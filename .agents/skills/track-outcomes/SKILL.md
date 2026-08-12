---
name: track-outcomes
description: Record application outcomes, execute status transitions in tracker.json, append durable patterns to role-family learning files, check reevaluation thresholds, and write back any mid-flow gate changes stated by the user.
---

# track-outcomes

> **Runs under AGENTS.md.** These contracts bind without being restated here: Privacy Invariant (`current_base` never outbound), Honesty Firewall, Placeholder/Bracket Ban, Gate Write-back, Domain-Neutral Rule, Browser Automation Contract, Activity Pulse logging, Tracker verify+re-render, and Sent-Clears-Draft. Inline reminders at point-of-use are intentional; standalone restatements point back to the relevant AGENTS.md section.

## STEP 0 — Classify the incoming outcome

Accept one of: **rejection**, **interview invite**, **offer received**, **ghosted/stale**, **status update**, **blocker removal**, **manual note**, or **explicit gate change** ("never apply to X again", "add Y as a cut signal").

Identify the target application by company + role title (or `id` if known). Read the matching row from `workspace/tracker.json` (applications array). If no matching row exists, confirm with the user before creating a new entry.

## STEP 1 — Read gate files

**Mode detection:** run `careerrat data status`. Exit 0 → DB workspace — every
write step below gives the `careerrat data <verb>` command (Data Write Contract,
AGENTS.md). Nonzero exit → legacy workspace (no DB yet) — every write step below
gives the existing direct JSON-edit instructions, unchanged.

Read in order:

1. `candidate/targeting.yml` — `role_buckets`, `role_families` (if present), `cut_signals`, `excluded_companies`, and `reevaluation` thresholds (`rejection_total`, `rejection_per_family`).
2. Application limits — DB mode: `careerrat data candidate get --json` (`application-limits.companies[]`); legacy mode: `candidate/application-limits.yml`.
3. `workspace/tracker.json` — the full applications array for current status, fitScore, channel, mode, appliedAt, note, and conversations[].

If `candidate/targeting.yml#reevaluation` is absent, use defaults: `rejection_total: 7`, `rejection_per_family: 3`.

## STEP 2 — Execute the status transition

### Canonical status vocabulary

| Status | Array | Board visibility | Meaning |
|---|---|---|---|
| `sourced` | `sourced[]` | active | Discovered, not yet evaluated |
| `reviewed-hold` | `sourced[]` | active | Passed the evaluate-job gate; ready to pursue |
| `cut` | `sourced[]` | **archived** | Failed the gate (cut_signals, exclusions, comp below floor). Off the active board but kept in data, recoverable. Do not delete. |
| `closed` | `sourced[]` | **archived** | Posting gone / expired before evaluation. Off the active board. |
| `manual-apply` | `applications[]` | **active** | Auto-apply could not complete (Cloudflare/CAPTCHA human-check, ATS account or password reset required, Ashby/Workday exercise, ATS spam-rejection, or any step needing the human). Human must finish applying. ACTIVE — stays surfaced on the board. Record the specific reason + the apply URL in `note`. Never call this "blocked". |
| `awaiting` | `applications[]` | active | Submitted; waiting for response |
| `interview` | `applications[]` | active | Interview stage |
| `offer` | `applications[]` | active | Offer received |
| `rejected` | `applications[]` | active/archive | Closed with rejection |
| `withdrawn` | `applications[]` | **archived** | Candidate chose to withdraw mid-process (comp gap, competing offer, culture read, role-scope mismatch, or proactive exit). Distinct from a market rejection — the candidate acted, the market did not close. (Pre-application pruning — role cut/hold/skipped — also lands here via the STAGE_RULES keyword map, but that is scanner-only behavior; this status in `applications[]` always means a voluntary mid-process candidate exit.) |

**Archived statuses** (`cut`, `closed`, `withdrawn`) are off the active board but stay in the data. The dashboard triage banner counts `reviewed-hold` + `manual-apply` and prompts the user to review them with the agent.

**`manual-apply` is always active, never archived.** Once the human finishes applying, transition to `awaiting`.

### Permitted transitions

| From | Event | To |
|---|---|---|
| `sourced` | gate pass (evaluate-job KEEP/REVIEW) | `reviewed-hold` |
| `sourced` | gate cut (evaluate-job CUT) | `cut` (archived) |
| `sourced` | posting gone | `closed` (archived) |
| `reviewed-hold` | submitted successfully | `awaiting` |
| `reviewed-hold` | auto-apply blocked, human needed | `manual-apply` |
| `reviewed-hold` | user decides to pass | `cut` (archived) |
| `manual-apply` | human finishes applying | `awaiting` |
| `manual-apply` | user decides to pass | `withdrawn` (archived) |
| `awaiting` | interview invite | `interview` |
| `awaiting` | rejection | `rejected` |
| `interview` | final outcome | `offer` / `rejected` |
| `interview` | candidate withdraws | `withdrawn` (archived) |
| `offer` | accepted/declined | close the row with a note |
| any | user withdraws | `withdrawn` (archived) |

Apply the transition:

- **DB workspace:** run
  ```
  careerrat data app set-status <id> <to> --note "<statusNote text>" \
    [--follow-up-due <iso>] [--clear-interview|--no-clear-interview]
  ```
  One call sets `status` and `statusNote` (via `--note`) and `followUp.dueAt`
  (via `--follow-up-due`), bumps the stamp, refreshes analytics, and logs the
  activity event — all in one transaction. **On round completion** (leaving
  `interview`), it also nulls `nextInterviewAt`/`interviewNote`/`interviewAt`
  (the last one only when no next round is booked) automatically per the Data
  Write Contract in AGENTS.md — do not hand-null those fields; use
  `--clear-interview`/`--no-clear-interview` only to override the
  auto-detection for the edge case of advancing rounds while `status` stays
  `interview`. For `appliedAt` on a new submission, or any other field not
  covered by `set-status`, follow with
  `careerrat data app set-fields <id> --data '{"<field>": "<value>"}'` (shallow
  merge one level; not outcome-changing, so it does not re-refresh analytics —
  the preceding `set-status` call already did).
- **Legacy workspace (no DB):** edit `workspace/tracker.json` directly —
  - Set `status` to the new value.
  - Set the appropriate date field: `appliedAt` if this is a new submission.
  - **On round completion** (transitioning OUT of `interview` → `rejected`, `offer`, or next-round advance): in the same write, null out `app.nextInterviewAt`, null out `app.interviewNote`, and null out `app.interviewAt` if this was the last scheduled round. (If the candidate is advancing to a next round, `schedule-meeting` will write the new `nextInterviewAt` when that round is booked — track-outcomes always clears the just-completed round's values regardless.)

Either way, write the outcome to **typed, single-topic fields** per the
**Tracker Content Register** in AGENTS.md — no superlatives, no editorializing,
evidence only. The old "note OR conversations[]" choice is replaced by this
routing:

  | What you heard | Write to | DB-mode command |
  |----------------|----------|------------------|
  | Stage filtered / rejection / live state | `app.statusNote` (≤120 chars) + an activity event | covered by `app set-status --note` above |
  | Comp / band signal | `app.compNote` (≤140 chars) | `app set-fields <id> --data '{"compNote":"<text>"}'` |
  | Interview scheduled | `app.interviewNote` (≤60 chars) + a `conversations[]` entry (round `kind` follows the canonical Round Vocabulary in AGENTS.md — type, never number; `final` only when the process truly ends there) | `app schedule-interview <id> --at <iso> --round "<kind>" --note "<text>"` |
  | Process intel (next rounds, stakeholders) | `conversations[].processNote` (≤160 chars) | `app set-fields <id> --data '{"conversations":[...]}'` — `conversations` replaces wholesale (array field), so read the current row first and patch the one entry |
  | Coaching / objections | `conversations[].learnings[]` (labeled, ≤5) | same as above — `app set-fields` with the full patched `conversations` array |
  | Keyword / screening fit | `candidate/learnings/<family>.md` | unchanged in both modes — see STEP 5 |

  `app.note` is internal-only (search text + a ≤60-char submission one-liner) and is
  never rendered on a card — do not use it as an outcome dumping ground (DB mode:
  `app set-fields <id> --data '{"note":"<text>"}'`). Use
  `expected_base` / `target_base` / `minimum_base` for any comp — **never write
  `current_base` into any tracker field or note under any circumstances.**

## STEP 2b — Comm record write-back

If a `communications[]` record exists for this job, it **must** be updated for
this same outcome. A change that updates `app.*` and leaves the comm record
untouched leaves a ghost CTA on every comm-derived render surface (Next Steps
card, Focus card, Action Queue).

Set `comm.status`:
- Rejection, candidate withdrawal, role closed → `closed`
- Interview invite, offer received → `waiting` (next round or decision pending)
- Ghosted/stale being closed out → `closed`
- Blocker removed, data-completion form submitted, additional-info provided → `waiting`

Also clear `comm.nextActionDue` (→ `null`) and `comm.draft` (→ `null`, and
`app.followUp.draft` too if present) — the expected event has occurred and the
draft that backed it is gone — then append a note recording what happened.

- **DB workspace:** `comm.mjs` exposes `upsert` (full-row replace),
  `append-message`, and `mark-sent` (status → `waiting` + draft clear, meant
  for an actual outbound send) — there is no single partial-patch verb yet, so
  compose two calls, back-to-back in the same turn as STEP 2's `app set-status`
  (there is no combined app+comm transaction, so "same write" becomes "same
  turn — never leave the second call for later"):
  1. Patch the comm row locally (read the current shape from
     `workspace/tracker.json#communications[]`, apply the `status` /
     `nextActionDue: null` / `draft: null` rules above), then persist the whole
     row:
     ```
     careerrat data comm upsert --data '<patched full comm row JSON>'
     ```
  2. Append the outcome note:
     ```
     careerrat data comm append-message <comm-id> --data '{"direction":"note","at":"<ISO timestamp>","summary":"<one-liner, e.g. Rejection received — recorded by track-outcomes>"}'
     ```
  If `app.followUp.draft` is set and step 1 wasn't itself a `comm mark-sent`
  call, clear it too: `careerrat data app set-fields <app-id> --data
  '{"followUp": {"draft": null}}'`. Neither call refreshes analytics (not
  outcome-changing) — STEP 2's `app set-status` already did.
- **Legacy workspace (no DB):** edit `workspace/tracker.json` directly, in the
  **same write** as the app-row change from STEP 2:
  1. Set `comm.status`, `comm.nextActionDue = null`, `comm.draft = null` (and
     `app.followUp.draft = null` if present).
  2. Append a note to `comm.messages[]`:
     ```json
     { "direction": "note", "at": "<ISO timestamp>", "summary": "<one-liner: what was recorded, e.g. 'Rejection received — recorded by track-outcomes'>" }
     ```

**D.E.Shaw / Avature / data-completion case:** if the completion event is a submitted additional-info or data-completion form that was tracked in a `communications[]` thread (identified by subject line or recruiter name), treat that thread as the comm record above — flip it to `waiting`, null its `nextActionDue`, clear its `draft`, and append the outbound-completion note (DB mode: the same `comm upsert` + `comm append-message` pair).

## STEP 3 — Persist and validate

- **DB workspace:** STEP 2 and STEP 2b already persisted the state — each
  `careerrat data <verb>` call is its own atomic transaction, and each
  auto-exports `workspace/tracker.json` + `workspace/activity.jsonl`
  afterward (Data Write Contract, AGENTS.md). There is no single combined
  app+comm transaction, so the completeness guarantee is on the sequence of
  calls, not one write — run the STEP 2 and STEP 2b calls back-to-back, never
  deferring the comm call. Validate what landed:
  ```
  careerrat data verify          # re-exports, then domain integrity: status/score/modes/channels/dupes
  careerrat tracker --verify     # JSON shape/structure vs tracker.schema.json (data verify doesn't run this)
  ```
  If either reports errors, the DB row itself is wrong — fix it with another
  `careerrat data app set-fields` / `comm upsert` call (never hand-edit
  `tracker.json`, it is a regenerated file and the next export overwrites it).
  Do not continue until both exit clean.

  **Analytics:** `app set-status` (and `sourced promote`) already refreshed
  `tracker.json#analytics` as part of their own transaction — no separate call
  needed. If STEP 2 wrote only via `app set-fields` (e.g. a manual note with no
  status change), run `careerrat data analytics-refresh` explicitly so STEP 6
  reads a current reevaluation gate.
- **Legacy workspace (no DB):** edit `workspace/tracker.json` directly (the tracker CLI has no mutation subcommands — JSON edits are the only write path).

  **Single-write requirement:** all `app.*` and `comm.*` field changes from STEP 2 and STEP 2b must land in ONE tracker.json write. This includes the interview-round-completion nulls (`nextInterviewAt`, `interviewNote`, `interviewAt`) when transitioning out of an interview round. A partial write that updates the app row and leaves the comm record or interview datetime fields untouched is non-compliant — it leaves ghost CTAs on Next Steps, Focus card, and Action Queue.

  After editing, run BOTH validators — they check different things and neither
  replaces the other (see RULES):

  ```
  careerrat tracker --verify   # JSON shape/structure vs tracker.schema.json
  npm run verify:tracker              # domain integrity: status/score/modes/channels/dupes
  ```

  If either reports errors, fix the JSON before proceeding. Do not continue to the next step until BOTH exit clean.

  **Refresh the analytics block (required — this is an outcome-changing write).** After both validators pass and BEFORE re-rendering, recompute and persist `tracker.json#analytics` so STEP 6 reads a current reevaluation gate. Skipping this leaves the block one run stale, so a threshold crossed by the rejection you just logged is invisible to STEP 6 and the `reevaluate-strategy` handoff fires late or not at all:

  ```
  careerrat analytics --write   # recompute tracker.json#analytics: rejection/advance counts + reevaluation.due/dueReasons
  ```

## STEP 4 — Re-render the dashboard

- **DB workspace:** every `careerrat data <verb>` call in STEP 2/2b already
  re-exported `workspace/tracker.json` + `workspace/activity.jsonl` (Data Write
  Contract, AGENTS.md). If `careerrat tracker-dev` is running, its `fs.watch` on
  `tracker.json` already picked this up and live-reloaded the open page —
  nothing further to do. For a static snapshot, or to confirm the render by
  hand, still run:
  ```
  careerrat tracker
  ```
- **Legacy workspace (no DB):** run:
  ```
  careerrat tracker
  ```

Confirm the status change appears correctly in `workspace/tracker.html`. If the render output looks wrong, diagnose before proceeding.

If the outcome creates or extends a follow-up cadence (e.g., interview scheduled, offer pending response, ghosted application to chase), also run (a read, unaffected by DB vs legacy mode):

```
careerrat tracker --followups
```

Review any follow-ups now due and hand off to `email-comms` if a draft is needed.

**Ghost CTA check:** verify that no `communications[]` record for this job still shows `comm.nextActionDue` in the past, a non-null `comm.draft`, or `comm.status` in a stale state after a terminal app outcome. If found, STEP 2b was missed — go back and apply the comm write-back before continuing (DB mode: re-run the `comm upsert` patch).

Log the outcome to the Activity Pulse feed (the dashboard's live timeline — see **Activity Pulse** in AGENTS.md), picking the type by what happened:

- **DB workspace:** STEP 2's `app set-status` call already auto-logged one
  generic `status_change` event (and STEP 2b's `comm upsert`/`comm
  append-message` calls each logged their own). For the richer, outcome-specific
  type below, log an additional event — this verb only logs, it never bumps the
  stamp, and there is no `--write`/dry-run flag, every call is a real write:
  ```
  careerrat data activity append --data '{"type":"interview","actor":"world","title":"Interview stage — <Company>","summary":"<stage / detail>","refs":{"applicationId":"<application id>","company":"<Company>"}}'
  ```
  Swap `type`/`title`/`summary`/`actor` per the categories below (`offer`,
  `status_change`, `failure` with `"needsUser":true` for a blocker).
- **Legacy workspace (no DB):**
  ```
  # interview / screen / onsite advance:
  careerrat activity append --type interview --actor world \
    --title "Interview stage — <Company>" --summary "<stage / detail>" \
    --company "<Company>" --app-id <application id> --write

  # offer:
  careerrat activity append --type offer --actor world \
    --title "Offer — <Company>" --summary "<detail>" \
    --company "<Company>" --app-id <application id> --write

  # rejection / closed:
  careerrat activity append --type status_change --actor world \
    --title "Closed — <Company>" --summary "<reason>" \
    --company "<Company>" --app-id <application id> --write

  # candidate withdrawal (neutral tone — candidate exited, market did not close):
  careerrat activity append --type status_change --actor agent \
    --title "Withdrew — <Company>" --summary "<reason: comp gap / competing offer / culture read / role-scope mismatch / proactive exit>" \
    --company "<Company>" --app-id <application id> --write

  # blocker needing the user:
  careerrat activity append --type failure --actor world --needs-user \
    --title "Blocked — <Company>" --summary "<what's blocking>" \
    --company "<Company>" --app-id <application id> --write
  ```

## STEP 5 — Append to role-family learning file

The `learnings` helper resolves the family slug automatically from `candidate/targeting.yml` (`role_families` → `role_buckets` → neutral slug); no manual derivation is needed.

Compose the entry body as markdown, capturing only durable signal:

- **On rejection:** stage where filtered, objection or gap heard, comp signal if disclosed, keywords or framing that did not land, channel.
- **On candidate withdrawal:** reason the candidate chose to exit (comp gap, competing offer, culture read, role-scope mismatch, timeline mismatch, or proactive de-prioritization). This is strategy signal — record it to track which conditions drive voluntary exits so patterns can inform future targeting.
- **On advance/offer:** winning positioning or phrasings, keywords that landed, comp signal, channel that converted.
- **On ghosted/stale:** funnel stage last known, channel, elapsed time.

Keep entries evidence-linked — only record what was actually observed or stated. Do not invent lessons.

Write the entry body to a temp file (e.g. `/tmp/learning-body.md`), then:

1. Dry-run (preview + lint):
   ```
   careerrat learnings append "<role title>" --title "<short label>" --body-file /tmp/learning-body.md
   ```
2. If the preview looks correct, commit the entry:
   ```
   careerrat learnings append "<role title>" --title "<short label>" --body-file /tmp/learning-body.md --write
   ```

The helper creates `candidate/learnings/` and the family file on first `--write`. A missing family file is normal — the helper handles it silently.

## STEP 6 — Check reevaluation thresholds

The analytics block in `tracker.json#analytics.reevaluation` already applies the threshold comparison — it is refreshed automatically by `app set-status`/`sourced promote` in a DB workspace, or by `careerrat analytics --write` as part of the Tracker Write Contract in a legacy workspace (STEP 3/4). STEP 6 reads; it does not recompute.

Read `tracker.json#analytics.reevaluation`:

- `reevaluation.due` — `true` if any rejection threshold is crossed since the last recorded strategy review.
- `reevaluation.dueReasons` — human-readable strings explaining which thresholds fired (e.g. `"total 8>=7"`, `"family:fde 3>=3"`).
- `reevaluation.sinceLastReview.rejectionTotal` — rejection delta since the last strategy review (not all-time total).
- `reevaluation.sinceLastReview.rejectionByFamily` — per-family rejection delta since the last strategy review.
- `reevaluation.thresholds` — the resolved threshold values (`rejectionTotal`, `rejectionPerFamily`) in effect when the block was last computed.

Also read `tracker.json#analytics.advanced.byFamily` — a cluster of advances or offers concentrated in one family or channel is a signal to double-down on that targeting even when no rejection threshold fired.

If `reevaluation.due` is `true`, hand off to `reevaluate-strategy` and report:
1. The `dueReasons` strings (which thresholds fired).
2. The `sinceLastReview` counts (delta totals and per-family breakdown).

If `reevaluation.due` is `false` but `advanced.byFamily` shows a strong concentration of advances in one family, note it and hand off to `reevaluate-strategy` for a double-down review.

## STEP 7 — Write back mid-flow gate changes

If the user states any new constraint during the outcome flow ("never apply to X again", "add this as a cut signal", "cap this company at 1 app"), persist it through the owning DB-aware command immediately:

- Exclusion → `careerrat gate exclude-company "<Company>" --write --confirm`
- Cut signal → `careerrat gate cut-signal "<signal>" --write`
- Keep signal → `careerrat gate keep-signal "<signal>" --write`
- Per-company cap or cooldown → after confirmation, write `careerrat data candidate limits upsert --data '<json row>'` in DB mode; legacy mode writes `candidate/application-limits.yml`
- Comp floor or anchor change → `careerrat gate comp-floor <N> --write --confirm` or `careerrat gate comp-target <N> --write --confirm`

**Friction rule:** write-and-report for unambiguous, low-blast-radius changes (one clear cut signal). Confirm-first for consequential changes (broad exclusion, comp floor drop, large re-rank). After writing, echo the CLI confirmation.

A stated gate must never live only in chat. Do not hardcode it into skill prose.

## STEP 8 — Commit

Commit `workspace/tracker.json`, any updated `candidate/learnings/<family>.md`, and any gate file changes with a Conventional Commits message:

```
feat(tracker): record <outcome-type> for <Company> — <Role>
```

Include the role family and threshold status in the commit body if a reevaluation threshold was tripped.

---

## RULES

- Tracker mutations: **DB workspace** (`careerrat data status` exits 0) — go through `careerrat data <verb>` (Data Write Contract, AGENTS.md); never hand-edit `tracker.json`/`activity.jsonl`, they are regenerated files. **Legacy workspace** (no DB) — direct JSON edits + two complementary validation checks + `careerrat tracker` re-render: run `careerrat tracker --verify` (validates JSON shape/structure against config/tracker.schema.json — required keys, field presence) AND `npm run verify:tracker` (validates domain integrity — status recognizability, score range 0–100, modes, channels, duplicate company-role pairs). Both must pass; they check different things and neither replaces the other; the legacy tracker CLI itself is read-only (no mutation subcommands). Never fabricate a mutation subcommand beyond what `node src/cli/data.mjs --help` documents.
- **Never write `current_base` into any tracker field, note, conversations entry, or learning file.** Use `expected_base`, `target_base`, or `minimum_base` only (the `learnings` helper enforces this).
- Notes must be factual. No superlatives, no invented lessons, no editorializing.
- Use `email-comms` for drafting follow-ups or replies. This skill records the outcome; it does not draft outbound text.
- Do not check reevaluation thresholds from prose in AGENTS.md — always read `tracker.json#analytics.reevaluation` (refreshed automatically by `app set-status`/`sourced promote` in a DB workspace, or by `careerrat analytics --write` in a legacy workspace). The block applies the threshold comparison; the agent reads `reevaluation.due` and `reevaluation.dueReasons`, it does not recompute.
- Role-family taxonomy is driven by `candidate/targeting.yml` (`role_families` or `role_buckets`); `classifyRoleFamily` in `outcome-analysis.mjs` accepts a `targeting` arg and prefers candidate-supplied families over the built-in tech slugs, which apply only when no candidate config is present. `analyze-outcomes.mjs` wires targeting through, so non-tech candidates get correct family files.
- Reevaluation threshold fields (`reevaluation.rejection_total`, `reevaluation.rejection_per_family`) live in `candidate/targeting.yml` (schema'd) and are resolved into `tracker.json#analytics.reevaluation.thresholds` by `buildReevaluationAnalytics()`. The threshold comparison is done by the analytics block — do not manually read the YAML values and branch on them in STEP 6. Read the block, trust `reevaluation.due`.
