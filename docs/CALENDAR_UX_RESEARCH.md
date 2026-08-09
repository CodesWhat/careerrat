# Calendar UX — research and the target shape

Researched July 10, 2026. Companion to `DASHBOARD_UX_RESEARCH.md`.

**Decision (July 10, 2026):** `CalendarNextPage.jsx` — the agenda-first shape below — is `/calendar`. The
original server-rendered calendar, V2, and V3 are all deleted. All three are recoverable at git tag
`archive/calendar-v3`.

## The problem this replaced

CareerRat's calendar is a **sparse work-queue calendar**, not a personal calendar. Its events are interviews,
recruiter calls, follow-ups, and deadlines. Volume is 0-4 events a day, most days empty, often a whole week
with two events. The question a user brings to it is "what's coming up and what do I have to prepare for,"
never "how does my month compare."

V2 answered a question nobody asked. It rendered the same handful of events **four times**: a Today panel, a
Month Snapshot with dot indicators, a week grid, and a full month grid behind a Week/Month toggle. The
dashboard already has a Today panel, so that was a fifth. Meanwhile a month grid of a sparse calendar is
roughly 35 empty cells, and empty cells that say nothing read as broken rather than calm (NN/g, empty
states).

The original server-rendered calendar was week + month, plus a Next-up rail and an Open-loops rail. It had
less redundancy and more capability. See `PORT_PARITY_AUDIT.md` for what it did that V2 dropped, and which
of those the current page restored.

## Verdict

**Agenda-first, grid-optional.** The primary surface is a time-relative list — Today / Tomorrow / This week /
Next week / Later — not a month grid. Agenda view exists precisely to answer "what's coming up" without
parsing a grid; the month grid exists to answer "how does my time compare across days," a job this calendar
doesn't have. The grid isn't useless, it's just secondary: it earns a compact strip for orientation and
jump-to-date, not the page's scaffold.

This is also an embedded panel inside a larger app shell, not a standalone calendar product. It should not
grow a general-purpose calendar's feature surface.

## Research constraints

~18 sources fetched in full. The rules that bind calendar work here:

- **Pick the view by the job, not the data volume.** Sparse data tolerates a month grid; it doesn't require
  one. The deciding factor is what the user came to do. (hora Calendar, "Types of Calendar Layouts")
- **A blank content area reads as a system failure**, not as "nothing scheduled." Every empty bucket needs a
  status message, and where relevant one action. (NN/g, "Designing Empty States")
- **Collapse empty periods rather than rendering them.** This is a shipped pattern, not a hack — `trim-weeks`
  in VCalendar, collapsible empty months in Attio's activity timeline.
- **Relative labels only inside a bounded near window** (about a month). Past that, absolute dates. Never
  abbreviate them (`2mo`) — screen readers misread abbreviations and it blocks translation. (Primer,
  `RelativeTime` guidelines)
- **The bucket organizes; the row still carries the real date and time.** A header saying "This week" doesn't
  excuse a row from saying `Thu Jul 16 · 2:00 PM`.
- **Chip ceiling.** Time, title, company/role, type, and *one* status signal. Anything more goes in a drawer.
  Linear's due-date treatment is the reference: one icon, three color states, hover for the full date, no
  inline text badge. (Linear docs)
- **Never encode status by color alone.** Pair color with an icon or a label.
- **Don't truncate what the chip exists to convey.** If it doesn't fit, it belongs in the detail panel.
- **Past isn't inert here.** In a personal calendar a past event is history. In a work queue a past interview
  usually has an unfinished follow-up hanging off it. So: a separate labeled, collapsed "Recent" section —
  not hidden, and not dimmed into invisibility. No mainstream calendar auto-dims the past, and that's a
  signal: naive dimming buries things that still need action. (Attio; the standing Google/Apple Calendar
  feature requests)
- **Navigation minimum:** a Today anchor, prev/next stepping, one jump-to-date. Any target inside three
  interactions. A comprehensive keyboard-shortcut system is a named anti-pattern for a tool this isn't the
  center of — even Vimcal, built for high-frequency schedulers, gets criticized for it. (Smashing, Friedman;
  Vimcal reviews)
- **Don't ship a day/week/month/agenda view switcher.** That's offering five answers because we didn't pick
  one. Agenda plus the compact strip. Add the grid back only if someone actually wants the comparison job.
- **Agent-populated events must say why they're there.** If the tracker auto-detects a deadline from an email
  and drops it on the calendar, it shows its source and a one-line reason. Never silently populate.
- **Two-level disclosure, maximum.** Chip → drawer. Usability falls off past two. (NN/g, progressive
  disclosure)

## The target shape

One page. Top to bottom:

### 1. Hero
Title `Calendar`, plus the tone-tinted scoreboard tiles V2 already has (`Due Today`, `Interviews`,
`This week`). Same grammar as the dashboard scoreboard. Keep it.

### 2. Date strip — secondary, for orientation only
A 14-day horizontal strip, not a 42-cell month grid. Each day: weekday, date, and up to three kind-colored
dots. Today is marked. Clicking a day scrolls the agenda to it. Empty days stay visually quiet — no
decoration, no "Open block" filler.

This replaces *both* the Month Snapshot panel and the month grid.

### 3. Agenda — the page
Buckets in order: `Today`, `Tomorrow`, `This week`, `Next week`, `Later`. Each header carries a count. Empty
buckets render their own one-line empty state and nothing else.

A row is: time (mono, tabular) · title · company and role · kind pill · one status signal. The row links into
the job drawer. Absolute date and time on every row.

### 4. Recent — collapsed
A `<details>` section, `Recent · N`, holding past events with an explicit status label (`Done`, or the
follow-up that's still open). Collapsed by default. Not dimmed.

### 5. Per-event export
`.ics`, Google, Outlook. The view model already attaches `export` to every calendar event
(`dashboard-data.js:1869`) and V2 threw it away. This is the one thing a job-search calendar uniquely owes
the user: getting the interview onto their real calendar. It was render-only work.

## What V2 lost in the move

- Today panel — the dashboard has one, and the agenda's first bucket *is* today.
- Month Snapshot panel — replaced by the date strip.
- Month grid + Week/Month toggle — replaced by the date strip.
- Week grid of day cards with `Open` filler — the agenda has no empty days to fill.
- Week paging — the agenda collects all three weeks the server sends, so next week is a bucket you scroll
  to, not a page you navigate to.

## Visual rules

Inherit the language. Do not invent one.

- Surfaces `--paper-surface`, rows `--paper-band`. Radii `--card-radius` / `--row-radius`.
- Card chrome unchanged: `1px solid rgba(var(--rgb-line), 0.1)` + `var(--card-shadow)`.
- Panel headers use the same `--dash-gutter` / `--dash-body-gap` discipline the dashboard now has.
- **No edge accent strips.** No `border-left`, no `border-top`, no inset `Npx 0 0` box-shadow on any card,
  row, or event chip. State goes in text color, chips, and icons.
- Coral signals action. Semantic color only. Every number is `Geist Mono` with `tabular-nums`.
- Fraunces once, in the page title.

## Data

The page renders fields; it does not derive them. `dashboard-data.js` owns the calendar rules server-side.
Fields V2 ignored that the current page now renders: `event.export` (`.ics` + Google + Outlook) and
`event.done`. Still unread by anything: `event.cta`, `week.nextUp`, `week.loops`.

Fields the shape needs that the view model does **not** yet emit:
- `event.prepped` — whether the interview has a prep packet. Drives the one status signal on the row. The
  page already renders it, gated on a strict `=== false`, so it stays dark until the server emits it.
- `event.source` / `event.why` — for agent-populated events.

## Sources

hora Calendar (layout selection) · NN/g (empty states, progressive disclosure, date input) · Smashing
Magazine / Friedman (date-time picker, three-tap rule) · Primer (`RelativeTime`) · Linear (due dates) ·
Attio (collapsible activity timelines) · Flexibits (Fantastical view rationale) · uxpatterns.dev (calendar
pattern, anti-patterns) · Setproduct (badge design) · Metaview (the readiness gap in recruiting tools) ·
Fuselab (agent-populated UI transparency) · Eleken, Bricxlabs (calendar UI teardowns).
