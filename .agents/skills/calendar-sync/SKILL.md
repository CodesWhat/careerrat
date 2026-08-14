---
name: calendar-sync
description: Write tracker-derived interviews, assessments, follow-ups, prep blocks, and deadlines to Apple Calendar, Google Calendar, Outlook, or approved local automation tools. Opt-in, user-initiated, confirm-first. Capability = calendar_sync; platforms = apple_calendar, google_calendar, outlook_calendar, automation_tools.
---

# calendar-sync

Use this skill when the user asks to add a tracked event to their real calendar,
sync Calendar to Apple/Google/Outlook, create a calendar hold from CareerRat, or
handoff a calendar event to local automation.

This builds on the no-auth Calendar export path already rendered in the
dashboard. The dashboard is read-only; this skill is the writer, and every real
calendar write remains confirm-first.

> **Runs under AGENTS.md.** These contracts bind without being restated here: Privacy Invariant (`current_base` never outbound), Honesty Firewall, Placeholder/Bracket Ban, Gate Write-back, Domain-Neutral Rule, Browser Automation Contract, Activity Pulse logging, Tracker verify+snapshot, and Sent-Clears-Draft. Inline reminders at point-of-use are intentional; standalone restatements point back to the relevant AGENTS.md section.

## STEP 0 — Consent gate

Run:

```bash
careerrat automation status --json
```

Inspect `capabilities.calendar_sync`. Applicable platforms:

- `apple_calendar`
- `google_calendar`
- `outlook_calendar`
- `automation_tools`

A platform may be used only when its entry has `allowed: true` — the global
switch, platform switch, and ToS/provider consent must all be true.

If the requested platform is not allowed, stop before opening a browser or
running local automation and explain the opt-in path:

```bash
careerrat automation consent <platform> --write
careerrat automation enable calendar_sync --write
careerrat automation enable calendar_sync <platform> --write
careerrat automation status --json
```

The user must read the provider/platform terms themselves before recording
consent. Never run this capability on a schedule or without a fresh user request.

## STEP 1 — Resolve the event

Read `workspace/tracker.json` and build the same dated event set the Calendar
dashboard uses. **The calendar holds only actionable, time-bound commitments the
candidate must _do_ at a moment** — never passive monitoring:

- interviews and assessments — `nextInterviewAt` / `interviewAt`, and interview/
  assessment `conversations[]`
- scheduled sends the candidate performs — a post-interview thank-you / follow-up
  with a real `followUp.dueAt`, or a communication `nextActionDue` that is a send
- prep blocks tied to an upcoming interview
- hard deadlines (application/decision/offer-response due dates)

**Exclude passive-wait items.** "Await their reply", "awaiting a scheduling
request", "waiting to hear back", "pending response" are NOT calendar events — they
belong in Next Steps / open loops. The dashboard derivation already drops these
(`isPassiveWaitAction` in `dashboard-data.js`); mirror that here and never write a
"waiting on someone else" item to a real calendar.

If the user named an event, match by company, role, title, or date. If ambiguous,
show the candidate events and ask the user to choose. Do not invent calendar
events from vague prose.

Use the existing Calendar export semantics as the source of truth for:

- title
- date/time
- all-day vs timed
- duration
- notes/details

## STEP 2 — Preview and confirm

Before writing, show the exact event preview:

- provider
- title
- date/time and timezone posture
- all-day/timed
- notes/details
- source tracker row/thread

Ask for explicit confirmation. No provider write happens without that yes.

## STEP 3 — Write through the provider path

Use the chosen platform only:

- `apple_calendar`: local Apple Calendar writer or AppleScript/Shortcuts path,
  if available and approved in this session.
- `google_calendar`: session browser or provider writer for Google Calendar.
- `outlook_calendar`: session browser or provider writer for Outlook Calendar.
- `automation_tools`: approved local script/Shortcut handoff.

Halt on login walls, 2FA, captcha, account picker confusion, missing permissions,
or unexpected provider interstitials. Do not create recurring events, invite
attendees, change reminders, or modify existing events unless the user explicitly
asked for that specific mutation.

## STEP 4 — Write back and render

**Mode detection:** run `careerrat data status`. Exit 0 → DB workspace — use the
`careerrat data <verb>` command below (Data Write Contract, AGENTS.md). Nonzero
exit → legacy workspace (no DB yet) — use the direct `tracker.json` write path
below.

After a successful confirmed provider write, persist one compact
`calendarWrites[]` record:

- `id`
- `eventId`
- `provider`
- `title`
- `status: written`
- `wroteAt`
- `eventIso`
- `summary`
- optional `artifactPath` if an `.ics` or script handoff file was created

Avoid duplicates by normalized `provider + eventId + eventIso + title`.

**DB workspace:**

```bash
careerrat data calendar write --data '<calendar write JSON>'
careerrat data verify
careerrat tracker --verify
```

`careerrat data calendar write` bumps `meta.lastUpdatedAt`/`meta.version`, writes
the Activity Pulse event, exports `workspace/tracker.json` +
`workspace/activity.jsonl`, and dedupes by normalized
`provider + eventId + eventIso + title`. Run `careerrat tracker` afterward only
when a recovery snapshot is useful.

**Legacy workspace (no DB):** append the record directly to
`workspace/tracker.json#calendarWrites[]`, then run:

```bash
careerrat tracker --verify
npm run verify:tracker
careerrat activity append --type system --title "Calendar event synced" --summary "Confirmed event written to the selected calendar provider." --tag calendar --write
careerrat tracker
```

Add concrete `--company`, `--role`, or `--app-id` refs when the synced event maps
cleanly to one tracker row.

The Calendar dashboard will show the provider readiness and recent write history.

## STEP 5 — If the write cannot complete

If provider sync is blocked, preserve the no-auth fallback:

- offer the `.ics` event/week export
- offer the prefilled Google/Outlook web link if applicable
- record no `calendarWrites[]` success row unless an actual provider write happened

Do not silently mark a write complete.
