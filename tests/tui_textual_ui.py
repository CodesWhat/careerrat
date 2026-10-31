import asyncio
import importlib.util
import json
import os
from pathlib import Path
import shutil
import tempfile
import unittest

from textual.widgets import DataTable, Input, TabbedContent
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


if __name__ == "__main__":
    unittest.main()
