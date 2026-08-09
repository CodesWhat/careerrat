# CareerRat Claude Instructions

Follow [AGENTS.md](AGENTS.md). It is the source of truth for intent routing,
the body-read gate, artifact completeness, and submit safety. If
`candidate/AGENTS.md` exists, read it too for candidate-specific context; if the
workspace is not set up yet, run `ingest-profile` (or `careerrat ingest`) first.

Key rule: when the user asks to apply, run the `apply-job` workflow. `apply-job`
must run or verify `evaluate-job` before tailoring, filling, or submitting.

When the user asks to draft, reply to, follow up on, summarize, or negotiate a
job-search email or recruiter message, run `email-comms` and update tracker
communication state.

When the user asks to schedule, propose times for, confirm, or reschedule a
recruiter or hiring-team call or interview, run `schedule-meeting` (it owns
timezone resolution, double-booking avoidance, calendar-ready holds, and
scheduling write-back; non-scheduling threads hand back to `email-comms`).

When the user is in a live or verbal offer or negotiation call, or wants to
rehearse or script a verbal comp conversation, run `interview-prep` (live
negotiation channel).

When the user asks to optimize, review, or improve their LinkedIn profile, or to
make it read for the roles they're targeting, run `optimize-linkedin`. It produces
a read-only before→after diff first (the default), and only writes edits back when
`profile_apply` is enabled, confirm-first per field.

When the user asks how risky, stable, or healthy a company is (layoffs, finances,
morale, "is this a safe place to land"), or to factor company risk into a role, run
`company-health`. It scores a role-scoped `healthy|watch|risky` rating with
provenance, persists it to the tracker, and feeds the fit score only where it
cross-cuts a stated candidate need. Cost-gated: auto-fires at the interview stage by
default; the rating is an internal signal and never enters an outbound artifact.

When a `careerrat` command crashes or behaves like it's broken, or the user asks to
report a bug or file an issue, run `report-issue`. It separates a real defect from a
config problem, assembles redacted diagnostics (never candidate PII, comp, or
workspace contents), and only with an explicit yes opens a GitHub issue on the
upstream `CodesWhat/careerrat` repo. It never auto-files.

When the user pastes an application-form or screening question and wants a drafted
answer outside a full tailor/apply run ("how should I answer this", "the form is
asking X"), run `answer-question`. It reuses `screening_answers` first, grounds new
answers in profile/honesty/evidence, never fabricates (the unanswerable case is the
literal `NEEDS YOU` marker), and persists durable disclosure-style answers back to
`form-defaults.yml#screening_answers` so they're never re-asked. During a full
tailor/apply run, `tailor-application` STEP 6 owns the answers artifact instead.
