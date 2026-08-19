<p align="center">
  <img src="assets/logo.png" alt="CareerRat" width="200">
</p>

<h1 align="center">CareerRat</h1>

<p align="center"><strong>Find, vet, and advance the right roles.</strong></p>

<p align="center">
  <a href="https://www.npmjs.com/package/careerrat"><img src="https://img.shields.io/npm/v/careerrat" alt="npm version"></a>
  <a href="package.json"><img src="https://img.shields.io/badge/node-%3E%3D24-339933?logo=node.js&logoColor=white" alt="Node >=24"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-C9A227" alt="License MIT"></a>
  <br>
  <a href="https://github.com/CodesWhat/careerrat/actions/workflows/ci-verify.yml"><img src="https://github.com/CodesWhat/careerrat/actions/workflows/ci-verify.yml/badge.svg?branch=main" alt="CI"></a>
  <a href="https://securityscorecards.dev/viewer/?uri=github.com/CodesWhat/careerrat"><img src="https://api.scorecard.dev/projects/github.com/CodesWhat/careerrat/badge" alt="OpenSSF Scorecard"></a>
  <br>
  <a href="https://www.npmjs.com/package/careerrat"><img src="https://img.shields.io/npm/dm/careerrat" alt="npm downloads"></a>
</p>

<hr>

## Contents

- [Docs](https://careerrat.com/docs)
- [Quick Start](#quick-start)
- [Why CareerRat](#why-careerrat)
- [Features](#features)
- [Roadmap](#roadmap)
- [Community & Support](#community--support)

<hr>

## Quick Start

You'll need:

- **Node.js 24 or newer**: check with `node -v`
- **An AI coding CLI**, either one:
  - Claude Code: `npm install -g @anthropic-ai/claude-code` ([claude.com/claude-code](https://claude.com/claude-code))
  - Codex: `npm install -g @openai/codex` ([github.com/openai/codex](https://github.com/openai/codex))

Then:

```bash
npm install -g careerrat
careerrat start claude    # or: careerrat start codex
```

macOS users can also download the signed, notarized desktop app from the
[latest release](https://github.com/CodesWhat/careerrat/releases/latest).

That sets up your workspace, opens the local app at `http://localhost:7777`, and
hands you off to the agent. From there you just talk to it.

### Your first hour

1. **Let it onboard you.** It asks a handful of questions and builds your profile
   from the answers: what roles you want, what you'll accept, what you won't,
   and the real work you've done. If you'd rather kick the tires first, say
   *"set me up with a quick sample profile."*
2. **Paste a job posting**, a description copied from anywhere, a link, or the
   sample in `examples/sample-jobs/`, and say *"evaluate this."* You'll get a
   verdict: keep it or cut it, how well it fits, whether the money works, and
   what to do next. All from an actual read of the posting.
3. **Say "write a résumé and cover letter for this."** It builds them from your
   own evidence and refuses to invent anything.
4. **Paste a recruiter email** and say *"draft a reply."* It writes the reply and
   remembers the thread.
5. **Open `http://localhost:7777`** and watch the job appear, move through your
   funnel, and pick up history. Quick local actions work in the app; longer work
   opens a visible conversation with the owning skill.

**One first-run thing that looks broken but isn't:** before you've onboarded,
`careerrat doctor` will report that your setup is incomplete and list
`candidate/*.yml` files to create. That's expected. Onboarding fills them in.

### Everyday commands

```bash
careerrat next       # the one thing worth doing next
careerrat doctor     # check your setup is healthy
careerrat update     # pull the latest code; your data is untouched
```

If the local app is already running, the update relaunches that recorded
CareerRat process on the updated code. Unrelated processes are never stopped;
CareerRat selects another loopback port instead.

The local app comes up with `careerrat start`. To run it on its own:

```bash
careerrat tracker        # snapshot tracker.json for recovery
careerrat tracker-dev    # serve http://localhost:7777 with live reload
```

**Useful flags on `start`:** `--no-agent` (workspace + local app only),
`--no-dashboard`, `--agent <name>` (override with a compatible agent command),
`--port <n>` (default 7777).

### Running from source

```bash
git clone https://github.com/CodesWhat/careerrat
cd careerrat
npm install
npm run hooks:install
npm link
careerrat start claude
```

<hr>

## Why CareerRat

CareerRat is a job-search workspace that runs on your own machine. You tell it
what you're actually looking for. It reads real job postings and tells you which
ones are worth your time, writes applications from things you've genuinely done,
drafts your recruiter replies, preps you for interviews, and keeps track of where
everything stands.

No account, no CareerRat server, no telemetry. CareerRat never phones home, and
your files stay on your machine. What does go out: your AI CLI talks to its own
provider to do the work, same as any other task you'd give it, and the app
fetches public resources like job postings and company logos from the services
that host them. The packaged desktop app also checks GitHub once a day for a
newer release and shows an in-app notice, nothing more; it never downloads or
installs anything on its own, and it can be turned off in Settings. See
[privacy](https://careerrat.com/docs/advanced/privacy) for the details.

Most job tools match keywords, then spray. CareerRat won't write a single line of
a cover letter until it has read the whole posting and checked it against what
you said you want: your comp floor, your location, your dealbreakers. Jobs that
don't clear that bar, it tells you to skip.

And it won't lie for you. Every claim in a tailored résumé traces back to
something you told it about your own work. If you didn't do it, it doesn't get
written.

CareerRat is an *agent runtime*. The CLI sets up the workspace and serves the
local app, but the job-search work happens inside your agent, reading a set of
skills that tell it how each step is done. That's why you talk to it in plain
language instead of memorizing subcommands. The first run detects supported AI
CLIs and explains the available choices.

The rule underneath all of it: **no tailoring, no applying, until the job has
passed a real read of the posting.** Titles and keywords are triage, not truth.

Same skills for anyone. A nurse, an engineer, and a driver each answer onboarding
their own way and get the same loop.

<hr>

## Features

- **Onboarding**: a conversation, not a form. Produces your targets, comp floor,
  evidence bank, honesty boundaries, and writing style.
- **Finding jobs**: builds searches from your targets, finds boards and company
  career pages worth watching, dedupes, drops dead links, and triages what's new.
- **Vetting jobs**: reads the full posting and judges it against your actual
  constraints before anything gets written.
- **Honest applications**: résumés, cover letters, and short answers built only
  from your evidence bank, with a check that blocks anything half-finished.
- **Applying**: fills portal forms for you, defaults to letting you hit submit,
  pauses at CAPTCHAs.
- **Recruiter comms**: drafts replies, follow-ups, scheduling, and negotiation,
  and keeps the whole thread.
- **Interview prep**: packets tailored to who you're talking to, a story bank
  grounded in your real work, and live coaching for comp conversations.
- **Outcome tracking**: records what happened, notices when your results say
  your strategy needs a rethink, and tells you.
- **Research**: company intel and comp benchmarks, kept firmly separate from
  your résumé claims so web findings can never launder into fake credentials.
- **Dashboard**: stat cards, funnel, active pipeline from sourced through offer,
  per-job detail, follow-up reminders, and table / board / calendar views. Tokyo
  Night and Gruvbox themes, light or dark.
- **Memory**: lessons from each application compound, so it gets sharper the
  longer you use it.

<hr>

## Roadmap

- [Roadmap](docs/ROADMAP.md): version themes and what's next
- [Sources strategy](docs/SOURCES.md): how job sources get curated
- [Architecture](docs/ARCHITECTURE.md) and [AGENTS.md](AGENTS.md): how the
  skills and the agent contract fit together

<hr>

## Community & Support

Bugs and feature requests: [GitHub Issues](https://github.com/CodesWhat/careerrat/issues).

Questions, ideas, and show-and-tell: [GitHub Discussions](https://github.com/CodesWhat/careerrat/discussions).

Chat: [CodesWhat Discord](https://discord.gg/mWHCPJRzSx).

---

**[MIT License](LICENSE)**
