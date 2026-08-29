---
name: schedule-meeting
description: Handle recruiter / hiring-team scheduling threads — read the proposed slots, the candidate's timezone and availability, and any calendar context; draft a clear availability reply, prepare a calendar-ready hold, and write scheduling state back to the tracker. Confirm-first before any outbound reply or calendar write. Degrades to a draft-only workflow when no calendar connector is available.
---

# schedule-meeting

The focused scheduling skill for recruiter / hiring-team threads: "when can you talk?",
"here are three slots," "can we move our call?". It owns the *scheduling* mechanics —
timezone resolution, slot selection, double-booking avoidance, calendar-ready holds — and
writes scheduling state back to the tracker.

**Relationship to `email-comms`.** `email-comms` remains the general written-comms surface
(replies, follow-ups, thank-yous, negotiation, cold outreach). Scheduling intent routes
*here* instead. If a thread turns out to be general comms or a comp negotiation rather than
scheduling, hand it back to `email-comms`. This skill draws on the same comms machinery
(thread match, style gate, message capture, activity logging) but adds the scheduling layer.

> **Runs under AGENTS.md.** These contracts bind without being restated here: Privacy Invariant (`current_base` never outbound), Honesty Firewall, Placeholder/Bracket Ban, Gate Write-back, Domain-Neutral Rule, Browser Automation Contract, Activity Pulse logging, Tracker verify+snapshot, and Sent-Clears-Draft. Inline reminders at point-of-use are intentional; standalone restatements point back to the relevant AGENTS.md section. Bare `candidate/`, `workspace/`, `config/`, and `.internal/` paths below are symbolic; resolve them per AGENTS.md's Path Resolution rule.

## Inputs

- `workspace/tracker.json` — `communications[]` and `applications[]`
- `workspace/comms/<thread-id>.md` — full raw thread body if previously saved
- `candidate/profile.yml` — `availability` block (optional), `location.*` (timezone
  fallback), `authorization.notice_period`
- `candidate/writing-style.md` (+ `workspace/writing-samples/`) — voice/register
- optional real free/busy — `workspace/tracker.json#calendarBusy[]` (opaque busy blocks
  ingested under the `calendar_read` capability), or a free/busy export the user provides
- the inbound scheduling message OR the user's stated scheduling intent

## Outputs

- a complete availability / confirmation reply (subject + body, no placeholders)
- an optional calendar-ready hold (`.ics`) written to `~/Downloads/careerrat/`
- updated `workspace/tracker.json` — `communications[].messages[]` + status, a
  `applications[].conversations[]` entry when a meeting is booked, and
  `interviewAt` / `nextInterviewAt` + `interviewNote` on the application row
- tracker snapshot checkpoint

---

## STEP 0 — Classify the scheduling intent

| Intent | What it is | Sub-steps |
|---|---|---|
| `propose-availability` | They asked when you're free; you offer windows | 1, 2, 3, 4, 5, 6, 7 |
| `accept-slot` | They proposed slots; you pick/confirm one | 1, 2, 3, 4, 5, 6, 7, 8 |
| `reschedule` | A booked meeting needs to move | 1, 2, 3, 4, 5, 6, 7, 8 |
| `send-scheduling-link` | Share a self-serve link instead of trading slots | 1, 2, 3, 5, 7 |

If the thread is actually general comms or a comp negotiation, stop and route to
`email-comms`. If the intent is ambiguous, ask one clarifying question first.

This skill is user-initiated. It drafts and prepares; it never sends a reply or writes to an
external calendar without explicit confirmation (see RULES).

---

## STEP 1 — Match to tracker thread

**Mode detection:** run `careerrat data status`. Exit 0 → DB workspace — every
write step below gives the `careerrat data <verb>` command (Data Write Contract,
AGENTS.md). Nonzero exit → legacy workspace (no DB yet) — every write step below
gives the existing direct JSON-edit instructions, unchanged.

Read `workspace/tracker.json`. Find the `communications[]` record whose `applicationId`,
`company` + `role`, or `threadId` / `subject` matches the message. If none exists and this is
a real thread, create one (same shape as `email-comms` STEP 1: `id`, `applicationId`,
`company`, `role`, `channel`, `status: "needs-reply"`, `summary`) and write it before
drafting. Don't draft against a thread that isn't recorded.

- **DB workspace:** `careerrat data comm upsert --data '<the new record JSON>'` (full-row insert).
- **Legacy workspace (no DB):** write the updated `workspace/tracker.json` directly.

---

## STEP 2 — Load context

Read, before drafting:

1. `workspace/comms/<thread-id>.md` — prior exchanges, if saved.
2. The linked `applications[]` row — role, stage, who you've spoken to
   (`conversations[]`), any artifacts.
3. The exact proposed slots / constraints in the inbound message (capture them verbatim —
   times, dates, duration, channel like phone / video / onsite, and the meeting purpose).

If the thread is for a role but no `applicationId` is linked, confirm the role first.

---

## STEP 3 — Resolve timezone + availability (never invent availability)

**Timezone.** Read `candidate/profile.yml#availability.timezone`. If absent, derive the
candidate's timezone from `location.home` and state the assumption to the user. Determine the
counterpart's timezone from the thread (their signature, stated location, or an explicit
"PT/ET"); if unknown, either ask or proceed stating the candidate's timezone clearly and
offering to adjust.

**Availability.** Read `availability` (`working_hours`, `preferred_days`, `preferred_times`,
`buffer_minutes`, `default_meeting_minutes`, `blackout`, `scheduling_link`). These are
*preferences*, not a live calendar — they constrain which windows are reasonable to offer,
they do not assert the candidate is actually free.

If the `availability` block is absent or thin, **ask the user for their real availability
once** (which days/times work, meeting length, timezone), then — confirm-first — offer to
persist it to candidate profile config (`availability`) so future runs don't ask again.
In DB mode use `careerrat data candidate patch profile --data ...`; in legacy mode use
the guarded candidate-config write path. Echo the CLI confirmation.

**Honesty (hard): never invent availability.** Only propose windows the candidate's
preferences or an explicit user confirmation support. If you cannot establish real
availability, ask — do not guess a free slot.

---

## STEP 3b — Ingest real free/busy (optional, gated by `calendar_read`)

This is the concrete version of "calendar context": it lets the skill see the candidate's
actual commitments so it schedules interviews *around* them, and surfaces those windows on the
Calendar as opaque **"Busy"** blocks. It is optional — the skill is fully usable without it
(STEP 4 falls back to draft-only). Run it when the user wants you to schedule around their real
calendar, or whenever `calendar_read` is already enabled.

**Consent gate.** Free/busy ingestion runs only under the `calendar_read` capability:

```bash
careerrat automation status --json
```

Inspect `capabilities.calendar_read`. Platforms:

- `work_calendar` — a work calendar already open in the **session browser** (e.g. the Chrome
  extension that holds the candidate's logins). The headline path for "schedule around my work
  meetings": no separate sign-in, you read what's already authenticated.
- `apple_calendar` / `google_calendar` / `outlook_calendar` — a personal calendar (for users
  who keep their availability there instead).

A platform is usable only when its entry is `allowed: true` (global switch + platform switch +
that platform's consent all true). If the requested platform is not allowed, **do not open any
calendar** — fall back to the draft-only path in STEP 4 and surface the opt-in commands:

```bash
careerrat automation consent <platform> --write
careerrat automation enable calendar_read <platform> --write
careerrat automation status --json
```

**Read free/busy — read-only and opaque.** Through the session browser (Browser Automation
Contract applies: halt on login wall / 2FA / captcha / account-picker confusion):

- open the candidate's calendar across the scheduling window (the candidate set of days from
  STEP 4, plus the buffer);
- capture only the **start and end** of each busy block. **Never read, infer, or store meeting
  titles, attendees, locations, notes, or descriptions** — that is the Privacy Invariant. Every
  block is opaque; an all-day block is `allDay: true`.

**Persist as opaque busy blocks.** Append to `workspace/tracker.json#calendarBusy[]`
(schema: `id`, `provider`, `startIso`, `endIso`, `allDay`, `label` — default `"Busy"`,
`source`, `ingestedAt`). Dedupe on normalized `provider + startIso + endIso`. The `label` stays
`"Busy"`; never substitute the real meeting subject. These are a **snapshot, not a live feed** —
note when it was taken, and re-ingest before relying on it for a fresh decision.

- **DB workspace:** write via the owning verb, never by hand-editing generated
  `tracker.json`:

  ```bash
  careerrat data calendar busy --data '<JSON array of opaque blocks>' --source calendar_read
  ```

  The verb stores `calendarBusy[]` as top-level tracker state, dedupes on
  `provider + startIso + endIso`, forces `label: "Busy"`, stamps
  `ingestedAt`, bumps meta, logs one activity event, and exports the generated
  legacy files.
- **Legacy workspace (no DB):** after writing, validate + snapshot (`careerrat tracker --verify`
  then `careerrat tracker`); the Calendar then shows the windows as muted "Busy" blocks alongside
  actionable events.

---

## STEP 4 — Resolve slots + avoid double-booking

Build the candidate set of proposed (or accepted) slots from STEP 2 + STEP 3, honoring
`working_hours`, `preferred_days`, `buffer_minutes`, and `blackout`.

**Double-booking check — depends on calendar context:**

- **If `calendarBusy[]` (or a user-provided free/busy export) is available** (from STEP 3b):
  **exclude any slot that overlaps a busy block** or violates the buffer around one. Use the
  most recent ingest; if the snapshot is stale, re-ingest or say so. Never assume a connector
  exists — check first.
- **If no calendar context is available**: this is the **draft-only** path. You cannot verify
  conflicts, so do not assert hard availability. Either (a) propose the candidate's
  preference-backed windows and state plainly in the reply that they're subject to final
  confirmation, or (b) list the slots back to the user and ask them to confirm against their
  own calendar before the reply is sent. Tell the user the skill could not check their
  calendar — no silent assumption of freedom.

For `accept-slot`: pick the best offered slot under the same rules; if none work, propose
alternatives instead of forcing a bad fit.

---

## STEP 5 — Draft the reply (timezone clarity is mandatory)

Apply the `candidate/writing-style.md` register (run `npm run calibrate:style` first if
`writing-style.md` is absent or older than newer `workspace/writing-samples/`). Mirror the
thread's tone.

**Timezone clarity (hard).** Every time you state carries an explicit timezone label, and
when the counterpart's timezone is known, state **both** — e.g. "Thursday, June 19 at 2:00 PM
ET (11:00 AM PT)". Never an unlabeled time. Spell out the date (day + date), not just "Thu
2pm". State the meeting length and channel (phone / video link / onsite) when known; don't
confirm logistics that haven't been established.

**Complete artifact, real names, no placeholders.** Subject + body, ready to send. Sign with
the candidate's real name (`profile.yml#candidate.preferred_name` → `full_name`). Address the
recipient by their real name from the thread; if unknown, a natural greeting ("Hi,"). Never
emit a bracket token (`[Name]`, `[Time]`, `[Company]`) — brackets are a build failure, not a
TODO. For `send-scheduling-link`, share `availability.scheduling_link` with a one-line
invitation; do not also trade slots.

If saved to a file, run `node src/cli/lint-placeholders.mjs <draft-path>` before presenting.

Present the draft and the chosen slot(s) to the user and **wait for explicit approval before
anything is sent or written to a calendar.**

---

## STEP 6 — Prepare a calendar-ready hold (optional, confirm-first)

When a slot is settled (or proposed for the candidate's own hold), prepare a calendar-ready
hold so it lands cleanly:

- **Always-available, dependency-free:** write a valid `.ics` (VEVENT) to the
  company's Downloads folder — `~/Downloads/careerrat/<Company>/<Company> - <Round> Invite.ics`
  (per the Artifact Contract: organized by company, then by round; real company
  name, no brackets) — `UID`, `DTSTART`/`DTEND`
  with the correct timezone (or UTC `Z`), `SUMMARY` (e.g. "<Company> — <stage> with <who>"),
  `DESCRIPTION` (channel + dial-in/link if known), and a `VALARM` reminder. The user
  double-clicks it to add the hold. This is the degrade-gracefully default and needs no
  connector.
- **If a calendar connector / session is available and the user approves:** you may
  additionally create the hold on their calendar. Writing to an external calendar is a
  confirm-first action — show what you'll create and wait for an explicit yes. Never create,
  move, or delete a calendar event silently.

Keep `.ics` content local (`~/Downloads/careerrat/` or `workspace/`). Never put
`current_base` or any private comp field in a hold.

---

## STEP 7 — Capture scheduling state to the tracker

Execute in order:

**(a) Append the reply to `communications[].messages[]`** (same shape as `email-comms` STEP
6a): `id`, `direction` (`outbound-draft` until sent, then `outbound-sent`), `at`, `from`,
`to`, `subject`, `summary`, `artifactPath`.

**Sent-clears-draft (hard).** In the same write as flipping `direction` to `outbound-sent`:
set `comm.draft = null` (and `app.followUp.draft = null` if the reply was backed by one).
A partial write — messages[] updated but draft still set — leaves the "Ready to send" CTA
live after the reply has gone out.

- **DB workspace:** `careerrat data comm append-message <comm-id> --data '<message JSON above>'`
  appends the message and auto-rolls `lastInboundAt`/`lastOutboundAt` from `direction`. If this
  call flips `direction` to `outbound-sent` and the status is advancing to `waiting`, follow with
  `careerrat data comm mark-sent <comm-id> [--at <iso>]` — it clears `comm.draft` (and
  `app.followUp.draft` when linked) automatically in the same transaction; do not hand-write that
  clear. For any other status target, use the read-patch-persist pattern in (b) below instead.
- **Legacy workspace (no DB):** append to `communications[].messages[]` directly in
  `workspace/tracker.json`.

**(b) Update the parent `communications[]` record** in that same write:

- `status`: `scheduled` once a slot is agreed; `waiting` while awaiting their pick/confirm;
  `needs-reply` if the ball is back with the candidate.
- `nextActionDue`: **null it first** (the scheduling reply IS the expected event — it has
  occurred), then set a fresh value for the next expected event (e.g. +3 days for their
  confirmation, or ahead of the meeting for a pre-meeting reminder). Pattern: null → new value
  in one write. Never overwrite a live `nextActionDue` without nulling it first.
- `nextAction`: rewrite to reflect the new pending item, or clear it if none.
- `lastOutboundAt` / `lastInboundAt`.

- **DB workspace:** there is no single-field patch verb for `communications[]` beyond
  `mark-sent`'s narrow send case (used in (a) above). For `status: scheduled`/`needs-reply`, or
  to set `nextActionDue`/`nextAction` explicitly, read the current row from
  `workspace/tracker.json#communications[]`, apply the fields above (carrying every other field
  over unchanged), and persist the whole row: `careerrat data comm upsert --data '<patched full
  comm row JSON>'`.
- **Legacy workspace (no DB):** edit the fields above directly on the communications record, in
  the same write as (a).

**(c) When a meeting is BOOKED** — do ALL of the following in the SAME write as (a) and (b):

**(c-i)** Add the `applications[].conversations[]` entry so it shows on the application
timeline and feeds `interview-prep`:

```json
{
  "date": "<ISO-8601 meeting datetime>",
  "kind": "<recruiter screen | technical | hiring manager | onsite | ...>",
  "who": "<interviewer / recruiter name>",
  "notes": "<length, channel, timezone-confirmed slot, any prep notes>"
}
```

Round `kind` values follow the canonical Round Vocabulary in AGENTS.md (never numbered); logistics/booking touchpoints (`interview scheduling`, `recruiter call`) are not rounds and keep their existing kinds.

**(c-ii) Advance `applications[].status`** to the matching stage (`recruiter screen`, `technical`,
`onsite`, etc.) in that same write. Do not defer this to STEP 8 — splitting the comm write and
the app write across steps leaves the app row at its old status with a ghost CTA. Both records
must land in one `tracker.json` write.

**(c-iii) Write the structured interview datetime fields** on the `applications[]` row — in the
SAME write as (c-i) and (c-ii). These fields drive the Focus card on the dashboard; without
them the booked interview never surfaces there.

- **First round being booked** → set `interviewAt` to the ISO 8601 datetime string (e.g.
  `"2026-06-23T12:00:00-04:00"`). Do not use the deprecated `interviewDate`.
- **Subsequent / follow-on round** → set `nextInterviewAt` instead (it supersedes `interviewAt`
  on the dashboard). Do not use the deprecated `nextInterviewDate`.
- **Both cases** → also set `interviewNote` to a ≤60-char logistics string:
  `"<Round> — <Weekday> <DD-MM> <HH:MM> <TZ> with <First Name>"`
  Example: `"Onsite loop — Tue 03-10 14:00 PT with Alex Rivera"`

If you don't know whether this is the first or a follow-on round, check `conversations[]` —
if a prior entry exists with a `kind` matching an interview stage, use `nextInterviewAt`; if
none, use `interviewAt`.

**DB workspace — (c-i)/(c-ii)/(c-iii) composition.** No single verb covers all three, so
compose, back-to-back in the same turn as (a)/(b):

1. ```
   careerrat data app schedule-interview <id> --at <iso> --round "<kind>" --note "<interviewNote text>"
   ```

   In one transaction this sets `interviewAt` (or `nextInterviewAt`, auto-detected from whether
   a future `interviewAt` already exists — same "first round vs. follow-on" rule above), sets
   `interviewNote`, and appends a `conversations[]` entry `{date: at, kind: round, notes: note}` —
   covering the bulk of (c-i) and all of (c-iii). It does not set `who` and reuses the same
   `--note` text for both `interviewNote` (the ≤60-char logistics string) and the conversations
   entry's `notes` (which wants the richer "length, channel, timezone-confirmed slot, prep
   notes" text) — those two fields want different content, so this verb doesn't map 1:1.
2. Patch the `who` field (and, if needed, a fuller `notes` string) onto the conversations entry
   `schedule-interview` just appended: read the current row's `conversations[]`, update that one
   entry, then persist the whole array (wholesale array replace, same pattern as
   `track-outcomes`' STEP 2 routing table): `careerrat data app set-fields <id> --data
   '{"conversations":[...]}'`.

3. ```
   careerrat data app set-status <id> "<stage>"
   ```

   Advances `applications[].status` to the matching stage (`recruiter screen`, `technical`,
   `onsite`, etc.) — outcome-changing, refreshes analytics, and (since entering, not leaving, the
   interview band) never triggers the round-completion clearing.

**Legacy workspace (no DB) — (c-i)/(c-ii)/(c-iii):** add the `conversations[]` entry, advance
`applications[].status`, and write the interview datetime fields exactly as described above, all
in the SAME `tracker.json` write as (a) and (b).

**(d) Validate + snapshot:**

- **DB workspace:** the calls in (a)–(c) already persisted and auto-exported. Run
  `careerrat data verify` (re-exports + domain integrity) and `careerrat tracker --verify`
  (schema-level parity).
- **Legacy workspace (no DB):** `careerrat tracker --verify` (must exit clean), then
  `careerrat tracker`.

**(e) Out-of-band completion.** If the user reports "I already confirmed / scheduled /
rescheduled this" without the agent having sent the reply: record it immediately in the same
single write — do not leave the CTA live because the agent did not perform the action.

- Append a `messages[]` entry: `direction: note`, `summary` describing the user-reported
    completion (e.g. "User confirmed slot out-of-band: Thu Jun 26 2pm ET").
- If a meeting was booked out-of-band, add the `conversations[]` entry (c-i) and advance
    `applications[].status` (c-ii) in the same write.
- Set `comm.draft = null`; null `nextActionDue`, then set a fresh value if the next event
    is known; advance `comm.status` to `scheduled` / `waiting` as appropriate.
- Run verify + snapshot (STEP 7d).
- **DB workspace:** `careerrat data comm append-message <comm-id> --data '{"direction":"note","at":"<ISO>","summary":"<user-reported completion>"}'`, then the same (c) composition above if a meeting was booked, then read-patch-persist `careerrat data comm upsert --data '<patched full comm row JSON>'` for `draft`/`nextActionDue`/`status`, then STEP 7(d)'s DB verify.
- **Legacy workspace (no DB):** apply the bullets above directly in `workspace/tracker.json`, then run STEP 7(d)'s legacy verify.

**(f) Log to the Activity Pulse feed** (see **Activity Pulse** in AGENTS.md). The reply is a
draft awaiting send → log it as needing the user:

- **DB workspace:** the (a)/(c) calls above already auto-logged their own generic events. For
  the richer, scheduling-specific type, log an additional event:

  ```
  careerrat data activity append --data '{"type":"drafted","actor":"agent","needsUser":true,"title":"Scheduling reply — <Company>","summary":"<one line: proposed/confirmed slot>","refs":{"applicationId":"<application id>","company":"<Company>"},"cta":{"label":"Review & send"}}'
  ```

- **Legacy workspace (no DB):**

  ```
  careerrat activity append --type drafted --actor agent --needs-user \
    --title "Scheduling reply — <Company>" \
    --summary "<one line: proposed/confirmed slot>" \
    --company "<Company>" --app-id <application id> --cta-label "Review & send" --write
  ```

---

## STEP 8 — Outcome routing

| Condition | Action | DB-mode command |
|---|---|---|
| Meeting booked / confirmed | `applications[].status` + `conversations[]` entry are already written in STEP 7(c). Hand off to `interview-prep` for prep materials using that conversations[] entry as the anchor. No additional write needed here. | Already covered by STEP 7(c)'s DB composition — no additional call. |
| Reschedule agreed | In ONE write: (1) update the existing `conversations[]` entry's `date` + `notes`; (2) update `interviewAt` or `nextInterviewAt` (whichever is set) to the new ISO datetime, and update `interviewNote` to match; (3) append a `messages[]` entry (`direction: note`, summary: "Meeting rescheduled to <new ISO datetime>") so the reschedule is in history; (4) set `comm.nextActionDue = null`, then set a fresh value keyed to the rescheduled slot; (5) run verify + snapshot. Without updating the datetime fields the dashboard Focus card still shows the old time. | `careerrat data app schedule-interview <id> --at <new-iso> --round "<kind>" --note "<updated interviewNote>"` re-books onto the same field (`interviewAt`/`nextInterviewAt`, auto-detected) and appends a fresh `conversations[]` entry rather than editing the old one in place — follow with `careerrat data app set-fields <id> --data '{"conversations":[...]}'` to patch the existing entry's `date`/`notes` in place instead, if that's the desired shape (wholesale array replace). Then `careerrat data comm append-message <comm-id> --data '{"direction":"note","at":"<ISO>","summary":"Meeting rescheduled to <new ISO datetime>"}'`, then read-patch-persist `careerrat data comm upsert --data '<patched full comm row JSON>'` for `nextActionDue`. Then STEP 7(d)'s DB verify. |
| They go quiet after your proposal | Leave `status: waiting`; STEP 7b's `nextActionDue` surfaces it as a follow-up (handled by `email-comms` / the follow-up timer). | No write here — this is a read/no-op branch. |
| Thread turns to comp / general reply | Hand off to `email-comms` (general comms / negotiation surface). | No write here — hand-off only. |
| User states a new availability rule mid-thread ("no Fridays", "never before 10") | Confirm-first, then persist to candidate profile config `availability` (STEP 3 write-back). | DB mode: `careerrat data candidate patch profile --data ...`; legacy mode: guarded candidate-config write path. Never hand-edit YAML in DB mode. |

---

## RULES

- **Confirm-first on every outbound + every calendar write.** Drafting and `.ics` preparation
  are safe; **sending the reply** and **creating/moving/deleting an external calendar event**
  each require an explicit user yes. Never send or mutate a calendar silently.
- **Never invent availability.** Only propose windows backed by the candidate's stated
  preferences or an explicit confirmation. If real availability is unknown, ask. (Same honesty
  line as `email-comms`.)
- **Timezone clarity is mandatory.** Every stated time is labeled with its timezone; give both
  the candidate's and the counterpart's when known. No unlabeled times, no bare "2pm".
- **Avoid double-booking when you can verify it.** With calendar context, exclude conflicts +
  honor the buffer. Without it, say so and fall back to draft-only — never assume the candidate
  is free.
- **Free/busy reads are gated + opaque.** Reading a real calendar runs only under
  `calendar_read` for an allowed platform (STEP 3b). Store start/end only — never a meeting
  title, attendee, location, or note. `calendarBusy[]` is a privacy-safe snapshot, not a live
  sync; reading is read-only and never writes to the source calendar.
- **Degrade gracefully.** No calendar connector → draft-only + an `.ics` hold the user imports
  by hand. The skill is fully usable with zero calendar integration.
- **Tool-agnostic.** Say "a calendar connector / session," "the session browser." Never name a
  vendor tool or MCP namespace. Calendar reads/writes through the session browser follow the
  Browser Automation Contract (halt on auth challenges).
- **`track-outcomes` owns status transitions; `interview-prep` owns prep.** This skill writes
  scheduling state and the conversations[] entry, then hands the stage change + prep off — it
  does not own interview outcomes.
- **Privacy + local-only.** No `current_base` or private comp in any reply, hold, or note.
  `.ics` and raw thread bodies stay under `~/Downloads/careerrat/` / `workspace/`.
- **No placeholder brackets.** Unknown detail → generic or omit; never a bracket token.
- **Domain-neutral.** No hardcoded companies, names, or times. The candidate's
  `availability` block + the thread make it specific; absent config stays neutral (derive +
  ask).

---

## HONESTY

> See **Negotiation Contract › Honesty Firewall (hard)** in AGENTS.md. In this skill: never invent availability, a meeting time the candidate hasn't agreed to, or a calendar state you haven't verified — ask rather than fabricate.
