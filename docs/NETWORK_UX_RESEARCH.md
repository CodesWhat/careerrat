# Network UX — research and the target shape

## Retired 2026-09-04

This is a research and recommendation doc for `NetworkPage.jsx`, which it called the canonical `/network`
route. Commit `16a66b06` ("feat(web)!: replace the app with the chat-first workspace") deleted `NetworkPage.jsx`
and its support files. `NetworkV2Page.jsx` and `NetworkV3Page.jsx`, the other route candidates this doc weighs,
never entered this repo's git history under either name; they don't appear in any commit's tree, so there is
no deletion commit to cite for them. The chat-first workspace now supplies People through
`apps/web/src/chat-first/WorkspaceBrowser.jsx`'s People panel, a single cross-application contact list rather
than the four competing shapes this doc weighed.

The research below is historical: it describes routes and components that no longer exist. Read it for the
reasoning, not as a description of the running app.

<!-- markdownlint-disable MD022 MD032 MD012 -->
<!-- Everything below this point is the original research body, left untouched by the retirement
     notice above; do not run a markdown formatter over it. -->

Researched July 10, 2026. Companion to `CALENDAR_UX_RESEARCH.md` and `DASHBOARD_UX_RESEARCH.md`. This is a
research and recommendation document — no code was changed to produce it.

**The question that has to be answered first, honestly: should Network exist at all?** Scott's own words:
"Should we even have this network fucking thing? I don't know if people are gonna use it." That doubt is
well-founded. This doc doesn't default to keeping it because three versions already got built.

## The problem this replaces

Network exists in four shapes right now, none of them settled:

1. **The original server-rendered page** (`src/core/tracker/dashboard-shell.html:6921-6960`) — one card,
   `network-company-grid`, subtitled "Company relationships, warm paths, and safe routing context." Small
   and honest about its scope.
2. **`NetworkPage.jsx`** (367 lines, the canonical `/network` today) — a company-first list: avatar, name,
   state badge, role/status, contact count, latest-activity date, opens a drawer with contacts + a
   "conversation timeline" + a routing note. A metrics hero (Warm Paths / Companies / Dormant), a Coverage
   card, a Routing Guardrails card, a Relationship Sourcing card.
3. **`NetworkV2Page.jsx`** (688 lines) — the one with the "People Map" Scott likes. Same underlying data,
   restructured person-first: one card per named contact instead of one card per company. Adds a "Next
   Touch" hero panel, a Coverage panel, a Sourcing panel, a "Relationship Memory" panel — four panels of
   scaffolding around the one thing that's different from V1.
4. **`NetworkV3Page.jsx`** (260 lines) — a CRM-workflow mockup: "Needs Attention," "Company Paths," "Review
   Leads," "Relationship Memory," with buttons labeled Approve lead / Reject lead / Snooze / Log touch. None
   of these buttons have handlers. It's UI theater for a write workflow the app doesn't have — Network is
   read-only, every mutation path is a separate opt-in skill (`relationship-sourcing`, `ingest-mail`,
   `ingest-messages`).

Three live routes doing the same job, escalating in panel count, none of them cut. That pattern alone — never
subtracting, only adding a new version next to the old one — is worth naming before touching the UI question:
it's the same failure mode `CALENDAR_UX_RESEARCH.md` found in the calendar (V2 rendering the same handful of
events four times) and `PORT_PARITY_AUDIT.md` found across the whole redesign (add the featured card, drop
the machinery behind it — except here it's the reverse, add panels, never validate whether the first one
earned them).

## Verdict

**REDUCE — to a single people-first list. Cut the other three shapes entirely.** Not a full CUT, and not a
KEEP of anything built so far. The evidence below supports keeping one narrow, honest surface: a short list
of named humans CareerRat already knows about, sorted by who needs a touch, with one safe-routing line each.
Everything else in all three current pages — the metrics heroes, the Coverage panel, the Guardrails/Memory
prose panels, the Next Touch panel, V3's fake buttons — should go.

Three things drove this to REDUCE instead of CUT:

- **The one thing Scott likes isn't actually a map.** V2's "People Map" (`NetworkV2Page.jsx:399-415`) has no
  graph, no nodes, no lines, no layout engine — it's a CSS grid of person cards
  (`network-v2__people-grid`). What he's responding to is *person-first framing*: a card that says "Maya
  Chen, Recruiter, Northstar AI" instead of a company logo and a status pill. That's a real, cheap,
  buildable idea, distinct from the failed idea of a visual relationship graph (see Research constraints).
- **The data is free, not manually entered.** Every comparable job-search CRM (Teal, Huntr, WayFinder, Dex —
  see Sources) makes the user type in each contact by hand, which is exactly why personal CRMs get
  abandoned: upkeep cost that doesn't pay for itself. CareerRat's network data is 100% derived from
  `ingest-mail` / `ingest-messages` / `relationship-sourcing` — nobody has to maintain it for it to exist.
  That collapses the usual cost side of the keep/cut tradeoff to near zero.
- **A real, narrow use case sits underneath it.** The "don't over-ping one recruiter across two roles at the
  same company" guardrail is genuine job-search advice with teeth, and it only works if there's somewhere
  that remembers who you've already talked to at a company. That's worth one honest list, not a whole CRM.

What tips it away from full KEEP: the ceiling on this data is low. `buildNetwork()` caps the company list at
6 (`dashboard-data.js:1009`, `.slice(0, 6)`), and a company only qualifies at all if it has a named contact
or a non-portal communication thread (`relationshipRecordHasSignal`, `:955-960`). Most ATS-portal-only
applications never produce a row. For someone running ~30 applications, realistically 2-6 will ever show up
here. A dedicated nav tab that's frequently near-empty risks the exact fate of LinkedIn's InMaps (see
Sources): built, underused, quietly killed. **Set a tripwire now, not later:** if after a real stretch of
dogfooding this page goes unopened while live warm contacts exist in the data, cut it and move the one
guardrail line it carries into the job drawer instead, where the decision it protects (whether to reach back
out) actually gets made.

## Research constraints

14 sources consulted (7 fetched in full, additional multi-source search rounds). The rules that bind this
work:

- **A visual relationship graph is a proven-failed pattern for exactly this use case, not an unproven one.**
  LinkedIn built this — InMaps, a personal-network node visualization — and quietly retired it in September
  2014, redirecting resources to "new ways to visualize your professional network" after apparent low
  adoption. This is the closest real-world precedent to Scott's "people map" instinct, and it's a documented
  cut, not a documented win. (TechCrunch, "LinkedIn Is Quietly Retiring Network Visualization Tool InMaps")
- **Node-link diagrams only pay for themselves when the topology itself is the insight** — multi-hop paths,
  clusters, centrality. A solo candidate's network is a star graph: one candidate, a handful of companies,
  1-3 named people each. There's no path structure to discover. Graph UIs are recommended specifically when
  you must *filter down* a large tangled graph to something readable ("hairballs in your knowledge graph are
  a good thing, just don't let them anywhere near your UI") — CareerRat's network never gets large enough to
  need that filtering step, which means the interaction cost (pan/zoom/drag/layout) buys nothing at n≤6 that
  a sorted list doesn't already give for free. (Cambridge Intelligence, "How to fix hairballs")
- **Every comparable job-search product treats this as a list/CRM, never a graph.** Teal's Networking CRM,
  Huntr's per-application contact tracker, WayFinder CRM, and Dex all ship contact tracking as rows with
  follow-up reminders — none ship a visual map. That's convergent evidence for the *shape* (a people list is
  a real, validated pattern) and simultaneously evidence against the *graph* framing of "people map."
- **Personal CRMs get abandoned when upkeep is manual and decoupled from where the relationship actually
  happens** (email, DMs). "Skipping integrations makes everything manual, which leads to abandonment... the
  less effort required to maintain the system, the more likely you are to keep using it." CareerRat's network
  view is already integration-derived, not manually maintained — this specific failure mode doesn't apply
  here the way it does to Huntr/Teal, which is a real point in favor of keeping something.
- **Referral-driven job search is real and large — 30-50% of hires, referred candidates ~4x more likely to
  get an offer** (Zippia; Jobera) — but that's evidence for the *value of networking as an activity*, not
  evidence that a dedicated relationship-mapping screen inside a tracker is what makes networking happen.
  Nothing in the research ties tool-side relationship visualization to networking outcomes; it ties the
  underlying human behavior (informational interviews, warm intros, follow-up cadence) to outcomes. Don't
  let the first stat justify the second claim.
- **Automated contact-finding data degrades fast.** Sourcing-tool contact data commonly runs 15-30% bounce
  rates and goes stale on job titles/companies (Metaview, Juicebox). `relationship-sourcing` leads are
  explicitly staged as "review before outreach," never auto-trusted — the UI must keep treating sourced
  leads as unverified, never blend them visually with confirmed human-thread contacts.
- **Pick the view by the job and the data volume, not by aspiration.** Same rule `CALENDAR_UX_RESEARCH.md`
  used to reject a month grid for a sparse calendar applies here: a 6-row-ceiling dataset doesn't earn 4
  panels any more than a 0-4-event day earns a 42-cell month grid.
- **Section vs. dedicated page is a data-volume call, not a default.** For small datasets, progressive
  disclosure inside a section beats a standalone page built to look busier than the data is. (Pencil &
  Paper, dashboard UX pattern analysis) — cited here as the reasoning behind trimming panels, not as
  grounds to fold Network into another tab; see Verdict for why it stays a thin standalone surface anyway.
- **No colored left-edge accent strip on any card or row, ever** (house rule, this repo). State goes in text,
  icon, and pill, never a border-left or inset box-shadow.
- **Render server-derived fields, never re-derive them.** `apps/web/src/app-shell/DashboardContext.jsx:8-13`:
  "NEVER re-derive CTA/focus/calendar/job-action rules from this data... Consumers render fields, they don't
  recompute them." Flattening/regrouping already-fetched fields for display (e.g. exploding
  `company.contacts[]` into one card per contact) is fine; computing new state (warmth scores, reuse
  guardrails, gap sentences) client-side is not, and nothing proposed here needs to.

## The target shape

One page. Top to bottom:

### 1. Hero — one count, not a metrics grid
Title `Network`. No 3-tile scoreboard. At a ceiling of 6 companies, a "6 Companies" tile is counting the
rows the user is about to scroll past — it's not triage information the way Calendar's "Due Today" tile is
(that tile summarizes across days the user *can't* otherwise see at a glance; this data is already the whole
page). Keep one small eyebrow count instead: `N people · M need a touch`.

### 2. The people list — the page
One card per named human, not per company. Reuse `buildPeopleCards` (`NetworkV2Page.jsx:250-291`) — it
already does this correctly: flattens `network.companies[].contacts[]` into person-first cards, and falls
back to a single "company memory" card when a tracked, non-terminal application has zero named contacts yet
(keep that fallback; "you have no contact path here" is a real, useful gap signal, not noise).

Card: avatar/initials, name, contact type + company (with logo), one state pill (`Warm path` / `In process`
/ `Closed` — text + icon, never color alone), one line: next safe touch, and the relative latest-activity
date. Sort: needs-touch first, then warmth, then recency — the existing `sortedForAction` logic
(`NetworkV2Page.jsx:296-302`) is correct, keep it as-is pending the hardening note in Data below.

Click opens a drawer.

### 3. Drawer — two sections, not four
- **Safe routing**: `reuseTitle` / `reuseBody` / `reuseScope` / next touch. This is the one piece of state
  that actually changes a decision (can I reach back out, and how). Keep exactly as-is.
- **Notes**: the company's captured notes as a plain list. Cut the "Conversation timeline" framing and the
  fake `Signal 1` / `Signal 2` numbering (`NetworkPage.jsx:333-347`) — `company.notes[]` is unordered free
  text extracted from comms summaries, not a timestamped sequence. Numbering it as a timeline overclaims
  structure the data doesn't have.

Cut the separate "Company context" card (role/status/latest-activity) — it's already on the card that opened
the drawer.

### 4. Sourcing — collapsed, and only when non-empty
`network.sourcing.reviewLeads[]` / `.targets[]`. Render nothing — not even an empty-state shell — when both
are empty, which by default they are: `relationship-sourcing` is opt-in and user-initiated
(`SKILL.md` STEP 0, consent gate), so most sessions have zero leads. When present: fix the two known
rendering bugs from the parity audit while rebuilding this —
- Targets show role + fit (`"${role} · ${fit} fit"`), not the company name twice (audit #15).
- Leads show `platform` on its own line, not shadowed behind `note || summary || platform` (audit #17).

### 5. Empty state
Two distinct empty states, not one:
- Zero companies at all: explain the portal-exclusion rule explicitly — "Portal-only application threads
  (no-reply@workday/ashby/greenhouse) are intentionally excluded; this fills in once a human recruiter or
  hiring-team thread is captured." (Fixes audit #18 — this was static copy in the original that never made
  it into the React port.)
- Companies exist but nobody needs a touch: "No relationship needs attention right now" — short, not a
  guilt-trip about coverage gaps.

## What to keep vs cut

**Keep:** the people-first card framing (what Scott actually likes), the safe-routing guardrail text per
person, the sourcing review-lead/target rows (fixed), the portal-exclusion empty-state copy, the
needs-touch-first sort.

**Cut, all three pages:**
- `NetworkPage.jsx` in full — company-first list + drawer, superseded by the people-first shape above.
- The Warm Paths / Companies / Dormant metrics hero (all three pages have a version of this) — redundant
  with a 6-row list.
- The Coverage panel (recruiters/HM/signals counts + generated "gap" sentences,
  `dashboard-data.js:1022-1033`) — the gap sentences are two hardcoded conditionals over contact-type
  counts, not real analysis, and the counts restate what the card list already shows.
- The "Routing guardrails" / "Relationship Memory" panel (`dashboard-data.js:1075-1079`) — worth calling out
  specifically: this panel's `guardrails` array is **three static strings, identical for every user, every
  session** ("Use same-company routing only when the ask is specific," etc.) — it is not computed from any
  of the candidate's data. It reads as personalized advice; it isn't. Generic advice text doesn't need a
  panel, it needs to not exist.
- The `objections` list — real signal (keyword-matched against note text) but thin and generically phrased;
  fold anything load-bearing into the per-person drawer note instead of a standalone page section.
- The "Next Touch" hero panel (V2) — redundant with sorting the main list needs-touch-first, same logic
  Calendar used to cut its duplicate Today panel.
- `NetworkV3Page.jsx` in full — the Approve lead / Reject lead / Snooze / Log touch buttons have no handlers
  and no backing write path (Network is read-only by design; every mutation is a separate opt-in skill).
  Shipping dead buttons that look actionable is worse than shipping nothing.

## Visual rules

Inherit the language. Do not invent one.

- Surfaces, radii, and card chrome match the rest of the app — same tokens Calendar and Dashboard use.
- **No edge accent strips.** No `border-left`, no `border-top`, no inset `Npx 0 0` box-shadow on any person
  card, row, or pill. State goes in text color, the state pill, and an icon.
- State pill pairs a label with an icon (`Warm path` / `In process` / `Closed`) — never color alone.
- Every count is `Geist Mono` with `tabular-nums`.
- Company logos via the existing `CompanyAvatar` component; person avatars stay initials, matching V2's
  existing `personInitials` pattern — don't add a new avatar system for people.
- Sourced-but-unverified rows (leads/targets) must read visually distinct from confirmed human-thread
  contacts — a "Review" pill, not the same state-pill vocabulary as a real warm path — so a candidate never
  mistakes an AI-found lead for a person they've actually talked to.

## Data

The page renders fields; `dashboard-data.js` owns the rules server-side (`buildNetwork`, `:962-1090`).
Everything the target shape needs already exists in the view model — this is a render-only rebuild, same as
every item in `PORT_PARITY_AUDIT.md`.

**What exists and is solid:**
- `network.companies[].contacts[]` — `{ type, name, note }`, extracted from conversation/communication
  participants via `contactTypeFromText` regex classification (`dashboard-data.js:680-710`).
- `network.companies[].reuseState/reuseTitle/reuseBody/reuseScope/nextTouch/stateLabel` — the safe-routing
  logic, fully computed server-side, correct as-is.
- `network.sourcing.reviewLeads[]` / `.targets[]` — real, but empty unless `relationship-sourcing` has been
  run or an active app has zero contacts. Design for the empty case as the default, not the exception.

**What's thin or misleading, worth fixing regardless of this doc's UI recommendation:**
- `network.companies[].contacts[]` carries no per-contact date. `buildPeopleCards` currently borrows the
  *company's* `latestAt` for every person card at that company (`NetworkV2Page.jsx:263,282`) — two different
  contacts at the same company will show the identical "latest activity" date even if only one of them was
  actually touched recently. Fixing this needs a real per-contact date field
  (`addNetworkContact`, `dashboard-data.js:693-710`, would need to start tracking one) — flagged for a
  future server-side pass, not solvable in the render layer.
- `needsTouch()` (`NetworkV2Page.jsx:237-239`) sorts the whole list by regex-matching free text:
  `/today|now|after|follow|ask|reply|due/i.test(card.nextTouch)`. This works today because `nextTouch` copy
  is server-generated from a small fixed set of phrases, but it's a string-matching heuristic standing in
  for what should be a real boolean. Recommend `dashboard-data.js` emit `company.needsTouch: boolean`
  directly instead of leaving the client to reverse-engineer intent from label text.
- `network.metrics.companies` is capped at 6 by `buildNetwork`'s own `.slice(0, 6)`
  (`dashboard-data.js:1009`) — this is not a rendering limitation, it's already a deliberate small-N design
  in the source data. Nothing about the target shape needs to raise that cap; if anything it confirms 6 was
  always meant to be a glanceable ceiling, not a table.
- `network.guardrails[]` and part of `network.objections[]` are static or near-static copy, not personalized
  data — see "What to keep vs cut."

## Sources

Teal Networking CRM / Job Search CRM (`tealhq.com`) · Huntr contact tracker (`huntr.co/product/job-tracker`)
· WayFinder CRM (`wayfindercrm.com`) · Dex for job seekers (`getdex.com/product/jobseekers`) · Zippia,
"25 Incredible Employee Referral Statistics" (referral-hire rate, offer-likelihood multiplier) · Kondo, "The
Numbers Game: Understanding Cold Networking Success Rates" (cold-outreach conversion, follow-up cadence) ·
Cambridge Intelligence, "How to fix hairballs" (node-link graph UX limits) · TechCrunch, "LinkedIn Is
Quietly Retiring Network Visualization Tool InMaps" (2014) · Martech / Linkurious coverage of the same InMaps
retirement · Goodword, "What Is a Personal CRM" (abandonment/friction) · Metaview and Juicebox, sourcing-tool
contact-data accuracy benchmarks (bounce rates, staleness) · Pencil & Paper, dashboard UX pattern analysis
(progressive disclosure, small-dataset section-vs-page) · CareerEnlightenment / general job-search-networking
survey aggregation (referral share of hires, network size needed to reach a decision-maker) · this repo:
`docs/PORT_PARITY_AUDIT.md` items 15-18, `src/core/tracker/dashboard-data.js:680-1090,5810-5922`,
`apps/web/src/app-shell/DashboardContext.jsx:8-13`, `.agents/skills/relationship-sourcing/SKILL.md`.

---

**Bottom line for Scott:** cut `NetworkPage.jsx` and `NetworkV3Page.jsx` outright, and cut roughly 70% of
`NetworkV2Page.jsx` (the metrics hero, Coverage panel, Next Touch panel, Relationship Memory panel). What's
left — a short, person-first list of the recruiters and hiring-team members CareerRat already found in your
mail and messages, sorted by who needs a touch, with one safe-routing line each — is cheap to keep because
none of it is hand-maintained, and it protects a real mistake (double-pinging the same recruiter across two
roles). It is not the relationship CRM or the visual map V2/V3 gesture toward, and it shouldn't try to be —
every comparable tool in this space (including LinkedIn's own attempt) validates the plain list and has
already killed the graph. Open call for Scott: whether this stays a standalone nav tab or the safe-routing
line also gets echoed inside the job drawer at the moment someone's about to re-engage a company — the doc
recommends starting with just the standalone page and adding the drawer echo only if dogfooding shows the
page itself goes unvisited.
