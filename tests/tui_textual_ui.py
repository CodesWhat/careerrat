import asyncio
import importlib.util
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest

from types import SimpleNamespace

from textual.widgets import Button, DataTable, Input, Static, TabbedContent
from textual import events

ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location(
    "careerrat_textual", ROOT / "src/core/tui/textual-app.py"
)
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


async def until(check):
    async with asyncio.timeout(5):
        while not check():
            await asyncio.sleep(0.03)


class WorkspaceTest(unittest.IsolatedAsyncioTestCase):
    async def test_recorded_undo_previews_then_updates_canonical_state(self):
        with tempfile.TemporaryDirectory(prefix="careerrat-textual-undo-") as folder:
            home = Path(folder)
            (home / "workspace").mkdir()
            (home / "workspace/tracker.json").write_text(
                json.dumps(
                    {
                        "applications": [
                            {
                                "id": "saved-role",
                                "company": "Example",
                                "role": "Lead",
                                "status": "applied",
                            }
                        ]
                    }
                )
            )
            env = {**os.environ, "CAREERRAT_HOME": folder}

            def module(value):
                return json.dumps((ROOT / value).as_uri())

            code = f"""
import {{ importFromTracker }} from {module('src/core/db/import-from-tracker.mjs')};
import {{ closeAll }} from {module('src/core/db/connection.mjs')};
import {{ candidateSetupInitialize, candidateConfigPatch }} from {module('src/core/db/verbs/candidate.mjs')};
import {{ workspaceMessageAppend }} from {module('src/core/agent/workspace-thread.mjs')};
import {{ buildKnowledgeWriteEntry }} from {module('src/core/agent/knowledge-write-log.mjs')};
const ctx={{repoRoot:{json.dumps(str(ROOT))},env:process.env}};
importFromTracker({{...ctx,sourceDir:{json.dumps(str(home / 'workspace'))}}});
candidateSetupInitialize(ctx);
candidateConfigPatch({{...ctx,name:'targeting',patch:{{fit_bands:{{fit_floor:70}}}}}});
workspaceMessageAppend({{...ctx,role:'assistant',kind:'action_result',text:'Saved fit floor',artifacts:[buildKnowledgeWriteEntry({{target:'candidate_config:targeting',op:'set',path:'fit_bands.fit_floor',before:60,after:70,label:'Fit floor'}})]}});
closeAll();
"""
            setup = await asyncio.to_thread(
                subprocess.run,
                [shutil.which("node"), "--input-type=module", "-e", code],
                env=env,
                capture_output=True,
                timeout=15,
            )
            self.assertEqual(setup.returncode, 0, setup.stderr.decode())
            app = MODULE.CareerRatApp(env=env, bridge_args=["--no-agent"])
            async with app.run_test(size=(160, 50)) as pilot:
                await until(lambda: app.snapshot and app.snapshot["view"]["changes"])
                await pilot.click("#--content-tab-changes")
                self.assertTrue(
                    await pilot.click("#preview-undo"),
                    str(app.query_one("#preview-undo").region),
                )
                await until(lambda: app.snapshot["state"].get("pendingUndo"))
                self.assertFalse(app.query_one("#confirm-undo", Button).disabled)
                await pilot.click("#confirm-undo")
                await until(
                    lambda: "undone" in app.snapshot["state"].get("message", "").lower()
                )
                self.assertTrue(app.snapshot["view"]["changes"][0]["reverted"])
                await pilot.press("ctrl+q")
            self.assertEqual(app.errors, [])
            verify = f"import {{candidateConfigGet}} from {module('src/core/db/verbs/candidate.mjs')}; console.log(candidateConfigGet({{repoRoot:{json.dumps(str(ROOT))},env:process.env}}).targeting.fit_bands.fit_floor);"
            result = await asyncio.to_thread(
                subprocess.run,
                [shutil.which("node"), "--input-type=module", "-e", verify],
                env=env,
                capture_output=True,
                timeout=15,
            )
            self.assertEqual(result.returncode, 0, result.stderr.decode())
            self.assertEqual(result.stdout.strip(), b"60")

    @unittest.skipIf(
        sys.platform == "win32", "Unix outer-PTY proof; Windows acceptance is separate"
    )
    async def test_normal_cli_installs_privately_and_launches_textual(self):
        import pty

        with tempfile.TemporaryDirectory(prefix="careerrat-textual-cli-") as folder:
            home = Path(folder)
            (home / "workspace").mkdir()
            path = home / "workspace/tracker.json"
            saved = {
                "applications": [
                    {
                        "id": "northstar",
                        "company": "Northstar",
                        "role": "Staff Engineer",
                        "status": "interview",
                    }
                ]
            }
            path.write_text(json.dumps(saved))
            env = {
                **os.environ,
                "CAREERRAT_HOME": folder,
                "CAREERRAT_TUI_PYTHON": sys.executable,
                "TERM": "xterm-256color",
            }
            node = shutil.which("node")
            installed = await asyncio.to_thread(
                subprocess.run,
                [node, str(ROOT / "src/cli/tui.mjs"), "setup"],
                env=env,
                capture_output=True,
                timeout=150,
            )
            self.assertEqual(installed.returncode, 0, installed.stderr.decode())
            self.assertTrue(list((home / "internal/tui").glob("python-*/.ready.json")))
            terminal_fd, application_fd = pty.openpty()
            process = await asyncio.create_subprocess_exec(
                node,
                str(ROOT / "src/cli/tui.mjs"),
                "--no-agent",
                env=env,
                stdin=application_fd,
                stdout=application_fd,
                stderr=application_fd,
                start_new_session=True,
            )
            os.close(application_fd)
            os.set_blocking(terminal_fd, False)
            output = b""
            try:
                async with asyncio.timeout(10):
                    while b"Northstar" not in output:
                        try:
                            output += os.read(terminal_fd, 65536)
                        except BlockingIOError:
                            await asyncio.sleep(0.03)
                os.write(terminal_fd, b"\x11")
                async with asyncio.timeout(10):
                    while process.returncode is None:
                        try:
                            output += os.read(terminal_fd, 65536)
                        except (BlockingIOError, OSError):
                            pass
                        await asyncio.sleep(0.03)
                self.assertEqual(process.returncode, 0, output.decode(errors="replace"))
                self.assertEqual(json.loads(path.read_text()), saved)
                self.assertFalse((home / "db").exists())
            finally:
                if process.returncode is None:
                    process.terminate()
                    await asyncio.wait_for(process.wait(), 10)
                os.close(terminal_fd)

    async def test_native_pane_typing_paste_resize_and_process_cleanup(self):
        with tempfile.TemporaryDirectory(prefix="careerrat-textual-native-") as folder:
            home = Path(folder)
            executable = home / "codex"
            node = shutil.which("node")
            executable.write_text(
                f"#!{node}\n"
                "import fs from 'node:fs';fs.writeFileSync(process.env.CAREERRAT_HOME+'/native.pid',String(process.pid));"
                "process.stdin.setRawMode(true);process.stdin.resume();process.stdout.write('\\x1b[?2004hNATIVE_FIXTURE_READY');"
                "process.stdin.on('data',b=>process.stdout.write(' GOT:'+b.toString().replaceAll('\\n','|')));"
            )
            executable.chmod(0o700)
            app = MODULE.CareerRatApp(
                env={
                    **os.environ,
                    "CAREERRAT_HOME": folder,
                    "PATH": folder + os.pathsep + os.environ["PATH"],
                },
                bridge_args=["--agent", "codex"],
            )
            async with app.run_test(size=(160, 50)) as pilot:
                pane = app.query_one(MODULE.NativePane)
                await until(
                    lambda: pane.frame and "NATIVE_FIXTURE_READY" in pane.render().plain
                )
                child_pid = int((home / "native.pid").read_text())
                bridge_pid = app.proc.pid
                await pilot.press("f6", "x")
                await until(lambda: "GOT:x" in pane.render().plain)
                pane.post_message(events.Paste("line one\nline two"))
                await until(lambda: "line one|line two" in pane.render().plain)
                await pilot.resize_terminal(130, 44)
                await until(lambda: pane.frame["cols"] == pane.content_size.width)
                await pilot.press("ctrl+q")
            for pid in (child_pid, bridge_pid):
                with self.assertRaises(ProcessLookupError):
                    os.kill(pid, 0)
            self.assertEqual(app.errors, [])

    async def test_saved_jobs_clicks_requests_context_and_cleanup(self):
        with tempfile.TemporaryDirectory(prefix="careerrat-textual-ui-") as folder:
            home = Path(folder)
            (home / "workspace").mkdir()
            tracker = {
                "meta": {"version": 7},
                "applications": [
                    {
                        "id": "northstar",
                        "company": "Northstar",
                        "role": "Staff Engineer",
                        "status": "interview",
                        "evaluation": {
                            "gate": "keep",
                            "requirements": [
                                {
                                    "requirement": "Distributed systems",
                                    "importance": "critical",
                                    "evidence": "stated",
                                    "jdSignal": "Own distributed services",
                                    "match": "strong",
                                    "note": "Led production platform work",
                                }
                            ],
                        },
                        "conversations": [
                            {
                                "type": "recruiter-screen",
                                "notes": "Discussed team scope",
                                "processNote": "Hiring manager next",
                            }
                        ],
                    },
                    {
                        "id": "harbor",
                        "evaluation": None,
                        "company": "Harbor",
                        "role": "Platform Lead",
                        "status": "applied",
                        "statusNote": "Recruiter replied",
                    },
                ],
            }
            path = home / "workspace/tracker.json"
            tracker["applications"][0]["artifacts"] = {
                "jd": "workspace/jobs/northstar.md"
            }
            (home / "workspace/jobs").mkdir()
            (home / "workspace/jobs/northstar.md").write_text(
                "# Saved role\n\nOwn the platform and its services."
            )
            path.write_text(json.dumps(tracker))
            app = MODULE.CareerRatApp(
                env={**os.environ, "CAREERRAT_HOME": folder}, bridge_args=["--no-agent"]
            )
            async with app.run_test(size=(160, 50)) as pilot:
                table = app.query_one("#jobs", DataTable)
                await until(lambda: table.row_count == 2)
                await pilot.click("#jobs", offset=(10, 2))
                await until(lambda: app.selected_id == "harbor")
                self.assertIn(
                    "Recruiter replied", str(app.query_one("#details").render())
                )
                await pilot.click("#jobs", offset=(10, 3))
                await until(lambda: app.selected_id == "northstar")
                await pilot.click("#--content-tab-assessment")
                report = app.query_one("#requirements", DataTable)
                await until(lambda: report.row_count == 1)
                self.assertIn("Distributed systems", str(report.get_row_at(0)))
                self.assertIn("Led production platform work", str(report.get_row_at(0)))
                await pilot.click("#--content-tab-fit")
                await pilot.click("#open-jd")
                await until(lambda: isinstance(app.screen, MODULE.JobDocument))
                self.assertIn(
                    "Own the platform", app.screen.document["artifact"]["markdown"]
                )
                await pilot.click("#close-document")
                await pilot.click("#--content-tab-history")
                self.assertIn(
                    "Discussed team scope", str(app.query_one("#history-text").render())
                )
                await pilot.click("#jobs", offset=(10, 2))
                await until(lambda: app.selected_id == "harbor")
                self.assertEqual(report.row_count, 0)
                await pilot.click("#--content-tab-fit")
                screenshot_dir = os.environ.get("CAREERRAT_TUI_SCREENSHOT_DIR")
                if screenshot_dir:
                    Path(screenshot_dir).mkdir(parents=True, exist_ok=True)
                    app.save_screenshot(
                        filename="textual-source-inspector.svg", path=screenshot_dir
                    )
                await pilot.click("#apply")
                await until(lambda: "harbor" in app.query_one("#request", Input).value)
                self.assertIn(
                    "Press Enter", app.query_one("#request", Input).placeholder
                )
                await pilot.click("#--content-tab-history")
                self.assertEqual(app.query_one(TabbedContent).active, "history")
                await app.send({"op": "view", "stage": "applied"})
                await until(lambda: table.row_count == 1)
                self.assertEqual(app.selected_id, "harbor")
                self.assertEqual(json.loads(path.read_text()), tracker)
                await pilot.click("#context")
                await pilot.pause()
                app.screen.query_one("#context-text").load_text(
                    "Interview transcript: platform ownership"
                )
                await pilot.click("#save-context")
                await until(
                    lambda: "saved context" in app.query_one("#request", Input).value
                )
                self.assertTrue(list((home / "workspace/intake/pastes").glob("*.md")))
                bridge_pid = app.proc.pid
                await pilot.press("ctrl+q")
            with self.assertRaises(ProcessLookupError):
                os.kill(bridge_pid, 0)
            self.assertEqual(app.errors, [])

    async def test_details_tolerate_nulls_and_history_stays_with_the_job(self):
        with tempfile.TemporaryDirectory(prefix="careerrat-textual-null-") as folder:
            (Path(folder) / "workspace").mkdir()
            app = MODULE.CareerRatApp(
                env={**os.environ, "CAREERRAT_HOME": folder}, bridge_args=["--no-agent"]
            )
            async with app.run_test(size=(160, 50)) as pilot:
                await until(lambda: app.snapshot)
                app.snapshot["view"]["workspaceMessages"] = [
                    {"role": "assistant", "createdAt": "2026-01-01", "text": "UNRELATED"}
                ]
                shared = {
                    "role": "user",
                    "createdAt": "2026-01-03",
                    "text": "SECOND",
                }
                app.update_details(
                    {
                        "record": {
                            "company": None,
                            "role": None,
                            "statusNote": None,
                            "nextAction": None,
                            "evaluation": {
                                "gate": "keep",
                                "requirements": [
                                    None,
                                    {"requirement": "Only name", "match": None},
                                ],
                            },
                        },
                        "thread": {
                            "messages": [
                                {"role": "user", "createdAt": None, "text": "NULLDATE"},
                                shared,
                            ]
                        },
                        "contextMessages": [
                            {"role": "user", "createdAt": "2026-01-02", "text": "FIRST"}
                        ],
                    }
                )
                await pilot.pause()
                report = app.query_one("#requirements", DataTable)
                self.assertEqual(report.row_count, 2)
                self.assertIn("Only name", str(report.get_row_at(1)))
                history = str(app.query_one("#history-text", Static).render())
                self.assertNotIn("UNRELATED", history)
                self.assertEqual(history.count("SECOND"), 1)
                self.assertLess(history.index("NULLDATE"), history.index("FIRST"))
                self.assertLess(history.index("FIRST"), history.index("SECOND"))
                self.assertNotIn("None", str(app.query_one("#details", Static).render()))
                await pilot.press("ctrl+q")

    async def test_a_bad_event_does_not_stop_later_events(self):
        with tempfile.TemporaryDirectory(prefix="careerrat-textual-events-") as folder:
            (Path(folder) / "workspace").mkdir()
            app = MODULE.CareerRatApp(
                env={**os.environ, "CAREERRAT_HOME": folder}, bridge_args=["--no-agent"]
            )
            async with app.run_test(size=(160, 50)) as pilot:
                await until(lambda: app.snapshot)
                reader = asyncio.StreamReader()
                for line in (
                    b"not json\n",
                    b'{"no":"type"}\n',
                    b'{"type":"request"}\n',
                    b'{"type":"context","path":"/saved/here.md"}\n',
                ):
                    reader.feed_data(line)
                reader.feed_eof()
                handled = []

                async def record(value):
                    await app.handle_event(value)
                    handled.append(value["type"])

                shim = SimpleNamespace(
                    proc=SimpleNamespace(stdout=reader),
                    stopping=False,
                    errors=[],
                    show_message=app.show_message,
                    handle_event=record,
                )
                await MODULE.CareerRatApp.read_events(shim)
                self.assertEqual(len(shim.errors), 3)
                self.assertEqual(handled, ["context"])
                self.assertIn(
                    "Workspace connection closed",
                    str(app.query_one("#message", Static).render()),
                )
                await pilot.press("ctrl+q")


if __name__ == "__main__":
    unittest.main()
