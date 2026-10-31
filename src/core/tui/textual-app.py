"""Textual development entry backed by CareerRat's canonical Node owners."""

import asyncio
import json
import os
from pathlib import Path
import shutil
import signal
import sys

from rich.text import Text
from textual import events
from textual.app import App, ComposeResult
from textual.binding import Binding
from textual.containers import Grid, Horizontal, Vertical
from textual.geometry import Offset
from textual.screen import ModalScreen
from textual.widget import Widget
from textual.widgets import (
    Button,
    DataTable,
    Footer,
    Header,
    Input,
    Select,
    Static,
    TabbedContent,
    TabPane,
    TextArea,
)

ROOT = Path(__file__).resolve().parents[3]
KEYS = {
    "enter": "\r",
    "backspace": "\x7f",
    "tab": "\t",
    "shift+tab": "\x1b[Z",
    "escape": "\x1b",
    "up": "\x1b[A",
    "down": "\x1b[B",
    "right": "\x1b[C",
    "left": "\x1b[D",
    "home": "\x1b[H",
    "end": "\x1b[F",
    "delete": "\x1b[3~",
    "pageup": "\x1b[5~",
    "pagedown": "\x1b[6~",
}


class NativePane(Widget):
    can_focus = True
    frame = None

    def render(self):
        if not self.frame:
            return Text("Saved jobs work without an agent.\nF6 switches jobs / agent.")
        text = Text()
        for index, line in enumerate(self.frame["lines"]):
            if index:
                text.append("\n")
            text.append_text(Text.from_ansi(line))
        return text

    def place_cursor(self):
        if self.has_focus and self.frame:
            cursor = self.frame["cursor"]
            self.app.cursor_position = self.content_region.offset + Offset(
                cursor["x"], cursor["y"]
            )

    def on_focus(self):
        self.place_cursor()

    async def on_key(self, event: events.Key):
        data = KEYS.get(event.key)
        if data is None and event.key.startswith("ctrl+") and len(event.key) == 6:
            data = chr(ord(event.key[-1].upper()) - 64)
        if data is None:
            data = event.character
        if data is not None:
            await self.app.send({"op": "input", "data": data})
        event.stop()
        event.prevent_default()

    async def on_paste(self, event: events.Paste):
        await self.app.send({"op": "paste", "data": event.text})
        event.stop()

    async def on_resize(self):
        await self.app.resize_agent()


class ContextCapture(ModalScreen):
    CSS = """
    ContextCapture { align: center middle; background: $background 70%; }
    #capture-dialog { width: 85%; height: 70%; padding: 1 2; border: round $accent; background: $surface; }
    #context-text { height: 1fr; margin: 1 0; }
    #capture-buttons { height: 3; }
    """

    def compose(self) -> ComposeResult:
        with Vertical(id="capture-dialog"):
            yield Static(
                "Add context: paste a JD, transcript, notes or a local file path.\nCareerRat saves a private copy before asking the agent to use it.",
                markup=False,
            )
            yield TextArea(id="context-text")
            with Horizontal(id="capture-buttons"):
                yield Button("Save context", id="save-context", variant="primary")
                yield Button("Cancel", id="cancel-context")

    async def on_button_pressed(self, event):
        if event.button.id == "save-context":
            value = self.query_one(TextArea).text
            if not value.strip():
                return
            await self.app.send({"op": "capture", "text": value})
        self.dismiss()


class CareerRatApp(App):
    TITLE = "CareerRat · Workspace"
    ENABLE_COMMAND_PALETTE = False
    BINDINGS = [
        Binding("f6", "switch_focus", "Jobs / agent", priority=True),
        Binding("ctrl+q", "quit", "Quit", priority=True),
    ]
    CSS = """
    #actions { height: 3; padding: 0 1; }
    #actions Button { min-width: 13; margin-right: 1; }
    #filters { height: 3; padding: 0 1; }
    #filters Select { width: 1fr; margin-right: 1; }
    #workspace { grid-size: 2 2; grid-columns: 3fr 2fr; grid-rows: 13 1fr; height: 1fr; padding: 0 1; grid-gutter: 1; }
    #jobs { height: 1fr; border: round $accent; }
    #inspector { height: 1fr; border: round $secondary; }
    TabPane { padding: 1; overflow-y: auto; }
    #native { row-span: 2; height: 1fr; border: round $primary; }
    #native:focus { border: double $accent; }
    #request { margin: 0 1; }
    #message { height: 2; padding: 0 2; color: $text-muted; }
    """

    def __init__(self, env=None, bridge_args=None):
        super().__init__()
        self.env = dict(os.environ if env is None else env)
        self.bridge_args = list(sys.argv[1:] if bridge_args is None else bridge_args)
        self.proc = None
        self.reader = None
        self.stderr_reader = None
        self.selected_id = None
        self.snapshot = None
        self.errors = []
        self.stopping = False
        self.updating = False
        self.job_ids = []
        self.table_signature = None
        self.theme = "nord"

    def compose(self) -> ComposeResult:
        yield Header()
        with Horizontal(id="actions"):
            yield Button("Search jobs", id="search", variant="primary")
            yield Button("Review matches", id="review")
            yield Button("Apply selected", id="apply")
            yield Button("Add context", id="context")
            yield Button("Refresh", id="refresh")
        with Horizontal(id="filters"):
            yield Select(
                [("All statuses", "all")], value="all", allow_blank=False, id="status"
            )
            yield Select(
                [("USD", "USD")], value="USD", allow_blank=False, id="currency"
            )
            yield Select(
                [("Base pay", "base"), ("Annual earnings", "annual-earnings")],
                value="base",
                allow_blank=False,
                id="basis",
            )
            yield Select(
                [("Highest pay first", "desc"), ("Lowest pay first", "asc")],
                value="desc",
                allow_blank=False,
                id="order",
            )
        with Grid(id="workspace"):
            yield DataTable(id="jobs", cursor_type="row")
            yield NativePane(id="native")
            with TabbedContent(id="inspector"):
                with TabPane("Job details", id="fit"):
                    yield Static(id="details", markup=False)
                with TabPane("History", id="history"):
                    yield Static(id="history-text", markup=False)
                with TabPane("Changes", id="changes"):
                    yield Static(id="changes-text", markup=False)
                    with Horizontal():
                        yield Button("Previous", id="previous-change")
                        yield Button("Next", id="next-change")
                        yield Button("Preview Undo", id="preview-undo")
                    with Horizontal():
                        yield Button("Confirm Undo", id="confirm-undo", disabled=True)
                        yield Button("Cancel", id="cancel-undo")
        yield Input(
            id="request",
            disabled=True,
            placeholder="Requests insert text only. Press Enter in the agent to run.",
        )
        yield Static("Connecting to saved workspace…", id="message", markup=False)
        yield Footer()

    async def on_mount(self):
        loop = asyncio.get_running_loop()
        if sys.platform != "win32":
            for name in (signal.SIGTERM, signal.SIGHUP):
                loop.add_signal_handler(name, self.exit)
        self.query_one("#jobs", DataTable).add_columns(
            "Company", "Role", "Status", "Fit", "Pay"
        )
        self.query_one("#native").border_title = "Native agent · F6 to focus"
        node = self.env.get("CAREERRAT_NODE") or shutil.which(
            "node", path=self.env.get("PATH")
        )
        if not node:
            raise RuntimeError("Node.js is required for the CareerRat workspace")
        self.proc = await asyncio.create_subprocess_exec(
            node,
            str(Path(__file__).with_name("textual-bridge.mjs")),
            *self.bridge_args,
            cwd=ROOT,
            env=self.env,
            stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            limit=32 * 1024 * 1024,
        )
        self.reader = asyncio.create_task(self.read_events())
        self.stderr_reader = asyncio.create_task(self.read_errors())
        await self.resize_agent()
        self.query_one("#jobs").focus()

    async def send(self, message):
        if self.proc and self.proc.returncode is None:
            try:
                self.proc.stdin.write((json.dumps(message) + "\n").encode())
                await self.proc.stdin.drain()
            except (BrokenPipeError, ConnectionResetError):
                if not self.stopping:
                    self.show_message(
                        "Workspace connection closed. Saved data remains available."
                    )

    async def resize_agent(self):
        if self.proc and not self.stopping:
            pane = self.query_one(NativePane)
            await self.send(
                {
                    "op": "resize",
                    "cols": max(1, pane.content_size.width),
                    "rows": max(1, pane.content_size.height),
                }
            )

    def show_message(self, text):
        self.query_one("#message", Static).update(text)

    async def read_errors(self):
        while line := await self.proc.stderr.readline():
            if not self.stopping:
                self.show_message(line.decode(errors="replace").strip())

    async def read_events(self):
        try:
            while line := await self.proc.stdout.readline():
                value = json.loads(line)
                if self.stopping:
                    continue
                kind = value["type"]
                if kind == "workspace":
                    self.update_workspace(value)
                elif kind == "frame":
                    pane = self.query_one(NativePane)
                    pane.frame = value
                    pane.refresh()
                    pane.place_cursor()
                elif kind == "request":
                    self.query_one("#request", Input).value = value["text"]
                    self.show_message(
                        "Request inserted. Review it and press Enter in the agent."
                        if value["inserted"]
                        else "No running agent. The request is available below."
                    )
                    if value["inserted"]:
                        self.query_one(NativePane).focus()
                elif kind == "context":
                    self.show_message("Context saved: " + value["path"])
                elif kind == "agent-exited":
                    self.show_message(
                        f"Agent exited ({value['exitCode']}). Saved jobs remain available."
                    )
                elif kind == "error":
                    self.errors.append(value["message"])
                    self.show_message(value["message"])
            if not self.stopping:
                self.show_message(
                    "Workspace connection closed. Quit and reopen to reconnect."
                )
        except (ValueError, OSError) as error:
            self.errors.append(str(error))
            if not self.stopping:
                self.show_message(str(error))

    def update_workspace(self, value):
        self.snapshot = value
        view, state = value["view"], value["state"]
        self.selected_id = view["selectedId"]
        jobs = view["jobs"]
        table = self.query_one("#jobs", DataTable)
        signature = json.dumps(jobs, sort_keys=True)
        self.updating = True
        try:
            if signature != self.table_signature:
                self.table_signature = signature
                table.clear()
                self.job_ids = [job["id"] for job in jobs]
                for job in jobs:
                    row, pay = job["record"], job["pay"]
                    numbers = [
                        str(int(pay[key]))
                        for key in ("min", "max")
                        if pay[key] is not None
                    ]
                    label = "–".join(dict.fromkeys(numbers)) or "Unknown"
                    if numbers:
                        label = (
                            f"{pay['currency'] or '?'} {label} / {pay['basis'] or '?'}"
                        )
                    table.add_row(
                        *[
                            Text(str(item))
                            for item in (
                                row.get("company", ""),
                                row.get("role", ""),
                                job["stage"]["label"],
                                (row.get("evaluation") or {}).get("gate", "—"),
                                label,
                            )
                        ],
                        key=job["id"],
                    )
            if self.selected_id in self.job_ids:
                table.move_cursor(row=self.job_ids.index(self.selected_id))
            table.border_title = f"Saved jobs · {len(jobs)} · {view['mode']}"
            stages = sorted(
                {job["stage"]["id"]: job["stage"]["label"] for job in jobs}.items()
            )
            stage_options = {
                state["stage"]: state["stage"],
                **dict(stages),
                "all": "All statuses",
            }
            # Keep all previously observed stages available while a filter is active.
            self.stage_options = {**getattr(self, "stage_options", {}), **stage_options}
            self.query_one("#status", Select).set_options(
                [(label, key) for key, label in self.stage_options.items()]
            )
            self.query_one("#status", Select).value = state["stage"]
            currencies = sorted(
                {
                    state["currency"],
                    *[job["pay"]["currency"] for job in jobs if job["pay"]["currency"]],
                }
            )
            self.query_one("#currency", Select).set_options(
                [(item, item) for item in currencies]
            )
            self.query_one("#currency", Select).value = state["currency"]
        finally:
            self.updating = False
        selected = next((job for job in jobs if job["id"] == self.selected_id), None)
        self.update_details(selected)
        changes = view.get("changes", [])
        change = next(
            (
                item
                for item in changes
                if f"{item['messageId']}:{item['index']}" == state.get("changeRef")
            ),
            None,
        )
        pending = state.get("pendingUndo")
        self.query_one("#changes-text", Static).update(
            json.dumps(pending or change, indent=2, ensure_ascii=False)
            if pending or change
            else "No recorded changes."
        )
        self.query_one("#confirm-undo", Button).disabled = not bool(pending)
        run = next(iter(view.get("searchRuns", [])), None)
        self.show_message(
            state.get("message")
            or (
                f"Search {run['status']} · {run['id']}"
                if run
                else "Click a job to inspect it. Requests wait for Enter in the native agent."
            )
        )

    def update_details(self, selected):
        if not selected:
            self.query_one("#details", Static).update("No jobs in this view.")
            self.query_one("#history-text", Static).update("No selected job.")
            return
        row = selected["record"]
        lines = [
            f"{row.get('company', '')} · {row.get('role', '')}",
            "",
            row.get("statusNote", ""),
            row.get("nextAction", ""),
        ]
        fit = row.get("roleFit") or {}
        for key in ("why", "risks"):
            if fit.get(key):
                lines += ["", key.title(), *["• " + str(item) for item in fit[key]]]
        lines += [
            "",
            "Saved documents",
            json.dumps(row.get("artifacts", {}), indent=2, ensure_ascii=False),
        ]
        self.query_one("#details", Static).update("\n".join(lines))
        messages = (selected.get("thread") or {}).get("messages", []) + selected.get(
            "contextMessages", []
        )
        messages += self.snapshot["view"].get("workspaceMessages", [])
        self.query_one("#history-text", Static).update(
            "\n\n".join(
                f"{item.get('role', '')} · {item.get('createdAt', '')}\n{item.get('text', '')}"
                for item in messages
            )
            or "No saved conversation yet."
        )

    async def on_data_table_row_highlighted(self, event):
        if (
            self.updating
            or not event.row_key.value
            or event.row_key.value == self.selected_id
        ):
            return
        await self.send({"op": "select", "id": event.row_key.value})

    async def on_select_changed(self, event):
        field = {
            "status": "stage",
            "currency": "currency",
            "basis": "basis",
            "order": "order",
        }.get(event.select.id)
        if (
            not self.updating
            and field
            and isinstance(event.value, str)
            and self.snapshot
            and self.snapshot["state"].get(field) != event.value
        ):
            await self.send({"op": "view", field: event.value})

    async def on_button_pressed(self, event):
        name = event.button.id
        if name == "context":
            self.push_screen(ContextCapture())
        elif name == "refresh":
            await self.send({"op": "refresh"})
        elif name in ("search", "review", "apply"):
            await self.send({"op": "request", "action": name})
        elif name in (
            "previous-change",
            "next-change",
            "preview-undo",
            "confirm-undo",
            "cancel-undo",
        ):
            key = {
                "previous-change": "[",
                "next-change": "]",
                "preview-undo": "u",
                "confirm-undo": "enter",
                "cancel-undo": "escape",
            }[name]
            await self.send({"op": "key", "name": key})

    def action_switch_focus(self):
        pane = self.query_one(NativePane)
        (self.query_one("#jobs") if pane.has_focus else pane).focus()

    async def on_unmount(self):
        self.stopping = True
        if self.proc:
            await self.send({"op": "quit"})
            try:
                await asyncio.wait_for(self.proc.wait(), 7)
            except asyncio.TimeoutError:
                self.proc.terminate()
                try:
                    await asyncio.wait_for(self.proc.wait(), 4)
                except asyncio.TimeoutError:
                    self.proc.kill()
                    await self.proc.wait()
            for task in (self.reader, self.stderr_reader):
                if task:
                    await task
        if sys.platform != "win32":
            for name in (signal.SIGTERM, signal.SIGHUP):
                asyncio.get_running_loop().remove_signal_handler(name)


if __name__ == "__main__":
    CareerRatApp().run()
