# Activity & Action State — one source of truth, one defined shape

This spec defines the split between durable history and live derived actions in the CareerRat tracker.

## The problem

Today the dashboard conflates two different things into one frozen record:

1. **History** — "what happened" (applied, replied, drafted, sent, interview booked).
2. **Actionability** — "what needs you now" (a live CTA like *Review & send*).

Both live as immutable lines in `workspace/activity.jsonl`, where each event can
carry `needsUser:true` + a `cta`. There is **no resolve/dismiss verb** anywhere
(`src/cli/activity.mjs` exposes only list/read/append/prune/backfill). So once a
`drafted` event is written with a *Review & send* button, that button renders
forever — appending a later `Sent` event does not cancel it.

Second failure, same root cause: **silent data loss.** `appendActivity` triggers
`autoPrune` once the file passes a high-water mark; `pruneActivity` atomically
rewrites the file to the newest N and drops the rest. The file is gitignored and
skill-written events (drafted/tailored/sourced) have no `tracker.json` anchor, so
`backfill` can't rebuild them and git can't recover them. That is the "lost a ton
of activity."

Root cause: **actionability and history are the same frozen record**, so clearing
state in `tracker.json` has no effect on what the feed shows.

## The shape

Split along one boundary: *did something happen* (log) vs *is something waiting* (action).

### Log event — durable, append-only history (`workspace/activity.jsonl`)

Written once, never updated. A past-tense fact.

```jsonc
{ "id":"evt_…",            // FNV-1a content hash (dedupe/idempotent backfill)
  "at":"ISO8601",           // immutable
  "type":"applied|message|drafted|interview|assessment|rejected|offer|note|…",
  "actor":"agent|world|user",
  "title":"Sent — Aperture Science",   // required, factual
  "summary":"…",                        // optional
  "refs":{ "applicationId":"…","company":"…","role":"…","url":"…" },
  "tone":"info|success|warning",        // visual only
  "needsUser":false,                    // DEPRECATED as a CTA driver — audit metadata only
  "cta":null }                          // audit metadata only, never rendered as a button
```

The pulse feed is **read-only history**. Rows with `refs.applicationId` get a
`data-detail-id` for drawer navigation, but **no buttons**. `activityCta()` returns
empty unconditionally.

### Derived action item — computed live, never stored

Recomputed every render from `tracker.json` by `cadence.mjs` (extend the existing
`computeFollowUps` / `buildNextSteps` path). Memory-only; lives in the view model.

```jsonc
{ "kind":"needs-reply|drafted|comm-due|waiting-stale|app-nudge|post-interview|thank-you|offer-decision|blocked",
  "id":"<comm.id|app.id>",
  "applicationId":"…", "company":"…", "role":"…",
  "dueAt":"ISO", "overdueDays": 0,
  "reason":"<nextAction or synthesized label>",
  "ctaLabel":"Review & send | Reply | Follow up | Decide",
  "draft":{ "subject":"…","body":"…" },   // from comm.draft / app.followUp.draft when present
  "detailId":"<for openDrawer>", "tone":"error|warning|info" }
```

An action exists **iff** its triggering `tracker.json` state exists. There is no
`done` state — done means the deriving condition is gone, so the item vanishes.

## Single source of truth

- `tracker.json` = authoritative for **current state** (what's pending).
- `activity.jsonl` = authoritative for **history** (what happened).
- One derive function feeds **every** surface: Next Steps card, Focus card, Action
  Queue drawer, Needs-Attention, and the job drawer "Ready to send" panel.

### Send-path invariant (the thing that makes it self-clear)

When the agent sends a message it does **one** `tracker.json` write:
`comm.status = waiting`, **`comm.draft = null`** (and `app.followUp.draft = null`
if that was the source), `lastOutboundAt = now`, append the `outbound-sent`
message. Then one `activity.jsonl` append (`type=message`, history only). Because
the draft field is gone, the Next Steps step, the Ready-to-send panel, and any CTA
all disappear at once. No resolve verb. No stale button possible.

## Durability (fixes the data loss)

- **Raise the cap + env override.** Default retention raised to 2000
  (`CAREERRAT_ACTIVITY_MAX` overrides) so a normal cycle never silently trims —
  `src/core/tracker/activity-log.mjs`.
- **Pre-prune backup.** `pruneActivity` snapshots `activity.jsonl.bak`
  before the destructive rewrite (one-generation recovery; `.bak` is under the
  gitignored `workspace/`).
- **Extend backfill** to re-derive `drafted` events (from
  `comm.status=drafted` + non-null `comm.draft`) and outbound `message` events
  (from `messages[]` with direction `outbound-sent` / `outbound-draft`) — both
  passes implemented in `src/core/tracker/activity-backfill.mjs`, steps 4 and 5
  of `deriveActivityEvents`.
- **tracker.json snapshot-on-checkpoint.** Every `careerrat tracker` call
  snapshots the current `workspace/tracker.json` into
  `workspace/.snapshots/tracker-<ISO>.json` before printing its summary.
  The newest ~20 are kept (override: `CAREERRAT_TRACKER_SNAPSHOTS`); the copy is
  skipped when content is unchanged since the last snapshot. Recovery: copy any
  snapshot back over `tracker.json`. This is the agent-mutated-file analog of
  the `activity.jsonl.bak` — a one-generation rolling safety net for the source
  of truth file that has no atomic write-path. Implemented in
  `src/core/tracker/tracker-snapshot.mjs`, called from `src/cli/tracker.mjs`.
- Do **not** git-track `activity.jsonl` — it's personal runtime data; `.bak` +
  extended backfill is enough.

## Plan (corrected per stress-test)

| # | Effort | Step | Files |
|---|---|---|---|
| 1 | S | AGENTS.md: add sent-clears-draft invariant (Actionability Write-Back Contract); `needsUser` is history-only audit; note backfill now derives outbound events | `AGENTS.md` |
| 2 | S | email-comms STEP 6b: set `comm.draft = null` (and `app.followUp.draft = null`) in the same write that advances status to `waiting` | `.claude/skills/email-comms/SKILL.md` |
| 3 | S | Durability: raise cap → 2000 + `CAREERRAT_ACTIVITY_MAX`, pre-prune `.bak` | `src/core/tracker/activity-log.mjs` |
| 4 | M | Extend `deriveActivityEvents`: drafted-from-comm + outbound-from-messages passes (idempotent ids) | `src/core/tracker/activity-backfill.mjs` |
| 5a | M | Strip live CTAs from the pulse feed: `activityCta()` returns ""; rows get `data-detail-id`; drop `needsUser` tint / `ctaLabel` / `href` | `src/core/tracker/dashboard-data.js` |
| 5b | M | Gate `comm.draft` **and** `app.followUp.draft` in `jobDetailFromRow` on `comm.status` not in {waiting, closed} | `src/core/tracker/dashboard-data.js` |
| 6a | S | **Prereq:** `export` `renderNextSteps`; add an **uncapped** `allNextSteps` view-model field (current `nextSteps` is `.slice(0,3)`) | `src/core/tracker/dashboard-data.js` |
| 6b | M | Superseded by the React app cutover; action surfaces now consume the live view model in `/app` | `apps/web/src/chat-first/*` |
| 7 | S | **Migration — must run AFTER #4:** `careerrat activity backfill --write`; audit live `needsUser` events each map to a `tracker.json` condition; null any `comm.draft` where status is `waiting` | `workspace/*` |

### Implementation notes

1. `renderNextSteps` isn't exported — added as explicit prereq 6a.
2. `nextSteps` is capped at 3 (`.slice(0,3)`) — the drawer must read a new uncapped `allNextSteps`, not `nextSteps`.
3. Migration (#7) must run **after** the backfill extension (#4), not before, or it derives nothing.

## Risks

- Existing `needsUser:true` events lose their visible CTA after 5a. Audit first
  (migration #7): any pending work that lives *only* in the feed must be written
  into `tracker.json` so the derived action reappears.
- Gating `comm.draft` on status surfaces any stale drafts left after a send — a
  one-time cleanup, correct behavior.
- Backfill could near-duplicate a `drafted` event if a skill used a different
  title than the canonical one — define canonical title-per-type in AGENTS.md.
