---
name: report-issue
description: When CareerRat itself looks broken — a crash, stack trace, non-zero exit, or clearly-wrong output — diagnose it, assemble redacted diagnostics, and (only with the user's explicit yes) open a GitHub issue on the upstream CareerRat repo.
---

# report-issue

> **Runs under AGENTS.md.** These contracts bind without being restated here: the Privacy Invariant (`current_base` and every piece of candidate PII never leave the machine), the Honesty Firewall (report what actually happened — never invent a repro or a symptom), and the Domain-Neutral Rule. Filing an issue is an **outbound publish to a public repo**: the per-invocation confirm-first gate and the redaction rules below are mandatory, not optional. Bare `candidate/` and `workspace/` paths below are symbolic; resolve them per AGENTS.md's Path Resolution rule.

> **Agent voice.** Read `candidate/modes.yml#agent_voice` (default `standard`). `exec-summary` = one line ("found a bug in X — want me to file it?") then just the link; `standard` = short diagnosis + the rendered issue preview; `verbose` = full diagnostics before the preview.

## Core Principle

When CareerRat breaks, the agent's job is three things: (1) tell a real defect apart from a user-config problem, (2) assemble a useful report that is **scrubbed of all personal data**, and (3) file it upstream **only after the user says yes**. This skill never auto-files, never runs on a schedule, and never puts candidate data in a public place. The issue is authored by the user's own `gh` identity, so their GitHub username is publicly attached to it — surface that before filing.

The report target is the upstream project tracker: **`CodesWhat/careerrat`**. (A fork maintainer can change this slug.)

---

## When to Use

Offer this skill when something looks like a **CareerRat defect**, not a user error:

- A `careerrat` CLI command throws, prints a stack trace, or exits non-zero unexpectedly.
- A skill workflow hits a tool crash, an unhandled exception, or produces clearly-wrong output (a mangled artifact, a gate that scores impossibly, a dashboard that won't render).
- The user says "this is broken", "report a bug", "file an issue", "tell the devs", "this doesn't work", or "open a ticket".
- A reproducible failure survives the obvious fixes.

**Do NOT use it for** missing or invalid config, an un-ingested profile, a gate the user simply disagrees with, or a ToS/permission block — those route to `configure`, `ingest-profile`, or `careerrat doctor`. Diagnose first; only escalate to an issue once you're confident it's a code defect, and say *why* you think so.

Offer, don't auto-run. The user opts in every time.

---

## STEP 1 — Confirm it's a bug, not a config problem

Run the cheap diagnostics and read the actual error before deciding anything:

```
careerrat doctor
careerrat --version
node --version
```

- If `doctor` flags missing config or schema drift → it's a setup issue. Route to `configure` or `ingest-profile`. Not an issue.
- If the failure is an unhandled exception, a stack trace into `src/`, or a reproducible wrong result from valid inputs → it's a real defect. Continue.

State your read out loud: "this looks like a CareerRat bug because `<reason>`," or "this is a config issue, here's the fix." Don't file on a hunch.

---

## STEP 2 — Assemble REDACTED diagnostics

Build the report from these, and **redact every one** per the rules below:

| Field | Source | Redaction |
|---|---|---|
| CareerRat version | `careerrat --version` | none (safe) |
| Node + OS | `node --version`, `process.platform` | none (safe) |
| Install method | in-tree clone vs global npm | none (safe) |
| Failing command | the `careerrat <cmd>` that broke | strip data args (names, paths, URLs) — keep the verb + flags |
| Error / stack trace | the thrown output | normalize home paths, drop any candidate data in the message |
| Expected vs actual | your diagnosis | generic phrasing, no candidate specifics |

**Redaction rules (hard — this is a PUBLIC repo):**

- **Never** include: candidate name, email, phone, location, `current_base` or any comp figure, employer or recruiter names, JD or tracker contents, or anything read from `candidate/` or `workspace/`.
- Rewrite absolute home paths `/Users/<name>/…` (or `/home/<name>/…`) → `~/…`, and workspace paths → `<workspace>/…`.
- Redact tokens, API keys, cookies, and any URL carrying a query-string secret.
- If a stack trace embeds a candidate value (e.g. a company name inside an error string), replace it with `<redacted>` — keep the shape of the error, drop the data.

When in doubt, leave it out. A vaguer-but-clean report beats a precise leak.

---

## STEP 3 — Dedup against existing issues

Search before filing so we don't pile on duplicates:

```
gh issue list --repo CodesWhat/careerrat --state open --search "<short error signature>"
```

If a matching open issue exists, offer to **add a comment** with the user's redacted repro instead of opening a new one. Only open a fresh issue when nothing matches.

---

## STEP 4 — Render the issue and get explicit consent

Build the title + body from this template, then **show the user the exact rendered text** and ask for a yes:

```
Title: <one-line summary of the failure>

### Environment
- CareerRat: <version>
- Node: <version>  •  OS: <platform>
- Install: <in-tree | global npm>

### What happened
<one or two sentences>

### Steps to reproduce
1. <redacted command / action>
2. …

### Expected
<what should have happened>

### Actual
<what happened, with the redacted error / stack trace fenced below>

​```
<fenced, redacted stack trace>
​```

---
_Filed via the CareerRat `report-issue` skill. Diagnostics were redacted of personal data._
```

Tell the user plainly: "this posts publicly to CodesWhat/careerrat under your GitHub account (`<gh username>`)." Get an explicit **yes** before filing. Nothing publishes without it.

---

## STEP 5 — File it

Try `gh` first (the user's authenticated path):

```
gh auth status                        # confirm authed; if not, use the fallback
gh issue create --repo CodesWhat/careerrat \
  --title "<title>" --body-file <redacted-body-file> --label bug
```

- On success, give the user the returned issue URL and confirm it's live (fetch it back if useful).
- Drop `--label bug` if the repo doesn't carry that label (the create fails on an unknown label).
- **Fallback (no `gh`, or not authed):** build a prefilled URL — `https://github.com/CodesWhat/careerrat/issues/new?title=<enc>&body=<enc>&labels=bug` — and hand it to the user to open. If the body is too long for a URL, print the redacted body for them to paste instead. Never block: the user always gets a one-click or one-paste path.

---

## STEP 6 — Report back

Give the user the issue URL (or the prefilled link) and a one-line confirmation of what was filed. This is a tooling action, not a job-search event — do **not** write any candidate-record state or Activity Pulse entry for it.

---

## Conversational workspace path

In the Ask workspace, preparing a redacted report and recording the filed
result are native: the app runs typed intents (`issue.report`,
`issue.record-filed`) directly in `workspace-agent.mjs`, not this skill's
CLI steps. A terminal or external-agent run still follows STEP 1 → 6 exactly
as written, using `gh` directly.

- **Prepare.** "Report a bug" (optionally with a description) builds an
  `issue_report` draft from the most recent workspace error, the app and Node
  versions, and the platform. Diagnostics are codes-primary: the error code
  maps to a generic developer-facing description, and raw error text is
  included only for unmapped codes after redaction; if any workspace
  identifier survives the scrub, the raw text is withheld entirely and the
  card says so. Home paths normalize, tracked company/role names, candidate
  location strings, and candidate identity strings are replaced, and comp
  phrasings in the user's own description are refused with a rewrite ask.
  Bare dollar figures split by source: in the user's own description they
  get a visible review warning, while in machine-generated error text they
  have no human in the loop to review them, so that text is withheld
  entirely like any other unredactable message.
- **File.** The card shows the full draft for review with a prefilled GitHub
  new-issue link. The app never runs `gh`, never holds GitHub credentials,
  and never posts: the user files it in their own browser under their own
  account, which is the explicit-consent step. STEP 3's dedup search has no
  workspace equivalent (the app cannot query GitHub); GitHub's own
  similar-issue suggestions on the new-issue page are the fallback, a known
  trade-off of this path.
- **Record.** "I filed it" runs `issue.record-filed`, which stores an
  `issue_filed` receipt in the workspace thread (with the issue URL when
  pasted, strictly validated to this repo's issue shape). Like STEP 6, this
  writes no Activity Pulse entry, and neither artifact lands in Downloads:
  the tooling-action exemption covers the Artifact Contract's export rule
  too, not just the Activity log.

---

## Rules

- **Confirm-first, always.** The rendered issue is shown and approved before anything posts. Never auto-file.
- **Redact ruthlessly.** No candidate PII, comp, employer/recruiter names, or workspace contents in a public issue. Normalize home paths. When unsure, drop it.
- **Bug, not config.** Diagnose first; route setup and permission problems to `configure` / `doctor`, never the issue tracker.
- **The user's identity is public.** The issue is authored by their `gh` account — say so before filing.
- **Dedup.** Search open issues first; prefer commenting on a match over opening a duplicate.
- **Never block.** If `gh` isn't available, fall back to a prefilled URL or a paste-ready body. The user always has a path.
- **Domain-neutral.** The only hardcoded value is the upstream repo slug (`CodesWhat/careerrat`); everything else is gathered at runtime.
- **Local-first.** Diagnostics are gathered locally; nothing leaves the machine except the single approved issue.
