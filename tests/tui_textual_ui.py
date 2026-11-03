import asyncio
import importlib.util
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import time
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
                self.assertTrue(app.query_one("#confirm-undo", Button).display)
                self.assertTrue(app.query_one("#cancel-undo", Button).display)
                self.assertFalse(app.query_one("#preview-undo", Button).display)
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

    def test_key_map_covers_newlines_modifiers_and_function_keys(self):
        table = {
            ("shift+enter", None): "\n",
            ("ctrl+j", "\n"): "\n",
            ("alt+enter", None): "\x1b\r",
            ("enter", "\r"): "\r",
            ("ctrl+c", None): "\x03",
            ("ctrl+space", None): "\x00",
            ("up", None): "\x1b[A",
            ("ctrl+left", None): "\x1b[1;5D",
            ("shift+right", None): "\x1b[1;2C",
            ("ctrl+shift+up", None): "\x1b[1;6A",
            ("pageup", None): "\x1b[5~",
            ("ctrl+delete", None): "\x1b[3;5~",
            ("delete", None): "\x1b[3~",
            ("insert", None): "\x1b[2~",
            ("f1", None): "\x1bOP",
            ("f5", None): "\x1b[15~",
            ("shift+f5", None): "\x1b[15;2~",
            ("shift+f1", None): "\x1b[1;2P",
            ("alt+backspace", None): "\x1b\x7f",
            ("alt+b", "b"): "\x1bb",
            ("shift+tab", None): "\x1b[Z",
            ("a", "a"): "a",
            ("é", "é"): "é",
        }
        for (key, character), expected in table.items():
            self.assertEqual(MODULE.key_bytes(key, character), expected, key)
        self.assertIsNone(MODULE.key_bytes("shift+f13x", None))

    async def test_newline_and_modified_keys_reach_the_native_agent(self):
        with tempfile.TemporaryDirectory(prefix="careerrat-textual-keys-") as folder:
            home = Path(folder)
            executable = home / "codex"
            executable.write_text(
                f"#!{shutil.which('node')}\n"
                "import fs from 'node:fs';\n"
                "process.stdin.setRawMode(true);process.stdin.resume();process.stdout.write('KEYS_READY');\n"
                "process.stdin.on('data',b=>fs.appendFileSync(process.env.CAREERRAT_HOME+'/keys.log',b.toString('hex')+'\\n'));\n"
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
                await until(lambda: pane.frame and "KEYS_READY" in pane.render().plain)
                await pilot.press("f6")
                log = home / "keys.log"
                for key, expected in [
                    ("shift+enter", "0a"),
                    ("ctrl+j", "0a"),
                    ("alt+enter", "1b0d"),
                    ("ctrl+left", "1b5b313b3544"),
                    ("f5", "1b5b31357e"),
                ]:
                    before = len(log.read_text().split()) if log.exists() else 0
                    await pilot.press(key)
                    await until(lambda: log.exists() and len(log.read_text().split()) > before)
                    self.assertEqual(log.read_text().split()[-1], expected, key)
                await pilot.press("ctrl+q")
            self.assertEqual(app.errors, [])

    async def test_pane_scrollback_follows_the_wheel_and_shift_page_keys(self):
        with tempfile.TemporaryDirectory(prefix="careerrat-textual-scroll-") as folder:
            home = Path(folder)
            executable = home / "codex"
            executable.write_text(
                f"#!{shutil.which('node')}\n"
                "for(let i=0;i<120;i++)console.log('HISTORY'+i);console.log('AT_BOTTOM');"
                "process.stdin.resume();\n"
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
                await until(lambda: pane.frame and "AT_BOTTOM" in pane.render().plain)
                self.assertEqual(pane.frame["scroll"]["offset"], 0)

                class Wheel:
                    def get_content_offset(self, widget):
                        return SimpleNamespace(x=2, y=3)

                    def stop(self):
                        pass

                    def prevent_default(self):
                        pass

                for _ in range(4):
                    await pane.wheel(Wheel(), -1)
                await until(lambda: pane.frame["scroll"]["offset"] == 12)
                self.assertNotIn("AT_BOTTOM", pane.render().plain)
                self.assertIn("12 lines up", pane.border_subtitle)
                await pane.wheel(Wheel(), 1)
                await until(lambda: pane.frame["scroll"]["offset"] == 9)
                await pilot.press("f6", "shift+pageup")
                await until(lambda: pane.frame["scroll"]["offset"] > 9)
                await pilot.press("shift+pagedown")
                await until(lambda: pane.frame["scroll"]["offset"] == 9)
                await pilot.press("x")
                await until(lambda: pane.frame["scroll"]["offset"] == 0)
                self.assertEqual(pane.border_subtitle, "")
                await pilot.press("ctrl+q")
            self.assertEqual(app.errors, [])

    async def test_agent_bell_title_and_clipboard_reach_the_outer_terminal(self):
        with tempfile.TemporaryDirectory(prefix="careerrat-textual-osc-") as folder:
            home = Path(folder)
            executable = home / "codex"
            executable.write_text(
                f"#!{shutil.which('node')}\n"
                "process.stdin.resume();\n"
                "process.stdout.write('\\x07\\x1b]2;Agent: plan\\x07"
                "\\x1b]52;c;aGVsbG8gY2xpcGJvYXJk\\x07\\x1b]52;c;?\\x07\\x1b]52;c;%%%\\x07READY');\n"
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
            bells, copies, writes = [], [], []
            app.bell = lambda: bells.append(1)
            app.copy_to_clipboard = lambda text: copies.append(text)
            async with app.run_test(size=(160, 50)) as pilot:
                pane = app.query_one(MODULE.NativePane)
                await until(lambda: pane.frame and "READY" in pane.render().plain)
                await until(lambda: copies and app.sub_title == "Agent: plan")
                self.assertEqual(copies, ["hello clipboard"])
                self.assertEqual(len(bells), 1)
                # Two bells inside a second are one bell.
                app.ring_bell()
                app.ring_bell()
                self.assertEqual(len(bells), 1)
                app.write_terminal = writes.append
                app.set_agent_title("a\x1b]0;evil\x07 title")
                self.assertEqual(app.sub_title, "a]0;evil title")
                self.assertNotIn("\x1b]0;evil", writes[-1])
                self.assertTrue(writes[-1].startswith("\x1b]2;CareerRat"))
                await pilot.press("ctrl+q")
            self.assertEqual(app.errors, [])

    async def test_letters_go_to_the_agent_not_the_shortcuts_when_the_pane_has_focus(self):
        with tempfile.TemporaryDirectory(prefix="careerrat-textual-letters-") as folder:
            home = Path(folder)
            self.fake_agent(home)
            (home / "workspace").mkdir()
            (home / "workspace/tracker.json").write_text(
                json.dumps({"applications": [{"id": "a", "company": "Alpha", "role": "Dev", "status": "applied"}]})
            )
            app = MODULE.CareerRatApp(
                env={
                    **os.environ,
                    "CAREERRAT_HOME": folder,
                    "PATH": folder + os.pathsep + os.environ["PATH"],
                },
                bridge_args=["--agent", "codex"],
            )
            async with app.run_test(size=(160, 40)) as pilot:
                pane = app.query_one(MODULE.NativePane)
                await until(lambda: pane.frame and "AGENT_READY" in pane.render().plain)
                await pilot.press("f6", "s", "v")
                await until(lambda: len(self.agent_log(home)) >= 1)
                self.assertNotIsInstance(app.screen, MODULE.RequestText)
                self.assertIn("s", "".join(item["data"] for item in self.agent_log(home)))
                await pilot.press("ctrl+q")
            self.assertEqual(app.errors, [])

    async def test_many_resizes_send_one_resize_and_the_log_file_keeps_errors(self):
        with tempfile.TemporaryDirectory(prefix="careerrat-textual-log-") as folder:
            (Path(folder) / "workspace").mkdir()
            log = Path(folder) / "internal/tui/tui.log"
            app = MODULE.CareerRatApp(
                env={**os.environ, "CAREERRAT_HOME": folder, "CAREERRAT_TUI_LOG": str(log)},
                bridge_args=["--no-agent"],
            )
            async with app.run_test(size=(160, 50)) as pilot:
                await until(lambda: app.snapshot)
                await pilot.pause()
                sent = []
                original = app.send

                async def record(message):
                    sent.append(message["op"])
                    await original(message)

                app.send = record
                pane = app.query_one(MODULE.NativePane)
                for _ in range(20):
                    pane.on_resize()
                await pilot.pause(0.4)
                self.assertEqual(sent.count("resize"), 1)
                await app.handle_event({"type": "error", "message": "Saved data could not refresh: boom"})
                await pilot.press("ctrl+q")
            self.assertIn("Saved data could not refresh: boom", log.read_text())

    async def test_a_status_that_arrives_during_a_held_message_shows_when_the_hold_ends(self):
        with tempfile.TemporaryDirectory(prefix="careerrat-textual-hold-") as folder:
            (Path(folder) / "workspace").mkdir()
            app = MODULE.CareerRatApp(
                env={**os.environ, "CAREERRAT_HOME": folder}, bridge_args=["--no-agent"]
            )
            async with app.run_test(size=(160, 50)) as pilot:
                await until(lambda: app.snapshot)
                message = app.query_one("#message", Static)
                app.show_message("Read this first", hold=0.4)
                app.show_status("Search running · 1")
                app.show_status("Search completed · 3 saved")
                self.assertIn("Read this first", str(message.render()))
                await until(lambda: "3 saved" in str(message.render()), 3)
                self.assertNotIn("running", str(message.render()))
                # Nothing is left to replay once it has been shown.
                self.assertIsNone(app.pending_status)
                app.show_message("Later hold", hold=0.3)
                app.show_status("Newest")
                await pilot.pause(0.1)
                app.show_message("Longer hold", hold=0.5)
                await until(lambda: "Newest" in str(message.render()), 3)
                self.assertGreaterEqual(time.monotonic(), app.held[1] - 0.05)
                await pilot.press("ctrl+q")
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
                await until(lambda: isinstance(app.screen, MODULE.RequestText))
                await pilot.press("escape")
                await until(lambda: not isinstance(app.screen, MODULE.RequestText))
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
                self.assertEqual([p for p in (home / "workspace/intake").rglob("*") if p.is_file()], [])
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
                self.assertEqual([p for p in (home / "workspace/intake").rglob("*") if p.is_file()], [])
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

    async def test_a_dead_agent_stays_visible_and_snapshots_keep_held_messages(self):
        with tempfile.TemporaryDirectory(prefix="careerrat-textual-dead-") as folder:
            (Path(folder) / "workspace").mkdir()
            (Path(folder) / "workspace/tracker.json").write_text(
                json.dumps({"applications": REAL_SHAPE})
            )
            app = MODULE.CareerRatApp(
                env={**os.environ, "CAREERRAT_HOME": folder}, bridge_args=["--no-agent"]
            )
            async with app.run_test(size=(160, 50)) as pilot:
                await until(lambda: app.snapshot)
                await app.handle_event({"type": "agent-exited", "exitCode": 1})
                await app.handle_event({"type": "notice", "message": "Look at this"})
                for _ in range(2):
                    app.snapshot = None
                    await app.send({"op": "refresh"})
                    await until(lambda: app.snapshot)
                banner = app.query_one("#agent-status", Static)
                self.assertIn("The agent stopped (exit 1)", str(banner.render()))
                self.assertTrue(banner.has_class("shown"))
                self.assertEqual(
                    str(app.query_one("#message", Static).render()), "Look at this"
                )
                await pilot.press("ctrl+q")

    async def test_a_request_with_no_agent_opens_a_readable_copyable_box(self):
        with tempfile.TemporaryDirectory(prefix="careerrat-textual-noagent-") as folder:
            (Path(folder) / "workspace").mkdir()
            (Path(folder) / "workspace/tracker.json").write_text(
                json.dumps({"applications": REAL_SHAPE})
            )
            app = MODULE.CareerRatApp(
                env={**os.environ, "CAREERRAT_HOME": folder}, bridge_args=["--no-agent"]
            )
            async with app.run_test(size=(160, 50)) as pilot:
                await until(lambda: app.snapshot)
                await pilot.click("#jobs", offset=(10, 2))
                await until(lambda: app.selected_id == "long-name")
                await pilot.click("#apply")
                await until(lambda: isinstance(app.screen, MODULE.RequestText))
                box = app.screen.query_one("#request-body", MODULE.TextArea)
                self.assertTrue(box.read_only)
                self.assertIn("apply-job", box.text)
                self.assertIn("No agent is running.", str(app.query_one("#message", Static).render()))
                await pilot.click("#copy-request")
                self.assertEqual(app.clipboard, box.text)
                await pilot.press("escape")
                await pilot.press("ctrl+q")

    async def test_a_corrupt_database_exits_with_the_real_error(self):
        with tempfile.TemporaryDirectory(prefix="careerrat-textual-corrupt-") as folder:
            (Path(folder) / "db").mkdir()
            (Path(folder) / "db" / "careerrat.db").write_bytes(b"this is not a database" * 50)
            app = MODULE.CareerRatApp(
                env={**os.environ, "CAREERRAT_HOME": folder}, bridge_args=["--no-agent"]
            )
            async with app.run_test(size=(160, 50)):
                await until(lambda: app.return_code, seconds=15)
            self.assertNotEqual(app.return_code, 0)
            self.assertIn("not a database", " ".join(app.stderr_lines))

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

                closed = []

                async def bridge_closed():
                    closed.append(True)

                shim = SimpleNamespace(
                    proc=SimpleNamespace(stdout=reader),
                    stopping=False,
                    errors=[],
                    show_message=app.show_message,
                    write_log=app.write_log,
                    handle_event=record,
                    bridge_closed=bridge_closed,
                )
                await MODULE.CareerRatApp.read_events(shim)
                self.assertEqual(len(shim.errors), 3)
                self.assertEqual(handled, ["context"])
                self.assertEqual(closed, [True])
                await pilot.press("ctrl+q")

    async def test_an_oversized_bridge_line_is_dropped_and_later_events_still_arrive(self):
        reader = asyncio.StreamReader(limit=64)
        # Over the limit with the newline already buffered, then over the limit
        # arriving in pieces, then a normal event.
        reader.feed_data(b"x" * 500 + b"\n")
        reader.feed_data(b'{"type":"ok"}\n')

        async def late():
            await asyncio.sleep(0.05)
            reader.feed_data(b"y" * 300)
            await asyncio.sleep(0.05)
            reader.feed_data(b"y" * 300 + b"\n" + b'{"type":"late"}\n')
            reader.feed_eof()

        task = asyncio.create_task(late())
        seen = []
        while line := await MODULE.read_event_line(reader):
            seen.append("big" if line is MODULE.OVERSIZED else json.loads(line)["type"])
        await task
        self.assertEqual(seen, ["big", "ok", "big", "late"])

    async def test_a_multi_megabyte_workspace_stays_connected_and_responsive(self):
        with tempfile.TemporaryDirectory(prefix="careerrat-textual-large-") as folder:
            home = Path(folder)
            (home / "workspace").mkdir()
            jobs = [
                {
                    "id": f"job-{index:03d}",
                    "company": f"Company {index:03d}",
                    "role": "Platform Engineer",
                    "status": "applied",
                    "note": "n" * 20000,
                    "evaluation": {
                        "gate": "keep",
                        "requirements": [
                            {
                                "requirement": f"Requirement {item}",
                                "importance": "high",
                                "evidence": "e" * 400,
                                "match": "strong",
                            }
                            for item in range(250)
                        ],
                    },
                }
                for index in range(40)
            ]
            text = json.dumps({"applications": jobs})
            self.assertGreater(len(text), 4_000_000)
            (home / "workspace/tracker.json").write_text(text)
            app = MODULE.CareerRatApp(
                env={**os.environ, "CAREERRAT_HOME": folder}, bridge_args=["--no-agent"]
            )
            async with app.run_test(size=(160, 50)) as pilot:
                table = app.query_one("#jobs", DataTable)
                await until(lambda: table.row_count == 40, 20)
                self.assertLess(len(json.dumps(app.snapshot)), 200_000)
                await until(lambda: app.detail and app.detail["id"] == app.selected_id, 10)
                first = app.selected_id
                table.focus()
                started = time.monotonic()
                await pilot.press("down")
                await until(lambda: app.selected_id != first, 5)
                await until(
                    lambda: app.detail and app.detail["id"] == app.selected_id, 5
                )
                self.assertLess(time.monotonic() - started, 3)
                self.assertFalse(app.reader.done())
                self.assertIn("Platform Engineer", str(app.query_one("#details", Static).render()))
                await pilot.press("ctrl+q")
            self.assertEqual(app.errors, [])


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

    async def test_every_toolbar_action_has_a_key_escape_closes_dialogs_and_f1_opens_the_palette(self):
        with tempfile.TemporaryDirectory(prefix="careerrat-textual-keys-") as folder:
            self.make_home(folder, self.synthetic_jobs())
            app = MODULE.CareerRatApp(
                env={**os.environ, "CAREERRAT_HOME": folder}, bridge_args=["--no-agent"]
            )
            async with app.run_test(size=(160, 40)) as pilot:
                table = app.query_one("#jobs", DataTable)
                await until(lambda: table.row_count == 2)
                self.assertTrue(table.has_focus)
                for key, name in (("v", "review"), ("a", "apply")):
                    await pilot.press(key)
                    await until(lambda: isinstance(app.screen, MODULE.RequestText))
                    self.assertIn(
                        "No agent", app.screen.reason, f"{key} did not send {name}"
                    )
                    await pilot.press("escape")
                    await until(lambda: not isinstance(app.screen, MODULE.RequestText))
                await pilot.press("c")
                await until(lambda: isinstance(app.screen, MODULE.ContextCapture))
                # Letters are text inside a dialog, not shortcuts.
                await pilot.press("s", "a")
                self.assertEqual(app.screen.query_one("#context-text").text, "sa")
                await pilot.press("escape")
                await until(lambda: not isinstance(app.screen, MODULE.ContextCapture))
                await pilot.press("f5")
                await pilot.pause()
                self.assertEqual(app.errors, [])
                for key, select_id in (
                    ("t", "status"),
                    ("b", "basis"),
                    ("o", "order"),
                ):
                    await pilot.press(key)
                    await until(lambda: app.query_one(f"#{select_id}", Select).expanded)
                    await pilot.press("escape")
                    await until(lambda: not app.query_one(f"#{select_id}", Select).expanded)
                # The currency list only exists with more than one currency.
                await pilot.press("y")
                await pilot.pause()
                self.assertFalse(app.query_one("#currency", Select).expanded)
                await pilot.press("f1")
                await until(lambda: type(app.screen).__name__ == "CommandPalette")
                await pilot.press("escape")
                await until(lambda: type(app.screen).__name__ != "CommandPalette")
                await app.run_action("add_context")
                await until(lambda: isinstance(app.screen, MODULE.ContextCapture))
                await pilot.press("escape")
                await until(lambda: not isinstance(app.screen, MODULE.ContextCapture))
                commands = [item.title for item in app.get_system_commands(app.screen)]
                for title in ("Search jobs", "Review matches", "Apply selected", "Add context", "Refresh"):
                    self.assertIn(title, commands)
                await pilot.press("ctrl+q")
            self.assertEqual(app.errors, [])

    async def test_a_refresh_updates_cells_in_place_and_keeps_scroll_and_selection(self):
        with tempfile.TemporaryDirectory(prefix="careerrat-textual-inplace-") as folder:
            jobs = [
                {"id": f"job-{n:03d}", "company": f"Company {n:03d}", "role": "Dev", "status": "applied"}
                for n in range(80)
            ]
            self.make_home(folder, jobs)
            path = Path(folder) / "workspace/tracker.json"
            app = MODULE.CareerRatApp(
                env={**os.environ, "CAREERRAT_HOME": folder}, bridge_args=["--no-agent"]
            )
            async with app.run_test(size=(140, 30)) as pilot:
                table = app.query_one("#jobs", DataTable)
                await until(lambda: table.row_count == 80)
                table.focus()
                table.move_cursor(row=45)
                await until(lambda: app.selected_id == "job-045")
                await pilot.pause()
                table.scroll_to(y=30, animate=False, immediate=True)
                await pilot.pause()
                scroll = table.scroll_y
                self.assertGreater(scroll, 0)
                cleared = []
                original = table.clear
                table.clear = lambda *a, **k: (cleared.append(1), original(*a, **k))[1]

                # A cell changes: updated where it sits, nothing is refilled.
                jobs[50]["status"] = "interview"
                path.write_text(json.dumps({"meta": {"version": 7}, "applications": jobs}))
                await until(lambda: "Interview" in str(table.get_row("job-050")[2]))
                self.assertEqual(cleared, [])
                self.assertEqual(table.scroll_y, scroll)
                self.assertEqual(table.cursor_row, 45)
                self.assertEqual(app.selected_id, "job-045")

                # A job is added: the table refills but keeps scroll and selection.
                jobs.append({"id": "job-999", "company": "Zeta", "role": "Dev", "status": "applied"})
                path.write_text(json.dumps({"meta": {"version": 7}, "applications": jobs}))
                await until(lambda: table.row_count == 81)
                await pilot.pause()
                await pilot.pause()
                self.assertEqual(table.scroll_y, scroll)
                self.assertEqual(app.selected_id, "job-045")
                self.assertEqual(table.cursor_row, app.job_ids.index("job-045"))
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
                await until(lambda: isinstance(app.screen, MODULE.RequestText))
                await pilot.press("escape")
                await until(lambda: not isinstance(app.screen, MODULE.RequestText))
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


def fake_change(number, reverted=False):
    return {
        "messageId": f"m{number}",
        "index": 0,
        "at": "2026-11-01T10:00:00Z",
        "reverted": reverted,
        "entry": {"label": f"Change {number}"},
    }


def fake_run(status="running", **extra):
    return {
        "id": "run-1",
        "purpose": "manual-search",
        "status": status,
        "started_at": "2026-11-02T09:30:00Z",
        "progress": {"completedSources": 4, "totalSources": 12, "foundCount": 3},
        **extra,
    }


class PolishTest(unittest.IsolatedAsyncioTestCase):
    async def start(self, folder):
        (Path(folder) / "workspace").mkdir(exist_ok=True)
        app = MODULE.CareerRatApp(
            env={**os.environ, "CAREERRAT_HOME": folder}, bridge_args=["--no-agent"]
        )
        return app

    def shown(self, app, *ids):
        return [i for i in ids if app.query_one(f"#{i}", Button).display]

    async def test_changes_tab_with_no_changes_is_one_dim_message_and_no_buttons(self):
        with tempfile.TemporaryDirectory(prefix="careerrat-polish-") as folder:
            app = await self.start(folder)
            async with app.run_test(size=(160, 50)) as pilot:
                await until(lambda: app.snapshot)
                await pilot.click("#--content-tab-changes")
                empty = app.query_one("#changes-empty", Static)
                self.assertTrue(empty.display)
                self.assertTrue(empty.has_class("empty"))
                text = str(empty.render())
                self.assertIn("No recorded changes.", text)
                self.assertIn("Changes you or the agent make show up here, with Undo.", text)
                self.assertFalse(app.query_one("#change-controls").display)
                self.assertEqual(
                    self.shown(
                        app,
                        "previous-change",
                        "next-change",
                        "preview-undo",
                        "confirm-undo",
                        "cancel-undo",
                    ),
                    [],
                )
                self.assertFalse(app.query_one("#changes-text", Static).display)
                await pilot.press("ctrl+q")

    async def test_change_buttons_follow_position_and_preview_state(self):
        with tempfile.TemporaryDirectory(prefix="careerrat-polish-") as folder:
            app = await self.start(folder)
            async with app.run_test(size=(160, 50)) as pilot:
                await until(lambda: app.snapshot)
                await pilot.click("#--content-tab-changes")
                changes = [fake_change(1), fake_change(2), fake_change(3, reverted=True)]
                view = {"changes": changes}

                def state(ref, pending=None):
                    return {"changeRef": ref, "pendingUndo": pending}

                button = lambda i: app.query_one(f"#{i}", Button)
                app.update_changes(view, state("m1:0"))
                self.assertEqual(
                    self.shown(app, "previous-change", "next-change", "preview-undo"),
                    ["previous-change", "next-change", "preview-undo"],
                )
                self.assertTrue(button("previous-change").disabled)
                self.assertFalse(button("next-change").disabled)
                self.assertEqual(self.shown(app, "confirm-undo", "cancel-undo"), [])
                self.assertIn("Change 1 of 3", str(app.query_one("#changes-position").render()))
                app.update_changes(view, state("m2:0"))
                self.assertFalse(button("previous-change").disabled)
                self.assertFalse(button("next-change").disabled)
                app.update_changes(view, state("m3:0"))
                self.assertTrue(button("next-change").disabled)
                self.assertTrue(button("preview-undo").disabled)
                self.assertIn("already undone", str(app.query_one("#changes-position").render()))
                app.update_changes(view, state("m2:0", pending={"preview": True}))
                self.assertEqual(
                    self.shown(
                        app,
                        "previous-change",
                        "next-change",
                        "preview-undo",
                        "confirm-undo",
                        "cancel-undo",
                    ),
                    ["confirm-undo", "cancel-undo"],
                )
                self.assertFalse(app.query_one("#changes-empty").display)
                await pilot.press("ctrl+q")

    async def test_the_change_controls_stay_on_one_row_inside_the_pane(self):
        for size in ((160, 50), (120, 40)):
            with tempfile.TemporaryDirectory(prefix="careerrat-polish-") as folder:
                app = await self.start(folder)
                async with app.run_test(size=size) as pilot:
                    await until(lambda: app.snapshot)
                    await pilot.click("#--content-tab-changes")
                    view = {"changes": [fake_change(1), fake_change(2)]}
                    for pending in (None, {"preview": True}):
                        app.update_changes(view, {"changeRef": "m1:0", "pendingUndo": pending})
                        await pilot.pause()
                        pane = app.query_one("#changes").region
                        visible = [
                            b for b in app.query_one("#change-controls").query(Button) if b.display
                        ]
                        self.assertTrue(visible)
                        for widget in visible:
                            region = widget.region
                            self.assertEqual(region.height, 1, widget.id)
                            self.assertEqual(region.y, visible[0].region.y, widget.id)
                            self.assertLessEqual(region.right, pane.right, f"{widget.id} {size}")
                            self.assertGreaterEqual(region.x, pane.x, widget.id)
                    await pilot.press("ctrl+q")

    async def test_empty_tabs_read_as_one_dim_centered_message(self):
        with tempfile.TemporaryDirectory(prefix="careerrat-polish-") as folder:
            app = await self.start(folder)
            async with app.run_test(size=(160, 50)) as pilot:
                await until(lambda: app.snapshot)
                for widget_id, phrase in (
                    ("details", "No jobs in this view."),
                    ("assessment-summary", "No selected job."),
                    ("history-text", "No selected job."),
                    ("workspace-history-text", "No workspace history yet."),
                ):
                    widget = app.query_one(f"#{widget_id}", Static)
                    self.assertIn(phrase, str(widget.render()), widget_id)
                    self.assertTrue(widget.has_class("empty"), widget_id)
                await pilot.press("ctrl+q")

    async def test_no_tab_or_dialog_uses_a_tall_button(self):
        with tempfile.TemporaryDirectory(prefix="careerrat-polish-") as folder:
            app = await self.start(folder)
            for size in ((160, 50), (120, 40)):
                async with app.run_test(size=size) as pilot:
                    await until(lambda: app.snapshot)
                    for button in app.query("#inspector Button"):
                        self.assertTrue(button.has_class("-textual-compact"), button.id)
                    for opener in (
                        lambda: app.push_screen(MODULE.ContextCapture()),
                        lambda: app.push_screen(MODULE.RequestText("text", "reason")),
                    ):
                        opener()
                        await pilot.pause()
                        dialog = app.screen.query_one(".dialog")
                        for button in app.screen.query(Button):
                            self.assertEqual(button.region.height, 1, button.id)
                            self.assertTrue(
                                dialog.region.contains_region(button.region), button.id
                            )
                        await pilot.press("escape")
                        await pilot.pause()
                    await pilot.press("ctrl+q")
                app = await self.start(folder)

    async def test_search_jobs_starts_the_background_worker_not_the_agent(self):
        with tempfile.TemporaryDirectory(prefix="careerrat-polish-") as folder:
            app = await self.start(folder)
            async with app.run_test(size=(160, 50)) as pilot:
                await until(lambda: app.snapshot)
                sent = []

                async def record(message):
                    sent.append(message)

                app.send = record
                await pilot.click("#search")
                await pilot.press("s")
                self.assertEqual(sent, [{"op": "search-start"}] * 2)
                self.assertIn("background", str(app.query_one("#search").tooltip).lower())
                await pilot.press("ctrl+q")

    async def test_activity_lists_a_running_then_finished_search_and_cancels_it(self):
        with tempfile.TemporaryDirectory(prefix="careerrat-polish-") as folder:
            app = await self.start(folder)
            async with app.run_test(size=(160, 50)) as pilot:
                await until(lambda: app.snapshot)
                self.assertTrue(app.query_one("#activity-empty").display)
                app.update_activity({"searchRuns": [fake_run()]})
                await pilot.click("#--content-tab-activity")
                self.assertFalse(app.query_one("#activity-empty").display)
                text = str(app.query_one("#run-0-text", Static).render())
                self.assertIn("Search · running · 4/12 sources · 3 found", text)
                self.assertIn("Started 2026-11-02 09:30", text)
                self.assertTrue(app.query_one("#cancel-run-0", Button).display)
                self.assertFalse(app.query_one("#review-run-0", Button).display)
                self.assertEqual(
                    str(app.query_one("#inspector").get_tab("activity").label), "Activity ●"
                )
                sent = []

                async def record(message):
                    sent.append(message)

                app.send = record
                await pilot.click("#cancel-run-0")
                self.assertEqual(sent, [{"op": "search-cancel", "id": "run-1"}])
                done = fake_run(
                    "completed",
                    summary={"new": 3},
                    health={"status": "degraded", "message": "2 of 8 sources failed", "failed": 2},
                )
                app.update_activity({"searchRuns": [done]})
                await pilot.pause()
                self.assertIn(
                    "Search finished: 3 new jobs, 2 sources failed. See Activity.",
                    str(app.query_one("#message", Static).render()),
                )
                self.assertFalse(app.query_one("#cancel-run-0", Button).display)
                self.assertTrue(app.query_one("#review-run-0", Button).display)
                self.assertEqual(
                    str(app.query_one("#inspector").get_tab("activity").label), "Activity"
                )
                self.assertIn("2 of 8 sources failed", str(app.query_one("#run-0-text").render()))
                # Offered, never sent for the user.
                self.assertEqual(sent, [{"op": "search-cancel", "id": "run-1"}])
                await pilot.click("#review-run-0")
                self.assertEqual(sent[-1], {"op": "request", "action": "review"})
                await pilot.press("ctrl+q")

    async def test_kitty_keys_map_to_a_newline_and_plain_enter_still_submits(self):
        from textual._xterm_parser import XTermParser

        def reported(sequence):
            parser = XTermParser()
            keys = list(parser.feed(sequence)) + list(parser.tick())
            return [(event.key, event.character) for event in keys]

        for sequence, key in (
            ("\x1b[13;2u", "shift+enter"),
            ("\x1b[13;130u", "shift+enter"),
            ("\x1b[13;5u", "ctrl+enter"),
            ("\n", "ctrl+j"),
            ("\r", "enter"),
        ):
            (got, character), = reported(sequence)
            self.assertEqual(got, key, repr(sequence))
            self.assertEqual(
                MODULE.key_bytes(got, character), "\r" if key == "enter" else "\n", key
            )

    def test_textual_enables_and_restores_the_kitty_disambiguate_flag(self):
        import inspect
        from textual.drivers import linux_driver

        start = inspect.getsource(linux_driver.LinuxDriver.start_application_mode)
        stop = inspect.getsource(linux_driver.LinuxDriver.stop_application_mode)
        self.assertIn("KITTY_DISAMBIGUATE_ESCAPE_CODES", start)
        self.assertIn("\\x1b[>", start)
        self.assertIn("\\x1b[<u", stop)


if __name__ == "__main__":
    unittest.main()
