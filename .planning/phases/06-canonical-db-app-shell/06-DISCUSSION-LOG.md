# Phase 6: Canonical DB App Shell - Discussion Log

> **Audit trail only.** Do not use as input to planning, research, or execution agents.
> Decisions are captured in CONTEXT.md — this log preserves the alternatives considered.

**Date:** 2026-07-05T14:21:23.139Z
**Phase:** 6-Canonical DB App Shell
**Areas discussed:** Product route retirement, DB-first read boundaries, Source setup and scanner context, Regression guard shape

---

## Product Route Retirement

| Option | Description | Selected |
|--------|-------------|----------|
| Keep legacy routes in product nav | Preserve `/tracker`/legacy pages as user-visible compatibility paths. | |
| Hide as debug/export only | Keep only where needed for developer/export workflows. | |
| Remove old product affordances | Treat `/app` as the new product structure and remove old product UX. | ✓ |

**User's choice:** "Remove old bullshit this is a new app structure."
**Notes:** Legacy surfaces are not product requirements and should not be normal navigation.

---

## DB-First Read Boundaries

| Option | Description | Selected |
|--------|-------------|----------|
| Temporary tracker-file fallback | Product routes can read exported files until migration finishes. | |
| DB-only product state | Product routes require DB-derived state and fail closed when setup is missing. | ✓ |

**User's choice:** "We don't need fall back this is its own product."
**Notes:** Missing DB should be treated as setup/error state, not a reason to use tracker exports.

---

## Source Setup and Scanner Context

| Option | Description | Selected |
|--------|-------------|----------|
| Only establish read contract | Leave source setup write migration to Phase 7. | |
| Move obvious seams now | Convert app-facing board/source/scanner context routes to DB-first where appropriate. | ✓ |
| Planner decides precise split | Let the planner choose exact route/module sequence inside DB-first boundary. | ✓ |

**User's choice:** "Do what is correct."
**Notes:** The implementation details are delegated, but the target is a DB-first app-local API layer.

---

## Regression Guard Shape

| Option | Description | Selected |
|--------|-------------|----------|
| Advisory docs only | Document the boundary without test enforcement. | |
| Aggressive static guards | Fail product-route/React regressions that read tracker/activity exports. | ✓ |
| Allowlisted debug/export exceptions | Keep narrow explicit exceptions for CLI/debug/static preview tools. | ✓ |

**User's choice:** Covered by "Do what is correct" after rejecting fallback and legacy product paths.
**Notes:** Guards should make the DB-first product boundary durable.

---

## the agent's Discretion

- Exact module names, route names, migration ordering, debug/export labels, and test placement.
- How to preserve CLI/export/debug utility surfaces without keeping them in product UX.

## Deferred Ideas

None.
