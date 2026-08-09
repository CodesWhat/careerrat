# CareerRat Local Agent Instructions

Read this before touching jobs.

## Dashboard Dev Server

The dashboard should be live during active CareerRat work. Check
`http://localhost:7777`; if it is down, start `rolester tracker-dev` from the repo
root before telling the user to use the dashboard.

The normal entry point, `rolester start [agent]`, starts the dashboard as a
separate local process and records `.internal/tracker-dev.pid` plus
`.internal/tracker-dev.log`. Agents opened directly in the repo must perform the
same check themselves.

For agent-run sessions, detach it so it survives the current turn:

```bash
mkdir -p .internal
nohup rolester tracker-dev > .internal/tracker-dev.log 2>&1 &
echo $! > .internal/tracker-dev.pid
```

If port 7777 is already occupied by something other than CareerRat, use
`rolester tracker-dev --port 7778` and report the actual URL. Keep the server
running after tracker-visible changes so the page hot reloads. The dashboard is
read-only; agents and skills write `workspace/tracker.json`.

## Actionability Write-Back

Do not leave useful job-search state only in chat. The live dashboard renders from
workspace files:

- Compact/actionable state goes in `workspace/tracker.json`: applications,
  sourced roles, communication threads, message summaries, conversations, artifact
  paths, next actions, due dates, and source watermarks.
- Long/raw bodies go in local artifacts and are referenced by JSON:
  `workspace/comms/*.md`, `workspace/jobs/*.md`, `workspace/tailored/*`,
  `workspace/interview-prep/*`, and `workspace/research/*`.
- For every recruiter/email/message exchange, update `communications[]`, append a
  `messages[]` entry, set status/nextAction/nextActionDue, and store long thread
  bodies in `workspace/comms/` with `artifactPath`.
- For every application/interview/status change, update `applications[]`,
  artifact paths, follow-up state, and `conversations[]` as applicable.
- After tracker-visible writes, run `rolester tracker --verify`; run
  `npm run verify:tracker` when domain integrity could be affected; then run
  `rolester tracker` so the live UI hot reloads.

## Intent Routing

- If the user says "apply", "apply to this", "submit", "fill this application",
  or gives a JD URL with application intent: use `apply-job`.
- If the user says "find jobs", "search", "source", "scan", "refresh",
  "HiringCafe", or asks for a queue: use `search-jobs`.
- If the user says "gate", "evaluate", "is this a fit", "should I apply", or
  gives a JD URL without application intent: use `evaluate-job`.
- If the user asks to tailor a resume, cover letter, short answer, or
  non-message outreach artifact: use `tailor-application`, but only after the
  job has passed `evaluate-job`.
- If the user asks to write, reply to, follow up on, summarize, thank, schedule,
  negotiate, or respond to a recruiter/hiring email or message: use
  `email-comms`.
- If the user asks to add a tracked event to Apple Calendar, Google Calendar,
  Outlook Calendar, a real calendar, or an approved local automation tool: use
  `calendar-sync`. It requires the `calendar_sync` capability to be allowed for
  the selected provider in `rolester automation status`, previews the event,
  confirms first, writes only that provider, and appends `calendarWrites[]`.
- If the user asks to sync/import/check email from Apple Mail, Gmail, or
  Outlook, pull recruiter replies, or ingest mailbox updates: use `ingest-mail`.
  Gmail/Outlook requires the `mail_access` capability to be allowed for that
  provider in `rolester automation status`.
- If the user asks to find a recruiter, hiring manager, employee contact, warm
  path, referral path, or relationship contact for a tracked company or job: use
  `relationship-sourcing`. It requires the `relationship_sourcing` capability to
  be allowed for LinkedIn or Wellfound in `rolester automation status`, writes
  only review leads into `relationshipLeads[]`, and never sends outreach.
- If the user says they got an interview, screen, recruiter call, assessment, or
  panel: use `interview-prep`.
- If the user reports a rejection, interview request, follow-up, blocker, or
  status change: use `track-outcomes`.
- If the workspace is new or the candidate profile is incomplete: use
  `ingest-profile`.
- If a `rolester` command crashes or exits unexpectedly, a skill produces
  clearly-wrong output, or the user says "this is broken" / "report a bug" /
  "file an issue": use `report-issue`. It separates a real defect from a config
  problem, assembles redacted diagnostics (no candidate PII, comp, or workspace
  contents), and — only with an explicit yes — opens a GitHub issue on the
  upstream `CodesWhat/rolester` repo. It never auto-files.

## Mandatory Gate

`evaluate-job` is the shared mandatory gate. Before tailoring or applying, read
the JD body and emit:

```text
GATE: KEEP|CUT|REVIEW - reason
FIT: high|med|stretch <score> - why | caveats: ... | priority: ...
COMP: clear|review|below-floor|OE-bucket - reason
ACTION: apply-now|hold|manual|cut
```

Scanner scores are triage only.

`search-jobs` owns discovery and coarse intake. `apply-job` owns application
execution and must run or verify `evaluate-job` as step zero.

## Truth Boundary

Use `candidate/evidence.yml` and `candidate/honesty.yml` as source of truth.
Never invent facts.

Use tracker communication records and `workspace/comms/` thread notes before
asking the user to re-provide conversation history.

## Application Fill Autonomy

Custom screening questions are not blockers by default. During `apply-job`, answer
as the candidate from local context first: `candidate/form-defaults.yml` (including
`screening_answers`), `profile.yml`, `honesty.yml`, `evidence.yml`, the saved JD,
and generated tailored artifacts. Fill ordinary supported prompts — interest,
relevant experience, availability, location, travel, work authorization,
sponsorship, expected compensation, and confirmed-tool questions — without stopping.
Stop only when an answer would require fabrication, unsupported years/metrics/dates
or tool depth, a security clearance or legal claim not in evidence, private current
compensation, a contradiction of `honesty.yml`, or a materially new disclosure not
captured during onboarding.

## Public Default

Do not submit applications without explicit user confirmation unless
`candidate/form-defaults.yml` opts into auto-submit.
