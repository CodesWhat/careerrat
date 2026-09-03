<div align="center">

<img src="apps/desktop/build/icon.png" alt="CareerRat" width="112">

<h1>CareerRat</h1>

**A Mac app that turns the AI CLI you already have into a personal recruiter.**

</div>

<p align="center">
  <a href="https://github.com/CodesWhat/careerrat/releases/latest"><img src="https://img.shields.io/github/v/release/CodesWhat/careerrat?label=desktop" alt="Latest desktop release"></a>
  <a href="https://www.npmjs.com/package/careerrat"><img src="https://img.shields.io/npm/v/careerrat" alt="npm version"></a>
  <a href="https://github.com/CodesWhat/careerrat/releases/latest"><img src="https://img.shields.io/badge/platform-macOS_(Apple_Silicon)-informational?logo=apple&logoColor=white" alt="Platform"></a>
  <a href="LICENSE"><img src="https://img.shields.io/github/license/CodesWhat/careerrat" alt="MIT License"></a>
  <br>
  <a href="https://github.com/CodesWhat/careerrat/actions/workflows/ci-verify.yml"><img src="https://github.com/CodesWhat/careerrat/actions/workflows/ci-verify.yml/badge.svg?branch=main" alt="CI"></a>
  <a href="https://securityscorecards.dev/viewer/?uri=github.com/CodesWhat/careerrat"><img src="https://img.shields.io/ossf-scorecard/github.com/CodesWhat/careerrat?label=openssf+scorecard&style=flat" alt="OpenSSF Scorecard"></a>
  <br>
  <a href="https://www.npmjs.com/package/careerrat"><img src="https://img.shields.io/npm/dm/careerrat" alt="npm downloads"></a>
  <a href="https://github.com/CodesWhat/careerrat/stargazers"><img src="https://img.shields.io/github/stars/CodesWhat/careerrat?style=flat" alt="Stars"></a>
</p>

<p align="center"><small>CareerRat itself costs nothing. Your AI provider may have its own plan or usage costs.</small></p>

<hr>

<h2 align="center">Contents</h2>

- [Quick Start](#quick-start)
- [Recent Updates](#recent-updates)
- [Why CareerRat](#why-careerrat)
- [Features](#features)
- [Supported Integrations](#supported-integrations)
- [Star History](#star-history)
- [Built With](#built-with)
- [Community & Support](#community-support)

<hr>

<h2 align="center" id="quick-start">Quick Start</h2>

CareerRat runs as a Mac app or from any terminal. Either way, it hands the actual
work to an AI coding assistant you probably already have on your machine, Claude
Code or OpenAI Codex, and gives that assistant a full recruiter's job to do:
read the posting, check it against what you want, write your materials, and
keep score of everything.

### Get the Mac app (Apple Silicon)

The current macOS release is a signed and notarized Apple Silicon app for macOS
12 or newer.

1. [Download the latest `.dmg`](https://github.com/CodesWhat/careerrat/releases/latest),
   or install it with Homebrew:

   ```bash
   brew install --cask codeswhat/tap/careerrat
   ```

2. Open CareerRat.
3. Choose Claude Code or Codex if it is ready. If neither is installed, CareerRat
   offers in-app Claude Code setup and the official OpenAI Codex setup guide.

[Claude Code](https://docs.anthropic.com/en/docs/claude-code/overview) and
[OpenAI Codex](https://developers.openai.com/codex/cli/) are CareerRat's only
supported product runtime choices. Both use the same CareerRat-owned workflows,
skills, and durable state. The packaged app invokes the selected installed CLI
directly and never falls back to or silently switches providers. A runtime
becomes `Ready` only after local availability, authentication, and its readiness
check pass.

### Any other platform (npm)

Needs Node.js 24.15 or newer.

```bash
npm install -g careerrat
careerrat start claude
# or
careerrat start codex
```

### First run

If CareerRat does not find Claude Code or Codex, it shows both supported choices
in plain English. CareerRat can install Claude Code inside the app. Claude Code
needs a paid Claude plan. Pro is enough; Max provides more usage. You can
[get Claude through Scott's referral](https://claude.ai/referral/rOLHwxlsfA),
then click **Install inside CareerRat**. The app runs Anthropic's official
installer, shows its progress in the CareerRat window, and reports a clear retry
if it fails. Click **Sign in**, finish in the browser, and return to CareerRat.
The app checks for Claude in the background and also keeps a visible **Check
setup** button. To use Codex, expand **Set up OpenAI Codex instead** and follow
its official install guide.

Choose the available AI engine, then drop a PDF, DOCX, image, or text resume into
the conversation, or just start talking. Paul, the CareerRat rat, fills in "What
Paul knows" beside the chat as it learns your target roles, location rules,
compensation floor, dealbreakers, evidence, and honesty boundaries. Paul speaks
in plain English: when it needs an abstract choice, it gives concrete examples
instead of job-search jargon. For example:

> "What would make one job worth applying to before another? The kind of work,
> a schedule and pay that fit, or room to grow?"

Progress saves continuously. Once the minimum search profile is ready, CareerRat
starts the first location-aware search while the rest of onboarding continues.
When setup finishes, the app opens Search and says clearly whether that search is
running, found matches, needs a retry, or is ready to start.

From there, ask it to find roles, evaluate a posting, tailor an application,
prepare an interview, or pick up a saved thread. Tool work appears as compact
activity rows in the conversation, so you can see what it is reading, searching,
and writing without a wall of approval prompts.

<details>
<summary>Windows, and the desktop window</summary>

The Windows x64 installer passed build, install, launch, export, and uninstall
QA. A public Windows installer will ship only after SignPath Foundation signing
is available; SignPath requires project reputation CareerRat does not yet have.
See [Windows status](docs/WINDOWS.md).

CareerRat opens at a designed desktop size of 1280 by 860. The window is
resizable, maximizable, and supports full screen, with a minimum working size of
1100 by 680. There is no mobile app or Intel Mac build.

</details>

<details>
<summary>Prefer the terminal, or building from source?</summary>

Terminal mode requires Node.js 24.15 or newer and launches Claude Code or Codex.
Both use the same canonical skills and local data as the Mac app.

Useful terminal commands:

```bash
careerrat next          # show the next useful agent-led workflow
careerrat doctor        # verify setup, data, skills, and runtime health
careerrat update        # update an npm installation without touching user data
careerrat tracker       # write a recovery snapshot and summary
careerrat tracker-dev   # serve the local browser workspace at localhost:7777
```

To contribute from source:

```bash
git clone https://github.com/CodesWhat/careerrat
cd careerrat
npm install
npm run hooks:install
npm link
careerrat start claude
```

The repository convention is in [AGENTS.md](AGENTS.md). Public architecture and
release documentation live in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) and
[docs/RELEASE.md](docs/RELEASE.md). Full setup docs are on
[careerrat.com/docs](https://careerrat.com/docs).

</details>

<hr>

<h2 align="center" id="recent-updates">Recent Updates</h2>

<details open>
<summary><strong>v0.17.0 highlights</strong></summary>

- **Pay checks now understand hourly, tipped, and shift-based jobs, not just
  salaried roles.** Candidate setup and Profile add an annual-cash worksheet
  that keeps your original pay inputs while deriving a comparable annual floor
  for search and evaluation.
- **Search and company discovery now follow your own role, seniority, and
  location rules**, instead of assuming a salaried software-engineering search.
- **Compensation checks compare like with like** across annual salaries, hourly
  and tipped wages, and explicitly labeled pay ranges.
- **An ordinary search no longer opens a stack of visible browser windows.**
  Public web searches run hidden; a source that needs your own login still opens
  visibly so you can interact with it.

Full history in [CHANGELOG.md](CHANGELOG.md).

</details>

<hr>

<h2 align="center" id="why-careerrat">Why CareerRat</h2>

**Rate. Apply. Track.**

CareerRat reads the full job posting against your location and compensation floor,
fit, and dealbreakers before it recommends anything. It builds resumes, cover
letters, and screening answers from your real experience, then fills supported
application forms for your review. It never presses the final Submit button.

Pay rules work for salaried, hourly, tipped, and commissioned jobs. You can set a
guaranteed base floor, a minimum for annual cash earnings that includes wages,
tips, commission, and cash bonuses, or both. Equity and benefits never count as
cash earnings.

The search stays together in one local workspace: conversations, jobs, recruiter
threads, missions, files, follow-ups, interviews, and outcomes. You can leave a
thread, come back later, and CareerRat restores the relevant state without
depending on one AI vendor's session history. CareerRat owns those workflows and
threads, so the execution layer stays provider-neutral.

<hr>

<h2 align="center" id="features">Features</h2>

### Rate every posting before you apply

CareerRat combines built-in public job-board and ATS sources with broad AI
open-web discovery. Source setup selects the applicable built-in sources from
your saved roles, then CareerRat discovers additional specialist boards and
employer pages for that search.

CareerRat gives Claude Code and Codex the same complete workflow, keeps long
searches and application missions durable across navigation and restart, and
turns finite questions into normal clickable choices that can also be answered
in text. Search combines built-in boards with AI open-web discovery, keeps AI
leads clearly unverified, then checks readable full postings against location,
office-day, compensation, seniority, eligibility, and fit rules before treating
them as verified.

When a saved job site is added or first used and login is needed, CareerRat asks
"Do you want to log into LinkedIn so I can use it?" with Yes and No buttons. Yes
opens that exact saved search in CareerRat's visible browser. No skips the site
and keeps searching everywhere else. There is no separate search permission or
Settings checklist.

Those partial discoveries are not presented as proven jobs. Search labels them
**AI · unverified** and preserves the visible title, company, location, pay,
date, link, and search evidence. **Evaluate** then verifies liveness, captures
the full posting through the public or supervised browser path, and applies your
real location, compensation, eligibility, and fit rules before any tailoring or
application work begins.

### It never submits without you

- Every job is read in full before tailoring or application work begins.
- Generated claims must trace back to your own evidence. Missing facts are asked
  for or left out, never invented.
- Application automation fills safe, confirmed fields and can attach the
  generated resume. When an application needs your answer, the job thread shows
  that question in its review panel and saves the response against the exact
  form question before preparation resumes. Voluntary demographic and
  self-identification questions stay blank by default; in
  **Profile > Application defaults**, you can leave them blank or choose the
  form's decline option when one is available. CareerRat never infers an answer.
- Application questions stay with the exact job thread. CareerRat can prepare a
  reviewed form through the final safe step, but CAPTCHA, sensitive attestations,
  uncertainty, and the final Submit control always stay with the candidate. The
  Mac app checks for signed updates, downloads them in place, and waits for an
  explicit **Restart and install**.

### One workspace for the whole search

The app uses one desktop shell with three working areas: the left rail holds
conversation threads, research, Deep ingest, mock interviews, and the current
view; the conversation stays in the center, so job-search actions and skill
results return there instead of opening a second product; the right panel shows
structured profile or job facts as the conversation discovers them, with whole
sections opening in focused editors when needed.

Search, Pipeline, Files, People, and Schedule are alternate views of the same
local state. Missions turn longer work into resumable, ordered steps with clear
user gates. Deep ingest gets its own durable thread. Mock interviews preserve the
session and debrief. "Needs You" groups actions such as reviewing several
prepared applications into one focused handoff.

Searches and intake continue in the background when you navigate to another view.
Returning to the view or reloading restores the durable run status. If the app or
computer stops mid-run, CareerRat marks the interrupted work for a clear retry
instead of reporting a false success.

CareerRat stores canonical candidate state, conversations, missions, mock
sessions, and pipeline records in local SQLite. Job descriptions, research,
interview dossiers, resumes, and exports remain readable Markdown, PDF, or other
normal files. See the [chat-first runtime](docs/CHAT_FIRST_RUNTIME.md).

### Your data stays on your machine

CareerRat has no product account, hosted candidate database, or app telemetry.
Your workspace stays on your machine and can be exported.

<details>
<summary>Exactly what leaves your machine</summary>

- The selected AI CLI connects to its own provider under that provider's account
  and privacy terms.
- Search, research, and browser skills fetch the public or authenticated pages
  needed for the task you started.
- The Mac app checks GitHub's `latest-mac.yml` SHA-512 checksum metadata at most
  once a day. It sends no candidate data and no unique installation or device
  identifier. When a newer version exists, it downloads the signed and notarized
  app update. Nothing installs until you choose **Restart and install**.
  Automatic checks can be disabled in Settings, and "Check for Updates…" still
  works as a manual check-and-download action. Windows self-update stays off
  until its installed app and final installer share a complete signing chain.
- The public website uses cookieless, privacy-limited aggregate analytics. The
  local app does not load that website analytics client.

Read the full [privacy documentation](https://careerrat.com/docs/advanced/privacy),
[data contract](docs/DATA_CONTRACT.md), and [Code signing policy](docs/CODE_SIGNING_POLICY.md).

</details>

### 28 skills, one workflow

The app and terminal flow share the same public skill definitions. You never
have to know their names; Paul routes to the right one for what you ask.

<details>
<summary><strong>Setup and intake</strong></summary>

- `ingest-profile`: conversational candidate setup and resume intake
- `resume-extract`: structured facts from PDF, image, or DOCX resumes
- `intake-extract`: verbatim extraction from general dropped files
- `configure`: inspect and change validated CareerRat settings

</details>

<details>
<summary><strong>Find and research</strong></summary>

- `setup-searches`: turn targeting into a reviewed source configuration
- `search-jobs`: search configured sources, dedupe, check liveness, and triage
- `discover-companies`: find likely employers and resolve their career boards
- `research-boards`: find and validate additional job boards
- `research-company`: build a cited company brief
- `research-comp`: benchmark compensation for a role and location
- `company-health`: assess role-specific company stability and momentum
- `relationship-sourcing`: find recruiters, hiring teams, and warm contacts

</details>

<details>
<summary><strong>Evaluate and apply</strong></summary>

- `evaluate-job`: full-posting fit, compensation, location, and action gate
- `coach-gaps`: turn review-worthy fit gaps into an honest plan
- `tailor-application`: produce evidence-backed resumes and application artifacts
- `answer-question`: answer screening questions from saved evidence and defaults
- `apply-job`: orchestrate evaluation, artifacts, form filling, and user review
- `optimize-linkedin`: propose evidence-backed LinkedIn profile improvements

</details>

<details>
<summary><strong>Pipeline and communication</strong></summary>

- `email-comms`: draft and track recruiter and hiring-team messages
- `schedule-meeting`: handle scheduling threads and availability replies
- `calendar-sync`: write approved search events to supported calendars
- `ingest-mail`: fold recruiter and application email into the workspace
- `ingest-messages`: capture LinkedIn and Wellfound message threads
- `sync-status`: read ATS dashboards and normalize application status
- `track-outcomes`: record transitions, rejections, advances, and learnings

</details>

<details>
<summary><strong>Interview, strategy, and support</strong></summary>

- `interview-prep`: create interview packets, practice, and debriefs
- `reevaluate-strategy`: tune the search from accumulated funnel outcomes
- `report-issue`: diagnose CareerRat failures and prepare redacted reports

</details>

<hr>

<h2 align="center" id="supported-integrations">Supported Integrations</h2>

### AI runtimes

[Claude Code](https://docs.anthropic.com/en/docs/claude-code/overview) and
[OpenAI Codex](https://developers.openai.com/codex/cli/) are CareerRat's two
supported runtime choices. The AI controls use the same product language for
either one. **Automatic** chooses by task, keeping Paul on the strongest coaching
path while routine search and extraction work stays efficient. **Faster**,
**Balanced**, and **Best** let you choose the overall quality level, while
**Thinking depth** controls how long the selected runtime reasons. The setting
never ranks Claude Code against OpenAI Codex or silently changes providers.

### Job sources (22 built-in, plus open-web discovery)

**Aggregators:** HiringCafe, LinkedIn, Indeed, Glassdoor, Wellfound, Remote Vibe
Coding Jobs

**ATS boards:** Ashby, Greenhouse, Lever, Workable, SmartRecruiters, Recruitee,
Workday

**Remote boards:** RemoteOK, Jobicy, Working Nomads, We Work Remotely, Remotive

**Hospitality boards:** OysterLink, Hcareers, Hospitality Online, iHireHospitality

Anything not covered by a built-in source is filled in by AI open-web discovery,
kept clearly labeled **AI · unverified** until Evaluate reads the live posting.
See [docs/SOURCES.md](docs/SOURCES.md) for the full, current source table.

### Calendar and messages

Approved interview holds, prep blocks, and deadlines write to Apple Calendar,
Google Calendar, or Outlook. Recruiter email and LinkedIn or Wellfound message
threads fold into the same workspace as the rest of your search.

<hr>

<h2 align="center" id="star-history">Star History</h2>

<div align="center">
  <a href="https://github.com/CodesWhat/careerrat/stargazers">
    <picture>
      <source media="(prefers-color-scheme: dark)" srcset="apps/website/public/star-history-dark.svg" />
      <img src="apps/website/public/star-history.svg" alt="Star history for CodesWhat/careerrat" width="900" />
    </picture>
  </a>
</div>

<hr>

<div align="center">

<h2 align="center" id="built-with">Built With</h2>

[![Node 24](https://img.shields.io/badge/Node_24-339933?logo=nodedotjs&logoColor=fff)](https://nodejs.org/)
[![Electron](https://img.shields.io/badge/Electron_44-47848F?logo=electron&logoColor=fff)](https://www.electronjs.org/)
[![React](https://img.shields.io/badge/React_19-149eca?logo=react&logoColor=fff)](https://react.dev/)
[![Vite](https://img.shields.io/badge/Vite_8-646CFF?logo=vite&logoColor=fff)](https://vite.dev/)
[![Biome](https://img.shields.io/badge/Biome_2.5-60a5fa?logo=biome&logoColor=fff)](https://biomejs.dev/)
[![SQLite](https://img.shields.io/badge/SQLite-003B57?logo=sqlite&logoColor=fff)](https://www.sqlite.org/)
[![Anthropic](https://img.shields.io/badge/Anthropic-CC785C?style=flat&logo=anthropic&logoColor=white)](https://claude.ai/)
[![OpenAI](https://img.shields.io/badge/OpenAI-10A37F?logo=openai&logoColor=fff)](https://openai.com)

[![SemVer](https://img.shields.io/badge/semver-2.0.0-blue)](https://semver.org/)
[![Conventional Commits](https://img.shields.io/badge/commits-conventional-fe5196?logo=conventionalcommits&logoColor=fff)](https://www.conventionalcommits.org/)
[![Keep a Changelog](https://img.shields.io/badge/changelog-Keep%20a%20Changelog-E05735)](https://keepachangelog.com/)

<h2 align="center" id="community-support">Community & Support</h2>

Real-time chat and early support: **[CodesWhat Discord](https://discord.gg/mWHCPJRzSx)**

Bugs and concrete feature requests go to **[GitHub Issues](https://github.com/CodesWhat/careerrat/issues)**; open-ended questions, ideas, and show-and-tell go to **[GitHub Discussions](https://github.com/CodesWhat/careerrat/discussions)**; real-time chat happens on the **[CodesWhat Discord](https://discord.gg/mWHCPJRzSx)**.

Found a bug in the app itself? Say so in your CareerRat chat. It prepares
redacted diagnostics (never candidate PII, comp, or workspace contents) and
only opens a GitHub issue with your explicit yes.

Private vulnerability reports: [Security policy](.github/SECURITY.md).

---

**[MIT License](LICENSE)**

<a href="https://github.com/CodesWhat">
  <img src="apps/website/public/codeswhat-logo.png" alt="CodesWhat" height="28">
</a>

<a href="#careerrat">Back to top</a>

</div>
