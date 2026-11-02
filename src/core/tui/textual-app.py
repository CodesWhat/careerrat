"""Textual development entry backed by CareerRat's canonical Node owners."""

import asyncio
import json
import os
from pathlib import Path
import re
import shutil
import signal
import sys
import time

from rich.text import Text
from textual import events
from textual.app import App, ComposeResult
from textual.binding import Binding
from textual.containers import Grid, Horizontal, Vertical
from textual.geometry import Offset
from textual.screen import ModalScreen
from textual.widget import Widget
from textual.widgets._select import SelectOverlay
from textual.widgets import (
    Button,
    DataTable,
    Footer,
    Header,
    Input,
    Label,
    MarkdownViewer,
    Select,
    Static,
    TabbedContent,
    TabPane,
    TextArea,
)

HOLD_SECONDS = 12
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


def sorted_messages(messages):
    return sorted(
        (item for item in messages if isinstance(item, dict)),
        key=lambda item: str(item.get("createdAt") or ""),
    )


def format_messages(messages):
    return "\n\n".join(
        f"{item.get('role') or ''} · {item.get('createdAt') or ''}\n{item.get('text') or ''}"
        for item in messages
    )


JOB_COLUMNS = ["Company", "Role", "Status", "Fit", "Pay"]
# Columns that keep a set width; the rest share what is left.
FIXED_WIDTHS = {"Status": 12, "Fit": 10, "Pay": 14}
MINIMUM_WIDTHS = {"Company": 12, "Role": 12, "Status": 10, "Fit": 7, "Pay": 9}
# Narrow screens give these up first. Company and Status always stay.
DROP_ORDER = ["Role", "Pay", "Fit"]
CELL_PADDING = 2


def clean(value):
    """Readable text for a saved field, or "" when it holds nothing."""
    if value is None or isinstance(value, bool):
        return ""
    if isinstance(value, str):
        return value.strip()
    if isinstance(value, (int, float)):
        return f"{value:,}" if isinstance(value, int) else f"{value:g}"
    if isinstance(value, (list, tuple)):
        return ", ".join(part for part in (clean(item) for item in value) if part)
    return ""


def clip(value, width):
    """One line, cut with an ellipsis when it does not fit."""
    text = Text(" ".join(clean(value).split()), no_wrap=True)
    text.truncate(max(width, 1), overflow="ellipsis")
    return text


def plan_columns(available):
    """Pick the columns that fit and give each a width."""
    names = list(JOB_COLUMNS)

    def need(items):
        return sum(
            FIXED_WIDTHS.get(name, MINIMUM_WIDTHS[name]) + CELL_PADDING
            for name in items
        )

    for name in DROP_ORDER:
        if need(names) <= available:
            break
        names.remove(name)
    flexible = [n for n in names if n not in FIXED_WIDTHS]
    fixed = {n: FIXED_WIDTHS[n] for n in names if n in FIXED_WIDTHS}
    if need(names) > available:
        fixed = {n: MINIMUM_WIDTHS[n] for n in fixed}
    spare = available - sum(w + CELL_PADDING for w in fixed.values())
    spare -= sum(MINIMUM_WIDTHS[n] + CELL_PADDING for n in flexible)
    spare = max(spare, 0)
    shares = {"Company": 0.4, "Role": 0.6} if len(flexible) == 2 else {"Company": 1}
    widths = {n: MINIMUM_WIDTHS[n] + int(spare * shares[n]) for n in flexible}
    return [(name, widths.get(name) or fixed[name]) for name in names]


def short_amount(value):
    value = int(value)
    return f"{round(value / 1000, 1):g}k" if value >= 1000 else str(value)


def pay_label(pay, currency=None):
    """Compact pay for the table; a dash when nothing is known."""
    low, high = pay.get("min"), pay.get("max")
    if low is None and high is None:
        return "—"
    if low is None:
        amount = f"≤{short_amount(high)}"
    elif high is None:
        amount = f"≥{short_amount(low)}"
    elif low == high:
        amount = short_amount(low)
    else:
        amount = f"{short_amount(low)}–{short_amount(high)}"
    code = pay.get("currency")
    return amount if code and code == currency else f"{code or '?'} {amount}"


def job_cells(job, currency=None):
    record = job["record"]
    fit = job.get("fit") or {}
    return {
        "Company": clean(record.get("company")),
        "Role": clean(record.get("role")),
        "Status": clean((job.get("stage") or {}).get("label")),
        "Fit": clean(fit.get("label")) or "—",
        "Pay": pay_label(job.get("pay") or {}, currency),
    }


def has_saved_jd(record):
    return bool(clean((record.get("artifacts") or {}).get("jd")))


def _label(key):
    spaced = re.sub(r"(?<=[a-z0-9])(?=[A-Z])", " ", key).lower()
    return {"jd": "Job description"}.get(key) or spaced.capitalize()


def saved_documents(artifacts, limit=10):
    """File names the job has on record, one readable line each."""
    if not isinstance(artifacts, dict):
        return []
    lines, seen = [], set()
    for key, value in artifacts.items():
        if "token" in key.lower() or not isinstance(value, str):
            continue
        value = value.strip()
        name = Path(value).name
        if (
            not value
            or "://" in value
            or name in seen
            or not re.search(r"\.[A-Za-z][A-Za-z0-9]{1,4}$", name)
        ):
            continue
        seen.add(name)
        lines.append(f"{_label(key)}: {name}")
    if len(lines) > limit:
        lines = [*lines[:limit], f"and {len(lines) - limit} more"]
    return lines


def bullet_lines(value):
    items = value if isinstance(value, (list, tuple)) else [value]
    return ["• " + text for text in (clean(item) for item in items) if text]


def labeled(*pairs):
    return [f"{label}: {clean(value)}" for label, value in pairs if clean(value)]


def suggested_action(row):
    """The saved action, unless it only repeats the verdict already shown."""
    gate = row.get("gate") if isinstance(row.get("gate"), dict) else {}
    evaluation = row.get("evaluation") or {}
    action = clean(row.get("action")) or clean(gate.get("action"))
    verdicts = {
        clean(value).lower()
        for value in (gate.get("gate"), row.get("fitBucket"), evaluation.get("gate"))
    }
    return "" if action.lower() in verdicts else action


def job_detail_text(job):
    row = job["record"]
    fit = job.get("fit") or {}
    title = " · ".join(
        part for part in (clean(row.get("company")), clean(row.get("role"))) if part
    )
    status = clean((job.get("stage") or {}).get("label")) or clean(row.get("status"))
    gate = row.get("gate") if isinstance(row.get("gate"), dict) else {}
    head = labeled(
        ("Status", status),
        ("Fit", fit.get("label")),
        ("Base pay", row.get("base")),
        ("Total pay", row.get("tc")),
        ("Next step", row.get("nextAction")),
        ("Suggested action", suggested_action(row)),
        ("Status note", row.get("statusNote")),
        ("Note", row.get("note")),
        ("Heads up", row.get("warn")),
        ("Ask", row.get("ask")),
        ("Apply link", row.get("link")),
    )
    sections = [[title] if title else [], head]
    fit_notes = row.get("roleFit") if isinstance(row.get("roleFit"), dict) else {}
    for key in ("why", "risks"):
        items = bullet_lines(fit_notes.get(key))
        if items:
            sections.append([key.title(), *items])
    documents = saved_documents(row.get("artifacts"))
    if documents:
        sections.append(["Saved documents", *documents])
    return "\n\n".join("\n".join(lines) for lines in sections if lines)


def fit_report_text(row, fit, has_table):
    """Summary above the requirements table, built from whatever is saved."""
    evaluation = row.get("evaluation") or {}
    if evaluation:
        return (
            f"Saved evaluation: {clean(evaluation.get('gate')) or 'Not evaluated'} · "
            f"{clean(evaluation.get('evaluatedAt')) or 'No evaluation date'}\n"
            + (
                "Scroll across for the complete evidence table."
                if has_table
                else "No saved requirements report. Use Review matches to evaluate the saved JD."
            )
        )
    gate = row.get("gate") if isinstance(row.get("gate"), dict) else {}
    verdict = clean(gate.get("gate")) or clean(row.get("fitBucket"))
    bucket = clean(row.get("fitBucket"))
    group = bucket if bucket.lower() != verdict.lower() else ""
    lines = labeled(
        ("Score", fit.get("score")),
        ("Verdict", verdict),
        ("Fit group", group),
        ("Suggested action", suggested_action(row)),
        ("Why this score", row.get("ratingReason")),
        ("Heads up", row.get("warn")),
    )
    notes = row.get("roleFit") if isinstance(row.get("roleFit"), dict) else {}
    sections = [lines]
    for key in ("why", "risks"):
        items = bullet_lines(notes.get(key))
        if items:
            sections.append([key.title(), *items])
    sections.append(
        [
            "No detailed requirement-by-requirement evidence is saved for this job."
            " Use Review matches to build it from the saved JD."
        ]
    )
    return "\n\n".join("\n".join(part) for part in sections if part)


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


class JobsTable(DataTable):
    def on_resize(self, event):
        self.app.render_jobs()


class RemoveFile(Button):
    def __init__(self, index, name):
        super().__init__("Remove", id=f"remove-file-{index}", classes="remove-file")
        self.index = index
        self.tooltip = f"Remove {name}"


class ContextCapture(ModalScreen):
    BINDINGS = [Binding("ctrl+s", "save", "Save context", priority=True)]
    CSS = """
    ContextCapture { align: center middle; background: $background 70%; }
    #capture-dialog { width: 85%; height: 70%; padding: 1 2; border: round $accent; background: $surface; }
    #attachments { height: auto; max-height: 12; overflow-y: auto; }
    .attachment { height: 3; }
    .attachment Static { width: 1fr; padding: 1 1; }
    .remove-file { min-width: 10; }
    #context-text { height: 1fr; margin: 1 0; }
    #capture-error { height: auto; color: $error; }
    #capture-buttons { height: 3; }
    """

    def __init__(self, prefill=""):
        super().__init__()
        self.prefill = prefill
        self.files = []
        self.waiting = False
        self.request_id = None

    def compose(self) -> ComposeResult:
        with Vertical(id="capture-dialog"):
            yield Static(
                "Add context: paste a JD, transcript, notes or a local file path.\nCareerRat saves a private copy before asking the agent to use it.",
                markup=False,
            )
            yield Vertical(id="attachments")
            yield TextArea(id="context-text")
            yield Static("", id="capture-error", markup=False)
            with Horizontal(id="capture-buttons"):
                yield Button("Save context", id="save-context", variant="primary")
                yield Button("Cancel", id="cancel-context")

    async def on_mount(self):
        self.query_one("#attachments").display = False
        if not self.prefill:
            self.query_one(TextArea).focus()
            return
        self.query_one(TextArea).load_text(self.prefill)
        self.set_waiting(True)
        self.request_id = self.app.next_request_id()
        await self.app.send(
            {"op": "inspect", "id": self.request_id, "text": self.prefill}
        )

    def set_waiting(self, waiting):
        self.waiting = waiting
        self.query_one("#save-context", Button).disabled = waiting
        for button in self.query(RemoveFile):
            button.disabled = waiting

    async def show_preview(self, files):
        self.request_id = None
        self.set_waiting(False)
        if files:
            self.files = list(files)
            self.query_one(TextArea).load_text("")
            await self.refresh_attachments()
        self.query_one(TextArea).focus()

    async def refresh_attachments(self):
        box = self.query_one("#attachments")
        await box.remove_children()
        self.query_one(TextArea).display = not self.files
        box.display = bool(self.files)
        for index, item in enumerate(self.files):
            await box.mount(
                Horizontal(
                    Static(item["name"], markup=False),
                    RemoveFile(index, item["name"]),
                    classes="attachment",
                )
            )

    def fail(self, message):
        self.request_id = None
        self.set_waiting(False)
        self.query_one("#capture-error", Static).update(
            f"Not saved: {message}\nYour text and files are still here. Fix it and try again."
        )

    async def action_save(self):
        if self.waiting:
            return
        value = self.query_one(TextArea).text
        if self.files:
            message = {"files": [item["path"] for item in self.files]}
        elif value.strip():
            message = {"text": value}
        else:
            return
        self.request_id = self.app.next_request_id()
        self.query_one("#capture-error", Static).update("")
        self.set_waiting(True)
        await self.app.send({"op": "capture", "id": self.request_id, **message})

    async def on_button_pressed(self, event):
        event.stop()
        button = event.button
        if isinstance(button, RemoveFile):
            if not self.waiting and 0 <= button.index < len(self.files):
                del self.files[button.index]
                await self.refresh_attachments()
        elif button.id == "save-context":
            await self.action_save()
        elif button.id == "cancel-context":
            self.dismiss()


class JobDocument(ModalScreen):
    CSS = """
    JobDocument { align: center middle; background: $background 70%; }
    #document-dialog { width: 90%; height: 90%; padding: 1 2; border: round $accent; background: $surface; }
    #jd-viewer { height: 1fr; margin: 1 0; }
    """

    def __init__(self, document):
        super().__init__()
        self.document = document

    def compose(self) -> ComposeResult:
        artifact = self.document["artifact"]
        with Vertical(id="document-dialog"):
            yield Static(
                f"{self.document.get('company') or ''} · {self.document.get('role') or ''}\nSaved JD · {artifact['completeness']}",
                markup=False,
            )
            yield MarkdownViewer(
                artifact["markdown"],
                show_table_of_contents=False,
                open_links=False,
                id="jd-viewer",
            )
            yield Button("Close", id="close-document")

    def on_button_pressed(self, event):
        event.stop()
        self.dismiss()


class RequestText(ModalScreen):
    """A request that has no agent to receive it: readable, selectable, copyable."""

    CSS = """
    RequestText { align: center middle; background: $background 70%; }
    #request-dialog { width: 85%; height: 60%; padding: 1 2; border: round $accent; background: $surface; }
    #request-body { height: 1fr; margin: 1 0; }
    #request-buttons { height: 3; }
    """
    BINDINGS = [Binding("escape", "close", "Close")]

    def __init__(self, text, reason):
        super().__init__()
        self.text = text
        self.reason = reason

    def compose(self) -> ComposeResult:
        with Vertical(id="request-dialog"):
            yield Static(
                f"{self.reason}\nThis is the request CareerRat would have sent. Copy it into your own agent to run it.",
                markup=False,
            )
            yield TextArea(self.text, read_only=True, id="request-body")
            with Horizontal(id="request-buttons"):
                yield Button("Copy request", id="copy-request", variant="primary")
                yield Button("Close", id="close-request")

    def on_mount(self):
        self.query_one("#request-body", TextArea).focus()

    def action_close(self):
        self.dismiss()

    def on_button_pressed(self, event):
        event.stop()
        if event.button.id == "copy-request":
            self.app.copy_to_clipboard(self.text)
            event.button.label = "Copied"
        else:
            self.dismiss()


class CareerRatApp(App):
    TITLE = "CareerRat · Workspace"
    AUTO_FOCUS = "#jobs"
    ENABLE_COMMAND_PALETTE = False
    BINDINGS = [
        Binding("f6", "switch_focus", "Jobs / agent", priority=True),
        Binding("ctrl+q", "quit", "Quit", priority=True),
    ]
    CSS = """
    #toolbar { height: auto; padding: 0 1; layout: vertical; }
    #toolbar.wide { height: 1; layout: horizontal; }
    #actions, #filters { height: 1; }
    #actions { width: 1fr; }
    #filters { width: 1fr; align-horizontal: right; }
    #toolbar.wide #filters { width: auto; }
    #toolbar Button { min-width: 0; margin-right: 1; background: $surface; color: $foreground; text-style: none; }
    #toolbar Button.-primary { background: $primary-muted; color: $text; }
    #toolbar Button:hover { background: $surface-lighten-2; }
    #toolbar Button:focus { background: $accent-muted; color: $text; text-style: bold; }
    #toolbar Label { color: $text-muted; margin-right: 1; height: 1; }
    #toolbar Select { margin-right: 2; height: 1; }
    #toolbar Select > SelectCurrent { background: $surface; }
    #toolbar Select > SelectCurrent:hover { background: $surface-lighten-2; }
    #toolbar Select:focus > SelectCurrent { background: $accent-muted; border: none; }
    #filters Select:last-child { margin-right: 0; }
    #currency-label { display: none; }
    #currency { display: none; }
    #currency-label.multi, #currency.multi { display: block; }
    #workspace { grid-size: 2 2; grid-columns: 2fr 1fr; grid-rows: 3fr 2fr; height: 1fr; padding: 0 1; grid-gutter: 1; }
    #jobs { height: 1fr; border: round $accent; }
    #inspector { height: 1fr; border: round $secondary; }
    TabPane { padding: 0 1; overflow-y: auto; }
    #open-jd { margin-bottom: 1; }
    .change-controls { height: 3; }
    #native { row-span: 2; height: 1fr; border: round $primary; }
    #native:focus { border: double $accent; }
    #request { margin: 0 1; border: none; height: 1; background: $surface; padding: 0 1; }
    #request:focus { background: $accent-muted; }
    #message { height: 1; padding: 0 2; color: $text-muted; }
    #agent-status { height: auto; padding: 0 2; color: $text; background: $warning-muted; display: none; }
    #agent-status.shown { display: block; }
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
        self.job_cells = []
        self.stage_options = {}
        self.column_key = None
        self.theme = "nord"
        self.request_counter = 0
        self.held = ("", 0.0)
        self.stderr_lines = []
        self.bridge_code = 0

    def compose(self) -> ComposeResult:
        yield Header()
        with Horizontal(id="toolbar"):
            with Horizontal(id="actions"):
                yield Button("Search jobs", id="search", variant="primary", compact=True)
                yield Button("Review matches", id="review", compact=True)
                yield Button("Apply selected", id="apply", compact=True)
                yield Button("Add context", id="context", compact=True)
                yield Button("Refresh", id="refresh", compact=True)
            with Horizontal(id="filters"):
                yield Label("Status:", id="status-label")
                yield Select(
                    [("Active", "active"), ("All statuses", "all")],
                    value="active",
                    allow_blank=False,
                    compact=True,
                    id="status",
                )
                yield Label("Currency:", id="currency-label")
                yield Select(
                    [("USD", "USD")],
                    value="USD",
                    allow_blank=False,
                    compact=True,
                    id="currency",
                )
                yield Label("Pay:", id="basis-label")
                yield Select(
                    [("Base", "base"), ("Annual earnings", "annual-earnings")],
                    value="base",
                    allow_blank=False,
                    compact=True,
                    id="basis",
                )
                yield Select(
                    [("Highest first", "desc"), ("Lowest first", "asc")],
                    value="desc",
                    allow_blank=False,
                    compact=True,
                    id="order",
                )
        with Grid(id="workspace"):
            yield JobsTable(id="jobs", cursor_type="row")
            yield NativePane(id="native")
            with TabbedContent(id="inspector"):
                with TabPane("Job details", id="fit"):
                    yield Button("Read saved JD", id="open-jd", compact=True)
                    yield Static(id="details", markup=False)
                with TabPane("Fit report", id="assessment"):
                    yield Static(id="assessment-summary", markup=False)
                    yield DataTable(id="requirements", cursor_type="row")
                with TabPane("History", id="history"):
                    yield Static(id="history-text", markup=False)
                with TabPane("Workspace", id="workspace-history"):
                    yield Static(id="workspace-history-text", markup=False)
                with TabPane("Changes", id="changes"):
                    with Horizontal(classes="change-controls"):
                        yield Button("Previous", id="previous-change")
                        yield Button("Next", id="next-change")
                        yield Button("Preview Undo", id="preview-undo")
                    with Horizontal(classes="change-controls"):
                        yield Button("Confirm Undo", id="confirm-undo", disabled=True)
                        yield Button("Cancel", id="cancel-undo")
                    yield Static(id="changes-text", markup=False)
        yield Input(
            id="request",
            disabled=True,
            placeholder="Requests insert text only. Press Enter in the agent to run.",
        )
        yield Static("", id="agent-status", markup=False)
        yield Static("Connecting to saved workspace…", id="message", markup=False)
        yield Footer()

    async def on_mount(self):
        loop = asyncio.get_running_loop()
        if sys.platform != "win32":
            for name in (signal.SIGTERM, signal.SIGHUP):
                loop.add_signal_handler(name, self.exit)
        self.render_jobs()
        for select_id, options in {
            "status": [("Active", "active"), ("All statuses", "all")],
            "currency": [("USD", "USD")],
            "basis": [("Base", "base"), ("Annual earnings", "annual-earnings")],
            "order": [("Highest first", "desc"), ("Lowest first", "asc")],
        }.items():
            self.fit_select(self.query_one(f"#{select_id}", Select), options)
        report = self.query_one("#requirements", DataTable)
        for label, width in [
            ("Requirement", 26),
            ("JD signal", 24),
            ("Evidence / notes", 34),
            ("Match", 9),
        ]:
            report.add_column(label, width=width)
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

    def fit_select(self, select, options):
        # A compact Select does not shrink to its content. Size the closed
        # control to the chosen label and the open list to the longest one.
        select.labels = {value: label for label, value in options}
        select.longest = max((len(label) for label, _ in options), default=4)
        self.size_select(select)

    def size_select(self, select):
        label = select.labels.get(select.value, "")
        select.styles.width = len(label) + 3
        select.query_one(SelectOverlay).styles.min_width = select.longest + 3

    def on_resize(self, event):
        toolbar = self.query("#toolbar")
        if toolbar:
            toolbar.first().set_class(event.size.width >= 150, "wide")

    def next_request_id(self):
        self.request_counter += 1
        return self.request_counter

    def capture_modal(self, request_id):
        screen = self.screen
        if (
            isinstance(screen, ContextCapture)
            and request_id is not None
            and screen.request_id == request_id
        ):
            return screen
        return None

    async def on_paste(self, event: events.Paste):
        # Native agent and text inputs stop their own paste; anything else lands here.
        if len(self.screen_stack) > 1 or not event.text.strip():
            return
        event.stop()
        self.push_screen(ContextCapture(prefill=event.text))

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

    def search_status_line(self, run):
        """One honest line for the latest search, including source health."""
        saved = (run.get("summary") or {}).get("new") or 0
        health = run.get("health") or {}
        line = f"Search {run['status']}"
        if run["status"] != "running":
            line += f" · {saved} saved"
            if health and health.get("status") != "ok":
                line += f" · {health.get('status')}: {health.get('message')}"
        return f"{line} · {run['id']}"

    def show_message(self, text, hold=0):
        """Show a message; with hold, snapshots can't replace it for that many seconds."""
        if hold:
            self.held = (text, time.monotonic() + hold)
        self.query_one("#message", Static).update(text)

    def show_status(self, text):
        # The snapshot-driven line yields to a message someone still needs to read.
        if time.monotonic() < self.held[1]:
            return
        self.show_message(text)

    def show_agent_status(self, text):
        """Agent trouble stays on screen in its own line until the app is closed."""
        banner = self.query_one("#agent-status", Static)
        banner.update(text)
        banner.set_class(bool(text), "shown")

    async def read_errors(self):
        while line := await self.proc.stderr.readline():
            text = line.decode(errors="replace").strip()
            if text:
                self.stderr_lines.append(text)
            if not self.stopping and text:
                self.show_message(text, hold=HOLD_SECONDS)

    async def read_events(self):
        try:
            while line := await self.proc.stdout.readline():
                try:
                    await self.handle_event(json.loads(line))
                except asyncio.CancelledError:
                    raise
                except Exception as error:
                    self.errors.append(str(error))
                    if not self.stopping:
                        self.show_message(str(error), hold=HOLD_SECONDS)
            await self.bridge_closed()
        except (ValueError, OSError) as error:
            self.errors.append(str(error))
            if not self.stopping:
                self.show_message(str(error), hold=HOLD_SECONDS)

    async def bridge_closed(self):
        """The bridge ended. Say why, and fail the launch if it never got started."""
        if self.stopping:
            return
        code = await self.proc.wait()
        if self.stderr_reader:
            await asyncio.gather(self.stderr_reader, return_exceptions=True)
        reason = "\n".join(self.stderr_lines[-3:])
        if code and self.snapshot is None:
            self.exit(
                return_code=code,
                message=reason or f"The saved workspace could not be opened (exit {code}).",
            )
            return
        self.bridge_code = code or 0
        text = "Workspace connection closed. Quit and reopen to reconnect."
        if code:
            text = f"Workspace connection failed (exit {code}). {reason} Quit and reopen to reconnect."
        self.show_agent_status(text)
        self.show_message(text, hold=3600)

    async def handle_event(self, value):
        if self.stopping or not len(self.query("#jobs")):
            return
        kind = value["type"]
        if kind == "workspace":
            self.update_workspace(value)
        elif kind == "selection":
            self.apply_selection(value)
        elif kind == "notice":
            self.show_message(value["message"], hold=HOLD_SECONDS)
        elif kind == "agent-status":
            self.show_agent_status(value["message"])
        elif kind == "frame":
            pane = self.query_one(NativePane)
            pane.frame = value
            pane.refresh()
            pane.place_cursor()
        elif kind == "request":
            self.query_one("#request", Input).value = value["text"]
            note = value.get("notice")
            reason = value.get("reason") or "No agent is running."
            self.show_message(
                (f"{note} " if note else "")
                + (
                    "Request inserted. Review it and press Enter in the agent."
                    if value["inserted"]
                    else f"{reason} The request was not sent."
                ),
                hold=HOLD_SECONDS,
            )
            if value["inserted"]:
                self.query_one(NativePane).focus()
            else:
                self.push_screen(RequestText(value["text"], reason))
        elif kind == "document":
            self.push_screen(JobDocument(value))
        elif kind == "intake-preview":
            modal = self.capture_modal(value.get("id"))
            if modal:
                await modal.show_preview(value.get("files"))
        elif kind == "capture-error":
            modal = self.capture_modal(value.get("id"))
            if modal:
                modal.fail(value["message"])
            else:
                self.show_message(
                    "Context was not saved: " + value["message"], hold=HOLD_SECONDS
                )
        elif kind == "context":
            modal = self.capture_modal(value.get("id"))
            if modal:
                modal.dismiss()
            skipped = len(value.get("errors") or [])
            unread = [
                item.get("sourceName") or "a file"
                for item in value.get("items") or []
                if item.get("extraction") == "incomplete"
            ]
            self.show_message(
                (
                    "Saved, but not read yet: " + ", ".join(unread)
                    + ". The text couldn't be pulled out of it. Paste the text instead, or ask the agent to read it."
                    if unread
                    else "Context saved: " + value["path"]
                )
                + (f" ({skipped} file(s) could not be saved)" if skipped else ""),
                hold=HOLD_SECONDS,
            )
        elif kind == "agent-exited":
            self.show_agent_status(
                f"The agent stopped (exit {value['exitCode']}). Saved jobs remain available. "
                "Quit and reopen to start a new agent."
            )
        elif kind == "error":
            self.errors.append(value["message"])
            self.show_message(value["message"], hold=HOLD_SECONDS)

    def render_jobs(self, force=False):
        """Fit the columns to the table's width and refill the rows."""
        table = self.query_one("#jobs", DataTable)
        # Leave room for the scrollbar so adding it never changes the layout.
        width = table.size.width - 2 if table.size.width else 76
        plan = plan_columns(width)
        key = (width, tuple(plan))
        if not force and key == self.column_key:
            return
        self.column_key = key
        self.updating = True
        try:
            table.clear(columns=True)
            for name, size in plan:
                table.add_column(name, width=size, key=name)
            for job_id, cells in zip(self.job_ids, self.job_cells):
                table.add_row(
                    *[clip(cells[name], size) for name, size in plan], key=job_id
                )
            if self.selected_id in self.job_ids:
                table.move_cursor(row=self.job_ids.index(self.selected_id))
        finally:
            self.updating = False

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
                self.job_ids = [job["id"] for job in jobs]
                self.job_cells = [job_cells(job, view.get("currency")) for job in jobs]
                self.render_jobs(force=True)
            if self.selected_id in self.job_ids:
                table.move_cursor(row=self.job_ids.index(self.selected_id))
            total = view.get("total", len(jobs))
            count = str(len(jobs)) if len(jobs) == total else f"{len(jobs)} of {total}"
            table.border_title = f"Saved jobs · {count} · {view['mode']}"
            stages = [
                (item["id"], item["label"])
                for item in view.get("stages")
                or [job["stage"] for job in jobs]
            ]
            self.stage_options = {
                "active": "Active",
                "all": "All statuses",
                **{key: label for key, label in self.stage_options.items()
                   if key not in ("active", "all")},
                **dict(stages),
            }
            if state["stage"] not in self.stage_options:
                self.stage_options[state["stage"]] = state["stage"]
            currencies = sorted(
                {
                    state["currency"],
                    *[job["pay"]["currency"] for job in jobs if job["pay"]["currency"]],
                }
            )
            # Refilling a Select resets it to its first option and announces that
            # as a change; only a click should ever send a new filter.
            with self.prevent(Select.Changed):
                status = self.query_one("#status", Select)
                status_options = [
                    (label, key) for key, label in self.stage_options.items()
                ]
                status.set_options(status_options)
                self.fit_select(status, status_options)
                status.value = state["stage"]
                self.size_select(status)
                currency = self.query_one("#currency", Select)
                currency_options = [(item, item) for item in currencies]
                currency.set_options(currency_options)
                self.fit_select(currency, currency_options)
                currency.value = state["currency"]
                self.size_select(currency)
                multi = len(currencies) > 1
                currency.set_class(multi, "multi")
                self.query_one("#currency-label").set_class(multi, "multi")
        finally:
            self.updating = False
        selected = next((job for job in jobs if job["id"] == self.selected_id), None)
        self.update_details(selected, view)
        self.update_workspace_history(view)
        self.update_status(view, state)

    def update_status(self, view, state):
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
        self.show_status(
            state.get("message")
            or (
                self.search_status_line(run)
                if run
                else "Click a job to inspect it. Requests wait for Enter in the native agent."
            )
        )

    def apply_selection(self, value):
        """Move the highlight without re-reading every job."""
        if not self.snapshot:
            return
        view, state = self.snapshot["view"], value["state"]
        self.snapshot["state"] = state
        view["selectedId"] = self.selected_id = value["selectedId"]
        if self.selected_id in self.job_ids:
            index = self.job_ids.index(self.selected_id)
            table = self.query_one("#jobs", DataTable)
            if table.cursor_row != index:
                self.updating = True
                try:
                    table.move_cursor(row=index)
                finally:
                    self.updating = False
        self.update_details(
            next((j for j in view["jobs"] if j["id"] == self.selected_id), None),
            view,
        )
        self.update_status(view, state)

    def update_workspace_history(self, view):
        messages = view.get("workspaceMessages") or []
        total = view.get("workspaceMessagesTotal")
        total = total if isinstance(total, int) else len(messages)
        lines = ["Skill results and saved changes. This is not a chat transcript."]
        if not messages:
            lines = ["No workspace history yet.", *lines]
        elif total > len(messages):
            lines.append(f"Showing the latest {len(messages)} of {total}.")
        text = "\n".join(lines)
        if messages:
            text += "\n\n" + format_messages(sorted_messages(messages))
        self.query_one("#workspace-history-text", Static).update(text)

    def update_details(self, selected, view=None):
        report = self.query_one("#requirements", DataTable)
        report.clear()
        jd_button = self.query_one("#open-jd", Button)
        if not selected:
            jd_button.display = False
            report.display = False
            total = (view or {}).get("total", 0)
            self.query_one("#details", Static).update(
                f"No active jobs. Pick All statuses in the status list to see all {total} saved jobs."
                if total and (self.snapshot or {}).get("state", {}).get("stage") == "active"
                else "No jobs in this view."
            )
            self.query_one("#history-text", Static).update("No selected job.")
            self.query_one("#assessment-summary", Static).update("No selected job.")
            return
        row = selected["record"]
        evaluation = row.get("evaluation") or {}
        requirements = evaluation.get("requirements") or []
        report.display = bool(requirements)
        jd_button.display = has_saved_jd(row)
        self.query_one("#assessment-summary", Static).update(
            fit_report_text(row, selected.get("fit") or {}, bool(requirements))
        )
        for item in requirements:
            item = item or {}
            match = item.get("match") or ""
            report.add_row(
                Text(
                    f"{item.get('requirement') or ''}\n{item.get('importance') or ''}"
                ),
                Text(item.get("jdSignal") or ""),
                Text(f"{item.get('evidence') or ''}\n{item.get('note') or ''}"),
                Text(
                    match,
                    style={
                        "strong": "green",
                        "partial": "yellow",
                        "missing": "red",
                    }.get(match, "dim"),
                ),
                height=None,
            )
        self.query_one("#details", Static).update(job_detail_text(selected))
        messages = sorted_messages(
            ((selected.get("thread") or {}).get("messages") or [])
            + (selected.get("contextMessages") or [])
        )
        calls = row.get("conversations") or []
        self.query_one("#history-text", Static).update(
            format_messages(messages)
            + (
                "\n\nCalls and interviews\n"
                + "\n\n".join(
                    "\n".join(
                        filter(
                            None,
                            [
                                call.get("type") or call.get("round"),
                                call.get("at") or call.get("date"),
                                call.get("notes"),
                                call.get("compNote"),
                                call.get("processNote"),
                                *[
                                    f"{item.get('label', '')}: {item.get('note', '')}"
                                    for item in call.get("learnings") or []
                                ],
                            ],
                        )
                    )
                    for call in calls
                )
                if calls
                else ""
            )
            or "No saved conversation yet."
        )

    async def on_data_table_row_highlighted(self, event):
        if event.data_table.id != "jobs":
            return
        if (
            self.updating
            or not event.row_key.value
            or event.row_key.value == self.selected_id
        ):
            return
        await self.send({"op": "select", "id": event.row_key.value})

    async def on_select_changed(self, event):
        if hasattr(event.select, "labels"):
            self.size_select(event.select)
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
        elif name == "open-jd" and self.selected_id:
            await self.send({"op": "document", "id": self.selected_id})
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
    app = CareerRatApp()
    app.run()
    sys.exit(app.return_code or app.bridge_code or 0)
