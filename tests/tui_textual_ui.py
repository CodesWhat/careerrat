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

from textual.widgets import Button, DataTable, Input, Select, Static, TabbedContent
from textual import events

ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location(
    "careerrat_textual", ROOT / "src/core/tui/textual-app.py"
)
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


async def until(check, seconds=5):
    async with asyncio.timeout(seconds):
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

    def fake_agent(self, home):
        executable = home / "codex"
        executable.write_text(
            f"#!{shutil.which('node')}\n"
            "import fs from 'node:fs';import path from 'node:path';\n"
            "const home=process.env.CAREERRAT_HOME;\n"
            "process.stdin.setRawMode(true);process.stdin.resume();process.stdout.write('\\x1b[?2004hAGENT_READY');\n"
            "process.stdin.on('data',b=>{const dir=path.join(home,'workspace/intake/uploads');"
            "const saved=fs.existsSync(dir)?fs.readdirSync(dir).map(n=>({n,body:fs.readFileSync(path.join(dir,n),'utf8')})):[];"
            "fs.appendFileSync(home+'/agent.log',JSON.stringify({data:b.toString(),saved})+'\\n');});\n"
        )
        executable.chmod(0o700)

    def agent_log(self, home):
        log = home / "agent.log"
        return [json.loads(line) for line in log.read_text().splitlines()] if log.exists() else []

    async def test_failed_capture_keeps_text_and_blocks_double_submit(self):
        with tempfile.TemporaryDirectory(prefix="careerrat-textual-fail-") as folder:
            (Path(folder) / "workspace").mkdir()
            missing = str(Path(folder) / "gone" / "notes.txt")
            app = MODULE.CareerRatApp(
                env={**os.environ, "CAREERRAT_HOME": folder}, bridge_args=["--no-agent"]
            )
            async with app.run_test(size=(160, 50)) as pilot:
                await until(lambda: app.snapshot)
                await pilot.click("#context")
                await pilot.pause()
                modal = app.screen
                self.assertIsInstance(modal, MODULE.ContextCapture)
                modal.query_one("#context-text").load_text(f"'{missing}'")
                await modal.action_save()
                self.assertTrue(modal.waiting)
                self.assertTrue(modal.query_one("#save-context", Button).disabled)
                await modal.action_save()
                await until(
                    lambda: "Not saved" in str(modal.query_one("#capture-error").render())
                )
                self.assertIs(app.screen, modal)
                self.assertEqual(modal.query_one("#context-text").text, f"'{missing}'")
                self.assertEqual(app.request_counter, 1)
                self.assertFalse(modal.waiting)
                self.assertEqual(app.query_one("#request", Input).value, "")
                await pilot.press("ctrl+q")
            self.assertEqual(app.errors, [])

    async def test_paste_on_jobs_opens_prefilled_modal_and_never_reaches_agent(self):
        with tempfile.TemporaryDirectory(prefix="careerrat-textual-paste-") as folder:
            home = Path(folder)
            (home / "workspace").mkdir()
            self.fake_agent(home)
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
                await until(lambda: pane.frame and "AGENT_READY" in pane.render().plain)
                app.query_one("#jobs").focus()
                app.post_message(events.Paste("Synthetic recruiter note"))
                await until(lambda: isinstance(app.screen, MODULE.ContextCapture))
                await until(
                    lambda: app.screen.query_one("#context-text").text
                    == "Synthetic recruiter note"
                    and app.screen.request_id is None
                    and not app.screen.waiting
                )
                await pilot.pause(0.3)
                self.assertEqual(self.agent_log(home), [])
                self.assertFalse((home / "workspace/intake").exists())
                await pilot.press("ctrl+q")
            self.assertEqual(app.errors, [])

    async def test_pasted_file_path_lists_attachment_and_remove_saves_nothing(self):
        with tempfile.TemporaryDirectory(prefix="careerrat-textual-attach-") as folder:
            home = Path(folder)
            (home / "workspace").mkdir()
            sources = home / "my files"
            sources.mkdir()
            first, second = sources / "offer one.txt", sources / "notes two.md"
            first.write_text("Synthetic offer")
            second.write_text("Synthetic notes")
            app = MODULE.CareerRatApp(
                env={**os.environ, "CAREERRAT_HOME": folder}, bridge_args=["--no-agent"]
            )
            async with app.run_test(size=(160, 50)) as pilot:
                await until(lambda: app.snapshot)
                app.post_message(events.Paste(f"'{first}' '{second}'"))
                await until(
                    lambda: isinstance(app.screen, MODULE.ContextCapture)
                    and len(app.screen.files) == 2
                )
                modal = app.screen
                await until(lambda: len(modal.query(MODULE.RemoveFile)) == 2)
                self.assertEqual(
                    [item["name"] for item in modal.files], ["offer one.txt", "notes two.md"]
                )
                self.assertFalse(modal.query_one("#context-text").display)
                await pilot.click("#remove-file-0")
                await until(lambda: len(modal.query(MODULE.RemoveFile)) == 1)
                self.assertEqual([item["name"] for item in modal.files], ["notes two.md"])
                await pilot.click("#remove-file-0")
                await until(lambda: not modal.files)
                self.assertTrue(modal.query_one("#context-text").display)
                self.assertFalse((home / "workspace/intake").exists())
                await pilot.press("ctrl+q")
            self.assertEqual(app.errors, [])

    @unittest.skipIf(
        sys.platform == "win32", "Unix outer-PTY proof; Windows acceptance is separate"
    )
    async def test_outer_terminal_dropped_path_is_saved_before_agent_gets_request(self):
        import pty

        with tempfile.TemporaryDirectory(prefix="careerrat-textual-drop-") as folder:
            home = Path(folder)
            (home / "workspace").mkdir()
            self.fake_agent(home)
            source = home / "dropped offer.txt"
            source.write_text("Synthetic offer letter body")
            env = {
                **os.environ,
                "CAREERRAT_HOME": folder,
                "PATH": folder + os.pathsep + os.environ["PATH"],
                "TERM": "xterm-256color",
            }
            terminal_fd, application_fd = pty.openpty()
            process = await asyncio.create_subprocess_exec(
                sys.executable,
                str(ROOT / "src/core/tui/textual-app.py"),
                "--agent",
                "codex",
                env=env,
                stdin=application_fd,
                stdout=application_fd,
                stderr=application_fd,
                start_new_session=True,
            )
            os.close(application_fd)
            os.set_blocking(terminal_fd, False)
            output = b""

            async def read_until(check, limit=15):
                nonlocal output
                async with asyncio.timeout(limit):
                    while not check():
                        try:
                            output += os.read(terminal_fd, 65536)
                        except BlockingIOError:
                            await asyncio.sleep(0.03)
                        except OSError:
                            return

            try:
                await read_until(lambda: b"AGENT_READY" in output)
                await asyncio.sleep(0.5)
                os.write(terminal_fd, f"\x1b[200~'{source}'\x1b[201~".encode())
                await read_until(lambda: b"dropped offer.txt" in output)
                self.assertEqual(self.agent_log(home), [])
                os.write(terminal_fd, b"\x13")
                async with asyncio.timeout(15):
                    while not self.agent_log(home):
                        try:
                            output += os.read(terminal_fd, 65536)
                        except BlockingIOError:
                            pass
                        await asyncio.sleep(0.05)
                received = self.agent_log(home)[0]
                self.assertIn("Read these saved context files", received["data"])
                self.assertFalse(received["data"].endswith("\r"))
                self.assertEqual(
                    sorted(
                        item["body"]
                        for item in received["saved"]
                        if item["n"].endswith(".txt")
                    ),
                    ["Synthetic offer letter body"] * 2,
                )
                self.assertTrue(
                    any(item["n"].endswith(".json") for item in received["saved"])
                )
                os.write(terminal_fd, b"\x11")
                async with asyncio.timeout(10):
                    while process.returncode is None:
                        try:
                            output += os.read(terminal_fd, 65536)
                        except (BlockingIOError, OSError):
                            pass
                        await asyncio.sleep(0.03)
                self.assertEqual(process.returncode, 0, output.decode(errors="replace"))
            finally:
                if process.returncode is None:
                    process.kill()
                    await process.wait()
                os.close(terminal_fd)

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

    async def seed_workspace(self, folder, count, size):
        home = Path(folder)
        (home / "workspace").mkdir(exist_ok=True)
        (home / "workspace/tracker.json").write_text(
            json.dumps(
                {
                    "applications": [
                        {"id": "saved-role", "company": "Example", "role": "Lead", "status": "applied"}
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
for (let i = 0; i < {count}; i++) workspaceMessageAppend({{...ctx,role:'assistant',kind:'action_result',text:'WS'+i+' '+'x'.repeat({size})}});
closeAll();
"""
        setup = await asyncio.to_thread(
            subprocess.run,
            [shutil.which("node"), "--input-type=module", "-e", code],
            env=env,
            capture_output=True,
            timeout=120,
        )
        self.assertEqual(setup.returncode, 0, setup.stderr.decode())
        return env

    async def test_workspace_tab_shows_skill_results_apart_from_job_history(self):
        with tempfile.TemporaryDirectory(prefix="careerrat-textual-ws-") as folder:
            env = await self.seed_workspace(folder, 2, 20)
            app = MODULE.CareerRatApp(env=env, bridge_args=["--no-agent"])
            async with app.run_test(size=(160, 50)) as pilot:
                await until(lambda: app.snapshot and app.snapshot["view"]["changes"])
                await pilot.click("#--content-tab-workspace-history")
                text = str(app.query_one("#workspace-history-text", Static).render())
                self.assertIn("Saved fit floor", text)
                self.assertIn("WS1", text)
                self.assertIn("not a chat transcript", text)
                self.assertNotIn("Showing the latest", text)
                self.assertNotIn("Saved fit floor", str(app.query_one("#history-text", Static).render()))
                await pilot.press("ctrl+q")
            self.assertEqual(app.errors, [])

    async def test_workspace_tab_empty_state(self):
        with tempfile.TemporaryDirectory(prefix="careerrat-textual-wsempty-") as folder:
            (Path(folder) / "workspace").mkdir()
            app = MODULE.CareerRatApp(
                env={**os.environ, "CAREERRAT_HOME": folder}, bridge_args=["--no-agent"]
            )
            async with app.run_test(size=(160, 50)) as pilot:
                await until(lambda: app.snapshot)
                await pilot.click("#--content-tab-workspace-history")
                text = str(app.query_one("#workspace-history-text", Static).render())
                self.assertIn("No workspace history yet.", text)
                self.assertIn("not a chat transcript", text)
                await pilot.press("ctrl+q")

    async def test_huge_workspace_history_is_capped_and_keeps_the_reader_alive(self):
        with tempfile.TemporaryDirectory(prefix="careerrat-textual-wsbig-") as folder:
            # 700 x 50,000 characters is over the 32 MiB event line limit.
            env = await self.seed_workspace(folder, 700, 49000)
            app = MODULE.CareerRatApp(env=env, bridge_args=["--no-agent"])
            async with app.run_test(size=(160, 50)) as pilot:
                await until(lambda: app.snapshot and app.snapshot["view"]["changes"], 40)
                view = app.snapshot["view"]
                self.assertEqual(view["workspaceMessagesTotal"], 701)
                self.assertLess(len(view["workspaceMessages"]), 701)
                self.assertEqual(len(view["changes"]), 1)
                self.assertFalse(app.reader.done())
                await pilot.click("#--content-tab-workspace-history")
                text = str(app.query_one("#workspace-history-text", Static).render())
                self.assertIn(f"Showing the latest {len(view['workspaceMessages'])} of 701.", text)
                await pilot.click("#--content-tab-changes")
                self.assertTrue(await pilot.click("#preview-undo"))
                # Previewing reads the whole saved thread, which is ~35 MB here.
                await until(lambda: app.snapshot["state"].get("pendingUndo"), 40)
                self.assertFalse(app.reader.done())
                await pilot.press("ctrl+q")
            self.assertEqual(app.errors, [])

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


REAL_SHAPE = [
    {
        "id": "long-name",
        "company": "A very long company name that would otherwise take the whole table",
        "role": "Senior Platform Engineer, Reliability and Developer Productivity",
        "status": "applied",
        "fitScore": 84,
        "fitBucket": "high",
        "gate": {"gate": "KEEP", "action": "apply"},
        "base": "$150k-$200k + equity",
        "tc": "",
        "action": "Apply this week",
        "note": "Short note",
        "warn": "Onsite two days",
        "ask": 210000,
        "ratingReason": "Strong match on scope",
        "link": "https://example.com/jobs/1",
        "statusNote": None,
        "nextAction": None,
        "roleFit": {"why": ["Fits the scope"], "risks": ["Long commute"]},
        "artifacts": {
            "jd": "workspace/jobs/long-name.md",
            "reqId": "R-1",
            "resumeSource": "workspace/out/Resume Draft.docx",
            "canonicalUrl": "https://example.com/jobs/1",
            "submittedAt": "2026-01-02T03:04:05.000Z",
        },
    },
    {
        "id": "bare",
        "company": None,
        "role": None,
        "status": "sourced",
        "fitScore": 40,
        "fitBucket": "stretch",
        "gate": None,
        "base": "unlisted",
        "tc": None,
        "roleFit": None,
        "artifacts": {},
        "link": None,
    },
]


class JobsTableTest(unittest.IsolatedAsyncioTestCase):
    def test_pay_labels_show_a_dash_when_unknown(self):
        known = {"min": 150000, "max": 200000, "currency": "USD"}
        self.assertEqual(MODULE.pay_label(known, "USD"), "150k–200k")
        self.assertEqual(MODULE.pay_label({**known, "currency": "CAD"}, "USD"), "CAD 150k–200k")
        self.assertEqual(MODULE.pay_label({"min": None, "max": None}), "—")
        self.assertEqual(MODULE.pay_label({}), "—")

    def test_columns_fit_the_width_and_drop_the_least_important_first(self):
        for width in range(30, 260):
            plan = MODULE.plan_columns(width)
            names = [name for name, _ in plan]
            self.assertIn("Company", names)
            self.assertIn("Status", names)
            if width >= 70:
                self.assertEqual(names, MODULE.JOB_COLUMNS, width)
            if width >= 36:
                total = sum(size + MODULE.CELL_PADDING for _, size in plan)
                self.assertLessEqual(total, width, width)

    def test_details_skip_empty_fields_and_read_documents_plainly(self):
        job = {
            "record": REAL_SHAPE[0],
            "stage": {"label": "Applied"},
            "fit": {"score": 84, "label": "84 KEEP"},
        }
        text = MODULE.job_detail_text(job)
        self.assertNotIn("None", text)
        self.assertNotIn("{", text)
        self.assertNotIn("\n\n\n", text)
        for expected in (
            "Status: Applied",
            "Fit: 84 KEEP",
            "Suggested action: Apply this week",
            "Note: Short note",
            "Heads up: Onsite two days",
            "Ask: 210,000",
            "Apply link: https://example.com/jobs/1",
            "Job description: long-name.md",
            "Resume source: Resume Draft.docx",
        ):
            self.assertIn(expected, text)
        self.assertNotIn("R-1", text)
        self.assertNotIn("Submitted", text)
        bare = MODULE.job_detail_text(
            {"record": REAL_SHAPE[1], "stage": {"label": "Sourced"}, "fit": {}}
        )
        self.assertEqual(bare, "Status: Sourced\nBase pay: unlisted")
        self.assertEqual(MODULE.saved_documents({}), [])
        self.assertEqual(MODULE.saved_documents(None), [])

    def test_fit_report_uses_what_is_saved_when_there_is_no_evaluation(self):
        text = MODULE.fit_report_text(REAL_SHAPE[0], {"score": 84}, False)
        for expected in (
            "Score: 84",
            "Verdict: KEEP",
            "Fit group: high",
            "Suggested action: Apply this week",
            "Why this score: Strong match on scope",
            "Heads up: Onsite two days",
            "• Fits the scope",
            "• Long commute",
            "No detailed requirement-by-requirement evidence",
        ):
            self.assertIn(expected, text)
        bare = MODULE.fit_report_text(REAL_SHAPE[1], {"score": 40}, False)
        self.assertNotIn("None", bare)
        self.assertIn("Verdict: stretch", bare)

    async def test_every_column_shows_at_120_and_company_and_status_at_80(self):
        with tempfile.TemporaryDirectory(prefix="careerrat-textual-shape-") as folder:
            (Path(folder) / "workspace").mkdir()
            (Path(folder) / "workspace/tracker.json").write_text(
                json.dumps({"applications": REAL_SHAPE[:1], "sourced": REAL_SHAPE[1:]})
            )
            app = MODULE.CareerRatApp(
                env={**os.environ, "CAREERRAT_HOME": folder}, bridge_args=["--no-agent"]
            )
            async with app.run_test(size=(120, 40)) as pilot:
                await until(lambda: app.snapshot and app.job_ids)
                await pilot.pause()
                table = app.query_one("#jobs", DataTable)
                self.assertEqual(
                    [str(c.label) for c in table.columns.values()], MODULE.JOB_COLUMNS
                )
                self.assertLessEqual(
                    table.virtual_size.width, table.scrollable_content_region.width
                )
                self.assertFalse(table.show_horizontal_scrollbar)
                cells = {
                    key.value: [str(cell) for cell in table.get_row(key)]
                    for key in table.rows
                }
                first = cells["long-name"]
                self.assertTrue(first[0].endswith("…"))
                self.assertEqual(first[2], "Applied")
                self.assertEqual(first[3], "84 KEEP")
                self.assertEqual(first[4], "150k–200k")
                self.assertEqual(cells["bare"][3], "40 stretch")
                self.assertEqual(cells["bare"][4], "—")
                await until(lambda: app.selected_id == "long-name")
                self.assertTrue(app.query_one("#open-jd", Button).display)
                self.assertIn(
                    "Strong match",
                    str(app.query_one("#assessment-summary", Static).render()),
                )
                self.assertFalse(app.query_one("#requirements", DataTable).display)
                await pilot.resize_terminal(80, 30)
                await pilot.pause()
                names = [str(c.label) for c in table.columns.values()]
                self.assertIn("Company", names)
                self.assertIn("Status", names)
                self.assertFalse(table.show_horizontal_scrollbar)
                await pilot.resize_terminal(150, 40)
                await pilot.pause()
                self.assertEqual(
                    [str(c.label) for c in table.columns.values()], MODULE.JOB_COLUMNS
                )
                # A job with nothing saved: no crash, no empty button, no blanks.
                await pilot.press("down")
                await until(lambda: app.selected_id == "bare")
                self.assertFalse(app.query_one("#open-jd", Button).display)
                self.assertEqual(
                    str(app.query_one("#details", Static).render()),
                    "Status: Sourced\nFit: 40 stretch\nBase pay: unlisted",
                )
                await pilot.press("ctrl+q")
            self.assertEqual(app.errors, [])

    def make_home(self, folder, applications):
        (Path(folder) / "workspace").mkdir()
        (Path(folder) / "workspace/tracker.json").write_text(
            json.dumps({"meta": {"version": 7}, "applications": applications})
        )

    def synthetic_jobs(self):
        return [
            {"id": "open-a", "company": "Alpha", "role": "Dev", "status": "applied"},
            {"id": "open-b", "company": "Beta", "role": "Dev", "status": "interview"},
            {"id": "shut", "company": "Gamma", "role": "Dev", "status": "rejected"},
        ]

    async def test_active_is_the_default_view_and_all_statuses_shows_closed_jobs(self):
        with tempfile.TemporaryDirectory(prefix="careerrat-textual-active-") as folder:
            self.make_home(folder, self.synthetic_jobs())
            app = MODULE.CareerRatApp(
                env={**os.environ, "CAREERRAT_HOME": folder}, bridge_args=["--no-agent"]
            )
            async with app.run_test(size=(140, 40)) as pilot:
                table = app.query_one("#jobs", DataTable)
                await until(lambda: table.row_count == 2)
                self.assertEqual(app.query_one("#status", Select).value, "active")
                self.assertIn("2 of 3", table.border_title)
                self.assertIn("rejected", app.stage_options)
                app.query_one("#status", Select).value = "all"
                await until(lambda: table.row_count == 3)
                self.assertNotIn("of", table.border_title.replace("Saved jobs", ""))
                await pilot.press("ctrl+q")
            self.assertEqual(app.errors, [])

    async def test_toolbar_never_clips_a_control_and_startup_focus_is_the_jobs_table(self):
        with tempfile.TemporaryDirectory(prefix="careerrat-textual-toolbar-") as folder:
            jobs = [
                {
                    "id": f"job-{index}",
                    "company": f"Extraordinarily Long Company Name {index} Holdings",
                    "role": "Principal Staff Platform Reliability Engineer",
                    "status": "applied",
                    "base": "$150k - $200k" if index % 2 else "GBP 90k - 120k",
                }
                for index in range(30)
            ]
            self.make_home(folder, jobs)
            for width, height, rows in [(80, 30, 2), (120, 40, 2), (160, 50, 1)]:
                app = MODULE.CareerRatApp(
                    env={**os.environ, "CAREERRAT_HOME": folder},
                    bridge_args=["--no-agent"],
                )
                async with app.run_test(size=(width, height)) as pilot:
                    table = app.query_one("#jobs", DataTable)
                    await until(lambda: table.row_count > 0)
                    await pilot.pause(0.2)
                    self.assertIs(app.focused, table)
                    toolbar = app.query_one("#toolbar")
                    self.assertEqual(toolbar.region.height, rows)
                    controls = [
                        widget
                        for widget in toolbar.query("Button, Select, Label")
                        if widget.display
                    ]
                    self.assertGreaterEqual(len(controls), 9)
                    for widget in controls:
                        region = widget.region
                        self.assertEqual(region.height, 1, widget.id)
                        self.assertGreaterEqual(region.x, 0, widget.id)
                        self.assertLessEqual(region.right, width, widget.id)
                        self.assertTrue(toolbar.region.contains_region(region), widget.id)
                        self.assertLessEqual(widget.size.width, region.width, widget.id)
                    await pilot.press("ctrl+q")
                self.assertEqual(app.errors, [])

    async def test_an_empty_active_view_says_how_to_see_everything(self):
        with tempfile.TemporaryDirectory(prefix="careerrat-textual-closed-") as folder:
            self.make_home(
                folder,
                [{"id": "shut", "company": "Gamma", "role": "Dev", "status": "rejected"}],
            )
            app = MODULE.CareerRatApp(
                env={**os.environ, "CAREERRAT_HOME": folder}, bridge_args=["--no-agent"]
            )
            async with app.run_test(size=(140, 40)) as pilot:
                await until(lambda: app.snapshot)
                await pilot.pause(0.2)
                text = str(app.query_one("#details", Static).render())
                self.assertIn("No active jobs", text)
                self.assertIn("All statuses", text)
                await pilot.press("ctrl+q")

    async def test_moving_the_highlight_does_not_resend_the_job_list(self):
        with tempfile.TemporaryDirectory(prefix="careerrat-textual-move-") as folder:
            self.make_home(folder, self.synthetic_jobs())
            app = MODULE.CareerRatApp(
                env={**os.environ, "CAREERRAT_HOME": folder}, bridge_args=["--no-agent"]
            )
            snapshots = []
            original = app.update_workspace
            app.update_workspace = lambda value: (snapshots.append(1), original(value))[1]
            async with app.run_test(size=(140, 40)) as pilot:
                table = app.query_one("#jobs", DataTable)
                await until(lambda: table.row_count == 2)
                first = app.selected_id
                before = len(snapshots)
                table.focus()
                await pilot.press("down")
                await until(lambda: app.selected_id not in (None, first))
                await until(
                    lambda: "Beta" in str(app.query_one("#details", Static).render())
                    or "Alpha" in str(app.query_one("#details", Static).render())
                )
                self.assertEqual(len(snapshots), before)
                self.assertEqual(
                    app.snapshot["state"]["selectedId"], app.selected_id
                )
                await pilot.press("ctrl+q")
            self.assertEqual(app.errors, [])

    async def test_review_names_what_it_took_and_apply_refuses_closed_jobs(self):
        with tempfile.TemporaryDirectory(prefix="careerrat-textual-asks-") as folder:
            self.make_home(folder, self.synthetic_jobs())
            app = MODULE.CareerRatApp(
                env={**os.environ, "CAREERRAT_HOME": folder}, bridge_args=["--no-agent"]
            )
            async with app.run_test(size=(140, 40)) as pilot:
                table = app.query_one("#jobs", DataTable)
                await until(lambda: table.row_count == 2)
                await pilot.click("#review")
                request = app.query_one("#request")
                await until(lambda: "evaluate-job" in request.value)
                self.assertIn("open-a", request.value)
                self.assertIn("open-b", request.value)
                self.assertNotIn("shut", request.value)
                message = str(app.query_one("#message", Static).render())
                self.assertIn("took the first 2 active jobs", message)
                request.value = ""
                app.query_one("#status", Select).value = "rejected"
                await until(lambda: table.row_count == 1)
                await pilot.click("#apply")
                await until(
                    lambda: "Apply selected" in str(app.query_one("#message", Static).render())
                )
                self.assertEqual(request.value, "")
                await pilot.press("ctrl+q")
            self.assertEqual(app.errors, [])

    def test_a_saved_action_that_repeats_the_verdict_is_left_out(self):
        row = {"action": "cut", "gate": {"gate": "cut"}, "fitBucket": "low"}
        self.assertEqual(MODULE.suggested_action(row), "")
        self.assertEqual(
            MODULE.suggested_action({"action": "Apply this week", "fitBucket": "high"}),
            "Apply this week",
        )
        text = MODULE.job_detail_text({"record": row, "stage": {"label": "Sourced"}, "fit": {}})
        self.assertNotIn("Next step", text)
        self.assertNotIn("cut", text.lower().replace("cut off", ""))

    async def test_an_empty_view_shows_plain_messages(self):
        with tempfile.TemporaryDirectory(prefix="careerrat-textual-empty-") as folder:
            (Path(folder) / "workspace").mkdir()
            app = MODULE.CareerRatApp(
                env={**os.environ, "CAREERRAT_HOME": folder}, bridge_args=["--no-agent"]
            )
            async with app.run_test(size=(120, 40)) as pilot:
                await until(lambda: app.snapshot)
                await pilot.pause()
                self.assertEqual(
                    str(app.query_one("#details", Static).render()),
                    "No jobs in this view.",
                )
                self.assertFalse(app.query_one("#open-jd", Button).display)
                await pilot.press("ctrl+q")
            self.assertEqual(app.errors, [])


if __name__ == "__main__":
    unittest.main()
