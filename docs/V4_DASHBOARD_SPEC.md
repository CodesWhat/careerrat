# Dashboard V4 — Spec

Researched July 9, 2026. Supersedes the Dashboard section of `V3_UX_FINDINGS.md`.
This is the design target for the Rolester dashboard.

## What V4 inherits, and from where

| Source | Keep | Why |
| --- | --- | --- |
| Original (`dashboard.mjs` demo) | Action-first rows: verb leads, company/role demoted to context, control lives in the row | The only surface of the three that answers "what should I be doing" |
| Original | `Next agent task` card — proposed action + stated reason + one CTA | The agent handoff is the product; nothing else surfaces it |
| Original | Focus card: due pill, facts strip, one primary CTA | Real hierarchy, not a card of equals |
| V2 | Mixed-color hero scoreboard (tone-tinted tiles, mono tabular numerals, uppercase labels) | Reads as a status board at a glance |
| V3 | Row grammar: kicker / title / meta, chip + inline action button | Cleanest, most reusable primitive of the three |
| V3 | Recent activity feed | Only surface that shows what the agent did while away |
| V3 | Real workflow CTA verbs (`Evaluate`, `Open dossier`, `Draft follow-up`) | Explicit beats descriptive |

## What V4 kills, and why

1. **The 68px Fraunces page title.** `clamp(48px, 5.4vw, 68px)` reading "Dashboard V3" eats the top
   ~90px of the first viewport to say nothing. Drops to 40px, and says `Today`.
2. **Normalized pipeline meter bars.** `width = value / max(values)` makes bar length meaningless
   (the largest stage is always 100%). V2's "Fresh Supply / Decision Load / Interview Momentum"
   are invented metric names, not workflow language. Replaced by a stage strip with real
   stage-to-stage conversion and aging flags.
3. **Focus/queue duplication.** V2 renders `focus` in the Priority panel *and* again as
   `allNextSteps[0]` in the action stack right below it. The queue excludes the focus item.
4. **Dead controls.** Every `<button type="button">` in `DashboardV3Page.jsx` has no handler.
   V4 ships `Link`s to real destinations or it doesn't ship the control.
5. **`.v3-event { border-left: 3px solid }`.** Violates the standing no-edge-accent-strip rule,
   and outside research independently flags colored card-edge stripes as the single most
   reliable tell of template-default UI.
6. **Vanity metrics.** `Interviews: 4` as a display numeral with nowhere to click. Every tile in
   V4 is a link into the queue it counts.

## Research constraints applied

Full source lists live in the two research briefs; the rules that bind this spec:

- **One glance, one decision.** A number that doesn't change behavior when it changes doesn't
  belong above the fold. Ceiling of 3–7 tiles; V4 uses 4.
- **Max two hero tiles.** Tile size encodes importance, not data volume. Focus is the hero.
- **Overview → drawer → page.** Drawers preserve context; modals are for short self-contained
  sub-tasks only. A modal that stacks JD + cover letter + resume + email thread (the original's
  `#job-modal`) is an IA failure, not a bigger-modal problem.
- **Skeletons, not spinners,** for a full-page load in the 2–10s band. A frame-only skeleton with
  no structural hint is just a spinner.
- **Empty states are three-part:** why it's empty, what belongs here, one action to fill it.
- **Agent status has four tiers:** ambient → progress → attention → summary. Only genuine
  input-needed moments interrupt. Pinging on arbitrary milestones trains users to ignore
  everything, including the real prompts.
- **Action receipts, not tool logs.** An activity row = what changed, when, which skill, and a
  hook back to the thing that changed.
- **Risk-tiered friction.** Read-only work auto-runs. Writes preview-then-approve. The preview
  *is* the confirmation — never a bare "are you sure?".
- **Approvals are never binary.** Approve / edit / reject. Forcing full rejection of a 90%-right
  proposal is how you train someone to rubber-stamp.
- **Confidence in buckets, with a reason.** Never a red flag alone; never false precision. If
  every item is high-confidence, the badge is wallpaper — reserve it for real variation.
- **Aging is invisible by default** and has to be surfaced explicitly. Stale = 1.5–2.0× the
  median days-in-stage, or no logged activity in 14 days at mid/late stage.
- **Density split:** tight inside data, generous in the chrome around it.

## Layout

Two columns at ≥1120px, one below. First viewport at 1600×1000 must contain the header line,
the focus row, and the agent handoff strip — nothing else is allowed to push them down.

```
HEADER LINE                    ~72px
  Today                             [Needs you 7] [Interviewing 4]
  Wednesday, July 8 · 3 overdue     [Waiting 6]   [High-fit 5]

FOCUS ROW                      ~300px      1.6fr / 1fr
  ┌ Focus ─────────────────────┐  ┌ Needs you ──────────────┐
  │ [DUE TODAY]                │  │ DECISION      Due now   │
  │ Prep Juniper Square        │  │ Decide 3 high-fit roles │
  │   technical screen         │  │                [Review] │
  │ Juniper Square ·           │  │ FOLLOW-UP     4:30 PM   │
  │   Sr Applied AI Engineer   │  │ Send Ramp follow-up     │
  │                            │  │                 [Draft] │
  │ Fit 93 · recruiter replied │  │ INTERVIEW     Tomorrow  │
  │   2d ago · JD saved   Why? │  │ Prep Stripe HM screen   │
  │                            │  │                  [Open] │
  │ FORMAT   LOCATION   FIT    │  │                         │
  │ Hybrid   NY         93     │  │ 4 more →                │
  │                            │  │                         │
  │ [Open dossier →] [Snooze]  │  │                         │
  └────────────────────────────┘  └─────────────────────────┘

AGENT HANDOFF                  ~110px      full width, coral-tinted
  NEXT AGENT TASK
  Evaluate 3 high-fit sourced roles
  Fit ≥ 86, JD bodies saved, none gated yet. Reads only — no writes.
                                  [Run evaluate-job →]  [Not now]

─────────────────── fold at 1600×1000 ───────────────────

SCHEDULE / ACTIVITY            1fr / 1fr
  ┌ Today ─────────────────────┐  ┌ Agent activity ─────────┐
  │ OVERDUE                    │  │ 9m   search-jobs        │
  │  Yesterday  Ramp follow-up │  │      Sourced 7 roles    │
  │ TODAY                      │  │ 32m  tailor-application │
  │  10:00  Juniper screen     │  │      Tailored Juniper   │
  │  4:30   Ramp follow-up     │  │ 1d   track-outcomes     │
  │  EOD    Glean packet       │  │      Stripe → HM        │
  └────────────────────────────┘  └─────────────────────────┘

PIPELINE                       full width
  Applied 6 → Screen 3 · 50% → Technical 2 · 67% → Offer 1 · 50%
  2 stale · Ramp 21d in Waiting (2.1× median) · Glean 16d no activity
```

## Component contracts

### Header line
- `Today` in Fraunces, 40px, weight 900. Not "Dashboard V4".
- Subline: full weekday date · overdue count, in the 11px uppercase label style.
- Four metric tiles, each a `Link` into the queue it counts. Tones reuse V2's scoreboard
  exactly: `danger` (needs you), `teal` (interviewing), `sky` (waiting), `gold` (high-fit new).
- Numerals: `Geist Mono`, 29px, weight 600, `font-variant-numeric: tabular-nums`.

### Focus card (the one hero)
- Due pill, tone-mapped. Title. `company · role`.
- **Basis line** — one sentence of provenance, always visible: `Fit 93 · recruiter replied 2d ago
  · JD saved`. A `Why?` control expands the full reason list inline. Summary-first; the
  explanation is one click away and never forced.
- Facts strip (`FORMAT / LOCATION / FIT`) in the label style, values in ink.
- One primary CTA (dark pill) plus one secondary (`Snooze`). Never two primaries.
- Empty state is celebratory, not blank: `Nothing needs you` + what would land here + the one
  action that would fill it (`Run search-jobs`).

### Needs you
- Rows sorted by actionability, not recency or score.
- Row: `KICKER` (Decision / Follow-up / Interview) · due chip, title, inline action button.
- **Excludes the focus item.** No duplication.
- Caps at 3 rows plus an `N more →` link. Working-memory ceiling, not truncation-by-accident —
  the overflow link is mandatory whenever `N > 0`.

### Agent handoff strip
- Coral-tinted panel, full width. Reuses existing card chrome (`1px solid rgba(var(--rgb-line),
  0.1)` + `var(--card-shadow)`) — no new border or shadow treatment.
- Contents: `NEXT AGENT TASK` kicker, the proposed task, and a **why** line stating the basis.
- **Risk tier drives the CTA:**
  - `risk: "read"` → `Reads only — no writes.` + primary `Run <skill> →`
  - `risk: "write"` → `Drafts only — nothing sends.` + primary `Preview <skill> →`
  - Never a bare confirm dialog. The preview is the confirmation.
- Always a `Not now` secondary. An approval surface with no decline path is a rubber stamp.
- Renders nothing when there's no proposed task. An empty agent strip is worse than no strip.

### Today
- Groups: `Overdue` (always rendered when non-empty, always first), `Today`.
- Time gutter left, mono, tabular. `EOD` is a valid time.
- Rows link to the record, not the calendar.

### Agent activity
- Action receipts, reverse-chron, capped at 5, `View all →`.
- Row: relative time (mono) · skill name (mono, the literal skill: `search-jobs`) · what changed.
- Passive surface. It never notifies and never interrupts — that's the ambient tier.

### Pipeline
- Below the fold. Stage strip with counts and **stage-to-stage conversion**, not normalized bars.
- Stale flags with the reason: `21d in Waiting (2.1× median)`, `16d no activity`.
- Terminal/closed counts are not celebratory cards and do not appear here.

## Visual rules

Inherit the existing language. Do not invent a new one.

- Surfaces: `--paper-surface`, rows `--paper-band`. Radii `--card-radius` (8px) / `--row-radius` (6px).
- Card chrome is **unchanged**: `1px solid rgba(var(--rgb-line), 0.1)` + `var(--card-shadow)`.
- Accent is coral, used only to signal action. Semantic color only: danger / warning / success /
  informational. No decorative color.
- **No edge accent strips.** No `border-left`, no `border-top`, no inset `Npx 0 0` box-shadow on
  any card, row, or event chip. State goes in text color, chips, and icons.
- No gradients, no glows, no colored shadows, no purple.
- One layout primitive — the panel — repeated. Not a mix of panels, stat banners, and bare rows.
- Fraunces appears exactly once, in the page title, at ≤40px.
- Every number is `Geist Mono` with `tabular-nums`.
- Motion: two values, system-wide. `--v4-dur: 200ms` / `--v4-ease: cubic-bezier(0.25, 1, 0.5, 1)`,
  and `120ms` for opacity-only. Honor `prefers-reduced-motion: reduce`.

## States

- **Loading** — skeleton rows that mirror the real row geometry (avatar block, two text bars, a
  chip). Not `Loading…`. Not a spinner.
- **Empty** — three parts, every time: why it's empty, what belongs here, one CTA.
- **No database** — keep the existing fail-closed `InlineAlert` copy. Don't invent a new degrade.

## Data

Renders from `snapshot.v4` when present, else `V4_MOCK_DATA` — same precedent as V3 reading
`snapshot.v3`. Where a field already exists on the view model with identical semantics
(`focus`, `allNextSteps`, `calendar`, `activity`, `jobs.rail`), map to it. **Never re-derive
focus / CTA / calendar rules client-side** — `dashboard-data.js` owns them and the browser
renders what it emits.

New fields V4 needs that the view model does not yet emit (mock-only until the server catches up):
`focus.basis`, `agentTask.why`, `agentTask.risk`, `pipeline.stages[].conversionFromPrev`,
`pipeline.stale[]`.

## Out of scope

The universal capture bar already exists globally (`app-shell/CaptureBar.jsx`). V4 does not add a
second capture surface. The original's dual action surfaces — Today bar *and* notification bell
drawing from the same follow-up state — is the mistake to avoid.
