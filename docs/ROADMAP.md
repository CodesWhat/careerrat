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

## Release status (v0.10.0, updated August 20, 2026)

**v0.10.0 is released and published.** npm `dist-tags.latest` is `0.10.0`. The
GitHub release `v0.10.0` carries a signed, notarized, stapled
`CareerRat-0.10.0-arm64.dmg`. `publish.yml` fires on a published GitHub Release,
not on a tag push, so tagging alone is always safe. `CHANGELOG.md` at the repo
root is the per-release record from here on.

Version drift now has a guard. `tests/release-consistency.test.mjs` checks that
`package.json`, `apps/desktop/package.json`, and the newest `CHANGELOG.md`
heading agree. It runs both in `ci-verify.yml`'s fast `structure-guards` subset
and in the full `tests` job, and both are required contexts, so it cannot be
skipped.

A Homebrew cask now exists and is available: `brew install --cask
codeswhat/tap/careerrat`. PR #4 on `CodesWhat/homebrew-tap` merged August 19,
2026. The cask is hand-maintained: careerrat has no cask generator script
(idlescreen has `scripts/generate-homebrew-cask.sh`; careerrat does not). This
is a known gap. Every release currently requires hand-editing the cask's
`version` and `sha256` and opening a tap PR.

Stale branch cleanup is done. `origin` is now just `main`. The branches
`fix/v0.7-publish`, `dev/v0.7`, `archive/dev-2026-07`, and
`release/careerrat-0.5.2` were deleted after verifying each had zero commits
absent from main (the 0.5.2 one is still permanently reachable via tag
`v0.5.2-careerrat`, which points at the identical SHA).

A local-only branch `backup/pre-public-history` was deliberately kept. It holds
pre-scrub history containing owner PII and must never be pushed or deleted.

### Landed on main since v0.10.0

Sixteen PRs, all merged, `origin` back to just `main` with every branch and worktree
cleaned up. Nothing is open.

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
  G-09 remains a product decision for Scott, not an engineering task.
- **Security hardening still staged:** harden-runner is in `audit` mode across
  workflows and `block` is the target once observed endpoints are allowlisted.
  Signed tags plus npm attestations and SBOM are tracked in #73.

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

   Neither protect script runs automatically. Both are manual, so drift is caught only when
   someone remembers to run them. A scheduled verify needs a credential with admin read on the
   rulesets API, which is a secret-management decision rather than a thing to add quietly.
4. **Knip backlog** ([#81](https://github.com/CodesWhat/careerrat/issues/81)). The `--max-issues`
   ratchet sits at 170 and hides new dead code behind existing debt. One unused file, four unused
   dependencies, one duplicate export alias pair, and 164 unused exports that mostly want
   de-exporting rather than deleting. Target is a ratchet of 0 and a plain `npx knip` gate. **The
   ratchet goes down, never up.**

   **Landed in [#130](https://github.com/CodesWhat/careerrat/pull/130) through
   [#133](https://github.com/CodesWhat/careerrat/pull/133), ratchet lowered in
   [#135](https://github.com/CodesWhat/careerrat/pull/135): 170 to 44.** Split into four
   file-disjoint lanes. The unused file, the duplicate alias, and 123 exports are gone, including
   500 dead lines in `tracker/dashboard.mjs` (four builders with no caller anywhere, in a file
   with twenty-plus importers).

   The target of 0 was wrong, and that is the useful finding. The 44 that remain are not debt.
   Four are fontsource packages both Next apps load by raw file path through `next/font/local`,
   which knip cannot see and which break the typeface silently if removed, exactly the trap #81
   warned about. The other 40 are exports named by a skill, doc, comment, or dynamic import with
   no JS importer: `SAFE_EXTERNAL_PROTOCOLS`, the SSRF guards in `public-http-fetch.mjs`,
   `RECRUITER_FARM_PHRASES`, `ATS_ROUND_RULES`, and the 14 `api.js` client functions that turned
   out to be an unwired feature surface rather than dead code
   ([#134](https://github.com/CodesWhat/careerrat/issues/134)). Six of those are the client half
   of `company-health` and the research flows, all with live backend routes and no UI that calls
   them.

   So reaching 0 means teaching knip about those references, not deleting them. Anyone who closes
   the gap the other way has made the number prettier and the product worse. That reasoning is in
   the workflow comment, not just here, because the ratchet is where the temptation lives.

**Two things the queue surfaced that are not lanes.** The `tests` gate went required on
2026-08-20 and immediately flaked on the db-concurrency test, which now means a flaky merge gate
([#136](https://github.com/CodesWhat/careerrat/issues/136)). And the `ci-verify.yml` header
claimed `qlty` and `knip` did not gate merges when both are required contexts, which is the exact
failure that same comment warns about two lines later. Prose has no drift guard. Fixed in #135,
which now tells the next reader to re-read the live ruleset instead of trusting the paragraph.

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
   accounts for all 74 Career Ops provider modules: 73 public-network adapters run through the
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
- **Finish browser automation inside the app** — assisted Apply now has a first-class native Orca
  path. Authenticated search, message ingest, status sync, multi-step ATS advancement, and the
  extension/Playwright executor bridges still need the same visible progress and recovery contract.

## Principles

- **Config, not code, holds your preferences.** The code stays field-neutral;
  exclusions, comp floors, role families, and board choices live in your config.
- **Your data is local and private.** Candidate files and workspace data are
  gitignored by default; comp inputs marked private never appear in any outbound
  or shareable artifact.
- **Human-in-the-loop by default.** Anything outward-facing — sending a message,
  submitting an application — is confirm-first unless you explicitly opt in.
