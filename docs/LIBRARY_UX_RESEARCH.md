# Library UX — research and the target shape

Researched July 10, 2026. Companion to `CALENDAR_UX_RESEARCH.md`. Three unshipped candidates exist —
`LibraryPage.jsx` (canonical `/library`), `LibraryV2Page.jsx`, `LibraryV3Page.jsx` — none is the settled
design. This doc settles it.

## The problem / what this is

Library is the candidate's reusable material: STAR stories, evidence claims, and writing-voice snippets —
the stuff that gets pasted into resumes, cover letters, and recruiter replies. It's backed by one snapshot
(`library.json`, built by `library-snapshot.mjs`) that is explicitly, deliberately uncapped: "the whole bank,
not a teaser" (`library-snapshot.mjs:430-432`). Today it holds 53+ cards.

`LibraryV3Page.jsx` started blurring that scope by adding tabs for Packets/Resumes/Cover Letters/Snippets/
Evidence/Assets — an attempt to fold in per-application documents. That's where Scott's three open questions
come from: does Library need to exist at all; does it stay stories-only or grow to include resumes/cover
letters; and is the right shape a flat bank, tabs like Jobs, or something search-first.

Two structural facts change the shape of the answer:

1. **Stories/evidence/voice and per-job documents are already different data, stored differently, on purpose.**
   `library.json` (candidate-level, one snapshot, workspace-wide) and `drawer.artifacts` (per-application, one
   `{kind, note}` pair per job, rebuilt from `tracker.json`'s own `applications[].artifacts`) have never shared
   a code path. `LibraryV3Page.jsx`'s tabbed taxonomy isn't wired to either — it reads `V3_MOCK_DATA`/`getV3Data`
   preview scaffolding, not `data.library`, and invents a `kind` vocabulary (`packet`, `snippet`, `asset`) that
   doesn't exist anywhere in `library-snapshot.mjs`'s real enum (`evidence | story | voice | honesty |
   role_signal`). The instinct is right; the implementation never touched real data.
2. **Nothing today aggregates documents across jobs.** Every artifact-reading code path in `dashboard-data.js`
   (`jobDetailFromRow`, lines 3861–3875) looks at one application's artifacts at a time. A repo-wide grep for
   `resumeBank`/`documentLibrary`/`allArtifacts`/`artifactBank` returns zero hits. A searchable cross-job
   document list is a **new aggregation**, not a re-view of something that already exists — unlike every item
   in `PORT_PARITY_AUDIT.md`, which is render-only work against fields already on the wire.

## Verdict

**Keep Library. Scope: stories/evidence/voice stays the spine; documents get a new, clearly separate second
section, not a merge into the card bank. Structure: one page, not routed tabs — a flat, filterable,
searchable card bank as the primary surface, with a second flat searchable list for documents underneath it.**

**On existence:** keep it. Library is the one page whose entire job is "give me material to paste right now,"
it already holds the largest content surface in the app, and `tailor-application`/`answer-question`
conceptually depend on the bank it represents. That's a different bar than Network, where Scott's skepticism
is warranted — Network's underlying data is thinner (mostly company-name rows) and its interaction pattern
is less proven. Library's isn't in that position; it has structured tags, story lanes, readiness, and gaps
already flowing from `ingest-profile`, actively used.

**On scope:** don't put résumés and cover letters in the same card grid as STAR stories. They fail the same
"is this reusable text" test that makes a story-bank card work: a tailored résumé for Acme isn't paste-ready
material for Globex the way a STAR story is. They're versioned, job-scoped, and mostly file pointers, not
snippets. Neither Huntr nor Teal — the two closest comparables — merge them either: both keep documents
job-centric (Huntr attaches a base résumé plus a per-job tailored résumé to the job record; Teal's
multi-résumé comparison lives inside its résumé tool, never blended with achievement/story material). But
Scott's instinct to search across documents from one place is legitimate and currently has no home at all —
so it gets a second section, built off a new small aggregation, not bolted onto the existing bank.

**On structure:** flat-plus-filter, not routed tabs, for the primary bank. `V1`/`V2` already implement this
correctly — a segmented type control (All/Evidence/Story/Voice) plus tag filters plus free-text search over
one list. That's the right shape for ~50-plus items of one content family: tags beat folders for small
reusable-content libraries because rigid categories force ambiguous filing calls ("is this evidence or a
story?") that a tag never does, and search alone fails here for the same reason NN/g's research says it fails
everywhere — recall beats recognition, and a snippet you're trying to relocate is exactly the case where you
don't remember the right query. Full routed tabs (a separate page per category, like Jobs' all/application/
sourced) are the wrong tool for two homogeneous collections this small; tabs earn their cost past a handful
of genuinely different destinations, and the volumes here don't clear that bar. The segmented control already
in `V1`/`V2` is functionally the tab pattern Scott is picturing, just without fragmenting into a route the
story bank can get hidden behind — which is `V3`'s real failure mode: land on `/library` and the first
thing shown might not be the story bank at all.

## Research constraints

- **Tags beat folders for a small, homogeneous reusable-content library.** Rigid categories force ambiguous
  filing decisions ("does this go under evidence or story?"); tags don't. Applies directly: Library's `kind`
  taxonomy plus free-form tags is the right model, a deeper folder hierarchy is not. (swipefiles.com, "What
  Is A Swipe File?"; Foreplay, "What is a Swipe File?"; SwipeWell, "What is a swipe file?")
- **Search needs navigation, not instead of it.** Users can't always construct the right query for something
  they're trying to relocate; recall is harder than recognition. A collection this size needs browse
  (segments, tags, lanes) with search layered on top, not a search box standing alone. (NN/g, "Search Is Not
  Enough: Synergy Between Navigation and Search"; NN/g, "Browse vs. Search: Which Deserves to Go?")
- **Filtered views of ONE dataset presented as a segmented control is a legitimate, common pattern** — it's
  what Notion calls a "view," and it's exactly what `V1`/`V2`'s type segments already are. This is different
  from routed, page-level tabs and should be kept in that lighter form. (Notion Help Center, "Views, filters,
  sorts & groups")
- **Tabs have a real ceiling (roughly 5) and are for genuinely separate destinations**, not filtered slices
  of a collection someone might want to scan in one pass. Library's story bank and the proposed Documents
  section are two different destinations by this test — file pointers vs. paste-ready text — which is why
  they get their own sections, not more tabs bolted onto the type segments. (Eleken, "Tabs UX Best Practices")
- **No comparable job-search tool aggregates documents across jobs into a standalone browsable library.**
  Huntr and Teal both keep résumés/cover letters attached to the job record (base + tailored per application);
  the closest thing to cross-version browsing lives inside the résumé *tool*, not merged with story/evidence
  material. Confirms: documents-as-library is new ground here, not a pattern to copy wholesale. (Huntr Help
  Center, "What Is Huntr?"; Huntr Help Center, "Understanding Huntr's Resume Builder")
- **A reusable-achievement bank is naturally flat and tag/chronology-ordered, not foldered** — the "brag
  document" convention (the closest non-vendor analogue to a story bank) is universally a running list, never
  a category tree. Reinforces the flat-plus-filter call for the story side. (jvns.ca, "Get your work
  recognized: write a brag document"; The Fountain Institute, "Keeping Track of Your Accomplishments")
- **Reference-based reuse, not copy-based reuse, is the correct mental model for "material meant to be pasted
  elsewhere."** A story/evidence card is a single source of truth referenced by many applications; a tailored
  résumé is a generated artifact that already consumed that source once. That's the conceptual line between
  what belongs in Library and what belongs on the job record. (Heretto, "Content Reuse Strategy"; UXPin,
  "What is a Single Source of Truth?")

## The target shape

One page. Top to bottom:

### 1. Hero
Title `Library`, subtitle unchanged from `V1` ("The full reusable evidence, story, and writing-voice bank"),
plus the metric tiles `V1`'s `library.index`/`metrics` already carry (Claims, Stories, Gaps — Voice/Honesty/
Role signal too, in deep-ingest mode). Fix the one thing `V1` gets wrong here: `.library-summary-tile strong`
carries no `font-family` today (`LibraryPage.css:27-32`), so the counts render in body type. `V2`'s
`.library-v2__metric strong` already does this correctly (`app.css:9220-9227`) — port that rule.

### 2. Toolbar
Search box, type segments (`All / Evidence / Story / Voice`, extended with `Honesty`/`Role signal` when
`library.metrics.voice`/`.honesty` are present), tag/family filter chips with counts, story-lane chips. This
is `V1`/`V2`'s existing toolbar — keep it structurally as-is, it already matches the real `data.library`
shape field for field.

### 3. Card grid — the primary content, restore what `V1` never shipped
Cards must be openable and copyable — parity item 8 in `PORT_PARITY_AUDIT.md`, still unfixed on the canonical
route. Port `V2`'s pattern: `role="button" tabIndex="0"`, click or Enter opens a drawer, drawer has a "Copy
reusable text" button with a clipboard fallback, Escape closes. `V2`'s URL-persisted filter/open state
(`?type=&family=&lane=&q=&open=`) is worth keeping too — a filtered view or an open card should survive a
reload or a shared link.

### 4. Readiness + guardrails
Keep one summary of this, not two. `V1` has three separate cards (bank status / readiness / claim
guardrails); `V2` has a "Featured asset" panel plus a separate readiness panel that mostly restates the same
numbers. Collapse to `V1`'s three-card row — it already covers readiness and gaps without a redundant
"best current asset" spotlight, which adds a decision (which card is "featured") the data doesn't actually
resolve deterministically.

### 5. Documents — new section, separate from the card grid
A flat, searchable list of every résumé/cover-letter/JD artifact across all applications, each row: artifact
kind, the company/role it belongs to, and a link back into that job's drawer (not a new place to view the
file — the job drawer already renders it). Own search box, not merged into the story-bank search or the
`kind` type segments above. This section needs a new small server-side aggregation — see Data, below — it is
the one part of this doc that isn't render-only.

### 6. Empty states, honestly
`V1`'s "No reusable material yet" pointing at `ingest-profile` is correct and should stay the pattern.
Don't repeat `V2`'s current behavior of silently substituting `PREVIEW_LIBRARY` mock data any time
`library.cards.length === 0` — that's fine gated behind the same explicit `VITE_STATIC_PREVIEW` flag
`DashboardContext.jsx` already uses for preview mode, but as an unconditional client fallback it means a
genuinely empty bank never tells the user their bank is empty.

## What to keep vs cut across V1/V2/V3

**Keep from `V1`:** the data-shape handling (it reads the real `library.metrics`/`.index`/`.filters`/
`.cards`/`.readiness`/`.gaps`/`.storyLanes` fields correctly, field for field), `PageScaffold` chrome, the
honest empty state, the three-card readiness/guardrails summary row.

**Cut from `V1`:** non-interactive cards — no click, no keyboard, no drawer, no copy (parity item 8). No
`font-family` on the metric numbers.

**Keep from `V2`:** click-to-open drawer with keyboard support, "Copy reusable text" with clipboard fallback,
URL-persisted filter and open-card state, correct `Geist Mono`/`tabular-nums` on metric numbers.

**Cut/fix from `V2`:** the unconditional `PREVIEW_LIBRARY` fallback whenever `cards.length === 0` (gate it
behind explicit preview mode, not "no real data happened to load yet"); the "Featured asset" panel, which
duplicates the readiness panel's job without resolving anything the data model actually ranks.

**Cut from `V3`:** the `LIBRARY_TABS` categorical split (Packets/Resumes/Cover Letters/Snippets/Evidence/
Assets) wholesale — it's mock-data-only, never reads `data.library`, and invents a `kind` taxonomy that
doesn't exist server-side. **Keep the instinct**: it's the strongest signal in the whole audit that Scott
wants document search from Library, and it should seed the new Documents section above — rebuilt against the
real per-job `artifacts` data, not merged into the story-card `kind` enum.

## Visual rules

Inherit the language already established for this exact page family. Do not invent one.

- Surfaces `--paper-surface`, rows/tiles `--paper-band`. Tone chips use the same `color-mix(in srgb,
  var(--tone) 12%, var(--paper-surface))` pattern `.library-v2__tag` already uses (`app.css:8688-8696`).
- **No edge accent strips.** No `border-left`, no `border-top`, no inset `Npx 0 0` box-shadow on any card,
  row, or chip. State goes in text color, chips, and icons — same rule as everywhere else in this app.
- Every number is `Geist Mono` with `font-variant-numeric: tabular-nums`, matching the canonical pattern at
  `.dashboard-v2__score strong` (`app.css:1129-1136`). This is the one visual bug both `V1` and (partially)
  `V2` need fixed or confirmed before ship.
- No new visual grammar for the Documents section — same card/row chrome, same tone-chip system, same search
  box component already used in the toolbar above it.

## Data

The page renders fields; it does not derive them (`DashboardContext.jsx:9-13`).

**Story/evidence bank — exists today, render-only work.** `data.library`, assembled server-side by
`buildLibrarySnapshot()`/`buildSnapshotFromDeepIngest()` (`library-snapshot.mjs:367-460`), served as
`library.json`, fetched by `fetchLibraryStatus()` (`dashboard-data.js:6739-6747`), passed through
`buildLibraryStatus()` (`dashboard-data.js:591-611`) into the view model. Fields: `metrics` (`claims`,
`stories`, `gaps`, plus `voice`/`honesty`/`roleSignals` in deep-ingest mode), `index` (`{label, value}[]`),
`filters` (`{label, count}[]`), `cards[]`, `readiness` (`{proof, stories, voice}`), `gaps[]`
(`{tone, title, body}`), `storyLanes[]` (`{tone, body}`). Card fields: `kind` (`evidence | story | voice |
honesty | role_signal`), `label`, `title`, `summary`, `tags[]` (`{label, tone}`), `note`, plus source-reference
fields (`sourceId` etc.) and, on story/voice/honesty/role-signal cards, a `metadata` object. No cap — the
bank is explicitly uncapped by design (`library-snapshot.mjs:430-432`). No `id` field on cards today; `V2`
synthesizes one client-side (`cardId()`, `LibraryV2Page.jsx:154-162`) for URL state and React keys, which is
fine to keep doing until the server adds one.

**Per-job artifacts — exists today, but scoped to one job at a time.** `drawer.artifacts`, built in
`jobDetailFromRow()` (`dashboard-data.js:3861-3875`), sourced from that application's own
`tracker.json` record (`artifacts: {jd, resume, resumeNote, coverLetter}`). Shape per entry: `{kind, note}`
only — `kind` ∈ `"Job description" | "Resume" | "Cover letter"`; `note` is either a file path/link or, when
nothing was captured, a prose fallback string like "Source link is available from the drawer header." This
is a real limitation for the Documents section: search quality depends on how consistently `tailor-application`
writes real artifact links, not prose placeholders.

**Documents section — does not exist, needs new backend work.** Nothing in the codebase loops across every
application's `artifacts` to build one list; every current call site sees one job at a time. This is the one
piece of this doc that isn't a render-only fix like everything in `PORT_PARITY_AUDIT.md`. It needs one new
aggregation — walk `tracker.json#applications[]`, flatten each `artifacts` entry with its parent's `company`/
`role`/`appId` attached, emit as a new top-level `documents[]` (or `library.documents[]`) field — before any
UI work against it can render real data instead of another preview mock.

## Sources

NN/g ("Search Is Not Enough," "Browse vs. Search: Which Deserves to Go?") · swipefiles.com, Foreplay,
SwipeWell (swipe-file organization: tags over folders, search as fallback) · Eleken ("Tabs UX Best Practices")
· Notion Help Center ("Views, filters, sorts & groups") · Huntr Help Center ("What Is Huntr?," "Understanding
Huntr's Resume Builder," "Building Your Tailored Resume") · Teal (tealhq.com — resume/achievement tooling,
multi-resume comparison scoped to the resume builder) · jvns.ca and The Fountain Institute ("brag document"
convention as the closest non-vendor analogue to a reusable achievement bank) · Heretto and UXPin (content
reuse / single-source-of-truth as the model for "material meant to be pasted elsewhere") · this repo:
`docs/PORT_PARITY_AUDIT.md` item 8, `library-snapshot.mjs`, `dashboard-data.js`, `DashboardContext.jsx`.
