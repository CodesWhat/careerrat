# Setup

CareerRat is a local job-search workspace with browser chat. A supported local
AI CLI runs the work behind the page; you can stay in the browser. CareerRat
owns the workflows and per-job threads, so recruiter messages, interview notes,
drafts and next steps do not depend on one terminal session's history.

## Prerequisites

- Node.js >= 24.15
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
careerrat start
```

Developing from a source checkout is the same command shape; link the local
binary once:

```bash
git clone https://github.com/CodesWhat/careerrat
cd careerrat
npm install
npm run hooks:install
npm link
careerrat start
```

That scaffolds your workspace and opens the local app at
<http://localhost:7777/app>. Choose your AI engine on the page, then continue
chatting there. Paste a job posting and say "evaluate this", or try the bundled
sample under `examples/sample-jobs/`. A terminal agent is optional.

`start` does the whole arc in one shot:

1. Scaffolds `.careerrat/candidate/` and `.careerrat/workspace/` directories (idempotent).
2. Seeds `.careerrat/workspace/tracker.json` from the demo template if absent,
   preserving existing work.
3. Starts or reuses the local app with event-driven data updates.
4. Opens the browser workspace. If the browser cannot open automatically, the
   launcher prints the address.

To work in a terminal agent too, name it explicitly: `careerrat start claude`
or `careerrat start codex`. This also installs the skill shim and sends the
doctor-driven starter message. Omitting the name keeps the conversation in the
browser; the page still uses your selected local AI engine.

Flags: `--no-agent` (browser only), `--no-dashboard` (terminal only, detecting a
supported agent when unnamed), `--no-open` (serve without opening a tab),
`--agent <name>` (alias for the positional), `--port <n>`.

## Exported Files

Resumes, cover letters and other saved job documents go in
`~/Documents/careerrat/<Company>/job-<application-id>/`. Each job has its own
folder, including when you apply for two roles at one company. The workspace keeps
the canonical originals; the job folder gives you copies to attach or open outside
CareerRat.
Rejected, withdrawn or closed jobs move to `_archive/<Company>/job-<application-id>/`
under the same CareerRat folder. Reopening a job restores its active folder.
Your job history and workspace originals remain available. Existing files in
Downloads stay where they are until their job ownership is established.

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
