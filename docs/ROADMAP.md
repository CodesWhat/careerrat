# CareerRat Roadmap

CareerRat is a local, skill-driven job-search workspace. You define what you
actually want; it turns that into searches, gates jobs against the real posting
body, tailors honest application artifacts from your own evidence, tracks
outcomes, and prepares you for interviews — with candidate-owned state stored
locally. AI requests go through the runtime the candidate selects and are subject
to that provider's privacy and retention terms.

The active product direction is a conversational local app powered primarily by
a supported AI CLI you already have installed and authenticated. Development and
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
  and the dashboard's Next agent task card point the agent at the next skill.
- **Body-read gate** (`evaluate-job`) — a standalone gate that reads the full
  posting and emits a `GATE` / `FIT` / `COMP` / `ACTION` verdict from your config.
  `apply-job` must run or verify it first.
- **Honest tailoring** (`tailor-application`) — résumé, cover letter, and
  short-answer artifacts built only from your evidence bank, with a placeholder
  lint that blocks unresolved template tokens before build or upload.
- **Communication memory** (`email-comms`) — draft and track recruiter threads,
  follow-ups, scheduling, and negotiation without re-pasting history. Draft-only
  by default; sending requires explicit confirmation.
- **Tracker & analytics** — a local app backed by canonical SQLite state: stat
  cards, a funnel, an **Active Pipeline organized by a
  semantic stage ladder** (Sourced → Applied → Screen → Interview → Final → Offer
  → Accepted, with your raw status labels preserved), an All-Jobs table,
  per-job detail view, and follow-up reminders. Plus outcome analysis.
- **Interview prep** (`interview-prep`) — audience-segmented packets (recruiter /
  hiring manager / panel) grounded in your evidence, with do-not-overclaim
  guardrails. Comp/logistics scripts use only your target/minimum figures.
- **Apply workflow engine** (`apply-job`) — portal form-fill recipes with a
  manual-submit default; auto-submit is strictly opt-in, and the flow halts on
  CAPTCHAs and unsupported auth prompts. With explicit `mail_access` consent, it
  can read one recent emailed verification code from any webmail provider and continue.
  The agent-led workflow and safety gates are shipped. Native Ask and Apply on site
  now provide a truthful manual handoff; connecting them to the supervised executor
  remains part of the active product coherence gate below.
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
- **Live-reload dashboard** (`careerrat tracker-dev`) — a dependency-free watch +
  live-reload dev server: edit your tracker data or the dashboard itself and the
  open page refreshes instantly.
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
- **Dashboard themes + editorial refresh** — Tokyo Night and Gruvbox theme families
  (light + dark) alongside the originals, plus a palette-independent editorial pass:
  tabular figures, eyebrow section labels, a ruled editorial masthead with a
  borderless metric band (no stat-card boxes), monospace metadata, lighter headings,
  and crisper less-rounded cards.
- **Per-track learning memory** (`careerrat learnings`) — durable, private lessons per
  role family. The skills that learn from outcomes (interview debriefs, rejection and
  win patterns, strategy reviews) append dated entries; the skills that produce
  artifacts (evaluation, search triage, tailoring) read them, so fit, résumés, and prep
  get sharper on each track the more you run it. Entries are checked for unresolved
  placeholders and refused if they would record a private comp input; everything stays
  in a gitignored local directory and never goes outbound.
- **Paper Command Center dashboard pages** — the live dashboard now has a rounded,
  SaaS-aligned command surface across the major tabs: Dashboard focus and metrics,
  Jobs command rail with compact Table/Cards views, active filters, action icons,
  Sankey funnel, and a slide-in job detail drawer; Calendar week board with
  previous/next controls, month zoom, and dimmed past days; Network company
  relationship map; Evidence Library; and a settings drawer for onboarding config,
  modes, and automation posture.
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
- **Deterministic source foundation** — all 73 public-network adapters from the pinned
  Career Ops provider snapshot run through CareerRat's shared scanner boundary, including
  company ATS APIs, broad public APIs/RSS, regional boards, and niche sources. The parity
  manifest records the one intentional exclusion: `local-parser`, which executes arbitrary
  user-configured local commands. Generic RSS and opt-in authenticated/manual sources remain
  available where a public adapter is not appropriate.
- **Opt-in browser & mail automation** — session-based automation you switch on per
  capability, using your own browser login with no stored credentials: application-status
  sync (`sync-status`), authenticated search, in-platform message ingest
  (`ingest-messages`), and authenticated one-click apply (LinkedIn Easy Apply, behind the
  existing submit-safety gate), LinkedIn profile optimization, plus opt-in mail sync and
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
- **Meeting scheduler** (`schedule-meeting`) — a dedicated scheduling workflow that turns recruiter
  or hiring-team availability threads into clear proposed time blocks, a calendar-ready hold, and a
  polished reply. It reads your tracker communications and (when available) calendar context to
  avoid double-booking, resolves and labels timezones clearly, and stays confirm-first before
  sending anything or creating a calendar event. With no calendar connector it degrades to
  draft-only plus an `.ics` hold you import by hand. An optional availability block in your profile
  lets it stop asking once you've told it your timezone and preferred times.
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
  can't auto-submit (CAPTCHA, account wall, a required exercise) is surfaced as "manual apply
  needed" rather than disappearing. A board-top triage banner counts what's waiting and prompts
  you to go through it with your agent.
- **Dashboard strategy insights** — a local, read-only "what's working" card on the dashboard:
  source performance, role-lane performance, fit-band breakdown, quiet-pipeline rows, longest
  active time-in-stage rows, cadence nudges for due/overdue/no-next-touch follow-up, and one
  strategy recommendation are computed from `workspace/tracker.json` so the tracker can show where
  traction is actually coming from without duplicating the Jobs, Network, or Library tabs.
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
- **App UI** — a bundled single-page app (`/app`) over the local server with guided onboarding,
  editable settings, AI-assisted proposals, and manual operation when no AI runtime is ready.
  The existing wizard/forms are durable review and correction surfaces; the active redesign
  makes conversation the primary first-run intake experience.

- **Repository structure and hygiene** — product packages now live together under `apps/`
  (`web`, `desktop`, `website`, and `docs`), design-only landing-page mockups are retained under
  `.planning/archive/mockups`, shared fonts live under `assets/fonts`, and the monorepo uses one
  root lockfile and one Turbo build graph. Release guards reject the old root directories,
  app-local lockfiles, tracked generated Next wiring, and stale build-output paths.
- **Universal capture** — a docked capture bar plus an Inbox: paste or drop anything (a job
  description, a posting URL, a recruiter email, an interview transcript) and the intake
  pipeline classifies it, matches it against what you're already tracking, and proposes exactly
  what it will write or run — you confirm before anything happens. Recognized ATS links are
  handled deterministically with no AI call at all, and ambiguity is surfaced, never guessed.
- **App dashboard views** — home (focus card, pipeline snapshot, next steps), a Jobs view with
  glanceable rows and a detail drawer whose actions write through the real domain verbs (status
  changes, interview scheduling, follow-up completion, notes, communications), a week/month
  calendar, and an activity feed, all rendered from one server-derived view model.
- **Company logos everywhere** — a server-side logo proxy with a local cache (and optional
  brand-search autocomplete when a key is configured), with an initials fallback so nothing
  breaks offline or keyless.
- **Desktop app shell** — an Electron wrapper around the same local server, so the whole thing
  runs as a native window: first run lands in the onboarding wizard, external links open in
  your OS browser, and quitting cleanly shuts down every agent session.
- **Installed AI runtime first** — onboarding and Settings detect supported coding CLIs,
  select an already-authenticated local tool, and run bounded structured calls without
  copying its credentials or requiring a provider key. External capabilities stay off until
  a concrete action needs one, then the app explains and requests that specific permission.
  Direct provider keys and managed AI remain explicit fallbacks, and every AI feature still
  degrades to a manual path.
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
- **Network and Library in the app** — company relationship records (contacts and
  conversation history behind a detail drawer) and the full evidence/story/writing-voice
  bank (uncapped, with type/lane/family filters and search) are now first-class app views.
  The retired static tracker has no product route or navigation affordance.
- **Setup readiness on the home view** — while sourcing runs, the home view shows what's
  still needed to unlock gating and applying (with per-item hints), and gets out of the way
  once setup is complete.

## In progress / up next

The web app is the daily development surface. The conversation-first product and packaged
Electron runtime have completed the acceptance sweep below, including the macOS distribution
gate:

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
   returns review/export actions without implying submission. Remaining work is the connected
   authenticated executor and automatic form-question capture, plus clean-home and packaged
   acceptance coverage for pasted and attached input. Explicit natural outcome reports now resolve
   one saved application and write the typed transition in the same Ask thread; ambiguous or
   missing references stop with specific clarification copy and no mutation. Natural recruiter
   requests now resolve one communication for an AI-backed reviewable draft or a user-reported
   sent write-back. Natural interview-prep requests resolve one interview application, build the
   saved-JD dossier, and return an immediate deep link in Ask. The remaining communications gap is
   connected verified sending, not reference resolution or durable draft/sent-report state.
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
   use that contract, while verified delivery remains open. The remaining original-skill rows stay
   tracked in the linked audit.
5. **Free/public source parity before AI (implemented and accepted)** — the pinned manifest
   accounts for all 74 Career Ops provider modules: 73 public-network adapters run through the
   deterministic registry, and `local-parser` is intentionally excluded with a safety reason.
   URL inference, explicit branded-host selection, normalized output, upstream conformance fixtures,
   scanner dedupe, full-JD hydration, and source provenance are wired. AI remains the fallback for
   discovery gaps and ambiguous/custom pages, not the default repeated scan path. Clean packed-
   install CLI and Settings acceptance now covers the manifest and UI-facing source-write path.
6. **Fresh acceptance pass (current tranche complete)** — clean-home onboarding, restart, Ask
   rate/apply, provider Settings, native Electron, npm install, lint, tests, and builds pass. The
   broader original-skill rows stay active in the linked audit instead of being hidden by this gate.

### Product-surface acceptance sweep (updated August 14, 2026)

The live result ledger is [`.planning/QA-ACCEPTANCE.md`](../.planning/QA-ACCEPTANCE.md); this
section remains the release-level source of truth. All 90 recorded findings are fixed and
live-retested. The broader skill-to-screen audit above remains active until every user-facing
original skill has a coherent native path.

Current verification: 2,565 repository tests completed with 5 intentional skips; 696 web tests passed;
lint completed with no errors; web, website, docs, and desktop builds passed; and the final 541-file
npm tarball installed into a clean home without lifecycle warnings. The clean setup, background
search, restart, Ask rate/apply, provider Settings, and source Electron checks produced no HTTP or
console errors. The previously accepted desktop release flow signs and notarizes both the app bundle
and DMG container, staples the ticket, and passes Gatekeeper.

- **Global shell and workspace conversation** — navigation, setup gating, Ask on every route,
  durable history, attachments, cancel/retry, confirmation gates, activity notifications,
  error recovery, reload/restart behavior, responsive layout, keyboard use, and light/dark themes.
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
- **Settings** — candidate and targeting edits, runtimes, direct-provider fallback, automation
  consent, source maintenance, validation and recovery, persistence after restart, and honest
  descriptions of what each installed tool can do.
- **Compatibility and release surfaces** — explicit retired-dashboard behavior, CLI
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

- **Installed-runtime isolation** — run bounded Codex and Claude tasks without inheriting
  unrelated global MCP failures; surface the actual CLI/runtime error and a working recovery path.
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
- **Bring-your-own authenticated CLI** — use a supported installed agent as the normal AI
  runtime. Be precise about which adapters are fully supported; direct provider keys are an
  Advanced fallback and managed AI is a parked future convenience.
- **First-day outcome** — carry a new user from résumé through targets/gates and the interview
  into source setup and one strictly filtered search with a small, useful review queue.
- **QA remediation, web-first** — preserve the completed candidate-truth, local-runtime,
  consent, and strict role/location/radius sourcing fixes. Continue typed evaluation,
  artifact, capture, relationship, communication, provenance, and reliability work as it
  supports the new flow. Run packaged Electron and clean-device regression QA in the final
  integration phase rather than after every ordinary web tranche.
- **Finish migrating the writing skills to the data API** — most writing skills now go
  through the same verbs the UI buttons use; the remaining batch is mail/message ingest,
  calendar sync, interview prep, and relationship sourcing (legacy workspaces keep working
  unchanged).
- **Coaching loop** — turn a below-floor fit score from a verdict into a plan: name the gaps,
  suggest how to close them, re-ingest the new evidence, re-score.
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
- **Agent CLI adapters / multi-runtime skill homes** — Gemini CLI, DeepSeek, Qwen,
  Kimi, Hermes Agent, and any other runner need launch/handoff support, local
  router/context loading, skill discovery, and a smoke-test path before appearing on
  a compatibility list. The mechanism: one canonical skill body in `.agents/skills/`
  mirrored into each runtime's native home (`.claude/`, `.opencode/`, `.qwen/`,
  `.antigravitycli/`) plus per-runtime command wrappers and an `OPENCODE.md`, via a
  symlink-or-materialize installer (symlinks in a git checkout; a tracked pointer
  stub that the installer overwrites with real content wherever symlinks don't
  survive — npm tarballs, zips, Windows). Today only Claude Code is wired, by a
  single dir symlink. Note the scale: 21 skills × N runtimes, not one entrypoint.
- **Cleanup and maintenance skill** — a shared housekeeping workflow for stale
  screenshots, browser traces, temp captures, detached logs, orphaned generated
  artifacts, and other maintenance debris. It should preview first, stay
  gitignore-aware, and preserve intentional candidate, tracker, demo, and evidence
  artifacts by default.
- **Brand-logo modernization** — refine the wordmark/mark so it feels welcoming
  and human while staying restrained, favicon-legible, and theme-agnostic.
- **Browser automation inside the app** — the consent-gated session-browser capabilities
  (authenticated search, message ingest, status sync, assisted apply) exist today for
  agent-driven runs; surfacing them as first-class buttons inside the app UI waits until
  the browser-free core has been proven with real users.

## Principles

- **Config, not code, holds your preferences.** The code stays field-neutral;
  exclusions, comp floors, role families, and board choices live in your config.
- **Your data is local and private.** Candidate files and workspace data are
  gitignored by default; comp inputs marked private never appear in any outbound
  or shareable artifact.
- **Human-in-the-loop by default.** Anything outward-facing — sending a message,
  submitting an application — is confirm-first unless you explicitly opt in.
