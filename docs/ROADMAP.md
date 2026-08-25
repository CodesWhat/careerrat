# CareerRat Roadmap

CareerRat is a local, skill-driven job-search workspace. You define what you
actually want; it turns that into searches, gates jobs against the real posting
body, tailors honest application artifacts from your own evidence, tracks
outcomes, and prepares you for interviews — with candidate-owned state stored
locally. AI requests go through the runtime the candidate selects and are subject
to that provider's privacy and retention terms.

The active product direction is a conversational local app powered primarily by
a boundary-verified AI CLI you already have installed and authenticated. Development and
QA happen web-first for speed, and the same app now ships in the packaged Electron
runtime. The macOS artifact is signed, notarized, stapled, and Gatekeeper-approved.
A managed AI service may return later as an optional convenience, but login,
billing, and a CareerRat API key are not prerequisites for the core first-run path.

The opinionated part is the **gate**: don't spray applications, don't trust
title/keyword matches, read the posting before tailoring, and treat comp,
location, work mode, travel, relocation, work authorization, and honesty
constraints as first-class inputs. Everything candidate-specific lives in
configuration (`candidate/*.yml`), so the *same* skills serve any field — a
nurse, a driver, and an engineer each bring their own config.

## Shipped

- **Guided onboarding** (`ingest-profile`) — turns a résumé + preferences into
  validated config: targets and adjacent roles, keep/cut signals, comp floor and
  expectations, location/mode/travel constraints, work authorization, preferred
  posting age, honesty boundaries, evidence bank, and writing-style calibration.
- **Search setup & intake** (`setup-searches`, `research-boards`,
  `discover-companies`, `search-jobs`) — build searches from your targets, discover
  boards and company ATS sources in order, capture postings, dedupe,
  liveness-check, and produce a gated intake queue with a coarse triage fit.
  `doctor` and the source CLIs now surface whether broad searches, board discovery,
  company discovery, and the first job sweep have actually run; `careerrat next`
  and the main conversation point the agent at the next useful skill.
- **Body-read gate** (`evaluate-job`) — a standalone gate that reads the full
  posting and emits a `GATE` / `FIT` / `COMP` / `ACTION` verdict from your config.
  `apply-job` must run or verify it first.
- **Honest tailoring** (`tailor-application`) — résumé, cover letter, and
  short-answer artifacts built only from your evidence bank, with a placeholder
  lint that blocks unresolved template tokens before build or upload.
- **Communication memory** (`email-comms`) — draft and track recruiter threads,
  follow-ups, scheduling, and negotiation without re-pasting history. Draft-only
  by default; sending requires explicit confirmation.
- **Tracker & analytics**: a local app backed by canonical SQLite state, with a
  searchable Pipeline organized by the semantic stage ladder (Sourced → Applied
  → Screen → Interview → Final → Offer → Accepted), durable job conversations,
  follow-up reminders, and outcome analysis.
- **Interview prep** (`interview-prep`) — audience-segmented packets (recruiter /
  hiring manager / panel) grounded in your evidence, with do-not-overclaim
  guardrails. Comp/logistics scripts use only your target/minimum figures.
- **Apply workflow engine** (`apply-job`) — portal form-fill recipes with a
  mandatory user-submit gate, and the flow halts on
  CAPTCHAs and unsupported auth prompts. With explicit `mail_access` consent, it
  can read one recent emailed verification code from any webmail provider and continue.
  The agent-led workflow and safety gates are shipped. Native Ask and Apply on site
  deterministically capture public Greenhouse and Ashby questions before packet
  generation. The native Orca executor captures rendered questions for other forms,
  rebuilds the packet, fills confirmed fields and generated PDFs from a fresh snapshot
  before every action, then stops before Submit. Paste remains the fallback. Applied is
  written only after a confirmation page and screenshot are captured or the user reports
  completion.
- **One-command start** (`careerrat start [agent]`) — scaffolds the workspace,
  installs the skills, brings up the local app, and launches a supported detected
  agent or an explicitly named compatible command with a starter message, so first
  run is a single line.
- **Packaging** — `careerrat` launcher (`start` / `init` / `install-skills` /
  `doctor` / `next` / `ingest` / `searches` / `companies` / `evaluate` /
  `tracker` / `tracker-dev` / `modes` / `automation` / `research` / `gate` /
  `learnings` / `stories` / `activity` / `evidence` / `analytics` /
  `strategy-review` / `status-map` / `export` / `restore`), a Docker option, and
  a sample workspace. `restore` recovers
  `tracker.json` from a rolling point-in-time snapshot (confirm-first, backs up
  the current file first).
- **Live app server** (`careerrat tracker-dev`): serves the chat-first app and
  pushes canonical tracker and activity changes into the open workspace as they
  happen.
- **Safe config write-back** (`careerrat gate`) — when you state a new gate mid-flow
  ("never that company", "$X floor", "don't claim that tool"), skills persist it to
  the right config file: comment-preserving, schema-validated, atomic, and
  confirm-first on consequential changes. Dry-run by default.
- **Posting-legitimacy screen** — the gate flags likely ghost jobs, evergreen
  "talent pool" reqs, staffing-agency reposts, stale listings, and thin JDs. It's a
  flag, never an automatic reject: a suspect posting goes to review so you decide.
  Thresholds and tells are configurable and field-agnostic.
- **Document export** — print-quality PDF for tailored artifacts and interview
  packets via the bundled headless Chromium (zero new runtime dependency), plus an
  opt-in `.docx` path that auto-detects pandoc/LibreOffice and otherwise falls back
  to a built-in writer (`careerrat export <file.md> --pdf [--docx]`).
- **Chat-first visual system**: a fixed desktop workspace with a persistent thread
  rail, centered conversation, contextual side panel, consistent neutral dark-gray selection,
  compact controls, and shared color, spacing, type, icon, and shape variables.
- **Per-track learning memory** (`careerrat learnings`) — durable, private lessons per
  role family. The skills that learn from outcomes (interview debriefs, rejection and
  win patterns, strategy reviews) append dated entries; the skills that produce
  artifacts (evaluation, search triage, tailoring) read them, so fit, résumés, and prep
  get sharper on each track the more you run it. Entries are checked for unresolved
  placeholders and refused if they would record a private comp input; everything stays
  in a gitignored local directory and never goes outbound.
- **Durable conversation workspace**: job, recruiter, research, Deep ingest, and
  mock-interview threads survive navigation and restart. Search, Pipeline, Files,
  People, and Schedule stay available as focused browse surfaces beside the chat,
  while resumable missions collapse multi-job work into one progress summary.
- **Research loop** (`research-company`, `research-comp`, `research-boards`) — opt-in
  company research, comp benchmarking, and board discovery that persist cited,
  privacy-safe findings and feed evaluation and interview prep. A three-tier citation
  firewall (verified evidence / sourced-web / agent-inferred) keeps web findings out
  of résumé claims. *(Shipped and live-validated — the citation firewall and private-comp
  privacy gate held across real research runs.)*
- **Interview story bank** (`careerrat stories`) — a candidate-owned bank of structured
  behavioral stories (STAR + result) reusable across loops, each tracing to a real
  evidence claim and surfaced in interview packets.
- **Deeper negotiation support** — geographic-discount pushback, competing-offer /
  BATNA framing, and multi-round sequencing across the written (`email-comms`) and
  live (`interview-prep`) channels, anchored to market benchmarks and never
  fabricating an offer, number, or deadline.
- **Deterministic source foundation** — all 77 public-network adapters from the pinned
  Career Ops provider snapshot run through CareerRat's shared scanner boundary, including
  company ATS APIs, broad public APIs/RSS, regional boards, and niche sources. The parity
  manifest records the one intentional exclusion: `local-parser`, which executes arbitrary
  user-configured local commands. Generic RSS and opt-in authenticated/manual sources remain
  available where a public adapter is not appropriate.
- **Opt-in browser & mail automation** — session-based automation you switch on per
  capability, using your own browser login with no stored credentials: application-status
  sync (`sync-status`), authenticated search, in-platform message ingest
  (`ingest-messages`), and authenticated supervised apply preparation (LinkedIn Easy Apply,
  stopping at the existing user-submit gate), LinkedIn profile optimization, plus opt-in mail sync and
  `mail_access` for generic webmail / Gmail / Outlook. A per-capability, per-platform consent
  switchboard (`careerrat automation`) defaults fully off and stores nothing — nothing runs
  until you read a platform's terms, record consent, and enable it; every session is
  human-in-the-loop and halts on a CAPTCHA, 2FA, or limit. Onboarding asks for each
  capability only when a concrete action needs it and saves partial progress so setup can
  resume after a restart. *(Shipped and live-validated; the consent gates remain the boundary
  for each capability and platform.)*
- **Settings & configure** (`configure`) — a lightweight settings step you run any time to
  change your config without redoing first-run onboarding: comp floor and target, targeting and
  excluded companies, writing style, form defaults, search sources, and your browser-automation
  opt-ins — including which session browser runs the authenticated capabilities (a browser
  extension, recommended, or a sign-in-once local profile). It shows your current settings first,
  then routes every change through the existing validated, confirm-first config commands; it never
  becomes a separate way to mutate your data. `doctor` now reports your session-browser provider
  and a best-effort readiness check.
- **Mode switchers** (`careerrat modes`) — two independent knobs for running CareerRat at the
  intensity you want. `usage_mode` (`lean | standard | full`) controls discretionary compute and
  scope: broad research, board discovery, deep interview packets, broad sweeps, and agent fan-out
  can downshift, but the core gate/tailor/track/comms loop stays full quality. `application_mode`
  (`selective | balanced | high-volume`) controls pursuit posture after discovery: promotion
  thresholds, medium-fit review, and apply/hold behavior. Discovery stays recall-oriented by
  default; modes never relax evidence, honesty, privacy, comp, consent, or application-limit gates.
  The optional private file is `candidate/modes.yml`; absent means `standard` / `balanced`, and
  both `doctor` and the dashboard report the active values.
- **LinkedIn profile optimizer** (`optimize-linkedin`) — an opt-in pass that reads your LinkedIn
  profile through the session browser (same consent model as the other authenticated capabilities,
  defaults off) and compares it against your targeting and evidence, then proposes honest,
  evidence-backed improvements to your headline, About, experience, and Featured so your profile
  reads for the roles you actually want. Keep it suggestions-only, or — with a separate opt-in —
  let it apply the approved rewrites for you through the same session browser. It always previews
  the full before→after first (nothing touched); applying is a separate, deliberate step you take
  field by field. Reading and writing are independent switches, every line traces back to your
  evidence, and a flagged claim that's actually true is grounded into your evidence rather than
  cut. *(Shipped; the suggest path has been live-validated, and write-back remains a separate
  per-field opt-in.)*
- **Meeting scheduler** (`schedule-meeting`): Ask and each job drawer now route scheduling through
  Paul. He reads the saved recruiter thread, profile availability and timezone, and opaque calendar
  busy blocks; blocks conflicts using the configured buffer; prepares a timezone-explicit reply;
  and creates a downloadable tentative `.ics` hold for an accepted slot. The draft is saved to the
  linked communication for review, while sending, booking, and `interviewAt` remain untouched until
  the user confirms those separate actions. Missing availability and AI failure stay in Ask with a
  specific recovery prompt. The old datetime form remains collapsed under **Record a confirmed
  time** for out-of-band bookings. *(Shipped and live-validated in an isolated workspace on
  2026-08-15, including conflict rejection, draft-only write-back, ICS validity, restart, desktop,
  and 390px layout.)*
- **Calendar export** — the Calendar dashboard page turns tracker-derived interviews,
  assessments, follow-ups, deadlines, and prep blocks into portable real-calendar
  actions: one-click per-event `.ics` downloads, week-level `.ics` export, and
  prefilled Google Calendar / Outlook web links. This is intentionally no-auth and
  user-clicked: CareerRat prepares the event, the user decides what to import.
- **Calendar provider sync** (`calendar-sync`) — a confirm-first provider-sync
  foundation for Apple Calendar, Google Calendar, Outlook Calendar, and approved
  local automation tools. The `calendar_sync` capability defaults off per provider,
  the Calendar page shows provider readiness plus recent `calendarWrites[]` history,
  and the owning skill previews exact tracker-derived events before any real
  calendar write. No background auto-sync is enabled.
- **Live Activity Pulse + derived action queue** — a running local timeline on the dashboard of
  what CareerRat did and what happened in your search: roles sourced, jobs evaluated, résumés
  tailored, follow-ups drafted, replies, interviews, and offers. The feed is pure append-only
  history (agent actions and real-world events stay distinct, each entry clicks through to the
  job, and each job drawer shows that role's own timeline); what *needs you* is computed live
  from your tracker as a self-clearing action queue — finish the work and the item disappears,
  so there are no stale "do this" buttons left behind. Backed by `workspace/activity.jsonl` with
  tracker backfill, a retention backup, and point-in-time `tracker.json` snapshots for recovery.
- **Sourced-role triage & status lanes** — newly sourced roles, gate verdicts, and apply
  outcomes drive clear board states: roles that pass the gate stay as ready-to-pursue, gated
  roles archive off the active board (kept and recoverable), and an application the assistant
  can't prepare a submission (CAPTCHA, account wall, a required exercise) is surfaced as "manual apply
  needed" rather than disappearing. A board-top triage banner counts what's waiting and prompts
  you to go through it with your agent.
- **Strategy insights**: local, read-only outcome analysis:
  source performance, role-lane performance, fit-band breakdown, quiet-pipeline rows, longest
  active time-in-stage rows, cadence nudges for due/overdue/no-next-touch follow-up, and one
  strategy recommendation are computed from canonical tracker state so CareerRat can explain where
  traction is actually coming from without duplicating the Pipeline, People, or Files views.
- **Deeper outcome learning** — Strategy insights now includes a compact outcome-learning
  layer: 30-day applied/advanced/interview/rejected trend cards, 30/60/90-day history,
  source and role-family learning signals, and a `#strategy-review` handoff that opens
  the Strategy details when the tracker has enough signal to recommend a real review.
- **Session webmail access** (`mail_access`) — a separately gated session-browser capability.
  During apply or sign-in flows, generic `webmail` can read only the specific recent
  verification-code email from any provider, never the broader inbox, and never sends, deletes,
  replies, or archives. Gmail/Outlook are also named platforms so `ingest-mail` can cover
  webmail sync for people who do not use macOS Apple Mail. It defaults off and halts on webmail
  login walls, 2FA prompts, CAPTCHA, or unexpected interstitials.
- **Opt-in relationship sourcing** (`relationship-sourcing`) — a separate session-browser
  capability for finding likely recruiters, hiring-team members, or warm contacts for tracked
  companies. It is gated as `relationship_sourcing` for LinkedIn/Wellfound, defaults off, writes
  only compact `relationshipLeads[]` review records into the tracker, and surfaces them on the
  Network page. Approved leads become Network contacts; rejected or unreviewed leads are not warm
  paths. It never sends outreach and never turns a no-contact application into a "prioritize"
  action by itself.
- **Company-health signal** (`company-health`) — an opt-in, role-scoped stability rating
  (`healthy | watch | risky` across layoff risk, hiring momentum, financials, sentiment, and
  leadership) with provenance and an as-of date. It only adjusts fit where a weak dimension
  intersects a need you actually stated, it is cost-gated (auto-fires at the interview stage by
  default), and it stays an internal signal — it never appears in an outbound artifact.
- **Interactive live demo on the site** — the dashboard rendered against the bundled sample
  workspace as a static, client-side-only build, served from the project site. Anyone can click
  through a realistic, fully populated job search (a live pipeline, booked interviews, an offer
  being weighed) without installing anything; demo dates auto-rebase so it stays evergreen.
- **Answer any application question** (`answer-question`) — paste a screening or form question
  outside a full apply run and get a drafted answer grounded in your profile, honesty
  boundaries, and evidence. Known answers are reused, durable disclosure-style answers persist
  so they are never re-asked, and anything unanswerable is marked for you instead of invented.
- **Apply packet without a browser** — for a gated job, one artifact set: tailored resume,
  cover letter, and drafted answers to the posting's *actual* application-form questions,
  fetched browser-free from supported ATS form endpoints (with a paste fallback for the rest).
  Unresolved answers structurally block "ready to upload."
- **Local database with one shared write path** — application data now lives in a local SQLite
  database (via Node's builtin driver — still zero runtime dependencies). Every change goes
  through the same atomic domain verbs whether a human clicks a button, the agent runs a skill,
  or you use the `careerrat data` CLI: one write path, with the activity event, freshness stamp,
  and analytics refresh applied in a single transaction. Existing workspaces migrate only via an
  explicit `careerrat data import`; `tracker.json` remains a generated compatibility export.
- **App UI**: a bundled chat-first single-page app (`/app`) over the local server
  with conversational onboarding, editable profile sections, visible skill and
  research threads, and manual operation when no AI runtime is ready.

- **Repository structure and hygiene** — product packages now live together under `apps/`
  (`web`, `desktop`, `website`, and `docs`), design-only landing-page mockups are retained under
  `.planning/archive/mockups`, shared fonts live under `assets/fonts`, and the monorepo uses one
  root lockfile and one Turbo build graph. Release guards reject the old root directories,
  app-local lockfiles, tracked generated Next wiring, and stale build-output paths.
- **Universal conversation intake**: paste or drop a résumé, job description,
  posting URL, recruiter email, interview transcript, or other career material
  into the conversation. The intake pipeline classifies it, matches it to durable
  state, and explains any consequential write before it happens.
- **Workspace browse views**: Search, Pipeline, Files, People, and Schedule expose
  canonical state beside the conversation. Their actions write through the real
  domain operations and route tool-heavy work back into a visible thread.
- **Company logos everywhere** — a server-side logo proxy with a local cache (and optional
  brand-search autocomplete when a key is configured), with an initials fallback so nothing
  breaks offline or keyless.
- **Desktop app shell**: an Electron wrapper around the same local server, using
  a designed 1280 by 860 desktop size that remains resizable and maximizable,
  supports native full screen, and preserves a 1100 by 680 minimum working size.
  First run lands in the onboarding conversation, external links open in the OS
  browser, and quitting cleanly shuts down every agent session.
- **Provider-neutral installed AI runtime (v0.16 review checkpoint)**: CareerRat
  owns its workflows and threads, so durable product state is provider-neutral.
  Claude Code and Codex are the only supported product runtime choices and use
  the same app-owned workflow contract. The packaged app invokes the selected
  installed CLI directly and never falls back or silently switches engines. A
  local runtime becomes `Ready` only after its executable, authentication, and
  readiness check pass. Other detected adapters remain diagnostic-only until
  the full promotion matrix passes. The v0.16 runtime boundary, packaged QA,
  and publication gates passed through protected PRs #217 and #218.
- **Database-backed setup and sourcing** — onboarding, settings, search setup, and the
  sourcing sweep all read and write the local database first: setup readiness
  (search-ready / gate-ready / apply-ready) is computed from stored facts and gates what
  unlocks next, discovery hands off through supervised in-app agent chats, and importing a
  legacy workspace brings its search sources along.
- **File drops in capture** — the capture bar accepts binary files (a resume PDF, a JD
  attachment, a screenshot), routed through the same confirm-first intake queue as pasted
  text and links.
- **Calendar busy blocks** — externally-sourced busy windows have a proper owning write
  path, so scheduling can avoid double-booking in database-backed workspaces.
- **People and Files in the app**: company relationship records, contacts, and
  conversation history live in People, while the evidence, story, writing-voice,
  résumé, posting, and tailored-artifact banks live in Files.
  The retired static tracker has no product route or navigation affordance.
- **Setup readiness in the onboarding conversation**: the side panel shows what
  is still needed to unlock gating and applying, with focused section editors for
  corrections, then gets out of the way once setup is complete.
- **Live chat activity lines** — while CareerRat works on a chat request, each step shows
  as a small activity line (an icon, a plain-language label like "Reading files: resume.pdf"
  or "Searching the web", and a spinner that settles when the step finishes) instead of the
  assistant narrating its own tool use in prose. Direct and ACP adapters normalize each
  engine's structured progress into the same activity rows.
- **Fit-gap coaching** (`coach-gaps`) — when an evaluation lands at "review" with named fit
  risks, an explicit click gets a plan for closing the gaps, grounded only in evidence
  already on record or the current conversation. An honest "no close path yet" is a valid
  answer; confirmed suggestions route through the same evidence firewall as every other
  evidence write.
- **AI shape QA harness** — a script-run quality check that exercises every AI-produced
  verdict shape end to end (evaluate-job, coach-gaps, search triage, company-health) against
  a fictional demo candidate through the installed AI CLI, so malformed AI output is caught
  before it reaches a real job seeker mid-search.

### Provider runtime parity checkpoint (August 25, 2026)

This checkpoint consolidates `CLI-PARITY-EXEC-SUMMARY.html`,
`RUNTIME-PARITY-PLAN.md`, the current branch audit, and live Codex canary
evidence. The raw reviews are local evidence under `.internal/review/`; this
section is the durable public release record. It passed packaged and release
acceptance and shipped as v0.16.0.

#### v0.16.1 hotfix checkpoint

v0.16.1 keeps the v0.16.0 provider-parity release intact and closes the first
public UI follow-ups. The hosted-access email and send controls now share one
bottom edge, the redundant website runtime-marketing sentence is gone, and the
website uses calmer section spacing. The v0.16.0 ledger and verification below
remain the historical record for the underlying release.

#### Superseding v0.16 release ledger

This ledger is the current source of truth. It supersedes narrower or earlier
acceptance statements later in this roadmap without rewriting those historical
records. v0.16.0 is released and deployed.

| Area | Current status | Evidence and remaining gate |
| --- | --- | --- |
| Supported runtime posture | Release-candidate QA passed | Claude Code and Codex are the only selectable product choices. Both use direct CareerRat-owned adapters and the same workflow contract; neither is described as the better provider. Both returned their own plain-English result in the signed package without fallback or a silent switch. |
| Direct packaged runtime behavior | Packaged QA passed | The signed app invoked each selected installed CLI directly with isolated configuration and scoped CareerRat tools. Durable restart, errors, and runtime selection passed without a provider key fallback or engine switch. |
| Installed-runtime cancellation | Packaged QA passed | Direct and ACP cancellation escalate from TERM to KILL after a bounded grace period and force-settle uncooperative children. The signed package passed cancellation and process-tree cleanup with no CareerRat or helper process left behind. |
| ACP adapters | Diagnostic only | ACP adapters remain diagnostic-only. Native provider fetch must be proven disabled or independently policy-bound before any adapter can enter the picker, followed by the complete product and packaged matrix. |
| Duplicate onboarding prompt repair | Packaged QA passed | A fresh realistic résumé produced one work-mode prompt and one next typed question. The same home, a restarted home, and a repaired historical completed home retained one copy of each prompt with no rendered or draft system messages. |
| Requisition identity and search quality | Packaged QA passed | The signed app coordinated configured and AI-web lanes, examined 413 configured postings, and returned two distinct live US-remote roles with relevant New York City context. Foreign and non-NYC local rows were excluded, Ashby requisitions remained distinct, and local JD evidence was saved with visible partial-description badges. |
| Strict no-submit application preparation | Packaged QA passed | The 127-test driver set is green. A real three-step Chromium form filled five fields, uploaded one file, clicked exactly two verified Next controls, and stopped on `Submit application` with `prepareOnly=true`, `submitClicked=false`, and no false Applied state. |
| Packaging and release | Released and verified | Protected PRs #217 and #218 merged, and the signed v0.16.0 tag points to the exact promotion merge on `main`. The public GitHub release includes the signed, notarized, and stapled Mac DMG plus its SBOM. `careerrat@latest` is 0.16.0, careerrat.com is running the production release, the Homebrew cask is 0.16.0, and the released app passed upgrade, Gatekeeper, launch, and visual inspection. Windows build, install, launch, export, and uninstall QA are green; the public signed Windows asset remains blocked because SignPath requires project reputation CareerRat does not yet have. |

The duplicate onboarding root fix has both required code paths. Completed homes
run transcript repair before `ChatFirstApp` renders, and internal résumé-upload
messages cannot clear or replay the current assistant question. Both persisted
reproductions passed in the signed package after restart.

##### Earlier checkpoint evidence (superseded where the ledger differs)

- CareerRat-owned SQLite threads, context assembly, workflow state, and
  write-back remain independent of any provider's session history.
- Claude Code and Codex have fixed direct adapters with isolated working
  directories, allowlisted environment, structured output, bounded capability
  invocation, live activity, bounded forced cancellation, and clear errors.
- Every conversational path now receives one shared plain-English voice
  contract. Agent replies lead with the answer, use ordinary language, and keep
  raw JSON, internal codes, command details, and tool narration out of chat.
  The renderer also unwraps valid reply envelopes and hides machine-only output
  when a runtime ignores the instruction.
- The supported picker, website, README, docs, published agent contract, and
  doctor output expose Claude Code and Codex, and no other runtime, as complete
  CareerRat choices. Other discovered runtimes stay outside the product picker.
- One runtime registry now owns support state, fixed invocation and sign-in
  arguments, protocol, model selection, technical capabilities, and separate
  product-acceptance evidence. Route selection, persisted verification, and the
  frontend picker derive from it. A diagnostic adapter cannot become a product
  runtime from an ACP handshake or a support flag alone.
- In-app sign-in recovery is implemented for both supported engines. It starts
  the runtime's real allowlisted flow, `claude auth login` or `codex login`,
  without opening a generic terminal command or falling back to another
  provider.
- Hermes, Gemini CLI, OpenCode, and GitHub Copilot route through one ACP client
  contract in the experimental adapter layer. Prompts stay off process
  arguments, output is bounded, activity is normalized, and the app cancels
  tool calls outside the requested capability. That protocol work is not a
  product support claim.
- Live local research smokes passed for Codex and Hermes. Hermes covered
  completion, structured output, one approved-file read, public-web research,
  and settled activity rows. Hermes has not passed the complete CareerRat
  workflow matrix and remains excluded from the supported picker.
- Internal readiness probes retain capability evidence for diagnostics. Missing
  evidence resolves every capability to false, ACP readiness performs
  initialize, authentication, and session creation, and exact path-bound probe
  evidence is persisted through execution. The product picker does not expose
  these internal tiers.
- The shared `careerrat_scoped_tools` MCP server now exposes only the capability
  requested for a call: DNS-pinned public fetch and/or one no-argument
  `read_staged_input` tool bound to the copied upload. Codex attaches it with
  per-call `-c` settings while continuing to disable shell, unified exec,
  browser, computer, image-read, plugin, native skill-discovery, and multi-agent
  features. ACP adapters receive the same server in `session/new`.
- The focused ACP and installed-runtime boundary suite passes 110 tests. It
  covers private URL rejection, caller-selected path rejection, symlink input,
  alternate input, bounded size, missing metadata, per-call MCP attachment, and
  the retained Codex disable list.
- Earlier live installed-runtime acceptance covered both Claude Code and Codex:
  readiness, completion, structured results, scoped public web, text/image/PDF
  staged reads, outside and symlink denial, live activity, and ordinary
  cancellation. The Codex run left `~/.codex/config.toml` byte-identical. The
  focused runtime regressions cover a TERM-ignoring child for one-shot and
  streaming calls, and signed-package process cleanup passed.

##### Ingested CLI parity execution review

- Do not add LiteLLM, the Vercel AI SDK, LangChain, or another model-provider
  framework. CareerRat integrates installed coding-agent CLIs, not raw model
  APIs. The portable layer is the existing runtime registry, canonical
  `.agents/skills`, CareerRat-owned threads, and narrowly scoped MCP tools.
- Codex already supports a per-invocation boundary by subtracting native
  features with repeatable `--disable` flags, ignoring user config, using an
  ephemeral read-only sandbox, and injecting app-owned MCP configuration with
  `-c`. Public-web calls can therefore expose only CareerRat's guarded fetch
  server without changing the user's global Codex configuration.
- The earlier execution plan concluded that Codex had no remaining tool-boundary
  gap. A live adversarial canary corrected that conclusion: read-only sandboxing
  still read a UUID from a sibling directory when shell and unified exec were
  enabled. With shell, unified exec, image read, and native skill discovery
  disabled, Codex could read neither the in-workspace nor outside canary. That
  evidence is why exact read now uses the no-path scoped MCP tool instead of
  native filesystem access.
- Codex live activity is structural JSONL progress plus a completed text result,
  not text-delta streaming. `streamInstalledAI` has no production caller that
  requests its legacy streaming mode. Remove stale comments and do not turn
  text deltas into a parity requirement.
- Keep native skill discovery disabled for bounded in-app calls until its
  interaction with the isolated single-skill workspace is proven. CareerRat
  already supplies the exact canonical skill body needed for each call, so
  enabling a second discovery path is not required for parity.
- Bring-your-own CLI is baseline compatibility, not a provider ranking. A CLI
  appears in the primary picker only after the complete CareerRat acceptance
  matrix passes. Every supported choice is presented as `Ready`, with no
  weaker task-tools or chat-only tiers.

##### Initial product support contract

- Claude Code and Codex are the only supported runtime choices for v0.16. A user
  can choose either and use the complete CareerRat product without switching
  agents for a workflow.
- Hermes is the next promotion candidate. It joins the supported set only after
  passing the same end-to-end matrix, including skills, scoped read and public
  web, cancellation, durable resume, sign-in recovery, desktop restart, job
  search, and supervised application preparation.
- Gemini CLI, OpenCode, GitHub Copilot, Qwen, Antigravity, Amp, Goose, Droid,
  and custom commands remain diagnostic discoveries or future adapters. They
  are not selectable or recommended merely because a binary is installed or an
  ACP handshake succeeds.

##### Future runtime-promotion gate

- ACP read and web enforcement rejects ambiguous reported tool activity and
  attaches the scoped server, but native provider fetch remains an unclosed
  boundary. Hermes and every other future promotion candidate need that boundary
  plus the complete matrix on an authenticated host before any public support
  claim.

##### v0.16 release completion

- v0.16.0 shipped through protected PRs #217 and #218. The signed tag points to
  the exact promotion merge on `main`; the signed, notarized, and stapled Mac
  DMG, SBOM, npm latest, production website, Homebrew cask, and released-app
  installation are verified. Windows build, install, launch, export, and
  uninstall QA are green. Public Windows distribution remains gated on
  SignPath Foundation signing, which requires project reputation CareerRat does
  not yet have.

##### Closed adversarial fix and verification queue

These four findings were reproduced against the current implementation. None
was counted as closed by the earlier focused parity count. Each now has a
focused regression and passed its affected acceptance path.

1. The non-ACP streaming path writes the raw user prompt to the child process
   instead of the composed installed-runtime prompt. Fix it so Codex streaming
   skill and staged-read calls receive the selected skill instructions and
   staged-input directive, then lock that behavior with a stdin regression.
2. A REVIEW approval action is not bound to the evaluation the user saw. Carry
   the expected `evaluatedAt` through the action and require an exact match
   before approval, including resumed actions, so a stale click cannot approve
   a newer REVIEW verdict.
3. The Codex schema normalizer turns an intentionally open object schema into
   an empty strict object. Replace open result shapes with explicit closed
   schemas or an equally lossless wire representation, and prove strategy
   review proposal payloads survive normalization.
4. Opening runtime settings currently probes every installed adapter, including
   diagnostic-only runtimes. Probe only the supported Claude Code and Codex
   entries; unsupported detections must remain passive and nonselectable.

##### Execution queue

| Order | Work | Status | Evidence required | Ship blocker |
| --- | --- | --- | --- | --- |
| 1 | Narrow website, README, docs, published agent contract, picker, and doctor output to the supported set | Implemented | Copy and UI tests expose Claude Code and Codex as uniform `Ready` choices and exclude every unaccepted adapter | Yes |
| 2 | Finish supported-runtime sign-in recovery from the app | Implemented | Claude Code and Codex start `claude auth login` and `codex login` respectively, with focused route and invocation coverage | Yes |
| 3 | Close the four current adversarial runtime findings | Implemented | Composed streaming prompt, evaluation-bound REVIEW approval, lossless strict schemas, and passive unsupported detection each pass focused regressions | Yes |
| 4 | Live Codex scoped-tool acceptance | Passed | Public research and staged text/PDF/image reads succeed; outside/sibling/symlink canaries remain unreadable; global Codex config is byte-identical | Yes |
| 5 | Full promotion acceptance for Hermes, then other ACP adapters | Pending | Each candidate passes completion, every CareerRat skill family, structured output, read, web, activity, cancellation, resume, sign-in recovery, restart, search, and supervised apply | No for v0.16 core; yes before that runtime becomes selectable |
| 6 | Consolidate adapter metadata | Implemented | Detection, auth, fixed argv, MCP attachment, output parsing, cancellation, technical capabilities, and product-acceptance evidence come from one registry entry per runtime; stale Claude-only streaming assumptions are removed | Yes |
| 7 | Add later runtime adapters | Pending | Per-call or isolated-project attachment, native-tool suppression, authentication, cancellation, full workflow acceptance, and no global-config mutation | No for v0.16 core; yes before each adapter is selectable |
| 8 | Finish packaged desktop QA | Passed | Fresh and returning homes passed setup, duplicate-prompt repair, picker, real skill calls, errors, restart, cancellation, search quality, strict no-submit application preparation, and no provider switching in the signed package | Yes |

Detection is never a support claim. A protocol handshake proves protocol
readiness, not every individual capability. Each selectable capability needs an
adapter-owned boundary plus the evidence named above.

### Search quality checkpoint (August 25, 2026)

The live fictional-résumé acceptance run exposed a false-zero search: 360 jobs
scanned, zero presented. Three independent audits compared the live pipeline,
the pre-chat-first CareerRat search, and `santifer/career-ops`. The exact local
evidence is under `.internal/review/search-quality-*.json`.

#### Verified findings and closures

- The chat-first Search button invoked only the deterministic configured-board
  lane. It now coordinates every executable lane behind one action, including
  deterministic sources and the installed-runtime AI web lane, with explicit
  per-lane configured, attempted, succeeded, failed, and skipped state.
- A fresh profile has only a small runnable source subset. The 77 provider
  modules are a catalog, not 77 active sources. Browser and URL-query entries
  are not attempted by the deterministic sweep, and the live run used five
  broad feeds with zero company ATS boards.
- Completed onboarding searches now reuse only an identical search-input
  fingerprint. Search-relevant targeting, profile, source, mode, and purpose
  changes supersede stale work; AI prompts carry their own candidate-input
  fingerprint; active runs have a ten-minute lease; and failed detached work is
  recorded durably. Prompt-cache and source-watermark writes are excluded from
  deterministic invalidation.
- Superseding a live deterministic run now fences the old worker at every
  network and write boundary. A stale worker cannot advance watermarks, replace
  newer source config, persist offers, or report completion. Watermarks mutate
  the current source entry atomically, so a source approved while a scan is in
  flight is preserved.
- In the measured run, 336 of 360 rows failed the title gate before body-aware
  fit scoring. The scanner now canonicalizes same-run duplicates before gates,
  ranks across all sources independent of arrival order, permits occupationally
  adjacent engineering titles only when body evidence supports them, and emits
  bounded metadata-only rejection samples with blocker/relevance counts.
- One remote-only RSS feed lost its work-mode provenance. Domestic remote roles
  labeled only `USA` or a US city/state were treated as local commute jobs. The
  fix now preserves remote provenance, accepts US regions for home-country
  remote scope, passes 115 focused scanner tests, and recovered four real
  domestic remote rows in replay.
- The live coordinated rerun passed locality, ranking, liveness, stale-run
  recovery, and tracker integrity, but exposed an AI-capture boundary bug: the
  model could omit the JD or label its own short summary complete. AI results
  now pass through CareerRat's guarded canonical job resolver before write-back.
  Canonical bodies replace model summaries, deferred excerpts stay visibly
  partial, empty unreadable roles and soft-404 pages are not persisted, and
  canonical URLs are deduped again. Complete descriptions are retained through
  a 64 KiB UTF-8 safety bound; a body that reaches that bound is explicitly
  partial instead of being mislabeled complete. Source receipts come from
  app-owned recovery even when the runtime emits no tool trace or every result
  is already known.
- Deterministic and AI hydration now use ordered four-worker pools. The
  presentation limit is applied before expensive deterministic hydration, AI
  output is schema-capped at 40 roles, and one run shares exact-URL and
  provider-board reads. Cancellation reaches DNS-pinned public and provider
  fetches and a cancelled lane writes no rows or false completion.
- Parallel discovery lanes now reconcile at the shared persistence
  transaction. If both lanes find the same normalized company and role, the
  winning lane writes the row and JD artifact, the losing lane reports zero
  new, and the combined result counts that role once.
- Cross-lane identity no longer collapses two real requisitions merely because
  their company and title match. Canonical URL and provider-qualified
  requisition ID win; company, role, and location are the fallback only when
  neither stronger key exists. Distinct NYC and US-remote openings now survive,
  while exact URL and requisition duplicates still reconcile once.
- Starting Search now reads the persisted AI route from the existing runtime
  config endpoint. It does not synchronously re-probe every installed CLI on
  each click; explicit Settings refresh and sign-in remain the probe boundary.
- Setup no longer launches another search after every onboarding answer. It
  starts one useful baseline search at minimum readiness, then coalesces one
  final refresh when setup completes and the search inputs changed. Graduation
  starts a visible `research-boards` thread, continues into visible company
  proposals, and keeps every ATS source write behind a Track/Skip decision. The
  proposal transcript, counts, and detail dialog dedupe retry and reload copies.
- A résumé home address no longer silently chooses remote, hybrid, or on-site
  work. Setup stays incomplete until the candidate explicitly confirms work
  modes; the confirmed profile write carries that fact durably.
- Board discovery now returns one validated `source_review` artifact instead of
  a Markdown table, bookkeeping ledger, and one protocol block per source. Chat
  shows one compact result with the four strongest sources and a single review
  action; the dedicated review surface retains every proposed, borderline, and
  rejected source with confirm-first writes.
- Evaluation display fields now pass semantic copy validation before persistence.
  Questions, drafting notes, and self-correction residue get one provider-neutral
  correction retry and then a safe manual-review result. Generic job pages prefer
  schema.org `JobPosting.description`, retaining the full JD and compensation
  without source-site navigation, related-job, question, or footer noise.

#### Implementation order

| Order | Work | Status | Acceptance |
| --- | --- | --- | --- |
| 1 | Preserve remote-source work mode and US-region locality | Implemented | Domestic remote rows survive; foreign remote and non-NYC local rows remain excluded |
| 2 | Fingerprint and lease sourcing runs; recover stale workers; invalidate stale prompts | Implemented | Targeting/source changes create a fresh coalesced run; dead runs recover without a restart |
| 3 | Replace deterministic-only Search with one executable-lane coordinator | Implemented | Deterministic and installed-runtime AI-web lanes expose configured/executable/consented/succeeded/failed/skipped state, discover in parallel, reconcile overlapping roles transactionally, and share one visible result refresh |
| 4 | Enqueue a coalesced fresh run after targeting, source approval, or successful board discovery | Implemented | Onboarding starts one early baseline and one changed-input refresh at completion, never one run per answer; final company approval and confirmed board addition start the expanded sweep without a hidden second click |
| 5 | Normalize and dedupe all same-run candidates before global scoring/ranking | Implemented | Source order cannot let a weaker duplicate win; adjacent titles can reach body fit without flooding the inbox |
| 6 | Persist bounded rejection diagnostics and honest source health | Implemented | Empty results explain unique gate samples and actual lane coverage without storing every rejected body |
| 7 | Make AI JD capture app-owned and canonical | Implemented | Every survivor is re-read through the guarded resolver; full bodies replace summaries, soft-404 and unreadable rows stay out, canonical URLs re-dedupe, the 64 KiB safety bound marks capped bodies partial, and source receipts survive duplicate-only runs |
| 8 | Thread watermarks into fetch windows and revision-protect source writes | Partially implemented | Revision-protected writes now prevent stale workers and concurrent source changes from overwriting each other; provider-specific repeat-fetch windows remain |
| 9 | Add asynchronous checkpointed reverse-ATS discovery | Pending | Broad discovery finds employers outside the watchlist without blocking onboarding or the first useful results |

CareerOps provides useful patterns, not a drop-in configuration. Borrow its
separation of fast configured scans from checkpointed reverse-ATS discovery,
fresh per-run source loading, bounded concurrency, and explicit liveness. Do
not copy its personalized AI/ML-heavy company list or imply its zero-AI scanner
executes the separate agent-owned `search_queries` lane.

### Code review remediation checkpoint (August 25, 2026)

The verified review is archived locally at
`.internal/review/CODE-REVIEW-FINDINGS.md`. Its fabricated finder output was
discarded before handoff; the findings below were rechecked against the named
code paths. The refuted `call-ai` `outputName` report is intentionally excluded.

#### Release-blocking gate integrity

1. Restrict `appSetFields` to explicit non-gate fields so `/api/data/app/fields`
   cannot write `evaluation.gate` or another apply-authorizing field.
2. Stop accepting caller-authored verified delivery evidence on
   `/api/data/comm/send`. Only the connected executor may create a verified send;
   supervised confirmation and user reports retain their weaker provenance.
3. Gate every authenticated application preparation before opening or filling a
   browser tab, not only LinkedIn Easy Apply. Extend the consent platform set to
   every supported ATS.

#### Apply-path correctness

1. Route Deep Ingest evidence through the canonical evidence firewall instead
   of raw SQL.
2. Make packet and evaluation excluded-company cuts share one matcher and the
   same company-plus-title input.
3. Serialize live apply operations per application so two clicks cannot operate
   the same tab concurrently.
4. Verify Orca select results by the acted-on ref, not the first matching label.
5. Make Orca checkbox operations honor both checked and unchecked states.
6. Treat an honestly negative required checkbox as satisfied when its default
   unchecked state is already correct, instead of reporting a false field-change
   blocker.

#### Web and contract correctness

1. Preserve `worked: false` with nullish fallback semantics in mock-interview
    feedback.
2. Apply the update-toggle write response directly, surface rejections, and
    clear the external-push guard after the write settles.
3. Add a busy guard to the cart's “Apply to N jobs” mission action.
4. Add the documented explicit user-approved REVIEW path, or narrow the
    contract if product policy rejects it. KEEP remains the automatic gate.
5. Enforce `authenticated_search` consent at execution time as well as source
    enablement.
6. Keep non-conflicting scheduling slots and ask for new availability only when
    every proposed slot conflicts.

P0 items 1 through 3 block every release. Items 4 through 15 block the v0.16 QA
restart unless a narrower product decision explicitly removes the affected
surface. Cleanup findings about the 4,378-line intent function, duplicate route
helpers, mixed dependency injection, and sequential scanners remain ranked
maintenance work, not correctness fixes to mix into this pass.

All 15 confirmed correctness findings are closed on the v0.16 runtime-parity
branch. Focused regression evidence passes 506 backend and domain assertions
plus 63 web assertions. Coverage includes gate-forgery rejection, trusted send
provenance, pre-navigation apply consent, evidence validation, shared exclusion
matching, per-application browser serialization, exact Orca ref verification,
both checkbox states, false-value preservation, update-toggle rollback, stale
REVIEW approval invalidation, authenticated search enforcement, and partial
scheduling conflicts. The cleanup-only findings remain in the maintenance
queue.

### Security queue checkpoint (August 25, 2026)

- CodeQL path-injection alerts 119 through 121 were dismissed as test-only. They
  are confined to the loopback-only
  fixture server. Its canonical-root, traversal, prefix-sibling, symlink, NUL,
  and malformed-URI boundaries have five passing regression tests.
- The Docker base image is pinned by digest and the image installs only root
  production dependencies. Its clean build and help-command smoke passed. Main
  and dev protection now require pull-request branches to be up to date; the
  live main ruleset matches the checked-in guard.
- The repository-age Scorecard alert was dismissed because repositories under
  90 days are explicitly unscorable, not because maintenance was waived. Recheck
  after September 23, 2026. The missing OpenSSF Best Practices badge was
  dismissed as governance follow-up, not a code vulnerability.
- Property-based fuzzing now exercises ACP permission decisions, isolated-read
  containment, and the public/private URL boundary. Keep the Scorecard alert
  open until the next main-branch scan recognizes the new fast-check coverage.
- Alerts 108, 109, and 111 remain open only until a main-branch Scorecard run can
  observe the live protection and the two staged repository fixes.

## Release status (v0.16.1, updated August 25, 2026)

**v0.16.1 is the current release line.** It preserves the v0.16.0 runtime and
workflow release, fixes the hosted-access email and send alignment, removes one
redundant runtime-marketing sentence, and restores calmer website section
spacing. The v0.16.0 signed Mac app, npm package, Homebrew cask, and production
website passed the release and installation gates above.
Since v0.11.0 the repo runs the strict flow: feature PRs land on the active dev
branch (`dev/v0.16` for this release), `main`
advances only through a promotion merge immediately before each cut, and the tag
fires the whole pipeline — `desktop-release.yml` builds, signs, notarizes, and
uploads the DMG, publishing the release then fires `publish.yml` (npm) and the
tap's own cask updater. `publish.yml` fires on a published GitHub Release, not
on a tag push, so tagging alone is always safe. `CHANGELOG.md` at the repo root
is the per-release record.

Version drift now has a guard. `tests/release-consistency.test.mjs` checks that
`package.json`, `apps/desktop/package.json`, and the newest `CHANGELOG.md`
heading agree. It runs both in `ci-verify.yml`'s fast `structure-guards` subset
and in the full `tests` job, and both are required contexts, so it cannot be
skipped.

A Homebrew cask now exists and is available: `brew install --cask
codeswhat/tap/careerrat`. PR #4 on `CodesWhat/homebrew-tap` merged August 19,
2026. `scripts/generate-homebrew-cask.sh` now generates the cask body
(version from `package.json`, `sha256` from the published or a local DMG),
closing the generator gap. Opening the tap PR is no longer a manual step
either: `CodesWhat/homebrew-tap` carries its own `update-careerrat-cask.yml`
workflow (cron plus manual dispatch) that watches the latest published
release, runs the generator, and commits the bump to its own `main` with
its own `GITHUB_TOKEN`, so no cross-repo credential exists anywhere. On this repo's
side, `.github/workflows/desktop-release.yml` builds, signs, notarizes,
uploads, and publishes on a tag push. The one-time CI signing secrets setup
documented in `docs/RELEASE.md`'s "One-time CI signing setup" section is done;
the pipeline still fails fast with a clear list if a secret is ever removed or
rotated away.

At the v0.15 cut, stale branch cleanup reduced `origin` to `main`. The branches
`fix/v0.7-publish`, `dev/v0.7`, `archive/dev-2026-07`, and
`release/careerrat-0.5.2` were deleted after verifying each had zero commits
absent from main (the 0.5.2 one is still permanently reachable via tag
`v0.5.2-careerrat`, which points at the identical SHA).

The local-only branch `backup/pre-public-history` is gone. It held pre-scrub
history containing owner PII and was deliberately kept off `origin` for that
reason. On 2026-08-20 the repo directory was deleted and re-cloned, taking the
branch with it; it never existed anywhere but that local clone, so it's
unrecoverable. That's not a leak: losing the branch removes the PII copy
rather than exposing it. Any doc or instruction that still refers to
`backup/pre-public-history` is describing history, not current state.

### Landed on main since v0.10.0

Thirty-three PRs, all merged, with the v0.15 release branches and worktrees
cleaned up. The first sixteen (#106 through #123) are below; the rest (#126
through #145) came out of the August 20 queue and are recorded lane by lane under
[The queue](#the-queue-opened-august-20-2026), since what each one turned out to be
matters more than that it merged.

Three issues are open, all accounted for: #180 holds the below-cut remainder of the
v0.12 whole-app review (its fixes merged in #197 and it closes with the v0.13.0
promotion), #148 tracks the star
chart's one leftover limitation (the shared refresh workflow can't push to a
PR-required dev branch; the adoption itself landed in #169/#187/#188), and #11 is
Renovate's Dependency Dashboard, which is permanent by design and is not a task.

- **#106, #112**: Playwright live harness, then custom combobox dropdowns in
  `playwright-ops`. The dropdown fix closes two real traps: an empty target value used
  to fall through to substring matching and click whichever option happened to be
  first, and a type-to-populate control could not be verified by reading its display
  value back, because the code had already typed the target text into the box itself.
  Selection is now confirmed by the display value *changing* or the option list
  closing, never by matching text the code put there.
- **#108**: the extension provider stops claiming automatic-apply support it does not
  have. `automaticApplyGap()` in `src/core/automation/session.mjs` is the single
  core-layer verdict; the CLI and the executor factory both format that one result
  instead of each carrying their own wording, which is how the two messages drifted
  apart. It deliberately never names a replacement provider.
- **#109, #123**: the full test suite runs in CI, then becomes a required context.
- **#110, #113, #116, #118**: update-check race, lockfile version drift plus a guard,
  AskBar comp-intent classification, and copy-format compatibility.
- **#114**: `protect-main.sh` fails on drift between the file and the live ruleset,
  and actually prints its remediation advice when it does.
- **#117 split into #118 through #121**: the em-dash sweep across user-facing CLI,
  core, provider, and app copy. Comments and LLM prompt strings keep theirs; the ban
  is on copy a person reads.
- **#122**: the old phase-tracking planning scaffolding is gone, 225 files, including
  `.planning/phases/` and `STATE.md`. `QA-ACCEPTANCE.md`, `architecture/`, and
  `archive/mockups/` stayed, the last two because tests read them.

### Picking this up cold

**v0.9.0 shipped with no `.dmg` attached.** The artifact was built, signed, and
notarized locally, but never uploaded, so for a while the Release page offered
nothing to download. It has since been uploaded and the Release is whole. The
process hole is closed in #101: `npm run desktop:release` builds and uploads in one
command, `release-assets.yml` fails any published release missing a version-matching
`.dmg`, and `docs/RELEASE.md` now creates the Release as a **draft** first so the
publish event (which is what fires `publish.yml`) cannot happen before the artifact
exists. The detector runs alongside `publish.yml`, not before it, so the draft-first
ordering is the actual prevention, not the check.

Open work, none of it blocking the release:

- **Renovate #75 and #76 landed August 19.** An earlier version of this section
  claimed #76's Vercel build "genuinely failed" as distinct from the deploy-quota
  message. That was wrong: it was the quota (`upgradeToPro=build-rate-limit`), and
  the in-repo `web-build` job was green throughout. The `dependency-review` blip
  cleared on its own. #76 did need a Renovate rebase after #75 merged.
- **CI runs the full test suite, and it gates.** This used to be the biggest hole in
  the repo: `ci-verify.yml` ran only the structure guards, so when Renovate #76
  bumped `posthog-js` past a version literal asserted in `tests/website-copy.test.mjs`,
  CI stayed green while every push from a clean checkout started failing (fixed in
  #102 by asserting the pin's *shape* rather than one literal version). The old
  warning here read "a green CI on this repo does not mean the tests pass." **That is
  no longer true.** #109 added the `tests` job running `npm test`, #119 fixed the
  flaky SSE watcher test that made requiring it unsafe, and #123 promoted `tests` to
  a required status context in both `scripts/protect-main.sh` and the live ruleset.
  The pre-push hook is no longer the only thing running the suite.
- **A batch of PRs merged without a CodeRabbit pass.** #77 and #76 landed on CI gates
  alone. So did #108, #109, #112, #114, #119, #120, #121, #122, and #123, which were
  merged on August 19 to 20 after the shared CodeRabbit budget ran out for the period
  (it resets September 1). Each of those got an agent review pass instead, with the
  findings and the trace posted on the PR. Re-review if you want the
  every-change-reviewed rule held to the letter.
- **QA re-runs are done.** `research-company`, `research-comp`, `research-boards`, and
  the `discover-companies` fourth leg were all re-run August 19, 2026 against a live
  installed Claude Code CLI runtime, with every write confirmed in durable storage and
  verified across a server restart. The record is in `.planning/QA-ACCEPTANCE.md`.
  G-09 was decided (rehydrate on reload) and shipped in #159; its decision record
  is checked off in `.planning/QA-ACCEPTANCE.md`.
- **Security hardening, partially landed:** the two GitHub-only jobs in
  desktop-release.yml run harden-runner in `block` mode with an allowlist built
  from the v0.11.0 runs' audit traces (#155); the macOS build job and every
  other workflow stay in `audit`, because Apple's notarization traffic rides
  rotating Akamai edge hosts that a static allowlist would break. The SBOM gap
  from #73 is closed: every published release now carries an SPDX SBOM asset,
  generated by sbom.yml (#154; syft, not `npm sbom`, which refuses this repo's
  vite version skew). The last two #73 items are closed too: npm publishes have
  carried OIDC provenance attestations since June's publish.yml (0.11.0 verified
  with a SLSA v1 attestation on the registry), and release tags now sign with the
  repo-local SSH key registered on GitHub as "CareerRat release signing", so the
  next release tag renders Verified.

### Review lanes, and which to use

There are two ways to get a CodeRabbit review, and they differ in speed and in what
they leave behind. An earlier version of this section claimed they draw on separate
budgets. **They do not.** On 2026-08-19, exhausting the CLI lane also rate-limited a
`@coderabbitai full review` on a PR, with both reporting the same included-review
pool and the same reset time. Plan around one shared budget. The rate-limit message
always states when the next review frees up.

- **PR lane** (`@coderabbitai full review` as a PR comment): posts inline threads on
  the PR, so it leaves a durable record. Slower to come back.
- **CLI lane** (`coderabbit review --committed --base main` from a worktree on the
  branch): finishes in a couple of minutes, which makes it the one to reach for on
  mechanical changes. It leaves no PR comment, so note the outcome yourself if the PR
  needs a record.

Worth knowing: the two lanes do not find the same things. On #99 the CLI returned 4
findings and the PR lane independently returned 4 more that the CLI missed, including
a non-atomic state write that would silently re-enable a feature the user had turned
off. On a change where correctness matters, running both is not redundant.

The CLI paces better than the PR bot on the same budget: it reports "3 included
reviews currently available" with a 20-minute wait, against the bot's roughly one
review every 34 minutes. It also reviews `package-lock.json`, which the bot's path
filter drops. Two traps when checking whether a review actually landed:
`gh pr view --json comments` reports the author as `coderabbitai` while the REST API
reports `coderabbitai[bot]`, so filtering on the wrong one silently returns nothing;
and the only reliable marker of a real review in the body is `walkthrough_start`.
"Actionable comments posted" never appears, and "rate limit" matches inside real
reviews too, from the tips block.

**The budget is exhausted for this period and resets September 1, 2026.** Everything
merged after August 19 went through an agent review pass instead.

### Gating posture

`main`'s ruleset now requires nine status contexts: the eight promoted from
`structure-guards` alone in #96 (`structure-guards`, `gitleaks`, `zizmor`,
`actionlint`, `analyze (javascript-typescript)`, `dependency-review`, `qlty`, `knip`)
plus `tests`, promoted in #123. Two failures are expected and never gate:
`qlty check` (Qlty Cloud minutes, distinct from the in-repo `qlty` job) and `Vercel`
(deploy quota). Any other red is real.

Two jobs run without gating: `web-build` and, since 2026-08-20, `website-build`. The
second exists because nothing was building the marketing site or the docs at all. A
TypeScript 6 bump turned `baseUrl` in `apps/docs/tsconfig.json` from a deprecation into
a hard error, the docs build broke on `main`, and every in-repo check stayed green. The
only signal was the `Vercel` context, and that one fails on deploy quota so routinely
that a real failure there reads as noise. Which is the general lesson: an expected-red
check is not a check. If a context is allowed to fail every day, nobody can tell the day
it fails for a new reason, so the coverage has to live in a job that is normally green.

`scripts/protect-main.sh` declares that set and `--verify` compares it against the
live ruleset. Since #114 that comparison is trustworthy: the drift report used to die
mid-print, because `diff | sed` under `set -euo pipefail` returns non-zero whenever
the inputs differ, so `set -e` killed the function right after the diff and swallowed
the remediation block, including the warning not to delete and re-create the ruleset.
Never toggle, disable, or weaken protection to land something. Clear
`REVIEW_REQUIRED` by approving with a non-author account instead.

## In progress / up next

The web app is the daily development surface. The conversation-first product and packaged
Electron runtime have completed the acceptance sweep below, including the macOS distribution
gate:

### The queue (opened August 20, 2026)

This is the working queue. It is here, not spread across GitHub issues, because a queue you have
to reassemble from an issue list is a queue nobody works through in order. Each lane links its
issue for the detail; this section owns the sequencing and the reason.

Lanes 1 through 3 are file-disjoint and run in parallel. Lane 4 runs last on purpose: it edits
files across every other lane, so running it concurrently buys nothing but merge conflicts.

**All four lanes closed on August 20, 2026.** What actually happened is below each lane, because
the gap between what a queue item predicted and what the work turned out to be is the part worth
keeping. Three of the four were not where the issue text pointed.

1. **Ask error handling** ([#88](https://github.com/CodesWhat/careerrat/issues/88),
   [#86](https://github.com/CodesWhat/careerrat/issues/86)). Two bugs on the daily surface.
   #88: a deliberate server-side refusal ("only pending supported ATS proposals can be approved")
   renders as a generic "Something went wrong, failed to fetch" banner, so a business rule reads
   as a network outage. #86: the per-process capability credential is re-minted on every server
   start, the file watcher restarts the server whenever a concurrent CLI write touches
   `workspace/tracker.json`, and the resulting 401 collapses an entire in-progress review card,
   discarding the other pending recommendations and the Finish-review button. A page reload
   recovers, which is the tell that only the credential was stale and the state was fine.

   **Landed in [#127](https://github.com/CodesWhat/careerrat/pull/127).** #88 was not a banner
   bug. The server already put the specific message on the wire and propagated the 422 correctly.
   The defect was one field: `assertApprovalAllowed` threw with the shared `VALIDATION_FAILED`
   code, which the same file uses for ordinary schema checks, so `errorCopy.js` had nothing
   specific to match on. It deliberately never shows raw server strings as the primary message,
   so the refusal fell through to the generic text. The refusals now carry
   `COMPANY_PROPOSAL_NOT_APPROVABLE`. #86 was two independent frontend defects, one per fix
   direction on the issue: no retry path existed at all, and `commitAction` overwrote the turn
   slot at the start of the request so the error branch returned before the artifact render.
   Found on the way out: the two onboarding surfaces call the same endpoint with no catch at all,
   so they can't reach even the generic banner
   ([#128](https://github.com/CodesWhat/careerrat/issues/128)).
2. **Multi-step ATS advancement.** The last `partial` row in the skill audit. Easy Apply is
   covered; other paginated ATS wizards are not. The interesting problem is confirming you
   actually advanced a step rather than seeing the page re-render, which is the same trap #112
   hit in the small when a combobox confirmed selection by reading back text the code had typed
   itself. The manual Submit boundary and verified-only Applied write-back are non-negotiable.

   **Landed in [#129](https://github.com/CodesWhat/careerrat/pull/129).** One loop now runs for
   every provider; a single-page form falls out of it naturally when no advance button is found.
   The re-render trap was the predicted problem and it was the easy half. The two real hazards
   only appeared once the loop stopped being LinkedIn-only. First, the advance labels include the
   bare word "continue", so "Continue with LinkedIn" matched, wasn't disqualified by the
   submit/send tokens, and would have driven a supervised browser onto a third-party auth page.
   Second, label matching cannot see where a button goes, and the fingerprint check passes for
   any page change including a navigation off the application entirely, so the loop now blocks
   when the hostname changes across an advance click. Both were found by reading the generalized
   code, not in the field. The `apply-job` row moves from `partial` to `native`.
3. **Standards adoption** ([#73](https://github.com/CodesWhat/careerrat/issues/73)). npm build
   provenance, signed release tags via a tag ruleset (commit signing deliberately not required),
   and the README community routing sentence. Item 3 of that issue, making the full test suite a
   required gate, already landed early in #123 and closes without further work.

   **Landed in [#126](https://github.com/CodesWhat/careerrat/pull/126).** `scripts/protect-tags.sh`
   mirrors `protect-main.sh`, including the three-way `live_ruleset` exit split (found, absent,
   lookup failed) so a network blip never announces that tags are unprotected, and the #114
   pipefail fix so the drift diff can't kill the remediation text. Applied live: ruleset
   `21092221` blocks deletion, update, and non-fast-forward on `refs/tags/v*` with no bypass
   actors. `required_signatures` is deliberately absent, matching the ops standards walk-back of
   2026-08-17: Actions-minted tags cannot carry verifiable signatures without real key
   management, and the Cosign artifact chain is the signature of record.

   Both scripts now run weekly from `.github/workflows/quality-ruleset-drift.yml`, plus on
   demand via `workflow_dispatch`. Non-gating on purpose: it never runs on a pull request, so a
   credential blip or real drift can't freeze a contributor's merge.

   This was first recorded here as blocked on "a credential with admin read on the rulesets
   API", and that was wrong. Rulesets are world-readable on a public repo, verified against this
   one with an unauthenticated request that returned the full rule list, so the default
   `GITHUB_TOKEN` is more than enough and no secret is stored. The false trail was assuming a
   permission scope existed: `administration` is not available to `GITHUB_TOKEN` at all, and
   actionlint rejects it outright. Worth remembering as a pattern, since the gap sat open on a
   guess about an API nobody had actually called. This does depend on the repo staying public;
   going private turns it back into a credential problem.
4. **Knip backlog** ([#81](https://github.com/CodesWhat/careerrat/issues/81)). The `--max-issues`
   ratchet sits at 170 and hides new dead code behind existing debt. One unused file, four unused
   dependencies, one duplicate export alias pair, and 164 unused exports that mostly want
   de-exporting rather than deleting. Target is a ratchet of 0 and a plain `npx knip` gate. **The
   ratchet goes down, never up.**

   **Landed in [#130](https://github.com/CodesWhat/careerrat/pull/130) through
   [#133](https://github.com/CodesWhat/careerrat/pull/133), ratchet lowered in
   [#135](https://github.com/CodesWhat/careerrat/pull/135) and again in
   [#142](https://github.com/CodesWhat/careerrat/pull/142) and
   [#145](https://github.com/CodesWhat/careerrat/pull/145): 170 to 44 to 32 to 30.** Split into
   four file-disjoint lanes. The unused file, the duplicate alias, and 135 exports are gone,
   including 500 dead lines in `tracker/dashboard.mjs` (four builders with no caller anywhere, in
   a file with twenty-plus importers).

   The target of 0 was wrong, and that is the useful finding. The 30 that remain are not debt.
   Four are fontsource packages both Next apps load by raw file path through `next/font/local`,
   which knip cannot see and which break the typeface silently if removed, exactly the trap #81
   warned about. The other 26 are exports named by a skill, doc, comment, or dynamic
   import with no JS importer: `SAFE_EXTERNAL_PROTOCOLS`, the SSRF guards in
   `public-http-fetch.mjs`, `RECRUITER_FARM_PHRASES`, `ATS_ROUND_RULES`.

   The 14 unimported `api.js` client functions were recorded here as an unwired feature surface
   worth preserving ([#134](https://github.com/CodesWhat/careerrat/issues/134)). **That was
   wrong**, and it is the second time in this queue a lane's premise did not survive contact with
   the code. Probing each wrapper against its route showed six are stale duplicates of paths the
   app already reaches another way, and `researchCompany()` had drifted from the live caller's
   entity shape, so keeping it would have left the wrong contract sitting in the file looking
   authoritative. Twelve deleted in #142.

   The two kept, `checkAiKey` and `getDiscoveryState`, called routes that really were orphaned,
   and both are wired in #145, which is what took the ratchet the last two down to 30. The
   discovery one was a real restart guarantee the onboarding contract already claimed and did not
   hold: `CompletionScreen` only ever learned about a discovery session from the POST that started
   it, so a reload mid-discovery sent the candidate back to the pre-discovery button while the
   server still had the session. `GET /api/discovery/state` existed for exactly that and had never
   been called. The other added a Settings control to test an already-saved AI key, which also
   made `errorCopy.js`'s `missing_key` rule reachable for the first time.

   [#141](https://github.com/CodesWhat/careerrat/issues/141) closed with those two, because the
   rest of what it listed is not a gap a candidate can feel. Each is one small wire-it-or-delete-it
   decision, and they live here now rather than in an open issue nobody reads:

   - `POST /api/boards/preview` is a backend built for a Targeting-step preview affordance that
     was never wired. The wizard's only board call is a direct `addBoard()`.
   - `POST /api/onboard/quick-start` seeds AI search prompts and gates on `search_ready`, but the
     wizard starts the first search through `POST /api/sourcing/first-run/start` instead. Nothing
     is broken, since the sibling satisfies the readiness gate, but two routes that both "start
     the first search" differently is the kind of thing that gets found during an incident.
   - `GET /api/logos/search` has no logo picker to serve. Company logos go through the unrelated
     and heavily used `logoImageUrl()`.
   - `GET /api/intake/one` is REST symmetry, not a missing feature. The only intake surface
     renders from the bulk list response and there is no per-item view to deep-link to.
   - The retired web config-export endpoint is gone. `careerrat ingest --write-config` remains an
     explicit CLI recovery/export command and does not expose a second app product path.

   So reaching 0 means teaching knip about the remaining references, not deleting them. Anyone who
   closes the gap the other way has made the number prettier and the product worse. That reasoning
   is in the workflow comment, not just here, because the ratchet is where the temptation lives.

**Three things the queue surfaced that are not lanes, all closed the same day.**

The `tests` gate went required on 2026-08-20 and immediately flaked on the db-concurrency test,
turning the new merge gate flaky on its first day
([#136](https://github.com/CodesWhat/careerrat/issues/136)). Fixed in
[#139](https://github.com/CodesWhat/careerrat/pull/139): SQLite's busy handler defaults to no
retry at all until `PRAGMA busy_timeout` runs, and `applyPragmas` was issuing
`journal_mode = WAL` first, so the one pragma most likely to contend was the one running with
zero retry protection. Reordering `busy_timeout` to the front fixes it. `tests/db-pragma-order.test.mjs`
guards the ordering behaviorally, through the real `openDb()`, so a future refactor that moves the
line back gets a named failure instead of an intermittent one.

The onboarding surfaces called the proposal-decide endpoint with no catch at all, so a failed
accept or reject silently did nothing ([#128](https://github.com/CodesWhat/careerrat/issues/128)).
Fixed in [#140](https://github.com/CodesWhat/careerrat/pull/140), which resolves the error through
the same `resolveErrorCopy` path the rest of the app uses and renders it inline on the row that
failed, not as a page-level banner.

And the `ci-verify.yml` header claimed `qlty` and `knip` did not gate merges when both are
required contexts, which is the exact failure that same comment warns about two lines later. Prose
has no drift guard. Fixed in #135, which now tells the next reader to re-read the live ruleset
instead of trusting the paragraph.

**The one open item the queue surfaced is now closed.** `profile.enrich` was declared as a
workspace intent (`WORKSPACE_INTENT_ENTITY_TYPES` in `src/core/agent/workspace-thread.mjs`) with
the user-facing label "Enrich my profile", but it had no entry in `EXECUTABLE_INTENTS` in
`workspace-agent.mjs`, so choosing it threw "workspace intent is not implemented yet". History
showed it was dead on arrival (declared in the runtime's first commit, never implemented in any
commit since) and no enrichment backend exists to wire it to, so #153 removed the offer rather
than fabricating an executor. The durable part of the fix is a drift-guard test asserting every
offered intent is implemented, so an offered-but-unimplemented intent is now a named test
failure instead of a runtime throw in front of a user.

### Skill-to-screen product coherence gate (active August 14, 2026)

The completed acceptance sweep proved the released surfaces and distribution artifacts. A
broader behavior audit is now active: [`.planning/SKILL-UX-AUDIT.md`](../.planning/SKILL-UX-AUDIT.md)
maps every original CareerRat skill to its natural-language entry, visible progress, confirmation
boundary, durable result, and next action. Backend or external-agent availability alone does not
count as native app support.

The current build order is:

1. **One onboarding graduation contract (implemented and accepted)** — as soon as Paul has a resume/no-resume decision,
   target roles, and a usable location posture, generate baseline deterministic sources and start
   sourcing in the background while the interview continues. Paul covers the settings needed for
   the candidate's intended workflows. The app cannot graduate setup until source config is durable
   and the first search is running or completed. If that cannot happen, Paul offers a durable pause
   with the exact reason and a resume-from-here action, but keeps the app gated. A user must never
   reach Jobs and see "No search sources set up yet" or be told to repair onboarding in Settings and
   reload. The release check for this contract must prove all of the following on a clean home and
   again after restart:

   - source generation and the first search begin at minimum search readiness, before the rest of
     Paul's interview is complete;
   - every search-ready target, including local and non-tech roles, receives at least one bounded,
     zero-auth deterministic source so a valid profile cannot graduate into source repair;
   - every setting required by the candidate's enabled workflows is confirmed or explicitly
     deferred inside Paul's thread;
   - Paul never claims a fact is saved unless it is already canonical or the same response exposes
     the confirmation that writes it, and every confirmation targets a field the owning schema
     actually supports;
   - one flat compensation floor or valid arrangement-specific floors satisfy the same readiness
     contract used later by job evaluation;
   - failed or unavailable setup work offers retry, guided repair, and a durable **Pause setup**
     checkpoint that resumes at the same item;
   - unreadable setup state fails closed to Paul, and a pending source read never flashes a false
     zero-source error; and
   - the main app opens only after usable source config is durable and the first search is running
     or completed, with progress or results already visible;
   - entering the app commits one server-verified graduation boundary, stamps setup complete only
     after that commit succeeds, and prepends the bounded Paul transcript to the canonical Ask
     thread without duplicating it on retry or losing search work already in progress;
   - `careerrat start` and update/relaunch paths compare the live `/api/health` version with the
     installed version, safely replace only the recorded CareerRat-owned server when it is stale,
     and never accept an old in-memory app just because port 7777 returns HTTP 200; and
   - a clean install, an in-place update with a running old server, and a full restart all preserve
     the same graduation gate and never expose retired setup copy.

2. **Ask orchestration** — make short job URLs, "rate this job," "apply to this job," natural job
   references, recruiter updates, and settings requests resolve to visible typed workflows instead
   of answer-only chat. Rating captures the JD, evaluates it, saves the verdict, renders the result,
   and offers the correct next action. Applying chains evaluation, promotion, packet generation,
   unresolved questions, confirmation, supervised execution/manual handoff, and verified outcome
   write-back in the same durable thread. Short URLs, explicitly open saved jobs, pasted or
   extracted attached JDs, and deterministic natural saved-job references now enter the native
   workspace flow. JD intake saves the full body, evaluates it, renders the structured result, and
   preserves an explicit rate/apply request as a separate confirmed intent. Direct apply intake now
   returns the evaluation, generated packet, and supervised site handoff in Ask. Missing and
   ambiguous references fail visibly instead of guessing. They never mark Applied without
   confirmation. Standalone résumé, cover-letter, and application-material tailoring now resolves
   a URL, the open job, or one named saved job, evaluates it first, generates only on KEEP, and
   returns review/export actions without implying submission. Automatic session-browser selection,
   the connected Orca executor, rendered-form capture, deterministic field/file filling, blockers,
   manual Submit boundary, confirmation re-scan, and screenshot evidence are now wired.
   Clean-home packaged acceptance of the AI-backed apply chain for pasted and attached input
   passed 2026-08-17; it found and fixed one gate/status resync defect on the attach-path dedup
   onto an existing application row. Remaining work is multi-step ATS advancement. The rating flow's
   packed acceptance now completes URL, open-job, named-job, pasted-JD, attached-JD, and
   ambiguity-recovery paths through durable verdict state. Greenhouse and Ashby
   question schemas are captured before packet generation; other ATS forms now use a durable
   in-Ask paste-and-resume path that can retry answer generation without losing the saved questions.
   Packed Greenhouse acceptance now proves the packet reuses onboarding facts instead of asking
   the model or user for standard form fields, treats the generated résumé as the upload artifact,
   leaves unresolved optional fields blank, and reports one plain-English action per required
   unknown. A real 19-field Anthropic rebuild reduced 26 duplicated internal validation messages
   to four human review actions while keeping the application in Reviewed Hold. It also fixed
   relocation, hybrid-office, and notice-period autofill and removed a false private-compensation
   warning from location wording.
   Packed Universal Intake acceptance now covers pasted and attached JDs too. Pasted Apply
   can evaluate and build the packet without pretending a missing site can be opened, then
   asks for the application link as a typed next action. Attached Apply preserves the user's
   intent, resolves an existing tracked job, and stops at REVIEW without generating or
   submitting. “Prepare/build/generate the application” phrases share the same confirm-first
   path as “apply/submit.”
   Explicit natural outcome reports now resolve
   one saved application and write the typed transition in the same Ask thread; ambiguous or
   missing references stop with specific clarification copy and no mutation. Natural recruiter
   requests now resolve one communication for an AI-backed reviewable draft or a user-reported
   sent write-back. Natural interview-prep requests resolve one interview application, build the
   saved-JD dossier, and return an immediate deep link in Ask. Explicit one-off application and
   screening questions now route through the existing evidence/honesty answer engine, render a
   review card in Ask, never imply submission, and expose a separate save confirmation only for
   recurring disclosure answers; employer-specific prose is never persisted as a global default.
   Headed isolated-home acceptance passed through the real backend, confirmed the DB write and
   durable workspace receipt after a full server restart, and produced no browser warnings or
   errors. A clean npm-package install then passed the same draft, review/save, restart readback,
   durable thread, and shipped-UI checks.
   The remaining communications gap is connected verified sending, not reference resolution or
   durable draft/sent-report state.
3. **Company thesis, not a company allowlist (implemented, acceptance in progress)** — Paul asks about companies or kinds of companies
   whose values, industry, size, stage, business model, or local presence the user likes. He turns
   answers such as fintech, large corporations, fast-food chains, or small Denver accounting firms
   into reusable discovery signals. Named employers are priority examples; all non-excluded
   companies remain fair game. Manual focus seeds and broader discovery must run together, leaving
   the answer blank must still discover companies, and discovery refreshes after setup instead of
   becoming a one-time step. Ask now accepts natural company-discovery requests, returns reviewable
   proposals with Track/Skip confirmation, and preserves every decision in the workspace thread.
   Manual job sweeps start immediately, then refresh discovery weekly or whenever the targeting
   thesis changes. An unresolved proposal batch is reopened instead of duplicated.
4. **Original-skill native parity** — every user-facing original skill gets an Ask entry and
   contextual shortcut where useful, deterministic entity resolution, visible work, safe decisions,
   a durable linked result, and the next handoff. Internal extraction helpers stay internal but must
   expose progress and errors through the invoking workflow. Post-setup job-board discovery now has
   a typed Ask entry that stays distinct from an ordinary source sweep, embeds the guided
   `research-boards` session in Ask, preserves Add source/Skip confirmation, and links approved
   source work back to Jobs and Settings. Natural source setup now recognizes explicit board-URL
   imports, keyword-search additions, and named source enable/disable requests; the Ask preview is
   the confirmation boundary, writes reuse validated SQLite source config, duplicates are no-ops,
   and the durable receipt returns to Jobs or Settings. Natural application outcomes and interview
   prep now satisfy the same typed, durable Ask contract. Recruiter drafts and reported sends also
   use that contract. Email-comms now additionally handles a free-text note-capture request
   (durable note receipt in Ask) and a supervised send handoff: a read-only card with the thread's
   draft prefilled into mailto/Gmail/Outlook compose links and an "I sent this" confirm, never an
   automated send. Recording a send now distinguishes three verification tiers: `verified`
   (executor-confirmed, still gated behind a not-yet-connected delivery executor), `supervised`
   (CareerRat prepared the draft and the candidate confirmed sending it), and `user_report` (a bare
   self-report). `communication.send` now also refuses non-email-channel threads before
   checking for an executor. An in-browser compose executor that would reach `verified` sends
   directly was evaluated and deferred behind recorded entry criteria (keystroke-safe compose-DOM
   handling, per-account Sent-folder verification, and a distinct Sent-folder read consent
   capability); recipient provenance, the prior open blocker, is now solved. Packaged acceptance
   for the note-capture, handoff, and verification-tier changes passed 2026-08-17. One-off
   screening answers now satisfy
   the same contract with review-before-reuse persistence. Company research, comp benchmarking, and
   company health now satisfy the same typed Ask contract too: natural requests resolve through a
   shared company reference resolver into either a fresh cached result rendered immediately or an
   embedded supervised research session, with cited dossiers, benchmarks, and ratings each carrying
   an explicit refresh action. Company-health ratings also gained a single validated writer,
   `companyHealthSet`, reached through two entry points — the dry-run-default CLI (`careerrat
   health record`) and the confirm-first `company.health-record` intent for shell-less embedded
   sessions — replacing the prior hand-patched write, and now render in the Jobs drawer alongside
   the existing row badge. Headed isolated-home acceptance
   passed on 2026-08-15 against the real server: routing, cached-result reuse, the health write
   path through to the drawer, ambiguity and missing-input recovery, confirmed saves with the
   private-comp refusal, clean no-AI degradation, and restart durability all held with no server
   errors. Packaged and live-AI-runtime acceptance on 2026-08-17 found and fixed a real regression
   (the installed-CLI chat path could not load its own skill, so no session could save a result;
   `F-103`/PR #84) and closed company-health's row fully, including the CLI and chat-equivalent
   write paths, the Jobs drawer badge, and the Activity Pulse event. research-company and
   research-comp were separately blocked by the installed runtime's 120s timeout on long turns
   until PR #92 widened it to 9 minutes; both rows closed on the 2026-08-19 re-run against a live
   installed CLI, with every write confirmed in durable storage and read back across a restart.
   Search-strategy review now satisfies the same contract too: natural
   phrasings ("review my strategy," "why am I getting filtered out," "what's working in my
   search") resolve to a typed `strategy.review` intent, and the Dashboard's Strategy panel's
   review-trigger CTA submits that identical intent into the durable Ask thread instead of a
   same-page reveal. The server assembles funnel, targeting, fit-band, and comp-target/floor-only
   context deterministically before drafting findings and recommendations with one bounded,
   non-agentic AI call, reusing the dashboard's own review-signal freshness gate so a review with
   nothing new since the last stamp returns a run-anyway state instead of a duplicate draft. Each
   recommendation applies individually and confirm-first through `strategy.apply`, routed to the
   same validated gate, comp, fit-band, and learning writers Settings and the CLI already use —
   writing-style suggestions stay present-only, with no automated writer — and `strategy.stamp`
   records the finished review and clears the dashboard nudge. Headed isolated-home acceptance
   passed 2026-08-15; packaged acceptance and a live run against a real AI runtime both passed
   2026-08-17. A capability-cookie dev-restart recovery gap found in the live-AI pass is tracked as
   an open issue, not a blocker for this row. The remaining original-skill rows stay tracked in the
   linked audit.
5. **Free/public source parity before AI (implemented and accepted)** — the pinned manifest
   accounts for all 78 Career Ops provider modules: 77 public-network adapters run through the
   deterministic registry, and `local-parser` is intentionally excluded with a safety reason.
   URL inference, explicit branded-host selection, normalized output, upstream conformance fixtures,
   scanner dedupe, full-JD hydration, and source provenance are wired. AI remains the fallback for
   discovery gaps and ambiguous/custom pages, not the default repeated scan path. Clean packed-
   install CLI and Settings acceptance now covers the manifest and UI-facing source-write path.
6. **Fresh acceptance pass (current tranche complete)** — clean-home onboarding, restart, Ask
   rate/apply, provider Settings, native Electron, npm install, lint, tests, and builds pass. The
   packed supervised-Apply pass now also proves automatic Orca detection, known-field filling,
   manual Submit, confirmation screenshot capture, and verified-only Applied write-back against a
   controlled local form. The broader original-skill rows stay active in the linked audit instead
   of being hidden by this gate.

### Product-surface acceptance sweep (updated August 17, 2026)

The live result ledger is [`.planning/QA-ACCEPTANCE.md`](../.planning/QA-ACCEPTANCE.md); this
section remains the release-level source of truth. All 103 recorded findings are fixed and
live-retested. The broader skill-to-screen audit above remains active until every user-facing
original skill has a coherent native path.

Current verification: 2,615 repository tests passed with 5 intentional skips; 711 web tests passed;
lint completed with no errors; web, website, docs, and desktop builds passed; and the final 545-file
npm tarball installed into a clean home without lifecycle warnings. The clean setup, background
search, restart, Ask rate/apply, provider Settings, and source Electron checks produced no HTTP or
console errors. The previously accepted desktop release flow signs and notarizes both the app bundle
and DMG container, staples the ticket, and passes Gatekeeper.

- **Global shell and workspace conversation** — navigation, setup gating, Ask on every route,
  durable history, attachments, cancel/retry, confirmation gates, activity notifications,
  error recovery, reload/restart behavior, fixed-window and full-screen layouts, and keyboard use.
- **Onboarding** — installed-runtime selection; résumé PDF, DOCX, text, no-résumé, retry, and
  resume-later paths; progressive Paul notes; manual checklist escape hatch; completion truth;
  first search; and a clean restart at each checkpoint.
- **Home** — setup readiness, focus item, pipeline summary, next actions, activity state, deep links,
  empty/loading/error states, and immediate consistency after writes elsewhere in the app.
- **Jobs** — search and filters, sourced Promote/Skip, drawer actions, full-JD capture, evaluation
  KEEP/REVIEW/CUT, compensation and fit display, document generation/export, application outcome
  writes, interview scheduling, communications, stale-link handling, and every preview/close path.
- **Calendar** — week/month navigation, busy blocks, interview and follow-up dates, timezone and DST
  handling, empty/loading/error states, deep links, and write-through consistency with Jobs.
- **Network** — company/contact search, detail drawer, communication history, relationship capture,
  empty/loading/error states, and links back to the owning job or conversation.
- **Library and Deep Ingest** — evidence, stories, role signals, writing voice, honesty boundaries,
  source provenance, edit/remove/confirm flows, filters, empty states, and whether confirmed facts
  actually influence later evaluation and packet generation.
- **Settings** — candidate and targeting edits, graded installed-runtime capabilities, automation
  consent, source maintenance, validation and recovery, persistence after restart, and honest
  descriptions of what each installed tool can do.
- **Release surfaces** — explicit retired-dashboard behavior, CLI
  commands used by the app, docs and website links, npm-pack install smoke, packaged Electron
  navigation/filesystem/runtime ownership, quit/restart, and a clean-device first run.
- **Failure matrix** — no AI route, runtime crash/timeout/schema failure, offline and partial network,
  missing/partial artifacts, unavailable ATS links, empty search, database unavailable, concurrent
  writes, cancelled work, and restart during a long-running action. No raw stack trace, false
  success, lost user input, or unexplained dead end is acceptable.

Every row above was live-tested in a fresh home and a populated returning-user home, with each
result marked pass or fixed. All P0/P1 findings, first-day search-to-application blockers, and
distribution gates are fixed.

### QA restart gate (passed August 13, 2026)

A clean isolated-home run now covers résumé intake and retry, restart/resume, conversational
setup, first search, evaluation, packet generation, PDF export, local applied-state write-back,
and the live dashboard. The repository cleanup and full automated gates below are part of the
same release contract:

- **Installed-runtime isolation** — run bounded Claude Code tasks without inheriting unrelated
  server credentials or global MCP configuration; permit Codex only for isolated in-app chat
  and drafting; and reject Codex task-tool or research work plus every in-app spawn from other
  unverified adapters, with the actual capability error and recovery path.

The August 25 provider runtime parity checkpoint supersedes that graded runtime
posture for v0.16. The August 13 bullet stays unchanged as the record of what
that acceptance pass actually proved.

- **Résumé intake matrix** — verify PDF, DOCX, text, retry, restart, and docked-upload recovery;
  failed retries must not create duplicate uploads.
- **Plain-language permissions** — avoid implementation-mode choices. Ask for browser,
  mail, or authenticated-site access only when a concrete action needs it, and advance the
  conversation when the user confirms or declines.
- **Schema-safe Paul actions** — constrain every confirmation card to the candidate API schema,
  validate before display, keep resolved status after reload, and show field-specific correction
  guidance when a write fails.
- **Real candidate review** — Paul's File and the completion disclosure must show the saved name,
  contact details, role lanes, location modes, compensation posture, companies, evidence, and
  guardrails. Never display ambient defaults as user-confirmed facts.
- **Durable conversation** — both sides of Paul's setup thread now carry into the canonical Ask
  thread through an idempotent graduation commit, ahead of any first-search work already recorded.
  Preserve this across clean install, reload, restart, and graduation retry acceptance, and keep the
  post-completion Ask bar's result visible.
- **Discovery fallback** — company suggestions must work through the selected runtime or expose
  the server's manual/no-AI fallback in the UI without forcing the user to invent companies.
- **One completion contract** — initialize or explicitly select the canonical data mode before
  graduation. Onboarding, `careerrat doctor`, source readiness, first-search state, and the
  dashboard must agree; never say "already hunting" until a durable sourcing run exists.
- **Fresh-install regression** — automate clean-home setup through completion, first search,
  restart, and dashboard entry, with no unexpected 404/409/5xx responses or silent failures.
- **Repository hygiene** — keep the website and docs under `apps/`, design history under
  `.planning/archive`, fonts under `assets/fonts`, generated output ignored, the legacy brand
  absent from paths and content, and the repository-wide lint gate green.

- **Conversational first ingestion** — accept a résumé, learn desired jobs and hard gates,
  run an adaptive interview that asks only unresolved/high-value questions, then present a
  grouped human-readable review before writing canonical profile, evidence, targeting, and
  honesty state. Autosave raw intake locally and support resume-later.
- **First-class Ask/Work surface** — make conversation the primary app surface rather than a
  floating helper. Attachments, streaming progress, cancel/retry, actionable errors, structured
  proposals, confirmation gates, and links to resulting state all use durable local sessions.
  Onboarding is the first phase of one persistent workspace conversation, not a disposable
  setup-only chat. Contextual buttons submit visible typed intents with entity IDs into that same
  thread; the agent reloads fresh canonical state and invokes deterministic operations or
  safety-isolated skill workers internally, with every result returning to the one user-facing
  conversation. Backend foundation now persists one canonical workspace thread, prepends Paul's
  bounded setup transcript at a server-verified graduation boundary, replays its durable history
  through the selected runtime, and routes interview-prep intents/results back into that history.
  The remaining work is natural-language entity/action resolution, inline
  workflow progress and results, executor wiring, and complete skill-to-screen parity.
- **Bring-your-own authenticated CLI**: use a supported installed agent as the
  normal AI runtime. Direct and ACP adapters expose the same capability-shaped
  contract, and the packaged app never switches to a different engine or a
  direct-provider key. Managed AI remains a parked future convenience.
- **First-day outcome** — carry a new user from résumé through targets/gates and the interview
  into source setup and one strictly filtered search with a small, useful review queue.
- **QA remediation, web-first** — preserve the completed candidate-truth, local-runtime,
  consent, and strict role/location/radius sourcing fixes. Continue typed evaluation,
  artifact, capture, relationship, communication, provenance, and reliability work as it
  supports the new flow. Run packaged Electron and clean-device regression QA in the final
  integration phase rather than after every ordinary web tranche.
- **Coaching loop** — phase 1 shipped in #160: a review-gated verdict with named fit risks
  offers "Coach me on this fit", each gap gets an evidence-claim draft grounded only in
  recorded evidence (or an honest no-close-path), a confirmed draft persists through the
  standard evidence firewall, and re-score is the existing re-evaluate path. Stale plans
  are enforced against the current verdict, and drafts are framed as AI-drafted to verify.
  The design finding that scoped it: the legacy CLI scorer never reads profile or evidence
  (it scores JD-vs-targeting text match), so coaching is only meaningful against the DB/web
  AI verdict path. Phase 2+ remains open: the legacy axis (teach the deterministic scorer to
  read evidence, or a targeting-calibration variant), a comp-focused variant for below-floor
  comp verdicts, and feeding coaching outcomes into role-family learnings.
- **Search-shape eval and tiered AI cost** — decompose the upstream Career Ops search
  discipline (a cost-gated deterministic-first cascade where the model discovers leads but
  never certifies them, and every web-sourced lead gets a mandatory liveness re-check)
  against CareerRat's agent-mediated lanes, then run a staged eval: fixture-corpus
  recall/precision, LLM-vs-deterministic triage agreement on the same labeled postings, and
  a live dead-link pass. Port whichever discipline wins; the known gaps are that the AI
  web-search lane re-derives fit in prose instead of calling the deterministic scorer and
  persists survivors without a liveness re-check. In parallel, thread per-call model-tier
  selection through the installed-CLI runtime path (the small-fast tier hint already works
  for API-key users but is dropped when a subscription CLI runs the call) and pass the
  orchestrator's computed context digest to fan-out subagents instead of re-reading config
  per call. Plan and findings: `.planning/SEARCH-SHAPE-EVAL.md`.
- **Desktop public distribution** — completed August 14, 2026. The restored local Keychain profile
  and permanent `release:dmg` stage produce a signed, Apple-notarized, stapled, and
  Gatekeeper-approved DMG in one command. Runtime/path ownership, navigation, clean-device first
  run, restart, and packaged end-to-end QA also pass.

## V2 Parking Lot

These ideas are deliberately out of the current pass. Reopen them when the core
daily workflow has been dogfooded and the pain is real enough to justify the
extra surface area.

- **Voice layer** — browser speech input/output, voice-extended interview prep, and
  post-interview voice debriefs. Text conversation and adaptive setup are now current work;
  voice remains deferred until that interaction model is proven.
- **Cleanup and maintenance skill** — a shared housekeeping workflow for stale
  screenshots, browser traces, temp captures, detached logs, orphaned generated
  artifacts, and other maintenance debris. It should preview first, stay
  gitignore-aware, and preserve intentional candidate, tracker, demo, and evidence
  artifacts by default.
- **Brand-logo modernization** — refine the wordmark/mark so it feels welcoming
  and human while staying restrained, favicon-legible, and theme-agnostic.
- **Finish browser automation inside the app** — assisted Apply now has a first-class native Orca
  path. Authenticated search, message ingest, status sync, multi-step ATS advancement, and the
  extension/Playwright executor bridges still need the same visible progress and recovery contract.

## Principles

- **Runtime-neutral by default.** CareerRat runs on the supported agent CLI you
  already have. Real capability gaps appear as preflight evidence in that
  runtime's own terms, never as a provider ranking or a surprise mid-task
  refusal. Capability differences are ours to close, not the user's to work
  around.
- **Config, not code, holds your preferences.** The code stays field-neutral;
  exclusions, comp floors, role families, and board choices live in your config.
- **Your data is local and private.** Candidate files and workspace data are
  gitignored by default; comp inputs marked private never appear in any outbound
  or shareable artifact.
- **Human-in-the-loop by default.** Anything outward-facing — sending a message,
  submitting an application — is confirm-first unless you explicitly opt in.
