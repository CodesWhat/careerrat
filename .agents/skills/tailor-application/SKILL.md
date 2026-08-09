---
name: tailor-application
description: Generate finished, honest role-specific resumes, cover letters, short answers, and non-message outreach artifacts from a saved JD, source resume facts, candidate evidence bank, writing style, and form defaults after the job passes the CareerRat gate. Reject unresolved placeholders. Use email-comms for email replies, follow-ups, thank-yous, scheduling, negotiation, and recruiter-message threads.
---

# tailor-application

> **Runs under AGENTS.md.** These contracts bind without being restated here: Privacy Invariant (`current_base` never outbound), Honesty Firewall, Placeholder/Bracket Ban, Gate Write-back, Domain-Neutral Rule, Browser Automation Contract, Activity Pulse logging, Tracker verify+re-render, and Sent-Clears-Draft. Inline reminders at point-of-use are intentional; standalone restatements point back to the relevant AGENTS.md section.

## STEP 0 — Prerequisites: gate check

Read the current session context for the `evaluate-job` output block. Confirm it
contains `GATE: KEEP` or `GATE: REVIEW` for this role.

- If the gate output is present, echo the full block:
  ```
  GATE: KEEP|REVIEW - <reason>
  FIT: <band> <score> - <why>
  COMP: <verdict> - <reason>
  COMP ANCHOR: <expected salary to state> - <rationale>
  ACTION: <action>
  ```
- If the gate output is missing, run `evaluate-job` now before proceeding.
- If `FIT` is stretch (score < `candidate/targeting.yml#fit_bands.med_min`, default
  65), warn: "FIT is stretch — tailoring will require stronger narrative framing.
  Proceed?" Wait for explicit confirmation before continuing.
- If `GATE: CUT` is present, halt and explain; do not proceed without explicit
  user override.

## STEP 1 — Load gate files

Read in this order:

1. `candidate/honesty.yml` — note `tools.confirmed`, `tools.do_not_claim`,
   `education.add_education_section`, `claims.do_not_fabricate`
2. `candidate/evidence.yml` — note `claims[]`, `allowed_wording[]`,
   `forbidden_wording[]`
3. `candidate/targeting.yml` — note `role_buckets`, `degree_policy`, `fit_bands`
4. `candidate/form-defaults.yml` — note `expected_base`, `work_authorization`,
   `auto_submit`
5. `candidate/profile.yml` — note `candidate.toolchain`, `candidate.domain`,
   `compensation.expected_base` (outbound-safe); **do not read or echo
   `compensation.current_base`** — it is private and must not appear in any artifact

Classify the role-family for this job: match the JD title and responsibilities
against `targeting.yml#role_buckets` patterns, using the same logic as
`evaluate-job`. If `targeting.yml#role_families` is present, use those patterns;
otherwise derive families from `role_buckets` names; fall back to the outcome-
analysis defaults only when both are absent. Record the resolved family (e.g. `fde`,
`solutions`, `driver`, `dispatcher`, `finance`) — it drives file paths in later steps.

## STEP 2 — Load learning context

Run:
```
rolester learnings read "<role>"
```
The helper classifies the role-family from `targeting.yml` and prints the learning file to stdout. If no file exists for this family it prints a skip note to stderr and exits 0 — a missing file is normal, never an error.

When present, extract and note:
- Positioning that has landed well for this track
- Bullet phrasings that resonate with reviewers
- Keywords that appear to match
- Objections or gaps previously surfaced
- Comp signals and recurring reject reasons

These inform STEP 5 framing — every application to this track should be sharper
than the last. Learning files describe real outcomes; they do not authorize
fabricating new claims.

## STEP 3 — Calibrate writing style

Check whether `workspace/writing-samples/` contains any files newer than
`candidate/writing-style.md` (compare modification timestamps).

- If new samples are present: run `npm run calibrate:style`; wait for it to
  complete; then read the updated `candidate/writing-style.md`.
- If no new samples: read `candidate/writing-style.md` as-is.

Note tone, voice, sentence rhythm, and any explicit prohibitions before drafting.

## STEP 4 — Seed from closest existing tailored file

Scan `workspace/tailored/` for the closest existing tailored resume:

1. Prefer a file from the same role-family (same family key in filename or metadata).
2. Fall back to the same company if present.
3. If no prior tailored file exists, start from `candidate/SOURCE_RESUME.md`.

Use the found file as a **structural template only** — section order, heading names,
approximate length. Do not copy its content verbatim; every claim must be re-evaluated
against the current JD and evidence.

## STEP 5 — Tailor resume

Draft the tailored resume into `workspace/tailored/<Company> — <Role>.md`.

Rules (all non-negotiable):

- **Keywords:** mirror the JD's language and role-level signals. Apply keyword and
  positioning lessons from the learning file (STEP 2).
- **Evidence:** every non-obvious claim must map to a `claims[]` entry in
  `candidate/evidence.yml`. If a claim has no evidence entry, remove it or ask
  the user to provide evidence before including it.
- **Honesty:** never claim any tool listed under `honesty.yml#tools.do_not_claim`.
  Use only tools listed under `honesty.yml#tools.confirmed` unless the user
  explicitly confirms a new one mid-session (write-back rule below).
- **Education:** include an Education section only if
  `honesty.yml#education.add_education_section` is true and the claimed degree
  matches `claims[]`. Never fabricate or upgrade a credential.
- **Wording:** apply `evidence.yml#allowed_wording[]` and refuse any term in
  `forbidden_wording[]`.
- **Obfuscation:** replace internal codenames with the allowed public wording per
  `allowed_wording[]`.
- **Length:** target 1–2 pages. Cut low-signal bullets before adding new ones.
- **Compensation:** never include the candidate's current compensation anywhere.
  Use `form-defaults.yml#expected_base` only when a comp figure is explicitly
  required in a form field — not in resume prose.
- **Names:** all names must be real — actual candidate name, actual company names.
  No placeholders in artifact prose.

## STEP 6 — Cover letter and short answers

**Always produce a cover letter whenever the application accepts one.** It is a second
keyword-matching surface for the ATS and a free chance to reinforce fit, so it is the
default, not an optional extra. Produce one when **any** of the following is true:
- The application form has a cover-letter field — **required OR optional** (an optional
  field still means it accepts one; fill it)
- The application is sent by email or as an attachment, so a cover letter can ride along
- The JD explicitly requests one
- The FIT band is stretch (< 65) and narrative framing would materially help

Only omit the cover letter when the application has **no way to accept one** (no field
and no email/attachment channel). Do not ask — decide and act.

### Angle — automatic by default; the user can steer

Before drafting, fix the cover letter's **angle** across four dimensions. Derive
each **automatically** from the material already on hand — **never interrogate the
user for them.** If the user offered an angle, hook, emphasis, or tone in their
request, use it to override the matching dimension(s); otherwise infer and proceed.

| Dimension | Auto-derive from | User can override with |
| --- | --- | --- |
| **Why this company/role** | JD mission/product, a `workspace/research/<slug>.md` artifact if present, `targeting.yml` keep signals | "lead with why I want to work there", a stated reason |
| **Their problem** | JD responsibilities, named challenges, and the role's reason to exist | "they're struggling with X", a named pain point |
| **My approach / proof** | the `evidence.yml` claims that best map to their problem — **must trace to a real claim; never invent an angle to fit** | "emphasize my `<evidenced>` work", a chosen project |
| **Tone** | `writing-style.md` register + the JD/company formality | "make it warm", "keep it crisp", a stated voice |

Open on the single strongest why+problem pairing as the hook; support it with one
or two evidenced proof points; carry the tone throughout. When you present the
draft, state the chosen angle in one line so the user can redirect — but never
wait for permission to draft. A stronger user-supplied angle always wins over the
inferred one; an angle with no backing evidence is an Evidence Gap to surface, not
a narrative to fabricate.

### Form questions — fetch the real list, answer every one

Short answers start from the **actual application-form questions**, not guesses inferred
from the JD:

1. **Fetch the form.** Run `rolester questions workspace/jobs/<saved-job>.md` —
   deterministic, zero AI cost; supports Greenhouse and Ashby postings and writes the
   normalized list to `workspace/jobs/<saved-job>.md.questions.json`. For any other ATS,
   ask the user to paste the form's questions and capture them in the same shape with
   `rolester questions workspace/jobs/<saved-job>.md --paste`. If neither is possible,
   fall back to questions stated in the JD and say so in the packet summary.
2. **Answer every fetched question** in one answers artifact,
   `workspace/tailored/<Company> — <Role> — answers.md`: one section per question
   (verbatim label, required ones marked), the drafted first-person answer beneath.
   Use apply-job's screening-answer posture: `form-defaults.yml#screening_answers`
   first, then profile / honesty / evidence and the tailored artifacts. Entries with
   `type: "file"` are attachment slots (resume, cover letter) — list them at the top
   as attachments; never write prose for them.
3. **Never fabricate.** A question whose truthful answer would require guessing a
   number/date/clearance/tool depth, revealing current compensation, or contradicting
   `honesty.yml` gets the literal marker `NEEDS YOU: <one-line reason>` as its body.
   The placeholder lint (STEP 7) blocks on `NEEDS YOU`, so the packet cannot be
   upload-ready until the user supplies the answer.
4. **Persist durable answers.** When the user resolves a `NEEDS YOU` or confirms an
   answer to a recurring disclosure-style question, write it to
   `candidate/form-defaults.yml#screening_answers` (normalized question fragment →
   exact answer) so it is never asked again — and note it in
   `candidate/interview-notes.md` when it is a legal/disclosure answer.

All cover-letter and short-answer text follows the same constraints as the resume:
no unresolved placeholders, no forbidden wording, no unevidenced claims, no
`do_not_claim` tools, privacy invariant on comp. Apply `writing-style.md` tone rules.

Outreach and referral notes (non-message, non-email): follow the same artifact rules.
For email replies, follow-ups, thank-yous, scheduling, and negotiation threads,
hand off to `email-comms` instead.

## STEP 7 — Placeholder lint

Run:
```
node src/cli/lint-placeholders.mjs workspace/tailored/
```

Fix every finding before continuing. The command exits 1 on any hit.

Do not mark any artifact as upload-ready or build-ready until this exits 0.

Then log the tailored artifacts to the Activity Pulse feed (the dashboard's live timeline — see
**Activity Pulse** in AGENTS.md). One event per tailoring run:

```
rolester activity append --type tailored --actor agent \
  --title "Tailored application — <Company>" --summary "<what was built, e.g. 'résumé + cover letter'>" \
  --company "<Company>" --role "<Role>" --app-id <application id> --write
```

Treat these as invalid placeholders: `[Company]`, `[Role]`, `{candidate}`,
`<insert metric>`, `TODO`, `TBD`, `lorem ipsum`, `NEEDS YOU`, and any similar
template residue. (`NEEDS YOU` is the STEP 6 unanswered-question marker — resolving
it with the user, not deleting it, is the fix.)

**Stamp the tracker row — both paths (apply-job and standalone).** After lint exits 0,
write the produced artifact paths back to the application row in a single
`tracker.json` write before proceeding to STEP 8 or STEP 12:

```
applications[<id>].artifacts.resume      = "workspace/tailored/<Company> — <Role>.md"
applications[<id>].artifacts.coverLetter = "<cover letter path or inline text, if produced>"
applications[<id>].artifacts.answers     = "workspace/tailored/<Company> — <Role> — answers.md" (when form answers were produced)
applications[<id>].artifacts.resumeNote  = "<one-line tailoring approach>"
```

Then run the AGENTS.md verify+re-render gate:

```
rolester tracker --verify && rolester tracker
```

Both must exit 0 before continuing. Do not skip this on the standalone-artifacts
path — without it, the dashboard has no durable record that tailored materials exist.

**Real names, never placeholders — go generic when unknown.** Always use the
candidate's real name (`candidate/profile.yml#candidate.preferred_name` →
`full_name`) on every artifact, and real company/role/contact from the saved JD
and `tracker.json` record. If a detail is genuinely unknown, write it generically
— never leave a bracketed token and never block on it. A cover letter with an
unknown addressee opens `Hello,` or `Dear Hiring Team,` (only name a team if it's
actually known), not `Dear [Hiring Manager]`. An unknown metric is omitted, not
bracketed. Brackets in output are a build failure, not a TODO.

## STEP 8 — Build (renderer-detected)

Read `candidate/profile.yml#candidate.toolchain` (set at onboarding via
`ingest-profile`). Branch on its value:

> **Primary PDF path is STEP 11b** (`rolester export … --pdf`), which renders
> through the repo's bundled Playwright Chromium — reliable and zero-setup. The
> toolchain branches below are the **environment fallback** and the DOCX path:
> use them when the bundled export can't run, or to produce a `.docx`. Note that
> `soffice` on a raw `.md` (path b) does NOT reliably render Markdown — prefer
> STEP 11b for any PDF you intend to upload.

**a. `pandoc`:**
```
pandoc "workspace/tailored/<Company> — <Role>.md" -o "workspace/tailored/<Company> — <Role>.docx"
soffice --headless --convert-to pdf "workspace/tailored/<Company> — <Role>.docx"
```
`soffice` is the optional PDF-conversion companion; if it is not installed, mark
the artifact as `.docx` upload and skip the PDF step.

After the PDF generates (if soffice is available), eyeball it: confirm 1–2 pages,
correct font, all black, 0 non-ASCII characters, hyphen bullets. If any check
fails, fix the source and rebuild.

**b. `libreoffice`:**
For PDF, prefer STEP 11b (`rolester export … --pdf`) — `soffice` opens a raw
`.md` as plain text and will not render Markdown structure reliably. Use
LibreOffice only as a last-resort fallback when the bundled export can't run:
```
soffice --headless --convert-to pdf "workspace/tailored/<Company> — <Role>.md"
```
If you do fall back to this, eyeball the `.pdf` before marking it the upload
artifact (1–2 pages, correct font, all black, ASCII, hyphen bullets).

**c. `word`:**
No scripted Word-automation path (AppleScript/COM) ships. Prefer the `pandoc`
path (b) to produce the `.docx` if pandoc is available; otherwise open the `.md`
in the candidate's editor and convert manually, marking the artifact as pending
manual build.

**d. `markdown-only`:**
Skip build entirely. Mark the `.md` file as the upload artifact.

Never force a build dependency not detected at onboarding. Never install pandoc or
soffice on behalf of the user without explicit consent.

## STEP 9 — Privacy check

Before marking any artifact complete, confirm:

1. No occurrence of the candidate's current compensation (`profile.yml#
   compensation.current_base` or any dollar figure matching it) appears anywhere in
   the resume, cover letter, short answers, or outreach artifacts.
2. Any compensation figure present is sourced from `form-defaults.yml#expected_base`
   and appears only in a required form field, not in prose.

If a violation is found, remove it and re-run STEP 7.

## STEP 10 — Honesty gate write-back

If the user stated any new honesty boundary during this session (e.g. "never claim
Terraform", "remove that certification claim", "add Kubernetes to do-not-claim"):

- **Write-and-report** for unambiguous, low-blast-radius additions (one new tool to
  do_not_claim, one claim to forbid): run `rolester gate do-not-claim "<tool>" --write`
  or `rolester gate do-not-fabricate "<claim>" --write`, then echo the CLI confirmation.
- **Confirm-first** for consequential changes (removing a confirmed tool, broad
  claim rewrites): propose the exact candidate-config change, get a yes, then write
  through the owning DB-aware command.

The gate must not live only in chat. After writing, re-check the resume for
compliance with the new boundary and fix if needed.

## STEP 11 — Outcome analysis check (optional, non-blocking)

**Preferred timing:** run this before STEP 5 drafting so rejection patterns can
inform keyword and narrative choices. If the session has already reached this point
without the check, run it now as a final review.

If the role-family has prior tracked applications, run:
```
npm run analyze:outcomes -- --summary
```
Scan for rejection patterns in this family or fit band. If a known reject signal
appears in the current resume framing, flag it and offer to adjust before handing
off.

Skip if no prior applications exist (exit 0 or no output). Do not block on this
step.

## STEP 11b — Export (optional)

After artifacts pass placeholder lint (STEP 7) and ATS-safe validation, render
print-quality output on request or when the user needs a file for upload/print:

```
rolester export workspace/tailored/<Company> — <Role>.md --pdf --ats   # the copy you upload to an ATS
rolester export workspace/tailored/<Company> — <Role>.md --pdf          # brand/print copy (Geist)
rolester export workspace/tailored/<Company> — <Role>.md --pdf --docx
```

**Default the upload/submission PDF to `--ats`.** It renders in a standard,
widely-installed font stack (Arial/Helvetica/Courier) with no embedded Geist —
ATS résumé parsers extract text from a common system face far more reliably than
from an embedded variable brand font. Drop `--ats` only for a copy meant for human
eyes (portfolio, print, direct email to a person) where the brand face is wanted.

PDF needs no setup — it uses the Playwright Chromium bundled with the repo.
DOCX auto-detects pandoc, then LibreOffice/soffice, then falls back to a
built-in OOXML writer. Zero new dependencies in either case.

Use `--out <path>` to override the output location, `--title "..."` to set the
document title (defaults to the file's stem).

**Export a convenience copy to the company's Downloads folder.** After every PDF
renders (resume and cover letter), copy it there unconditionally, under the
per-company folder (Artifact Contract: organized by company, then by round):

```
~/Downloads/rolester/<Company>/<Company> - Resume.pdf
~/Downloads/rolester/<Company>/<Company> - Cover Letter.pdf   # if produced
```

Use the real company name for the folder and filename (no brackets — truly
unknown company → `unknown`). If a prior round's file with the same name is at
that company root, move it to `~/Downloads/rolester/<Company>/archive/` first so
the root only shows what's live. `workspace/tailored/` remains the source of
truth; Downloads is a convenience copy for quick access. Plain-text artifacts
(short answers, outreach notes) export as `.txt` to the same company folder.

## STEP 12 — Hand off

Confirm final artifact locations:
```
workspace/tailored/<Company> — <Role>.md
workspace/tailored/<Company> — <Role>.docx   (if built)
workspace/tailored/<Company> — <Role>.pdf    (if built)
```

- If the user intends to submit: hand off to `apply-job`. `apply-job` will re-verify
  the gate, fill the form, and handle submission per `form-defaults.yml#auto_submit`.
- If the user only wanted the artifacts: confirm files are ready and list their paths.
- Do not auto-submit from within this skill. Submission is owned by `apply-job`.
- **Learnings write-back is owned by `track-outcomes`, not this skill.** Read it
  via `rolester learnings read "<role>"` (STEP 2); appends are `track-outcomes`'
  job. After an outcome is known (rejection, advance, offer), run `track-outcomes`
  — it owns appending to `candidate/learnings/<role-family>.md`. Do not write to
  that file here.

**Clear any satisfied recruiter-materials comm CTA — same write as the artifact
stamp (or a dedicated write if the artifact stamp already ran).** Before confirming
artifacts to the user, scan `communications[]` for any thread on this role where
`status: needs-reply` and `nextAction` references providing materials, a resume, or
a cover letter. If such a thread exists, include these fields in the SAME
`tracker.json` write:

```
thread.status        = "waiting"
thread.nextActionDue = null
thread.nextAction    = "Await recruiter response"   # rewrite to reflect what's next
thread.messages[]   += { date: "<today>", kind: "note",
                          body: "Tailored resume + cover letter ready for send — pending email-comms dispatch" }
```

Writing the app row alone does NOT clear a live comm CTA. Both records must land in
the same write. A ghost comm CTA is a broken contract (see AGENTS.md
"Completed-action clears its CTA (hard)").

After any write at this step, run the verify+re-render gate again:

```
rolester tracker --verify && rolester tracker
```

Both must exit 0 before reporting completion to the user.
