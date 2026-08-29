---
name: relationship-sourcing
description: Find likely recruiters, hiring-team members, or warm contacts for tracked companies through the session browser, then capture candidate-reviewed leads into Network. Opt-in, user-initiated, local-only. Capability = relationship_sourcing; platforms = linkedin, wellfound.
metadata:
  tier_1_inputs:
    - consent verdict
    - sourcing-target applications
    - platform scope
  tier_2_inputs:
    - per-platform/per-target browser search results
---

# relationship-sourcing

Use this skill when the user asks to find a recruiter, hiring manager, employee,
warm path, referral path, or relationship contact for a tracked company or job.

This is not a Jobs priority shortcut. A submitted application with no contact path
stays waiting/monitoring until a lead is found, reviewed, and approved by the
candidate. This skill only creates lead candidates for review; outreach drafts go
through `email-comms` or `ingest-messages` and sending remains confirm-first.

> **Runs under AGENTS.md.** These contracts bind without being restated here: Privacy Invariant (`current_base` never outbound), Honesty Firewall, Placeholder/Bracket Ban, Gate Write-back, Domain-Neutral Rule, Browser Automation Contract, Activity Pulse logging, Tracker verify+snapshot, and Sent-Clears-Draft. Inline reminders at point-of-use are intentional; standalone restatements point back to the relevant AGENTS.md section.

## STEP 0 — Consent gate

Run:

```bash
careerrat automation status --json
```

Inspect `capabilities.relationship_sourcing`. Applicable platforms are `linkedin`
and `wellfound`. A platform may be used only when its entry has `allowed: true` —
the global switch, platform switch, and ToS consent must all be true.

If no requested platform is allowed, stop before opening a browser and explain the
opt-in path:

```bash
careerrat automation consent <platform> --write
careerrat automation enable relationship_sourcing --write
careerrat automation enable relationship_sourcing <platform> --write
careerrat automation status --json
```

The user must read the platform terms themselves before recording consent. Never
run this capability on a schedule or without a fresh user request.

## STEP 1 — Choose targets

Read `workspace/tracker.json` and use the Network page's sourcing targets when
possible: active applications with no recruiter, hiring-team member, referral, or
warm contact already tracked. If the user named a company or job, narrow to that
company/application.

Skip terminal rows unless the user explicitly wants historical relationship memory.
Do not treat portal-only rows as warm paths; they are search targets only.

## STEP 2 — Use the session browser

**[DELEGATE: subagent — sequential]** Per-platform/per-target sourcing drives the session
browser, so it runs **one at a time** (one-browser rule); delegation isolates each target's
context, not for parallelism. Each subagent searches its target and returns compact lead
candidates; the orchestrator captures only candidate-reviewed leads into `relationshipLeads[]`
(STEP 3–4) — subagents never write the tracker or send outreach. STEP 0 consent already
cleared on the orchestrator. See the **Delegation Contract** in AGENTS.md.

For each allowed platform, open the platform in the session browser. Prefer the
configured extension session; fall back to a persistent Playwright profile only if
that is the configured provider.

Search for specific people, not generic outreach blasts. Good query shape:

- `<Company> recruiter <role family>`
- `<Company> talent acquisition <role family>`
- `<Company> hiring manager <team or role family>`
- `<Company> engineering manager <role family>`

Before each interaction, inspect the page state. Halt on login walls, 2FA, captcha,
rate-limit warnings, or unexpected interstitials.

## STEP 3 — Capture review leads only

For each plausible person, record a compact lead:

- `company`
- `applicationId` when known
- `name`
- `type` (`Recruiter`, `Decision maker`, `Referral`, or `Contact`)
- `title`
- `platform`
- `url`
- `basis`
- `status: review`
- `foundAt`

Store long notes or screenshots under `workspace/network-leads/` when useful. Keep
the dashboard-facing `relationshipLeads[]` record short and privacy-safe.

Do not infer private emails, do not guess personal contact details, and do not add
a person as an approved warm path until the candidate approves the lead.

## STEP 4 — Write back and render

**Mode detection:** run `careerrat data status`. Exit 0 → DB workspace — use the
`careerrat data <verb>` command below (Data Write Contract, AGENTS.md). Nonzero
exit → legacy workspace (no DB yet) — use the direct `tracker.json` write path
below.

Append review leads to `relationshipLeads[]`. Avoid duplicate lead records by
normalized `company + name + platform`.

**DB workspace:**

```bash
careerrat data relationship leads upsert --data '<relationship lead JSON array>'
careerrat data verify
careerrat tracker --verify
```

`relationship leads upsert` persists `relationshipLeads[]`, dedupes by
normalized `company + name + platform`, clears sourcing-related CTAs on linked
jobs in the same transaction, writes Activity Pulse, and exports
`workspace/tracker.json` + `workspace/activity.jsonl`. Run `careerrat tracker`
afterward only when a recovery snapshot is useful.

**Legacy workspace (no DB):** append review leads to
`workspace/tracker.json#relationshipLeads[]` directly.

**CTA clear-down (same write):** For each target job row, inspect `jobs[id].nextAction`
and `jobs[id].followUp` for any sourcing-related pending CTA (e.g. "find recruiter
contact", "source warm path"). If one is found, include these field updates in the
**same** `tracker.json` write as the `relationshipLeads[]` append — never as a
separate write:

- `jobs[id].nextAction` → `'Review relationship leads — approve or reject in Network tab'`
- `jobs[id].nextActionDue` → `null` (ball is in candidate's court; no deadline until outreach is decided)

Partial writes leave ghost CTAs. One write, both mutations.

Then run:

```bash
careerrat tracker --verify
npm run verify:tracker
careerrat activity append --type system --title "Relationship leads found" --summary "Review leads captured for candidate approval." --tag relationship --needs-user --write
careerrat tracker
```

Add concrete `--company`, `--role`, or `--app-id` refs when the leads map cleanly
to one tracker row.

The Network dashboard will show pending leads in **Lead review**. Approved leads
become Network contacts; rejected leads stay out of the warm-path map.

## STEP 5 — Approval and outreach

**DB workspace:**

When the candidate approves a lead:

```bash
careerrat data relationship lead set-status <lead-id> approved --at <ISO timestamp> --follow-up-due <ISO date>
careerrat data verify
careerrat tracker --verify
```

`relationship lead set-status` sets `relationshipLeads[n].status = "approved"`,
records `approvedAt`, updates the linked job row to
`nextAction: "Send outreach to <Name> via email-comms"`, sets `nextActionDue`,
appends the internal conversation note, logs Activity Pulse, and exports
tracker files in one transaction.

When the candidate rejects a lead:

```bash
careerrat data relationship lead set-status <lead-id> rejected --at <ISO timestamp> --note "<brief reason>"
careerrat data verify
careerrat tracker --verify
```

The same verb records `rejectedAt`, appends the internal note, and if no other
`review` or `approved` leads remain for that target job, restates
`nextAction: "Re-run relationship-sourcing for <Company>"` with
`nextActionDue: null` in the same transaction. Run `careerrat tracker` afterward
only when a recovery snapshot is useful.

**Legacy workspace (no DB):**

**When the candidate approves a lead**, perform a single `workspace/tracker.json`
write that covers all three mutations together:

1. `relationshipLeads[n].status` → `'approved'`; `relationshipLeads[n].approvedAt` → ISO timestamp.
2. On the linked job row: `jobs[id].nextAction` → `'Send outreach to <Name> via email-comms'`;
   `jobs[id].nextActionDue` → today + 3 days (ISO date).
3. Append to `jobs[id].conversations[]` (or `jobs[id].activityEvents[]` if no comm
   record exists):

   ```json
   { "type": "note", "direction": "internal",
     "summary": "Relationship lead approved: <Name> (<title>, <platform>). Outreach queued to email-comms.",
     "timestamp": "<ISO>" }
   ```

Bump `meta.lastUpdatedAt` to the current ISO timestamp in the same write (per the AGENTS.md Tracker Write Contract).

Then run:

```bash
careerrat tracker --verify
npm run verify:tracker
careerrat activity append --type outreach --actor agent \
  --title "Relationship lead approved: <Name>" \
  --summary "Lead approved; outreach to <Name> (<title>, <platform>) queued to email-comms." --write
careerrat tracker
```

Only after the write can this contact be treated as a warm path.

**When the candidate rejects a lead**, write in a single pass:

1. `relationshipLeads[n].status` → `'rejected'`; append the same note shape with a
   brief reason.
2. If no other `review` or `approved` leads remain for that target job: restate
   `jobs[id].nextAction` → `'Re-run relationship-sourcing for <Company>'` so the CTA
   stays visible rather than silently disappearing.

Bump `meta.lastUpdatedAt` to the current ISO timestamp in the same write (per the AGENTS.md Tracker Write Contract).

Then run:

```bash
careerrat tracker --verify
npm run verify:tracker
careerrat activity append --type system --actor agent \
  --title "Relationship lead declined: <Name>" \
  --summary "Lead rejected; brief reason noted on lead record." --write
careerrat tracker
```

If outreach is needed, hand the approved contact and context to `email-comms` for a
draft. Never send automatically.

---

## In-app and terminal paths

CareerRat's in-app path searches LinkedIn and Wellfound through its owned
browser workflow after the platform-specific `relationship_sourcing` permission
passes. Results are saved as review-only leads in Network; the app never sends a
message, connection request, or outreach. A terminal or external-agent run still
follows STEP 0 → 5 exactly as written.

- **Recording a contact the candidate found** (`relationship.record-lead`).
  Self-reports like "I found a recruiter at Acme on LinkedIn, named Jordan
  Lee" or "add Casey Wu as a hiring manager at Globex" offer a "Record the
  contact you found" chip. No consent gate applies: the candidate did the
  finding, so there is nothing for CareerRat to be permitted to do. The lead
  lands in `relationshipLeads[]` with `status: review` through the same
  upsert verb (same dedupe, same CTA clearing) and is approved or rejected in
  the Network tab like any sourced lead. The company links to a tracked
  application when one matches; an untracked company still records, just
  without the link. Notes and titles are checked for the candidate's private
  current pay figure and refused if it appears.
- **Requesting a sourcing run** (`relationship.source-request`). Requests like
  "find a recruiter at Acme" or "who can refer me at Globex" offer a "Request
  people sourcing" chip. The handler checks `mayRun` for `relationship_sourcing`
  per platform: with every platform off it refuses and points at Settings;
  with at least one allowed it runs the native search and reports each
  platform's result. When the linked application has no pending next action,
  it writes `nextAction: "Run relationship-sourcing for <Company>"` so the
  request survives reload. That CTA deliberately uses this skill's
  sourcing vocabulary: STEP 4's lead upsert auto-clears it to the review CTA
  the moment leads land, in the same transaction. An existing next action is
  never overwritten.
- **Execution and recovery.** The app performs the allowed search when the chip
  is chosen. Login, captcha, 2FA, and permission blockers leave a durable retry
  action instead of clearing the request. Approval, rejection, and outreach
  handoff to `email-comms` are unchanged.
