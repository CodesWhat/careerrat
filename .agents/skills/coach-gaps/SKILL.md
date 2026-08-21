---
name: coach-gaps
description: When a job's evaluate-job verdict lands at gate REVIEW with named fit gaps, name each gap a plan the candidate can act on — either an honest evidence-claim draft grounded in evidence already on record, or an explicit no-close-path — and route a confirmed draft through the evidence firewall before offering a re-evaluation.
tier_1_inputs: [application.evaluation.gate, application.evaluation.fitRisks, candidate/evidence.yml#claims, saved JD body]
tier_2_inputs: []
---

# coach-gaps

Use this skill when the user asks how to close a fit gap, improve their fit for a role, or
says something like "why did this land at review" and wants to do something about it. It is
the DB/web workspace's coaching loop, not a scanner: it only ever fires on a role
`evaluate-job` already body-read and scored, never on a raw sourced listing.

> **Runs under AGENTS.md.** These contracts bind without being restated here: Honesty
> Firewall, Placeholder/Bracket Ban, Domain-Neutral Rule, and the Tracker Write Contract
> (stamp → verify → snapshot → activity). Inline reminders at point-of-use are intentional.
> **One hard rail specific to this skill: a suggestion is never invented.** An evidence-claim
> draft may only restate what is already in `candidate/evidence.yml` or the current
> conversation — nothing new is fabricated to make a gap look closeable. A gap with nothing
> honest to say about it gets an explicit `no-close-path` suggestion, which is a correct,
> expected answer, never a fallback failure.

`evaluate-job` stays the narrow gate exactly as it is today — this skill never changes what
that gate does or how it scores. It only reads the gate's own output (`gate`, `fitRisks`)
after the fact.

---

## STEP 0 — Trigger

Fires **only** when both are true on the application's current typed `evaluation`:

- `evaluation.gate === "review"`
- `evaluation.fitRisks` is a non-empty array

Never on `gate: "keep"` (nothing to coach — the role already cleared) and never on
`gate: "cut"` (nothing to coach toward — comp-floor failures and hard cuts are not a coaching
problem). Always **explicit-click** — the "Coach me on this fit" button next to Re-evaluate
in the Jobs drawer's Evaluate card, or the same request typed in Ask. Never auto-fires,
matching the point-of-need consent rule every cost-gated skill in this workspace follows
(company-health's own STEP 1 is the sibling precedent).

---

## STEP 1 — Build the plan

The `coaching.plan` workspace intent (`src/core/agent/workspace-agent.mjs`) calls
`buildCoachingPlan` (`src/core/coaching/plan.mjs`), which is modeled directly on
`evaluatePacketGate` (`src/core/packet/gate.mjs`): the same `runBoundedAI` bounded-AI call,
the same schema-validated JSON contract (`coachingPlanSchema`,
`src/core/coaching/schemas.mjs`), and the same `NO_AI_ROUTE` degradation to a reviewable
(never fabricated) result when no AI route is configured.

Inputs, read fresh every run, never cached beyond the single call:

- `evaluation.fitRisks` — the gate's own named gaps, taken **verbatim**. The model never
  restates them; the persisted `gapText` is always the exact source string.
- `candidate/evidence.yml#claims` — the confirmed evidence bank (via the same
  `buildPacketContext` packet generation already reads).
- The saved JD body (`buildPacketContext`'s own JD read) — same body-read invariant
  `evaluate-job` used to produce the verdict this plan is built against.

For every named gap, in order, the model returns one suggestion:

- **`evidence-claim`** — only when the evidence bank or the current conversation already
  contains something that honestly closes the gap. The draft claim may not go beyond what is
  already on record.
- **`no-close-path`** — when nothing on record honestly closes the gap. Correct and expected
  for a real gap; never forced into an evidence-claim just to fill the slot.

A suggestion that claims `evidence-claim` but arrives with no usable draft is downgraded to
`no-close-path` before it is ever shown or saved — the plan never hands the candidate a claim
CareerRat cannot ground.

---

## STEP 2 — Persist the plan

Written through the existing generic `appSetFields` patch verb (`src/core/db/verbs/app.mjs`)
onto the application row's `coachingPlan` field — no new DB verb. Shape:

```jsonc
"coachingPlan": {
  "generatedAt": "2026-08-20T12:00:00.000Z",
  "basedOn": { "gate": "review", "fitScore": 68, "fitBucket": "med", "evaluatedAt": "..." },
  "gaps": [
    {
      "id": "no-direct-kubernetes-production-experience",
      "gapText": "No direct Kubernetes production experience on record",
      "suggestion": {
        "kind": "evidence-claim",
        "draftClaim": { "claim": "...", "evidence": "..." },
        "rationale": "..."
      },
      "status": "open"
    }
  ]
}
```

`status` starts `"open"` on every gap and only ever moves forward — `"closed"` once its draft
is confirmed into evidence (STEP 3), `"dismissed"` if the candidate skips it. This mirrors
`config/tracker.schema.json`'s `coachingPlan` block.

---

## STEP 3 — Confirm a draft into evidence (the firewall)

The candidate reviews each gap in the Coaching card and either confirms the draft ("Add to
evidence") or skips it. Confirming fires the `coaching.evidence-save` workspace intent, which
routes the draft through the **same** evidence firewall every other guarded evidence write
uses — never a bypass:

1. `computeEvidenceWrite` (`src/core/profile/evidence-writer.mjs`) validates the claim
   (id/claim/evidence required, placeholder-lint clean, no `current_base` leak) and computes
   the merged claim set.
2. `candidateEvidenceMerge` (`src/core/db/verbs/candidate.mjs`) is the actual DB-mode
   persistence — the exact branch `src/cli/evidence.mjs`'s own `add --write` path takes when a
   DB workspace exists, enforcing the identical lint/leak backstop a second time
   (`assertCleanEvidenceClaims`) before the row is written.
3. On success, the matching gap's `status` flips to `"closed"` via `appSetFields`.

A validation failure surfaces to the candidate as a real error — it is never silently
swallowed or treated as a save.

Skipping a gap sets its `status` to `"dismissed"` via a plain `appSetFields` field patch (no
intent needed for a skip — it changes nothing about evidence or scoring).

---

## STEP 4 — Offer a re-evaluation

Once at least one gap is closed, offer **"See if this changed your fit"** — the existing
`job.evaluate` intent, re-run exactly as `evaluate-job` already does it. This skill never
re-scores anything itself and never promises the score will move; it only offers the same
gate a second time now that new evidence is on record.

---

## Copy rules

Normal-people language, no jargon, no em dashes. Never promise a score will improve. Show the
gap plainly, show the suggestion plainly, and let "See if this changed your fit" do the
asking rather than a prediction.

---

## Honesty rails (hard)

- **Grounded only.** An evidence-claim draft may restate only what is already in the evidence
  bank or the current conversation — never a new fact, metric, tool, or credential.
- **`no-close-path` is not a failure.** It is the honest, correct answer for a gap nothing on
  record closes, and it is always available as a first-class outcome, never hidden behind a
  forced evidence-claim.
- **No bypass of the evidence firewall.** Every write onto `candidate/evidence.yml` /
  `candidate_evidence_claims`, from any entry point, passes through the same
  validate-then-persist path this skill uses.
- **Explicit-click only.** Never auto-fires on a review verdict; the candidate always asks
  first.

---

## Domain-Neutrality Rule

No hardcoded role families, companies, or skills in this skill's behavior. Gaps come entirely
from the tracker row's own `evaluation.fitRisks`; suggestions come entirely from the
candidate's own evidence bank. With no evidence bank, every gap is honestly a
`no-close-path`. See the Domain-Neutral Rule in AGENTS.md.
