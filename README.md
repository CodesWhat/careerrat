<p align="center">
  <img src="assets/logo.png" alt="CareerRat" width="200">
</p>

# CareerRat

**Find, vet, and advance the right roles.**

CareerRat is a job-search workspace that runs on your own machine. You tell it
what you're actually looking for. It reads real job postings and tells you which
ones are worth your time, writes applications from things you've genuinely done,
drafts your recruiter replies, preps you for interviews, and keeps track of where
everything stands.

No account, no server, no telemetry. CareerRat never phones home, and your files
stay on your machine. The one thing that goes out is whatever your AI CLI sends
to its own provider to do the work — same as any other task you'd give it. See
[privacy](https://careerrat.com/docs/advanced/privacy) for the details.

## Why it's different

Most job tools match keywords, then spray. CareerRat won't write a single line of
a cover letter until it has read the whole posting and checked it against what
you said you want — your comp floor, your location, your dealbreakers. Jobs that
don't clear that bar, it tells you to skip.

And it won't lie for you. Every claim in a tailored résumé traces back to
something you told it about your own work. If you didn't do it, it doesn't get
written.

## Getting started

You'll need:

- **Node.js 24 or newer** — check with `node -v`
- **An AI coding CLI**, either one:
  - Claude Code — `npm install -g @anthropic-ai/claude-code` ([claude.com/claude-code](https://claude.com/claude-code))
  - Codex — `npm install -g @openai/codex` ([github.com/openai/codex](https://github.com/openai/codex))

Then:

```bash
npm install -g careerrat
careerrat start claude    # or: careerrat start codex
```

That sets up your workspace, opens the dashboard at `http://localhost:7777`, and
hands you off to the agent. From there you just talk to it.

## Your first hour

1. **Let it onboard you.** It asks a handful of questions and builds your profile
   from the answers: what roles you want, what you'll accept, what you won't,
   and the real work you've done. If you'd rather kick the tires first, say
   *"set me up with a quick sample profile."*
2. **Paste a job posting** — a description copied from anywhere, a link, or the
   sample in `examples/sample-jobs/` — and say *"evaluate this."* You'll get a
   verdict: keep it or cut it, how well it fits, whether the money works, and
   what to do next. All from an actual read of the posting.
3. **Say "write a résumé and cover letter for this."** It builds them from your
   own evidence and refuses to invent anything.
4. **Paste a recruiter email** and say *"draft a reply."* It writes the reply and
   remembers the thread.
5. **Open `http://localhost:7777`** and watch the job appear, move through your
   funnel, and pick up history. The dashboard is read-only on purpose — the agent
   does the work, the dashboard shows it.

**One first-run thing that looks broken but isn't:** before you've onboarded,
`careerrat doctor` will report that your setup is incomplete and list
`candidate/*.yml` files to create. That's expected. Onboarding fills them in.

## What it does

- **Onboarding** — a conversation, not a form. Produces your targets, comp floor,
  evidence bank, honesty boundaries, and writing style.
- **Finding jobs** — builds searches from your targets, finds boards and company
  career pages worth watching, dedupes, drops dead links, and triages what's new.
- **Vetting jobs** — reads the full posting and judges it against your actual
  constraints before anything gets written.
- **Honest applications** — résumés, cover letters, and short answers built only
  from your evidence bank, with a check that blocks anything half-finished.
- **Applying** — fills portal forms for you, defaults to letting you hit submit,
  pauses at CAPTCHAs.
- **Recruiter comms** — drafts replies, follow-ups, scheduling, and negotiation,
  and keeps the whole thread.
- **Interview prep** — packets tailored to who you're talking to, a story bank
  grounded in your real work, and live coaching for comp conversations.
- **Outcome tracking** — records what happened, notices when your results say
  your strategy needs a rethink, and tells you.
- **Research** — company intel and comp benchmarks, kept firmly separate from
  your résumé claims so web findings can never launder into fake credentials.
- **Dashboard** — stat cards, funnel, active pipeline from sourced through offer,
  per-job detail, follow-up reminders, and table / board / calendar views. Tokyo
  Night and Gruvbox themes, light or dark.
- **Memory** — lessons from each application compound, so it gets sharper the
  longer you use it.

Same skills for anyone. A nurse, an engineer, and a driver each answer onboarding
their own way and get the same loop.

## Everyday commands

```bash
careerrat next       # the one thing worth doing next
careerrat doctor     # check your setup is healthy
careerrat update     # pull the latest code; your data is untouched
```

The dashboard comes up with `careerrat start`. To run it on its own:

```bash
careerrat tracker        # write a static snapshot to workspace/tracker.html
careerrat tracker-dev    # serve http://localhost:7777 with live reload
```

**Useful flags on `start`:** `--no-agent` (workspace + dashboard only),
`--no-dashboard`, `--agent <name>` (any CLI on your PATH, e.g. `cursor`),
`--port <n>` (default 7777).

## How it works

CareerRat is an *agent runtime*. The CLI sets up the workspace and serves the
dashboard, but the job-search work happens inside your agent, reading a set of
skills that tell it how each step is done. That's why you talk to it in plain
language instead of memorizing subcommands, and why it works with whichever AI
CLI you already have.

The rule underneath all of it: **no tailoring, no applying, until the job has
passed a real read of the posting.** Titles and keywords are triage, not truth.

## More

- [Docs](https://careerrat.com/docs) — setup, guides, and reference
- [Architecture](docs/ARCHITECTURE.md) and [AGENTS.md](AGENTS.md) — how the skills
  and the agent contract fit together
- [Roadmap](docs/ROADMAP.md) · [Sources strategy](docs/SOURCES.md)

## Running from source

```bash
git clone https://github.com/CodesWhat/careerrat
cd careerrat
npm install
npm link
careerrat start claude
```

MIT licensed.
