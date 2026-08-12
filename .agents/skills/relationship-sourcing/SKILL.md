---
name: relationship-sourcing
description: Find likely recruiters, hiring-team members, or warm contacts for tracked companies through the session browser, then capture candidate-reviewed leads into Network. Opt-in, user-initiated, local-only. Capability = relationship_sourcing; platforms = linkedin, wellfound.
tier_1_inputs: [consent verdict, sourcing-target applications, platform scope]
tier_2_inputs: [per-platform/per-target browser search results]
---

# relationship-sourcing

Use this skill when the user asks to find a recruiter, hiring manager, employee,
warm path, referral path, or relationship contact for a tracked company or job.

This is not a Jobs priority shortcut. A submitted application with no contact path
stays waiting/monitoring until a lead is found, reviewed, and approved by the
candidate. This skill only creates lead candidates for review; outreach drafts go
through `email-comms` or `ingest-messages` and sending remains confirm-first.

> **Runs under AGENTS.md.** These contracts bind without being restated here: Privacy Invariant (`current_base` never outbound), Honesty Firewall, Placeholder/Bracket Ban, Gate Write-back, Domain-Neutral Rule, Browser Automation Contract, Activity Pulse logging, Tracker verify+re-render, and Sent-Clears-Draft. Inline reminders at point-of-use are intentional; standalone restatements point back to the relevant AGENTS.md section.

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

Append review leads to `workspace/tracker.json#relationshipLeads[]`. Avoid duplicate
lead records by normalized `company + name + platform`.

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
