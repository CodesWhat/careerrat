# CareerRat full-product acceptance ledger

Started: 2026-08-13
Reopened: 2026-08-14
Current tranche completed: 2026-08-15

Gate result: all 103 recorded findings are fixed and live-retested. The clean-home onboarding, Ask
rate/apply, deterministic-provider, npm install, update/restart, and native Electron checks pass.
The broader native skill-to-screen build gate remains tracked separately in
`SKILL-UX-AUDIT.md`.

v0.16.3 release-candidate rerun: 2026-08-26

- PASS: fresh desktop onboarding opened Search at completion and presented the running first-search
  handoff instead of leaving the candidate to discover the next surface.
- PASS: a locality-constrained sweep examined 358 postings with `Brooklyn, NY local + Home-country
  remote`, excluded onsite work, returned one Remote US Bestow match, and saved its full job
  description.
- PASS, ORIGINAL BASELINE: a public Grafana Labs Greenhouse form filled 15 safe fields and attached
  one résumé. Exactly three voluntary demographic questions had no saved candidate answer and stayed
  unanswered. The browser stopped at the CAPTCHA, did not press Submit, and left the application at
  Reviewed Hold with all applied/submitted timestamps null.
- PASS: a fresh browser session reported zero console errors and zero warnings. The repository suite
  passed 3,848 tests with 15 intentional skips, the web suite passed all 712 tests, and web, website,
  docs, and desktop builds passed. Desktop smoke returned `SMOKE OK`; lint completed with no errors;
  knip, placeholder lint, and `git diff --check` passed.
- PASS: the current desktop bundle ran a fresh Codex-backed intake turn and rendered Paul's exact
  plain-English question, “What would make one job worth applying to before another? For example,
  interesting technical work, strong engineering practices, or room to grow.” The preceding
  yes-or-no guardrail question also used concrete examples and rendered clickable Yes/No answers.
  Reload restored the question and the clean browser context reported zero errors and warnings.
- PASS: **Profile > Application defaults**
  now offers exactly two local, user-owned choices for voluntary demographic and self-identification
  questions: leave them blank, or choose the form's decline option when available. Existing
  exact answers remain hidden and preserved. The policy and answers are redacted from Paul's context;
  supervised apply may use only that saved policy or an explicitly saved exact answer and must never
  infer one. Focused schema, form-fill, apply-driver, profile-model, and UI coverage passes. The
  follow-up live Greenhouse run filled 22 fields, uploaded one résumé, and finished with zero
  unresolved fields. The CAPTCHA was the sole blocker, Submit stayed untouched, and the application
  remained `reviewed-hold` with `submitted_at` and `applied_at` null.
- PASS: completed setup with `confirmed_at` null showed only the local Application defaults dialog,
  without requiring runtime or chat setup. Separate live passes covered both choices: **Leave them
  blank** saved the disabled blank policy, while **Choose decline when available** saved
  `enabled: true`, `default_action: decline_when_available`, a fresh `confirmed_at`, and `answers: {}`.
  Each handed off to the workspace, stayed dismissed after reload, and the current browser console
  reported zero errors and warnings.

This is the live execution ledger for the release gate in `docs/ROADMAP.md`. Status values are
`NOT RUN`, `PASS`, `FAIL`, `FIXED`, or `DEFERRED`. Every failure needs reproduction evidence,
severity, root cause, fix/test references, and a live retest before it becomes `FIXED`.

Test homes:

- Fresh: no database or prior setup
- Returning: demo-seeded local database with applications, sourced roles, interviews,
  communications, relationships, evidence, activity, and calendar state

## Global shell and workspace conversation

- [x] `G-01` Navigation reaches every declared route and preserves browser history/deep links.
- [x] `G-02` Incomplete setup gates product routes but leaves Settings and onboarding usable.
- [x] `G-03` Ask works from every product route and keeps one durable thread across navigation.
- [x] `G-04` Ask handles attachment, confirmation, cancel, retry, reload, and runtime failure honestly.
- [x] `G-05` Activity/toasts update after writes and expose useful recovery for failures.
- [x] `G-06` Keyboard navigation, focus visibility, labels, landmarks, and dialogs are usable.
- [x] `G-07` Light/dark themes and 1440px, 1024px, and mobile layouts have no clipped controls.
- [x] `G-08` Reload and server restart preserve route, state, and completed actions without duplicates.
- [x] `G-09` Ask rehydrates its last completed turn (result card and follow-up actions) from the durable
  thread after reload. Observed 2026-08-16 during report-issue acceptance: the thread persists
  server-side but the Ask bar mounts empty. Decided 2026-08-21 (Scott): replay-on-mount is intended.
  Implemented in #159: mount-time fetch of the existing thread read, completed turns only, failed and
  in-progress turns stay unreplayed, live turns always beat a late rehydration response.

## Onboarding

- [x] `O-01` Runtime detection/selection explains installed choices in non-technical language.
- [x] `O-02` PDF résumé upload extracts, reviews, confirms, and survives reload.
- [x] `O-03` DOCX and plain-text résumé paths behave like PDF without duplicate uploads.
- [x] `O-04` No-résumé path reaches search-ready setup without deadlock.
- [x] `O-05` Paul asks only unresolved questions and progressive notes stay visible and editable.
- [x] `O-06` Location, work modes, compensation, companies, evidence, and guardrails save truthfully.
- [x] `O-07` Decline, retry, correction, resume-later, and manual checklist paths preserve progress.
- [x] `O-08` Completion review matches canonical state and first search starts exactly once.

## Home

- [x] `H-01` Fresh/incomplete, empty-complete, and populated home states explain the next action.
- [x] `H-02` Focus, pipeline, next steps, and activity agree with canonical dashboard state.
- [x] `H-03` Home deep links open the correct job, interview dossier, or setup surface.
- [x] `H-04` Writes elsewhere update Home immediately without stale counts or duplicate actions.

## Jobs and application workflow

- [x] `J-01` Tabs, filters, search, counts, URL state, empty states, and long content work.
- [x] `J-02` Sourced Promote/Skip writes once, updates lists, and survives reload.
- [x] `J-03` Drawer deep links, navigation, previews, close controls, and source links work.
- [x] `J-04` Full JD capture distinguishes complete, partial, stale, login-gated, and unavailable.
- [x] `J-05` Evaluation KEEP/REVIEW/CUT and compensation/fit displays never fabricate certainty.
- [x] `J-06` Document generation, unresolved answers, preview, export, and regeneration work.
- [x] `J-07` Apply on site cannot mark Applied without verified or user-reported completion.
- [x] `J-08` Status, follow-up, note, communication, and interview actions clear satisfied CTAs.
- [x] `J-09` Jobs writes update Home, Calendar, Network, Library inputs, activity, and Ask context.
- [x] `J-10` Supervised Apply captures the live form, fills only confirmed values, stops before
  Submit, and requires confirmation-page screenshot evidence before writing Applied.

## Calendar

- [x] `C-01` Week/month navigation, today, timezone, DST, and date formatting are correct.
- [x] `C-02` Interviews, follow-ups, deadlines, and busy blocks appear on the correct dates.
- [x] `C-03` Event detail links return to the owning job/conversation and completed events clear.
- [x] `C-04` Empty/loading/error states and small layouts remain usable.

## Network

- [x] `N-01` Company/contact search, filters, counts, empty states, and long names work.
- [x] `N-02` Relationship drawer shows correct job and communication history.
- [x] `N-03` Lead capture/status/follow-up writes survive reload and update other surfaces.
- [x] `N-04` Missing contact data and no relationship records degrade honestly.

## Library and Deep Ingest

- [x] `L-01` Evidence, stories, role signals, writing voice, and boundaries render/filter correctly.
- [x] `L-02` Add/edit/remove/confirm flows persist once, validate, and survive reload.
- [x] `L-03` Provenance and confirmed/unconfirmed state are clear; long source text is safe.
- [x] `L-04` Confirmed facts actually affect evaluation and packet generation; removed facts do not.
- [x] `D-01` All ingest lanes accept supported sources and expose extraction/proposal progress.
- [x] `D-02` Confirm/reject/retry/version-conflict paths preserve the source and avoid duplicates.
- [x] `D-03` Empty, no-AI, schema-failure, and partial-extraction states have a usable recovery.

## Settings

- [x] `S-01` Candidate, targeting, role lanes, location/work modes, comp, and guardrails round-trip.
- [x] `S-02` Installed runtimes, custom command, provider fallback, and selected engine round-trip.
- [x] `S-03` Automation consent is capability-specific, off by default, and described plainly.
- [x] `S-04` Source maintenance adds/edits/removes/tests sources without hidden writes.
- [x] `S-05` Validation is field-specific; unsaved edits, failures, and restart do not lose input.
- [x] `S-06` Settings remains usable before setup and correctly unlocks the product when complete.

## Compatibility, failures, and release

- [x] `R-01` Classic dashboard matches app counts/actions or has an explicit retirement blocker.
- [x] `R-02` No-AI, runtime timeout/crash/schema error, offline, and partial network are actionable.
- [x] `R-03` Missing DB/artifact, unavailable ATS, empty search, concurrent write, and cancellation are safe.
- [x] `R-04` CLI commands used by the app agree with UI state and preserve the one-write contract.
- [x] `R-05` Docs and website navigation/links match the shipped product and current CareerRat brand.
- [x] `R-06` npm-pack install starts a clean home and includes every required runtime asset.
- [x] `R-07` Packaged Electron owns paths/runtime correctly; navigation, external links, quit, and restart work.
- [x] `R-08` Final tests, lint, production builds, package dry-run, and clean-device smoke pass.

## Findings

### `F-001` Library hid confirmed onboarding evidence

- Status: `FIXED`
- Severity: P1, saved candidate truth was invisible on a core product surface.
- Reproduction: in a DB workspace, save a canonical evidence claim without Deep ingest provenance,
  then open `/app/library`; the page showed “No reusable material yet.”
- Root cause: the DB Library snapshot read only Deep ingest provenance-scoped evidence and omitted
  otherwise-confirmed rows in `candidate_evidence_claims`.
- Fix: Library now combines the canonical candidate evidence document with confirmed Deep ingest
  story, voice, honesty, and role-signal rows; unconfirmed proposals remain excluded.
- Regression: `tests/deep-ingest-db.test.mjs` covers onboarding evidence without Deep ingest ids.
- Live retest: PASS on the returning-user home; the saved RAG claim renders with its metric and
  role-signal tags after restart.

### `F-002` Selected onboarding runtime has no programmatic selected state

- Status: `FIXED`
- Severity: P1, keyboard and assistive-technology users cannot tell which detected runtime is active.
- Reproduction: select Codex on `/app/onboarding` and inspect the runtime chooser. The visual card
  changes, but the nested “Select Codex” button exposes neither radio semantics nor `aria-pressed`.
- Expected: the detected runtimes are one named choice group and expose the selected choice.
- Fix: each runtime selector now publishes its current state with `aria-pressed` while retaining
  native button keyboard behavior.
- Regression: `apps/web/src/onboarding/EngineScreen.test.jsx` covers both unselected and selected states.
- Live retest: PASS in the engine re-entry flow; the active Codex selector exposes
  `aria-pressed="true"` after a production rebuild and server restart.

### `F-003` Ask discarded failed requests without a retry

- Status: `FIXED`
- Severity: P1, a temporary local-runtime or proxy failure forced the user to reconstruct the prompt.
- Reproduction: submit “What should I do next?” with an unreachable configured proxy. Ask showed a
  generic error, cleared the composer, and exposed no retry action.
- Root cause: Ask turns retained only display text, not the original request or its retryability.
- Fix: failed answer, action, text-capture, and file-capture turns retain their exact request and show
  a “Try again” action for recoverable failures.
- Regression: `apps/web/src/app-shell/AskBar.test.jsx` resends the exact failed request.
- Live retest: PASS on Calendar with a deliberately unreachable proxy; the error remains honest and
  the visible retry action resubmits the request.

### `F-004` A brand-new bundled demo failed the tracker schema

- Status: `FIXED`
- Severity: P0, the product's own populated starter state could not pass its release verifier.
- Reproduction: run `careerrat data init --demo`, then `careerrat tracker --verify`; it reported 43
  communication-channel and missing-summary violations while `careerrat data verify` reported clean.
- Root cause: legacy application-source channel values were copied into demo communication records,
  and application-receipt threads had no required top-level summary.
- Fix: the bundled demo uses `email` or `portal` communication channels and supplies concise receipt
  summaries. The byte-shape-compatible importer remains unchanged.
- Regression: `tests/db-export.test.mjs` now requires both the source demo and DB round-trip to pass
  `config/tracker.schema.json`.
- Live retest: PASS in a new temporary home; both data verification and tracker schema verification
  complete with zero errors or warnings.

### `F-005` Jobs pipeline uses numbered interview rounds

- Status: `FIXED`
- Severity: P1, this contradicts CareerRat's canonical cross-company round vocabulary.
- Reproduction: open Jobs > Pipeline in the populated demo. The flow labels are “1st round” through
  “4th round” instead of Screen, Assessment, Technical, Hiring manager, Onsite, and Final.
- Root cause: the app Sankey intentionally grouped applications by raw conversation count even
  though cards and canonical tracker state use semantic stage types.
- Fix: each application now enters the funnel at its exact deepest canonical stage, with direct
  links that do not invent skipped stages. Rejected, withdrawn, and accepted rows remain anchored
  to the semantic stage they reached, and clicking a stage filters to exactly the rows it counts.
- Regression: `tests/dashboard-data.test.mjs`, `apps/web/src/jobs/FunnelSankey.test.jsx`,
  `apps/web/src/jobs/jobsExplorer.test.js`, and `apps/web/src/jobs/JobsPage.test.jsx` reject numbered
  nodes and cover semantic stage rendering and exact filters. Static preview data uses the same model.
- Live retest: PASS in the populated workspace after a production rebuild and server restart. The
  funnel shows Hiring manager, Onsite, Final, and Offer with no numbered rounds; selecting Hiring
  manager shows the one counted Hooli row, including its terminal rejected state.

### `F-006` Finder engine status contradicts ranked results

- Status: `FIXED`
- Severity: P1, the user cannot tell whether displayed fit scores are current, approximate, or stale.
- Reproduction: open Jobs > Finder in the populated workspace. The page says “NO ENGINE · NOTHING
  RANKED” while four or more rows display approximate numeric scores and both search launchers say READY.
- Root cause: legacy receipt copy described the absence of AI ranking but ignored the deterministic
  coarse-triage score that Finder actually displays with a `~` prefix.
- Fix: the free-board receipt now says “RULES · APPROXIMATE TRIAGE.”
- Regression: `apps/web/src/jobs/JobsPage.test.jsx` rejects the contradictory legacy copy.
- Live retest: PASS with four populated Finder rows and their approximate scores visible together.

### `F-007` Promoting a sourced role can create an over-budget internal note

- Status: `FIXED`
- Severity: P1, an ordinary UI action writes canonical data that violates the 60-character content register.
- Reproduction: promote the bundled Black Mesa Applied AI Engineer prospect. Its 157-character source
  note becomes the application internal note even though the same drawer labels that field “≤60 chars.”
- Root cause: the atomic DB promotion copied the sourced blob verbatim and did not enforce the
  application-only content register at the sourced-to-application boundary.
- Fix: promotion trims and clamps the application note to 60 Unicode characters before its one write.
- Regression: `tests/db-verbs.test.mjs` promotes a long source note and asserts its exact 60-character value.
- Live retest: PASS by promoting Massive Dynamic through the rebuilt UI; the canonical DB value is 60
  characters and the source row was removed in the same transaction.

### `F-008` Bundled sourced roles have no captured JD artifact

- Status: `FIXED`
- Severity: P1, evaluation cannot rely on a durable job body and the posting can disappear.
- Reproduction: open or promote the bundled Black Mesa prospect. Artifacts contains only the remote
  source link; no local JD body or partial-capture marker is present.
- Root cause: the demo fixture's sourced rows had no `artifacts.jd`; its 29 application rows used an
  obsolete inline-summary value; and demo initialization imported tracker rows without copying the
  referenced artifact tree into the active workspace.
- Fix: all 38 application and sourced rows now use canonical `workspace/jobs/*.md` paths. Demo init
  copies the fixture artifact tree and creates an explicitly `partial: true` capture for any fictional
  row without a full body, instead of fabricating completeness.
- Regression: `tests/db-export.test.mjs` seeds the bundled demo, requires every row's canonical path,
  reads every artifact through the real job-description boundary, and accepts only complete or
  explicitly partial captures with useful content.
- Live retest: PASS in a fresh demo home. The Cyberdyne application API returns a 3,584-character
  complete capture. The Black Mesa Finder drawer opens a readable 509-character preview and shows
  “Partial capture” beside the artifact.

### `F-009` Paul's Notes stayed blank while extracted facts awaited confirmation

- Status: `FIXED`
- Severity: P0, the core progressive-onboarding interaction looked broken even though Paul had
  correctly extracted four candidate facts.
- Reproduction: answer the first setup prompt with location, target roles, compensation, and work
  authorization. The chat showed four Confirm actions while the right rail still said details would
  appear there later.
- Root cause: the file pane rendered canonical candidate state only and ignored unresolved chat
  confirmation blocks.
- Fix: Paul's Notes now renders a clearly labeled pending-confirmation section from unresolved
  profile, targeting, authorization, company, and evidence proposals, then replaces each preview
  with canonical state when confirmed.
- Regression: `apps/web/src/onboarding/FilePane.test.jsx` and
  `apps/web/src/onboarding/InterviewSurface.test.jsx` cover pending previews and resolution.
- Live retest: PASS with all four pending groups visible before confirmation and progressively
  replaced by saved checklist rows after confirmation.

### `F-010` Paul withheld explicitly stated identity details

- Status: `FIXED`
- Severity: P0, the setup transcript advanced while the candidate's name remained absent from the
  live file, contradicting the progressive-notes interaction.
- Reproduction: state only a full name, or state name, email, and phone together. The setup skill
  previously allowed the identity group to wait until every related field was collected.
- Root cause: the setup contract bundled identity/contact persistence instead of proposing each
  explicit fact in the turn where it was learned.
- Fix: the setup contract now requires an immediate confirmation block for every explicit fact and
  specifically forbids waiting for related identity fields.
- Regression: `tests/release-safety.test.mjs` enforces the immediate-fact contract.
- Live retest: PASS. One message containing name, email, phone, and domain produced two immediate
  Confirm actions and showed all four facts in Paul's Notes before confirmation.

### `F-011` Paul re-asks a location that is already saved

- Status: `FIXED`
- Severity: P1, redundant questions make setup feel unaware of the file it is building.
- Reproduction: save Austin, TX from the first onboarding answer, then provide name, email, phone,
  and domain. Paul replies, “What city, state, and country do you call home?”
- Expected: every turn checks canonical and unresolved proposed state, then asks only the next
  genuinely missing fact.
- Root cause: installed-runtime chat replayed the transcript but had no authoritative current
  candidate snapshot, and the skill contract did not explicitly treat pending proposal payloads as
  answered facts.
- Fix: both installed and SDK chat routes now refresh a compact, `current_base`-redacted canonical
  candidate snapshot before every onboarding turn. The setup contract also forbids re-asking values
  present in either canonical or unresolved proposal state.
- Regression: `tests/chat-runtime.test.mjs` covers snapshot refresh on every turn for both runtime
  routes; `tests/release-safety.test.mjs` enforces the state-aware question contract.
- Live retest: PASS after a server restart. Paul named the already-saved identity, roles,
  compensation, location, and authorization, then advanced to the no-résumé work-history path
  without repeating any of them.

### `F-012` Conversational setup drops the candidate's job-board preferences

- Status: `FIXED`
- Severity: P1, a directly requested onboarding answer has no durable write and cannot shape source
  setup later.
- Reproduction: in the no-résumé conversation, answer Paul’s “Which job boards or aggregators do
  you usually use?” with LinkedIn and Indeed. The next question appears, but there is no confirmation
  action, saved note, source proposal, or canonical candidate field for either answer.
- Root cause: the setup interview inherited a CLI-only question whose answer could be carried into a
  later `--write-config` command. The primary web chat has no equivalent source-config write.
- Fix: web onboarding no longer asks for job-board preferences. The setup-searches handoff owns that
  question and writes its answer through the source APIs; one-shot shell onboarding may ask only
  when the same run performs and verifies the config write.
- Regression: `tests/release-safety.test.mjs` requires this surface-specific ownership rule.
- Live retest: PASS in the clean PDF, DOCX, and text setup runs. Paul completed the candidate file
  without asking for LinkedIn/Indeed preferences, then the completion pipeline handed source choices
  to the dedicated board-research and source-review flow.

### `F-013` Reaching 8 of 8 abandons unresolved setup facts

- Status: `FIXED`
- Severity: P0, the success screen can erase visible, unconfirmed candidate choices and terminate
  the interview mid-question.
- Reproduction: propose three tracked companies plus additional cut signals when the setup checklist
  is 7 of 8, then confirm only the first company. The canonical checklist reaches 8 of 8 and the UI
  immediately replaces the transcript, dropping the other companies, the cut-signal proposal, and
  Paul’s unanswered exclusion question.
- Root cause: the interview rendered completion from canonical checklist readiness alone, without
  considering the running turn, unresolved confirmation blocks, or an unanswered assistant question.
- Fix: completion now waits for the durable transcript to load and stays in the interview while a
  turn is running, any visible proposal is unresolved, or the latest conversational turn is an
  unanswered assistant question.
- Regression: `apps/web/src/onboarding/InterviewSurface.test.jsx` covers all three attention states
  and a complete canonical checklist with a restored pending company proposal.
- Live retest: PASS after production rebuild and server restart. The transcript restored at 8 of 8
  with OpenAI, Scale AI, and the cut-signal proposal still actionable, and each saved independently.

### `F-014` Onboarding completion starts a job sweep before source discovery

- Status: `FIXED`
- Severity: P0, this bypasses the required setup-searches, research-boards, and discover-companies
  sequence and tells the user setup is done before source decisions are made.
- Reproduction: let the eighth checklist item save. The completion screen automatically calls the
  first-search endpoint and reports “First sweep done: 4 boards” without a source review or company
  ATS discovery pass.
- Root cause: `CompletionScreen` owns an automatic `startFirstSearchRun()` effect inherited from the
  older quick-start flow instead of handing off to the source-setup workflow.
- Expected: profile completion points to the next guided source-setup action. A job sweep starts only
  after source and company discovery are completed or explicitly skipped.
- Fix: completion now has an explicit “Set up search sources” handoff into guided board research and
  never starts the first sweep as a mount side effect.
- Regression: `apps/web/src/onboarding/InterviewSurface.test.jsx` rejects automatic sweep calls and
  requires the discovery chat to start only after the button click.
- Live retest: PASS after completing the full deep interview. The done screen states that no job
  search starts until source and company discovery are reviewed, and no sweep ran.

### `F-015` Incorrect setup proposals cannot be dismissed

- Status: `FIXED`
- Severity: P0, a typo or bad extraction leaves a permanent pending fact with only a Confirm action,
  and the safer completion gate can never clear.
- Reproduction: let Paul propose an incorrect candidate patch, company, or evidence claim. The pill
  has no Dismiss/Not now action; only authorization and the retired mode choice can decline.
- Root cause: `ConfirmPill` treated ordinary proposals as single-action approvals and
  `InterviewSurface` only implemented decline handling for two sensitive-answer kinds.
- Expected: every unresolved proposal can be rejected without a canonical write, records the
  resolution in the durable transcript, and tells Paul not to assume the rejected value.
- Fix: every confirmation kind now exposes a secondary resolution action: “Dismiss” for ordinary
  proposals, “Not now” for capability consent, and “I’d rather not say” for sensitive answers.
  Ordinary dismissals perform no canonical write and send Paul a correction-aware system turn when
  the chat is live.
- Regression: `apps/web/src/onboarding/ConfirmPill.test.jsx` covers labels across proposal kinds;
  `apps/web/src/onboarding/InterviewSurface.test.jsx` proves dismissal writes nothing and clears the
  durable pending block.
- Live retest: PASS after restart. The malformed compensation cut-signal proposal restored with a
  Dismiss action, resolved to “Dismissed,” disappeared from Paul’s Notes, and setup continued.

### `F-016` Paul reclassifies a compensation floor that is already saved

- Status: `FIXED`
- Severity: P1, repetitive compensation questions erode trust and risk writing a private current
  salary or application-form value where the user only stated a minimum.
- Reproduction: after `$190,000` is already stored as `minimum_base`, restate “190000 dollars base”
  while correcting a typo. Paul says he has the minimum and target, then asks whether the repeated
  number is the minimum, current base, or application-form amount.
- Root cause: the setup contract says to inspect canonical state but does not explicitly prohibit
  reclassifying a repeated compensation value into another field.
- Expected: preserve the existing field meaning unless the candidate explicitly changes it, and ask
  about a different compensation concept only when it is genuinely required and still missing.
- Fix: the setup contract now preserves the meaning of repeated compensation values, prohibits
  soliciting or inferring `current_base`, and only asks for a different compensation concept when it
  is required and missing.
- Regression: `tests/release-safety.test.mjs` enforces the compensation-state rule.
- Live retest: PASS. Paul kept `$190,000` as the minimum, explicitly left current compensation
  private, proposed `$215,000` as the application-form value, and moved to the next comp question.

### `F-017` One compensation answer produces two indistinguishable confirmations

- Status: `FIXED`
- Severity: P1, an average user is asked to confirm the same `$215,000` fact twice under vague
  “personal details” and “application answers” labels with no explanation of why.
- Reproduction: state that `$215,000` is the expected base for application forms. Paul emits one
  `profile.compensation.expected_base` patch and one `form-defaults.expected_base` patch, each as a
  separate confirmation pill.
- Expected: one understandable confirmation atomically persists the canonical compensation value
  and its application-form default, or the UI clearly groups the mirrored writes as one decision.
- Fix: conversational setup now emits one application-answer confirmation. That single click writes
  the expected base to both `profile.compensation` and `form-defaults` before resolving.
- Regression: `apps/web/src/onboarding/InterviewSurface.test.jsx` proves one pill performs both
  durable writes; `tests/release-safety.test.mjs` keeps the skill contract single-confirmation.

### `F-018` Paul asks for pay floors for arrangements already ruled out

- Status: `FIXED`
- Severity: P1, setup ignores saved dealbreakers and makes the candidate answer hypothetical fields
  for work they already said they will not accept.
- Reproduction: save full-time onsite work and relocation as hard cuts, then reach arrangement pay
  floors. Paul asks for onsite-Austin and relocation minimums alongside remote and hybrid.
- Expected: collect floors only for allowed arrangements. Persist disallowed arrangements as
  unavailable without asking the candidate to invent a salary that would make them acceptable.
- Fix: arrangement-floor intake now reads the saved work-mode cuts, asks only about viable
  arrangements, omits invented numeric floors for excluded arrangements, and preserves the hard
  cut itself as the gate.
- Regression: `tests/release-safety.test.mjs` enforces both the allowed-arrangements-only rule and
  the explicit onsite/relocation skip.

### `F-019` Paul cannot see work facts already saved as evidence

- Status: `FIXED`
- Severity: P1, setup repeats work-history questions even though the candidate already confirmed
  the exact employer, title, dates, and metrics and CareerRat saved them as evidence.
- Reproduction: save “Staff Software Engineer at Acme Robotics” in an evidence claim, then describe
  a project at Acme. Paul asks, “What was your title at Acme Robotics?”
- Root cause: the canonical per-turn onboarding snapshot included profile, targeting, honesty, and
  form defaults, but omitted the evidence bank entirely.
- Fix: the refreshed canonical onboarding context now includes saved evidence claims, so every
  runtime route can reuse confirmed work-history facts instead of relying only on transcript recall.
- Regression: `tests/chat-runtime.test.mjs` creates a DB-backed evidence claim and proves it is
  present in `resolveCandidateChatContext()`.

### `F-020` A server restart restores the transcript visually but not to Paul

- Status: `FIXED`
- Severity: P0, the UI appears to resume setup while the replacement AI session starts without the
  restored conversation and repeats facts the candidate already answered.
- Reproduction: complete several setup turns, restart `tracker-dev`, reload onboarding, and answer
  the visible last question. The replacement chat receives only that newest message even though the
  full durable transcript is rendered on screen.
- Root cause: `InterviewSurface` restored `onboarding-draft.json` into React state, but
  `ensureChatStarted()` passed only the latest composer text to a newly-created server session.
- Fix: when no live chat exists, the replacement-chat kickoff now carries a bounded role-labeled
  copy of the durable user/Paul transcript plus the latest user message. Canonical candidate state
  remains the authoritative current values.
- Regression: `apps/web/src/onboarding/InterviewSurface.test.jsx` proves a replacement chat receives
  both restored roles and the new message while a first-time empty transcript stays unchanged.
- Live retest: PASS after a second server restart. Paul consumed the restored Acme/Beacon history,
  stopped repeating those work facts, and advanced to the missing country/timezone question.

### `F-021` Default setup asks for optional family and lifestyle constraints

- Status: `FIXED`
- Severity: P1, a normal setup unexpectedly asks for personal family/lifestyle details even though
  optional areas default to empty and the user never raised that topic.
- Reproduction: finish location, hybrid-days, and travel preferences in a default deep setup. Paul
  asks whether family or lifestyle constraints should affect role selection.
- Root cause: the setup preamble made lifestyle opt-in, but STEP 7 still listed it as an unconditional
  required question.
- Fix: STEP 7 now asks only when `optional_areas` explicitly includes lifestyle or the candidate
  raises a relevant constraint naturally; otherwise it skips the topic.
- Regression: `tests/release-safety.test.mjs` enforces the opt-in gate.

### `F-022` Default setup asks for optional company-size and funding-stage preferences

- Status: `FIXED`
- Severity: P1, setup continues into preference trivia a new user did not opt into, lengthening an
  already-complete required profile interview.
- Reproduction: answer the named-company exclusion question with no additional companies. Paul
  immediately asks for headcount and funding-stage limits.
- Root cause: STEP 10 made company-size preferences unconditional despite the setup preamble making
  optional work-preference questions opt-in.
- Fix: headcount/funding-stage intake now runs only when `optional_areas` includes work-preferences
  or the candidate naturally raises a limit; otherwise the question is skipped.
- Regression: `tests/release-safety.test.mjs` enforces the opt-in gate and skip behavior.

### `F-023` One set of profile links requires duplicate confirmations

- Status: `FIXED`
- Severity: P1, the same LinkedIn, GitHub, and portfolio values appear as separate profile and
  application-default confirmation decisions.
- Reproduction: provide all three links during form-default setup. Paul emits one profile patch and
  a second form-defaults patch containing the same values.
- Fix: conversational setup now emits one profile-links confirmation. That click persists the
  profile values and mirrors the same keys into form defaults before resolving.
- Regression: `apps/web/src/onboarding/InterviewSurface.test.jsx` proves the one-click dual write;
  `tests/release-safety.test.mjs` keeps the model contract to one proposal.

### `F-024` “No portfolio” produces a schema-invalid profile proposal

- Status: `FIXED`
- Severity: P0, clicking Confirm on an ordinary “I have no portfolio” answer fails with
  `candidate.portfolio expected type string, got null` and leaves setup blocked on Retry.
- Root cause: the model represented an absent optional profile URL as `null`, while profile URL
  fields are strings; only their form-default mirrors accept null.
- Fix: the setup contract requires an empty string for absent profile links, and the confirmation
  handler defensively normalizes model-proposed null profile links to empty strings while preserving
  null in the form-default mirror.
- Regression: the one-click profile-links test now starts from a null portfolio proposal and proves
  both schema-safe writes; release safety enforces the string-field contract.
- Live retest: PASS. The original failed pill restored after restart, Retry normalized the null,
  saved the links, and rendered LinkedIn/GitHub in Paul's Notes.

### `F-025` ATS authorization answers are proposed with the wrong types

- Status: `FIXED`
- Severity: P0, confirming ordinary work-authorization defaults fails with
  `requires_sponsorship expected type string, got boolean` and leaves setup blocked on Retry.
- Root cause: profile authorization uses booleans, but the similarly named reusable ATS form fields
  require human-readable strings. The setup instructions did not distinguish those schemas.
- Fix: the setup contract now requires Yes/No strings for form defaults, and the confirmation
  handler defensively converts model-proposed booleans before saving.
- Regression: `apps/web/src/onboarding/InterviewSurface.test.jsx` starts with boolean ATS proposals
  and proves schema-safe string writes; release safety enforces the field-type distinction.
- Live retest: PASS. The original failed authorization pill restored after restart and Retry saved
  the Yes/No defaults without another error.

### `F-026` Stated writing preferences disappear after Paul's acknowledgment

- Status: `FIXED`
- Severity: P1, application writing can ignore the candidate's explicit voice and anti-patterns
  even though setup says it saved them.
- Reproduction: with no writing samples, tell Paul to write in a plain, direct, evidence-first voice
  and avoid hype, jargon, invented personality, and em dashes. Paul acknowledges the rules and asks
  the next question without a confirmation action or canonical write.
- Root cause: STEP 14 only supported file-based calibration and had no conversational persistence
  path for preferences stated directly in chat.
- Fix: stated writing preferences now require one immediate honesty confirmation containing complete
  `style.prefer` and `style.avoid` arrays. The honesty schema and new-candidate defaults declare both.
- Regression: `tests/release-safety.test.mjs` enforces the conversational write contract and schema;
  `tests/yaml.test.mjs` verifies the updated example config remains parseable.
- Live retest: PASS after server restart. Paul presented one reviewable boundaries save, Paul's Notes
  previewed both lists, and the confirmed `style.prefer` / `style.avoid` arrays matched canonical DB state.

### `F-027` An unanswered user turn can trigger setup completion

- Status: `FIXED`
- Severity: P0, a user can send the final missing context and immediately lose the interview before
  Paul answers or presents the resulting confirmation.
- Reproduction: reach 8 of 8, restart the server, then answer Paul's last question. The durable
  transcript's newest turn is the user, but the UI swaps to “CareerRat is ready” while the
  replacement chat is starting.
- Root cause: the completion guard returned false when the latest user message appeared after the
  latest assistant message, treating an unanswered user as a completed exchange.
- Fix: an unmatched latest user turn now always keeps the interview open, independent of the chat
  runtime's initial state value.
- Regression: `apps/web/src/onboarding/InterviewSurface.test.jsx` covers an idle replacement session
  whose durable transcript ends with the user.
- Live retest: PASS with an 8-of-8 durable transcript ending in an unanswered user turn. Reload kept
  the full interview visible until Paul answered and both final proposals were resolved.

### `F-028` ATS work authorization can be saved under a noncanonical alias

- Status: `FIXED`
- Severity: P0, setup reports the reusable application answer as saved while
  `form-defaults.work_authorization` remains blank.
- Reproduction: confirm a form-defaults proposal containing `work_authorized: true`. The schema's
  permissive extension handling accepts that unknown key, but application filling reads the canonical
  `work_authorization` string.
- Root cause: the confirmation boundary normalized boolean value types but did not translate the
  similarly named profile-style alias to the ATS field name.
- Fix: form-default confirmation maps `work_authorized` to `work_authorization`, removes the alias,
  and normalizes both authorization answers to Yes/No strings. The dedicated authorization pill now
  also writes those reusable ATS strings in the same user action that saves profile authorization.
- Regression: `apps/web/src/onboarding/InterviewSurface.test.jsx` starts from the exact bad live
  proposal and requires only the canonical string fields at the write API; the dedicated
  authorization-pill test requires both profile and ATS writes.
- Live retest: PASS in the clean DOCX workspace. One authorization confirmation produced profile
  `work_authorized: true` / `requires_sponsorship: false` and form-defaults
  `work_authorization: "Yes"` / `requires_sponsorship: "No"`.

### `F-029` Source discovery re-asks the saved candidate domain

- Status: `FIXED`
- Severity: P1, the first post-setup task makes a normal user translate their search into an
  internal label they already supplied during setup.
- Reproduction: finish setup with `profile.candidate.domain` set, click “Set up search sources,”
  and wait for research-boards. It sees the role family and location but asks which candidate domain
  it should use.
- Root cause: the discovery handoff reused the outbound search-prompt context builder, which omitted
  `profile.candidate.domain` even though research-boards requires it.
- Fix: the outbound-safe search/discovery context now includes the saved domain when present.
- Regression: `tests/discovery-route.test.mjs` builds context from a complete candidate and requires
  the exact saved domain in the handoff payload.
- Live retest: PASS. The rebuilt research session immediately screened six boards using Riley's
  saved applied-AI/FDE domain and did not ask Riley to classify it again.

### `F-030` Board research asks the user to recite CareerRat's source registry

- Status: `FIXED`
- Severity: P0, the primary post-setup action dead-ends on implementation details an average user
  cannot reasonably know.
- Reproduction: restart after the saved-domain fix and start source setup again. research-boards
  asks, “What source labels or URLs are already configured?” instead of researching.
- Root cause: the network-isolated discovery chat received candidate targeting but not the local
  source registry it needs to deduplicate proposed boards.
- Fix: the server now includes a minimized `configured_sources` set in the outbound-safe discovery
  context; the skill treats that array as canonical and is forbidden from asking the candidate to
  enumerate internal source config.
- Regression: `tests/discovery-route.test.mjs` preserves the source labels, URLs, provider, type, and
  enabled state; `tests/release-safety.test.mjs` enforces the no-recite conversational contract.
- Live retest: PASS. research-boards deduplicated against the eight server-supplied sources and
  returned screened proposals without asking for labels, URLs, commands, or config details.

### `F-031` Discovery chat cannot persist an approved source or advance the pipeline

- Status: `FIXED`
- Severity: P0, the required post-onboarding workflow can research sources but cannot turn the
  user's decision into durable CareerRat state.
- Reproduction: let research-boards or discover-companies propose a source in the completion-screen
  chat, approve it in natural language, and inspect source config. The chat has only web and skill
  runtime tools, so no source or company write occurs and no durable completion advances the step.
- Root cause: `ChatPanel` treated natural-language confirmation as equivalent to the owning source
  APIs even though the runtime had no mutation tool and assistant prose had no parseable decision
  contract.
- Fix: discovery skills now emit typed `careerrat:discovery` proposal blocks. The app renders real
  Add/Track/Skip controls backed by the validated source APIs, records explicit step completion,
  resumes the saved next step after restart, and exposes the first search as a separate user action.
- Regression: `apps/web/src/onboarding/discoveryBlocks.test.js`,
  `apps/web/src/onboarding/ChatPanel.test.jsx`, `apps/web/src/onboarding/InterviewSurface.test.jsx`,
  `tests/agent-guidance.test.mjs`, and `tests/discovery-route.test.mjs` cover parsing, writes,
  decisions, durable advancement, restart resume, and the explicit first-search gate.
- Live retest: PASS. Add source persisted FD Roles, Track company persisted GitLab's Greenhouse
  board, Skip performed no write, both completion markers survived a server restart, and the app
  advanced to the explicit search action.

### `F-032` Company discovery starts but remains hidden behind the closed board session

- Status: `FIXED`
- Severity: P0, the required discovery sequence appears to stop after the first step even though the
  server starts and completes the next agent session.
- Reproduction: resolve every board proposal and click “Continue to company discovery.” The board
  chat changes to “Session ended,” while `/api/chat/list` shows an idle discover-companies session
  whose transcript never appears.
- Root cause: React reused the same stateful `ChatPanel` instance at the same tree position. Its
  `chatId` state retained the closed research session instead of adopting the new prop.
- Fix: key the discovery panel by skill and chat ID so every pipeline handoff mounts the intended
  session and subscribes to its own event stream.
- Regression: `apps/web/src/onboarding/InterviewSurface.test.jsx` requires distinct component keys
  before and after the research-to-company transition.
- Live retest: PASS in a fresh demo home. After both research-board proposals were explicitly
  skipped, “Continue to company discovery” immediately replaced the old transcript with a live
  discover-companies session. Paul asked for the candidate domain in the visible panel; the old
  “Session ended” state did not remain on screen.

### `F-033` Discovery results render as raw Markdown syntax

- Status: `FIXED`
- Severity: P1, the average-user source review is a dense blob of hashes, pipes, dashes, and raw
  link syntax instead of a readable result summary.
- Reproduction: finish research-boards in the completion-screen chat. The assistant's standard
  heading and proposed-board table appear literally as `##`, `|---|`, and `[label](url)` text.
- Root cause: `ChatPanel` inserted assistant text as a plain React string even though discovery
  skills have a documented Markdown output contract.
- Fix: the panel now uses a safe React-only block renderer for headings, tables, lists, line breaks,
  and the existing restricted inline formatting. It never parses raw HTML or allows non-HTTP links.
- Regression: `apps/web/src/onboarding/chatMarkdown.test.jsx` covers the discovery table shape and
  rejects an unsafe link scheme.
- Live retest: PASS. Company discovery rendered a level-three heading, an accessible eight-column
  table with real HTTP links, and separate Track/Skip cards instead of visible Markdown syntax.

### `F-034` The post-discovery search button can reuse a stale completed run

- Status: `FIXED`
- Severity: P0, newly approved sources and company boards are not searched even though the UI says
  “First search started.”
- Reproduction: complete an initial search before discovery, then add FD Roles and GitLab through
  the guided review and click “Start first search.” The idempotent first-run endpoint returns the
  older completed receipt, the new sources retain null watermarks, and no scan starts.
- Root cause: the completion screen ignored the first-run response's `reused` and terminal status,
  treating every successful HTTP response as newly started work.
- Fix: the explicit action starts the idempotent first run when none exists, but starts a normal
  post-discovery refresh when the first run is already complete. Parked/failed results no longer
  produce a success claim, and reused running work gets truthful copy.
- Regression: `apps/web/src/onboarding/InterviewSurface.test.jsx` covers both a new first run and a
  completed-first-run fallback to a new manual search.
- Live retest: PASS against the original stale first-run state. The rebuilt button created a new
  manual-search run at 04:52, scanned five deterministic sources including one supported ATS
  company, and reported the post-discovery refresh honestly.

### `F-035` Paul starts before résumé extraction and leaves his notes blank

- Status: `FIXED`
- Severity: P0, the primary résumé-first setup path immediately asks for facts already printed in
  the document while the area that is supposed to fill from the résumé remains blank.
- Reproduction: from a fresh home, select a runtime and upload a real PDF résumé. CareerRat starts
  the ingest-profile chat before the 20 to 50 second extraction finishes, so Paul asks a generic
  domain question and Paul's Notes shows no reading or extraction state. The facts arrive in a
  corrective system turn only after the misleading first response.
- Root cause: `handleResumeDrop` called `ensureChatStarted` before `extractResumeAi`, then sent the
  extracted facts as a second turn after canonical writes completed.
- Fix: the drop now docks the interview locally and shows the active filename in both columns while
  extraction runs. A new chat starts only after extracted facts are saved, using those facts in its
  first kickoff; an existing chat receives the same context after extraction.
- Regression: `apps/web/src/onboarding/InterviewSurface.test.jsx` holds extraction open and requires
  visible reading progress with no chat start, then requires the first chat kickoff to contain the
  saved facts. `apps/web/src/onboarding/FilePane.test.jsx` requires a live-region reading card in
  place of the empty profile placeholder.
- Live retest: PASS in a brand-new home with a real PDF. Both columns showed the active filename
  during extraction; six claims, identity, roles, and companies filled before Paul's first response;
  that response referenced the two extracted employers instead of asking for a known domain.

### `F-036` Default setup asks an average candidate about over-employment

- Status: `FIXED`
- Severity: P1, an otherwise complete résumé setup remains open for an unexplained niche work
  arrangement the candidate never raised.
- Reproduction: complete the required PDF setup fields and confirm all proposals. At 8 of 8, Paul
  asks, “Are you open to OE, meaning a concurrent secondary position?”
- Root cause: STEP 4 of ingest-profile still required the OE question unconditionally even though
  the setup preamble makes optional work-preference branches opt-in.
- Fix: ask about an OE bucket only when the candidate naturally raises concurrent work or
  explicitly asks to configure it. Otherwise skip it, while preserving the existing OE comp path
  for candidates who opt in.
- Regression: `tests/release-safety.test.mjs` forbids an unconditional OE prompt and requires the
  opt-in contract.
- Live retest: PASS after restarting the clean DOCX setup with the corrected skill. Paul proposed
  only the three visibly missing required groups and never asked about OE.

### `F-037` Search-ready setup keeps interviewing for extra evidence

- Status: `FIXED`
- Severity: P0, the UI says 8 of 8 but refuses to finish because every additional assistant
  question keeps the completion gate open.
- Reproduction: finish and confirm the PDF flow's guardrails, quick facts, authorization, and
  writing boundaries. After the canonical setup becomes search-ready, answer Paul's last optional
  question. Paul asks for another Staff-level project even though six résumé evidence claims are
  already saved.
- Root cause: the skill's long-form enrichment steps had no hard conversational completion boundary,
  and the per-turn canonical context did not include the exact checklist completion the UI uses.
- Fix: make the shared 8-of-8 setup calculation available to the chat runtime, then use
  `setupProgress.complete` as a code-owned prompt boundary with a matching skill contract.
  Acknowledge the final answer, ask no new setup questions, and move optional enrichment outside
  initial onboarding.
- Regression: `tests/chat-runtime.test.mjs` requires the code-owned completion instruction whenever
  canonical state is search-ready; `tests/release-safety.test.mjs` requires the matching skill rule.
- Live retest: PASS after restarting the PDF workspace. The full transcript and 8-of-8 state
  restored, the replacement chat acknowledged the last answer without another question, and the UI
  advanced to “CareerRat is ready.”

### `F-038` Broad search readiness can declare onboarding complete at 5 of 8

- Status: `FIXED`
- Severity: P0, Paul tells the candidate initial setup is complete while Guardrails, Quick facts,
  and Work authorization remain visibly unfinished.
- Reproduction: upload the real DOCX fixture after adding a completion boundary based on
  `setup.readiness.search_ready`. Résumé extraction makes that broad pipeline readiness true while
  the onboarding pane still reads 5 of 8, so Paul's first response incorrectly declares completion.
- Root cause: pipeline search readiness intentionally has different requirements from the product's
  onboarding checklist and cannot serve as the UI completion signal.
- Fix: `computeSetupProgress` now lives in a shared core module used by both the onboarding route and
  chat context. Only its exact `complete: true` value activates the conversation boundary.
- Regression: `tests/chat-runtime.test.mjs` builds all eight canonical inputs and requires the
  resolver to report exactly 8 of 8; `tests/onboard-setup-progress.test.mjs` still covers the route's
  full item semantics.
- Live retest: PASS after restarting the same 5-of-8 DOCX workspace. The replacement turn stayed in
  the interview, presented the remaining Guardrails, Quick facts, and Work authorization proposals,
  and moved to “CareerRat is ready” only after every one was confirmed.

### `F-039` Plain-text résumé upload loses most of the résumé

- Status: `FIXED`
- Severity: P0, the advertised text résumé path accepts the document but reports zero facts saved,
  produces no role, company, or evidence seeds, and asks the candidate to rebuild information the
  same content extracts from PDF and DOCX.
- Reproduction: upload the real `morgan-hale-resume.txt` fixture in a clean home. The pane reaches
  only 2 of 8 with “0 facts saved”; identity partially fills, but location becomes
  “Brooklyn, New” and every work-history-derived group stays empty.
- Root cause: the UI routes text files to the limited deterministic parser while PDF and DOCX use
  the structured resume-extract skill. The location regex also tries the two-letter alternative
  before a full state/country name, truncating “New York.”
- Fix: text and Markdown file uploads now use the same structured extractor as PDF, while the
  deterministic endpoint remains available for pasted/manual fallback. Its location parser now
  preserves multiword state and country names.
- Regression: `apps/web/src/onboarding/InterviewSurface.test.jsx` requires text drops and picker
  uploads to call the structured extractor; `tests/onboard-route.test.mjs` covers text bytes,
  structured seeds, and saved originals; `tests/resume-parser.test.mjs` locks “Brooklyn, New York.”
- Live retest: PASS in a brand-new home with the real text fixture. Both columns showed the reading
  state, then six evidence claims, two role buckets, twelve companies, the full contact profile,
  and the full location appeared before Paul's first response. That response used the extracted
  staff backend, platform, payments, and remote targets.

### `F-040` Mobile product header clips the Library navigation item

- Status: `FIXED`
- Severity: P1, the last primary surface looks unavailable on a phone-sized window even though its
  link remains in the accessibility tree.
- Reproduction: open any product route at 390px. The header retains its desktop 64px height, its
  second navigation row overflows the header, and an unconditional fade masks most of “Library.”
- Root cause: the mobile grid added a second row without increasing header height, while the nav
  kept a max-content width, large gaps, and the desktop overflow mask.
- Fix: the mobile header now owns an 88px two-row height; all five items share the available width
  with compact spacing and no fade, while the utility controls stay on the first row.
- Regression: `tests/app-shell-style.test.mjs` locks the mobile header height, mask removal, and
  width-sharing navigation rules.
- Live retest: PASS at a real 390×844 viewport in dark and light themes. All five route labels and
  three utility controls are fully visible, the document has no horizontal overflow, and the nav's
  client width equals its scroll width.

### `F-041` Home dossier deep link crashes the entire app

- Status: `FIXED`
- Severity: P0, a featured Home action and direct Jobs URL replace the whole product with a blank
  screen.
- Reproduction: click “Open dossier” for Cyberdyne Systems or open
  `/app/jobs?open=demo-app-5`. React throws because the drawer receives typed learning objects. Once
  that exception is removed, the Home action still opens the general drawer and exposes raw
  Markdown instead of the required full-page dossier reader.
- Root cause: the dashboard adapter correctly emits `{label, note}` learnings, but `JobDrawer`
  treated every entry as a renderable string. Home also reused the generic `?open=` destination for
  both job actions and dossier actions.
- Fix: Signals & learnings now supports typed and legacy entries. Home uses a dedicated
  `?dossier=` deep link, Jobs mounts one full-page reader instead of the drawer, the API supplies
  safely escaped rendered HTML while preserving Markdown as source, and Close, backdrop, and Escape
  all return to Jobs.
- Regression: `apps/web/src/jobs/JobDrawer.test.jsx`, `InterviewDossierCard.test.jsx`,
  `JobsPage.test.jsx`, `apps/web/src/pages/DashboardPage.test.jsx`, and
  `tests/interview-dossier.test.mjs` cover the typed shape, route ownership, full-page dialog,
  rendered document, and API boundary.
- Live retest: PASS from Home after a production rebuild and server restart. The polished Cyberdyne
  packet opens over Jobs without a drawer or visible Markdown syntax; Escape closes it back to
  `/app/jobs`. The direct drawer URL still renders all four typed learning entries.

### `F-042` A fresh demo seed is trapped in onboarding with no demo candidate

- Status: `FIXED`
- Severity: P1, the canonical populated QA/sample command creates tracker data the app immediately
  hides behind an empty setup interview.
- Reproduction: run `careerrat data init --demo`, select a detected engine, then open Jobs. The app
  redirects to onboarding; `careerrat ingest --check` reports missing identity, roles, and résumé.
- Root cause: `seedDemo` pointed tracker import at `examples/demo-workspace`, but legacy candidate
  import reads only the active candidate directory. The fixture also had no source résumé and no
  tracked-company choice, so it could not satisfy the exact eight-item onboarding gate.
- Fix: demo initialization copies the fictional candidate fixture before the shared import path runs.
  The fixture now includes its evidence-backed source résumé and tracked-company shortlist. Engine
  selection remains a real per-machine choice; after it, the exact checklist is 8 of 8.
- Regression: `tests/db-export.test.mjs` requires the seeded Riley Chen candidate, search readiness,
  and exact onboarding completion when an engine is configured.
- Live retest: PASS in a fresh home. `careerrat ingest --check` returns `ok: true`, `/api/onboard/state`
  reports 8 of 8 after selecting Codex, and the direct Black Mesa Jobs drawer loads instead of
  redirecting to setup.

### `F-043` Escape closes both an artifact preview and its owning job drawer

- Status: `FIXED`
- Severity: P1, keyboard users lose their place in Jobs when dismissing the top layer.
- Reproduction: open a job drawer, open its JD preview, then press Escape once. Both dialogs close
  and the `?open=` deep link disappears instead of returning to the still-open job.
- Root cause: the full-page artifact viewer had no keyboard ownership. The drawer's document-level
  Escape handler received the event and closed the entire route-backed layer. A first capture-phase
  guard still allowed the drawer's listener on the same `document` target to run after React flushed
  the viewer close.
- Fix: the viewer now owns modal semantics, focus entry/restoration, Tab containment, and a
  capture-phase Escape handler that stops same-target listeners immediately. The drawer also ignores
  keyboard dismissal while its viewer is active.
- Regression: `apps/web/src/jobs/ArtifactViewerModal.test.jsx` covers viewer Escape and modal
- Live retest: PASS in both the Black Mesa partial-JD flow and generated-resume preview. The first
  Escape returns to the owning drawer with its `?open=` route intact; the second closes the drawer.

### `F-044` Submitted applications are sent backward to Evaluate

- Status: `FIXED`
- Severity: P0, the Jobs table replaces real waiting, follow-up, and interview actions with an
  impossible pre-application step for every imported application without a packet-gate record.
- Reproduction: seed the populated demo and open Jobs. Offer, Final, Onsite, Applied, and stale rows
  all say “Evaluate,” even though CareerRat requires evaluation before submission.
- Root cause: the client-side apply-ladder CTA checked the pre-applied status only for “Mark
  applied.” Its no-gate and document-generation branches ran for every nonterminal application.
- Fix: apply-ladder CTAs are now limited to `reviewed-hold`; submitted and later rows retain the
  action derived from their canonical pipeline, interview, follow-up, and communication state.
- Regression: `apps/web/src/jobs/useApplicationGates.test.js` covers no-gate applications at
  Applied, Screen, Interview, Offer, and Accepted.
- Live retest: PASS in a new demo home. E Corp shows “Open details · Waiting,” stale applications
  show “Open details,” and the upcoming Cyberdyne and Massive Dynamic rounds show “Open prep.”

### `F-045` Interview actions use the oldest completed round as their due date

- Status: `FIXED`
- Severity: P0, active interview rows show preparation overdue by weeks even when the next booked
  round is still ahead, while completed loops can keep a false Prep action indefinitely.
- Reproduction: open the demo Jobs table on August 14. Cyberdyne's August 16 final says “38d
  overdue,” and Massive Dynamic's August 19 panel says “10d overdue.”
- Root cause: the action builder selected the earliest date across `interviewAt`,
  `nextInterviewAt`, and every historical interview conversation. It also created Prep solely from
  a reached stage when no future booking existed.
- Fix: Prep actions now require an explicit future structured interview datetime and choose the
  earliest future value. Historical conversations remain history and cannot manufacture work.
- Regression: `tests/dashboard-data.test.mjs` combines an old recruiter screen with a future
  structured round and also covers a completed loop with no future booking.
- Live retest: PASS. Cyberdyne now shows “Open prep · in 2d,” Massive Dynamic shows “Open prep · in
  5d,” and E Corp's completed offer loop no longer exposes interview prep.

### `F-046` The bundled demo uses prose as application status

- Status: `FIXED`
- Severity: P1, the starter data displays a one-off pipeline rung, prevents terminal behavior, and
  teaches the wrong write shape on the product's main QA fixture.
- Reproduction: seed the demo and open Jobs. Aperture renders “WITHDREW — OFFER BELOW COMP FLOOR”
  as a live status with Evaluate, while Massive Dynamic stores `panel interview` instead of the
  canonical Onsite rung.
- Root cause: outcome detail and round labels were embedded in `status` instead of the typed
  `statusNote` and canonical status vocabulary.
- Fix: Aperture now stores `withdrawn` with the comp reason in `statusNote`; Massive Dynamic stores
  `onsite` with its panel note. Bundled analytics use the same canonical keys.
- Regression: `tests/db-export.test.mjs` rejects every noncanonical bundled application status.
- Live retest: PASS in a new seed. The funnel includes a real Withdrawn terminal and an
  Offer-to-Withdrawn flow, Massive Dynamic renders Onsite, and Aperture no longer appears active.

### `F-047` Same-company roles inherit another application's messages

- Status: `FIXED`
- Severity: P0, a job drawer can attribute application receipts and recruiter history from a
  different role to the current application.
- Reproduction: promote the Black Mesa Applied AI Engineer prospect, then inspect its drawer. The
  timeline claims Riley applied to Black Mesa's separate Research Engineer role and shows that
  role's receipt messages.
- Root cause: communication matching fell back to company and optional role even when a
  communication carried a different explicit `applicationId`. Missing `comm.role` made the foreign
  thread match every application at that company.
- Fix: an explicit `applicationId` is now authoritative. Company/role fallback is reserved for
  legacy communications that have no application id.
- Regression: `tests/dashboard-data.test.mjs` creates two same-company applications and ensures a
  linked receipt appears only on its owning role.
- Live retest: PASS after restarting the populated server. The promoted Applied AI Engineer drawer
  says there are no communication threads and contains none of the Research Engineer receipt
  timeline; the original Research Engineer retains its messages.

### `F-048` An unavailable full evaluation erases useful triage data

- Status: `FIXED`
- Severity: P0, evaluating a partial or unavailable JD replaces an honest approximate score and
  posted compensation with zero/unknown values, making the record less accurate after a failed gate.
- Reproduction: promote the partial Black Mesa Applied AI Engineer capture and click Evaluate. The
  table changes `~81` to `0.00`, clears its fit bucket and base, and labels the result Review.
- Root cause: the typed evaluation projection always persisted null fit and compensation fields,
  even when the result was a manual `MISSING_JOB_BODY` fallback rather than a completed evaluation.
- Fix: manual evaluations without a score persist the evaluation and recovery reason only. Existing
  triage fit, bucket, basis, base, and compensation estimate remain intact.
- Regression: `tests/packet-generate-route.test.mjs` evaluates a missing-JD application with saved
  triage and compensation state and requires every value to survive.
- Live retest: PASS. Black Mesa now keeps `~81`, its high bucket, `$200–235K`, and comparable range
  while the drawer honestly shows Review and the missing-full-JD reason.

### `F-049` The forbidden-wording gate treats JavaScript as Java

- Status: `FIXED`
- Severity: P0, ordinary evidence-backed document generation fails for the bundled candidate even
  after a KEEP evaluation.
- Reproduction: evaluate the complete E Corp role to KEEP, then generate documents. The request
  fails `PACKET_RESUME_ERROR` with `Artifact contains forbidden wording: "Java"` because the
  generated résumé truthfully says JavaScript.
- Root cause: honesty-boundary enforcement used raw case-insensitive substring matching. Short
  forbidden terms matched inside longer confirmed tools.
- Fix: forbidden wording now uses Unicode-aware term boundaries throughout artifact validation,
  proposal grounding, allowed-wording projection, and writing-voice hygiene. Exact Java still
  fails; JavaScript does not.
- Regression: `tests/documents-tailor.test.mjs` covers both sides, and the packet answer, engine,
  generate, and document suites exercise the shared matcher.
- Live retest: PASS. The E Corp packet generated an evidence-backed résumé and cover letter, showed
  both previews, deferred answers until form questions exist, and exported both PDFs.

### `F-050` Apply-on-site failure tells the user to restart CareerRat

- Status: `FIXED`
- Severity: P1, the correct fail-closed submission path looks like an unexplained local crash and
  invites a retry that cannot succeed without an executor.
- Reproduction: click Apply on site without an authenticated application executor. Status remains
  correct, but the drawer says only “Something went wrong on this computer” and offers Try again.
- Root cause: the client error translator had no rules for `APPLICATION_EXECUTOR_UNAVAILABLE` or
  `APPLICATION_NOT_VERIFIED`.
- Fix: both codes now explain that nothing was marked Applied and direct the candidate to use “I
  applied elsewhere” only after completing or confirming the site submission.
- Regression: `apps/web/src/lib/errorCopy.test.js` covers both typed failures.
- Live retest: PASS. The drawer says CareerRat cannot control the site in this session, confirms
  nothing was submitted, and the DB remains `reviewed-hold`. “I applied elsewhere” then records a
  user-reported Applied transition and clears both submission actions.

### `F-051` Network is a read-only card wall despite having relationship write APIs

- Status: `FIXED`
- Severity: P1, a core surface cannot search its records, review pending leads, or return to the
  job that owns a relationship.
- Reproduction: open the populated Network page. Seventeen people render with no search or state
  filter. Expand Sourcing; each review lead is inert even though the application CTA says to
  approve or reject it in Network. Open Angela Moss; the drawer shows one unordered company-wide
  note dump, no structured communication dates, and no link back to the E Corp job.
- Root cause: the reduced Network rebuild shipped only the presentation slice. It never connected
  the existing `/api/data/relationship/lead-status` transaction, and `buildNetwork()` discards
  owning-application and structured communication fields before the React page receives them.
- Fix: add company/person/role search, relationship-state filtering, an always-available capture
  handoff to Ask, accessible route-backed drawer behavior, structured dated history, and an owning
  Jobs link. Pending leads now call the existing atomic approve/reject domain verb with retryable
  human error copy and immediate snapshot refresh. The server keeps all companies and contacts in
  the searchable view instead of silently capping them at six companies and three people each.
- Regression: `apps/web/src/network/NetworkPage.test.jsx` covers search/filter semantics, real lead
  controls, modal semantics, history, and the owning-job link. `tests/dashboard-data.test.mjs`
  covers structured history, application ownership, and the absence of display caps.
- Live retest: PASS in the populated DB. Search narrowed Cyberdyne to exactly three people, state
  filters and zero-result copy worked, Capture relationship focused Ask, Angela's drawer restored
  focus and linked to `demo-app-1`, and two seeded review leads each wrote exactly once through
  Approve and Reject before disappearing from Sourcing. `careerrat data verify` remained clean.

### `F-052` Network approval duplicates people and rejection creates a relationship

- Status: `FIXED`
- Severity: P1, deciding a lead corrupts the meaning of the people list immediately after a
  successful write.
- Reproduction: approve Darlene Alderson and reject Vera Washington in Network. Darlene appears
  twice under two inferred types, Vera appears as a real contact despite rejection, and Angela and
  Tyrell duplicate when same-company roles infer a different type for the same person.
- Root cause: contact identity was keyed by `type + name`, so every changed role classification
  created a new person. The application audit conversations written for both approved and rejected
  decisions were also ingested as relationship evidence. Company notes/history were not scoped to
  the primary owning application.
- Fix: key contacts by normalized human name, recognize Referral as a first-class contact type,
  treat lead-decision conversations as audit history only, add approved contacts only from the
  approved lead record, and scope drawer history/notes to the owning application id.
- Regression: `tests/dashboard-data.test.mjs` covers same-person role changes, rejected-lead audit
  conversations, approved contacts beyond the old cap, and same-company history/note isolation.
- Live retest: PASS after the approve/reject writes. Network has one Darlene Referral, no Vera,
  no duplicate Angela or Tyrell, and Angela's drawer contains neither the other E Corp role's new
  hiring-manager note nor either lead-decision audit note.

### `F-053` Evergreen demo dates disagree with dates inside their own prose

- Status: `FIXED`
- Severity: P1, the canonical populated QA fixture presents an impossible timeline and makes live
  product behavior look untrustworthy.
- Reproduction: seed the demo on August 14 and open Angela Moss's communication history. A row dated
  August 13 says the candidate will respond by June 29; an August 8 offer says it expires June 30;
  July messages still claim an onsite is confirmed for June 10.
- Root cause: demo rebasing shifts only strings that are entirely an ISO date or datetime. Embedded
  ISO tokens and ordinary month/day phrases inside summaries, subjects, notes, and dossiers remain
  anchored to June while their structured sibling timestamps move forward.
- Fix: the demo-only rebaser now shifts unambiguous embedded ISO dates and English month/day
  phrases along with exact structured timestamps, preserving ISO, short-month, and long-month
  formatting. Activity import receives the original demo anchor so its prose follows the same
  delta. Ambiguous numeric fragments remain untouched.
- Regression: `tests/rebase-dates.test.mjs` covers structured values, embedded ISO tokens, short
  and long month names, implicit-year selection, and activity-log rebasing; the full DB export
  suite still passes.
- Live retest: PASS in a newly seeded August 14 home. Angela's August 13 reply now says August 17,
  the August 8 offer expires August 18, the July 29 onsite subjects and summaries agree with their
  row dates, and the original Thursday date remains a Thursday after shifting.

### `F-054` Library invents dozens of documents from prose summaries

- Status: `FIXED`
- Severity: P1, the external document library claims nonexistent résumés and cover letters are
  available, then routes them to preview paths that cannot resolve.
- Reproduction: open Library → External in the populated workspace. It reports 99 documents and
  lists a résumé and cover letter for almost every demo job. Most `artifacts.resume` and
  `artifacts.coverLetter` values are tailoring summaries, not paths; “Technical details” exposes
  those paragraphs as though they were filenames.
- Root cause: the old demo fixture stored descriptive copy in path-owned artifact fields, and the
  dashboard adapter accepted every nonempty string as a workspace artifact path.
- Fix: artifact discovery now accepts only newline-free, traversal-free paths rooted in
  `workspace/`. The bundled demo no longer stores tailoring prose in path-owned artifact fields.
- Regression: `tests/dashboard-data.test.mjs` proves prose summaries never become Library
  documents, and `tests/db-export.test.mjs` proves the bundled demo carries no invalid document
  paths. Both targeted suites pass.
- Live retest: Library now reports 41 real documents instead of 99. The Résumés filter returns one
  generated résumé, and “Open job” routes it to `/app/jobs?open=qa-keep-e-corp`.

### `F-055` Library detail drawer lets keyboard focus escape

- Status: `FIXED`
- Severity: P1, the primary edit and removal surface was presented as a dialog but did not identify
  itself as modal, take focus, contain Tab navigation, or restore the opener after closing.
- Reproduction: open any Library card, then navigate with Tab or inspect focus. Focus remains behind
  the drawer and can leave it while the modal is open.
- Root cause: `LibraryDrawer` only listened for Escape and omitted the focus lifecycle used by the
  Jobs and Network drawers.
- Fix: the drawer now takes focus, declares `aria-modal`, traps forward and reverse Tab navigation,
  closes on Escape, and restores the previously focused element.
- Regression: `LibraryPage.test.jsx` covers modal semantics and Tab wrapping; all 22 tests pass.
- Live retest: focus lands on “Library card detail,” and Tab from the final Remove button wraps to
  the drawer Close button.

### `F-056` A failed Library save hides the user's unsaved correction

- Status: `FIXED`
- Severity: P1, a transient API failure exited edit mode immediately; reopening Edit rebuilt values
  from server state and discarded the user's correction.
- Reproduction: edit a Library evidence claim, make its save request fail, then inspect the drawer.
  It returns to read mode even though nothing persisted.
- Root cause: Save called the asynchronous writer without awaiting its result, then unconditionally
  set `editing` false. The shared write wrapper did not report success or failure.
- Fix: Library writes now return a success boolean, and Save leaves the form and its local values
  open until the mutation and refetch both succeed.
- Regression: `LibraryPage.test.jsx` rejects the evidence write and proves the attempted value,
  Save control, and inline error all remain visible.
- Live retest: the successful path updated the disposable claim from 25% to 37%, survived the server
  round trip, exited edit mode only after success, and the confirmed removal deleted exactly that row.

### `F-057` Library confirmation and provenance are implicit

- Status: `FIXED`
- Severity: P1, candidates could not tell whether a displayed fact was confirmed or where it came
  from without deciphering a source token appended to reusable prose.
- Reproduction: open an Internal Library card. The drawer only shows the derived text and tags;
  source data, when present, is embedded inside the “Reusable text” paragraph.
- Root cause: the snapshot carried `sourceRef`, but the drawer had no typed status or provenance
  presentation.
- Fix: every drawer now shows a structured Status and Source list. Persisted items say Confirmed,
  sourced items expose their source reference, and profile-derived compatibility material is labeled
  honestly. Long references wrap safely.
- Regression: `LibraryPage.test.jsx` covers the confirmed label and exact source reference.
- Live retest: the disposable claim displayed “Confirmed” and source `qa-library-live-pass` before
  its edit/removal round trip.

### `F-058` Empty Deep Ingest exit falsely reads like completed work

- Status: `FIXED`
- Severity: P1, an average user who had nothing to add was sent to a success screen saying confirmed
  material now feeds future documents even though all seven lanes remained untouched.
- Reproduction: open Deep Ingest with no sources and click Continue. Step 7 says “That's the deep
  stuff” and uses the success payoff while every count is zero and readiness remains 0 of 7.
- Root cause: the intentional no-material exit reused the same static Done heading/payoff as a
  completed review and marked Material filled based only on navigation position.
- Fix: the empty exit now says “Deep dive paused,” states that nothing was marked complete, shows the
  exact incomplete lane count, and does not mark Material finished without source work or a terminal
  source-coverage decision.
- Regression: `DeepIngestPage.test.jsx` covers the zero-source Continue path and its progress rail.
- Live retest: the no-material exit now says “0 of 7 lanes finished. Deep ingest is still
  incomplete” and never claims that confirmed material exists.

### `F-059` Deep Ingest cannot complete two of its seven required lanes

- Status: `FIXED`
- Severity: P0, a user could confirm every draft the UI exposes and still end at 5 of 7 forever.
- Reproduction: add a source, draft and confirm Evidence, Stories, Honesty, Voice, and Role signals,
  then reach Done. `source_coverage` and `open_gaps` remain `not_started`, with no control for either.
  A source producing only a grounded gap also keeps offering Draft proposals instead of advancing.
- Root cause: the seven-step redesign visually collapsed source coverage into Material and gap review
  into Done, but never wired those two steps to the corresponding durable lane-state API.
- Fix: adding material reopens source and gap readiness; Continue from fully drafted Material records
  source coverage; grounded gap-only results count as drafted; and Done exposes an explicit finish
  action that completes an empty gap lane or defers visible gaps with a durable reason. Existing
  5-of-7 sessions recover through the same controls.
- Regression: 17 Deep Ingest web tests cover source coverage, empty exit, gap-only results, clean
  completion, and finish-with-gaps. The 17-test DB suite covers source creation reopening previously
  terminal coverage/gap state.
- Live retest: the full pasted-source run produced and confirmed 1 evidence claim, 1 story, 2 honesty
  boundaries, 1 voice rule, and 2 role signals. Material advanced readiness to 6 of 7; “Finish Deep
  ingest” advanced it to 7 of 7 with `ready: true` and an empty missing-lane list.

### `F-060` Library hides filters for confirmed honesty and role-signal cards

- Status: `FIXED`
- Severity: P1, confirmed material appeared in All but could not be isolated using the advertised
  type filters.
- Reproduction: confirm Deep Ingest honesty and role-signal proposals, then open Library. The cards
  render, but the toolbar only offers All, Evidence, Stories, and Voice.
- Root cause: the dashboard adapter dropped `voice`, `honesty`, and `roleSignals` metrics, while the
  client used those stripped metrics, not actual card kinds, to decide whether to expose filters.
- Fix: the adapter preserves every typed Library metric/readiness count, and the client also derives
  deep-ingest filter availability from the confirmed card kinds as a defensive fallback.
- Regression: `LibraryPage.test.jsx` covers card-kind-driven filters; `dashboard-data.test.mjs`
  covers all typed metrics and readiness fields.
- Live retest: the completed 12-card bank now exposes All, Evidence, Stories, Voice, Honesty, and
  Role signal filters.

### `F-061` Search sources are deleted on the first click

- Status: `FIXED`
- Severity: P1, an accidental click permanently removes a search or company board with no warning
  or undo path.
- Reproduction: open Settings, scroll to any configured source, and click Remove once. The source is
  immediately deleted from durable configuration.
- Root cause: both Remove buttons called the mutation API directly. The settings surface had no
  armed-removal state even though these rows determine where every later search runs.
- Fix: the first click now arms that exact row and exposes Confirm remove plus Cancel. Only the
  second explicit click calls the delete API; a successful deletion clears the armed state.
- Regression: `SourceMaintenance.test.jsx` covers the armed confirmation and cancellation controls.
- Live retest: a disposable saved query remained in the API after the first click, Cancel restored
  the ordinary controls, and the later two-click confirmation removed exactly that query.

### `F-062` Settings exposes internal source and platform identifiers

- Status: `FIXED`
- Severity: P2, identifiers such as `RemoteVibeCodingJobs`, `Remoteok`, `Workingnomads`,
  `Url-Query`, and `Linkedin` make a candidate-facing settings screen look unfinished.
- Reproduction: open Settings in the populated workspace and inspect source metadata or Advanced
  automation platform names.
- Root cause: source and automation views applied generic capitalization to storage identifiers
  instead of using product labels for known providers, source types, and brands.
- Fix: normalize provider identifiers case-insensitively and render explicit labels for Remote Vibe
  Coding Jobs, RemoteOK, Working Nomads, URL query, LinkedIn, and calendar brands.
- Regression: `SourceMaintenance.test.jsx` covers raw provider/type suppression, and the existing
  Automation controls suite remains green.
- Live retest: all populated source rows and every Advanced permission row now use the expected
  product and brand labels; no `Linkedin` platform label remains.

### `F-063` Unsupported company-board URLs produce a generic computer error

- Status: `FIXED`
- Severity: P1, a normal validation mistake tells the candidate something is wrong with their
  computer and offers a pointless retry instead of explaining what URL is accepted.
- Reproduction: add `https://example.com/jobs` as a company ATS board. The server correctly rejects
  it, but the UI says only to retry or restart CareerRat.
- Root cause: the shared error-copy layer had no rule for the board route's `unsupported ATS host`
  response, so the 400 fell into the unknown-error bucket.
- Fix: translate that response to a direct supported-board explanation while preserving the raw
  server message only inside Technical details. The rejected form values remain available to edit.
- Regression: `errorCopy.test.js` covers the exact API response and confirms it has no retry action.
- Live retest: the same invalid URL now explains that a Greenhouse, Lever, Ashby, or Workday board
  is required, keeps both inputs intact, and writes no company source.

### `F-064` Operational docs still promise a retired Classic dashboard

- Status: `FIXED`
- Severity: P1, the roadmap, setup docs, agent router, and writing skills instructed people and
  agents to publish or open `workspace/tracker.html`, even though that output no longer exists.
- Reproduction: run `careerrat tracker`; it correctly creates a JSON recovery snapshot and summary,
  but README and the write-back contract call it a static-dashboard renderer. The roadmap also says
  a Classic link remains reachable even though `/app` intentionally removed it.
- Root cause: Phase 6 retired the static HTML product and its route, but the later roadmap and
  operational prose were not reconciled with the shipped one-dashboard architecture.
- Fix: make the React app the explicit sole dashboard, describe `careerrat tracker` as the recovery
  snapshot checkpoint, update the write contracts and affected skills, and remove Classic from the
  active roadmap. Historical planning records remain historical.
- Regression: `tests/static-dashboard-retirement.test.mjs` scans the public operational docs,
  roadmap, agent router, and every shipped skill for the retired artifact contract.
- Live retest: `/` redirects to `/app`, `/tracker` returns 404, product navigation contains no
  Classic link, and `careerrat tracker` creates or deduplicates a JSON snapshot without claiming to
  publish HTML.

### `F-065` `careerrat tracker --json` emits invalid JSON

- Status: `FIXED`
- Severity: P1, scripts and agents cannot parse the command's advertised machine-readable output.
- Reproduction: run `careerrat tracker --json`. The first line is the human message `Snapshot:
  skipped (unchanged)`, followed by a JSON object, so `JSON.parse` and `jq` fail immediately.
- Root cause: the snapshot status was printed before the command branched into its JSON response.
- Fix: suppress human status/warnings in JSON mode and represent a thrown snapshot failure inside
  the returned `snapshot` object instead.
- Regression: `tests/tracker-cli.test.mjs` launches the real CLI in an isolated home and parses its
  entire stdout as one JSON document.
- Live retest: the populated QA home now pipes directly through `jq` and reports the snapshot result
  plus the correct post-demo-strip application count.

### `F-066` Website install and runtime claims disagree with the package

- Status: `FIXED`
- Severity: P1, the public install surface tells users Node 18 is sufficient even though npm enforces
  Node 24, and advertises any CLI on PATH even though the in-app runtime has an explicit supported
  adapter registry.
- Reproduction: compare the built website prerequisites and hero/runtime section with
  `package.json#engines` and `INSTALLED_RUNTIME_DEFINITIONS`.
- Root cause: the website copy did not move with the Node 24 release and broadened the supported CLI
  claim beyond what runtime selection can safely execute. It also claimed zero runtime dependencies
  despite shipping normal npm dependencies.
- Fix: require Node 24 consistently, name representative supported runtimes, describe the remainder
  as other supported CLIs, and replace the dependency claim with the factual no-hosted-backend claim.
  Related docs now say the CLI serves the app and snapshots tracker state.
- Regression: `tests/website-copy.test.mjs` compares website/docs requirements to the package engine
  and rejects the stale or overbroad phrases.
- Live retest: the rebuilt website and docs both expose Node 24, supported-runtime wording, and the
  current one-dashboard behavior.

### `F-067` Public setup and data docs describe the retired product model

- Status: `FIXED`
- Severity: P1, a new user was told to choose implementation modes, treat `candidate/` files as
  canonical, and think the app could not write even though the shipped setup and SQLite app work
  differently.
- Reproduction: compare `docs/SETUP.md` and the published Getting Started, Dashboard, Data Model,
  Agent Contract, and Applying pages with the app onboarding and database write routes.
- Root cause: the app and data layer moved to conversation-first setup and canonical SQLite writes,
  but the public guides retained the earlier Basic/Advanced, Deep/Shallow, read-only, and static
  publish contracts.
- Fix: describe one adaptive setup conversation with capability-on-demand prompts, identify SQLite
  as canonical, identify candidate/tracker files as compatibility exports, and document the app's
  supported write actions. Privacy copy now distinguishes local storage from context sent through
  the selected AI runtime under its provider's terms.
- Regression: `tests/release-safety.test.mjs`, `tests/static-dashboard-retirement.test.mjs`, and
  `tests/website-copy.test.mjs` scan the public setup, runtime, data, and privacy contracts.
- Live retest: the rebuilt integrated docs at `/docs/` use the current app and database model, contain
  no Classic artifact path or mode menu, and load at desktop and 390px with zero console errors.

### `F-068` The npm package tries to install repository Git hooks for consumers

- Status: `FIXED`
- Severity: P1, a global install ran the source-maintainer `prepare` lifecycle and attempted to
  configure Lefthook inside an npm consumer environment.
- Reproduction: install a packed CareerRat tarball in a clean directory. npm reports both the
  intended skill postinstall and the repository-only `prepare` lifecycle.
- Root cause: hook installation was attached to npm's automatic `prepare` script instead of an
  explicit contributor setup command.
- Fix: remove the automatic lifecycle and expose `npm run hooks:install` for source checkouts. The
  source setup docs include the explicit step.
- Regression: `tests/release-safety.test.mjs` rejects a package `prepare` lifecycle and requires the
  explicit hook script.
- Live retest: a clean packed install runs without attempting repository hook configuration; the
  installed CLI still starts a fresh home and finds its shipped runtime assets.

### `F-069` Desktop packaging reports success for an unnotarized DMG

- Status: `FIXED`
- Severity: P0, the release command exited zero even though Gatekeeper rejected the pilot artifact.
- Reproduction: run `npm run desktop:dist` without Apple notarization credentials. electron-builder
  signs the app, skips notarization, writes a DMG, and previously returned success.
- Root cause: `notarize: true` asks electron-builder to notarize when credentials exist but does not
  make missing notarization configuration fatal.
- Fix: the release command now runs deterministic app-signature, stapled-ticket, and Gatekeeper
  checks after packaging and exits nonzero on any failure. `dist:local` remains available for a
  local QA artifact; `dist` is the release gate.
- Regression: `tests/desktop-runtime.test.mjs` covers pass/fail verification and
  `tests/desktop-package-resources.test.mjs` requires release verification after packaging.
- Live retest: the verifier rejected the original signed-only artifact, then passed the rebuilt
  signed, notarized, stapled, and Gatekeeper-approved artifact after `F-070` was fixed.

### `F-070` Desktop release omitted DMG container notarization

- Status: `FIXED`
- Severity: P0 release blocker, macOS Gatekeeper will reject the current DMG outside this development
  machine.
- Reproduction: `xcrun stapler validate apps/desktop/dist/CareerRat-0.4.0-arm64.dmg` reports no
  ticket, and `spctl --assess --type open --context context:primary-signature` rejects it.
- Root cause: the previously validated `careerrat-notary` Keychain item had been removed even though
  its API key remained in the local signing bundle. After restoring it, electron-builder correctly
  notarized the app bundle but still built the DMG container afterward without signing, submitting,
  or stapling it.
- Fix: restore the existing API key as the `careerrat-notary` Keychain profile and add an explicit
  `release:dmg` stage. The stage derives the Developer ID authority from the signed app, signs the
  DMG, submits it using the configured Keychain/API-key/Apple-ID credential path, waits for Apple,
  and staples the accepted ticket before the hard release verifier runs.
- Regression: `tests/desktop-dmg-release.test.mjs` covers credential resolution, signing identity
  parsing, step order, and fail-fast behavior. `tests/desktop-package-resources.test.mjs` requires
  `dist:local -> release:dmg -> verify:release` ordering.
- Live retest: `APPLE_KEYCHAIN_PROFILE=careerrat-notary npm run desktop:dist` completed end to end
  for `CareerRat-0.7.0-arm64.dmg`. Apple accepted app submission
  `a7c35703-beb2-4ead-a1d4-04f957f3c244` and DMG submission
  `1c18d46d-f3f0-4de3-8776-512fc8f5ed75`; app signature, stapler validation, Gatekeeper, and
  fresh, existing-data, and demo packaged smokes all pass from the mounted read-only DMG. The
  packaged data layer reached schema version 10, wrote SQLite and a mode-0600 BYOK file only under
  the isolated `CAREERRAT_HOME`, and left signed resources unchanged. Final DMG: 221,908,253 bytes,
  SHA-256 `8a78f1a353e246046dd73713bf0a860969f6e8c9bab56069723b0abe177e976d`.

### `F-071` Static website and docs builds emit avoidable browser console errors

- Status: `FIXED`
- Severity: P1, clean local acceptance showed an ignored CSP directive on every page and a missing
  Vercel Analytics asset on non-Vercel static builds.
- Reproduction: serve `apps/website/out`, open the homepage, and inspect the console. Chromium warns
  that `frame-ancestors` is ignored in a meta policy and requests an unavailable
  `/_vercel/insights/script.js`.
- Root cause: static HTML hardening copied an HTTP-header-only directive into the meta CSP, while the
  analytics component rendered even when the build had no Vercel runtime.
- Fix: keep `frame-ancestors 'none'` in the deployment/security header but omit it from meta CSP, and
  include Vercel Analytics only in a Vercel build.
- Regression: `tests/static-html-security.test.mjs` separates header and meta requirements;
  `tests/website-copy.test.mjs` requires the Vercel build gate.
- Live retest: the rebuilt homepage and integrated `/docs/` load with zero browser console errors.

### `F-072` Mobile website puts the product preview before the value proposition

- Status: `FIXED`
- Severity: P1, a phone visitor saw a large dashboard image before the headline or explanation and
  had to scroll to learn what CareerRat is.
- Reproduction: open the marketing homepage at 390 by 844. A mobile-only CSS order moved the preview
  ahead of the DOM-first hero copy.
- Root cause: `.hero-visual { order: -1; }` reversed the useful semantic order only on small screens.
- Fix: retain the source order at every breakpoint so the pitch and calls to action lead, followed by
  the product preview.
- Regression: `tests/website-copy.test.mjs` rejects a mobile negative order on the hero preview.
- Live retest: the 390px production export has no horizontal overflow, the headline leads visually,
  and the page reports zero console errors.

### `F-073` Release security scan found unsafe input-handling patterns

- Status: `FIXED`
- Severity: P0 release blocker, CodeQL reported production paths with unsafe HTML stripping,
  profile-link protocols, route dispatch, glob conversion, token handling, and nonlinear slug
  regular expressions.
- Reproduction: run the pull request's JavaScript/TypeScript CodeQL analysis on the release head;
  the gate originally reported 57 alerts, including 14 in runtime code and 43 in test harnesses.
- Root cause: several mature input paths still used regex-based HTML parsing or dynamically selected
  methods, and repeated test helpers reproduced the same patterns across route coverage.
- Fix: use parser-backed HTML text extraction, allow only HTTP(S) profile links, dispatch fixed route
  methods explicitly, compile single-star globs without regex construction, compare API tokens by
  HMAC-derived identifiers, trim slug edges with linear scans, and route test HTML/assertion helpers
  through the same safe primitives.
- Regression: `tests/security-regressions.test.mjs`, `apps/web/src/onboarding/FilePane.test.jsx`, and
  the existing route/parser suites cover malicious protocols, entity handling, glob literals,
  dispatch behavior, token mismatch, and long slug inputs.
- Live retest: exact-head CodeQL completed with zero alerts; the root suite passed 2,363 tests with
  five skips and zero failures, and the web suite passed all 647 tests.

### `F-074` macOS window controls covered the onboarding logo

- Status: `FIXED`
- Severity: P1, the first-run desktop header rendered the native close, minimize, and fullscreen
  controls on top of the CareerRat wordmark.
- Reproduction: launch the macOS Electron app into chat-first onboarding. Its header started at a
  32px left inset while the custom title bar placed the traffic-light controls in the same space.
- Root cause: the chat-first onboarding surface introduced a third product header without the
  92px macOS-safe inset and drag/no-drag rules already used by the other desktop headers.
- Fix: give the chat-first onboarding header the established macOS-safe left inset, make its empty
  space draggable, and keep links and buttons interactive with an explicit no-drag rule.
- Regression: `tests/app-shell-style.test.mjs` pins the safe inset and complete title-bar contract.
- Live retest: PASS in a 1280x860 CareerRat Electron window. All three native controls render left
  of the wordmark with clear separation, and the header action remains interactive.

### `F-075` Completed onboarding can land on Jobs with no search sources

- Status: `FIXED`
- Severity: P0 release blocker, a first-time candidate can finish Paul's interview and immediately
  see "No search sources set up yet" instead of a working search.
- Reproduction: complete onboarding in a clean npm home without manually adding a tracked company
  or board, then open Jobs.
- Root cause: historical graduation treated interview completion and usable source/search state as
  separate concerns.
- Fix: start deterministic source generation and the first search as soon as minimum
  search readiness exists. Keep setup gated unless sources are durable and that search is running
  or complete; otherwise expose retry, guided repair, and durable pause/resume.
- Regression: the onboarding graduation and background-sourcing route/surface suites.
- Live retest: a clean packed npm install started four deterministic sources at 4 of 8 while Paul
  continued interviewing, scanned 269 postings, saved two qualified roles, and opened Jobs without
  the no-sources banner. After a full server restart, setup still opened as ready and Jobs still
  showed the same two-role review queue with zero HTTP or console errors.

### `F-076` Résumé extraction invents company targeting

- Status: `FIXED`
- Severity: P1, uploading a résumé can silently turn former employers into target companies and
  skip Paul's actual company-thesis question.
- Reproduction: upload a résumé containing employer names in a fresh setup and inspect Company
  focus before answering any company-preference question.
- Root cause: the extraction schema allowed target-company suggestions from employment history.
- Fix: résumé extraction now seeds role and keep signals only. Named employers and company thesis
  remain empty until the candidate states them.
- Regression: résumé extraction, onboarding route, and InterviewSurface suites.
- Live retest: the clean packed install remained at 4 of 8 after upload, showed no tracked companies
  or company preferences, and Paul asked the open company-thesis question.

### `F-077` Setup failures cannot be paused and resumed safely

- Status: `FIXED`
- Severity: P0 release blocker, a runtime or source failure can strand a non-technical user with no
  durable way to stop and continue.
- Reproduction: fail the onboarding chat start after entering a message, then close and reopen setup.
- Root cause: the interview surface showed retry copy but persisted neither the pause reason nor the
  failed turn.
- Fix: persist the failed user turn and an `interviewPause` checkpoint, disable streaming while
  paused, and expose Pause setup plus Resume setup with exact progress and transcript restoration.
- Regression: InterviewSurface, onboarding state, and chat route suites.
- Live retest: an aborted start was paused, the app was closed and reopened, and Resume restored the
  exact transcript and populated notes pane with no HTTP or console errors.

### `F-078` Paul can claim notice period is saved under an invalid field

- Status: `FIXED`
- Severity: P0 release blocker, Paul can tell the candidate setup is complete while emitting
  `form-defaults.notice_period`, which the schema rejects and never saves.
- Reproduction: answer Paul's notice-period question on the completion boundary of a clean setup.
- Root cause: the skill asked for an unsupported earliest-start value and did not pin notice period
  to `profile.authorization.notice_period`; completion copy could also outrun the write confirmation.
- Fix: use the supported profile path, stop collecting earliest start during initial
  setup, and prohibit saved/noted claims without canonical state or a same-response confirmation.
- Regression: chat-runtime and release-safety suites.
- Live retest: in the complete clean packed-install interview, Paul's final response exposed a
  reviewable Notice period confirmation, saved `profile.authorization.notice_period` as `2 weeks`,
  asked no earliest-start follow-up, and then reached CareerRat is ready.

### `F-079` Arrangement-specific compensation floors do not satisfy setup readiness

- Status: `FIXED`
- Severity: P0 release blocker, Paul can correctly save remote and hybrid floors but Quick facts and
  `gate_ready` remain incomplete because they check only the obsolete flat fallback.
- Reproduction: save positive `comp_floors.remote` and `comp_floors.hybrid` without `minimum_base`.
- Root cause: onboarding progress and SQLite readiness drifted from the evaluation gate, which
  already understands arrangement-specific floors.
- Fix: share compensation-floor readiness semantics across setup and candidate state, and
  render the actual per-arrangement floors in Paul's notes.
- Regression: setup progress, candidate DB verbs, and onboarding view-model suites.
- Live retest: after the clean interview, the packed app's live API removed the flat fallback while
  retaining remote and hybrid floors. Quick facts remained complete at 8 of 8 across restart, and
  the disclosure rendered `Remote $175K floor · Hybrid $190K floor` with zero HTTP or console errors.

### `F-080` Ask result links leave the mounted app router

- Status: `FIXED`
- Severity: P1, a successful job rating's Review action navigates from `/app/jobs` to the unmounted
  `/jobs` URL and loses the drawer.
- Reproduction: open a saved job, ask "Can you rate this job?", then click Review this job or Review
  why this was cut in the typed result.
- Root cause: workspace actions correctly carried router-relative `/jobs?...` paths, but Ask rendered
  them as raw anchors without applying the product's `/app` mount point.
- Fix: normalize trusted internal action paths through the mounted app prefix and suppress non-local
  href values from that action slot.
- Regression: `AskBar.test.jsx` pins the resulting `/app/jobs?...` URL.
- Live retest: the packed app rated the open job, followed Review this job without leaving CareerRat,
  kept the drawer open, and accepted the contextual "Apply to this job" follow-up.

### `F-081` Empty interview dossiers log expected 404s as browser errors

- Status: `FIXED`
- Severity: P1, opening an ordinary application drawer before interview prep exists logs a 404 and
  red console error even though the UI treats the missing dossier as normal.
- Reproduction: open any newly evaluated application and inspect the interview-prep request and
  browser console.
- Root cause: the optional read API encoded "not built yet" as an HTTP error and relied on the card
  to catch it.
- Fix: return a console-clean 200 with `state: "missing"` and `dossier: null`; retain client handling
  for legacy 404 responses.
- Regression: interview dossier route and card suites cover both the new missing state and legacy
  compatibility.
- Live retest: the packed rate/apply flow opened and refreshed the drawer repeatedly with no 4xx
  responses or console errors.

### `F-082` npm blocks CareerRat's redundant consumer postinstall

- Status: `FIXED`
- Severity: P1, npm 11 warns that CareerRat has an unapproved install script and skips the skill
  shim during an otherwise successful first install.
- Reproduction: install the packed package into a clean npm consumer with current npm defaults.
- Root cause: skill installation ran both as a package lifecycle hook and inside `careerrat start`;
  the lifecycle copy now requires consumer approval and was unnecessary.
- Fix: remove the consumer postinstall entirely and keep the explicit, idempotent skill installation
  in `careerrat start` and `careerrat install-skills`.
- Regression: release-safety coverage requires no prepare/postinstall lifecycle and verifies the
  start launcher still invokes the installer.
- Live retest: a brand-new packed install completed with no allow-scripts warning. Running
  `careerrat start --no-agent --no-dashboard` then installed all 27 skills and seeded the isolated
  workspace successfully.

### `F-083` Vercel builds depend on live Google font downloads

- Status: `FIXED`
- Severity: P0 release blocker, the public website preview fails even though local builds pass.
- Reproduction: deploy the PR through Vercel after Google retires one of Next.js's generated
  Archivo asset URLs.
- Root cause: the website and docs used `next/font/google`, which still fetches font files during
  each production build. The resulting site is self-hosted, but the build itself is network-coupled.
- Fix: load the required Archivo and IBM Plex files from pinned local npm font packages through
  `next/font/local`, so neither site contacts Google during a build.
- Regression: `tests/website-copy.test.mjs` rejects Google font imports and remote font hosts on
  both deployed surfaces.
- Live retest: the complete Vercel-mode docs-plus-website production build passed locally without
  any remote font request; the updated PR preview is the external acceptance check.

### `F-084` Ask trusts arbitrary server-provided internal result links

- Status: `FIXED`
- Severity: P0 release blocker, CodeQL identified a high-severity path from durable workspace text
  into an anchor URL on the Ask result surface.
- Reproduction: return a crafted `metadata.nextActions[].href` from the workspace thread and render
  the completed Ask turn.
- Root cause: the client rejected obvious absolute and protocol-relative URLs, but still accepted
  every root-relative path and query value as an anchor destination.
- Fix: parse result URLs against a fixed non-routable origin, allow only the supported Jobs drawer
  route with exactly one `open` application ID, validate that ID, and rebuild the mounted URL from
  a literal route plus an encoded value. Everything else renders no link.
- Regression: `AskBar.test.jsx` covers the valid mounted route, an injected query value, and a
  `javascript:` scheme.
- Live retest: focused Ask coverage and the complete web suite pass; exact-head CodeQL is the
  external acceptance check.

### `F-085` Live-reload acceptance writes byte-identical tracker state

- Status: `FIXED`
- Severity: P1 release blocker, the full release suite can time out even though tracker live reload
  works because the acceptance test relies on a filesystem event for a byte-identical overwrite.
- Reproduction: run the complete repository suite under load; the isolated SSE test passes while
  the parallel suite can coalesce the no-op write and miss `tracker-update`.
- Root cause: the test rewrote `tracker.json` with exactly the bytes already on disk. Filesystem
  watchers do not promise a distinct notification for a no-op state rewrite.
- Fix: mutate the tracker version after the SSE connection is ready, matching the real product
  contract where tracker-visible writes change durable state.
- Regression: the focused SSE test passes 50 consecutive runs before the full release suite.
- Live retest: PASS in the complete 0.7.1 release suite: 2,487 repository tests passed with five
  intentional skips, including the watcher assertion under full parallel load.

### `F-086` Pasted-job provenance renders as a fake external posting link

- Status: `FIXED`
- Severity: P1 product-coherence blocker, a job created from pasted or extracted JD text opened a
  drawer with a `View posting` link backed by the internal `careerrat://intake/...` locator.
- Reproduction: paste and confirm a new JD in Ask, follow the evaluation result to the saved job,
  and inspect the drawer header.
- Root cause: sourced persistence requires a stable locator while the row is created, and promotion
  copied that internal locator into the application `link` field. The drawer also trusted any
  non-empty `drawer.link` instead of applying the existing external-HTTP URL guard.
- Fix: clear the synthetic link after promotion, persist `sourceIntakeId` as typed provenance, keep
  the full JD artifact, and allow the drawer's `View posting` action only for real HTTP(S) URLs.
- Regression: `workspace-agent.test.mjs` pins null external link plus durable intake provenance;
  `JobDrawer.test.jsx` pins real HTTP links and rejects internal locator schemes.
- Live retest: a fresh confirmed Nova Forge JD saved `link:null`, the matching intake provenance,
  and a readable `workspace/jobs/...md` artifact. The earlier internal-link row also rendered no
  `View posting` action after the client hardening.

### `F-087` Ambiguous Ask job references collapse into a generic computer error

- Status: `FIXED`
- Severity: P1 workflow blocker, Paul correctly refused to guess between saved jobs but did not tell
  the user which roles matched or how to clarify.
- Reproduction: enter `rate the Aperture Science role` when two Aperture Science jobs are saved.
- Root cause: the executor returned `JOB_REFERENCE_AMBIGUOUS`, but the HTTP response exposed no
  structured match list and Ask mapped every rejected action request to the generic retry error.
- Fix: return bounded company/role match labels as structured error details, translate that code to
  candidate-safe clarification copy, and suppress blind retry when the input itself needs revision.
- Regression: workspace route, error-copy, and Ask tests cover structured labels, safe rendering,
  and the absence of a useless retry button.
- Live retest: Ask named `Forward Deployed Engineer` and `Research Engineer, Enrichment Systems`,
  asked for a more specific company and role, and did not choose or mutate either job.

### `F-088` An old local server survives an update and serves retired onboarding behavior

- Status: `FIXED`
- Severity: P0 release blocker, the code and installed package can be current while the default
  localhost app continues running an older CareerRat release from memory.
- Reproduction: leave a 0.7.0 `tracker-dev` process running on port 7777, update the checkout or
  package to 0.7.1, and reopen the existing app URL. The old Jobs page can still show "No search
  sources set up yet" even though that dead end no longer exists in current source.
- Evidence: on 2026-08-14 the default server process had started on 2026-08-13, `/api/health`
  reported `version: 0.7.0`, the checkout reported 0.7.1, and the server's candidate workspace had
  zero sources. Restarting that owned server loaded 0.7.1 and restored the current route gate.
- Root cause: the launcher treats any successful response on the preferred URL as an already-live
  app. It does not compare the running API version with the installed version, and an update does
  not safely replace the recorded owned server.
- Fix: `/api/health` now identifies the CareerRat product, package version, and runtime PID.
  `careerrat start` compares that handshake with the installed version, replaces only a recorded
  process whose command is the exact workspace tracker server, and uses the next free loopback port
  without touching a stale-unowned or foreign listener. `careerrat update` remembers a running owned
  app and invokes the freshly installed launcher so the same reconciliation runs after extraction.
- Regression: `local-app-runtime.test.mjs` covers matching, stale-owned, stale-PID, legacy-health,
  foreign-listener, exact-command, health-identity, and fallback-port cases. `api-server.test.mjs`
  pins product/version/PID health identity, and `release-safety.test.mjs` pins both launcher paths.
- Live retest: an isolated 0.7.1 server stayed running while its install advanced to 0.7.2.
  Relaunch stopped PID 35422, started PID 35604 on the same port with health version 0.7.2, and
  preserved the workspace tracker byte-for-byte. A separate foreign service on port 7793 remained
  alive and unchanged while CareerRat selected 7794. The real default app is now serving 0.7.1 and
  routes the source-less workspace back to Paul with no current-page console errors.

### `F-089` Natural recruiter ambiguity renders as a generic server error

- Status: `FIXED`
- Severity: P1 workflow blocker, Ask refused to guess between recruiter threads but returned HTTP
  500 and generic computer-error copy instead of telling the user how to clarify.
- Reproduction: ask CareerRat to draft a reply for a company with more than one saved recruiter
  thread and omit the role or subject.
- Root cause: the new deterministic communication resolver emitted missing and ambiguous codes,
  but the workspace HTTP boundary and candidate-facing error translator did not classify them.
- Fix: map a missing recruiter thread to 404, ambiguity to 409, and render only bounded structured
  company, role, and subject choices with no blind retry action.
- Regression: workspace route and error-copy tests cover both codes, safe labels, and status values.
- Live retest: an ambiguous natural Ask request displayed both candidate-safe thread choices and
  left every thread unchanged instead of selecting one.

### `F-090` Ask interview-prep receipt loses company and role

- Status: `FIXED`
- Severity: P1 product-coherence blocker, a successfully generated dossier could leave Ask saying
  `Prepared the interview packet for undefined — undefined.`
- Reproduction: prepare an interview through natural Ask against the real dossier builder rather
  than the injected unit-test seam.
- Root cause: the dossier builder persisted the correct title but omitted `company` and `role` from
  its return object, while Ask used those fields for the completion receipt.
- Fix: return the canonical application company and role with the persisted dossier and expose an
  allowlisted `/app/jobs?dossier=<application-id>` next action.
- Regression: dossier and Ask tests pin the returned identity, safe deep link, and rendered action.
- Live retest: natural Ask prepared `Northstar — Staff AI Engineer`, rendered the exact company and
  role, and opened the saved dossier at the application-scoped Jobs deep link.

### `F-091` Native apply handoff skips the existing application-question capture path

- Status: `FIXED`
- Severity: P1 workflow blocker, Ask could generate a packet and hand the user to the ATS without
  collecting the employer's actual questions even when a public form API exposed them.
- Reproduction: ask CareerRat to apply to a Greenhouse or Ashby posting, then inspect the packet
  manifest and supervised handoff.
- Root cause: deterministic Greenhouse/Ashby question adapters and the packet-question API existed,
  but `job.prepare-request`, `job.generate-documents`, and `job.apply` never called that owner.
- Fix: capture supported public form questions before packet generation, preserve the typed capture
  state in the handoff, and provide an in-Ask paste-and-resume surface for every other ATS. A failed
  answer rebuild keeps the captured questions and exposes a retry. Applied remains verified-only.
- Regression: workspace-agent, AskBar, JobDrawer, form-question, and packet tests cover supported,
  unsupported, failed-rebuild, unsafe-URL, and verified-completion paths.
- Live retest: one headed Ask request against Anthropic's live Greenhouse board captured the full JD,
  all 19 public application fields, and a 96/100 KEEP verdict; generated the résumé, cover letter,
  and answer sheet; stopped on human-review gaps; and left the application in Reviewed Hold.

### `F-092` Evaluation copy is clipped mid-word and uses broken plural grammar

- Status: `FIXED`
- Severity: P1 product-quality blocker, a successful live evaluation rendered fragments such as
  `customers,cut`, an incomplete trailing conjunction, and `5 items still needs review`.
- Reproduction: run a real packet gate whose structured fields reach the 80/140/160-character
  budgets, then prepare a packet with more than one unresolved item.
- Root cause: structured output retries could land exactly on the schema budgets, and normalization
  used raw string slicing. The packet receipt also hardcoded the singular verb for every count.
- Fix: prompt for complete plain-English copy with safety margin, normalize budget-edge fragments at
  word boundaries with an ellipsis, remove dangling connectors, and select the singular/plural verb
  from the actual count.
- Regression: packet-gate tests pin exact-budget and dangling-connector inputs; workspace-agent
  coverage pins plural packet-gap copy.
- Live retest: the final Anthropic evaluation rendered complete concise English fit/comp sentences,
  three readable reasons and risks, and `4 items still need review`.

### `F-093` Expected logo misses pollute the browser console

- Status: `FIXED`
- Severity: P2 acceptance noise, an unavailable company logo rendered the correct initials but also
  logged an HTTP 404 on every clean Jobs-page load.
- Reproduction: load a real company without a logo.dev match, such as Recare Deutschland GmbH, and
  inspect the browser console.
- Root cause: the image route deliberately used 404 as the control signal for the React `onError`
  initials fallback. The visual fallback worked, but Chromium correctly logged the failed request.
- Fix: the SPA opts into `fallback=initials`; expected upstream/cache misses then return a cacheable
  empty 204 that still fires the image fallback. Invalid and direct API requests retain 400/404
  semantics.
- Regression: logo-route and CompanyAvatar tests pin the opt-in URL, quiet 204, legacy 404, and
  traversal-safe behavior.
- Live retest: a fresh headed Jobs load rendered the `RD` initials fallback and the complete apply
  handoff with zero console errors and zero warnings.

### `F-094` Live job evaluation exhausts its output budget before emitting JSON

- Status: `FIXED`
- Severity: P1 workflow blocker, a normal saved-job evaluation could spend its entire output budget
  on adaptive thinking and fall back to manual review instead of returning a typed verdict.
- Reproduction: rate the saved Grafana Labs role through Ask with the default Sonnet model; both
  attempts stopped at exactly 700 output tokens with no parseable verdict.
- Root cause: the packet gate sized `max_tokens` only for the visible JSON, even though current
  models count adaptive thinking and visible output against the same hard cap.
- Fix: carry provider effort through the bounded/native AI seam, use low effort for this bounded
  classification task, and reserve 4,096 output tokens for reasoning plus the typed verdict.
- Regression: packet-gate, bounded-AI, and call-AI tests pin the budget and effort wire format.
- Live retest: the packed app evaluated the same 9,333-character JD in one call, saved a 58/100
  REVIEW verdict, and rendered compensation plus three fit reasons and risks with no schema fallback.

### `F-095` The npm package omits Universal Intake's routing table

- Status: `FIXED`
- Severity: P1 packaged-workflow blocker, attached or pasted JDs fail classification only after
  install even though the source checkout works.
- Reproduction: attach a text JD in a clean npm install and choose `Capture and evaluate this job`.
- Root cause: `config/paste-intake-routes.json` is a runtime dependency, but the package allowlist
  shipped only schemas and example config files.
- Fix: add the routing table explicitly to the package allowlist and pin it in release-safety tests.
- Regression: the release test requires the exact runtime file and npm dry-run inspection confirms
  it is present in the tarball.
- Live retest: the rebuilt clean install loaded the routing table and classified the attached JD as
  `Northstar Ledger — Senior Platform Engineer` instead of throwing ENOENT.

### `F-096` Installed intake classification ignores configured credentials and sends an invalid native schema

- Status: `FIXED`
- Severity: P1 workflow blocker, Universal Intake could report no AI route despite a working BYOK
  key, then fail with a provider 400 after it was moved onto the shared native route.
- Reproduction: classify an attached JD in the installed app with the same key that successfully
  evaluates saved jobs.
- Root cause: intake classification used the Agent SDK-only one-shot path instead of `callAI`; its
  nested `additionalProperties:true` schema was also invalid for Anthropic native structured output.
- Fix: use the configured installed/BYOK/proxy bounded-AI seam in production, keep the SDK injection
  only as a compatibility test path, and close permissive nested objects at the native schema seam.
- Regression: intake-classify and call-AI tests pin configured-route use, low effort, output budget,
  and provider-compatible nested schemas.
- Live retest: the packed app classified the attachment, showed the confirm boundary, captured the
  full JD, returned a 38/100 CUT, rendered the reasons and compensation, and persisted the verdict.

### `F-097` Application packets expose internal validation noise and wrong setup-derived answers

- Status: `FIXED`
- Severity: P1 workflow blocker, a prepared application told an ordinary user that 26 items needed
  review even though most were duplicate evidence-validator and placeholder-linter messages. The
  same packet incorrectly filled a relocation boolean with the candidate's home city, filled an
  address-or-relocating field with `Yes`, and flagged `Current base is Austin` as private pay.
- Reproduction: prepare Anthropic's public Greenhouse application from a fully onboarded packed
  install and inspect the 19-field answer sheet plus packet manifest.
- Root cause: packet answers sent standard setup fields through the AI evidence lane, every safety
  layer appended its own copy of the same unresolved item, generic location matching treated the
  substring in `relocation` as current location, and the private-pay phrase detector treated any
  use of `current base` as compensation.
- Fix: resolve standard form fields through the existing deterministic fill plan, treat the
  generated résumé as the file-upload answer, leave unresolved optional questions blank, normalize
  all `NEEDS YOU` punctuation, store omitted unsupported skills as advisory warnings, and persist
  one typed plain-English gap per required human action. Relocation, percentage-based hybrid work,
  and notice-period prompts now use the confirmed setup fields without entering the AI lane.
- Regression: packet-answer, packet-engine, and apply-form-fill tests pin deterministic profile
  reuse, optional-question behavior, deduplicated action counts, location-versus-compensation
  privacy, and exact relocation/hybrid/start answers.
- Live retest: the rebuilt npm package recaptured all 19 Anthropic fields, generated all packet
  artifacts, reported four real review actions instead of 26 internal messages, filled hybrid
  office posture as `Yes`, start availability from the two-week notice period, relocation as `Yes`,
  and the work-address field as `relocating`. The application stayed Reviewed Hold with no applied
  or submitted timestamp.

### `F-098` Text-only Apply intake offers an impossible site handoff

- Status: `FIXED`
- Severity: P1 workflow blocker, a pasted or attached JD without a posting URL could finish packet
  preparation and then tell the user to open the application site even though no safe link existed.
- Reproduction: paste a JD into Ask, request Apply, confirm the proposed capture/evaluate/prepare
  action, and inspect the final handoff.
- Root cause: the Apply result only modeled an executable handoff and the intent router recognized
  `apply` and `submit`, but not ordinary preparation phrases such as `prepare the application`.
- Fix: emit a typed `APPLICATION_URL_REQUIRED` action with direct paste-the-link guidance when a
  safe URL is absent. Route prepare/build/generate-application language through the same visible,
  confirm-first Apply workflow.
- Regression: workspace-agent tests pin the typed missing-link action, null executable handoff,
  preserved Apply intent for Universal Intake, and preparation-language routing.
- Live retest: the packed app evaluated a pasted JD at 92/100 KEEP and generated its packet without
  submitting; an attached JD resolved the existing tracked application, returned a 91/100 REVIEW,
  and stopped before packet generation. The final package previewed `Prepare the application for
  Anthropic Applied AI Engineer` as a `job.prepare-request` action.

### `F-099` Standalone tailoring inherits screening questions from an earlier Apply run

- Status: `FIXED`
- Severity: P1 workflow-boundary blocker, asking only for a tailored résumé could regenerate an
  answer sheet from application questions captured during an unrelated earlier Apply flow.
- Reproduction: capture public Greenhouse questions through Apply, then ask CareerRat to tailor the
  same job with `applyIntent:false` and inspect the packet artifacts and model calls.
- Root cause: packet generation always fell back to the persisted question capture, regardless of
  whether the current workflow intended to apply.
- Fix: include screening answers only for explicit Apply intent or an explicit low-level question
  capture. Standalone tailoring uses an empty capture boundary, labels the artifact purpose as
  tailoring, and exposes only document review/export actions.
- Regression: packet-generator and workspace-agent tests pin persisted-capture isolation, explicit
  capture compatibility, documents-only artifacts, and the absence of an application handoff.
- Live retest: the rebuilt package tailored Anthropic's live job URL without an answers artifact or
  answers-model call, then rendered `Tailored documents` with only Export and Review actions.

### `F-100` Pasted and attached Tailor requests lose their requested action

- Status: `FIXED`
- Severity: P1 workflow blocker, the URL path could tailor a job while Universal Intake reduced
  pasted or attached requests to evaluation or application preparation.
- Reproduction: type `Tailor my resume for this job`, then paste a JD or choose a text JD with the
  file picker and inspect the proposed dispatch.
- Root cause: Universal Intake modeled only `evaluate` and `prepare`, and the Ask attachment path
  could not preserve a dedicated tailoring intent alongside the captured document.
- Fix: add the typed `tailor` requested action end to end, map it to `job.tailor-request`, and render
  the confirm-first `capture, evaluate, and tailor documents` plan for paste and attachment inputs.
- Regression: intake action, dispatch, route, summary, and AskBar suites pin natural Tailor phrases,
  both capture paths, and the typed workspace intent.
- Live retest: a real paste and a real file-picker upload in the packed app both persisted
  `requestedAction: tailor`, returned KEEP verdicts, generated only résumé and cover letter
  artifacts, and exposed no Apply handoff or submission write.

### `F-101` Native Apply stops before the application form

- Status: `FIXED`
- Severity: P0 first-day workflow blocker, CareerRat could prepare an application packet but had no
  connected production executor to open the real form, fill known answers, or verify the outcome.
- Reproduction: ask CareerRat to apply to a saved KEEP job from the packaged app and follow the
  generated handoff. The workflow stopped at a manual site link with no visible browser session,
  field progress, blocker state, or confirmation evidence.
- Root cause: the workspace agent exposed an optional `applyJobImpl` seam, but tracker-dev never
  supplied one. Form-question capture also depended on provider-specific schemas instead of the
  rendered form, and browser provider selection exposed implementation choices to the user.
- Fix: automatically select the available session browser, connect the Orca executor in production,
  capture the rendered form before every action, rebuild answers when new questions appear, fill
  deterministic fields and generated documents, stop on identity/security blockers, preserve the
  user's final Submit boundary, and require a confirmation re-scan plus screenshot before writing
  Applied. Ask and the job drawer now show the live session, filled fields, unresolved work, and
  blockers instead of implying completion.
- Regression: Orca executor, session selection, workspace-agent, packet-answer, AskBar, JobDrawer,
  Settings, consent, and schema suites cover automatic provider choice, safe fill/upload behavior,
  rendered-question rebuilds, manual-submit handoff, and verified-only outcome write-back.
- Live retest: a clean packed npm install automatically selected Orca for a controlled local form,
  filled name, email, and work authorization, left the optional portfolio blank, and stopped before
  Submit. After the explicit test submission, re-scan found the confirmation page, captured a local
  PNG receipt, and only then moved the application to Applied. No employer form was submitted.

### `F-102` One-off application questions have no coherent native Ask path

- Status: `FIXED`
- Severity: P1 workflow blocker, a user could ask how to answer a newly surfaced application
  question, but the primary chat treated it as generic advice while the dedicated `/answer` page
  was retired and no longer reachable from the product.
- Reproduction: type `How should I answer this application question: Will you now or later require
  sponsorship?` into Ask and inspect the preview and result.
- Root cause: the evidence-grounded packet answer engine and `answer-question` skill existed, but
  workspace intent classification, execution, result rendering, and reusable-answer confirmation
  were never connected.
- Fix: add typed `screening.answer` and `screening.answer-save` intents, reuse the packet answer
  engine and saved application context, render reviewable provenance-aware answer cards, preserve
  NEEDS YOU and self-identification exclusions, append tracked answer artifacts idempotently, and
  expose persistence only for reviewed recurring disclosure answers. Employer-specific prose is
  never saved as a global default, and the result explicitly says nothing was submitted.
- Regression: one-off answer, workspace preview/execution, route-status, and AskBar suites cover
  deterministic profile reuse, evidence/NEEDS YOU behavior, durable classification, non-durable
  rejection, tracked artifact stamping, typed request bodies, and the review/save UI.
- Live retest: an isolated 8-of-8 candidate with one deterministic source and a completed first
  search entered the real app, previewed the typed Ask action, received the saved no-sponsorship
  answer without an AI call, reviewed and saved it, and retained both the exact
  `screening_answers` value and durable workspace receipt after a full server restart. Browser
  console output contained zero warnings or errors. A clean 545-file npm package also ran the real
  deterministic draft and confirmed save against a fresh candidate home, reopened the database to
  verify the exact default and both durable thread records, and verified that the shipped UI bundle
  contains the review card.

### `F-103` Installed-CLI embedded chat sessions cannot load their own skill

- Status: `FIXED`
- Severity: P1, every embedded chat session (research-company, research-comp, company-health,
  research-boards, discover-companies) started under an installed CLI runtime could produce
  content but could never emit the typed result block the app needs to save it.
- Reproduction: select the installed Claude Code CLI as the embedded runtime, then ask Ask to
  research a company, benchmark comp, or check company health. Each session opens by stating it
  cannot load the matching packaged skill ("I couldn't load the research-company skill from this
  session's registry") and ends by admitting it has no file-write access to save the result.
- Root cause: `buildInstalledRuntimeInvocation` passed `--safe-mode` on every installed-CLI chat
  invocation, which isolates project-scoped `.claude/skills/` from the spawned session. The
  Agent-SDK/BYOK path has an explicit `Options.skills` + `settingSources:['project']` mechanism to
  load skills despite similar isolation; the installed-CLI path had no equivalent, so it silently
  degraded to free-lanced web research instead of erroring loudly or falling back.
- Fix: for Read-less `CHAT_RUNTIME_TOOLS` sessions, materialize an app-owned temp cwd containing
  only a symlink (copy fallback) to the one matching session skill, and swap `--safe-mode` for
  `--setting-sources project`. One-shot runtimes that retain `Read` keep `--safe-mode` and
  `cwd=repoRoot` byte-identical. (PR #84)
- Regression: installed-runtime, chat-runtime, and skill-runtime suites cover the isolated cwd,
  the spawn-level argv change, and byte-identical one-shot-runtime behavior.
- Live retest: PASS on 2026-08-17 against the fix branch. Re-ran research-company, research-comp,
  company-health, and research-boards against a live Claude Code CLI runtime; every session's
  spawned argv showed `--setting-sources project` in place of `--safe-mode`, and the isolated cwd
  contained only the one matching skill symlink. No session opened with "isn't installed here"
  again. company-health reached a full end-to-end pass (schema-valid result block, CLI and
  chat-equivalent write paths, Jobs drawer badge, Activity Pulse event, restart-durable).
  research-company and research-comp now reach real six-axis WebSearch/WebFetch research but are
  separately blocked by the installed-runtime's 120s timeout on long research turns (fix open as
  PR #92), and research-boards' skill text let chat turns claim CLI writes they cannot make;
  the rendered Add source/Skip controls are the real, already-wired write path
  (filed as issue #90, skill-text fix in PR #93). Both are their own findings, not
  this regression. Re-verified 2026-08-19 with both fixes on main: research-company, research-comp,
  and research-boards were re-run and discover-companies was retested for the first time, all
  against a live installed Claude Code CLI runtime. Spawned argv for each session showed
  `--setting-sources project` (`claude -p --setting-sources project --output-format json
  --permission-mode dontAsk --no-session-persistence --tools WebSearch,WebFetch,Skill
  --allowedTools WebSearch,WebFetch,Skill`), parented directly by the dev server, never
  `--safe-mode`. research-company and research-comp both completed real WebSearch/WebFetch runs
  inside PR #92's 9-minute chat-session timeout with no truncation; the demo workspace's fictional
  company name correctly failed to resolve on the open web (the honesty firewall refusing to
  fabricate, not a bug), so the research turns were redirected to a real public company, GitLab
  Inc., while candidate identity and comp figures stayed synthetic. research-boards and
  discover-companies both now state in-transcript that writes happen through the rendered
  Add source / Track company / Skip controls rather than claiming a CLI write the session can't
  make, matching PR #93's fix — discover-companies' own turn ended with "AUTO-ADDED: none (chat
  handoff — writes happen via the Track company/Skip controls, not this turn)". All four produced
  schema-valid typed result blocks the app renders and saves: research-company and research-comp
  through "Save to workspace" (`workspace/research/*.md`, via the same `research.record` intent
  the UI calls), research-boards and discover-companies through the boards/company config write
  path (`search-sources` and `sourced-scan` rows in the `candidate_source_configs` table). Every
  write was confirmed in durable SQLite/file storage, not just an API response, and all four
  survived a full server kill-and-restart (new pid, same data read back correctly). Zero browser
  console errors or warnings across the run. One footnote, not a defect in this fix: the AskBar's
  free-text intent classifier didn't reliably surface an ACTION chip for research.comp-shaped
  phrasing during this retest and fell back to a lighter Q&A path instead; worked around by calling
  the `research.comp` workspace intent directly, the same code path the chip would trigger, which
  correctly reused the live session instead of spawning a redundant one.
