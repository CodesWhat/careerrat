// CR50: the Schedule tab's calendar actions used to act on whatever exportable
// event happened to be first in the list, regardless of which row's button was
// clicked, and done interviews/assessments rendered no differently from what's
// still ahead. These tests cover both fixes: per-row calendar actions that act
// on the row's own event, and done rounds rendering muted and sorted after the
// not-done rows within their day.
import { describe, expect, it, vi } from "vitest";
import { calendarAction } from "./chat-first-app-controller.js";

async function loadModel() {
  return import("./chat-first-model.js");
}

async function loadBrowser() {
  return import("./WorkspaceBrowser.jsx");
}

function findElements(node, predicate, out = []) {
  if (node == null || typeof node !== "object") return out;
  if (Array.isArray(node)) {
    for (const child of node) findElements(child, predicate, out);
    return out;
  }
  if (typeof node.type === "function") {
    findElements(node.type(node.props), predicate, out);
    return out;
  }
  if (predicate(node)) out.push(node);
  findElements(node.props?.children, predicate, out);
  return out;
}

function exportFor(label) {
  return {
    googleUrl: `https://calendar.google.com/calendar/render?action=TEMPLATE&text=${label}`,
    outlookUrl: `https://outlook.live.com/calendar/0/deeplink/compose?subject=${label}`,
    filename: `${label.toLowerCase()}.ics`,
    ics: `BEGIN:VCALENDAR\r\nSUMMARY:${label}\r\nEND:VCALENDAR`,
  };
}

describe("SchedulePanel per-event calendar actions", () => {
  it("renders calendar actions only on rows with export data, and clicking one acts on that row's own event", async () => {
    const { SchedulePanel } = await loadBrowser();
    const groups = [
      {
        day: "THURSDAY",
        items: [
          {
            id: "event-1",
            title: "First interview",
            actionLabel: "Open prep",
            export: exportFor("First"),
          },
          {
            id: "event-2",
            title: "Second interview",
            actionLabel: "Open prep",
            export: exportFor("Second"),
          },
          { id: "event-3", title: "No export item", actionLabel: "Open" },
        ],
      },
    ];
    const onCalendarAction = vi.fn();
    const tree = SchedulePanel({ groups, onAction: vi.fn(), onCalendarAction });

    const googleButtons = findElements(
      tree,
      (node) => node.type === "button" && node.props.children === "Google"
    );
    const downloadButtons = findElements(
      tree,
      (node) => node.type === "button" && node.props.children === "Download file"
    );
    // Only the two exportable rows get calendar buttons; the third gets none.
    expect(googleButtons).toHaveLength(2);
    expect(downloadButtons).toHaveLength(2);

    // Clicking the SECOND row's Google button acts on the second event, not
    // the first — the regression the old panel-level, first-exportable-item
    // lookup could not distinguish.
    googleButtons[1].props.onClick();
    expect(onCalendarAction).toHaveBeenCalledWith("Google", "event-2");
    expect(onCalendarAction).not.toHaveBeenCalledWith("Google", "event-1");
  });

  it("shows no calendar actions on a row with no export data", async () => {
    const { SchedulePanel } = await loadBrowser();
    const { renderToStaticMarkup } = await import("react-dom/server");
    const groups = [
      {
        day: "THURSDAY",
        items: [{ id: "event-1", title: "No export item", actionLabel: "Open" }],
      },
    ];
    const tree = SchedulePanel({ groups, onAction: vi.fn(), onCalendarAction: vi.fn() });

    expect(renderToStaticMarkup(tree)).not.toMatch(/cf-schedule__calendar-actions/);
  });

  it("renders a done round muted and sunk below the not-done row it shares a day with", async () => {
    const { SchedulePanel } = await loadBrowser();
    const { renderToStaticMarkup } = await import("react-dom/server");
    const groups = [
      {
        day: "THURSDAY",
        items: [
          { id: "active-1", title: "Upcoming panel", actionLabel: "Open prep", done: false },
          { id: "done-1", title: "Completed screen", actionLabel: "Open prep", done: true },
        ],
      },
    ];
    const tree = SchedulePanel({ groups, onAction: vi.fn(), onCalendarAction: vi.fn() });
    const html = renderToStaticMarkup(tree);

    expect(html).toMatch(/cf-schedule__row--done/);
    // The muted row's own markup carries the done class; the not-done row does not.
    const doneRowStart = html.indexOf("Completed screen");
    const activeRowStart = html.indexOf("Upcoming panel");
    const doneRowHtml = html.slice(html.lastIndexOf("<article", doneRowStart), doneRowStart);
    const activeRowHtml = html.slice(html.lastIndexOf("<article", activeRowStart), activeRowStart);
    expect(doneRowHtml).toMatch(/cf-schedule__row--done/);
    expect(activeRowHtml).not.toMatch(/cf-schedule__row--done/);
  });
});

describe("groupSchedule done ordering (chat-first-model.js)", () => {
  it("sinks a done event below a not-done event within the same day, regardless of input order", async () => {
    const { buildChatFirstView } = await loadModel();
    const dashboard = {
      calendar: {
        upcoming: {
          events: [
            {
              id: "done-1",
              iso: "2026-06-18",
              time: "9:00 AM",
              title: "Completed screen",
              kind: "interview",
              done: true,
            },
            {
              id: "active-1",
              iso: "2026-06-18",
              time: "3:00 PM",
              title: "Upcoming panel",
              kind: "interview",
              done: false,
            },
          ],
        },
      },
    };

    const view = buildChatFirstView(dashboard, {});

    expect(view.browser.schedule).toHaveLength(1);
    const items = view.browser.schedule[0].items;
    expect(items.map((item) => item.id)).toEqual(["active-1", "done-1"]);
    expect(items[0].done).toBe(false);
    expect(items[1].done).toBe(true);
  });

  it("keeps an event's export data attached so the row it produces can act on it", async () => {
    const { buildChatFirstView } = await loadModel();
    const dashboard = {
      calendar: {
        upcoming: {
          events: [
            { id: "event-1", iso: "2026-06-20", title: "First", export: exportFor("First") },
            { id: "event-2", iso: "2026-06-20", title: "Second", export: exportFor("Second") },
          ],
        },
      },
    };

    const view = buildChatFirstView(dashboard, {});
    const items = view.browser.schedule[0].items;
    const second = items.find((item) => item.id === "event-2");
    expect(second.export.filename).toBe("second.ics");
  });
});

describe("calendarAction acts on the specific event passed in (chat-first-app-controller.js)", () => {
  it("exporting from the second event yields the second event's data, not the first's", () => {
    const schedule = [
      {
        day: "THURSDAY",
        items: [
          { id: "event-1", export: exportFor("First") },
          { id: "event-2", export: exportFor("Second") },
        ],
      },
    ];
    const open = vi.fn();
    // Mirrors ChatFirstApp.jsx's actions.calendarAction: look the clicked
    // row's event up by id, then hand its own export data to calendarAction.
    const findById = (id) => schedule.flatMap((group) => group.items).find((e) => e.id === id);

    expect(calendarAction("Google", findById("event-2")?.export, { openWindow: open })).toBe(true);
    expect(open).toHaveBeenCalledWith(
      expect.stringContaining("text=Second"),
      "_blank",
      "noopener,noreferrer"
    );
    expect(open).not.toHaveBeenCalledWith(
      expect.stringContaining("text=First"),
      expect.anything(),
      expect.anything()
    );
  });

  it("still rejects an ics document missing the BEGIN:VCALENDAR header", () => {
    const documentRef = { body: {}, createElement: vi.fn() };
    const badExport = { filename: "bad.ics", ics: "not a calendar" };

    expect(calendarAction("Download file", badExport, { documentRef })).toBe(false);
    expect(documentRef.createElement).not.toHaveBeenCalled();
  });

  it("still rejects an ics document over the 100 KB cap", () => {
    const documentRef = {
      body: { appendChild: vi.fn() },
      createElement: vi.fn(() => ({ click: vi.fn(), remove: vi.fn() })),
    };
    const oversizedIcs = `BEGIN:VCALENDAR\r\n${"A".repeat(100_001)}\r\nEND:VCALENDAR`;
    const tooBig = { filename: "big.ics", ics: oversizedIcs };
    const withinCap = { filename: "ok.ics", ics: "BEGIN:VCALENDAR\r\nEND:VCALENDAR" };

    expect(calendarAction("Download file", tooBig, { documentRef })).toBe(false);
    expect(calendarAction("Download file", withinCap, { documentRef })).toBe(true);
  });
});
