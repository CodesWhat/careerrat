# CareerRat Skill-to-Screen UX Audit

Started: 2026-08-14
Status: active build gate

This audit checks whether the app exposes CareerRat's workflow as one coherent
conversation, not whether each backend module merely exists. The August 2026
surface acceptance sweep remains valid for the surfaces it tested. This gate is
broader: every user-facing skill must have an understandable entry, visible work,
a safe decision point, a durable result, and a useful next action.

## Product contract

Ask is the primary input. Contextual buttons are shortcuts into the same durable
workspace thread, never separate workflow islands. For every user-facing skill,
the app must provide:

1. a natural-language Ask entry and relevant contextual shortcut;
2. deterministic entity resolution or a visible clarification when the target is
   ambiguous;
3. visible progress for work that takes longer than an ordinary response;
4. a confirmation boundary before consequential writes, sends, or submissions;
5. a durable result linked to the affected job, company, communication, artifact,
   or candidate setting; and
6. the next useful action in the same conversation.

Internal extraction helpers do not need their own navigation item. Their progress,
errors, and results still have to appear inside the user-facing workflow that
invoked them.

## Highest-risk conversational flows

### Onboarding graduation and background sourcing

Paul owns setup readiness. A candidate must never finish the conversation, enter
the app, and see: "No search sources set up yet. Add tracked companies or a job
board in Settings or Onboarding, then reload this page."

Required behavior:

1. Treat candidate readiness and source readiness as separate facts. Having a
   resume, roles, and location is enough to begin source generation, but it is not
   proof that a deterministic source exists.
2. As soon as minimum search context exists, generate the baseline deterministic
   sources and start the first search in the background while Paul continues the
   deeper interview. The user should reach the main app with useful work already
   underway whenever possible.
3. Paul covers every setting required for the workflows the candidate will use.
   He confirms saved values instead of making the user rediscover missing settings
   after setup.
4. Graduation requires durable baseline source config plus a first-search state of
   `running` or `completed`. Candidate setup completion alone cannot release the
   route gate, and pausing does not count as graduation.
5. A paused state names the exact missing fact or unavailable dependency, offers
   **Pause setup**, saves the transcript/checkpoint, and resumes at that item on the
   next launch. It never dumps the user into Settings or asks them to reload.
6. Source discovery may continue after graduation, but zero-source state is handled
   inside the Paul conversation with a retry, manual source proposal, or pause. A
   paused setup remains gated and resumes here. It is never a Jobs-page dead end.
7. The dashboard and Jobs page read the same graduation state. They show live
   search progress, results, or the resumable pause action, not contradictory
   readiness copy.

Current implementation starts baseline sourcing at candidate `search_ready`, requires
usable source config plus a running/completed first search for graduation, and keeps
failed or paused setup inside Paul. Graduation now goes through one server-verified commit
that rechecks the canonical checklist, deterministic source count, and durable first-search
run, then prepends a bounded user/Paul transcript to `workspace-main`. Retries reuse the same
handoff, changed onboarding history replaces the prior import, and first-search messages already
in flight keep their order after the imported setup context. Clean packed-install QA proved
sourcing at 4 of 8, 269 postings scanned while the interview continued, two qualified roles
waiting on Jobs at graduation, no false zero-source state, exact pause/resume restoration, and the
same ready state after a full server restart. A second packaged pass used the domain-neutral target
"local CPA roles at small accounting firms in Denver" and proved the zero-auth baseline scanned
100 postings, completed with an honest zero-result state, graduated without a source error, and
carried Paul's exact target context into the first Ask response. A later screenshot of the retired zero-source dead
end was traced to an owned 0.7.0 local server that remained alive after the checkout and installed
package reached 0.7.1. The onboarding behavior remains fixed; runtime-version handshaking, safe
owned-server replacement, update relaunch, and foreign-port fallback are now implemented and
accepted under `F-088`.

### "Rate this job"

The app must:

1. recognize a short posting URL, pasted JD, attached file, or already-saved job;
2. capture the full reachable JD immediately and persist its provenance;
3. resolve or create the sourced/application record without guessing;
4. run `evaluate-job` against current candidate gates and evidence;
5. show a structured `KEEP | REVIEW | CUT` result with fit, compensation,
   dealbreakers, evidence, and unknowns;
6. save the verdict to the job; and
7. offer the correct next actions. `KEEP` can continue to packet/apply, `REVIEW`
   asks only for the missing decision, and `CUT` explains why and offers archive or
   gate correction.

Current implementation recognizes short job URLs, pasted or extracted attached JDs,
an explicitly open saved job, and deterministic natural references such as "the Acme
role." It captures or reuses the full JD, promotes sourced roles, runs the gate, saves
the verdict, and renders a structured result plus Review and typed Prepare application
actions in Ask. Ambiguous and missing natural references fail visibly instead of
guessing. Packed-app acceptance covers the open-saved-job REVIEW/CUT path; clean-home
and packaged acceptance for pasted/attached and natural-reference inputs remains.

### "Apply to this job"

The app must:

1. resolve the same inputs as the rating flow;
2. run or reuse a current evaluation and stop on `CUT`;
3. promote a sourced role when needed;
4. generate the resume, cover letter, and screening-answer packet;
5. surface unresolved facts or required user choices in chat;
6. show the exact submission plan and confirmation boundary;
7. run the authenticated executor when the required capability is available, or
   give a concrete supervised/manual handoff when it is not; and
8. mark the application applied only after verified confirmation.

Current implementation resolves a short job URL, explicitly open saved job, or unique
natural saved-job reference into the evaluate-to-packet chain. A confirmed pasted or
attached JD preserves an explicit rate/apply request separately from the document,
confirms the exact evaluate or evaluate-to-packet plan, and returns the structured
evaluation, generated packet, and supervised application handoff in the same Ask
receipt. The chain stops on `CUT`/`REVIEW`, generates base documents on `KEEP`, keeps
moving when application questions are not discoverable until the form opens, and never
marks the job Applied from a manual handoff. A verified executor result is still the
only path that writes Applied. Packed-app QA proves the REVIEW/CUT stop without a false
Applied action. Remaining work is the connected authenticated executor, automatic
form-question capture, and clean-home/packaged acceptance for pasted and attached input.

## Original skill inventory

Status meanings:

- `native`: the app has an understandable end-to-end path.
- `partial`: some native UI exists, but Ask routing, execution, result rendering,
  or the next handoff is incomplete.
- `agent-only`: the skill exists for an external agent/runtime but has no coherent
  native app entry.
- `blocked`: a visible app action cannot complete its advertised operation.

| Original skill | Current app path | Status | Build gate |
| --- | --- | --- | --- |
| `ingest-profile` | Chat-first onboarding, company thesis, editable file pane, and durable graduation into Ask | native | Run clean-home and packaged acceptance for transcript continuity, retry idempotency, restart, and a first search already in flight. |
| `setup-searches` | Onboarding baseline plus Ask URL/query imports and source toggles, with Settings maintenance | native | Add packaged-install acceptance plus headed authenticated-off and ambiguous-name recovery coverage. |
| `research-boards` | Ask starts or reopens an embedded guided board search with Add source/Skip review | native | Keep clean-home and packaged acceptance for new-source, duplicate-source, skip-all, and runtime-restart paths. |
| `discover-companies` | Company-thesis onboarding plus native Ask proposals and Track/Skip decisions | native | Keep clean-home and packaged acceptance for explicit, weekly, targeting-change, and pending-review paths. |
| `search-jobs` | Jobs search controls and typed `search.run` Ask preview | native | Preserve as the reference interaction contract while source coverage expands. |
| `evaluate-job` | Application drawer plus Ask for URLs, pasted/attached JDs, open jobs, and named saved jobs | partial | Run clean-home and packaged acceptance for every input shape, including ambiguity and recovery. |
| `tailor-application` | Job packet actions plus URL, open-job, and named-job tailoring/apply Ask chains | partial | Add browser-captured screening questions; keep returning gaps/artifacts in chat and keep tailoring separate from submission. |
| `apply-job` | Ask/manual handoff, Apply on site, and skill runtime | partial | Connect the supervised executor and automatic form-question capture; preserve verified-only Applied write-back. |
| `track-outcomes` | Status controls and classified pasted updates | partial | Resolve natural job references and make external outcomes one-turn durable actions. |
| `email-comms` | Draft, note, and external-send controls | partial | Resolve natural thread references and connect a verified send executor or explicit supervised handoff. |
| `schedule-meeting` | Manual interview scheduling form | partial | Add availability, timezone, busy-calendar, thread reply, hold, and next-action flow. |
| `interview-prep` | Dossier actions and featured interview state | partial | Route natural interview references and return the packet plus immediate prep actions in chat. |
| `calendar-sync` | ICS, Google, and Outlook export links | partial | Distinguish export from real provider sync and expose confirmed provider writes when connected. |
| `ingest-mail` | External agent/session-browser workflow | agent-only | Add an opt-in native entry, visible consent, progress, review, and tracker write result. |
| `ingest-messages` | External agent/session-browser workflow | agent-only | Add an opt-in native entry for LinkedIn/Wellfound message sync with the same review contract. |
| `sync-status` | External agent/session-browser workflow | agent-only | Add an opt-in job/status sync action with proposed transitions before writes. |
| `relationship-sourcing` | Review existing leads in Network | partial | Let Ask or a company screen start sourcing and return reviewable leads to Network. |
| `research-company` | External agent workflow | agent-only | Add job/company Ask routing and a cited research result linked to the company. |
| `research-comp` | External agent workflow | agent-only | Add role/location Ask routing and persist a cited benchmark for later evaluation. |
| `optimize-linkedin` | External agent/session-browser workflow | agent-only | Add opt-in read, diff, approval, and separate write-back steps in the app. |
| `reevaluate-strategy` | Server-derived strategy view model | partial | Render the strategy surface and route the review CTA through the workspace thread. |
| `configure` | Settings pages | partial | Let Ask explain and propose validated settings changes without creating a second write path. |

The five skills added after the original release follow the same rule:
`answer-question`, `company-health`, and `report-issue` need coherent user-facing
entry/results; `resume-extract` and `intake-extract` remain internal helpers whose
work is shown through onboarding or universal intake.

## Company thesis and continuous discovery

The onboarding company moment is not "which companies should we search?" It is:

> Are there companies or kinds of companies whose values, size, industry,
> business model, or local presence you like?

Paul uses the response to learn a reusable company thesis. Examples include a
preference for fintech, large corporations, every fast-food chain, mission-driven
employers, or small local accounting firms in Denver. Named companies are examples
and priority seeds, not the boundary of the search.

Required behavior:

- Persist structured company-preference signals separately from job-level
  `keep_signals` and from resolved/scannable `tracked_companies`.
- Capture at least industry/domain, organization type, company size/stage,
  business model, values/mission, geography/locality, and named examples when the
  user supplies them. Do not force categories the user did not express.
- Derive company-search queries and seed explanations from those signals.
- Mix named/manual priority seeds with additional generated and deterministic
  discovery seeds in the same run. Manual seeds must never suppress broad seed
  generation.
- Treat `excluded_companies` and explicit excluded categories as the only hard
  company boundary. Tracked, applied, and sourced companies are dedupe inputs,
  not evidence that discovery is complete.
- Leaving the company answer blank still runs broad company discovery from role,
  location, compensation plausibility, and keep/cut context.
- Run `discover-companies` before the first sweep and refresh it on a documented
  cadence or when targeting changes. It is not a one-time onboarding task.
- Label the UI clearly as Focus examples, Discovered companies, and Exclusions.
  Never imply that the focus list is the complete search universe.

Current implementation persists a confirmed structured company thesis separately
from resolved ATS sources. Named examples are priority seeds, broader generated and
deterministic seeds still run, exclusions remain the only hard boundary, and résumé
employers no longer masquerade as target companies. Ask can start company discovery
directly and returns reviewable proposals with confirm-first Track/Skip actions in the
same durable thread. Manual job sweeps start their deterministic search immediately,
then refresh company discovery every seven days or whenever the targeting thesis
changes. Pending proposals reopen instead of spawning a duplicate batch.

## Recurring job-board discovery

Board research is available after onboarding through ordinary Ask requests such
as "find more job boards." CareerRat keeps that distinct from "sweep my boards,"
which searches sources already configured. The typed `source.discover` action is
recorded in the durable workspace thread, starts or reopens the visible
`research-boards` session with outbound-safe candidate context and the complete
configured-source dedup set, and embeds the live progress directly in Ask. Every
proposed source still requires Add source or Skip. Approved sources write through
the validated source API, then the receipt links back to Jobs and Settings.

## Natural source setup

Routine source changes no longer require the user to understand Settings fields or
provider IDs. Ask recognizes explicit requests to add a pasted job-board URL, add a
keyword job search, or enable/disable a named source. The typed preview is the
confirmation boundary. Execution reuses the same validated SQLite source-config
owners as Settings, keeps authenticated imports off until their separate browser
consent exists, treats exact URL and case-only query duplicates as no-ops, and
records a compact source-state receipt in the durable workspace thread. The receipt
links directly to Jobs and source maintenance. Destructive removal remains a
double-confirmed Settings action.

Headed repository-build acceptance passed on 2026-08-14. A fresh zero-record DB
imported and enabled a Greenhouse board through Ask with no console errors; an
isolated populated DB also passed exact duplicate no-op, visible-label toggle,
query add/dedup, continuous follow-up typing, and durable DB/UI receipt checks.
Packaged-install acceptance remains open.

## Standalone tailoring

Ask treats requests to tailor a résumé, write a cover letter, or customize
application materials as their own typed workflow. A URL, the explicitly open job,
or one unambiguous named saved job is captured and evaluated first. KEEP generates
the honest role-specific packet with `applyIntent:false`, returns the evaluation,
document paths, gaps, Export documents, and Review documents in the workspace
thread, and never shows an application handoff or claims submission. REVIEW/CUT
stop before document generation. Automatic browser-side screening-question capture
remains part of the supervised apply executor gate.

Headed isolated-home repository-build acceptance passed on 2026-08-14 with the
installed Codex runtime. Ask previewed the open job, REVIEW stopped before
generation, and a real KEEP 96 run persisted the tailored résumé and cover letter
while leaving the application Interested. The receipt offered only Export documents
and Review documents, deferred screening answers unless the user later chooses to
apply, refreshed the open drawer immediately, and produced no HTTP or console errors.
Packaged-input and supervised-browser-question acceptance remain open.

## Deterministic source parity

Snapshot on 2026-08-14:

- CareerRat pins Career Ops commit `8be39e0934b83410276d66b541bf3a2edf3411cb`
  and accounts for all 74 provider modules in `provider-parity.mjs`.
- The 73 public-network adapters are implemented behind one CareerRat registry and
  scanner boundary. `local-parser` is intentionally unsupported because it executes
  user-configured local commands.
- Recognized URLs infer their adapter automatically. Branded hosts can select an
  explicit adapter through the CLI, API, or Settings source-maintenance surface.

Free/public deterministic calls run before AI. Each imported provider requires a
registry manifest, URL/host inference, normalized offer output, pagination and
recency behavior, liveness/error tests, dedupe stability, full-JD capture, and an
app-visible source identity. Providers that need authentication or violate the
local consent model stay behind the appropriate opt-in browser capability.

Implemented waves:

1. shared provider contract, parity manifest, fixtures, and conformance suite;
2. high-leverage ATS families, including BambooHR, Breezy, Comeet, Gem, Getro,
   iCIMS, Jobvite, Personio, Pinpoint, Rippling, Teamtailor, SuccessFactors,
   Avature, Eightfold, Phenom, Radancy, and Oracle Cloud;
3. public board/API/RSS adapters with broad role coverage;
4. regional and niche providers selected from the candidate's company thesis;
5. parser-only/custom sources and authenticated providers behind explicit
   capability gates.

The provider parity gate is complete: all 73 implemented adapters load, their
upstream offline provider contracts run against the vendored snapshot, and shared
CareerRat tests cover transport, normalization, provenance, dedupe, and full-JD
hydration. The packed CLI exposes the pinned 74-provider manifest and Settings
successfully persisted an enabled RemoteOK source with no HTTP or console errors.

## Release gate

This audit closes only when:

- every row above is `native` or explicitly classified as an internal helper;
- a clean candidate begins background sourcing as soon as minimum search context
  exists and cannot graduate with zero deterministic sources or no resumable
  first-search state;
- the two highest-risk conversational flows pass clean-home and returning-user UI
  tests from Ask through durable state;
- company-thesis examples produce broader matching companies without excluding
  unrelated but valid employers;
- manual focus companies and broad discovery run together;
- every Career Ops provider is accounted for in the parity manifest;
- deterministic sources run before AI fallbacks and every grabbed job preserves
  its reachable JD body; and
- web, packaged Electron, repository tests, lint, builds, and clean npm install
  gates pass again.
