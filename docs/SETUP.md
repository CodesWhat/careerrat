# Setup

CareerRat is a local, skill-driven job-search workspace. A supported local AI
CLI drives the workflow; the CareerRat CLI scaffolds, renders, and serves the
local app. CareerRat owns the workflows and threads, so durable search state
does not depend on one provider's session history.

## Prerequisites

- Node.js >= 24
- A supported coding-agent CLI on your PATH:
  - Claude Code:  `npm install -g @anthropic-ai/claude-code`  (<https://claude.com/claude-code>)
  - Codex:        `npm install -g @openai/codex`               (<https://github.com/openai/codex>)

Claude Code and Codex both run the complete CareerRat product. CareerRat shows a
runtime as `Ready` only after local availability, authentication, and the
complete readiness check pass.

The in-app AI preferences are provider-neutral. **Automatic** chooses the right
quality and thinking depth for each task: Paul stays on the strongest coaching
path, web research uses a balanced path, and small bounded helpers use a faster
path. **Faster**, **Balanced**, and **Best** override overall quality;
**Thinking depth** can be Automatic, Low, Medium, or High. The setting works the
same with Claude Code and OpenAI Codex and never switches providers.

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
npm run hooks:install
npm link
careerrat start claude    # or: careerrat start codex
```

That scaffolds your workspace, installs the skills, opens the local app at
<http://localhost:7777>, and hands off to your agent. Then paste a job posting and say
"evaluate this" — or try the bundled sample under `examples/sample-jobs/`.

`start` does the whole arc in one shot:

1. Scaffolds `.careerrat/candidate/` and `.careerrat/workspace/` directories (idempotent).
2. Installs the canonical skills so the selected agent sees `/apply-job`,
   `/evaluate-job`, etc.
3. Seeds `.careerrat/workspace/tracker.json` from the demo template (if not yet present).
4. Boots the live local app at <http://localhost:7777> with event-driven data updates.
5. Launches your agent with the starter message that asks it to read
   `AGENTS.md`, run `careerrat doctor`, and follow the next unfinished skill.

The first bare word picks the agent (`careerrat start claude` or `careerrat
start codex`). Omit it to use the first supported launcher found.

Flags: `--no-agent` (scaffold + local app only), `--no-dashboard`,
`--agent <name>` (alias for the positional), `--port <n>`.

## Update Later

```bash
careerrat update     # fetches the latest published code; your data is untouched
```

The update command pulls the latest release from npm and overwrites only the
code. Your `.careerrat/workspace/` and `.careerrat/candidate/` data are not touched. If the local app
is running, the updated launcher verifies its version and safely replaces only
that recorded CareerRat process. An unrelated process on the preferred port is
left alone and CareerRat uses another loopback port.

## Manual Wiring

Prefer to open the agent yourself?

```bash
careerrat install-skills
careerrat doctor     # confirm the scaffold and environment
```

Then open your agent in the repo root and send:

> Read AGENTS.md, run careerrat doctor, then guide me through the next unfinished CareerRat skill.

The agent reads `AGENTS.md`, verifies the skills shim, and runs `ingest-profile`
conversationally if the candidate profile is not yet set up. Once Paul has the
minimum role and location context, CareerRat starts the deterministic baseline
search in the background while the rest of setup continues.

Search and intake workers belong to the CareerRat app, not the currently open
view. They keep running when the user navigates elsewhere. A reload restores
their durable status; a service restart turns interrupted work into an explicit
retry instead of claiming success.

## Candidate Setup

`ingest-profile` (or `careerrat ingest`) interviews you and produces these files
under `.careerrat/candidate/` (gitignored):

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

Setup starts as one plain-language conversation. It uses the résumé and facts
already available, asks only for missing information, and saves progress after
each settled answer. You can stop at any point and resume later. Saved job-site
search login uses one point-of-use Yes/No question and no permission matrix.
Separate private-account browser, mail, calendar, messaging, and application
actions ask for their own concrete capability only when that action is needed.

`careerrat doctor` reports whether setup is complete or still in progress.

## Agent Files

- `AGENTS.md` — canonical intent router used by provider-neutral workspace flows.
- `.agents/skills/` — one canonical skill tree shared by direct and ACP runtimes.
- `CLAUDE.md` — points Claude Code at the same rules.

Both require `apply-job` to run or verify `evaluate-job` before tailoring,
filling, or submitting.

## Dashboard

`careerrat start` brings the dashboard up. To run it separately:

```bash
careerrat tracker        # snapshot tracker.json for recovery
careerrat tracker-dev    # live-updating app server on :7777
```

`careerrat start [agent]` runs that dashboard as a separate local process and
writes `.careerrat/internal/tracker-dev.pid` plus `.careerrat/internal/tracker-dev.log`, so the page
stays available while the launched agent works.

`careerrat tracker` creates a deduplicated recovery snapshot and prints a summary.
The live server reads the canonical database view directly, watches exported tracker
state, and refreshes the open page over Server-Sent Events.

## Workspace Directories

By default `.careerrat/` (holding both `workspace/` and `candidate/`) is created
inside the cloned repo. An older install that already has top-level `candidate/`,
`workspace/`, `config/`, or `.internal/` directories at the repo root keeps
using those instead. Set `CAREERRAT_HOME` to put it somewhere else:

```bash
export CAREERRAT_HOME=~/careerrat-data
careerrat start claude
```

Everything under `CAREERRAT_HOME` is gitignored and never touches the repo tree.
Useful if you want to share one data directory across multiple checkouts or keep
your personal files off a work machine's repo path.

Generated and private artifacts live under `.careerrat/workspace/` (gitignored):

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
