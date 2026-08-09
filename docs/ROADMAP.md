# CareerRat Roadmap

CareerRat is a local, skill-driven job-search workspace. You define what you
actually want; it turns that into searches, gates jobs against the real posting
body, tailors honest application artifacts from your own evidence, tracks
outcomes, and prepares you for interviews — with candidate-owned state stored
locally. AI requests go through the runtime the candidate selects and are subject
to that provider's privacy and retention terms.

The active product direction is a conversational local app powered primarily by
an AI CLI you already have installed and authenticated. Development and QA happen
web-first for speed; Electron remains the eventual desktop package after the
experience stabilizes. A managed AI service may return later as an optional
convenience, but login, billing, and a CareerRat API key are not prerequisites for
the core first-run path.

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
- **Tracker & analytics** — a dependency-free static dashboard rendered from
  `tracker.json`: stat cards, a funnel, an **Active Pipeline organized by a
  semantic stage ladder** (Sourced → Applied → Screen → Interview → Final → Offer
  → Accepted, with your raw status labels preserved), an All-Jobs table,
  per-job detail view, and follow-up reminders. Plus outcome analysis.
- **Interview prep** (`interview-prep`) — audience-segmented packets (recruiter /
  hiring manager / panel) grounded in your evidence, with do-not-overclaim
  guardrails. Comp/logistics scripts use only your target/minimum figures.
- **Apply assistant** (`apply-job`) — portal form-fill recipes with a
  manual-submit default; auto-submit is strictly opt-in, and the flow halts on
  CAPTCHAs and unsupported auth prompts. With explicit `mail_access` consent, it
  can read one recent emailed verification code from any webmail provider and continue.
- **One-command start** (`careerrat start [agent]`) — scaffolds the workspace,
  installs the skills, brings up the live dashboard, and launches your agent
  (Claude Code, Codex, or any CLI on your PATH) with a starter message, so first
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
- **Portal coverage** — Wellfound and Lever adapters behind provider modules: pasted
  links route to canonical search URLs, with seeded board defaults.
- **Opt-in browser & mail automation** — session-based automation you switch on per
  capability, using your own browser login with no stored credentials: application-status
  sync (`sync-status`), authenticated search, in-platform message ingest
  (`ingest-messages`), and authenticated one-click apply (LinkedIn Easy Apply, behind the
  existing submit-safety gate), LinkedIn profile optimization, plus opt-in mail sync and
  `mail_access` for generic webmail / Gmail / Outlook. A per-capability, per-platform consent
  switchboard (`careerrat automation`) defaults fully off and stores nothing — nothing runs
  until you read a platform's terms, record consent, and enable it; every session is
  human-in-the-loop and halts on a CAPTCHA, 2FA, or limit. Onboarding adds basic/advanced
  setup modes and resumable deep/shallow setup (progress saved to
  `workspace/setup-state.json`), surfacing the capability install guidance and opt-ins at
  the right moment. *(Shipped and live-validated; the consent gates remain the boundary for
  each capability and platform.)*
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
  explicit `careerrat data import`; the classic `tracker.json` keeps working as a generated
  export during the transition.
- **App UI** — a bundled single-page app (`/app`) over the local server with guided onboarding,
  editable settings, AI-assisted proposals, and manual operation when no AI runtime is ready.
  The existing wizard/forms are durable review and correction surfaces; the active redesign
  makes conversation the primary first-run intake experience.
- **Universal capture** — a docked capture bar plus an Inbox: paste or drop anything (a job
  description, a posting URL, a recruiter email, an interview transcript) and the intake
  pipeline classifies it, matches it against what you're already tracking, and proposes exactly
  what it will write or run — you confirm before anything happens. Recognized ATS links are
  handled deterministically with no AI call at all, and ambiguity is surfaced, never guessed.
- **App dashboard views** — home (focus card, pipeline snapshot, next steps), a Jobs view with
  glanceable rows and a detail drawer whose actions write through the real domain verbs (status
  changes, interview scheduling, follow-up completion, notes, communications), a week/month
  calendar, and an activity feed — all rendered from the same server-derived view model as the
  classic dashboard, so the two never disagree.
- **Company logos everywhere** — a server-side logo proxy with a local cache (and optional
  brand-search autocomplete when a key is configured), with an initials fallback so nothing
  breaks offline or keyless.
- **Desktop app shell** — an Electron wrapper around the same local server, so the whole thing
  runs as a native window: first run lands in the onboarding wizard, external links open in
  your OS browser, and quitting cleanly shuts down every agent session.
- **Installed AI runtime first** — onboarding and Settings detect supported coding CLIs,
  select an already-authenticated local tool, and run bounded structured calls without
  copying its credentials or requiring a provider key. Basic mode keeps every external
  capability off; Advanced exposes individual platform + terms opt-ins. Direct provider
  keys and managed AI remain explicit fallbacks, and every AI feature still degrades to a
  manual path.
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
  bank (uncapped, with type/lane/family filters and search) are now first-class app views;
  the classic dashboard remains reachable as a "Classic" link.
- **Setup readiness on the home view** — while sourcing runs, the home view shows what's
  still needed to unlock gating and applying (with per-item hints), and gets out of the way
  once setup is complete.

## In progress / up next

The web app is the daily development surface. Current work is re-sequenced around a
conversation-first local product; Electron packaging and final desktop QA follow after the
web experience and contracts stabilize:

- **Conversational first ingestion** — accept a résumé, learn desired jobs and hard gates,
  run an adaptive interview that asks only unresolved/high-value questions, then present a
  grouped human-readable review before writing canonical profile, evidence, targeting, and
  honesty state. Autosave raw intake locally and support resume-later.
- **First-class Ask/Work surface** — make conversation a primary app surface rather than a
  floating helper. Attachments, streaming progress, cancel/retry, actionable errors, structured
  proposals, confirmation gates, and links to resulting state all use durable local sessions.
  Onboarding is the first phase of one persistent workspace conversation, not a disposable
  setup-only chat. Contextual buttons submit visible typed intents with entity IDs into that same
  thread; the agent reloads fresh canonical state and invokes deterministic operations or
  safety-isolated skill workers internally, with every result returning to the one user-facing
  conversation. Backend foundation now persists one canonical workspace thread, replays its
  durable history through the selected runtime, and routes interview-prep intents/results back
  into that history; streaming, attachments, onboarding graduation, and the visual Ask surface
  remain active work.
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
- **Classic dashboard retirement** — Network and Library now render in the app; what's
  left on the classic tracker page is the funnel diagram and a final parity check on
  activity/action state. The classic render path retires only once those are covered.
- **Coaching loop** — turn a below-floor fit score from a verdict into a plan: name the gaps,
  suggest how to close them, re-ingest the new evidence, re-score.
- **Desktop integration and packaging** — after web acceptance: desktop-safe runtime/path
  discovery, filesystem ownership, navigation, exports, signing/notarization, clean-device
  first run, restart, and packaged end-to-end QA.

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
- **More sources** — additional job-board and ATS adapters behind provider modules,
  beyond the current Wellfound + Lever coverage.
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
