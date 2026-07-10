# Dashboard UX — research and the V2 riff backlog

Researched July 9, 2026. Supersedes the Dashboard section of `V3_UX_FINDINGS.md`.

**Decision (July 10, 2026):** Dashboard V2 is the locked direction. V3 and V4 are deleted; both are
recoverable at git tag `archive/dashboard-v3-v4`. This doc keeps the research that produced that
call and lists what V2 should absorb next.

## Why V2 won

V2 is the only one of the three with a real hierarchy: one hero decision (the Focus card), then a
queue, then everything else. V3 flattened that into four equal panels — calmer to look at, but it
stops telling you what to do first. The original tracker had the hierarchy too, but buried it under
a 1000×500 funnel SVG that pushed the actual job decisions below the fold.

Two things V2 has that the research says matter most:

- **A single hero.** Tile size should encode importance, not data volume; cap the page at one or two
  hero surfaces. V2's Focus card is the hero. V3 has none.
- **The mixed-color scoreboard.** Tone-tinted tiles, `Geist Mono` tabular numerals, uppercase
  labels. Reads as a status board in one glance.

## Research constraints

Two research passes, ~19 sources fetched in full. The rules that bind dashboard work here:

- **One glance, one decision.** A number that doesn't change behavior when it changes doesn't belong
  above the fold. Ceiling of 3–7 tiles.
- **Action-oriented, not reporting.** The clearest 2025-26 shift: dashboards that surface what to do
  next rather than what happened. Attio is the canonical example — the dashboard's job is
  prioritization, not display.
- **Overview → drawer → page.** Drawers preserve context. Modals are for short self-contained
  sub-tasks. A modal that stacks JD + cover letter + resume + email thread (the original's
  `#job-modal`) is an IA failure, not a bigger-modal problem.
- **Skeletons, not spinners,** for a full-page load in the 2–10s band. A frame-only skeleton with no
  structural hint is just a spinner. Under 1s, show neither. Over 10s, use a progress bar.
- **Empty states are three-part:** why it's empty, what belongs here, one action to fill it.
- **Agent status has four tiers:** ambient → progress → attention → summary. Only genuine
  input-needed moments interrupt. Pinging on arbitrary milestones trains users to ignore everything,
  including the real prompts.
- **Action receipts, not tool logs.** An activity row = what changed, when, which skill, and a hook
  back to the thing that changed.
- **Risk-tiered friction.** Read-only work auto-runs. Writes preview-then-approve. The preview *is*
  the confirmation — never a bare "are you sure?".
- **Approvals are never binary.** Approve / edit / reject. Forcing full rejection of a 90%-right
  proposal is how you train someone to rubber-stamp (documented ~93% auto-approval rates once that
  sets in).
- **Confidence in buckets, with a reason.** Never a red flag alone; never false precision. If every
  item is high-confidence the badge is wallpaper — reserve it for real variation.
- **Aging is invisible by default** and has to be surfaced explicitly, even though the system logs
  every stage transition. Stale = 1.5–2.0× the median days-in-stage, or no logged activity in 14
  days at mid/late stage.
- **Density split:** tight inside the data, generous in the chrome around it.

Independently confirmed by an outside DOM audit of AI-generated pages: **colored stripes on the top
or left edge of cards** are the single most reliable tell of template-default UI. That matches the
standing repo rule. `v3.css` violated it at `.v3-event { border-left: 3px solid }`.

## The V2 riff backlog

Ranked. Each item is a change to `DashboardV2Page.jsx` / the `.dashboard-v2` block in `app.css`.

### 1. Fix the focus/queue duplication — bug, not polish
`PriorityPanel` renders `focus` and then `ActionStack` renders `allNextSteps`, whose first entry is
the same item. The queue must exclude the focus item.

### 2. Replace the Momentum meters
`dashboardPipeline()` sets `width = value / max(values) * 100`, so the largest stage is always 100%
and bar length carries zero information. "Fresh Supply", "Decision Load", and "Interview Momentum"
are invented metric names, not workflow language.

Replace with a stage strip carrying real **stage-to-stage conversion** and **aging flags** with their
reason (`21d in Waiting (2.1× median)`, `16d no activity`). Move it below the fold — it's
orientation, not a decision.

### 3. Add the agent handoff strip
The original had this and V2 dropped it: a full-width, coral-tinted card naming the proposed agent
task, **why** it's proposed, and one CTA. The agent is the product; nothing on V2 currently surfaces
it.

- `risk: "read"` → `Reads only — no writes.` + `Run <skill> →`
- `risk: "write"` → `Drafts only — nothing sends.` + `Preview <skill> →`
- Always a `Not now`. An approval surface with no decline path is a rubber stamp.
- Renders nothing when there's no proposed task. An empty agent strip is worse than no strip.

Tint the background, keep the card chrome. The scoreboard tiles already do exactly this.

### 4. Make the scoreboard tiles links
`Interviews: 4` as a display numeral with nowhere to click is decoration. Each tile becomes a `Link`
into the queue it counts.

### 5. Add provenance to the Focus card
One always-visible basis line (`Fit 93 · recruiter replied 2d ago · JD saved`) plus a `Why?` that
expands the full reason list inline. Summary-first; the explanation is one click away and never
forced.

### 6. Add an agent activity feed
Action receipts, reverse-chron, capped at 5, `View all →`. Row = relative time · the literal skill
name (`search-jobs`) · what changed. Passive surface: it never notifies and never interrupts.

### 7. Real states
- Loading → skeleton rows mirroring the real row geometry. V2 currently renders the string `Loading…`.
- Empty → three parts, every panel.
- Keep the existing fail-closed `noDatabase` `InlineAlert`. Don't invent new degrade copy.

### 8. Trim the hero title
`.dashboard-v2__title` is `clamp(48px, 5.4vw, 68px)` of Fraunces. It costs ~90px of first viewport.
Drop to 40px.

## Visual rules

Inherit the existing language. Do not invent a new one.

- Surfaces `--paper-surface`, rows `--paper-band`. Radii `--card-radius` (8px) / `--row-radius` (6px).
- Card chrome is **unchanged**: `1px solid rgba(var(--rgb-line), 0.1)` + `var(--card-shadow)`.
  Tinting a background is not changing chrome.
- Accent is coral, used only to signal action. Semantic color only: danger / warning / success /
  informational. No decorative color.
- **No edge accent strips.** No `border-left`, no `border-top`, no inset `Npx 0 0` box-shadow on any
  card, row, or event chip. State goes in text color, chips, and icons.
- No gradients, no glows, no colored shadows, no purple.
- One layout primitive — the panel — repeated.
- Fraunces appears exactly once, in the page title.
- Every number is `Geist Mono` with `font-variant-numeric: tabular-nums`.
- Motion: two values, system-wide. `200ms` / `cubic-bezier(0.25, 1, 0.5, 1)`, and `120ms` for
  opacity-only. Honor `prefers-reduced-motion: reduce`.

## Data

The dashboard renders fields; it does not derive them. `dashboard-data.js` owns focus / CTA /
calendar rules server-side and `DashboardContext.jsx` says so in a comment. Fields the riff backlog
needs that the view model does not yet emit: `focus.basis`, `agentTask.{why,risk}`,
`pipeline.stages[].conversionFromPrev`, `pipeline.stale[]`.

## Out of scope

The universal capture bar already exists globally (`app-shell/CaptureBar.jsx`). The dashboard does
not add a second capture surface. The original's dual action surfaces — Today bar *and* notification
bell drawing from the same follow-up state — is the mistake to avoid.
