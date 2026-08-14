# Phase 8: Deep Ingest Lane - Discussion Log

> **Audit trail only.** Do not use as input to planning, research, or execution agents.
> Decisions are captured in CONTEXT.md — this log preserves the alternatives considered.

**Date:** 2026-07-05T20:18:48Z
**Phase:** 8-Deep Ingest Lane
**Areas discussed:** Deep ingest source of truth, drop-all review flow, AI interview shape, deep ingest completion, repo/project handling

---

## Deep Ingest Source of Truth

| Option | Description | Selected |
|--------|-------------|----------|
| New DB-shaped structure | Build Phase 8 as fresh SQLite-native app state. | ✓ |
| Migrate existing candidate files | Preserve and migrate candidate file structures into the new flow. | |
| Keep compatibility surfaces | Keep old ingest/profile compatibility as a product requirement. | |

**User's choice:** "We don't need to worry about migration or compat; this is a new structure."
**Notes:** Context locks the product target as a new DB-backed deep ingest structure. Compatibility files may continue to exist outside Phase 8's product acceptance criteria.

---

## Drop-All Review Flow

| Option | Description | Selected |
|--------|-------------|----------|
| Inbox proposal queue | Route every captured item through generic Inbox review. | |
| Dedicated deep-ingest workspace | Build one central review area for all deep-ingest proposals. | |
| Context-specific review | Review the item according to where it was dropped and the target shape the user selected. | ✓ |

**User's choice:** If material is dropped as part of evidence intake, review it as evidence. If it is added later in the evidence/library area, provide an add/drop control where the user chooses the target shape, pastes or links material, then clicks ingest.
**Notes:** The final UI can reuse the generic capture/inbox where useful, but type-specific review should win when the user's context is clear.

---

## AI Interview Shape

| Option | Description | Selected |
|--------|-------------|----------|
| Guided app-native interview | Build a structured interview sequence in React. | |
| Visible chat panel | Use a chat-style panel for the interview. | |
| Defer AI interview | Keep Phase 8 to bounded extraction/proposals and defer full interview. | ✓ |

**User's choice:** "AI interview can be v2 deferred."
**Notes:** Bounded AI extraction remains in scope. A full role/job-aware interview lane is deferred.

---

## Deep Ingest Completion

| Option | Description | Selected |
|--------|-------------|----------|
| Checklist terminal states | Each required lane is done when completed, marked not available, or deferred as a visible todo. | ✓ |
| Minimum thresholds | Done means hitting counts such as N evidence claims and M stories. | |
| Always open lane | Show progress, but never mark deep ingest complete. | |

**User's choice:** "Deep ingest should be whatever the full flow is. The user may not have everything... They are done when they complete whatever the stuff is." User then selected option 1.
**Notes:** The planner should define the full lane checklist from ING-01 through ING-04, then persist terminal state per lane.

---

## Repo/Project Handling

| Option | Description | Selected |
|--------|-------------|----------|
| Store as context only | Save links/paths and ask the user later. | |
| Best-effort scan and extraction | Try to fetch/read/scan within bounded limits, then surface gaps. | ✓ |
| Full repository ingestion | Clone/read all repository contents regardless of size or access limits. | |

**User's choice:** "Ingest what is pasted; try to scan and shit."
**Notes:** Discussion refined this into best-effort extraction with explicit gaps for private, huge, unsupported, login-gated, truncated, or unreadable sources.

---

## the agent's Discretion

- Choose exact DB schema, route names, API envelopes, UI layout, extraction schemas, file-type coverage, scanner limits, and tests.
- Define the full deep-ingest checklist from the roadmap requirements and existing product architecture.

## Deferred Ideas

- Full role/job-aware AI interview lane.
- Full unbounded repository cloning or authenticated private-source scanning.
