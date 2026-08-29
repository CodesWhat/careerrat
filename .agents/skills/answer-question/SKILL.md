---
name: answer-question
description: Evidence-grounded drafted answers to one-off application-form or screening questions — reuses persisted `screening_answers` first, grounds new answers in profile/honesty/evidence, and never fabricates (the unanswerable case is the literal `NEEDS YOU` marker, never a guess). Durable disclosure-style answers (work authorization, sponsorship, relocation, notice period, clearance status, start date) persist back to candidate form defaults `screening_answers` so they're never re-asked; job-specific answers are never persisted. Capability = local files only — no browser, no submission.
---

# answer-question

> **Runs under AGENTS.md.** These contracts bind without being restated here: the Privacy Invariant (`current_base` never outbound), the Honesty Firewall (never fabricate an answer — the unanswerable case is the literal `NEEDS YOU` marker, not a guess), the Placeholder/Bracket Ban, the Domain-Neutral Rule, Activity Pulse logging, and Tracker verify+snapshot (only when a tracked application's answers artifact gets stamped). Inline reminders at point-of-use are intentional; standalone restatements point back to the relevant AGENTS.md section. Bare `candidate/`, `workspace/`, `config/`, and `.internal/` paths below are symbolic; resolve them per AGENTS.md's Path Resolution rule.

## Boundary — when this runs

Use this skill for one-off pasted application-form or screening question(s),
optionally with company/role context — typically via the `/answer` page
through the embedded runtime, or conversationally mid-session. During a full
tailor/apply run, `tailor-application` STEP 6 ("Form questions — fetch the real
list, answer every one") owns the answers artifact end to end; this skill
exists for "an extra question came up" outside that flow — a recruiter
forwards a supplemental question, a portal surfaces one after submission, or
the user is simply curious how to answer something.

**No STEP-0 gate check.** Every apply-surface skill (`apply-job`,
`tailor-application`) opens on a gate/limits check because it can submit,
upload, or advance an application. This skill never does any of that — it only
drafts text. The user pursuing the question at all already implies the pursue
decision was made elsewhere (by `evaluate-job` or by the user directly);
re-gating here is friction with no protective purpose.

If the input names a company/role that maps to a tracked `applications[]` row,
load its JD sidecar (`workspace/jobs/<saved-job>.md`) and any tailored
artifacts (`workspace/tailored/<Company> — <Role>.md`, `… — answers.md`) as
grounding context before drafting.

## STEP 1 — Parse the input

Extract the question text (one question, or several) and, if present, the
company/role context. Normalize each question for matching: trim whitespace,
lowercase, drop leading numbering/"Q:" labels, collapse to the distinguishing
fragment.

## STEP 2 — screening_answers first

Read candidate form defaults `screening_answers` through the shared DB-first
config accessor — plus the legacy read aliases `screeningAnswers` and `screening` in that same precedence order,
mirroring `configuredScreeningEntries()` in `src/core/apply/form-fill.mjs`
(~lines 498–505). Match each normalized question against the configured keys
by substring, the same rule `findConfiguredScreeningAnswer()` there applies.

On a hit: reuse the persisted answer's substance exactly. Adapt only the
phrasing to fit how this particular question is worded — never change what it
says. Mark the answer `SOURCE: screening_answers`.

## STEP 3 — Ground a new answer

No configured hit → draft fresh. Apply **`apply-job`'s screening-answer
posture** by pointer — see "Screening answer posture" in
`.agents/skills/apply-job/SKILL.md` STEP 7 — rather than restating its logic
here. Ground the answer in, in order of precedence: candidate form defaults,
profile, honesty, evidence, any tailored artifacts loaded in the Boundary step,
and the JD when available.
Write first person, in the candidate's writing style
(`candidate/writing-style.md`). Every claim must trace to a real
`evidence.yml` claim — never invent an angle to fit the question.

Stop only on the same conditions `apply-job` stops on: the truthful answer
would require fabricating, guessing a number/date/security-clearance/tool
depth, revealing private current compensation, or contradicting
`honesty.yml`. On a stop condition, the answer body is the literal marker
`NEEDS YOU: <one-line reason>` — this is already a recognized
placeholder-lint pattern in both `src/cli/lint-placeholders.mjs` and
`src/core/documents/placeholder-lint.mjs`; reference it, do not add new lint
code. Mark it `SOURCE: needs-you`.

Mark a grounded answer `SOURCE: evidence` or `SOURCE: profile` depending on
which input carried the substance, or `SOURCE: mixed` when both did.

## STEP 4 — Persist durable answers

**Durable** = a recurring disclosure/logistics-style answer that will come up
again verbatim on other applications: work authorization, sponsorship,
relocation, notice period, security clearance status, start date, and
similar. Write the normalized question fragment → exact answer into candidate
form defaults `screening_answers`: in DB mode use
`careerrat data candidate patch form-defaults --data ...`; in legacy mode use the
guarded compatibility config path. When it is a legal/disclosure answer, also
capture a local note/artifact through the owning skill; do not hand-edit
candidate YAML in DB mode.

**Never persist:** job-specific answers (why-this-company, role-fit essays,
anything referencing a particular employer or posting), and any `NEEDS YOU`
body — an unanswered question is not a durable answer.

## STEP 5 — Stamp + log

If the question maps to a tracked `applications[<id>]` row that already has
an answers artifact (`workspace/tailored/<Company> — <Role> — answers.md`),
append the new Q&A to that file and stamp
`applications[<id>].artifacts.answers` with its path. That is a tracker
write, so it follows the **Tracker Write Contract**: stamp
`meta.lastUpdatedAt`, increment `meta.version`, then
`careerrat tracker --verify && careerrat tracker` before reporting done. Skip
this sub-step entirely when the question doesn't map to a tracked row with an
existing answers artifact — there is nothing to stamp.

Always append one Activity Pulse event, regardless of whether a tracker stamp
happened:

```
careerrat activity append --type system --actor agent \
  --title "Answered a screening question" --summary "<question fragment, truncated>" \
  --company "<Company>" --role "<Role>" --app-id <application id> --write
```

Omit `--company`/`--role`/`--app-id` when no tracked row applies.

## Output contract

The final reply is the drafted answer(s), one block per question:

```
**Q:** <verbatim question>
**A:** <drafted first-person answer, or the NEEDS YOU marker>
```

Followed by exactly these trailing marker lines as the LAST lines of the
message, one per line — the `/answer` page's client parses these off the tail
of the assistant's final text and strips them from the rendered answer body:

```
SOURCE: screening_answers|evidence|profile|mixed|needs-you
DURABLE: yes|no
PERSISTED: <comma-separated normalized keys>|no
```

For a multi-question reply, use the single strongest applicable value per
line across the whole answer set (e.g. `mixed` if sources differ) — the
marker lines summarize the whole reply, not one line per question.
