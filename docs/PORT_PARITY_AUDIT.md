# Port parity: what the original did that the React app doesn't

## Verdict

The port is functionally complete for the single happy path (see today's top item, see this week, see one job) but it strips out almost every layer of depth behind that headline view. All 20 confirmed losses in this audit are render-only: the exact fields the React components need (`strategy`, `allNextSteps`, `jobs.rail`, `drawer.companyHealth`, calendar event export payloads, and so on) are already sitting in the view model that `dashboard-data.js` emits on every poll. Nothing here needs new backend work, it's all wiring that never got written. The single biggest category of loss is the "go deeper than the headline" layer: everywhere the original paired one featured card with a way to see and act on everything else (Focus plus the Next Steps queue plus the Action Queue drawer, one dashboard recommendation plus `jobs.rail`'s decision queue, one comp line plus the full negotiation band, one company name plus the health rating that scored it), the React port kept the featured card and dropped the machinery behind it. Jobs took the worst hit: search, filter, sort, decay state, comp band, health badge, and fit confidence are all gone, which means a candidate running more than a handful of applications has no way to work the list, only to eyeball it. Calendar is close behind, missing its entire reason for existing on top of the tracker (add-to-calendar) plus the week-paging that made it useful for planning ahead. This is a clean render pass through an already-complete API, not a re-architecture.

---

## The backlog

Every confirmed item below is a **render-only fix**. There is no "needs a new server-side field" group in this backlog, because every field the React app would need already ships in the view model today. That's the good news: this whole list is UI work against an API that already works.

### 1. Jobs list: search, filters, sort, and view toggle are gone, only 3 static tabs remain
**Jobs, high value.**
The search box, stage/mode/source/action filters, min comp, min fit, 8-key sort with direction toggle, table/card view toggle, and session persistence across all of it are gone.
This was the primary way someone with dozens of active applications managed their day-to-day queue. "Show me only roles that need a reply" now means scrolling every row by eye.
- **Original:** `src/core/tracker/dashboard-shell.html:9209-9608` (`setupJobsExplorer`), localStorage-persisted search/filters/8 sort keys/view toggle.
- **React:** `apps/web/src/jobs/JobsPage.jsx:19-23,98-101` offers only all/application/sourced tabs, no search input, no other filter, no sort, no view toggle. Rows render in whatever order `buildJobs()` emits.
- **Data:** `row.searchText`, `row.action`/`actionState`/`workstream`, `row.mode`, `row.baseK`/`compMidpointK`, `row.fit`, `row.needsReview`, already computed per row in `dashboard-data.js:3746-3762,4105-4123,4177-4193`, none wired to any control.

### 2. Strategy insights panel is gone from the dashboard
**Status: fixed.** Top source/lane conversion, quiet-application staleness, stage-age, cadence nudges, outcome-learning trend, reevaluation review-trigger, and a recommendation CTA had no renderer at all; the panel is now wired into the Dashboard, and its review-trigger CTA is wired into Ask.
**Dashboard, high value.**
It's the dashboard-side view into the reevaluate-strategy domain rules. Without it there was no way to see what's converting or whether there's enough signal to safely retune gates.
- **Original:** `buildStrategyInsights` (`dashboard-data.js:2992`, assembled from `:2437`, `:2485`, `:2601`, `:2873`, `:2956`); emitted at `:4802`; rendered at `dashboard-shell.html:6204-6330`.
- **React:** `apps/web/src/pages/DashboardPage.jsx`'s `StrategyPanel` now reads `data.strategy` end to end: metric chips (top source/best lane/quiet count), a recommendation + review-trigger callout, and `<details>` expanders for the source/lane/fit-band breakdown, quiet-pipeline and time-in-stage rows (each deep-linking to its job via `/jobs?open=`), cadence nudges, and the 30/60/90 learning block. When the review trigger is ready (or its `ctaAction` says `strategy-review`), the CTA submits a typed `strategy.review` intent straight into the durable Ask thread via `app-shell/ask-events.js`'s `requestAskAction` (new — a typed-intent sibling of the existing text-prefill `requestAskBar`), rendered by `AskBar.jsx`'s new `StrategyReviewCard`/`StrategyApplyCard` for the `strategy_review`/`strategy_apply` artifact kinds.
- **Data:** `strategy`, fully populated top-level field, now read by `StrategyPanel` and, via the Ask round trip, by the `strategy_review`/`strategy_apply` Ask artifacts.

### 3. Next Steps queue and the Action Queue drawer both collapse to a bare count
**Dashboard, high value.**
The ranked top-3 "Next Steps" list beside Focus, and the full uncapped "Open queue" drawer behind it, are both gone.
Without them you can only see and act on the #1 priority item. Items 2, 3, and beyond are invisible except as a number.
- **Original:** `buildNextSteps` (`dashboard-data.js:1119`), `:4778-4797` (`allNextSteps` with `limit: null` plus `timeNextSteps` top-3), rendered beside Focus at `dashboard-shell.html:6108-6133`, and again in full via the "Open queue" trigger (`:7095`) and `renderActionsDrawer` (`:8453-8477`).
- **React:** `DashboardV2Page.jsx` reads `data.allNextSteps` only to compute two counts, `needsYou` at line 279 and `dueNow` at 280-282. The array's contents (title/company/dueText/actionLabel) are never mapped to a list or a drawer anywhere in the file. `DashboardV2Page.test.jsx:162` confirms this was a deliberate call during the redesign, not an accident.
- **Data:** `allNextSteps`/`nextSteps`, full array, already fetched by the page, just measured with `.length` instead of rendered.

### 4. Interview dossier no longer opens from the Focus card
**Dashboard, high value.**
"Open dossier" no longer opens the interview-prep packet. The Format/Location facts line and the free-text interview note are gone too.
Opening the CTA and reading the packet is the whole point of building the dossier in the first place.
- **Original:** `buildInterviewFocus` (`dashboard-data.js:1330-1370`) builds facts/dossier/hasDossier/note/cta; `renderFocusCard` (`:5043-5069`) wires `data-open-dossier`; modal at `dashboard-shell.html:7196-7211` and `openDossierModal` at `:9151-9196`.
- **React:** `PriorityFocus` (`DashboardV2Page.jsx:93-123`) reads only title/company/role/dueText/tone/cta/detailId, and `ctaTo` always routes to `/jobs?open=<id>` no matter what. `JobDrawer.jsx` has zero dossier/markdown references anywhere, its Artifacts card only lists jd/resume/coverLetter kind/note pairs, never `interviewDossier`.
- **Data:** `focus.dossier` (`{title, subtitle, round, generatedAt, markdown}`), `focus.hasDossier`, `focus.facts`, `focus.note`, all still emitted, all unread.

### 5. Comp negotiation band is a plain text line instead of a range bar with pins
**Jobs, high value.**
The Floor/Market P50/Your Ask/Ceiling visual bar plus a provenance badge (built from data vs posted band vs needs more info) is gone from the job drawer.
It's the concrete artifact you open right before a recruiter comp call, to see at a glance where your ask sits and how trustworthy the range is.
- **Original:** `renderCompBar` (`dashboard-shell.html:8912-8980`); fields from `jobDetailFromRow` (`dashboard-data.js:3990-4001`).
- **React:** `JobDrawer.jsx`'s `CompFitCard` (`:443-508`) renders only `row.compSummary || drawer.base` plus an optional `drawer.compBasis` suffix, one line of text, no bar, no pins, no badge.
- **Data:** `drawer.floor`, `ask`, `marketLo`, `marketP50`, `marketHi`, `compState`, `compStateLabel`, `compBasis`, `compConfidence`, `compHasMarket`, `compSampleSize`, `compAsOf`, all emitted, none read.

### 6. Company-health rating has no pill and no drawer section
**Status: fixed.** The card pill was already wired (`JobsPage.jsx`'s `HealthBadge`, reading `row.healthBadge`, landed separately); the drawer section was the real gap and is now wired too.
**Jobs, high value.**
The Watch/Risky badge on job cards and the full drawer breakdown (rating, rationale, per-dimension levels, cited sources) were gone.
Company-health is a first-class routed skill whose whole purpose is surfacing layoff/finance/morale risk on a role. Persisting the rating and never showing it defeated the point of running the skill.
- **Original:** `buildHealthBlock`/`buildHealthBadge` (`dashboard-data.js:3812-3859`); card pill at `:5645-5648`; drawer detail at `dashboard-shell.html:8838-8910`.
- **React:** `JobsPage.jsx`'s `HealthBadge` (row/card views) already reads `row.healthBadge`. `JobDrawer.jsx`'s `CompanyHealthCard` now reads `drawer.companyHealth` and renders the rating chip, provenance, as-of date, per-dimension levels, rationale, and a collapsible sourced-evidence list.
- **Data:** `row.healthBadge` (`:4089`,`:4171`), `drawer.companyHealth` (`:4016`), both computed, both now read.

### 7. Stale and ghosted applications look identical to active ones
**Jobs, high value.**
A quiet application no longer reads as "Going stale" (14d+) or "Ghosted" (30d+) via a distinct pill, color, and icon. It just shows the raw stage.
This is the tracker's built-in nudge that a dead application needs a follow-up, purely from elapsed time, no manual bookkeeping.
- **Original:** `rowDecayState`/`applyJobAction` (`dashboard-data.js:3737-3762`); `statusDisplayLabel`/`statusPillTone`/`statusPillIcon` (`:5470-5489`).
- **React:** `JobRow.jsx`'s `stageTone()`/badge (`:8-13,29`) branches only on `row.terminal`/`row.stage`/`row.source`, never `row.stale` or `row.ghosted`. (The Sankey chart on the same page does show aggregate "Going stale"/"Ghosted" bucket counts, but that's a flow diagram, not a per-row badge you can act on.)
- **Data:** `row.stale`, `row.ghosted`, `row.decayState`, set on every row, unread.

### 8. Library cards can't be opened or copied
**Library, high value.**
Cards are non-interactive: no click, no keyboard open, no drawer, no one-click copy of the reusable evidence/story/voice text.
The whole point of the Library tab is reusable material meant to be pasted into applications and outreach. Without one-click copy you're manually selecting text out of a card by hand.
- **Original:** card marked `role="button" tabindex="0"` (`dashboard-data.js:5957`); click/keydown open (`dashboard-shell.html:8386-8398`); copy button with `clipboard.writeText` plus `execCommand` fallback and "Copied"/"Copy failed" feedback (`:8404-8429`).
- **React:** `LibraryPage.jsx`'s `EvidenceCard` (`:135-165`) is a plain `<article>`, no `onClick`, `onKeyDown`, `role`, or `tabIndex`, no drawer component anywhere in the file, no clipboard call. (The clipboard code does exist, but only in the unshipped `LibraryV2Page.jsx` at `/library-v2`, not the canonical `/library` route.)
- **Data:** `card.title`/`summary`/`note`, already rendered as static text on the card face. Only the click/keyboard activation and the copy action are missing.

### 9. Add-to-calendar (.ics, Google, Outlook) is gone from every event
**Calendar, high value.**
No per-event calendar export anywhere, not in the calendar page's day/week/compact views, not in the dashboard's Today panel.
This is the core reason a calendar page exists on top of the tracker: push an interview, deadline, or follow-up straight into your real calendar app instead of retyping it.
- **Original:** `calendarEventExport`/`calendarGoogleUrl`/`calendarOutlookUrl`/`calendarIcsDocument` (`dashboard-data.js:1775-1793`), attached to every event at `:1869` and every week bundle at `:2113`; buttons at `dashboard-shell.html:7825-7871`, click handler at `:8050-8057`.
- **React:** `CalendarV2Page.jsx` never reads `event.export` anywhere, day cells, week view, and compact view all just render a `<Link>` to `/jobs?open=<id>`. `DashboardV2Page.jsx`'s `TodayPanel` has the identical gap. Repo-wide grep for `.ics`/`googleUrl`/`outlookUrl`/`.export` turns up nothing real anywhere in the tree.
- **Data:** `calendar.weeks[].days[].events[].export`, `calendar.today.events[].export`, `weeks[].export`, `{filename, ics, googleUrl, outlookUrl}`, already emitted.

### 10. No way to page forward or back through the calendar week
**Calendar, high value.**
The calendar always shows week 0. No way to page to next week or the week after, even though the server builds exactly a 3-week rolling window.
Lets you check next week's interview load or look back at the week just completed without leaving the page.
- **Original:** `buildCalendar` computes exactly 3 weeks (`dashboard-data.js:2210-2212`); prev/next buttons and `weekIndex` state wired live at `dashboard-shell.html:6720-6730,7968-8034,8073-8084`.
- **React:** `CalendarV2Page.jsx:549` always resolves `calendar.weeks[calendar.currentWeekIndex || 0]`. `currentWeekIndex` is a server-supplied field permanently `0`, and the component's only `useState` is the Week/Month view toggle. No prev/next control exists anywhere in the file.
- **Data:** `calendar.weeks`, 3 week objects, indices 1 and 2 already shipped, just never read.

### 11. Completed interview rounds don't render muted
**Calendar, medium value.**
A finished round looks exactly like an open action item.
Lets you glance at today's board and immediately tell history apart from what you still need to show up for. The original's own code comment calls this out as a deliberate design goal.
- **Original:** `calendarEventDone` (`dashboard-data.js:1599-1613`, comment at `1599-1602`); applied via `.calendar-event--done` (`dashboard-shell.html:4501-4511`, opacity 0.6 plus muted text).
- **React:** `CalendarV2Page.jsx` never reads `event.done` anywhere. `app.css` has no calendar-v2 "done" rule at all (only a day-level `--past` opacity rule that mutes an entire day, not a single event within it).
- **Data:** `calendar...events[].done` and `calendar.today.events[].done`, already set by `buildCalendarEvents`.

### 12. Fit score doesn't distinguish a triage guess from an evaluated score
**Jobs, medium value.**
"~72%, not yet fully evaluated" now renders identically to a confirmed evaluate-job score.
Erases a meaningful trust signal. You can't tell a rough sourcing-time guess from a gated, body-read evaluation at a glance.
- **Original:** `isTriageFit`/`fitLabel` (`dashboard-data.js:3297-3302`); rendered with an `is-triage` class plus distinct aria-label at `:5585-5589` and a "~" prefix in the drawer at `dashboard-shell.html:8554`.
- **React:** `JobRow.jsx` renders `Fit ${row.fit}` unconditionally (line 30). `JobDrawer.jsx`'s `CompFitCard` never references `drawer.fitBasis` anywhere in the file.
- **Data:** `row.fitBasis` (`:4074`,`:4156`), `drawer.fitBasis` (`:3980`), both emitted, neither read.

### 13. "Next decision" workstream CTA is gone
**Jobs, medium value.**
The single prioritized "what to work on next" call to action (Review N roles / Promote or hold N fresh roles / Protect interview path / Queue is clear), which used to pre-set the whole filter and sort state when clicked, is gone.
It's the tracker telling you what to work on instead of making you infer it from separate counters.
- **Original:** `buildJobsRail` (`dashboard-data.js:4641-4688`); rendered and wired to filter presets at `dashboard-shell.html:9630-9672` (`applyJobsRailAction`).
- **React:** `JobsPage.jsx`'s `JobsMetrics` only recomputes flat Total/Applied/Sourced counts from `rows` client-side. `jobs.rail` is never read anywhere on the canonical page (the unshipped `JobsV2Page.jsx` computes a `nextDecision` object into its model but never renders `.title`/`.summary`, and `.action` is dead code).
- **Data:** `jobs.rail` (`nextDecision.title`/`summary`/`action`/`hasWork`), still emitted at `:4728`, unread.

### 14. Opening a drawer or modal doesn't move keyboard focus
**Cross-cutting, medium value, accessibility.**
Job drawer, network drawer, and the capture bar panel all open without moving focus into them.
Keyboard and screen-reader users used to land directly inside the panel (`tabindex="-1"` plus `.focus()`). Now focus stays wherever it was, so Tab walks through the rest of the page first.
- **Original:** every open function calls `.focus()` on the panel, `dashboard-shell.html:8136,8187,8304,8476,9181`; each panel is `tabindex="-1" role="dialog"`.
- **React:** `JobDrawer.jsx` opens with `role="dialog"` (line 144) but no ref, no `.focus()`, no `aria-modal`. Same pattern in `NetworkDrawer` and `CaptureBar`'s panel. Repo-wide grep for `.focus()`/`autoFocus` across `apps/web/src/**/*.jsx` turns up exactly one hit, an unrelated password-gate page.
- **Data:** NONE. Pure client-side behavior, no field needed at all.

### 15. Sourcing-target rows show the company name twice instead of role and fit
**Network, medium value.**
Relationship-sourcing targets should show role and fit score. They show the company name twice.
The sourcing-targets list is a fit-sorted priority queue. Without the visible fit number the order is invisible, and the list reads as an unranked pile of company names.
- **Original:** `buildRelationshipSourcingTargets` (`dashboard-data.js:839-858`, sorts by fit); `renderNetworkSourcingTargets` (`:5901-5922`) renders `"${role} · ${fit} fit"`.
- **React:** `NetworkPage.jsx`'s `SourcingRows` (`:234-256`) is shared between `reviewLeads` and `targets` and only reads `row.name`/`title`/`type`, none of which exist on a target object, so it falls back to printing `row.company` twice with no fit suffix.
- **Data:** `network.sourcing.targets[].role` and `.fit`, already emitted, just not read by `SourcingRows`.

### 16. Activity Pulse rows tied to a job aren't clickable
**Dashboard, low value.**
An activity-feed row tied to a job used to jump you to that job's drawer. Now nothing happens on click.
Converts "this happened for company X" directly into "show me that job" with one click.
- **Original:** `buildActivityPulse` emits `appId` (`dashboard-data.js:4960`); `renderActivityRow` makes the row navigable (`data-next-step-item`, cursor-pointer) whenever `appId` is set (`:5014-5019`).
- **React:** `ActivityBell.jsx`'s `<li>` (`:72-84`) has no `onClick`, `Link`, or reference to `e.appId`. The drawer-open pattern (`/jobs?open=<id>`) is alive and used elsewhere on the same page, just never applied here.
- **Data:** `activity[].appId`, present on every row, never read.

### 17. Lead's source platform is shadowed out
**Network, low value.**
A relationship-lead row's source platform (linkedin vs wellfound) doesn't show on its own line anymore.
Tells you where a found contact was sourced from, so you know which platform to verify/reach out on.
- **Original:** `normalizeRelationshipLead` sets `platform` (`dashboard-data.js:781-809`); rendered as two separate meta lines at `:5893-5894`.
- **React:** `NetworkPage.jsx`'s `SourcingRows` collapses the meta line into `row.note || row.summary || row.platform` (line 251). `note` is always non-empty, so `platform` is unreachable dead code.
- **Data:** `network.sourcing.reviewLeads[].platform`, emitted, shadowed by the `||` chain. One-line fix: stop relying on fallthrough, render it as its own line.

### 18. Empty Network state doesn't explain the portal-only exclusion
**Network, low value.**
The zero-companies empty state no longer explains that portal-only application threads (no-reply@workday/ashby/greenhouse) are intentionally excluded from the warm-path map.
Without this line, someone who applied everywhere through pure ATS portals sees an empty Network page and can read it as a capture bug instead of a deliberate exclusion of non-human contact channels.
- **Original:** `renderNetworkCompanies` empty branch (`dashboard-data.js:5810-5826`), message at `:5821-5824`.
- **React:** `NetworkPage.jsx`'s `NetworkEmptyState` (`:160-170`) only explains how to add data, never mentions the portal-exclusion rule.
- **Data:** NONE. Static copy, not a view-model field. No plumbing needed, just add the sentence.

---

## Deliberately not restored

### Agent guidance card ("Next agent task")
This is the one item in the whole audit with test-backed proof of intent: `DashboardV2Page.test.jsx:187-188` explicitly asserts the strings "Next agent task" and "Run search-jobs" are absent from rendered output. That's not an oversight, someone cut it on purpose during the redesign. Focus already carries the single most urgent next action. A second full-width "what skill should run next" card duplicates that job and reintroduces exactly the clutter the redesign was trying to remove (see the standing no-giant-tables/one-glanceable-action UI direction). Leave it dead. If a stronger orchestration nudge is needed later, put it in Focus's own CTA copy, not a second card.

### Drawer matched/gaps chip row
Value tier here is explicitly low, and the information it carried (a job's open "reply needed" items) is already fully covered by the drawer's dedicated communications-thread card sitting right below where the chips would go. Restoring `drawer.matched`/`drawer.gaps` as a chip row would just be a second, more compressed rendering of data that's already visible one scroll down. Not worth the component work. If anything needs attention here, it's making sure the comms-thread card itself surfaces "reply needed" state clearly, not resurrecting a redundant summary row above it.

---

## Calendar specifics

The calendar page is getting redesigned right now, so pulling these three out on their own:

1. **Add-to-calendar is missing entirely** (item 9 above). Every event, in every view (day/week/compact), needs its `.ics`/Google/Outlook export wired to `event.export`, which is already on the payload. Don't let the redesign ship without this, it's the actual reason the page exists.
2. **Week paging is missing entirely** (item 10 above). `calendar.weeks[1]` and `calendar.weeks[2]` are already computed and already sent to the browser. The redesign needs a real `weekIndex` state and prev/next control, not a permanent read of `calendar.currentWeekIndex` (which the server always sets to `0`).
3. **Completed rounds don't mute** (item 11 above). `event.done` is on every event object and currently unused. Whatever the new visual language is, give done events a distinct, quieter treatment so today's board reads as "history vs next action" at a glance, the way the original explicitly designed it to.

All three are render-only. Build the new calendar UI to consume `event.export`, `event.done`, and a real week-index state from day one rather than retrofitting them after launch.


---

## Audit provenance

Run July 10, 2026 as a 32-agent workflow: six finders (one per surface: calendar, dashboard, jobs, network,
library, cross-cutting), each claimed loss then handed to an independent verifier prompted to REFUTE it and
to default to refuted when uncertain. Only survivors are listed above.

Accounting: 25 claims, 2 returned refuted, 23 confirmed. The 23 collapse to the 20 entries above because
three were found twice by different agents (per-event calendar export, the interview dossier) or merged
(the Next Steps queue and the Action Queue drawer are one item).

Two corrections to the verified set, applied by hand:

- One verifier returned `REFUTED` while its own reason reads "attempted hard to refute but could not: the
  claim is accurate on every point." The claim was that the original month grid let you click a day to
  expand that whole week inline, and that CalendarV2Page only renders `+N more`. That is a real loss. It is
  omitted from the backlog anyway because `docs/CALENDAR_UX_RESEARCH.md` retires the month grid entirely.
- The one genuine refutation: the dashboard Today panel filters to timed calendar reminders, and the
  unfiltered "everything due today" list was claimed lost. It is not. The calendar page carries it, one
  click away via the panel's own Calendar link.
