<p align="center">
  <img src="assets/logo.png" alt="Rolester" width="200">
</p>

# Rolester

Agentic job-search workspace for finding, vetting, tailoring, tracking, and
preparing for the right roles.

A local, skill-driven workspace: define what you actually want, turn it into
searches, gate jobs against the real posting, tailor honest application
artifacts, track outcomes, and prep for interviews — all from your own data,
which never leaves your machine.

Tagline:

> Find, vet, and advance the right roles.

## Quickstart

**Prerequisites:**

- Node.js ≥ 24 — check with `node -v`
- A coding-agent CLI on your PATH — Claude Code or Codex:
  - Claude Code: `npm install -g @anthropic-ai/claude-code` ([claude.com/claude-code](https://claude.com/claude-code))
  - Codex: `npm install -g @openai/codex` ([github.com/openai/codex](https://github.com/openai/codex))

**Get it running:**

```bash
npm install -g rolester
rolester start claude    # or: rolester start codex
```

Developing from a source checkout is the same command shape; link the local
binary once:

```bash
git clone https://github.com/CodesWhat/rolester
cd rolester
npm install
npm link
rolester start claude    # or: rolester start codex
```

That scaffolds your workspace, installs the skills, opens the dashboard at
`http://localhost:7777`, and hands off to your agent. Then paste a job posting and
say "evaluate this" — or try the bundled sample under `examples/sample-jobs/`.
Run `rolester next` any time you want the terse next agent task.

**Update later:**

```bash
rolester update     # fetches the latest published code; your data is untouched
```

Nothing you enter leaves your machine. No account, no server, no build step.

Rolester is an *agent runtime*: the CLI sets up the workspace and dashboard, but the
actual job-search work happens inside your agent reading the skills.

**Useful flags:** `--no-agent` (scaffold + dashboard only), `--no-dashboard`,
`--agent <name>` (any CLI on your PATH, e.g. `cursor`), `--port <n>` (default 7777).

### A 5-minute path to confirm the whole loop works

Once your agent is up, use it the way a real candidate would:

1. **Let it onboard you.** It builds a profile by asking a few questions. To kick
   the tires without using real details, just say: *"set me up with a quick sample
   profile so I can test the flow."*
2. **Paste a job posting** (a JD copied from anywhere, a posting URL, or the bundled
   sample in `examples/sample-jobs/`) and say *"evaluate this."* You should get a
   `GATE / FIT / COMP / ACTION` verdict from an actual read of the posting — not a
   keyword match.
3. **Ask it to tailor:** *"write a resume and cover letter for this."* It builds
   honest artifacts from the profile's evidence bank and refuses to invent facts.
4. **Paste a recruiter email** and say *"draft a reply"* — it routes to the comms
   flow and tracks the thread.
5. **Open http://localhost:7777** and watch the application appear, move through the
   funnel, and accumulate activity. The dashboard is **read-only** — the agent does
   the work; the dashboard just shows it.

If those five land, the whole stack — CLI plumbing, skills, agent reasoning, and the
live dashboard — is working end to end.

**Prefer to let the agent run the test itself?** Open `claude` or `codex` in this
folder and say:

> read the README and AGENTS.md, set yourself up, and walk me through testing
> Rolester end to end

**What's normal, not a bug:** until you onboard, `rolester doctor`
reports that local candidate setup is incomplete and lists `candidate/*.yml` to
create — that's the expected pre-setup state, and your agent fills it in during
onboarding.

## What It Is

Rolester is built around a simple rule: do not tailor or apply until the job has
passed a real body-read gate. Title and keyword matches are triage, not truth.

The intended workflow:

1. Ingest the candidate profile, resume, evidence bank, and constraints.
2. Generate searches and source jobs into the sourced queue.
3. Read the JD body and emit a KEEP/CUT/REVIEW decision.
4. Tailor honest application artifacts from the evidence bank.
5. Draft and track recruiter/hiring communications.
6. Track applications and outcomes.
7. Build interview packets when a role advances.

## What's Built

The full apply-cycle is shipped and working end-to-end:

- **Guided onboarding** (`ingest-profile`) — conversational interview that
  produces `candidate/` config: targets, comp floor, evidence bank, honesty
  boundaries, writing-style calibration.
- **Search & intake** (`setup-searches`, `research-boards`,
  `discover-companies`, `search-jobs`) — build searches from your targets, find
  boards and employer ATS sources, dedupe, liveness-check, and triage the sourced queue.
- **Body-read gate** (`evaluate-job`) — reads the full posting; emits
  `GATE / FIT / COMP / ACTION` against your config before any tailoring.
- **Honest tailoring** (`tailor-application`) — résumé, cover letter, and
  short-answer artifacts built only from your evidence bank, with placeholder
  lint that blocks unresolved tokens.
- **Apply assistant** (`apply-job`) — portal form-fill recipes, manual-submit
  default, CAPTCHA pause.
- **Communication memory** (`email-comms`) — draft and track recruiter threads,
  follow-ups, scheduling, and negotiation.
- **Interview prep** (`interview-prep`) — audience-segmented packets grounded in
  your evidence; STAR+R story bank; live and written negotiation coaching.
- **Outcome tracking & strategy** (`track-outcomes`, `reevaluate-strategy`) —
  records results; triggers strategy review when rejection or advance thresholds
  trip.
- **Research loop** (`research-company`, `research-comp`, `research-boards`) —
  company intel, comp benchmarking, and board discovery with a citation-tier
  firewall so web findings never launder into résumé claims.
- **Tracker dashboard** — stat cards, funnel, Active Pipeline (Sourced → Offer),
  All-Jobs table, per-job detail, follow-up reminders; Table ⇄ Board ⇄ Calendar
  views; Tokyo Night and Gruvbox theme families.
- **Learning memory** — per-role-family lessons compound across loops; tailoring
  and evaluation get sharper each time.

Health check:

```bash
rolester doctor
rolester next
```

### The dashboard

`rolester start` brings the dashboard up for you. To run it on its own:

```bash
rolester tracker        # render workspace/tracker.html once — a static snapshot
rolester tracker-dev    # serve http://localhost:7777 with live reload
```

`rolester start [agent]` starts the live server as a separate local process and
records its PID/log at `.internal/tracker-dev.pid` and
`.internal/tracker-dev.log`, so the dashboard keeps serving while the agent does
the work.

`rolester tracker` publishes the dashboard shell to `workspace/tracker.html`
and its browser data adapter to `workspace/dashboard-data.js`. Use
`rolester tracker-dev` for the live command center: it serves the shell, the adapter, and
`workspace/tracker.json`, watches tracker data plus dashboard source, re-renders
through the same path as `rolester tracker`, and refreshes the open page over
Server-Sent Events.

## Product Notes

The roadmap lives in [docs/ROADMAP.md](docs/ROADMAP.md).
The source strategy lives in [docs/SOURCES.md](docs/SOURCES.md).

Naming decision: **Rolester**.

Why: it has the Napster/Friendster feel, it is role-specific, and it avoids the
generic "jobster" lane while still making sense for a job-search workspace.

Prior candidates now treated as alternates: `Prospectr`, `Prospector`,
`RoleRelay`, `CareerRelay`, `RoleProxy`, `See-V`, and `RoleScopeGo`.
