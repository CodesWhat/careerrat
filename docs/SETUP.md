# Setup

CareerRat is a local, skill-driven job-search workspace. An agent (Claude Code,
Codex, or any AGENTS.md-aware tool) drives the workflow; the CLI scaffolds,
renders, and serves the dashboard.

## Prerequisites

- Node.js >= 24
- A coding-agent CLI on your PATH — Claude Code or Codex:
  - Claude Code:  `npm install -g @anthropic-ai/claude-code`  (<https://claude.com/claude-code>)
  - Codex:        `npm install -g @openai/codex`               (<https://github.com/openai/codex>)

## Get It Running

```bash
npm install -g careerrat
careerrat start claude    # or: careerrat start codex
```

Developing from a source checkout is the same command shape; link the local
binary once:

```bash
git clone https://github.com/CodesWhat/careerrat
cd careerrat
npm install
npm link
careerrat start claude    # or: careerrat start codex
```

That scaffolds your workspace, installs the skills, opens the dashboard at
http://localhost:7777, and hands off to your agent. Then paste a job posting and say
"evaluate this" — or try the bundled sample under `examples/sample-jobs/`.

`start` does the whole arc in one shot:

1. Scaffolds `candidate/` and `workspace/` directories (idempotent).
2. Installs skills so Claude Code sees `/apply-job`, `/evaluate-job`, etc.
3. Seeds `workspace/tracker.json` from the demo template (if not yet present).
4. Boots the live dashboard at http://localhost:7777 with hot reload.
5. Launches your agent with the starter message that asks it to read
   `AGENTS.md`, run `careerrat doctor`, and follow the next unfinished skill.

The first bare word picks the agent (`careerrat start claude`, `careerrat start
codex`, or any CLI on your PATH). Omit it to use the first one found.

Flags: `--no-agent` (scaffold + dashboard only), `--no-dashboard`,
`--agent <name>` (alias for the positional), `--port <n>`.

## Update Later

```bash
careerrat update     # fetches the latest published code; your data is untouched
```

The update command pulls the latest release from npm and overwrites only the
code. Your `workspace/` and `candidate/` data are not touched.

## Manual Wiring

Prefer to open the agent yourself?

```bash
npm install        # also runs install-skills via postinstall
careerrat doctor     # confirm the scaffold and environment
```

Then open your agent in the repo root and send:

> Read AGENTS.md, run careerrat doctor, then guide me through the next unfinished CareerRat skill.

The agent reads `AGENTS.md`, verifies the skills shim, and runs `ingest-profile`
conversationally if the candidate profile is not yet set up.

## Candidate Setup

`ingest-profile` (or `careerrat ingest`) interviews you and produces these files
under `candidate/` (gitignored):

- `profile.yml` — identity, location, comp floor and targets, domain/toolchain
- `targeting.yml` — role buckets, keep/cut signals, excluded companies
- `evidence.yml` — accomplishment claims that feed tailored artifacts
- `honesty.yml` — tools confirmed, do-not-claim, fabrication boundaries
- `form-defaults.yml` — applicant facts and expected-base for portal forms
- `modes.yml` — optional usage and application posture switches

Until `ingest-profile` has run, the agent will prompt to complete onboarding
before routing any other intent.

`modes.yml` can also be managed later with `careerrat modes`: `usage_mode` changes
how much discretionary work CareerRat runs, while `application_mode` changes how
aggressively it pursues already-discovered roles. If the file is absent, the safe
defaults are `standard` usage and `balanced` application mode.

## Setup Modes

When `ingest-profile` runs for the first time it asks two quick questions before
the main interview begins.

### Basic vs Advanced

- **Basic** — read-only, manual workflow. The agent researches, drafts, and
  guides; you copy/paste and click. No browser automation, no extension required.
- **Advanced** — opt into the authenticated browser + mail capabilities (status
  sync, authenticated search, in-platform message ingest, one-click apply,
  profile optimization, and `mail_access` for provider-agnostic verification-code
  reads via `webmail` plus Gmail/Outlook webmail ingest). Each
  capability is still individually off by default; nothing runs until you read a
  platform's terms, record consent, and enable it via `careerrat automation`. The
  Chrome extension is the preferred path (no separate credential store needed);
  `careerrat automation status` shows what's live. Choosing Advanced during
  setup just surfaces the install guidance and opt-in prompts at the right moment
  — you can enable or disable anything later.

### Deep vs Shallow (and resume-later)

- **Deep** — full onboarding interview in one session: identity, targets, comp,
  location, evidence, honesty boundaries, writing-style calibration, and (in
  Advanced mode) capability opt-ins.
- **Shallow** — collect the minimum-viable config now, defer the rest. The skill
  saves progress after each step to `workspace/setup-state.json` (written by the
  agent; gitignored). Re-running `ingest-profile` (or `careerrat ingest`) reads
  that file and resumes from where you left off, so you can stop and come back
  without losing ground.

`careerrat doctor` reports whether setup is complete or still in progress.

## Agent Files

- `AGENTS.md` — canonical intent router (used natively by Codex and similar).
- `CLAUDE.md` — points Claude Code at the same rules.

Both require `apply-job` to run or verify `evaluate-job` before tailoring,
filling, or submitting.

## Dashboard

`careerrat start` brings the dashboard up. To run it separately:

```bash
careerrat tracker        # one-shot snapshot → workspace/tracker.html
careerrat tracker-dev    # live-reloading dev server on :7777
```

`careerrat start [agent]` runs that dashboard as a separate local process and
writes `.internal/tracker-dev.pid` plus `.internal/tracker-dev.log`, so the page
stays available while the launched agent works.

`careerrat tracker` publishes the dashboard shell plus
`workspace/dashboard-data.js`. The live server serves those files alongside
`workspace/tracker.json`, watches tracker data and dashboard source, and refreshes
the open page over Server-Sent Events.

## Workspace Directories

By default `workspace/` and `candidate/` are created inside the cloned repo.
Set `CAREERRAT_HOME` to put them somewhere else:

```bash
export CAREERRAT_HOME=~/careerrat-data
careerrat start claude
```

Everything under `CAREERRAT_HOME` is gitignored and never touches the repo tree.
Useful if you want to share one data directory across multiple checkouts or keep
your personal files off a work machine's repo path.

Generated and private artifacts live under `workspace/` (gitignored):

- `jobs/` — saved job-description files
- `tailored/` — tailored resume, cover letter, and short-answer artifacts
- `intake/` — sourced and triaged posting queue
- `scan-results/` — raw board/ATS scan output
- `comms/` — recruiter and hiring communication threads
- `interview-prep/` — interview packets and story-bank exports
- `writing-samples/` — voice-calibration samples
- `research/` — company intel, comp benchmarks, board-discovery log

## Health Check

```bash
careerrat doctor
```

Reports environment health, skills discoverability, workspace scaffold state,
and any config schema errors.
