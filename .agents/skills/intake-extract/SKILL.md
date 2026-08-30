---
name: intake-extract
description: "Read a dropped PDF or image file from a Universal Intake upload and transcribe its full legible text verbatim — no summarizing, no classifying, no résumé/candidate-specific assumptions. Backend-only: invoked by the embedded runtime for POST /api/intake/upload's PDF/image branch, never chat-routed or run conversationally."
metadata:
  tier_1_inputs:
    - intake file path
---

# intake-extract

> **Runs under AGENTS.md.** The contract that actually binds here is the Honesty
> Firewall: never fabricate text the source document doesn't contain. Most other
> AGENTS.md contracts (Tracker Write Contract, Activity Pulse, Gate Write-back) don't
> apply — this skill never writes to `workspace/tracker.json` or `activity.jsonl`; it
> only reads one file and replies with text. (Bare `workspace/` paths are symbolic;
> see AGENTS.md's Path Resolution rule.)

## Boundary — when this runs

This skill is **never** invoked conversationally and has no Intent Routing entry — a
user never asks for it by name. It exists solely as the backend of one Universal
Intake upload branch, `src/cli/intake-route.mjs`'s `POST /api/intake/upload` handler,
running it exactly once per PDF/image upload, headlessly, over the embedded one-shot
runtime (`src/core/ai/skill-runtime.mjs`'s `runSkillStream`), with the tool surface
restricted to `Read` only — no `Bash`, `Write`, `Edit`, or `WebFetch`.

The uploaded file could be anything a candidate drops into intake — a job
description, a recruiter's screenshot, an offer letter, a scanned form — **never
assume it's a résumé.** `.txt`/`.md` uploads decode locally without this skill;
`.docx` uploads extract via mammoth without this skill; `.eml` uploads parse
deterministically without this skill. This skill only ever runs for
`.pdf`/`.png`/`.jpg`/`.jpeg`/`.webp` uploads, and only when an AI route is
configured — the route itself skips straight to a manual-review outcome when no AI
route is available, so this skill is never invoked with nothing to call.

## The one job

You will be given the path to exactly one file, and possibly, on a retry, a
corrective note describing why your previous reply didn't parse. In either case:

1. **Read the file at the exact path given — nothing else.** Do not Glob, Grep, or
   Read any other file; you don't have those tools anyway, but don't try.
2. Transcribe **all** legible text, verbatim, in reading order — headings,
   paragraphs, lists, tables, signatures, footers. Do not summarize, rewrite, omit
   sections, or add facts. If part of the document is illegible, transcribe the
   legible parts only; never invent missing content.
3. Do **not** classify the document, extract structured fields, or guess what kind
   of content this is — that is a separate downstream step
   (`src/core/intake/classify.mjs`). Your only output is the transcribed text.
4. Multi-page PDFs are read up to 20 pages at once. If the document is truncated
   (e.g. a combined multi-document dump), transcribe what's visible and don't
   fabricate the rest.
5. Reply with **exactly one** fenced ` ```json ` code block and nothing else outside
   it — no preamble, no explanation, no markdown headers before or after.

## Output schema

The fenced block must be a single JSON object matching
`config/intake-extract.schema.json`:

```json
{"full_text": "Subject: Following up on the Staff Engineer role\n\nHi Jordan, just checking in on next steps for the Applied AI Engineer position..."}
```

- `full_text` — the best complete plain-text transcription of the file. This is the
  only PDF/image → text path the caller has, so it must always be a real, complete
  transcription — never blank.

## On a corrective retry

If the input includes a note saying your previous reply didn't parse or failed
schema validation, it means the caller (the server route) tried to parse your last
reply and couldn't. Re-read the same file (the path is repeated in the retry
instruction) and reply again with ONLY the fenced ```json block — no prose before or
after it this time, even if you narrated your reasoning last time.
