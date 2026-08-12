# Rolester Roadmap

Rolester is a local, skill-driven job-search workspace. You define what you
actually want; it turns that into searches, gates jobs against the real posting
body, tailors honest application artifacts from your own evidence, tracks
outcomes, and prepares you for interviews — all from candidate-owned data that
never leaves your machine.

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
- **Packaging** — `rolester` launcher (`start` / `init` / `install-skills` /
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
- **Mode switchers** (`careerrat modes`) — two independent knobs for running Rolester at the
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
  user-clicked: Rolester prepares the event, the user decides what to import.
- **Calendar provider sync** (`calendar-sync`) — a confirm-first provider-sync
  foundation for Apple Calendar, Google Calendar, Outlook Calendar, and approved
  local automation tools. The `calendar_sync` capability defaults off per provider,
  the Calendar page shows provider readiness plus recent `calendarWrites[]` history,
  and the owning skill previews exact tracker-derived events before any real
  calendar write. No background auto-sync is enabled.
- **Live Activity Pulse + derived action queue** — a running local timeline on the dashboard of
  what Rolester did and what happened in your search: roles sourced, jobs evaluated, résumés
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

## Dogfood Pass

Rolester is now in a use-it-and-tighten-it pass. There is no active v1 feature
queue; the next work should come from real usage, tracker data problems, or UI
friction that blocks the job-search loop.

### Watch list

- **Tracker data quality** — keep `npm run verify:tracker` clean enough to trust
  the dashboard. Current warnings are data hygiene, not feature blockers.
- **Dashboard clarity** — keep trimming clutter as real usage shows what should be
  glanceable, drill-in, or hidden behind the drawer.
- **Real-data dashboard surfaces** — every dashboard panel now renders from your
  tracker (the Network map and the last static one, the Sourced page, are wired);
  keep new panels real-data-only so nothing ever shows placeholder companies.
- **Consent-gated automation** — calendar sync, mail, messaging, status polling,
  relationship sourcing, and profile writes stay opt-in and confirm-first.
- **Skill flow polish** — when a real run feels awkward, fix the owning skill or
  tracker write-back path instead of adding a parallel workflow.

## V2 Parking Lot

These ideas are deliberately out of the current pass. Reopen them when the core
daily workflow has been dogfooded and the pain is real enough to justify the
extra surface area.

- **Conversational coach layer** — browser speech input/output, a dashboard chat
  panel, and adaptive setup prompts that read existing context before asking for
  more. This includes optional voice, voice-extended interview prep, post-interview
  voice debriefs, and "talk to your agent from the dashboard."
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
- **Interactive live demo on the site** — render the dashboard against the bundled
  sample workspace as a static, client-side-only build and serve it from the project
  site so anyone can click through a realistic, fully populated job search (emails,
  interview notes, an offer-to-accept arc) without installing anything. No backend; the
  demo data ships with the build.

## Principles

- **Config, not code, holds your preferences.** The code stays field-neutral;
  exclusions, comp floors, role families, and board choices live in your config.
- **Your data is local and private.** Candidate files and workspace data are
  gitignored by default; comp inputs marked private never appear in any outbound
  or shareable artifact.
- **Human-in-the-loop by default.** Anything outward-facing — sending a message,
  submitting an application — is confirm-first unless you explicitly opt in.
