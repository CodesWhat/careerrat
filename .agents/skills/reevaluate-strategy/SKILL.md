---
name: reevaluate-strategy
description: Learn from accumulated outcomes — read the funnel, rejections, interview transcripts, and wins, then recommend concrete tuning to targeting signals, comp anchoring, fit calibration, channel mix, and writing-style. Triggered by outcome thresholds or an explicit review request.
metadata:
  tier_1_inputs:
    - targeting.reevaluation thresholds
    - modes verdict
    - byStatus/byRoleFamily summary counts
  tier_2_inputs:
    - full tracker.json
    - rejection-reason notes
    - interview transcripts/conversations
---

# reevaluate-strategy

Use this skill when the user asks why they're getting filtered, to review their strategy, to re-rank sourced roles, or "what should I change" — or when `track-outcomes` trips a threshold (see the Reevaluation Contract in `AGENTS.md`). This is the self-tuning half of the loop: it turns accumulated outcomes into concrete, recommended adjustments.

> **Runs under AGENTS.md.** These contracts bind without being restated here: Privacy Invariant (`current_base` never outbound), Honesty Firewall, Placeholder/Bracket Ban, Gate Write-back, Domain-Neutral Rule, Browser Automation Contract, Activity Pulse logging, Tracker verify+snapshot, and Sent-Clears-Draft. Inline reminders at point-of-use are intentional; standalone restatements point back to the relevant AGENTS.md section.

> **Agent voice.** Read candidate modes through the shared DB-first accessor (`modes.agent_voice`, default `standard`) before producing strategy recommendations. Apply the register from AGENTS.md#mode-switches. `exec-summary` = top 2–3 recommended changes as bullets + threshold that tripped; `standard` = findings summary + recommendations as scannable bullets; `technical` = funnel analysis + per-signal breakdown + recommended changes; `verbose` = full analysis including win/rejection patterns, confidence levels, and proposed gate write-backs.

---

## STEP 0 — GATE CHECK (trigger confirmation)

**Trigger sources.** This skill is entered either:

- Explicitly by the user ("why am I getting filtered", "review my strategy", "re-rank prospects", "what should I change").
- Via handoff from `track-outcomes` STEP 6, which reads the persisted reevaluation gate at `tracker.json#analytics.reevaluation` (refreshed by `careerrat analytics --write` as part of the Tracker Write Contract) and hands off here when `reevaluation.due` is true — passing `reevaluation.dueReasons` (the tripped threshold names and counts).

**Read the persisted gate; do not recompute the trip.** The threshold comparison is already applied by `buildReevaluationAnalytics()` and stored in `tracker.json#analytics.reevaluation` — thresholds resolved from candidate targeting config `reevaluation.rejection_total` / `reevaluation.rejection_per_family` (defaults: 7 total, 3 per family if absent). This mirrors `track-outcomes` STEP 6 and the AGENTS.md Tracker Write Contract — read the block, trust `reevaluation.due`.

Pre-flight: `analytics.mjs` reads `workspace/tracker.json` (the source of truth) and resolves it relative to the repo root, so it runs from any cwd — no dashboard render is required first. If the file is missing, seed it: `cp templates/tracker.json workspace/tracker.json`.

Run: `careerrat analytics refresh --json` (dry-run read; use `-- --write` if you also want to persist the refresh to `tracker.json#analytics`).

The output (from `buildReevaluationAnalytics` in `src/core/tracker/outcome-analysis.mjs`) includes:

- `byStatus` — counts keyed by `status` value (e.g. `rejected`, `offer`, `awaiting`, `interview`).
- `rejected.total` / `rejected.byFamily` — cumulative rejected counts, total and per family slug (slugs derived from `role_families` → `role_buckets` → neutral title slug).
- `advanced.total` / `advanced.byFamily` — cumulative interview/offer counts, total and per family slug.
- `reevaluation.thresholds` — the resolved trip thresholds (total + per family).
- `reevaluation.sinceLastReview` — rejections accumulated since the last strategy-review stamp (`rejectionTotal` + `rejectionByFamily`). **This delta, not the cumulative total, is what trips the gate** — a strategy review stamps a snapshot, so only NEW rejections since then count.
- `reevaluation.due` / `reevaluation.dueReasons` — the trip verdict and the human-readable reasons. Trust this; never re-derive the trip from cumulative `rejected.byFamily` totals.

(`npm run analyze:outcomes` — `buildOutcomeSummary` — is the descriptive funnel breakdown used in STEP 1. Its `byRoleFamily` is total apps per family, NOT rejected-per-family, and it does not compute the trip. Never read the gate from it.)

**Branch:**

- If `reevaluation.due` is false AND the user did NOT explicitly request a review: report current counts, state "below threshold — no action needed," and exit.
- If `reevaluation.due` is true OR user explicitly requested: continue to STEP 1.

Also read application limits now. In DB mode use `careerrat data candidate get --json` (`application-limits.companies[]`); in legacy mode read `candidate/application-limits.yml`. Identify any per-company caps or cooldowns that could be inflating rejection counts — exclude cap-blocked entries from reject-pattern tallies (a cap block is not a strategy signal).

---

## STEP 1 — QUANTITATIVE BASELINE

**[DELEGATE: subagent]** The read-only analysis phase (STEPS 1–4) parallelizes — the
quantitative baseline, funnel tally, qualitative transcript read, and win analysis are
independent slices over the same data. Fan out a subagent per slice (each reads
`tracker.json` / transcripts and returns a structured findings block); the orchestrator
synthesizes the recommendation in STEP 5 and owns every write (STEPS 6–7, confirm-first).
Subagents read only — they never write config, the tracker, or learning files. STEP 0's
trigger gate already ran on the orchestrator. Degrade to inline sequential analysis with no
subagent primitive. See the **Delegation Contract** in AGENTS.md.

Run: `npm run analyze:outcomes`

This produces the full JSON breakdown. Extract the following slices (flag any slice with N < 3 as unreliable / "small-N"):

- **By role-family** (`byRoleFamily`) — counts keyed by the candidate's own family slugs. `classifyRoleFamily` in `outcome-analysis.mjs` derives these from candidate targeting config `role_families` (explicit `[{name, patterns[]}]`) → `role_buckets` (bucket `name` slugified, `titles` as patterns) → neutral title slug (no config). Do NOT hardcode any domain-specific family names here.
- **By fit-band** — `buildOutcomeSummary` does NOT emit a `byFitBand` field. Partition rejected applications by the **persisted `app.fitBucket`** field (written by `evaluate-job` at evaluation time, so it reflects the `fit_bands` thresholds that were in effect when each role was scored — the same bucket the dashboard shows). Do NOT re-derive bands by re-applying *current* `fit_bands` to `fitScore`: thresholds may have moved since these rows were evaluated, and silently re-bucketing the board is the exact consequential re-score STEP 7 gates as confirm-first. Fall back to `fitScore` + current `fit_bands` (`high_min` default 85, `med_min` default 65 — high ≥ high_min, med ≥ med_min, stretch < med_min) only for the rare row missing `fitBucket`.
- **By channel** (`byChannel`) — keyed by each application's `channel` value (e.g. `referral`, `recruiter`, `board`, `portal`). Cross-filter to rejected-only for reject-rate; cross-filter to `offer`/`interview` for advance-rate.
- **By mode** (`byMode`) — keyed by each application's `mode` value (e.g. `remote`, `hybrid`, `onsite`).
- **By sourced pipeline** (`sourcedFamilies`) — family-slug counts for sourced (not-yet-submitted) prospects; use this to check whether the candidate is feeding the right families into the top of the funnel.

Record: reject-rate and advance-rate for each slice, with N. Slices at small-N get a "(small-N: treat as directional only)" label.

---

## STEP 2 — FUNNEL POSITION TALLY

Read `workspace/tracker.json`. For each rejected application, inspect `conversations[]`. The schema defines `{date, kind, who, notes, recording}` — there is no `stage` field. Use `conversations[].kind` (e.g. `"resume-screen"`, `"recruiter"`, `"hm"`, `"panel"`, `"offer-comp"`) to derive funnel position. Use `conversations[].notes` for stated rejection reasons.

Locate each application row by matching `applications[]` entries on `id`, or on `company` + `role` if no `id` exists.

Tally rejection counts by `kind` value. Name the **dominant choke point** (the `kind` value with the most rejections). The fix depends on the stage:

| Dominant stage | Likely fix direction |
| --- | --- |
| resume-screen | résumé copy, keyword alignment, positioning |
| recruiter | comp anchoring, role-fit framing |
| HM / panel | depth of evidence, overclaim gaps |
| offer/comp | comp floor vs ask gap |

---

## STEP 3 — QUALITATIVE SIGNAL

For each affected role-family, check whether this rejection pattern was already logged (avoid surfacing the same recommendation twice if it was already actioned). Read via the CLI:

```
careerrat learnings read "<role title or family>" --family
```

(Pass the family slug with `--family`, or pass a role title without it and the CLI will resolve the slug. If the family has no file yet the CLI prints a note to stderr and exits 0 — a missing file is normal and not an error.)

From `conversations[].notes` across all rejected applications, identify recurring qualitative themes:

- Positioning mismatch or framing gap.
- Suspected overclaims (honesty.yml do_not_claim items mentioned as gaps).
- Comp rejection (offer-stage or below-floor `warn` flag set).
- Keyword miss (role required something not in résumé).
- Fit overcount (role scored high but rejected early).

Read `candidate/honesty.yml` to cross-check any claimed gaps against confirmed tools and do_not_claim boundaries. Do not surface a "gap" that honesty.yml lists as do_not_claim — that is expected.

---

## STEP 4 — WIN ANALYSIS

From the same `npm run analyze:outcomes` output, run the same family/channel/mode/fit-band breakdown on **advances and offers** only.

Identify where the candidate is advancing. This is the double-down signal — weight it as strongly as the rejection signal. A family/channel that is converting is evidence to prioritize, not noise.

---

## STEP 4b — ADAPTIVE RE-RANK NUDGE (rejection-feedback surface)

After completing STEP 4, synthesize STEPS 1–4 into a single structured recommendation block **before** presenting individual dimension proposals. This is the rejection-feedback nudge: use accumulated outcomes as evidence to update targeting priorities, not to silently re-score the board.

**Small-N rule (explicit):** Do NOT auto-apply any adjustment when the supporting evidence is N < 3 for that dimension. Present the recommendation and state the N. Let the user confirm. Only write changes to files after explicit acceptance. This rule applies even when a threshold was tripped — the threshold determines *whether* to run the analysis; the small-N rule determines *how confidently* to act on each slice.

Construct the recommendation block as follows:

---

### Strategy Adjustment Recommendation

**Trigger:** `<threshold name that was crossed>` — `<count>` total rejections / `<count>` in `<family-slug>` family (or "user-requested review").

**Where filtering is occurring:**

| Dimension | Slice | Rejections (N) | Advance/Offer (N) | Reject-rate | Signal strength |
|---|---|---|---|---|---|
| Role-family (`byRoleFamily`) | `<slug>` | N | N | % | reliable / directional |
| Channel (`byChannel`) | `<value>` | N | N | % | reliable / directional |
| Mode (`byMode`) | `<value>` | N | N | % | reliable / directional |
| Fit-band (derived) | high / med / stretch | N | N | % | reliable / directional |
| Funnel stage (from `conversations[].kind`) | `<kind>` | N | — | — | reliable / directional |

(Omit rows where N = 0. Mark N < 3 as "directional".)

**Recommended adjustments** (one line each; write-and-report vs. confirm-first noted):

1. **Re-rank sourced prospects** — `<specific family/channel to promote or deprioritize>` (affects `workspace/tracker.json` `priority`/`status` fields). N = `<N>`. [confirm-first if > 5 rows]
2. **Tighten targeting.yml cut-signals** — add `"<proposed signal string>"` to `cut_signals`. N = `<N>`. [write-and-report if N ≥ 3 and single clear signal; confirm-first if broad]
3. **Re-anchor comp** — propose new candidate profile `compensation.target_base` or `compensation.minimum_base`. [confirm-first — consequential]
4. **Fit recalibration** — `<high-fit-rejects pattern>`: spot-check with `careerrat evaluate` on 2–3 rejecting roles, then propose `fit_bands` or `keep_signals` tweak. [confirm-first — re-scores board]
5. **Double-down signal** — `<family or channel converting>`: increase sourcing weight here.

**Your call:** Accept all / accept some / decline. State which items to apply and I will write them now.

---

If no dimension has N ≥ 3 signal, state: "Insufficient data for high-confidence recommendations (all slices N < 3). Directional patterns noted above — continue sourcing and re-run when N reaches 3 in the flagged families."

## STEP 5 — RECOMMENDATIONS (detailed blocks, on accept)

After the user responds to the STEP 4b recommendation block — accepting all, some, or none — expand each accepted item into its full detail block. For declined items, skip. For items the user defers, note them as pending.

Produce one detailed block per accepted dimension (N ≥ 3 or explicit pattern). Each block must state the supporting N and evidence.

**(a) Re-rank sourced roles**
Name which family/channel to prioritize or deprioritize in `workspace/tracker.json` (direct edits to the `priority` or `status` fields of affected rows). State the before/after for each affected entry.

**(b) Signal tuning**
Propose specific strings to add to candidate targeting `keep_signals` or `cut_signals`. One proposed string per evidence line. Do not propose broad exclusions (e.g., "all companies over 500 employees") — those are consequential and go to confirm-first.

**(c) Comp re-anchor**
Read candidate profile `compensation.target_base`, `compensation.minimum_base`, and `compensation.current_comp_shareable`. `current_comp_shareable` is a read-only gate: if true, `current_base` may exist in profile but must NEVER appear in any output or recommendation regardless. All outbound comp uses `target_base`, `minimum_base`, or `expected_base` only (see foundations-spec §9).
If comp-stage rejections cluster, or `warn` flags appear on below-floor applications: propose a new `target_base` or `minimum_base` value.
**PRIVACY INVARIANT:** Never read, surface, log, or reference `current_base` in any output, recommendation, or artifact. Use only `target_base`, `minimum_base`, and `expected_base`.

**(d) Fit recalibration**
If high-fit roles (score ≥ high_min from targeting.fit_bands) reject while stretch roles (< med_min) advance, the scoring prior is off.
Spot-check: run `careerrat evaluate <path-to-job.md>` on a sample of 2–3 of the rejecting high-fit roles to see what would re-score them to med. Propose a targeted `keep_signals` or `fit_bands` threshold adjustment based on what those runs show. Do not silently re-score the whole board.

**(e) Writing/positioning adjustment**
If transcripts or rejection notes reveal a recurring overclaim or framing gap: propose a concrete change to `candidate/writing-style.md` (a specific line or section to add/modify, not vague advice). Note that `npm run calibrate:style` must run if new writing samples were added to `workspace/writing-samples/`.

---

## STEP 6 — CONFIRM BEFORE WRITING

Present all recommendations together as a numbered list with evidence for each.

**Write-and-report (unambiguous, low blast-radius):** a single new cut signal with clear evidence from >= 3 rejections; a new learning entry; a style note. Write it through the owning DB-aware command, then echo the CLI confirmation.

**Confirm-first (consequential):** dropping the comp floor, adding a broad excluded-company entry, large re-rank (> 5 sourced roles), or any change to candidate targeting `fit_bands` (a threshold change re-scores the entire board — always confirm first). Propose the exact change and get explicit user yes before writing.

If the user states a new gate mid-flow ("never apply to X", "below $Y is a no", "add Z as a cut signal"), write it through `careerrat gate` immediately (write-and-report for unambiguous; confirm-first for broad-exclusion/comp-drop) — a stated gate must never live only in chat.

---

## STEP 7 — WRITE-BACK (on accept)

**(a) Targeting signal changes**
Use `careerrat gate keep-signal "<signal>" --write` or `careerrat gate cut-signal "<signal>" --write` for accepted signals. For fit-band threshold changes, use `careerrat data candidate patch targeting --data ...` in DB mode after explicit confirmation; legacy YAML is fallback only when no DB exists. Run `careerrat doctor`.

**(b) Profile comp re-anchor**
If comp re-anchor accepted, use `careerrat gate comp-target <N> --write --confirm` or `careerrat gate comp-floor <N> --write --confirm`.
**Do NOT touch `compensation.current_base`** — it is a private gate input, not an output.

**(c) Re-rank write-back**

**DB workspaces:** never hand-edit `workspace/tracker.json`. Apply each accepted re-rank through the owning verbs — `careerrat data app set-status` for status changes, `careerrat data app set-fields` for `priority` and the `followUp` clears, `careerrat data comm upsert` / `comm append-message` for the comm-side clears and the note (`node src/cli/data.mjs --help` for exact syntax).

**Legacy workspaces:** edit `workspace/tracker.json` directly for any accepted re-rank changes (update `priority` or `status` fields on the affected rows).

**CTA clear (same write — no ghost CTAs):** For every row whose `status` changes to `deprioritized` or any terminal/inactive state (e.g. `withdrawn`, `dropped`, `closed`), in the **same** write also:

- Set `followUp.due` → `null` and `followUp.draft` → `null` (if the keys exist).
- Set `comm.nextActionDue` → `null` and `comm.draft` → `null` (if the keys exist).
- Rewrite `comm.nextAction` → `""` or remove the key.
- Append a note entry to `comm.messages[]`: `{ "date": "<YYYY-MM-DD>", "kind": "note", "actor": "agent", "body": "Row deprioritized via strategy review — outreach paused." }` — this preserves history and self-clears the CTA.

Echo the cleared fields for each affected row: `Cleared CTAs on <company>/<role>: followUp.due, comm.nextActionDue, comm.draft → null; note appended.`

Run `careerrat data verify` (DB mode) or `careerrat tracker --verify` (legacy) immediately after.

**(d) learnings/<family>.md — append dated entry**
For each affected role-family, compose the entry body as markdown using this template:

```
- **Pattern:** <1-2 sentence summary of what the data shows>
- **Evidence:** <app-id or company name citations from tracker.json>
- **Recommendation applied:** <exact change made — e.g. "Added 'no headcount' to cut_signals">
- **Advance signal:** <win patterns from same family, if any>
```

The `## <ISO-DATE> — <label>` heading is produced by the CLI (`--title` / `--date`); the body passed is the bullet block above only. Write the body to a temp file, then:

1. Dry-run (lints for placeholders and comp leaks):

   ```
   careerrat learnings append "<role title or family>" --title "<short pattern label>" --body-file <path-to-temp-file>
   ```

2. Commit on success:

   ```
   careerrat learnings append "<role title or family>" --title "<short pattern label>" --body-file <path-to-temp-file> --write
   ```

Pass `--family` if providing an explicit slug rather than a role title. Pass `--date YYYY-MM-DD` to override today's date. The CLI derives the family slug from candidate targeting config and creates `candidate/learnings/` and the file on first `--write`.

**(e) writing-style.md**
If writing/positioning change accepted, edit `candidate/writing-style.md` with the specific addition/modification. If new writing samples were added, run `npm run calibrate:style`.

**(f) tracker.json — stamp the review marker (ALWAYS, even on a no-change review)**
A completed review must clear the dashboard "review ready" nudge whether or not any
adjustment was accepted — running the analysis *is* the review. Stamp the marker:

```
careerrat strategy-review stamp --write
```

This records `tracker.json#strategyReview` = `{ lastReviewedAt, snapshot: { applied,
advanced, rejected, outcomes } }`, where `outcomes` (all-time advances + rejections) is
the count the render gate compares the live total against. The banner stays quiet until
the funnel produces enough NEW outcomes (default 5) — or a slow drip ages past the
cooldown (default 21 days). Dry-run without `--write` to preview. The marker is
mechanical (timestamp + outcome snapshot); this skill still owns the strategy judgement.
Without this stamp the nudge re-fires on every render forever, since the rolling 30-day
counts stay above threshold regardless of whether a review just ran.

---

## STEP 8 — VALIDATE AND SNAPSHOT

**Orphaned-CTA check (before render):** After stamping the strategy-review marker and before snapshotting, run a targeted check over every row whose `priority` or `status` was changed in STEP 7(c). For each such row, confirm in `workspace/tracker.json` that no `comm.nextActionDue` or `followUp.due` remains set on a row that is now in a dormant/inactive state. If `--verify` output flags orphaned due-dates on re-ranked rows, null them now and re-run verify before proceeding.

Run in sequence:

1. `careerrat tracker --verify` — schema check passes with zero errors.
2. `npm run verify:tracker` — tracker integrity check (foundations-spec §6, distinct from schema check above).
3. `careerrat tracker` — create a deduplicated recovery checkpoint under `workspace/.snapshots/`; the source write itself refreshes the live app.
4. `node src/cli/lint-placeholders.mjs candidate/learnings/` — belt-and-suspenders final sweep for placeholder strings in learning files. (`careerrat learnings append` already lints each entry on write; this is a backstop for the whole directory.)
5. If `candidate/writing-style.md` was changed: `node src/cli/lint-placeholders.mjs candidate/writing-style.md`.

All steps must pass before declaring the skill complete.

Activity Pulse logging: in DB mode, STEP 7(f)'s `strategy-review stamp --write`
already logs the "Strategy review" event itself — do NOT append a second one.
Only when the workspace is still in legacy tracker.json mode (no db yet) does the
stamp skip the log; in that case, and only then, log it manually (see **Activity
Pulse** in AGENTS.md):

```
careerrat activity append --type system --actor agent \
  --title "Strategy review" --summary "<what changed and why>" --write
```

---

## STEP 9 — CLOSE

State what changed, why, and which specific evidence drove each change (cite the N and the stage or note that motivated it). Keep it auditable.

Rules:

- Do NOT re-score the whole board silently — every mutation must be traceable to this session's evidence.
- Learn from wins as strongly as rejections — double down on what is converting.
- Hand drafting (follow-ups, withdrawals, recruiter outreach triggered by this review) to `email-comms`. This skill decides *what to change*, not the outreach itself.
- Never invent outcomes or transcript content; use only what is recorded in `workspace/tracker.json` and `candidate/learnings/`.
