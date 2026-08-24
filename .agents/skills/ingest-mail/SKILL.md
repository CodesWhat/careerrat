---
name: ingest-mail
description: Read job-search email updates from Apple Mail on macOS or, with separate mail_access consent, Gmail/Outlook webmail through the session browser; fold recruiter replies and status changes into CareerRat tracker communication state. Opt-in, local-only, read-only.
metadata:
  tier_1_inputs:
    - source/opt-in gate
    - watermark window
    - tracker thread match keys
  tier_2_inputs:
    - matched-message full bodies
---

# ingest-mail

> **Runs under AGENTS.md.** These contracts bind without being restated here: Privacy Invariant (`current_base` never outbound), Honesty Firewall, Placeholder/Bracket Ban, Gate Write-back, Domain-Neutral Rule, Browser Automation Contract, Activity Pulse logging, Tracker verify+snapshot, and Sent-Clears-Draft. Inline reminders at point-of-use are intentional; standalone restatements point back to the relevant AGENTS.md section.

## STEP 0 — SOURCE + OPT-IN GATE

Confirm the user explicitly requested this sync. Never run this skill unprompted
or on a schedule.

Determine the requested mail source:

- **Apple Mail** — default when the user asks for "mail" on macOS and does not name Gmail/Outlook.
- **Gmail / Outlook webmail** — use only when the user asks for Gmail, Outlook, webmail, or the machine is not macOS and the user wants a browser-backed mail sync.

Run `uname`.

- If using Apple Mail and the output is not `Darwin`, stop the Apple Mail path and offer either Gmail/Outlook webmail (if they want to opt into `mail_access`) or pasted email capture via `email-comms`.
- If using Gmail/Outlook webmail, continue to STEP 1W below.

## STEP 1 — MAIL PROCESS PRE-FLIGHT

Run:

```bash
osascript -e 'tell application "System Events" to (name of processes) contains "Mail"'
```

If the result is `false`, tell the user to open Apple Mail and re-run. Do not
attempt to launch Mail automatically.

If the first `osascript` call fails with a permission error ("Terminal wants to
control System Events"), instruct the user to approve Automation access in
System Settings → Privacy & Security → Automation.

## STEP 1W — WEBMAIL CONSENT PREFLIGHT (GMAIL / OUTLOOK ONLY)

Use this path only for `gmail` or `outlook`. It is separate from Apple Mail and
separate from in-platform messaging.

Run:

```bash
careerrat automation status --json
```

Inspect `capabilities.mail_access` for the requested platform. `allowed: true`
means all three conditions are simultaneously true: the `mail_access` capability
global switch is on, that mail provider's per-capability switch is on, and that
provider's one-time ToS consent is recorded. This is the three-part AND from
`mayRun()` in `src/core/automation/consent.mjs` — never re-derive it in prose.

If `mail_access` is not allowed, stop before opening a browser and show the exact
opt-in steps:

1. Read the provider's terms of service yourself.
2. `careerrat automation consent <gmail|outlook> --write`
3. `careerrat automation enable mail_access --write`
4. `careerrat automation enable mail_access <gmail|outlook> --write`
5. `careerrat automation status --json`

If allowed, use the session browser. Read only job-search/recruiting messages in
the resolved window from STEP 2; do not browse personal mail outside that scope.
Never send, delete, reply, archive, or intentionally mark messages read. Halt on
a webmail login wall, mail 2FA prompt, captcha, or unexpected interstitial. Use
`classifyMailAccessBlocker()` from `src/core/automation/mail-access.mjs` when
classifying page text.

## STEP 2 — LOAD WATERMARK + COMPUTE WINDOW

Read `workspace/tracker.json`. Find the entry in `sources[]` where `id` is
`"apple-mail"` for Apple Mail, `"gmail-webmail"` for Gmail, or
`"outlook-webmail"` for Outlook. If the entry exists and has a `lastRunAt`
value, use that ISO-8601 date-time as the `date received >` threshold for the
AppleScript query or webmail search window.
If no such entry exists or `lastRunAt` is absent, default the window to
`(current date) - 14 * days`.

Log the resolved window to the user before proceeding:
`Scanning <source> for messages received after <resolved-threshold>.`

## STEP 3 — READ MAIL METADATA (APPLESCRIPT PRIMARY)

Apple Mail path:

Run the metadata sweep using the resolved window from Step 2. Capture per
message: date received, sender address, subject, message ID. Do NOT pull body
content yet.

Compute the threshold as a shell variable first, then pass it into the
AppleScript so the snippet is self-contained and nothing is left as a
placeholder comment:

```bash
# Compute epoch seconds for the resolved threshold (from Step 2).
# Use the lastRunAt ISO date if present, or fall back to 14 days ago.
THRESHOLD_EPOCH=$(date -j -f "%Y-%m-%dT%H:%M:%S" "${LAST_RUN_AT:-}" "+%s" 2>/dev/null \
  || date -v-14d "+%s")
THRESHOLD_HRS=$(( ( $(date "+%s") - THRESHOLD_EPOCH ) / 3600 ))

osascript -e "tell application \"Mail\"
  set out to \"\"
  set cutoff to (current date) - (${THRESHOLD_HRS} * hours)
  repeat with m in (messages of inbox whose date received > cutoff)
    set out to out & (date received of m as string) & \"\t\" & (sender of m) & \"\t\" & (subject of m) & \"\n\"
  end repeat
  return out
end tell"
```

`LAST_RUN_AT` is the raw `lastRunAt` string read from `sources[id=apple-mail]`
in Step 2 (empty string if absent; the `|| date -v-14d` branch then activates).

If the osascript call fails with a permission error, proceed to Step 4 (SQLite
fallback) and explain which toggle the user must flip in System Settings →
Privacy & Security → Full Disk Access.

Webmail path:

Use the session browser to search Gmail/Outlook for messages newer than the
resolved threshold and likely related to recruiting / applications. Capture per
message: date received, sender address, subject, and a stable provider message
identifier or URL. Do NOT pull body content yet. Keep the visible search scoped
to the window and job-search terms; do not scroll/browse the broader inbox.

## STEP 4 — SQLITE FALLBACK (if Step 3 fails or permission denied)

Apple Mail only. The webmail path has no SQLite fallback; if the session browser
hits a login wall, mail 2FA prompt, captcha, or provider error, halt and ask the
user to paste the relevant email content or clear the blocker manually.

First probe the schema to confirm column names before querying:

```bash
sqlite3 ~/Library/Mail/V*/MailData/"Envelope Index" .schema 2>/dev/null | grep -i date
```

Once columns are confirmed, query the `messages` table for messages in the same
window. Treat the result as best-effort — surface any schema mismatch to the
user and do not guess column names. Bodies in this path live in per-account
`.emlx` files under `~/Library/Mail/`; reference them by message ID.

## STEP 5 — MATCH TO TRACKER

Read `workspace/tracker.json` (already loaded in Step 2). Also read
candidate targeting config through the shared DB-first accessor for
`excluded_companies`, `keep_signals`, and any additional domain/company signals
not yet in the tracker (e.g., a company in `excluded_companies` should be
skipped at match time).

For each message from Step 3 or Step 4, attempt matching in priority order:

1. Sender email domain vs. application `domain` field.
2. Company name in subject or body vs. application `company` field.
3. Subject vs. existing `communications[].subject` on any application.

Apply a subject-line pre-filter: skip messages whose subjects match obvious
non-job patterns (e.g., contain "invoice", "receipt", "billing", "order
confirmation") — list any filtered-out messages so the user can see what was
skipped.

Collect all unmatched and ambiguous messages. Print them as a numbered table
(row: index | sender | subject | date received) and ask the user to supply the
application ID for each row or type `skip`. Do not proceed to Step 6 for any
message until it is either matched or explicitly skipped.

## STEP 6 — PULL BODIES FOR MATCHED MESSAGES ONLY

**[DELEGATE: subagent]** Body pulls for matched messages are independent. The Apple Mail /
SQLite path is local and batches across subagents; the webmail (`mail_access`) path drives
the session browser and stays **sequential** (one-browser rule). Each subagent returns the
captured body for its message; the orchestrator folds them into `communications[]` and
remains the only tracker writer. The STEP 0/1W opt-in gate already cleared on the
orchestrator. Degrade to inline sequential pulls with no subagent primitive. See the
**Delegation Contract** in AGENTS.md.

For each confirmed match from Step 5, pull the full message body only for that
matched message.

Apple Mail path:

```bash
osascript -e 'tell application "Mail" to get content of message id "<message-id>" of inbox'
```

Webmail path:

Open only the confirmed matched message in the session browser and read its
visible body. Do not open unrelated messages. Do not send, delete, reply,
archive, or intentionally mark messages read. If the provider blocks access with
a login wall, mail 2FA prompt, captcha, or unexpected interstitial, halt and ask
the user to paste the message body or clear the blocker manually.

If the body is long (over ~1,500 characters), ensure the directory exists then
save the body:

```bash
mkdir -p workspace/comms
```

Write the body to `workspace/comms/<company>-<threadId>.md` and store the path
in the message record as `artifactPath`. Short bodies may be stored inline in
`summary`.

Never write message body content anywhere outside `workspace/`. Never transmit
it outbound.

## STEP 7 — CAPTURE TO TRACKER

**Mode detection:** run `careerrat data status`. Exit 0 → DB workspace — use the
`careerrat data <verb>` commands below (Data Write Contract, AGENTS.md). Nonzero
exit → legacy workspace (no DB yet) — use the direct `workspace/tracker.json`
instructions further down in this step.

**DB workspace:** for each confirmed-matched message:

1. Save any long raw body to `workspace/comms/<thread-id>.md` as before. This
   artifact file write is local-only and is unaffected by DB vs legacy mode.
2. Find or create the parent communication row by patching the full
   communication object and persisting it:

   ```bash
   careerrat data comm upsert --data '<full communication row JSON>'
   ```

3. Append the inbound message:

   ```bash
   careerrat data comm append-message <comm-id> --data '<message JSON>'
   ```

4. If the message changes parent communication state (`status`,
   `lastInboundAt`, `nextAction`, `nextActionDue`, `draft`,
   `outcomeSignalUnresolved`), patch the full communication row from the
   current exported tracker state and persist it again:

   ```bash
   careerrat data comm upsert --data '<patched full communication row JSON>'
   ```

5. For outcome-signal records, follow STEP 8: write only the message append and
   `lastInboundAt` first, hand the outcome to `track-outcomes`, and let
   `track-outcomes` settle application state. If `track-outcomes` fails to
   settle the communication state, persist the fallback communication row with
   `status: "waiting"`, `nextAction: null`, `nextActionDue: null`,
   `draft: null`, and `outcomeSignalUnresolved: true` through
   `careerrat data comm upsert`.

The communication verbs bump/export/log Activity Pulse events automatically.
Add a richer inbound-thread event only if needed with
`careerrat data activity append --data '<activity JSON>'`; do not hand-edit
`activity.jsonl` in DB mode. The message shape, CTA-clearance rules, privacy
invariant, and gate write-back rules below apply in both modes.

**Legacy workspace (no DB):** for each confirmed-matched message, update
`workspace/tracker.json` directly:

Find or create the `communications[]` record with fields:
`id`, `applicationId`, `company`, `role`, `channel: "email"`, `status`,
`summary`.

Append to `communications[].messages[]` a message object with this exact shape
(per the locked schema in foundations-spec §4):

```json
{
  "id": "msg-<appId>-<n>",
  "direction": "inbound",
  "at": "<ISO-8601>",
  "from": "<sender-address>",
  "to": ["<recipient-address>"],
  "subject": "<subject>",
  "summary": "<concise gist — do NOT include current_base>",
  "artifactPath": "<workspace/comms/... or empty string>"
}
```

Update the parent `communications[]` record fields: `status`, `lastInboundAt`,
`nextAction`, `nextActionDue`.

- **CTA clearance — expected event arrived:** If the inbound message is the event that was being waited on (the recruiter replied, a confirmation email arrived, or a form-submission acknowledgment was received), set `nextActionDue = null` and rewrite `nextAction` to the next pending action or clear it entirely. Do not leave a satisfied due date in place.
- **Stale draft clearance:** If the matched comm thread has a non-null `comm.draft`, set `comm.draft = null` — an inbound reply proves the outbound was sent; the draft is stale and must not surface as a CTA.
- **Acknowledgment / confirmation emails:** When the inbound message subject or body matches acknowledgment patterns ("application received", "submission confirmed", "we have received", "thank you for submitting", "form received"), treat it as a CTA-clearing event: set `nextActionDue = null`, set `nextAction` to `null` or `"awaiting-response"`, and set `status = "waiting"`. Do not set a new future due date for these messages.

Privacy invariant: `summary` and `artifactPath` content must never echo
`profile.compensation.current_base`. Outbound-safe comp fields are
`expected_base`, `target_base`, and `minimum_base` only.

If the user states a new gate mid-flow (e.g., "never follow up with this
company", "add them to excluded"), apply the write-back rule using this
discriminator:

- **Write directly and report** when the change affects only the single
  application in scope (e.g., set `nextAction: none` on one record) or is a
  low-blast-radius supported gate (`careerrat gate cut-signal` / `keep-signal`).
- **Confirm first** when the change affects more than one application or has
  broad downstream effects (e.g., a comp floor change that re-screens the whole
  board, adding a wildcard domain exclusion, or resetting an aggregated field
  like `minimum_base` in `profile.yml`).

Route each gate type through its owning command:

- Company exclusion → `careerrat gate exclude-company "<Company>" --write --confirm`
- Comp floor change → `careerrat gate comp-floor <N> --write --confirm`
- Per-application follow-up pause → `workspace/tracker.json` (that record's
  `nextAction`/`nextActionDue`)

Then log each inbound thread to the Activity Pulse feed (the dashboard's live timeline — see **Activity Pulse** in AGENTS.md). One event per inbound thread captured, actor `world`:

```
careerrat activity append --type message --actor world \
  --title "<Company> replied" --summary "<subject or one-line summary>" \
  --company "<Company>" --app-id <application id> --write
```

## STEP 8 — CLASSIFY OUTCOME SIGNALS

For each captured message, scan the summary for outcome signals:

- Rejection language → outcome label `rejected`
- Offer language → outcome label `offer`
- Interview advance / scheduling → outcome label `interview-advance`

For any message carrying one of these signals, hand off to `track-outcomes`
with the `applicationId` and the outcome label before finalizing communication
state for that record. **For outcome-signal records, skip the Step 7 status/nextAction/nextActionDue write for that record — write only the `messages[]` append and `lastInboundAt`.** Pass the full comm state write (status, nextAction, nextActionDue) to `track-outcomes`; a partial Step 7 write would surface a ghost CTA between the two writes.

If `track-outcomes` fails or returns without writing `status`, `nextAction`, and `nextActionDue` for a record, fall back to writing that record's `status: "waiting"`, `nextAction: null`, `nextActionDue: null` directly (in a follow-up STEP 7 write), and set `outcomeSignalUnresolved: true` on the record so the next ingest-mail sweep surfaces it for re-resolution. Do not leave the record in a half-written state (messages[]/lastInboundAt set but comm state never resolved) — that is the ghost-CTA condition this fallback prevents.

## STEP 9 — WRITE WATERMARK

Run this step unconditionally — even if STEP 8 (the track-outcomes hand-off) returned early or failed, the sweep happened, so the watermark must still be written. Write `lastRunAt` to the matching `sources[]` entry and also set `meta.lastSweepAt` to the same timestamp. Do **not** set `meta.lastUpdatedAt` here — that field drives the dashboard's "last updated" pill and must only be touched when this sweep actually mutated tracker data (a status, nextAction, or nextActionDue change). A sweep that found nothing or had no outcome-signal hand-offs must not reset that pill.

**DB workspace:**

```bash
careerrat data source watermark --at <ISO-8601 timestamp of now> --data '<source JSON>'
```

Use one of these source objects:

Apple Mail:

```json
{ "id": "apple-mail", "kind": "apple-mail", "name": "Apple Mail", "lastRunAt": "<ISO-8601 timestamp of now>" }
```

Gmail webmail:

```json
{ "id": "gmail-webmail", "kind": "webmail", "name": "Gmail webmail", "lastRunAt": "<ISO-8601 timestamp of now>" }
```

Outlook webmail:

```json
{ "id": "outlook-webmail", "kind": "webmail", "name": "Outlook webmail", "lastRunAt": "<ISO-8601 timestamp of now>" }
```

`source watermark` updates `sources[]` and `meta.lastSweepAt`, exports tracker
files, and intentionally does not bump `meta.version`, `meta.lastUpdatedAt`, or
Activity Pulse.

**Legacy workspace (no DB):** upsert the selected source object into
`tracker.json#sources[]`. If an entry with the selected source id already
exists, update only `lastRunAt`. If no such entry exists, insert the full
object. Write the change directly to `workspace/tracker.json`.

## STEP 10 — VERIFY + SNAPSHOT

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

Print a final ingest summary. The counts in this summary are agent-composed
from the running tallies kept during Steps 5–8 — they are NOT parsed from
CLI output (the CLI commands above confirm schema validity and rendering
only, and do not emit these counts):

```
Ingest complete:
  Messages scanned:    N
  Matched:             M  (to K applications)
  Unmatched/skipped:   U  (listed above)
  Handed to track-outcomes: P  (application IDs: ...)
  Watermark updated:   <lastRunAt>
```

---

## Conversational workspace path

In the Ask workspace, one narrow piece of this skill is native: the app runs a
typed `mail.sync-request` intent directly in `workspace-agent.mjs`, not this
skill's mail-reading steps. A terminal or external-agent run still follows
STEP 0 onward exactly as written, and all mail reading always happens there.
The app never opens Apple Mail, Gmail, or Outlook itself.

- **Requesting a mail check** (`mail.sync-request`). "Check my email" or "any
  new recruiter emails?" offers a "Check for new mail" chip. The handler
  returns a handoff card showing each source's real state: Apple Mail (listed
  only when the app runs on macOS, since it reads the local Mail app and needs
  no webmail consent), plus Gmail and Outlook with their `mayRun` consent
  state for the `mail_access` capability. Each row shows the last sweep time
  from that source's `sources[]` watermark ("Never checked" before a first
  run), and the card adds how many email threads are currently waiting on a
  reply. On a non-macOS host with both webmail platforms off, the request
  refuses toward Settings instead. The intent reads no mail and changes no
  tracker state; the only record it leaves is its own receipt message in the
  Ask conversation, like every other workspace request.
- **What stays here.** The actual mail reading (AppleScript, SQLite fallback,
  or session-browser webmail), the STEP 5 match/skip review table, body pulls,
  `communications[]` and watermark writes, and the track-outcomes handoff all
  remain this skill's agent path. Recording a single recruiter email the
  candidate reports themselves stays with email-comms
  (`communication.capture-inbound` and its sibling intents).
