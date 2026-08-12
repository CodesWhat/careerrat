---
name: sync-status
description: Read application status from ATS dashboards via the session browser, normalize each raw label to the canonical tracker vocabulary, and hand real transitions to track-outcomes — which remains the only writer of workspace/tracker.json. Opt-in, user-initiated, read-only at the portal.
tier_1_inputs: [consent verdict, applications-to-poll list, platform scope]
tier_2_inputs: [per-platform portal page state]
---

# sync-status

> **Runs under AGENTS.md.** These contracts bind without being restated here: Privacy Invariant (`current_base` never outbound), Honesty Firewall, Placeholder/Bracket Ban, Gate Write-back, Domain-Neutral Rule, Browser Automation Contract, Activity Pulse logging, Tracker verify+re-render, and Sent-Clears-Draft. Inline reminders at point-of-use are intentional; standalone restatements point back to the relevant AGENTS.md section.

## STEP 0 — Consent gate (hard stop)

Run:

```
careerrat automation status --json
```

Inspect the `capabilities.status_polling` entry. The applicable platforms are
`greenhouse`, `workday`, `ashby`, and `lever`. For each platform, `allowed: true`
means all three conditions are met: the capability global switch is on, that
platform's per-capability switch is on, and the platform's one-time ToS consent
is recorded. This is the three-part AND from `mayRun()` in
`src/core/automation/consent.mjs` — never hardcode it here.

If **no platform** shows `allowed: true`, explain exactly how to opt in, then
stop — do not open a browser:

1. Read the platform's terms of service yourself.
2. Record consent: `careerrat automation consent <platform> --write`
3. Enable the capability: `careerrat automation enable status_polling --write`
4. Enable for the specific platform: `careerrat automation enable status_polling <platform> --write`
5. Verify: `careerrat automation status --json`

This skill is always user-initiated. Never run it unprompted or on a schedule.

## STEP 1 — Identify applications to poll

Read `workspace/tracker.json` (`applications[]`). Select rows that meet both
criteria:

- The application's host platform maps to one of the `allowed: true` platforms
  from STEP 0. Derive the platform from the `channel` field or the application
  URL — `greenhouse.io` → `greenhouse`, `myworkday` / `wd1` / `wd3` →
  `workday`, `ashby.com` → `ashby`, `lever.co` → `lever`.
- The application is still in-flight: `status` is not `rejected`, `withdrawn`,
  or `offer` (where the offer has already been accepted or closed).

Group the selected rows by platform so you visit each dashboard once. If no
rows qualify, report that and stop.

## STEP 2 — Open each platform dashboard in the session browser

**[DELEGATE: subagent — sequential]** Per-platform polling drives the session browser, so
platforms are read **one at a time** (one-browser rule); delegation isolates each platform's
context rather than parallelizing. Each subagent reads its platform's rows and returns raw
statuses; the orchestrator normalizes (STEP 3) and hands transitions to `track-outcomes`
(the only tracker writer). STEP 0 consent already cleared on the orchestrator. See the
**Delegation Contract** in AGENTS.md.

For each allowed, in-scope platform, navigate to that platform's candidate
portal URL in the session browser. The session browser is Layer 3 per
`docs/BROWSER.md`: prefer the Chrome extension (it already holds the user's
logins), fall back to Playwright with a one-time login pause (a persistent
profile the user signs into once).

Before reading each application row, snapshot or read the current page state —
never rely on hardcoded selectors. Drive the live DOM turn-by-turn.

Read from each visible application row: company name, role title, and the raw
status label as it appears on the dashboard.

If you encounter a login wall, captcha, 2FA prompt, or any unexpected
interstitial at any point, halt immediately and ask the user to complete it.
Do not attempt to bypass or automate around any auth challenge.

Save any screenshot or scraped page body under `workspace/` only. Nothing
leaves the local machine.

## STEP 3 — Normalize each raw status

For each scraped row, run:

```
careerrat status-map "<raw status label>" --current "<row's current tracker status>" --json
```

Read the JSON result. The fields that matter:

| Field | Meaning |
|---|---|
| `autoApplicable: true` | High-confidence advance or definitive terminal outcome — eligible to hand off |
| `direction: "regress"` | Status appears to go backward — surface for user confirmation, do not auto-apply |
| `confidence: "low"` | Unrecognized label defaulted to `awaiting` — surface for user confirmation |
| `changed: false` | Same canonical status as the current tracker row — nothing to do |

The CLI is the source of truth for normalization. Do not hand-map raw labels by
eye.

## STEP 4 — Hand transitions to track-outcomes

For each row where `autoApplicable: true`:

Hand off to `track-outcomes` with the company name, role title, and the new
canonical status from the normalization result. `track-outcomes` executes the
tracker write, appends learning entries, and checks reevaluation thresholds.
Batch all handoffs before exiting this skill; do not call `track-outcomes` one
row at a time if several transitions are ready.

When the normalization result includes a non-null `round` field, pass it to
`track-outcomes` as the `conversations[].kind` for the new conversation entry.
The `round` value is already the canonical Round Vocabulary kind from AGENTS.md
(e.g. a portal label "Welcome to your virtual onsite" → `onsite`, not a numbered
or generic interview). Never invent or re-derive a round kind from the raw label
by eye — the normalizer in `status-map.mjs` (`ATS_ROUND_RULES`) is the SSOT and
already mirrors the AGENTS.md Round Vocabulary.

**Comm-field write-back (same write as the status advance):** For each row
being handed to `track-outcomes`, also read its matching `communications[]`
record. If the portal-detected advance makes any open comm CTA moot (e.g. the
recruiter thread was waiting on a portal decision that is now confirmed), instruct
`track-outcomes` to include these field updates in the **same** `tracker.json`
write that records the status transition:

- `comm.nextActionDue = null`
- `comm.nextAction` — rewrite to reflect the new state, or clear if no
  follow-up is needed
- `comm.draft = null` if a draft was backing the superseded CTA
- `followUp.due = null` if a follow-up chase is no longer appropriate given the advance
- Append a `note`-type entry to `comm.messages[]` (or `conversations[]`)
  recording that the status advance was observed via portal poll

A partial write that advances `app.status` but leaves a stale comm CTA
violates the single-write rule from AGENTS.md ("Completed-action clears its
CTA (hard)").

`track-outcomes` is the **only** writer of `workspace/tracker.json`. This skill
never writes the tracker itself. It also does not log to the Activity Pulse — `track-outcomes` records the transitions it receives (see **Activity Pulse** in AGENTS.md).

For rows where `autoApplicable` is false (low confidence, regress, or
unchanged): collect them in a confirmation list for STEP 5. Do not hand them
to `track-outcomes` without an explicit user yes.

## STEP 5 — Report

Print a summary in this format:

```
sync-status complete:
  Platforms polled:         N  (<list of platform names>)
  Application rows checked: M
  Transitions applied:      A  (handed to track-outcomes)
  Awaiting confirmation:    C  (listed below)
  Platforms skipped:        S  (<reason: no consent / not allowed>)
```

For each item awaiting confirmation, list: company, role, current status →
scraped label → normalized canonical, and the reason it was not auto-applied
(low confidence / regress / no change). Ask the user which, if any, to apply.
For each confirmed by the user, hand off to `track-outcomes` now — and apply
the same comm-field write-back as STEP 4: in the **same** write that records
the confirmed status transition, set `comm.nextActionDue = null`,
rewrite or clear `comm.nextAction`, null `comm.draft` and `followUp.due` if
a draft or chase was backing the now-resolved CTA, and append a `note` entry
to `comm.messages[]` recording the user-confirmed portal advance. Do not leave
the comm thread open after a portal-confirmed transition.

---

## RULES

- This skill is **read-only at the portal** and **never writes `workspace/tracker.json`**. `track-outcomes` is the only writer of the tracker. Never fabricate a tracker mutation here.
- Opt-in and OFF by default. Only poll platforms where `careerrat automation status --json` shows `status_polling` `allowed: true` for that platform. The `allowed` field encodes the three-part AND (global switch, platform switch, ToS consent) from `mayRun()` — never re-derive the predicate in prose.
- Never run on a schedule or unattended. Always user-initiated with the agent in the loop.
- Halt and ask on captcha, 2FA, login wall, or any unexpected interstitial. Never attempt to bypass an auth challenge.
- Use tool-agnostic browser prose: "the session browser," "snapshot or read the page." Prefer the Chrome extension (holds existing logins); fall back to Playwright with a one-time login pause. Never name an MCP namespace or vendor tool.
- Status normalization is deterministic via `careerrat status-map`. Do not hand-map raw portal labels by eye.
- Local-only. Scraped bodies and screenshots stay under `workspace/`. Nothing goes outbound.
- Domain-neutral. No hardcoded companies, roles, or candidate-specific values. No bracketed placeholder tokens anywhere — if a detail is unknown, omit it or go generic; never emit `[Company]`, `[Role]`, or any bracket.
- Auto-apply only `autoApplicable: true` results. Surface `direction: "regress"`, `confidence: "low"`, and `changed: false` rows for human confirmation before handing anything to `track-outcomes`.
