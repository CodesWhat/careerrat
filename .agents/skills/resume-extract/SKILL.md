---
name: resume-extract
description: "Read a dropped PDF/image résumé, or a markdown conversion of a dropped DOCX résumé, and emit one fenced JSON block matching the onboarding profile/targeting-draft schema — no prose, no invented factual claims, unknown contact fields left null. Backend-only: invoked by the embedded runtime for POST /api/onboard/resume-ai and POST /api/onboard/resume-docx's AI upgrade, never chat-routed or run conversationally."
metadata:
  tier_1_inputs:
    - intake file path
---

# resume-extract

> **Runs under AGENTS.md.** The contract that actually binds here is the Honesty
> Firewall: never fabricate a fact the source document doesn't contain. Most other
> AGENTS.md contracts (Tracker Write Contract, Activity Pulse, Gate Write-back) don't
> apply — this skill never writes to `workspace/tracker.json` or `activity.jsonl`; it
> only reads one file and replies with text.

## Boundary — when this runs

This skill is **never** invoked conversationally and has no Intent Routing entry — a
user never asks for it by name. It exists solely as the backend of two onboarding
wizard résumé-drop steps in `src/cli/onboard-route.mjs`, each running it exactly once
per upload, headlessly, over the embedded one-shot runtime
(`src/core/ai/skill-runtime.mjs`'s `runSkillStream`), with the tool surface restricted
to `Read` only — no `Bash`, `Write`, `Edit`, or `WebFetch`:

- `POST /api/onboard/resume-ai` — a dropped PDF or image (PNG/JPG/WEBP), read directly.
- `POST /api/onboard/resume-docx` — when an AI route is configured, a dropped DOCX
  gets converted to a markdown sidecar file first (preserving hyperlink targets a
  plain-text extraction would drop) and this skill reads that markdown file instead of
  the original DOCX. Same rules apply either way; only the intake file's format
  differs.

Plain-text/markdown résumés dropped directly by the user never reach this skill; they
go through the existing zero-AI `POST /api/onboard/resume` path (`resume-parser.mjs`).

## The one job

You will be given the path to exactly one file — a PDF, an image (PNG/JPG/WEBP), or a
markdown/plain-text conversion of a DOCX handed over by the route — and possibly, on a
retry, a corrective note describing why your previous reply didn't parse. In either
case:

1. **Read the file at the exact path given — nothing else.** Do not Glob, Grep, or
   Read any other file; you don't have those tools anyway, but don't try.
2. Extract factual fields only from what the document actually contains. Never invent
   a name, contact detail, employer, dates, or accomplishment that isn't legible in
   the source. A factual field you can't find is `null` (or an empty array for
   `claims`/section counts), never a guess or a placeholder.
3. You may infer **role targeting suggestions** from the resume's visible background,
   seniority, domain, tools, and company context. These are suggestions for the user
   to accept/reject later, not facts about the candidate. Use real posted job-title
   language; if there is not enough signal, return empty arrays rather than generic
   filler. Never infer target companies or a company thesis from a résumé. Paul learns
   those preferences directly from the user during onboarding.
4. Multi-page PDFs are read up to 20 pages at once. If the document is truncated
   (e.g. a combined cover-letter-plus-resume dump), extract what's visible and don't
   fabricate the rest.
5. Hyperlink URLs present in the text — including markdown `[text](url)` links from a
   converted DOCX — are legitimate sources for `linkedin`/`github`/`portfolio`. Extract
   the URL itself, never the visible anchor text, when the two differ.
6. Reply with **exactly one** fenced ` ```json ` code block and nothing else outside
   it — no preamble, no explanation, no markdown headers before or after.

## Output schema

The fenced block must be a single JSON object matching
`config/resume-extract.schema.json`. The recomposable `resume_document` source object
was dropped from this contract for speed (it roughly halved output tokens, which was
most of a resume-extract call's wall-clock time) — it returns only if/when a later
tailoring step actually needs a structured resume rebuild; `full_text` alone covers
today's callers:

```json
{
  "full_text": "Jane Doe\njane.doe@example.com\n\nExperience\nLed a team of 6 engineers shipping the payments platform rewrite\n\nSkills\nPython, JavaScript, SQL",
  "candidate": {
    "full_name": "Jane Doe",
    "email": "jane.doe@example.com",
    "phone": null,
    "location": null,
    "linkedin": null,
    "github": null,
    "portfolio": null,
    "domain": "software engineering"
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
  },
  "targeting_suggestions": {
    "role_buckets": [
      {
        "name": "Payments Platform",
        "priority": "primary",
        "titles": ["Senior Software Engineer, Payments", "Payments Platform Engineer"],
        "notes": "Visible experience combines team leadership and payments infrastructure delivery.",
        "fit_signals": ["payments infrastructure", "platform ownership"],
        "down_signals": ["pure frontend UI"]
      }
    ],
    "keep_signals": ["platform ownership", "team leadership"]
  }
}
```

- `full_text` — the best complete plain-text transcription of the resume. Preserve
  the visible reading order, headings, bullets, dates, employers, contact lines, and
  skill lists. Normalize repeated whitespace and line breaks, but do not summarize,
  rewrite, omit sections, or add facts. If part of the document is illegible, include
  the legible text only; never invent missing content. This is the only PDF/image → text
  path the caller has, so it must always be a real, complete transcription — never blank.
- `candidate.*` — contact fields only, each `null` when absent from the document,
  except `candidate.domain`: one short lowercase phrase naming the candidate's
  professional domain (e.g. `"software engineering"`, `"nursing"`, `"finance"`),
  inferred from the visible roles/skills/employers rather than read verbatim off
  the page. This feeds downstream tech-vs-general board selection
  (`generate-search-sources.mjs`), so use `""` — never `null` — when the resume
  genuinely doesn't give enough signal to infer one; do not guess to fill the
  field.
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
- `targeting_suggestions.role_buckets[]` — editable search tracks inferred from the
  resume. Emit **exactly one** bucket with `priority: "primary"` — the single
  strongest, best-evidenced track the resume actually supports. Add a `secondary`
  bucket only when the resume shows distinct, real evidence for a genuinely second
  track (not a rephrasing of the primary one); never pad the array with filler
  buckets just to fill space. `priority` must be one of `primary`, `secondary`,
  `stretch`, `oe`, or `adjacent`. Each bucket has real employer-posted titles at the
  right seniority. Use `notes` only when a short reason is useful. `fit_signals` and
  `down_signals` are lane-specific role/posting cues only; do not put person-wide
  guardrails such as travel, salary, location, or autonomy here.
- `targeting_suggestions.keep_signals[]` — concrete role/posting signals that would make
  a job relevant to this candidate. These are compatibility search/gate hints, not resume claims.

## On a corrective retry

If the input includes a note saying your previous reply didn't parse or failed
schema validation, it means the caller (the server route) tried to parse your last
reply and couldn't. Re-read the same file (the path is repeated in the retry
instruction) and reply again with ONLY the fenced ```json block — no prose before or
after it this time, even if you narrated your reasoning last time.
