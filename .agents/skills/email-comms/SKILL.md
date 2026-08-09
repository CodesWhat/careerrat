---
name: email-comms
description: Draft, reply to, follow up on, summarize, and track job-search email and recruiter-message threads — including thank-yous, scheduling, negotiation, and cold outreach — while persisting full thread context in the CareerRat tracker.
---

# email-comms

> **Runs under AGENTS.md.** These contracts bind without being restated here: Privacy Invariant (`current_base` never outbound), Honesty Firewall, Placeholder/Bracket Ban, Gate Write-back, Domain-Neutral Rule, Browser Automation Contract, Activity Pulse logging, Tracker verify+re-render, and Sent-Clears-Draft. Inline reminders at point-of-use are intentional; standalone restatements point back to the relevant AGENTS.md section.

> **Agent voice.** Read `candidate/modes.yml#agent_voice` (default `standard`) before producing in-chat commentary around drafts. Apply the register from AGENTS.md#mode-switches. The **drafted artifact itself** (email subject + body) is always written in full regardless of register — `writing-style.md` governs its tone. Register governs the **agent commentary**: `exec-summary` = draft only + one action line; `standard` = draft + short bullets on intent/next-step; `technical` = draft + thread-context summary + strategy note; `verbose` = draft + full thread reconstruction + alternatives.

## Inputs

- `workspace/tracker.json` — communications[] and applications[] arrays
- `workspace/comms/<thread-id>.md` — full raw thread body if previously saved
- `candidate/profile.yml` — compensation fields, location, domain
- `candidate/targeting.yml` — excluded_companies, cut/keep signals
- `candidate/honesty.yml` — claims.do_not_fabricate, confirmed tools/claims
- `candidate/evidence.yml` — factual sourcing for all claims
- `candidate/writing-style.md` — voice and register calibration
- `workspace/writing-samples/` — raw samples for style calibration
- the latest inbound message text OR the user's stated outbound intent

## Outputs

- complete, finished email or message artifact (subject + body, no placeholders)
- updated `workspace/tracker.json` — communications[].messages[] append + status fields
- optional `workspace/comms/<thread-id>.md` for long raw thread bodies
- `~/Downloads/rolester/email-<company-slug>-<yyyy-mm-dd>.txt` — convenience copy of the draft (`workspace/` stays source of truth)
- re-rendered tracker dashboard

---

## Entry point: Drafting from the Needs Attention surface

When the user pastes or types a prompt of the form:

> Draft the follow-up email for {Company} — {Role}

this is the one-click Draft button on the dashboard's Needs Attention panel. It copies exactly that text to the clipboard and the user pastes it here.

Treat this as an `outbound-follow-up` (or `thank-you` if the notification kind is `thank-you`). Start at STEP 1 to match the communications or application record for `{Company}` + `{Role}` in `workspace/tracker.json`. Then run the full flow (STEP 2 → 5 → 6 → STEP 8) to:

1. Draft the due follow-up (STEP 5 — complete, no placeholders).
2. Capture the outbound draft message (STEP 6a/b).
3. Advance the record status and reset `nextActionDue` (STEP 6b / STEP 8 timer reset).
4. Persist the baked draft onto the record (STEP 8 — `comm.draft` or `app.followUp.draft`) so the notification bell can show it ready to send.
5. Validate and re-render — the mode branch from STEP 6(d)/(e) and STEP 8 items 6–7 (DB workspace: `rolester data verify` + `rolester tracker --verify`; legacy: `rolester tracker --verify` then `rolester tracker`) — this clears the timer from the Needs Attention panel for that item.

---

## Out-of-band completion (entry-point branch)

**Mode detection:** run `rolester data status`. Exit 0 → DB workspace — every
write step below gives the `rolester data <verb>` command (Data Write Contract,
AGENTS.md). Nonzero exit → legacy workspace (no DB yet) — every write step below
gives the existing direct JSON-edit instructions, unchanged.

When the user says they already sent a message, already replied, or already completed the action manually (e.g. "I already sent this", "I replied earlier today", "I did this on my phone"):

1. **Confirm** which thread and action the user means (one clarifying question if ambiguous).
2. Record the completion:
   - Append an `outbound-sent` (or `note` if no artifact exists) entry to `communications[].messages[]` with `direction: "outbound-sent"`, current timestamp, and a one-sentence summary of what was sent.
   - Set `status → waiting` (or `closed` if this was a terminal action such as a rejection response or withdrawal).
   - Set `nextActionDue = null` — the CTA is satisfied.
   - Set `nextAction` to the next expected event (e.g. "Await recruiter reply"), or `null` if none.
   - Set `comm.draft = null` (and `app.followUp.draft = null` if a draft was staged) — the draft is no longer pending.
   - **DB workspace:** compose two calls, back-to-back:
     1. `rolester data comm append-message <comm-id> --data '{"direction":"outbound-sent","at":"<ISO>","summary":"<what was sent>"}'`
     2. If `status` is advancing to `waiting` (the common case): `rolester data comm mark-sent <comm-id> --at <iso>` — sets `status: waiting`, clears `comm.draft` (and `app.followUp.draft` when linked), automatically. Otherwise (e.g. `closed`), or to set `nextAction`/`nextActionDue`: read the current row and persist the patched whole row with `rolester data comm upsert --data '<patched full comm row JSON>'`.
   - **Legacy workspace (no DB):** write to `tracker.json` in one operation — no partial writes.
3. **Validate:**
   - **DB workspace:** `rolester data verify` (re-exports + domain integrity), then `rolester tracker --verify` (schema-level parity).
   - **Legacy workspace (no DB):** run `rolester tracker --verify`, confirm clean exit, then **re-render** (`rolester tracker`).

The agent not having performed the action is not a reason to leave the CTA up. Record it immediately and clear state.

---

## STEP 0 — Classify message intent

Identify which type of communication this is. The type controls which sub-steps run:

| Type | Sub-steps triggered |
|---|---|
| `inbound-recruiter-reply` | 2, 3, 4, 5, 6, 7 |
| `outbound-reply` | 2, 3, 4, 5, 6, 7 |
| `outbound-follow-up` | 2, 3, 4, 5, 6, 8 |
| `thank-you` | 2, 3, 4, 5, 6 |
| `scheduling-confirm` | 2, 3, 4, 5, 6, 7 — but a true scheduling thread (proposing/confirming/moving a call) routes to `schedule-meeting`, which owns timezone, double-booking, and calendar holds. Keep this type only for a one-line confirmation inside a broader comms reply. |
| `negotiation-comp` | 2, 3, 4-COMP, 4b, 5, 6, 7 |
| `cold-outreach` | 3, 4, 5, 6 |
| `note` | 1, 6 |

If the type is ambiguous, ask one clarifying question before proceeding.

---

## STEP 1 — Match to tracker thread

**Mode detection** (same check as the entry-point branches above): run `rolester
data status`. Exit 0 → DB workspace — every write step below gives the
`rolester data <verb>` command (Data Write Contract, AGENTS.md). Nonzero exit →
legacy workspace (no DB yet) — every write step below gives the existing direct
JSON-edit instructions, unchanged.

Read `workspace/tracker.json`. Find the `communications[]` record whose:
- `applicationId` matches a known application, OR
- `company` + `role` match, OR
- `threadId` or `subject` matches the inbound message.

If no match and this is a real communication (not a test note):

Create a new communications record with at minimum:
```json
{
  "id": "comm-<applicationId or slug>",
  "applicationId": "<id or null>",
  "company": "...",
  "role": "...",
  "channel": "email|linkedin|portal|phone|sms|other",
  "status": "needs-reply",
  "summary": "<one line>"
}
```

- **DB workspace:** `rolester data comm upsert --data '<the record JSON above>'` (full-row insert).
- **Legacy workspace (no DB):** write the updated `workspace/tracker.json` immediately.

Do not proceed with a draft until the record exists.

---

## STEP 2 — Load context

Read each of the following before drafting:

1. `workspace/comms/<thread-id>.md` — full thread body and prior exchanges, if the file exists.
2. The linked `applications[]` row in `workspace/tracker.json` — JD context, current status, artifacts.
3. `candidate/evidence.yml` — factual claims available to use.
4. `candidate/honesty.yml` — boundaries on what may and may not be claimed (`claims.do_not_fabricate`, `tools.do_not_claim`).

If the thread is for a role but no `applicationId` is linked, ask the user to confirm the role before drafting.

---

## STEP 3 — Style gate

Read `candidate/writing-style.md`.

Then check `workspace/writing-samples/` for any files modified AFTER `writing-style.md` was last written (compare file mtimes; treat absent mtimes as newer).

- If `writing-style.md` is absent OR newer samples exist: run `npm run calibrate:style`, wait for it to finish, then read the updated `candidate/writing-style.md` before drafting.
- If `writing-style.md` is current: proceed.

---

## STEP 4 — Comp gate (negotiation-comp messages ONLY)

Read candidate profile config through the shared DB-first accessor and extract:

| Field | Use |
|---|---|
| `compensation.target_base` | Primary outbound anchor (state this) |
| `compensation.minimum_base` | Walk-away floor (do not reveal unless pressed) |
| `compensation.expected_base` | Form-field value if a portal comp form is involved (foundations-spec §2 / §5; canonical read path: `form-defaults.yml#expected_base` first, then `profile.compensation.expected_base` as fallback) |
| `compensation.cash_over_equity` | Flag equity vs. cash preference if asked |
| `compensation.current_comp_shareable` | Gate: if false (the default), `current_base` is PRIVATE |

**Privacy invariant:** `current_base` must NEVER appear in any outbound draft. If `current_comp_shareable` is not explicitly `true`, treat `current_base` as if it does not exist. State `target_base` as the anchor; use `minimum_base` only as an internal walk-away reference, not as an outbound number unless the user explicitly instructs otherwise.

For OE-bucket roles: read `profile.compensation.oe_min_base` / `profile.compensation.oe_max_base` (foundations-spec §2; both confirmed in `profile.schema.json`) and apply them instead of the standard floor/anchor. The standard `minimum_base` / `target_base` do NOT apply for OE roles.

If the user states a new comp boundary mid-flow (e.g., "I won't go below $210K on this one") — confirm-first, then run `rolester gate comp-floor <N> --write --confirm`. Echo the CLI confirmation.

---

## STEP 4b — Written-negotiation depth (negotiation-comp messages ONLY)

Run this step immediately after STEP 4. It applies the three depth capabilities from the **Negotiation Contract** in AGENTS.md — read that section first for strategy; this step is written-channel mechanics only.

### 4b-1 Geographic-discount pushback

If the inbound message cites the candidate's location or remote status to justify a lower offer:

1. Read the most recent `workspace/research/comp-bench-<role>-<loc>-<yyyy-mm>.md` artifact. Extract `benchmark.floor`, `benchmark.midpoint`, and `benchmark.ceiling` from frontmatter.
   - If no benchmark artifact exists, do NOT cite a market number. Reframe on value only (see 4b-3). State in the draft that the ask reflects role scope, not a local rate.
   - If the artifact is stale (> 6 months), surface a warning to the user before drafting: `Benchmark artifact may be stale — run research-comp to refresh before sending.`
2. Anchor the rebuttal on the **role market band**, not a locale-discounted figure. Use `benchmark.midpoint` as the default reference. Use `benchmark.floor` only when the offer is already above the midpoint and the gap is narrow; use `benchmark.ceiling` only when the role scope or seniority matches the top of the benchmarked band and the artifact explicitly supports it.
3. Include a remote-comp-parity statement: distributed roles compete for talent nationally (or globally); the candidate's geography does not reduce role scope or output.
4. Support with at least one evidence claim from `candidate/evidence.yml`. Do not fabricate impact metrics.
5. Never cite `current_base`. Never cite the discounted-locale figure the employer used — rebut it structurally, not numerically.

| Signal in inbound | Written-rebuttal framing |
|---|---|
| "Our remote employees are at a location-adjusted rate" | Cite role market band from benchmark; name the midpoint; assert output-not-location pricing |
| "Your area has a lower cost of living" | Redirect to role scope and national talent pool; use benchmark midpoint as anchor |
| No benchmark artifact exists | Value + role-scope reframe only; no market number |

### 4b-2 Competing-offer / BATNA framing

Read `candidate/honesty.yml` (`claims.do_not_fabricate`) before this sub-step. The honesty firewall applies in full.

**If the candidate has a real competing offer or genuine alternative:**

1. Name the offer type generically ("another offer at the senior level", not the competing company unless the candidate explicitly instructs disclosure).
2. State the walk-away clearly — `profile.compensation.minimum_base` (or `oe_min_base` for OE roles) is the internal floor; never quote it outbound unless the user explicitly instructs otherwise. Frame it as the candidate's genuine decision timeline.
3. Frame timeline honestly: state only a deadline that is real. Do not invent urgency. Ask the candidate to confirm the exact date before drafting any sentence that references a deadline.
4. Use the competing offer as leverage to invite a stronger response, not as a threat. Tone: collegial, not adversarial.

**If the candidate has NO competing offer or BATNA:**

Do not fabricate one. Say so plainly to the user before drafting: `No competing offer or deadline found — coaching to honest alternatives only.`

Coach and draft using only:
- Market anchor from the benchmark artifact (4b-1), if one exists.
- Unique value from `candidate/evidence.yml` — measurable impact, rare skills, or domain depth.
- Time: a genuine response window the candidate controls. Ask the candidate for a specific day and write that real day into the sentence — e.g. "I'd like to give this proper consideration — could we reconnect on Tuesday?" Never emit a bracket placeholder for the date; use the day the candidate actually gives.

Absolute rule (restated from AGENTS.md Negotiation Contract): never fabricate a competing offer, a deadline, a number, or leverage that does not exist.

### 4b-3 Multi-round sequencing and concession ladder

For ongoing negotiation threads (round ≥ 2), read the full `communications[].messages[]` history for this thread before drafting. Identify the current round.

**Round map:**

| Round | Anchor | Tone | Concession posture |
|---|---|---|---|
| Opening | `profile.compensation.target_base` (or `oe_max_base` for OE roles) | Confident, evidence-backed | None — hold the full ask |
| Counter | Employer's counter vs. `target_base` delta | Collaborative, value-forward | Offer one tradeable item if needed (see ladder below) |
| Re-counter | Close the remaining gap | Decisive | One final concession, or hold and name a close condition |
| Close | At or above `minimum_base` / `oe_min_base` | Warm, forward-looking | Accept, decline, or ask for 24 h to decide |

**Concession ladder** — tradeables ranked by `profile.compensation.cash_over_equity`:

| Item | Trade when | Do NOT trade |
|---|---|---|
| Sign-on bonus | Base is hard-capped; bonus bridges the gap | When base is already below `minimum_base` / `oe_min_base` |
| Equity / vesting terms | `cash_over_equity` is `false` and the role includes equity compensation | When `cash_over_equity` is `true` |
| Start date | Candidate has flexibility; small goodwill signal | As a substitute for comp |
| Title / level | Materially affects future negotiating power or career path | To paper over a comp gap |
| Remote / relocation terms | Candidate is indifferent to location | When location is a hard constraint |
| Base salary | Only as a last move, and only to `minimum_base` / `oe_min_base` — never below | Never below the walk-away floor |

When `cash_over_equity` is `true`, do not offer equity concessions before exhausting sign-on and start-date options.

**Deadline discipline:**
- If the employer sets a deadline, acknowledge it and respond within it, or ask for a short extension (24–48 h) once.
- If no deadline is set, the candidate controls timing. Do not volunteer one.
- When to hold: round 1 (opening) and any round where the gap to `target_base` is > 10% — conceding early signals the floor is lower than it is.
- When to close: the offer clears `minimum_base` / `oe_min_base` and any one of (a) the employer states this is final, (b) further rounds risk goodwill, or (c) the candidate's own deadline is real and near.

**Persistence:** every round's outbound draft is a `negotiation-comp` message appended to `communications[].messages[]` via STEP 6. The full round history accumulates in the thread so context is never lost between sessions.

**Gate write-back:** if a new comp boundary emerges mid-negotiation (e.g., the candidate says "I won't go below $210K on this one"), apply the STEP 4 write-back rule — confirm-first, then run `rolester gate comp-floor <N> --write --confirm` for the per-offer walk-away. `profile.compensation.minimum_base` is the single source of truth for the comp floor — there is no separate `targeting.comp_floor` field.

---

## STEP 5 — Draft

Write a complete, finished artifact: subject line + body. No placeholders. The artifact must be ready to send as written.

**Real names, never placeholders — go generic when unknown.** Always sign with the candidate's real name (`candidate/profile.yml#candidate.preferred_name`, falling back to `full_name`) and a real signature block — the candidate is always known, so the signature is never generic. Address the recipient by their real name and pull company/role/contact from the linked `tracker.json` record. If a detail is genuinely unknown, write it generically — NEVER emit a bracketed token like `[Name]`, `[Recruiter]`, or `[Company]`, and never block or ask the user to fill one. An unknown recipient name → a natural greeting (`Hi,` / `Hello,`; use `Hi {team} team` only if the team is actually known). An unknown company/role → rephrase the sentence so it reads naturally without it. Brackets in the output are a build failure, not a TODO.

Apply writing-style.md register and patterns throughout. Match the tone and formality of the inbound thread.

Per-type requirements:

- **thank-you:** Reference one specific moment from the interview or conversation for genuine personalization. Read `workspace/tracker.json#applications[].conversations[]` for notes.
- **scheduling-confirm:** State candidate availability from `profile.yml#location` / `travel_tolerance`. Confirm the channel (email vs. portal vs. video link). Do not confirm logistics that haven't been stated.
- **negotiation-comp:** State `target_base` as the anchor. Do NOT mention `current_base`. Support the anchor with value framing from `evidence.yml`. Apply the full STEP 4b written-negotiation depth: geographic-discount rebuttal (4b-1), competing-offer/BATNA framing (4b-2), and concession-ladder round sequencing (4b-3). See AGENTS.md Negotiation Contract for strategy; STEP 4b for written-channel mechanics.
- **cold-outreach:** No fabricated mutual connections, referrals, or recruiter commitments. Claims sourced from `evidence.yml` only.
- **follow-up:** Mirror prior thread tone. Do not re-litigate prior exchanges; advance to next action.
- **note:** Factual summary only, no outbound artifact.

Run `node src/cli/lint-placeholders.mjs <draft-path>` if the draft is saved to a file before presenting it to the user.

---

## STEP 6 — Capture

Execute the following mutation sequence in order:

**(a) Append the new message to `communications[].messages[]`** in `workspace/tracker.json`:

```json
{
  "id": "msg-<commId>-<n>",
  "direction": "inbound|outbound-sent|outbound-draft|note",
  "at": "<ISO 8601 datetime>",
  "from": "<sender>",
  "to": ["<recipient>"],
  "subject": "<subject line>",
  "summary": "<concise gist — one sentence>",
  "artifactPath": "<workspace/comms/... if saved>"
}
```

- **DB workspace:** `rolester data comm append-message <comm-id> --data '<the message JSON above>'`. This appends to `messages[]` and auto-rolls `lastInboundAt`/`lastOutboundAt` forward from `direction` — the first half of (b) below. Include a `summary` or `nextAction` key in the payload if you also want those set on the parent record in this same call (the verb applies them when present).
- **Legacy workspace (no DB):** append to `communications[].messages[]` directly in `workspace/tracker.json`.

**(b) Update the parent communications record** with:
- `status`: `needs-reply | drafted | waiting | scheduled | closed | blocked`
- `nextAction`: what to do next
- `nextActionDue`: ISO date
- `lastInboundAt` or `lastOutboundAt`: ISO datetime of this message

  **Sent-clears-draft (hard — same write, no exceptions).** When the message was SENT and
  status advances to `waiting` (or otherwise past `drafted`), also set `comm.draft = null`
  on the communications record in this same write. If the draft came from
  `app.followUp.draft`, set `app.followUp.draft = null` (or remove `app.followUp`). This
  is the sent-clears-draft invariant from AGENTS.md "Actionability Write-Back Contract".
  Leaving a draft set after a send creates a ghost "Ready to send" panel that never resolves.

  - **DB workspace:** compose the call(s) matching what actually changed, back-to-back with (a) above (no combined messages+status transaction exists):
    - **Message was SENT and status is advancing to `waiting`** (the common send-clears-draft case): `rolester data comm mark-sent <comm-id> [--at <iso>] [--summary "<t>"]` — sets `status: waiting`, clears `comm.draft` (and `app.followUp.draft` when that application exists), and stamps `lastOutboundAt`, all in one transaction, automatically. Do not hand-write that clear.
    - **Any other status value** (`needs-reply`, `drafted`, `scheduled`, `closed`, `blocked`) or to set `nextAction`/`nextActionDue` explicitly: there is no single-field patch verb for `communications[]`, so read the current row from `workspace/tracker.json#communications[]`, apply the fields above (carrying every other field over unchanged), and persist the whole row: `rolester data comm upsert --data '<patched full comm row JSON>'`.
  - **Legacy workspace (no DB):** edit the fields above directly on the communications record in `workspace/tracker.json`, in the same write as (a).

**(c) Save long raw body** to `workspace/comms/<thread-id>.md` if the body exceeds one paragraph. Reference the path in `artifactPath`. `workspace/comms/` files are local-only and must not appear in any outbound artifact. (This is a local file write outside `tracker.json` — unaffected by DB vs legacy mode.)

**(d) Validate:**
- **DB workspace:** the calls in (a)/(b) already persisted and auto-exported `workspace/tracker.json` + `workspace/activity.jsonl` (Data Write Contract, AGENTS.md). Run `rolester data verify` (re-exports + domain integrity) and `rolester tracker --verify` (schema-level parity).
- **Legacy workspace (no DB):** run `rolester tracker --verify`.

Confirm it exits clean before proceeding. If it fails, fix the JSON (legacy) or the DB row via another verb call (DB — never hand-edit `tracker.json`, it is a regenerated file) and re-run.

**(e) Re-render:**
- **DB workspace:** already exported by the calls above; if `rolester tracker-dev` is running its `fs.watch` already picked it up. For a static snapshot, or to confirm by hand, still run `rolester tracker`.
- **Legacy workspace (no DB):** run `rolester tracker`.

Then log it to the Activity Pulse feed (the dashboard's live timeline — see **Activity Pulse** in AGENTS.md). If the message is a draft awaiting the user to send, log it as needing the user; if it was already sent, log it sent:

- **DB workspace:** the (a)/(b) calls above already auto-logged their own generic events (`message` type) in their own transactions. For the richer, outcome-specific type below, log an additional event (this verb only logs, it never bumps the stamp):
  ```
  # draft awaiting send:
  rolester data activity append --data '{"type":"drafted","actor":"agent","needsUser":true,"title":"Drafted reply — <Company>","summary":"<one line: what the message does>","refs":{"applicationId":"<application id>","company":"<Company>"},"cta":{"label":"Review & send"}}'

  # already sent:
  rolester data activity append --data '{"type":"message","actor":"agent","title":"Sent — <Company>","summary":"<one line: what the message does>","refs":{"applicationId":"<application id>","company":"<Company>"}}'
  ```
- **Legacy workspace (no DB):**
  ```
  # draft awaiting send:
  rolester activity append --type drafted --actor agent --needs-user \
    --title "Drafted reply — <Company>" --summary "<one line: what the message does>" \
    --company "<Company>" --app-id <application id> --cta-label "Review & send" --write

  # already sent:
  rolester activity append --type message --actor agent \
    --title "Sent — <Company>" --summary "<one line: what the message does>" \
    --company "<Company>" --app-id <application id> --write
  ```

---

## STEP 7 — Outcome routing

Branch on message type after capture:

| Condition | Action | DB-mode command |
|---|---|---|
| Scheduling confirmed / interview booked | In the SAME `tracker.json` write: update `applications[].status` to the appropriate stage (phone-screen, onsite, etc.) AND update the communications record — `status → scheduled`, `nextActionDue = null`, `nextAction = 'Attend <stage> — <date>'` (or clear it if no further prep action is needed), `comm.draft = null` if a draft was staged. Both records must land in one write so neither leaves a ghost CTA. Hand off to `interview-prep` for prep materials. | `rolester data app set-status <id> "<stage>"` for the application row, then patch the comm record (read current row, apply the fields, persist): `rolester data comm upsert --data '<patched full comm row JSON>'`. Run both back-to-back, never deferring the second. |
| Offer received | Before surfacing the comp comparison, write to `tracker.json` in one operation: comm `status → waiting`, `nextActionDue = null`, `nextAction = 'Evaluate offer and respond'` (set a real deadline if the employer gave one, else null), `comm.draft = null` if a draft was staged. Append a `note`-direction message to `messages[]` summarising the offer receipt. Then read the candidate config through the shared DB-first accessor (`profile.compensation.minimum_base` and `target_base`), surface whether the stated comp clears the floor, and recommend accept/negotiate/decline. Do not accept on the user's behalf. | Patch the comm record locally (status/nextActionDue/nextAction/draft), persist: `rolester data comm upsert --data '<patched full comm row JSON>'`; then append the note: `rolester data comm append-message <comm-id> --data '{"direction":"note","at":"<ISO>","body":"<offer receipt summary>"}'`. Comp comparison itself is a candidate-config read: SQLite in DB mode, YAML only in legacy mode. |
| Rejection or withdrawal | In the SAME `tracker.json` write as the STEP 6 capture: set `status = closed`, `nextActionDue = null`, `nextAction = null`, `comm.draft = null` (if any draft was staged). Do not rely on STEP 6's generic status field alone — state it explicitly here. Then hand off to `track-outcomes` for durable outcome recording and reevaluation-threshold check. | Same composition as STEP 6(b)'s DB branch — read-patch-persist `rolester data comm upsert --data '<patched full comm row JSON>'` with `status: "closed"`, `nextActionDue: null`, `nextAction: null`, `draft: null`. `track-outcomes` owns the durable app-row transition (its own DB verbs) — this call only closes the comm thread. |
| Ghosting / no response after follow-up | In the SAME `tracker.json` write: set `status = closed` (or `blocked` if appropriate), `nextActionDue = null`, `nextAction = null`, `comm.draft = null` if a draft was staged. The due-date CTA must clear together with the status in one write. Hand off to `track-outcomes`. | Same read-patch-persist pattern: `rolester data comm upsert --data '<patched full comm row JSON>'` with the fields above. |
| User states new exclusion mid-thread (e.g., "never email this company again") | Confirm-first, then run `rolester gate exclude-company "<Company>" --write --confirm`. Echo the CLI result. Run `rolester doctor` to verify after write. | `rolester gate` is DB-aware: it writes SQLite in DB mode and legacy YAML only in legacy mode. Never hand-edit `candidate/targeting.yml`. |
| User states new comp floor mid-thread | See STEP 4 comp write-back rule; use `rolester gate comp-floor <N> --write --confirm`. | `rolester gate` is DB-aware: it writes SQLite in DB mode and legacy YAML only in legacy mode. Never hand-edit `candidate/profile.yml`. |

---

## STEP 8 — Follow-up timer management

After every `outbound-sent` or `outbound-draft` capture, set `nextActionDue`:
- Waiting for recruiter reply: 5–7 business days from send date.
- Awaiting scheduling follow-up: 2 business days before the event deadline (or 3 days if no deadline given).
- Thank-you: no follow-up needed unless the user requests one. After the thank-you is captured via STEP 6, set `nextActionDue = null` on the comm record in that same write — the thank-you satisfies the due event. Do NOT set a new follow-up timer unless the user explicitly asks for one.

**Stale threshold:** A `waiting` thread with no update for **7 days** is stale and surfaces as a follow-up. Applied-with-no-response threads surface after **10 days**. These defaults come from `cadence.mjs` — if the candidate's `follow_up:` config block in `candidate/targeting.yml` provides custom thresholds for a kind, those take precedence over the code defaults.

When the user asks to work follow-ups (or `rolester tracker --followups` surfaces them):

1. Read the stale thread via STEP 2.
2. Apply STEP 3 style gate.
3. Draft the follow-up (STEP 5).
4. Capture (STEP 6): append outbound message, advance `status` from `waiting` to appropriate state, reset `nextActionDue`.
5. **Persist a baked draft** for the dashboard notification panel. After drafting, write `draft: { subject, body }` onto the relevant record in `workspace/tracker.json`:
   - For comm-based kinds (`needs-reply`, `comm-due`, `waiting-stale`): set `comm.draft = { subject, body }` on the communications record.
   - For application-based kinds (`app-nudge`, `post-interview-nudge`, `thank-you`): set `app.followUp = { kind, dueAt, draft: { subject, body }, generatedAt }` on the application record.
   The dashboard notification bell reads these fields directly; a baked draft appears as "ready to send." A baked draft is only valid for the DRAFT/awaiting-send state; once the message is sent, it must be nulled per the sent-clears-draft invariant (STEP 6b) so the "Ready to send" panel clears.
   - **DB workspace:** comm-based kinds — there is no single-field patch verb for `communications[]`, so read the current row, set `draft`, and persist: `rolester data comm upsert --data '<patched full comm row JSON>'`. Application-based kinds — `app.followUp` merges one level under `app set-fields`: `rolester data app set-fields <id> --data '{"followUp":{"kind":"<kind>","dueAt":"<iso>","draft":{"subject":"<s>","body":"<b>"},"generatedAt":"<iso>"}}'`. Neither is outcome-changing.
   - **Legacy workspace (no DB):** edit `workspace/tracker.json` directly.
   **Also write a convenience copy** to the company's Downloads folder — `~/Downloads/rolester/<Company>/<Company> - <what> Email.txt` (e.g. `Aperture Science - Follow-up Email.txt`), per the Artifact Contract (organized by company, then by round). Use the real company name for the folder and file (never a bracket placeholder; if the company is somehow unknown, use `unknown`). File content: subject line on the first line, a blank line, then the body. `workspace/` stays the source of truth; Downloads is for the user's convenience. Body must NEVER contain `current_base` or any private comp field (per the Privacy Invariant). (This Downloads copy is a local file write outside `tracker.json` — unaffected by DB vs legacy mode.)
6. Validate:
   - **DB workspace:** the calls above already persisted and auto-exported. Run `rolester data verify` and `rolester tracker --verify`.
   - **Legacy workspace (no DB):** `rolester tracker --verify` (also: `npm run verify:tracker`). Confirm clean exit before proceeding.
7. Re-render:
   - **DB workspace:** already exported; run `rolester tracker` to confirm or refresh a static snapshot.
   - **Legacy workspace (no DB):** `rolester tracker` (so the timer clears from the dashboard).

---

## STEP 8a — Prepare follow-up drafts

When surfacing currently-due follow-ups (the same set `computeFollowUps` returns), proactively generate a baked draft for each due item so the bell panel shows them ready to send — not just as bare reminders.

For each item returned by `computeFollowUps`:

1. **Check the candidate `follow_up:` config** in `candidate/targeting.yml`. Do NOT generate a draft for any kind that is `enabled: false` — those reminders are suppressed entirely. Use the configured `after_days` / `after_hours` thresholds (mapped via `rulesFromConfig` in `src/core/tracker/cadence.mjs`) rather than hardcoded defaults.
2. **Draft per kind** (apply STEP 5 requirements — complete, no placeholders, honest):
   - `app-nudge`: short, professional follow-up on the outstanding application; reference the role name and applied date. **Contact-path precondition (hard):** an app-nudge only makes sense when there's an actual person to nudge — a linked recruiter/email thread (`communications[]` for the row), a logged conversation with a named `who`, or an explicit contact on the application. A black-hole portal or cold application with none of these has nobody to follow up with, so `computeFollowUps` no longer emits an `app-nudge` for it (see `appHasContactPath` in `cadence.mjs`). Do **not** hand-draft a follow-up "to nobody" for such a row — the real move is `relationship-sourcing` (find a contact first) or a plain wait/archive decision. The dashboard mirrors this: a contactless quiet application shows no action.
   - `post-interview-nudge`: 4–6 lines referencing the interview stage, reiterating interest, and asking about next steps.
   - `thank-you`: warm, specific thank-you referencing one detail from `applications[].conversations[]`; keep to 3–5 lines.
   - `needs-reply` / `comm-due` / `waiting-stale`: advance the existing thread per STEP 5's follow-up guidance.
3. **Persist** the draft to the record (see STEP 8 — "Persist a baked draft" above, including its DB-mode branch).
4. **Validate and re-render** after all drafts are written — same mode branch as STEP 8 items 6–7: DB workspace runs `rolester data verify` + `rolester tracker --verify`; legacy workspace runs `rolester tracker --verify` then `rolester tracker`.

---

## HONESTY

> See **Negotiation Contract › Honesty Firewall (hard)** in AGENTS.md. Read `candidate/honesty.yml` before every draft.

---

## Known limitations

- **Cadence is candidate-configurable via `follow_up:` in `candidate/targeting.yml`.**
  STEP 8's timing defaults come from `src/core/tracker/cadence.mjs` (`FOLLOWUP_RULES`),
  but a candidate can override any kind's `enabled` flag and `after_days` / `after_hours`
  threshold via a `follow_up:` block in `candidate/targeting.yml` — the schema for
  this block is defined in `config/targeting.schema.json` and the snake_case → camelCase
  mapping is handled by `rulesFromConfig()` in `cadence.mjs`. Supported kinds:
  `app_nudge`, `post_interview`, `waiting_stale`, `interview_thank_you`, `needs_reply`,
  `comm_due`. Two kinds are new as of the current cadence engine: **`post-interview-nudge`**
  (interviewed but gone quiet, default 5 days) and **`thank-you`** (owed within 24 hours
  of a logged interview). Always check whether a kind is enabled before preparing or
  surfacing a draft for it.
