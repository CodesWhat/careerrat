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
guessing. Clean packed-install acceptance now covers URL evaluation, an open saved job,
named saved-job resolution, pasted-JD capture and evaluation, attached-text-JD confirmation
and evaluation, structured REVIEW/CUT rendering, durable full-JD capture, and ambiguous-name
recovery. The pass also fixed adaptive-thinking truncation in the packet gate, shipped the
intake routing table in the npm package, and moved installed intake classification onto the
configured AI seam.

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
marks the job Applied from a manual handoff. Public Greenhouse and Ashby forms are captured
deterministically before packet generation. With an automatically selected Orca browser,
other forms are inspected live: rendered questions are persisted, the packet rebuilds,
known fields and generated PDFs are filled from a fresh snapshot before every action, and
Ask reports blockers and unresolved fields. The executor never clicks Submit. A later
re-scan must find a confirmation page and save screenshot evidence before Applied is written.
Paste-and-resume remains available when no session browser is ready.

Headed packed-install acceptance passed on 2026-08-15 against Anthropic's live Greenhouse
board. One Ask request captured the full JD, returned a KEEP evaluation, collected all 19
public application fields, generated the résumé, cover letter, and answer sheet, and left
the application in Reviewed Hold. The packet now reuses setup facts locally for identity,
contact, links, work posture, relocation, notice period, authorization, and sponsorship;
treats the generated résumé as the upload answer; leaves unresolved optional fields blank;
and reports one plain-English action per required unknown. The clean rebuild reduced 26
duplicated validator/linter messages to four real review actions, fixed relocation and
hybrid-office answers, and removed a false private-compensation warning caused by the phrase
"current base" in a location sentence. A packed controlled-form acceptance pass on
2026-08-15 automatically selected Orca, filled three saved facts, left an unknown optional
Portfolio blank, stopped before Submit, then captured a 45 KB confirmation screenshot and
wrote Applied only after the explicit test submit. Remaining work is safe multi-step ATS
advancement and full clean-home packed acceptance for pasted and attached AI-backed chains.

Final packed acceptance also covered both Universal Intake routes. A pasted JD produced a
92/100 KEEP, generated the packet, and stopped on the real review actions; an attached JD
matched the existing application, returned a 91/100 REVIEW, and stopped before packet
generation. Text-only Apply now asks for the application link instead of offering an
impossible site handoff, and natural requests such as “Prepare the application for …” route
to the same visible, confirm-first application workflow.

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
| `evaluate-job` | Application drawer plus Ask for URLs, pasted/attached JDs, open jobs, and named saved jobs | native | Preserve full-JD capture, typed verdict rendering, deterministic resolution, and ambiguity recovery in clean packed-install acceptance. |
| `tailor-application` | Ask handles URL, pasted, attached, open-job, and named-job tailoring as a documents-only workflow | native | Preserve the separate tailoring/apply boundary, typed artifacts, and packed URL/paste/file-picker acceptance. |
| `apply-job` | Ask, deterministic/public and rendered question capture, automatic Orca fill, supervised Submit boundary, confirmation evidence, and manual fallback | partial | Add safe multi-step ATS advancement and extension/Playwright executor bridges; preserve verified-only Applied write-back. |
| `track-outcomes` | Status controls, classified pasted updates, and natural Ask outcome reports | native | Keep ambiguity, missing-reference, and durable write-back coverage in clean-home and packaged acceptance. |
| `email-comms` | Draft, note, external-send controls, and natural Ask note-capture, draft, supervised-handoff, and sent-report flows with tiered send verification | native | Keep acceptance coverage; the in-browser compose executor remains future work behind the recorded entry criteria. |
| `schedule-meeting` | Ask plus job-drawer shortcut reads the saved thread, availability, timezone, and busy blocks; returns a reviewable reply and tentative hold | native | Preserve no-conflict/no-draft behavior, explicit timezone, tentative ICS validity, full-thread artifact reads, and separate confirmed-time write-back in packaged acceptance. |
| `interview-prep` | Dossier actions, featured interview state, and natural Ask prep with an immediate dossier link | native | Keep saved-JD, missing-JD, ambiguity, and dossier deep-link coverage in packaged acceptance. |
| `calendar-sync` | Honest export links (labeled one-way), a Calendar page sync panel showing per-provider readiness from real consent state plus confirmed-write history, and a confirm-first Ask `calendar.record-write` receipt (manual self-reports ungated; automated records consent-gated via `mayRun`) | native | Keep the provenance split (automated requires calendar_sync consent, manual never does), the no-downgrade dedupe policy, honest status vocabulary (Ready/Needs setup/Off, never Connected), and matcher-ordering regression coverage. Live session-browser provider writes remain the skill's agent path. |
| `ingest-mail` | External agent/session-browser workflow | agent-only | Add an opt-in native entry, visible consent, progress, review, and tracker write result. |
| `ingest-messages` | External agent/session-browser workflow | agent-only | Add an opt-in native entry for LinkedIn/Wellfound message sync with the same review contract. |
| `sync-status` | External agent/session-browser workflow | agent-only | Add an opt-in job/status sync action with proposed transitions before writes. |
| `relationship-sourcing` | Ask resolves the target company, checks per-platform consent, and hands off to the relationship-sourcing agent/CLI run (`sourcing_handoff` with a durable auto-clearing CTA); candidate-found contacts record natively via `relationship.record-lead` into the same review pipeline; approve/reject stays in Network | native | Keep the consent split (source requests gated per platform, candidate self-reports never), the write-once CTA whose vocabulary the lead upsert auto-clears, the comp-figure guard on lead notes, and matcher-ordering regression coverage. Live platform browsing stays the skill's agent path; the Network target-row "Start sourcing" button is a recorded follow-up. |
| `research-company` | Ask resolves natural company requests ("research Acme") to a fresh cached dossier or an embedded research session, cited and linked to the company | native | Keep clean-home and packaged acceptance for fresh-cache, stale-cache, ambiguous-name, and company-not-found paths. Headed isolated-home acceptance passed 2026-08-15; packaged acceptance and a live embedded session with a real AI runtime remain open. |
| `research-comp` | Ask resolves natural comp requests ("market comp for a nurse in Denver") to a fresh cached benchmark or an embedded research session, cited to role and location | native | Keep clean-home and packaged acceptance for fresh-cache, stale-cache, and missing-role/location paths. Headed isolated-home acceptance passed 2026-08-15; packaged acceptance and a live embedded session with a real AI runtime remain open. |
| `optimize-linkedin` | External agent/session-browser workflow | agent-only | Add opt-in read, diff, approval, and separate write-back steps in the app. |
| `reevaluate-strategy` | Dashboard strategy surface (metrics, source/lane/fit-band performance, quiet pipeline, time-in-stage, cadence nudges, outcome-learning) plus a typed Ask `strategy.review` entry, freshness-gated against the same dashboard review-signal thresholds, with per-recommendation confirm-first `strategy.apply` and a `strategy.stamp` finish action | native | Headed isolated-home acceptance passed 2026-08-15 (freshness gate, confirm-first applies across the gate/comp/fit-band/learning/re-rank writers, no-AI degrade, stamp write-back). Packaged acceptance and a live-AI-runtime run remain. |
| `configure` | Settings pages plus native Ask `settings.explain`/`settings.apply`: an allow-listed settings overview card and confirm-first single-setting changes through the existing validated write paths | native | Keep the handler-enforced boundary (consent grants and high-tier capability enables stay in Settings; disable always allowed), the current_base allow-list plus leak backstop, and matcher-ordering regression coverage in acceptance. |
| `answer-question` | Explicit application/screening questions route through Ask to grounded review cards and confirmed reusable-answer saves | native | Keep profile reuse, evidence-backed prose, NEEDS YOU, self-identification exclusion, tracked-answer append, and restart persistence in regression coverage. |
| `company-health` | Ask resolves natural health requests ("is Acme a safe place to land") through the company reference resolver to a fresh cached rating or an embedded research session, with a validated `careerrat health record` write path | native | Keep clean-home and packaged acceptance for fresh-cache, stale-cache, ambiguous-name, and not-tracked-company paths. Headed isolated-home acceptance passed 2026-08-15; packaged acceptance and a live embedded session with a real AI runtime remain open. |
| `report-issue` | External agent workflow plus native Ask `issue.report`/`issue.record-filed`: a codes-primary redacted draft from the most recent workspace error, reviewed in-card, filed by the user in their own browser via a prefilled GitHub link, with a validated `issue_filed` thread receipt | native | Keep the redaction pipeline (identifier scrub with fail-closed message drop, comp refusal and bare-figure flag, home-path normalization), the never-auto-file boundary, and the strict issue-URL shape check in regression coverage. |
| `resume-extract` | Internal onboarding helper with visible streamed progress and retry | internal | Keep extraction progress, failure, retry, and manual fallback inside Paul's setup flow. |
| `intake-extract` | Internal Universal Intake helper with visible progress and review | internal | Keep extraction progress, errors, and decisions inside the invoking Ask capture flow. |

### One-off application questions

Ask recognizes explicit requests such as "How should I answer this application
question: ..." without misclassifying ordinary career advice. It reuses the packet
answer engine, candidate setup, honesty boundaries, evidence, and saved application
context; self-identification questions remain excluded and missing facts return the
literal NEEDS YOU state instead of a guess. The result renders as a review card and
states that nothing was submitted. Recurring disclosure answers expose a separate
**Save for future applications** confirmation; job-specific prose never does. A
tracked application with an existing answer sheet receives an idempotent appended
Q&A and artifact stamp, while standalone questions still produce the required
Activity Pulse entry. Headed isolated-home acceptance passed against the real backend:
an 8-of-8 candidate with a completed deterministic first search received the saved
profile answer without an AI call, reviewed and persisted it through Ask, then retained
the exact answer and workspace receipt after a full server restart with no browser
warnings or errors. A clean 545-file npm package then ran the same deterministic draft,
review/save, restart readback, durable thread-receipt, and shipped-UI checks successfully.

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

## Natural outcomes, recruiter threads, and interview prep

Ask now treats explicit user reports such as "I applied to the Acme role" and
"I got rejected by Acme" as confirmed typed writes instead of answer-only chat.
It resolves only against saved applications, refuses ambiguous company-only
references with candidate-safe choices, and leaves every possible match untouched
until the user is specific.

Recruiter draft requests and user-reported sends resolve natural company, role, or
subject references to the existing communication workflow. Drafting uses the
selected AI runtime and persists a reviewable draft. Reporting that a reply was
sent transitions the thread to waiting, records the outbound history, and clears
the draft and completed next action in the same write. Missing and ambiguous
threads return specific recovery copy instead of a generic server error.

Ask now also handles natural note capture and a supervised send handoff. A
free-text request such as "add a note to the Acme thread: called to follow up"
resolves the same reference and returns a durable note receipt in the thread; an
empty note or an unresolved reference returns specific recovery copy instead of a
generic error. A request such as "send my reply to Acme" returns a supervised
handoff: a read-only card carrying the thread's draft prefilled into mailto,
Gmail, and Outlook compose links, built from the first participant's email
address, with an explicit no-recipient state when the thread has no address on
file. CareerRat never sends on the candidate's behalf; the handoff's "I sent
this" action runs the existing sent-report confirm. Recording a send now
distinguishes three verification tiers: `verified` (an executor confirmed
delivery; `communication.send` still requires a connected delivery executor and
returns a conflict if none exists), `supervised` (CareerRat prepared the draft
and the candidate confirmed sending it through the handoff), and `user_report` (a
bare self-report with no CareerRat-prepared draft). `communication.send` also now
checks the thread's channel first and refuses non-email threads, pointing the
candidate back to the handoff/sent-report path instead of a generic error. An
in-browser compose executor that could reach `verified` sends directly was
evaluated and deferred; its entry criteria (a keystroke-safe design validated
against real webmail compose DOMs, per-account compose/Sent verification, and a
distinct Sent-folder read consent capability separate from today's
verification-code-only `mail_access`) are recorded for when that work resumes.
Recipient provenance, previously an open blocker, is now solved by the same
resolver the handoff uses. Headed acceptance for the note-capture, handoff, and
verification-tier changes is pending; a separate acceptance pass is in progress
and its results are not yet recorded here.

Natural interview-prep requests resolve only against applications with interview
context, build the evidence-grounded dossier from the saved JD, and return an
immediate **Open dossier** link in Ask. Headed isolated-home acceptance passed on
2026-08-15 for a durable rejection, non-mutating ambiguous outcome recovery, a real
Codex recruiter draft followed by an external-send report, dossier creation, and the
`/app/jobs?dossier=<application-id>` deep link. Canonical SQLite exports confirmed
the same status, message history, cleared draft, untouched ambiguous rows, and
persisted dossier shown in the UI.

## Standalone tailoring

Ask treats requests to tailor a résumé, write a cover letter, or customize
application materials as their own typed workflow. A URL, the explicitly open job,
or one unambiguous named saved job is captured and evaluated first. KEEP generates
the honest role-specific packet with `applyIntent:false`, returns the evaluation,
document paths, gaps, Export documents, and Review documents in the workspace
thread, and never shows an application handoff or claims submission. REVIEW/CUT
stop before document generation. Screening-question capture stays intentionally out of
standalone tailoring. It begins only when the user chooses the supervised apply path,
where public Greenhouse/Ashby fields are captured automatically and other sites use the
in-Ask paste-and-resume handoff.

Headed isolated-home repository-build acceptance passed on 2026-08-14 with the
installed Codex runtime. Ask previewed the open job, REVIEW stopped before
generation, and a real KEEP 96 run persisted the tailored résumé and cover letter
while leaving the application Interested. The receipt offered only Export documents
and Review documents, deferred screening answers unless the user later chooses to
apply, refreshed the open drawer immediately, and produced no HTTP or console errors.

Final packed-install acceptance passed on 2026-08-15 for every supported input. A
live Anthropic URL exposed that standalone tailoring was inheriting screening questions
saved by an earlier Apply run. The packet boundary now includes answers only for explicit
Apply intent or an explicit low-level question capture. A rebuilt package generated only
the résumé and cover letter, made no answers-model call, rendered **Tailored documents**,
and exposed only Export documents and Review documents. A real pasted JD and a real
file-picker upload both preserved `requestedAction: tailor`, showed the exact
capture/evaluate/tailor confirmation, returned 89/100 and 92/100 KEEP verdicts, and
produced the same documents-only result with no application handoff or submission write.

## Company research, comp benchmarks, and company health in Ask

Three previously agent-only skills now have native Ask entries. Natural phrasings
("research Acme", "market comp for a nurse in Denver", "is Acme a safe place to
land") resolve to typed `research.company`, `research.comp`, and `company.health`
intents; the `-request` variants for company-scoped asks resolve through a shared
company reference resolver that token-matches tracked applications and sourced
rows, caps ambiguity choices at five, and returns specific recovery copy for
company-not-found, ambiguous, not-tracked, and missing-role/location cases.

A fresh result short-circuits the round trip: a company-research dossier inside
its staleness window, a comp benchmark inside its own staleness window, or a
companyHealth rating inside its recheck window renders immediately as a result
card — cited markdown dossier, floor/midpoint/ceiling benchmark, or rating with
per-dimension levels and any fit cross-cut — with an explicit refresh action.
Otherwise Ask starts or reuses an embedded research chat session, scoped to the
skill's own network tool profile (`CHAT_RUNTIME_TOOLS`: WebSearch/WebFetch/Skill,
no Bash). That profile gap means persistence is NOT the same mechanism board
discovery uses — board/company discovery write their proposals directly from a
server-held batch on confirmation, but an embedded research/comp/health session
has no shell to run `careerrat research record`/`careerrat health record` from.
Instead the skill finishes its work and emits the result as a typed
`careerrat:discovery` block (`company_research_result` / `comp_benchmark_result` /
`company_health_result`); the app renders it as a Save to workspace / Discard
control, and Save fires a separate confirmed intent (`research.record` or
`company.health-record`) that performs the write server-side, deterministically,
through the exact same validated guards the CLI path used — `computeResearchWrite`/
`writeResearch` (citation-hygiene, placeholder lint, `current_base` leak) for the
research pair, `companyHealthSet`/`validateCompanyHealth` (rating/provenance/asOf
enums, `fitDelta` clamped to <= 0, the same `current_base` leak guard) for health.
The chat session itself never writes; saving is always the separate, explicit,
confirm-first step.

Confirm boundaries hold across all three: starting a research or health session
is itself an explicit user ask, not a background action, and so is the follow-up
save. The company-health write path (CLI or conversational) is dry-run-by-default/
confirm-first either way — `careerrat health record <id> --file rating.json
[--write]` from a one-shot CLI run, or the confirm-first `company.health-record`
intent from an embedded chat session — with the same rating/provenance/asOf
validation, `fitDelta` clamped to <= 0, and `current_base` privacy guard in both
cases; a company-health rating never enters an outbound artifact regardless of
how it was triggered. Both paths call the identical `companyHealthSet` verb, so
both log the required Activity Pulse event in the same transaction; this replaced
the prior hand-patched `set-fields`/`upsert-batch` path with one validated verb.

Headed isolated-home acceptance passed on 2026-08-15 against the real server and
HTTP API with a non-tech seed (a nurse, a driver, and a medical assistant): all
new preview phrasings routed to the correct typed intents while board and company
discovery phrasings kept their old routes; the `careerrat health record` write
surfaced in the company.health short-circuit, the dashboard drawer, and the
Activity Pulse event; fresh research artifacts returned reused result cards with
no session start; `force` with no AI runtime degraded to the actionable
NO_AI_ROUTE message with no stack trace; ambiguity, not-tracked, and
missing-input cases returned their exact codes and statuses; `research.record`
persisted a real artifact and refused a `current_base` payload; and every prior
thread message, rating, and artifact survived a full server restart. No 5xx and
no console errors were observed. Packaged/clean-install acceptance and a live
embedded research session with a real AI runtime remain open for these rows.

## Strategy review in Ask

Natural phrasings ("review my strategy," "why am I getting filtered out," "what's
working in my search," "what should I change in my search") resolve to a typed
`strategy.review` intent (`strategyReviewRequestFromText` in `workspace-agent.mjs`);
the Dashboard's Strategy panel submits that same intent directly through
`requestAskAction` when its review-trigger CTA is ready, so the button and the typed
phrase land in the identical Ask turn instead of a same-page reveal. The server
assembles the analysis context deterministically before any AI call — funnel counts
and role-family breakdown, the dashboard's own source/lane/fit-band insights,
targeting signals (keep/cut signals, excluded companies, fit bands), comp target/floor
only (`current_base` is never read here), and compact learning-file headings — then
makes one bounded, non-agentic structured AI call (no tool access, no web, no shell)
to draft ranked findings and typed recommendations.

A freshness gate runs first: it reuses the exact `STRATEGY_REVIEW_NEW_SIGNAL`/
`STRATEGY_REVIEW_COOLDOWN_DAYS` thresholds and the `strategyReviewSignal` function the
dashboard's own review-ready nudge already uses (now exported from `dashboard-data.js`
for this purpose rather than re-derived), so the two surfaces can never disagree about
what counts as new signal. A review with nothing new since the last stamp returns a
"nothing new since your last review" state with an explicit **Run it anyway** action.

No-AI degrade: when the bounded AI call has no route, the workflow still completes
with the dashboard's own deterministic strategy recommendation, labeled "No AI
available" and framed as CareerRat's deterministic tracker rules rather than a
model-drafted read.

Every recommendation renders with its own Apply control; nothing applies
automatically — applies are always a user click on the `strategy_review` card.
`strategy.apply` dispatches one recommendation at a time through the same validated
writers Settings and the CLI already use: DB-native gate edits for keep/cut signals and
excluded companies, comp target/floor edits, fit-band patches, learning-file appends,
and re-ranks capped at 5 rows per apply. Comp-target/floor and fit-band applies carry
explicit consequence copy before the click ("Updates the comp target future
evaluations compare against," "Re-scores every job on your board"). Writing-style and
other free-text recommendations are present-only — no writer exists for them, so the
card shows the proposed text with no Apply button. `strategy.stamp` ("Finish review")
writes the same `strategyReview` marker and Activity Pulse event as the CLI's
`strategy-review stamp --write`, and silences the dashboard's review-ready nudge until
enough new outcomes accrue again.

Repository and web test suites pass and builds are clean. Headed isolated-home
acceptance ran 2026-08-15 against the real server with no AI runtime (seeded
nurse/Denver workspace): all matrix rows passed — preview routing plus
non-regression, the manual no-AI degrade (200, never a 501), every apply type
including the 5-row re-rank cap and the writing-style unsupported path, the stamp
clearing the dashboard nudge, freshness fresh/force, restart durability, and a
clean 5xx/stack-trace sweep. The one finding (comp-target/floor applies returned
the raw config-patch result, leaking `current_base` into the response and durable
thread) is fixed: apply writers now return scoped summaries only, with a
serialization regression test. Packaged acceptance and a live run against a real
AI runtime remain open for this row.

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
