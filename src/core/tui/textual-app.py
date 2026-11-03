"""Textual development entry backed by CareerRat's canonical Node owners."""

import asyncio
import json
import os
import traceback
from pathlib import Path
import re
import shutil
import signal
import sys
import time
from datetime import datetime

from rich.text import Text
from textual import events
from textual.app import App, ComposeResult, SystemCommand
from textual.binding import Binding
from textual.containers import Grid, Horizontal, Vertical
from textual.geometry import Offset, Region
from textual.strip import Strip
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
LOG_LIMIT_BYTES = 512 * 1024
# A window resize fires many events; the agent only needs the last one.
RESIZE_DELAY = 0.08
# One bridge event is one line. A line past this is dropped, not fatal.
EVENT_LINE_LIMIT = 32 * 1024 * 1024
OVERSIZED = object()
ROOT = Path(__file__).resolve().parents[3]
KEYS = {
    "enter": "\r",
    "backspace": "\x7f",
    "tab": "\t",
    "shift+tab": "\x1b[Z",
    "escape": "\x1b",
    "space": " ",
}
# A newline that doesn't submit. Shift+Enter only reaches us in terminals that
# report it (Kitty keyboard protocol); the agents read a bare line feed
# (Ctrl+J) as "insert a newline" in every terminal.
NEWLINE_KEYS = {"shift+enter", "ctrl+enter", "ctrl+j", "newline"}
CURSOR_KEYS = {"up": "A", "down": "B", "right": "C", "left": "D", "home": "H", "end": "F"}
TILDE_KEYS = {"insert": 2, "delete": 3, "pageup": 5, "pagedown": 6}
FUNCTION_KEYS = {
    "f1": "\x1bOP",
    "f2": "\x1bOQ",
    "f3": "\x1bOR",
    "f4": "\x1bOS",
    **{
        f"f{number}": f"\x1b[{code}~"
        for number, code in zip(
            range(5, 13), (15, 17, 18, 19, 20, 21, 23, 24)
        )
    },
}
# xterm's modifier parameter: 1 + shift(1) + alt(2) + ctrl(4).
MODIFIER_BITS = {"shift": 1, "alt": 2, "meta": 2, "ctrl": 4}


def keep_alt_enter():
    """Report ESC + CR as alt+enter.

    Textual's parser drops the ESC when the next key has a multi-character name,
    so a terminal that sends Shift+Enter as ESC CR (a Ghostty keybind, or any
    meta-sends-escape terminal) delivered a plain Enter, which submits.
    """
    try:
        from textual._xterm_parser import XTermParser
    except ImportError:
        return
    original = XTermParser._sequence_to_key_events
    if getattr(original, "keeps_alt_enter", False):
        return

    def sequence_to_key_events(self, sequence, alt=False):
        if alt and sequence == "\r":
            yield events.Key("alt+enter", None)
            return
        yield from original(self, sequence, alt)

    sequence_to_key_events.keeps_alt_enter = True
    XTermParser._sequence_to_key_events = sequence_to_key_events


keep_alt_enter()


def key_bytes(key, character=None):
    """What the native agent should receive for a Textual key, or None."""
    if key in NEWLINE_KEYS:
        return "\n"
    if key in KEYS:
        return KEYS[key]
    *held, base = key.split("+") if key != "+" else ["+"]
    if any(name not in MODIFIER_BITS for name in held):
        return character
    modifier = 1 + sum(MODIFIER_BITS[name] for name in set(held))
    if held == ["alt"] and base == "enter":
        return "\x1b\r"
    if base in CURSOR_KEYS:
        final = CURSOR_KEYS[base]
        return f"\x1b[1;{modifier}{final}" if held else f"\x1b[{final}"
    if base in TILDE_KEYS:
        code = TILDE_KEYS[base]
        return f"\x1b[{code};{modifier}~" if held else f"\x1b[{code}~"
    if base in FUNCTION_KEYS:
        sequence = FUNCTION_KEYS[base]
        if not held:
            return sequence
        if sequence.startswith("\x1bO"):
            return f"\x1b[1;{modifier}{sequence[-1]}"
        return sequence[:-1] + f";{modifier}~"
    if held == ["ctrl"] and len(base) == 1 and base.isalpha():
        return chr(ord(base.upper()) - 64)
    if held == ["ctrl"] and base in ("space", "at", "@"):
        return "\x00"
    if held == ["ctrl"] and base in "[]\\^_" and len(base) == 1:
        return chr(ord(base) - 64)
    if held == ["alt"] and base == "backspace":
        return "\x1b\x7f"
    if held == ["alt"] and character and character.isprintable():
        return "\x1b" + character
    return character


async def read_event_line(reader):
    """The next bridge line, OVERSIZED if it ran past the limit (the rest of it
    is discarded so later events still arrive), or b"" at the end of the stream."""
    skipped = False
    while True:
        try:
            line = await reader.readuntil(b"\n")
        except asyncio.LimitOverrunError as error:
            await reader.readexactly(error.consumed)
            skipped = True
            continue
        except asyncio.IncompleteReadError as error:
            return b"" if skipped else error.partial
        return OVERSIZED if skipped else line


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


RUN_LABELS = {"manual-search": "Search", "first-search": "First search"}
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


TARGET_NAMES = {
    "evidence": "Evidence",
    "learning": "Learning",
    "rows:rerank": "Job ranking",
}
# Who made a recorded change, from the source the write logged.
WRITER_NAMES = {
    "settings.apply": "you",
    "screening.answer-confirm": "you",
    "knowledge.revert": "an undo",
}
VALUE_LIMIT = 48


def target_name(target):
    target = clean(target)
    if target in TARGET_NAMES:
        return TARGET_NAMES[target]
    tail = target.split(":", 1)[-1].replace("_", " ").strip()
    return tail[:1].upper() + tail[1:] if tail else ""


def value_text(value):
    """A saved value in a few readable words; long ones are clipped."""
    if value is None:
        return "unset"
    if isinstance(value, bool):
        return "yes" if value else "no"
    if isinstance(value, list):
        text = ", ".join(value_text(item) for item in value)
    elif isinstance(value, dict):
        text = f"{len(value)} field{'' if len(value) == 1 else 's'}"
    else:
        text = " ".join(clean(value).split())
    return text if len(text) <= VALUE_LIMIT else text[: VALUE_LIMIT - 1].rstrip() + "…"


def change_label(entry):
    label = clean(entry.get("label"))
    if label:
        return label
    path = clean(entry.get("path")).split(".")[-1].replace("_", " ")
    return (path[:1].upper() + path[1:]) if path else clean(entry.get("id")) or "This value"


def change_value(entry, key):
    return None if entry.get(f"{key}Absent") else entry.get(key)


def list_changes(before, after):
    if isinstance(before, list) and isinstance(after, list):
        return (
            [item for item in after if item not in before],
            [item for item in before if item not in after],
        )
    return None


def change_title(entry):
    """One line saying what a recorded change did."""
    label = change_label(entry)
    before, after = change_value(entry, "before"), change_value(entry, "after")
    lists = list_changes(before, after)
    if lists and (bool(lists[0]) != bool(lists[1])):
        added, removed = lists
        return f"Added {value_text(added)} to {label}" if added else f"Removed {value_text(removed)} from {label}"
    if entry.get("op") == "add" and isinstance(after, dict):
        return f"Added {label}"
    if entry.get("op") == "remove" and isinstance(before, dict):
        return f"Removed {label}"
    if isinstance(before, list) and isinstance(after, list):
        return f"{label}: {len(before)} items → {len(after)} items"
    return f"{label}: {value_text(before)} → {value_text(after)}"


def undo_title(entry):
    """What confirming an Undo will do, in the same words."""
    label = change_label(entry)
    before, after = change_value(entry, "before"), change_value(entry, "after")
    lists = list_changes(before, after)
    if lists and (bool(lists[0]) != bool(lists[1])):
        added, removed = lists
        return (
            f"Undo will remove {value_text(added)} from {label}."
            if added
            else f"Undo will add {value_text(removed)} back to {label}."
        )
    if entry.get("op") == "add" and isinstance(after, dict):
        return f"Undo will remove {label}."
    if entry.get("op") == "remove" and isinstance(before, dict):
        return f"Undo will add {label} back."
    if before is None:
        return f"Undo will clear {label}."
    return f"Undo will set {label} back to {value_text(before)}."


def change_time(value):
    try:
        moment = datetime.fromisoformat(str(value).replace("Z", "+00:00")).astimezone()
    except ValueError:
        return ""
    return f"{moment:%b} {moment.day}, {moment.hour % 12 or 12}:{moment:%M} {moment:%p}"


def change_text(change, undo=False):
    """A recorded change as a title and one dim line, with no ids or raw fields."""
    entry = change.get("entry") or {}
    source = entry.get("source") if isinstance(entry.get("source"), dict) else {}
    kind = clean(source.get("kind"))
    meta = [
        change_time(change.get("at")),
        target_name(entry.get("target")),
        f"by {WRITER_NAMES.get(kind, 'the agent')}" if kind and kind != "unknown" else "",
        "already undone" if change.get("reverted") else "",
    ]
    companions = len(entry.get("companions") or [])
    text = Text(undo_title(entry) if undo else change_title(entry), style="bold")
    text.append("\n" + " · ".join(part for part in meta if part), style="dim")
    if companions:
        text.append(
            f"\nAlso updated {companions} related setting{'' if companions == 1 else 's'}.",
            style="dim",
        )
    if undo:
        text.append("\nConfirm Undo to apply it, or Cancel to keep the change.", style="dim")
    return text


def run_started(run):
    value = run.get("started_at") or run.get("startedAt")
    if isinstance(value, (int, float)):
        value = time.strftime("%Y-%m-%d %H:%M", time.localtime(value / 1000 if value > 1e11 else value))
    return value.replace("T", " ")[:16] if isinstance(value, str) else ""


def run_text(run):
    """Two lines for an Activity row: what it is and where it stands, then the detail."""
    progress = run.get("progress") or {}
    health = run.get("health") or {}
    label = RUN_LABELS.get(run.get("purpose"), "Background run")
    status = run.get("status") or "unknown"
    head = f"{label} · {status}"
    if status == "running":
        head += (
            f" · {progress.get('completedSources') or 0}/{progress.get('totalSources') or '?'} sources"
            f" · {progress.get('foundCount') or 0} found"
        )
    else:
        head += f" · {(run.get('summary') or {}).get('new') or 0} new"
    started = run_started(run)
    detail = " · ".join(
        part
        for part in (
            f"Started {started}" if started else "",
            health.get("message") if status != "running" else "",
            (run.get("error") or {}).get("message") if isinstance(run.get("error"), dict) else "",
        )
        if part
    )
    return Text(head, style="bold") + (Text("\n" + detail, style="dim") if detail else Text(""))


def search_finished_line(run):
    """The one status line when a search stops."""
    error = run.get("error") if isinstance(run.get("error"), dict) else {}
    if error.get("code") == "SEARCH_CANCELLED":
        return "Search cancelled. See Activity."
    if run.get("status") != "completed":
        return f"Search {run.get('status')}: {error.get('message') or 'see Activity for the reason'}. See Activity."
    new = (run.get("summary") or {}).get("new") or 0
    failed = (run.get("health") or {}).get("failed") or 0
    line = f"Search finished: {new} new job{'' if new == 1 else 's'}"
    if failed:
        line += f", {failed} source{'' if failed == 1 else 's'} failed"
    line += ". See Activity."
    if new:
        line += " Review new matches there to ask the agent."
    return line


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
    lines = ()

    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self.strips = {}

    def apply_frame(self, value):
        """Take a frame from the bridge and repaint only the rows that changed."""
        old = self.lines
        if "lines" in value:
            lines = list(value["lines"])
        else:
            lines = list(old)
            for index, line in value["changed"]:
                if index >= len(lines):
                    lines.extend([""] * (index + 1 - len(lines)))
                lines[index] = line
        changed = [
            index
            for index in range(max(len(lines), len(old)))
            if index >= len(old) or index >= len(lines) or lines[index] != old[index]
        ]
        resized = len(lines) != len(old)
        self.lines = lines
        self.frame = {**{k: v for k, v in value.items() if k != "changed"}, "lines": lines}
        for index in changed:
            self.strips.pop(index, None)
        if resized or "lines" in value and len(changed) == len(lines):
            self.strips.clear()
            self.refresh()
        elif changed:
            gutter = self.gutter
            width = self.size.width
            self.refresh(
                *[
                    Region(0, index + gutter.top, width, 1)
                    for index in changed
                ]
            )

    def render_line(self, y):
        if not self.frame:
            return super().render_line(y)
        strip = self.strips.get(y)
        if strip is None:
            line = self.lines[y] if y < len(self.lines) else ""
            text = Text.from_ansi(line)
            strip = Strip(text.render(self.app.console)).simplify()
            self.strips[y] = strip
        return strip.adjust_cell_length(self.content_size.width)

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

    async def on_mouse_scroll_up(self, event: events.MouseScrollUp):
        await self.wheel(event, -1)

    async def on_mouse_scroll_down(self, event: events.MouseScrollDown):
        await self.wheel(event, 1)

    async def wheel(self, event, direction):
        offset = event.get_content_offset(self)
        await self.app.send(
            {
                "op": "wheel",
                "direction": direction,
                "col": offset.x if offset else 0,
                "row": offset.y if offset else 0,
            }
        )
        event.stop()
        event.prevent_default()

    async def on_key(self, event: events.Key):
        if event.key in ("shift+pageup", "shift+pagedown"):
            await self.app.send(
                {"op": "scroll", "pages": -1 if event.key == "shift+pageup" else 1}
            )
            event.stop()
            event.prevent_default()
            return
        data = key_bytes(event.key, event.character)
        if data is not None:
            await self.app.send({"op": "input", "data": data})
        event.stop()
        event.prevent_default()

    async def on_paste(self, event: events.Paste):
        await self.app.send({"op": "paste", "data": event.text})
        event.stop()

    def on_resize(self):
        self.app.schedule_agent_resize()


RUN_SLOTS = 6


class RunButton(Button):
    """A button in one Activity row; the row's run id is filled in on each snapshot."""

    def __init__(self, label, action, slot, **kwargs):
        super().__init__(label, compact=True, **kwargs)
        self.action_name = action
        self.slot = slot
        self.run_id = None


class JobsTable(DataTable):
    def on_resize(self, event):
        self.app.render_jobs()


class RemoveFile(Button):
    def __init__(self, index, name):
        super().__init__(
            "Remove", id=f"remove-file-{index}", classes="remove-file", compact=True
        )
        self.index = index
        self.tooltip = f"Remove {name}"


class ContextCapture(ModalScreen):
    BINDINGS = [
        Binding("ctrl+s", "save", "Save context", priority=True),
        Binding("escape", "close", "Cancel"),
    ]
    CSS = """
    ContextCapture { align: center middle; background: $background 70%; }
    #capture-dialog { width: 85%; height: 70%; padding: 1 2; border: round $accent; background: $surface; }
    #attachments { height: auto; max-height: 12; overflow-y: auto; margin: 1 0; }
    .attachment { height: 1; }
    .attachment Static { width: 1fr; padding: 0 1 0 0; text-overflow: ellipsis; text-wrap: nowrap; }
    #context-text { height: 1fr; margin: 1 0; }
    #capture-error { height: auto; color: $error; }
    #capture-buttons { height: 1; }
    """

    def __init__(self, prefill=""):
        super().__init__()
        self.prefill = prefill
        self.files = []
        self.waiting = False
        self.request_id = None

    def compose(self) -> ComposeResult:
        with Vertical(id="capture-dialog", classes="dialog"):
            yield Static(
                "Add context: paste a JD, transcript, notes or a local file path.\nCareerRat saves a private copy before asking the agent to use it.",
                markup=False,
            )
            yield Vertical(id="attachments")
            yield TextArea(id="context-text")
            yield Static("", id="capture-error", markup=False)
            with Horizontal(id="capture-buttons"):
                yield Button(
                    "Save context", id="save-context", variant="primary", compact=True
                )
                yield Button("Cancel", id="cancel-context", compact=True)

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

    def action_close(self):
        self.dismiss()

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
    BINDINGS = [Binding("escape", "close", "Close")]
    CSS = """
    JobDocument { align: center middle; background: $background 70%; }
    #document-dialog { width: 90%; height: 90%; padding: 1 2; border: round $accent; background: $surface; }
    #jd-viewer { height: 1fr; margin: 1 0; }
    #document-buttons { height: 1; }
    """

    def __init__(self, document):
        super().__init__()
        self.document = document

    def compose(self) -> ComposeResult:
        artifact = self.document["artifact"]
        with Vertical(id="document-dialog", classes="dialog"):
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
            with Horizontal(id="document-buttons"):
                yield Button("Close", id="close-document", compact=True)

    def action_close(self):
        self.dismiss()

    def on_button_pressed(self, event):
        event.stop()
        self.dismiss()


class RequestText(ModalScreen):
    """A request that has no agent to receive it: readable, selectable, copyable."""

    CSS = """
    RequestText { align: center middle; background: $background 70%; }
    #request-dialog { width: 85%; height: 60%; padding: 1 2; border: round $accent; background: $surface; }
    #request-body { height: 1fr; margin: 1 0; }
    #request-buttons { height: 1; }
    """
    BINDINGS = [Binding("escape", "close", "Close")]

    def __init__(self, text, reason):
        super().__init__()
        self.text = text
        self.reason = reason

    def compose(self) -> ComposeResult:
        with Vertical(id="request-dialog", classes="dialog"):
            yield Static(
                f"{self.reason}\nThis is the request CareerRat would have sent. Copy it into your own agent to run it.",
                markup=False,
            )
            yield TextArea(self.text, read_only=True, id="request-body")
            with Horizontal(id="request-buttons"):
                yield Button(
                    "Copy request", id="copy-request", variant="primary", compact=True
                )
                yield Button("Close", id="close-request", compact=True)

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
    # F1, because the agent keeps Ctrl+P for its own history.
    COMMAND_PALETTE_BINDING = "f1"
    BINDINGS = [
        Binding("f6", "switch_focus", "Jobs / agent", priority=True),
        Binding("ctrl+q", "quit", "Quit", priority=True),
        Binding("s", "request('search')", "Search jobs"),
        Binding("v", "request('review')", "Review matches"),
        Binding("a", "request('apply')", "Apply selected"),
        Binding("c", "add_context", "Add context"),
        Binding("f5", "refresh_jobs", "Refresh"),
        Binding("t", "filter('status')", "Status", show=False),
        Binding("y", "filter('currency')", "Currency", show=False),
        Binding("b", "filter('basis')", "Pay basis", show=False),
        Binding("o", "filter('order')", "Pay order", show=False),
    ]
    CSS = """
    #toolbar { height: auto; padding: 0 1; layout: vertical; }
    #toolbar.wide { height: 1; layout: horizontal; }
    #actions, #filters { height: 1; }
    #actions { width: 1fr; }
    #filters { width: 1fr; align-horizontal: right; }
    #toolbar.wide #filters { width: auto; }
    #toolbar Button, #inspector Button, .dialog Button { min-width: 0; margin-right: 1; background: $surface; color: $foreground; text-style: none; }
    #toolbar Button.-primary, #inspector Button.-primary, .dialog Button.-primary { background: $primary-muted; color: $text; }
    #toolbar Button:hover, #inspector Button:hover, .dialog Button:hover { background: $surface-lighten-2; }
    #toolbar Button:focus, #inspector Button:focus, .dialog Button:focus { background: $accent-muted; color: $text; text-style: bold; }
    #toolbar Button:disabled, #inspector Button:disabled, .dialog Button:disabled { color: $text-disabled; background: $surface; text-style: none; }
    #toolbar .group-label { color: $text-muted; margin-right: 1; }
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
    .empty { width: 100%; color: $text-muted; text-align: center; margin-top: 1; }
    #change-controls { height: 1; margin-bottom: 1; }
    #change-controls Button { margin-right: 1; }
    #changes-position { color: $text-muted; height: auto; }
    #activity-empty { margin-top: 1; }
    .run { height: auto; margin-bottom: 1; display: none; }
    .run-text { height: auto; }
    .run-buttons { height: 1; }
    .run-buttons Button { margin-right: 1; }
    #native { row-span: 2; height: 1fr; border: round $primary; }
    #native:focus { border: double $accent; }
    #request { margin: 0 1; border: none; height: 1; background: $surface; padding: 0 1; display: none; }
    #request:focus { background: $accent-muted; }
    #message { height: 1; padding: 0 2; color: $text-muted; }
    #agent-status { height: auto; padding: 0 2; color: $text; background: $warning-muted; display: none; }
    #agent-status.shown { display: block; }
    """

    def __init__(self, env=None, bridge_args=None, line_limit=EVENT_LINE_LIMIT):
        super().__init__()
        self.line_limit = line_limit
        self.detail = None
        self.last_bell = float("-inf")
        self.resize_timer = None
        self.pending_status = None
        self.status_timer = None
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
        self.run_status = {}
        self.table_signature = None
        self.rendered_ids = []
        self.rendered_rows = []
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
                yield Label("Agent:", classes="group-label")
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
                    with Horizontal(id="change-controls"):
                        yield Button("Previous", id="previous-change", compact=True)
                        yield Button("Next", id="next-change", compact=True)
                        yield Button("Preview Undo", id="preview-undo", compact=True)
                        yield Button("Confirm Undo", id="confirm-undo", compact=True)
                        yield Button("Cancel", id="cancel-undo", compact=True)
                    yield Static(id="changes-position", markup=False)
                    yield Static(id="changes-text", markup=False)
                    yield Static(
                        "No recorded changes.\nChanges you or the agent make show up here, with Undo.",
                        id="changes-empty",
                        classes="empty",
                        markup=False,
                    )
                with TabPane("Activity", id="activity"):
                    yield Static(
                        "No background work yet.\nSearch jobs runs here, and you can cancel it from this tab.",
                        id="activity-empty",
                        classes="empty",
                        markup=False,
                    )
                    for slot in range(RUN_SLOTS):
                        with Vertical(id=f"run-{slot}", classes="run"):
                            yield Static(id=f"run-{slot}-text", classes="run-text", markup=False)
                            with Horizontal(classes="run-buttons"):
                                yield RunButton("Cancel", "cancel", slot, id=f"cancel-run-{slot}")
                                yield RunButton(
                                    "Review new matches", "review", slot, id=f"review-run-{slot}"
                                )
        yield Input(
            id="request",
            disabled=True,
        )
        yield Static("", id="agent-status", markup=False)
        yield Static("Connecting to saved workspace…", id="message", markup=False)
        yield Footer()

    async def on_mount(self):
        person = (self.env.get("CAREERRAT_PERSON") or "").strip()
        if person:
            self.title = f"CareerRat · {person}"
            self.sub_title = f"Workspace for {person}"
        loop = asyncio.get_running_loop()
        if sys.platform != "win32":
            for name in (signal.SIGTERM, signal.SIGHUP):
                loop.add_signal_handler(name, self.exit)
        self.write_terminal("\x1b[22;0t\x1b]2;CareerRat\x07")
        self.render_jobs()
        for button_id, tip in {
            "search": "Starts the background search of your configured sources. No agent involved; progress shows in Activity.",
            "review": "Asks the agent to evaluate the first active jobs in this view. Text is inserted, you press Enter in the agent.",
            "apply": "Asks the agent to apply to the selected job. Text is inserted, you press Enter in the agent.",
            "context": "Save a JD, transcript, notes or file, then ask the agent to use it.",
            "refresh": "Read the saved workspace again.",
        }.items():
            self.query_one(f"#{button_id}", Button).tooltip = tip
        self.set_interval(2.0, self.poll_runs)
        self.update_changes({}, {})
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
            limit=self.line_limit,
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

    def schedule_agent_resize(self):
        if self.resize_timer:
            self.resize_timer.stop()
        self.resize_timer = self.set_timer(RESIZE_DELAY, self.resize_agent)

    def write_log(self, text):
        """Keep a line for later in the log file; the screen only has room for one."""
        path = self.env.get("CAREERRAT_TUI_LOG")
        if not path:
            return
        try:
            target = Path(path)
            target.parent.mkdir(parents=True, exist_ok=True)
            if target.exists() and target.stat().st_size > LOG_LIMIT_BYTES:
                target.replace(target.with_name(target.name + ".1"))
            with target.open("a", encoding="utf-8") as handle:
                handle.write(f"{time.strftime('%Y-%m-%dT%H:%M:%S')} {text}\n")
        except OSError:
            pass

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
        # The snapshot-driven line yields to a message someone still needs to
        # read, then takes over again when the hold ends: the latest status is
        # kept and shown then, so an old one can't stay on screen.
        self.pending_status = text
        remaining = self.held[1] - time.monotonic()
        if remaining > 0:
            if self.status_timer:
                self.status_timer.stop()
            self.status_timer = self.set_timer(remaining + 0.02, self.release_status)
            return
        self.release_status()

    def release_status(self):
        remaining = self.held[1] - time.monotonic()
        if remaining > 0:
            self.show_status(self.pending_status)
        elif self.pending_status is not None:
            text, self.pending_status = self.pending_status, None
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
                self.write_log(f"bridge stderr: {text}")
            if not self.stopping and text:
                self.show_message(text, hold=HOLD_SECONDS)

    async def read_events(self):
        try:
            while line := await read_event_line(self.proc.stdout):
                if line is OVERSIZED:
                    message = "A workspace update was too large to show and was skipped."
                    self.errors.append(message)
                    self.write_log(message)
                    if not self.stopping:
                        self.show_message(message, hold=HOLD_SECONDS)
                    continue
                try:
                    await self.handle_event(json.loads(line))
                except asyncio.CancelledError:
                    raise
                except Exception as error:
                    self.errors.append(str(error))
                    self.write_log(f"event error: {traceback.format_exc()}")
                    if not self.stopping:
                        self.show_message(str(error), hold=HOLD_SECONDS)
            await self.bridge_closed()
        except (ValueError, OSError) as error:
            self.errors.append(str(error))
            self.write_log(f"bridge read error: {error}")
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
        self.write_log(f"bridge exited with code {code}")
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
        elif kind == "detail":
            self.apply_detail(value)
        elif kind == "notice":
            self.show_message(value["message"], hold=HOLD_SECONDS)
        elif kind == "agent-status":
            self.show_agent_status(value["message"])
        elif kind == "frame":
            pane = self.query_one(NativePane)
            pane.apply_frame(value)
            behind = (value.get("scroll") or {}).get("offset") or 0
            pane.border_subtitle = (
                f"{behind} lines up · type or Shift+PageDown to return" if behind else ""
            )
            pane.place_cursor()
        elif kind == "bell":
            self.ring_bell()
        elif kind == "title":
            self.set_agent_title(value.get("title"))
        elif kind == "clipboard":
            self.copy_from_agent(value.get("text"))
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
        elif kind == "search-started":
            self.query_one("#inspector", TabbedContent).active = "activity"
            self.show_message(
                "A search is already running. See Activity."
                if value.get("reused")
                else "Search started in the background. Progress is in Activity.",
                hold=HOLD_SECONDS,
            )
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
            self.write_log(f"error: {value['message']}")
            self.show_message(value["message"], hold=HOLD_SECONDS)

    def ring_bell(self):
        """The agent rang the bell: pass it to the outer terminal, at most once a second."""
        now = time.monotonic()
        if now - self.last_bell >= 1:
            self.last_bell = now
            self.bell()

    def write_terminal(self, text):
        driver = getattr(self, "_driver", None)
        if driver is not None and not self.is_headless:
            driver.write(text)
            driver.flush()

    def set_agent_title(self, title):
        """Show the agent's window title in the header and the outer terminal's title."""
        title = "".join(c for c in str(title or "") if c.isprintable())[:120].strip()
        self.sub_title = title
        self.write_terminal(f"\x1b]2;CareerRat{' · ' + title if title else ''}\x07")

    def copy_from_agent(self, text):
        """The agent asked to set the clipboard (OSC 52); send it to the outer terminal."""
        if not isinstance(text, str) or not text:
            return
        self.copy_to_clipboard(text)
        self.show_message(
            f"The agent copied {len(text):,} characters to your clipboard.",
            hold=HOLD_SECONDS,
        )

    def render_jobs(self, force=False):
        """Fit the columns to the table's width and show the rows.

        force says the saved jobs changed. When only cell text changed, the
        cells are updated where they sit, so the scroll position and the
        highlighted row stay put; only a new layout or a different set or order
        of jobs refills the table, and that keeps the scroll position too."""
        table = self.query_one("#jobs", DataTable)
        # Leave room for the scrollbar so adding it never changes the layout.
        width = table.size.width - 2 if table.size.width else 76
        plan = plan_columns(width)
        key = (width, tuple(plan))
        relayout = key != self.column_key
        if not force and not relayout:
            return
        rows = [
            [clip(cells[name], size) for name, size in plan] for cells in self.job_cells
        ]
        self.updating = True
        try:
            if not relayout and self.job_ids == self.rendered_ids:
                for job_id, row, before in zip(self.job_ids, rows, self.rendered_rows):
                    for (name, _), cell, old in zip(plan, row, before):
                        if cell != old:
                            table.update_cell(job_id, name, cell, update_width=False)
            else:
                scroll = table.scroll_y
                table.clear(columns=relayout)
                if relayout:
                    for name, size in plan:
                        table.add_column(name, width=size, key=name)
                for job_id, row in zip(self.job_ids, rows):
                    table.add_row(*row, key=job_id)
                if self.selected_id in self.job_ids:
                    table.move_cursor(
                        row=self.job_ids.index(self.selected_id), scroll=False
                    )
                # The table sizes itself after this refresh; scroll once it has.
                table.call_after_refresh(
                    table.call_after_refresh,
                    lambda: table.scroll_to(y=scroll, animate=False, immediate=True),
                )
            self.column_key = key
            self.rendered_ids = list(self.job_ids)
            self.rendered_rows = rows
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
            if (
                self.selected_id in self.job_ids
                and table.cursor_row != self.job_ids.index(self.selected_id)
            ):
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
        self.show_selected(selected, view)
        self.update_workspace_history(view)
        self.update_activity(view)
        self.update_status(view, state)

    def set_text(self, widget_id, text, empty=False):
        """Show text in a pane; an empty-state message reads as one dim, centered line."""
        widget = self.query_one(f"#{widget_id}", Static)
        widget.update(text)
        widget.set_class(empty, "empty")

    def update_changes(self, view, state):
        changes = view.get("changes", [])
        ref = state.get("changeRef")
        change = next(
            (item for item in changes if f"{item['messageId']}:{item['index']}" == ref),
            changes[0] if changes else None,
        )
        pending = state.get("pendingUndo")
        index = next((i for i, item in enumerate(changes) if item is change), -1)
        browsing = bool(changes) and not pending
        self.query_one("#change-controls").display = bool(changes) or bool(pending)
        for name, shown, off in (
            ("previous-change", browsing, index <= 0),
            ("next-change", browsing, index >= len(changes) - 1),
            ("preview-undo", browsing, bool(change and change.get("reverted"))),
            ("confirm-undo", bool(pending), False),
            ("cancel-undo", bool(pending), False),
        ):
            button = self.query_one(f"#{name}", Button)
            button.display = shown
            button.disabled = off
        position = self.query_one("#changes-position", Static)
        position.display = bool(change) and not pending
        if change:
            position.update(f"Change {index + 1} of {len(changes)}")
        text = self.query_one("#changes-text", Static)
        text.display = bool(pending or change)
        if pending:
            known = next(
                (
                    item
                    for item in changes
                    if (item["messageId"], item["index"])
                    == (pending.get("messageId"), pending.get("index"))
                ),
                {},
            )
            text.update(change_text({**known, **pending}, undo=True))
        else:
            text.update(change_text(change) if change else "")
        self.query_one("#changes-empty").display = not (pending or change)

    def update_activity(self, view):
        runs = view.get("searchRuns") or []
        self.query_one("#activity-empty").display = not runs
        for slot in range(RUN_SLOTS):
            run = runs[slot] if slot < len(runs) else None
            self.query_one(f"#run-{slot}").display = run is not None
            if run is None:
                continue
            running = run.get("status") == "running"
            new = (run.get("summary") or {}).get("new") or 0
            self.query_one(f"#run-{slot}-text", Static).update(run_text(run))
            for name, shown in (
                ("cancel", running),
                ("review", run.get("status") == "completed" and new > 0),
            ):
                button = self.query_one(f"#{name}-run-{slot}", RunButton)
                button.display = shown
                button.run_id = run["id"]
        statuses = {run["id"]: run.get("status") for run in runs}
        for run in runs:
            if self.run_status.get(run["id"]) == "running" and run.get("status") != "running":
                self.show_message(search_finished_line(run), hold=HOLD_SECONDS)
        self.run_status = statuses
        tab = self.query_one("#inspector", TabbedContent).get_tab("activity")
        tab.label = "Activity ●" if "running" in statuses.values() else "Activity"

    async def poll_runs(self):
        # A running search writes its own progress; ask for it while one runs.
        if "running" in self.run_status.values() and not self.stopping:
            await self.send({"op": "refresh"})

    def update_status(self, view, state):
        self.update_changes(view, state)
        run = next(iter(view.get("searchRuns", [])), None)
        self.show_status(
            state.get("message")
            or (
                self.search_status_line(run)
                if run
                else "Click a job to inspect it. Requests insert text only; press Enter in the agent to run."
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
        self.show_selected(
            next((j for j in view["jobs"] if j["id"] == self.selected_id), None),
            view,
        )
        self.update_status(view, state)

    def apply_detail(self, value):
        """The selected job in full. The snapshot only carries summary rows."""
        if self.detail == value or not self.snapshot:
            return
        self.detail = value
        if value["id"] == self.selected_id:
            view = self.snapshot["view"]
            self.show_selected(
                next((j for j in view["jobs"] if j["id"] == self.selected_id), None),
                view,
            )

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
        self.set_text("workspace-history-text", text, empty=not messages)

    def show_selected(self, summary, view):
        """Show the selected job from its saved detail, or say it is loading."""
        if summary and (self.detail or {}).get("id") != summary["id"]:
            self.query_one("#requirements", DataTable).display = False
            self.query_one("#open-jd", Button).display = False
            for name in ("details", "history-text", "assessment-summary"):
                self.set_text(name, "Loading…", empty=True)
            return
        self.update_details(self.detail["job"] if summary else None, view)

    def update_details(self, selected, view=None):
        report = self.query_one("#requirements", DataTable)
        report.clear()
        jd_button = self.query_one("#open-jd", Button)
        if not selected:
            jd_button.display = False
            report.display = False
            total = (view or {}).get("total", 0)
            self.set_text(
                "details",
                f"No active jobs. Pick All statuses in the status list to see all {total} saved jobs."
                if total and (self.snapshot or {}).get("state", {}).get("stage") == "active"
                else "No jobs in this view.",
                empty=True,
            )
            self.set_text("history-text", "No selected job.", empty=True)
            self.set_text("assessment-summary", "No selected job.", empty=True)
            return
        row = selected["record"]
        evaluation = row.get("evaluation") or {}
        requirements = evaluation.get("requirements") or []
        report.display = bool(requirements)
        jd_button.display = has_saved_jd(row)
        self.set_text(
            "assessment-summary",
            fit_report_text(row, selected.get("fit") or {}, bool(requirements)),
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
        self.set_text("details", job_detail_text(selected))
        messages = sorted_messages(
            ((selected.get("thread") or {}).get("messages") or [])
            + (selected.get("contextMessages") or [])
        )
        calls = row.get("conversations") or []
        history = (
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
        )
        self.set_text(
            "history-text", history or "No saved conversation yet.", empty=not history
        )

    async def on_data_table_row_highlighted(self, event):
        if event.data_table.id != "jobs":
            return
        # A highlight posted while the table was refilled arrives after the
        # cursor has already moved back; it describes a row nobody chose.
        if (
            self.updating
            or event.cursor_row != event.data_table.cursor_row
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

    def on_input_changed(self, event):
        # The inserted request only takes a row while there is one to read.
        if event.input.id == "request":
            event.input.display = bool(event.value)

    async def on_button_pressed(self, event):
        name = event.button.id
        if isinstance(event.button, RunButton):
            if event.button.action_name == "cancel" and event.button.run_id:
                await self.send({"op": "search-cancel", "id": event.button.run_id})
            elif event.button.action_name == "review":
                await self.send({"op": "request", "action": "review"})
        elif name == "search":
            await self.send({"op": "search-start"})
        elif name == "context":
            self.push_screen(ContextCapture())
        elif name == "open-jd" and self.selected_id:
            await self.send({"op": "document", "id": self.selected_id})
        elif name == "refresh":
            await self.send({"op": "refresh"})
        elif name in ("review", "apply"):
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

    def check_action(self, action, parameters):
        # Single letters belong to the agent and to text boxes; they only act
        # from the jobs side, and never under a dialog.
        if action in ("request", "add_context", "refresh_jobs", "filter"):
            if len(self.screen_stack) > 1 or self.query_one(NativePane).has_focus:
                return False
            if action == "filter" and not self.query_one(f"#{parameters[0]}").display:
                return False
        return True

    def get_system_commands(self, screen):
        yield from super().get_system_commands(screen)
        for label, help_text, callback in (
            ("Search jobs", "Ask the agent to search for jobs", lambda: self.action_request("search")),
            ("Review matches", "Ask the agent to review the shown jobs", lambda: self.action_request("review")),
            ("Apply selected", "Ask the agent to apply to the selected job", lambda: self.action_request("apply")),
            ("Add context", "Paste a JD, transcript or file path", self.action_add_context),
            ("Refresh", "Read the saved workspace again", self.action_refresh_jobs),
            ("Jobs / agent", "Move focus between the jobs table and the agent", self.action_switch_focus),
        ):
            yield SystemCommand(label, help_text, callback)

    async def action_request(self, name):
        if name == "search":
            await self.send({"op": "search-start"})
        else:
            await self.send({"op": "request", "action": name})

    def action_add_context(self):
        self.push_screen(ContextCapture())

    async def action_refresh_jobs(self):
        await self.send({"op": "refresh"})

    def action_filter(self, name):
        select = self.query_one(f"#{name}", Select)
        select.focus()
        select.action_show_overlay()

    def action_switch_focus(self):
        pane = self.query_one(NativePane)
        (self.query_one("#jobs") if pane.has_focus else pane).focus()

    async def on_unmount(self):
        self.stopping = True
        self.write_terminal("\x1b[23;0t")
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
    try:
        app.run()
    except BaseException:
        app.write_log(f"crash: {traceback.format_exc()}")
        raise
    sys.exit(app.return_code or app.bridge_code or 0)
