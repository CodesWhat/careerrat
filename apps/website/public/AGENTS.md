# CareerRat — AGENTS.md

> **For humans:** this file is the AI agent's operating manual, not a setup guide for people.
> If you're trying to install CareerRat, see the README at
> <https://github.com/CodesWhat/careerrat> or the site at careerrat.com instead.

> **For AI agents:** you landed in the right place. Read this file, then follow the steps
> below to set the user up. The full operating contract ships inside the repo.

## What CareerRat is

A chat-first, local-first job-search tracker. It helps one person rate, apply to, and track
roles — from their own data, on their own machine, driven by their own AI agent (you). It
isn't a site you log into; it's a set of skills you run locally. There is no CareerRat account
or hosted candidate database. Workspace state stays local, the selected CLI uses its provider,
and the local app has no telemetry. CareerRat is free to self-host and MIT licensed.

## Requirements

- Node.js >= 24
- A supported coding-agent CLI on PATH, Claude Code or Codex (CareerRat runs *through* you):
  - Claude Code: `npm install -g @anthropic-ai/claude-code` (<https://claude.com/claude-code>)
  - Codex: `npm install -g @openai/codex` (<https://github.com/openai/codex>)

## Install & start

Install the package and launch it with the public `careerrat` binary:

```
npm install -g careerrat
careerrat start claude        # or: careerrat start codex
```

`start` scaffolds a local `workspace/`, installs the skills (so `/evaluate-job`,
`/apply-job`, etc. become available), seeds demo data and boots a live dashboard at
<http://localhost:7777>, then hands control to you with a starter message. Paste a job
posting and say "evaluate this", or try the bundled sample under `examples/sample-jobs/`.

## After it starts — what to do

The loop is **paste → route → tune**: the user pastes something (a job description, a
recruiter email, a LinkedIn URL), you classify it and run the owning skill, the tracker and
dashboard update. To get going:

1. **Onboard** — run `ingest-profile` (or `careerrat ingest`) to read the user's resume and
   generate their `candidate/*.yml` config plus a personalized `candidate/AGENTS.md`.
2. **Vet a job** — when the user pastes a JD, run `evaluate-job` before anything else.
3. **Apply** — `apply-job` (it verifies `evaluate-job` first, then `tailor-application`).
4. **Comms** — recruiter message → `email-comms`; scheduling a call → `schedule-meeting`.
5. **Track** — outcomes land on the dashboard at <http://localhost:7777>.

After install, **read the repo's own `AGENTS.md`** (the long one). It is the source of
truth for intent routing, the body-read and submit-safety gates, and tracker write-back.
This file only gets you to the front door — don't improvise procedures it covers.

## The skills

`answer-question` · `apply-job` · `calendar-sync` · `coach-gaps` · `company-health` ·
`configure` · `discover-companies` · `email-comms` · `evaluate-job` · `ingest-mail` ·
`ingest-messages` · `ingest-profile` · `intake-extract` · `interview-prep` ·
`optimize-linkedin` · `reevaluate-strategy` · `relationship-sourcing` · `report-issue` ·
`research-boards` · `research-comp` · `research-company` · `resume-extract` ·
`schedule-meeting` · `search-jobs` · `setup-searches` · `sync-status` ·
`tailor-application` · `track-outcomes`

## Rules — read before acting for the user

- **NEVER press a job application's final submit control.** Prepare the form and
  leave submission to the user. This is the one hard safety gate.
- **ASK before** sending any outbound message (email, LinkedIn) on the user's behalf.
- **ALWAYS run the owning skill** instead of improvising — skills are the how-to, AGENTS.md
  is the contract.
- Candidate state stays in the local workspace. When a workflow invokes the selected CLI,
  send only the context it needs and follow the documented provider and privacy boundary.

## Tool notes

- **Claude Code** reads `CLAUDE.md`, not `AGENTS.md`. If you saved this file locally, add
  `@AGENTS.md` to the top of your `CLAUDE.md` so it gets ingested. Once CareerRat is
  installed, its repo already wires `CLAUDE.md → AGENTS.md` for you.
- **Codex** reads `AGENTS.md` directly.

## Keeping current

- **Update an install:** run `careerrat update`.
  It fetches the latest published code via npm; your `workspace/` and `candidate/` data are
  untouched.
- **This file** is maintained by hand and versioned with CareerRat releases — a short
  onboarding pointer, not a living memory. For anything deeper, defer to the repo `AGENTS.md`
  and `docs/`, which are the canonical, always-current sources. Don't auto-generate it.
