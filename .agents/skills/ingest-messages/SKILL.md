---
name: ingest-messages
description: Read in-platform DMs from LinkedIn and Wellfound via the session browser and fold them into tracker communications[] — the browser analog of ingest-mail. Opt-in, user-initiated, local-only. Capability = messaging; platforms = linkedin, wellfound.
metadata:
  tier_1_inputs:
    - consent verdict
    - watermark window
    - tracker thread match keys
  tier_2_inputs:
    - per-thread message bodies
---

# ingest-messages

> **Runs under AGENTS.md.** These contracts bind without being restated here: Privacy Invariant (`current_base` never outbound), Honesty Firewall, Placeholder/Bracket Ban, Gate Write-back, Domain-Neutral Rule, Browser Automation Contract, Activity Pulse logging, Tracker verify+snapshot, and Sent-Clears-Draft. Inline reminders at point-of-use are intentional; standalone restatements point back to the relevant AGENTS.md section. Bare `candidate/`, `workspace/`, `config/`, and `.internal/` paths below are symbolic; resolve them per AGENTS.md's Path Resolution rule.

## STEP 0 — CONSENT GATE (hard stop)

This is the highest ToS-exposure capability in the automation stack. Messaging
automation most directly risks a platform's terms of service — the consent gate
here is the most explicit in the system. Never open a browser or touch any platform
until consent is confirmed.

Run:

```
careerrat automation status --json
```

Inspect the `capabilities.messaging` entry. The applicable platforms are `linkedin`
and `wellfound`. For each platform, `allowed: true` means all four conditions are
simultaneously true: automation is in the "advanced" setup mode, the `messaging`
capability global switch is on, that platform's per-capability switch is on, and
the platform's one-time ToS consent is recorded. This is the four-part AND from
`mayRun()` in `src/core/automation/consent.mjs` — never re-derive it in prose.

If **no platform** shows `allowed: true`, explain exactly how to opt in, then
stop — do not open a browser:

1. Read the platform's terms of service yourself to confirm automated messaging reads
   are permitted.
2. Record consent: `careerrat automation consent <platform> --write`
3. Enable the capability global switch: `careerrat automation enable messaging --write`
4. Enable for the specific platform: `careerrat automation enable messaging <platform> --write`
5. Verify: `careerrat automation status --json`

State clearly: this capability is OFF by default; enabling it is a deliberate choice.
The user must read the platform ToS themselves before recording consent — CareerRat
records the decision but does not make it.

This skill is always user-initiated. Never run it unprompted or on a schedule.

## STEP 1 — LOAD WATERMARK + COMPUTE WINDOW

Read `workspace/tracker.json`. For each platform that showed `allowed: true` in STEP 0,
find the entry in `sources[]` whose `id` is `"linkedin-messages"` or
`"wellfound-messages"` respectively. If the entry exists and has a `lastRunAt` value,
use that ISO-8601 date-time as the lookback threshold for that platform. If no such
entry exists or `lastRunAt` is absent, default the window to 14 days back.

Log the resolved window per platform before proceeding:

```
Scanning LinkedIn messages received after <resolved-threshold>.
Scanning Wellfound messages received after <resolved-threshold>.
```

Proceed only with platforms that are both allowed and in scope. Skip any platform
that is not `allowed: true` and note the reason.

## STEP 2 — OPEN THE MESSAGES INBOX IN THE SESSION BROWSER

For each allowed platform, navigate to that platform's messages or DM inbox URL in
the session browser. The session browser is Layer 3 per `docs/BROWSER.md`. Keep the
provider on `auto` unless the user explicitly changes it; CareerRat resolves the current
session browser and reuses its signed-in session.

Before reading anything, snapshot or read the current page state. Drive the live DOM
turn-by-turn. Never rely on hardcoded selectors — the same model as `apply-job`.

If you encounter a login wall, captcha, 2FA prompt, or any unexpected interstitial at
any point, halt immediately and ask the user to complete it. Do not attempt to bypass
or automate around any auth challenge.

Save any screenshot or scraped page fragment under `workspace/` only.

## STEP 3 — READ MESSAGE METADATA

Within the inbox, scroll to surface threads active within the window resolved in
STEP 1. For each visible thread, capture — without opening the thread body:

- Correspondent name and/or handle
- Correspondent headline / title and any thread badge (recruiter / talent / hiring /
  InMail / Jobs / Sponsored / Promoted) when surfaced in the list — this is the
  recruiting-relevance signal consumed in STEP 4
- Thread subject or first-message snippet
- Most-recent message timestamp
- Thread ID or URL (to return for full body if matched)
- Direction of the most-recent message (inbound / outbound — infer from position or
  sender name vs. the candidate's own account name)

Do NOT pull full message bodies yet. Collect only enough metadata to classify
recruiting-relevance and match threads to tracker applications in STEP 4.

## STEP 4 — MATCH TO TRACKER

Read `workspace/tracker.json` (already loaded in STEP 1). Also read
candidate targeting config through the shared DB-first accessor for
`excluded_companies` and any company/domain signals relevant at match time.

For each thread from STEP 3, attempt matching in priority order:

1. Correspondent name vs. `communications[].messages[].from` / `messages[].to` on
   any existing application record.
2. Company name extracted from the thread subject or snippet vs. application `company`
   field.
3. Thread subject vs. existing `communications[].subject` on any application.

Apply a two-sided relevance classification BEFORE escalating anything to the user — the
human gate is for "real recruiter, which application?", never for "is this even a job thread?":

**Negative pre-filter** — auto-skip threads whose subject / snippet / sender match obvious
non-recruiting patterns: marketing, event invite, newsletter, sponsored / promoted, or a
clearly personal or networking exchange with no job signal.

**Positive relevance test** — for every remaining unmatched thread, decide whether it is
plausibly recruiting-related from the STEP 3 signals: a recruiter / talent / hiring sender
headline, an InMail or Jobs badge, or role / opportunity / interview / screening / offer /
JD language in the snippet. A thread with NONE of these signals and no tracker match is
auto-skipped as non-recruiting — do NOT put it in the user table. (A 1st-degree connection
sending a casual reply with no job content is the canonical auto-skip; the agent classifies
it, it does not ask the user about it.)

Only escalate threads that PASS the positive test (look recruiting-related) yet cannot be
auto-matched to an existing application — e.g. a recruiter for a company not yet tracked, or
an ambiguous match across two applications. When relevance is genuinely unclear from metadata
alone, ONE lightweight body peek is permitted to classify (read-only, for classification only,
never ingestion); if still unclear, escalate.

Log every auto-skip (both negative-filter and non-recruiting) so the user sees what was
dropped and why. Then collect only the escalated unmatched / ambiguous threads into a
numbered table:

```
#  | Platform  | Correspondent        | Subject / snippet                      | Date
---|-----------|----------------------|----------------------------------------|----------
1  | linkedin  | Jane Smith           | "Following up on your application..."  | 2026-06-10
2  | wellfound | Alex Rivera          | "Intro from Acme Engineering team"     | 2026-06-09
```

Ask the user to supply the application ID for each numbered row or type `skip`.
Do not proceed to STEP 5 for any thread until it is either matched or explicitly
skipped.

## STEP 5 — PULL BODIES FOR MATCHED THREADS ONLY

**[DELEGATE: subagent — sequential]** Thread body-pulls drive the session browser, so they
run **one at a time** per the one-browser rule — delegation here buys per-thread context
isolation, not parallelism. Each subagent reads its matched thread and returns the
chronological messages; the orchestrator captures them to `communications[]` (sole tracker
writer). The STEP 0 consent gate already ran on the orchestrator. See the **Delegation
Contract** in AGENTS.md.

For each confirmed match from STEP 4, navigate to that thread in the session browser
and read the full message bodies within the lookback window. Snapshot the page before
reading. Capture all individual messages in the thread in chronological order:
direction, timestamp, sender name, and body text.

If the full thread text is long (over ~1,500 characters), ensure the directory exists
first then save the body:

```bash
mkdir -p workspace/comms
```

Write the thread to `workspace/comms/<company-slug>-<threadId>.md` and record the
path as `artifactPath`. Short bodies may be stored inline in `summary`.

Never write message body content anywhere outside `workspace/`. Never transmit it
outbound. Never send any message, reply, or reaction — this skill is read-only on
the platform.

## STEP 6 — CAPTURE TO TRACKER

**Mode detection:** run `careerrat data status`. Exit 0 → DB workspace — use the
`careerrat data <verb>` commands below (Data Write Contract, AGENTS.md). Nonzero
exit → legacy workspace (no DB yet) — use the direct `workspace/tracker.json`
instructions further down in this step.

**DB workspace:** for each confirmed-matched thread:

1. Save any long raw body to `workspace/comms/<thread-id>.md` as before. This
   artifact file write is local-only and is unaffected by DB vs legacy mode.
2. Find or create the parent communication row by patching the full
   communication object and persisting it:

   ```bash
   careerrat data comm upsert --data '<full communication row JSON>'
   ```

3. Append each newly captured message in chronological order:

   ```bash
   careerrat data comm append-message <comm-id> --data '<message JSON>'
   ```

4. If the thread changes parent communication state (`status`, `lastInboundAt`,
   `nextAction`, `nextActionDue`, `draft`), patch the full communication row
   from the current exported tracker state and persist it again:

   ```bash
   careerrat data comm upsert --data '<patched full communication row JSON>'
   ```

5. For outcome-signal threads, follow STEP 7: defer intermediate `needs-reply`
   writes, hand the outcome to `track-outcomes`, then persist only the resolved
   communication state after `track-outcomes` returns. Do not hand-edit
   `tracker.json` or `activity.jsonl` in DB mode.

The communication verbs bump/export/log Activity Pulse events automatically.
Add a richer inbound-thread event only if needed with
`careerrat data activity append --data '<activity JSON>'`. The message shape,
status-transition rules, privacy invariant, and gate write-back rules below
apply in both modes.

**Legacy workspace (no DB):** for each confirmed-matched thread, update
`workspace/tracker.json` directly.

Find or create the `communications[]` record with fields:
`id`, `applicationId`, `company`, `role`, `status`, `summary`.

Set `channel` based on platform:

- LinkedIn threads → `channel: "linkedin"`
- Wellfound threads → `channel: "portal"`

Both enum values exist in `config/tracker.schema.json`; no schema change is needed.

For each individual message in the thread (within the lookback window), append to
`communications[].messages[]` a message object with this exact shape (per the locked
schema in foundations-spec §4):

```json
{
  "id": "msg-<appId>-<n>",
  "direction": "inbound",
  "at": "<ISO-8601>",
  "from": "<sender-name-or-handle>",
  "to": ["<recipient-name-or-handle>"],
  "subject": "<thread subject or first-line snippet>",
  "summary": "<concise gist — do NOT include current_base>",
  "artifactPath": "<workspace/comms/... or empty string>"
}
```

For outbound messages in the thread (sent by the candidate), set `"direction":
"outbound"`.

Update the parent `communications[]` record fields as follows — all in **one write**
(partial writes leave ghost CTAs):

- **status transition (required):** if the last captured message in this thread is
  `direction: inbound`, set `status → needs-reply`; if the last captured message is
  `direction: outbound` and no inbound message follows it, set `status → waiting`.
- **nextActionDue null-first rule:** if the matched comm record previously had
  `status: waiting` (candidate was awaiting a recruiter reply) and an inbound message
  now arrives, **set `nextActionDue → null` first** (the expected event has occurred),
  then set a new `nextActionDue` for the candidate's reply window (72 h from the
  inbound message timestamp, unless the message implies urgency — e.g. "let me know
  by EOD" → same-day).
- **draft-clearing rule:** if the existing comm record has `comm.draft != null`, set
  `comm.draft = null` in this same write and note `"draft cleared — superseded by
  recruiter reply"`. This closes the ghost "Ready to send" panel that would otherwise
  persist after a new inbound message arrives on that thread.
- **Outcome-signal deferral:** before writing the comm status above, **peek at the
  outcome-signal classification** (STEP 7). If this thread will be handed to
  `track-outcomes` (rejected / offer / interview-advance), **do NOT write an
  intermediate `needs-reply` status** — hold the comm write, complete the
  `track-outcomes` hand-off, then write comm state **once** as a single atomic update
  (status, nextActionDue, comm.draft — all in one pass) after `track-outcomes` returns
  the resolved state. This prevents a ghost CTA between STEP 6 and STEP 7 completing.

Privacy invariant: `summary` and `artifactPath` content must never echo
`profile.compensation.current_base`. Outbound-safe comp fields are `expected_base`,
`target_base`, and `minimum_base` only.

If the user states a new gate mid-flow (e.g., "never follow up with this company",
"add them to excluded"), apply the write-back rule using this discriminator:

- **Write directly and report** when the change affects only the single
  application in scope (e.g., set `nextAction: none` on one record) or is a
  low-blast-radius supported gate (`careerrat gate cut-signal` / `keep-signal`).
- **Confirm first** when the change affects more than one application or has broad
  downstream effects (e.g., a comp floor change, adding a wildcard domain exclusion).

Route each gate type through its owning command:

- Company exclusion → `careerrat gate exclude-company "<Company>" --write --confirm`
- Comp floor change → `careerrat gate comp-floor <N> --write --confirm`
- Per-application follow-up pause → `workspace/tracker.json` (that record's
  `nextAction`/`nextActionDue`)

Then log each inbound thread to the Activity Pulse feed (the dashboard's live timeline — see **Activity Pulse** in AGENTS.md). One event per inbound thread captured, actor `world`:

```
careerrat activity append --type message --actor world \
  --title "<Company> messaged" --summary "<one-line summary>" \
  --company "<Company>" --app-id <application id> --write
```

## STEP 7 — CLASSIFY OUTCOME SIGNALS

For each captured thread, scan the summaries for outcome signals:

- Rejection language → outcome label `rejected`
- Offer language → outcome label `offer`
- Interview advance / scheduling request → outcome label `interview-advance`

For any thread carrying one of these signals, **before** handing off: set
`comm.draft = null` on that record if a draft exists (draft is stale once an outcome
is known). Then hand off to `track-outcomes` with the `applicationId` and the outcome
label. Do not write `status` for those records before `track-outcomes` returns — wait
for the resolved state, then write comm and app in one atomic pass (status,
nextActionDue → null, comm.draft → null, messages[] append). The STEP 6 comm write
is **deferred** for outcome-carrying threads; `track-outcomes` owns the outcome write
and the final comm/app state is settled in that single pass.

Reply drafts are NOT this skill's job. If the user wants to reply to a DM, hand
off to `email-comms` — it is channel-aware for `linkedin` and `portal` and will
draft the response.

## STEP 8 — WRITE WATERMARK

For each platform successfully polled, write the source watermark.

**DB workspace:**

```bash
careerrat data source watermark --at <ISO-8601 timestamp of now> --data '<source JSON or JSON array>'
```

LinkedIn:

```json
{ "id": "linkedin-messages", "kind": "linkedin-messages", "name": "LinkedIn Messages", "lastRunAt": "<ISO-8601 timestamp of now>" }
```

Wellfound:

```json
{ "id": "wellfound-messages", "kind": "wellfound-messages", "name": "Wellfound Messages", "lastRunAt": "<ISO-8601 timestamp of now>" }
```

When both platforms were polled, pass a JSON array containing both objects.
`source watermark` updates `sources[]` and `meta.lastSweepAt`, exports tracker
files, and intentionally does not bump `meta.version`, `meta.lastUpdatedAt`, or
Activity Pulse.

**Legacy workspace (no DB):** upsert the same object(s) into
`tracker.json#sources[]`. If an entry with the matching `id` already exists,
update only `lastRunAt`. If no such entry exists, insert the full object.
Write the changes directly to `workspace/tracker.json`.

## STEP 9 — VERIFY + SNAPSHOT

**DB workspace:**

```bash
careerrat data verify
careerrat tracker --verify
careerrat tracker --followups
careerrat tracker --summary
```

Both verify commands must exit 0. If either fails, do not proceed — show the
validation errors and ask the user how to resolve them. Confirm new threads
appear in the follow-ups surface and message counts incremented for the
matched applications. Run `careerrat tracker` afterward only when a recovery
snapshot is useful.

**Legacy workspace (no DB):**

```bash
careerrat tracker --verify
careerrat tracker --followups
careerrat tracker --summary
careerrat tracker
```

`careerrat tracker --verify` must exit 0. If it fails, do not proceed — show the
validation errors and ask the user how to resolve them. Confirm new threads
appear in the follow-ups surface and message counts incremented. The final
command creates a deduplicated recovery checkpoint under `workspace/.snapshots/`.

Print a final ingest summary. The counts in this summary are agent-composed from
the running tallies kept during STEPS 4–7 — they are NOT parsed from CLI output
(the CLI commands above confirm schema validity and snapshotting only, and do not
emit these counts):

```
Ingest complete:
  Platforms polled:            N  (<platform list>)
  Threads scanned:             T  (linkedin: A, wellfound: B)
  Auto-skipped (marketing/non-recruiting):  S  (listed above, with reasons)
  Matched:                     M  (to K applications)
  Escalated unmatched:         U  (listed above — awaiting your match/skip)
  Handed to track-outcomes:    P  (application IDs: ...)
  Watermarks updated:          <linkedin lastRunAt>, <wellfound lastRunAt>
```

---

## RULES

- **Opt-in, OFF by default.** Only poll platforms where `careerrat automation status --json`
  shows `messaging` `allowed: true` for that platform. The `allowed` field encodes the
  four-part AND (advanced setup mode · global switch · platform switch · ToS consent) from
  `mayRun()` in `src/core/automation/consent.mjs` — never re-derive the predicate in prose.

- **Highest ToS exposure — strongest consent gate.** In-platform messaging reads most
  directly risk a platform's terms of service. Consent must be deliberate: the user
  reads the platform ToS themselves and records it explicitly via the CLI. Surface this
  clearly; never downplay it.

- **Honor the Browser Automation Contract.** Follow AGENTS.md `## Browser Automation
  Contract` in full. The `mayRun()` predicate is the hard gate; if `allowed` is false,
  surface the reasons and stop — do not drive the browser.

- **Never run on a schedule or unattended.** Always user-initiated with the agent in
  the loop. Never invoke this skill automatically in response to a paste, a timer, or
  an upstream skill trigger.

- **Halt on auth challenges.** On captcha, 2FA prompt, login wall, or any unexpected
  interstitial, halt immediately and ask the user to resolve it. Never attempt to bypass
  or automate around an auth challenge.

- **Tool-agnostic browser prose.** Say "the session browser," "snapshot or read the
  page." Keep the provider on `auto`; never ask the user to choose a CLI, extension, or
  browser driver, and never name an MCP namespace or vendor tool.

- **Local-only.** Message bodies, thread artifacts, and screenshots stay under
  `workspace/`. Nothing goes outbound. No credentials are stored — the session browser
  holds the logins.

- **Read-only on the platform.** This skill reads messages and captures them to the
  tracker. It does NOT send, reply to, react to, or otherwise mutate any in-platform
  message. Reply drafts belong to `email-comms` (channel-aware for `linkedin` and
  `portal`).

- **Outcome writes belong to `track-outcomes` on this path.** Never write `status`
  directly for records carrying rejection / offer / interview-advance signals.
  Hand those to `track-outcomes` with the applicationId and label so it can apply
  the transition plus the required learning and follow-up work.

- **Privacy invariant.** Never write `current_base` into any `communications` field,
  message summary, or `workspace/comms/` artifact. Outbound-safe comp fields are
  `expected_base`, `target_base`, and `minimum_base` only.

- **Domain-neutral.** No hardcoded companies, roles, or candidate-specific values in
  this skill. No bracketed placeholder tokens anywhere — if a detail is unknown, omit
  it or go generic; never emit `[Company]`, `[Role]`, `[Name]`, or any bracket.

---

## In-app and terminal paths

CareerRat's in-app path reads LinkedIn and Wellfound recruiting messages through
its owned browser workflow after the platform-specific `messaging` permission
passes. It writes relevant threads into `communications[]`, stores long bodies
under `workspace/comms/`, and advances each platform watermark. A terminal or
external-agent run still follows the steps above exactly as written.

- **Requesting a message check** (`messages.sync-request`). "Check my LinkedIn
  messages" or "any new DMs?" offers a "Check for new messages" chip. The
  handler reports each platform's real `mayRun` consent
  state for the `messaging` capability, the last sweep time from that
  platform's `sources[]` watermark ("Never checked" before a first run), and
  how many LinkedIn threads are currently waiting on a reply. The count is
  LinkedIn-scoped on purpose: Wellfound threads record under the shared
  `portal` channel, so counting that channel would overclaim what a message
  sync covers. With every platform off, the request refuses toward Settings;
  there is no ungated fallback source here, unlike mail's local Apple Mail
  path. Otherwise, choosing the action runs every allowed platform and returns
  the captured count or a retry blocker in the same Ask thread.
- **Execution and recovery.** The app performs the allowed read when the chip is
  chosen. Login, captcha, 2FA, and permission blockers return a visible retry
  state without advancing the watermark. The terminal path keeps the detailed
  relevance/escalation review and track-outcomes handoff. Reply drafting stays
  with email-comms.
