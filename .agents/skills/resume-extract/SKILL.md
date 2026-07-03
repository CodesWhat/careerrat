---
name: resume-extract
description: Read a dropped PDF/image résumé and emit one fenced JSON block matching the onboarding profile-draft schema — no prose, no invented facts, unknown fields left null. Backend-only: invoked by the embedded runtime for POST /api/onboard/resume-ai, never chat-routed or run conversationally.
tier_1_inputs: [intake file path]
---

# resume-extract

> **Runs under AGENTS.md.** The contract that actually binds here is the Honesty
> Firewall: never fabricate a fact the source document doesn't contain. Most other
> AGENTS.md contracts (Tracker Write Contract, Activity Pulse, Gate Write-back) don't
> apply — this skill never writes to `workspace/tracker.json` or `activity.jsonl`; it
> only reads one file and replies with text.

## Boundary — when this runs

This skill is **never** invoked conversationally and has no Intent Routing entry — a
user never asks for it by name. It exists solely as the backend of the onboarding
wizard's PDF/image résumé-drop step: `POST /api/onboard/resume-ai`
(`src/cli/onboard-route.mjs`) runs it exactly once per upload, headlessly, over the
embedded one-shot runtime (`src/core/ai/skill-runtime.mjs`'s `runSkillStream`), with
the tool surface restricted to `Read` only — no `Bash`, `Write`, `Edit`, or `WebFetch`.
Plain-text/markdown résumés never reach this skill at all; they go through the
existing zero-AI `POST /api/onboard/resume` path (`resume-parser.mjs`).

## The one job

You will be given the path to exactly one file (a PDF or an image — PNG/JPG/WEBP) and
possibly, on a retry, a corrective note describing why your previous reply didn't
parse. In either case:

1. **Read the file at the exact path given — nothing else.** Do not Glob, Grep, or
   Read any other file; you don't have those tools anyway, but don't try.
2. Extract only what the document actually contains. Never invent a name, contact
   detail, employer, dates, or accomplishment that isn't legible in the source. A
   field you can't find is `null` (or an empty array for `claims`/section counts),
   never a guess or a placeholder.
3. Multi-page PDFs are read up to 20 pages at once. If the document is truncated
   (e.g. a combined cover-letter-plus-resume dump), extract what's visible and don't
   fabricate the rest.
4. Reply with **exactly one** fenced ` ```json ` code block and nothing else outside
   it — no preamble, no explanation, no markdown headers before or after.

## Output schema

The fenced block must be a single JSON object matching
`config/resume-extract.schema.json`:

```json
{
  "candidate": {
    "full_name": null,
    "email": null,
    "phone": null,
    "location": null,
    "linkedin": null,
    "github": null,
    "portfolio": null
  },
  "claims": [
    { "claim": "Led a team of 6 engineers shipping the payments platform rewrite", "evidence": "Source: resume (Experience — Acme Corp)." }
  ],
  "sections": {
    "experience": 2,
    "education": 1,
    "skills": 1,
    "projects": 0,
    "other": 0
  }
}
```

- `candidate.*` — contact fields only, each `null` when absent from the document.
- `claims[]` — one entry per genuine accomplishment line (a past-tense achievement
  verb, a metric/number, or a clearly scoped deliverable) drawn from experience or
  project sections — mirrors what `deriveEvidenceSeed()` extracts from plain-text
  resumes today, just read from a PDF/image instead. `evidence` is a short source
  pointer ("Source: resume (Experience — <employer/heading>)."), never a verification
  claim you can't back — the caller re-labels this as unverified evidence exactly
  like the plain-text path already does.
- `sections.*` — a plain **count** of entries found in each bucket (experience,
  education, skills, projects, other), not the content itself — the caller only needs
  these for the same "found N experience entries" summary the plain-text path shows.

## On a corrective retry

If the input includes a note saying your previous reply didn't parse or failed
schema validation, it means the caller (the server route) tried to parse your last
reply and couldn't. Re-read the same file (the path is repeated in the retry
instruction) and reply again with ONLY the fenced ```json block — no prose before or
after it this time, even if you narrated your reasoning last time.
