# Phase 2: Bounded AI Foundation - Discussion Log

> **Audit trail only.** Do not use as input to planning, research, or execution agents.
> Decisions are captured in CONTEXT.md - this log preserves the alternatives considered.

**Date:** 2026-07-04
**Phase:** 02-bounded-ai-foundation
**Areas discussed:** Invocation wrapper, Response/error shape, Telemetry and cost labels, Native structured outputs

---

## Invocation Wrapper

| Option | Description | Selected |
|--------|-------------|----------|
| Single bounded-AI helper/route contract | Centralize invocation, schema validation, retry, telemetry labels, and degraded responses around existing AI primitives. | yes |
| Route-local tightening | Improve each bounded route individually without creating a shared contract. | |

**User's choice:** "the correct arch"
**Notes:** Phase 2 should build the common architecture rather than leave each route to duplicate the pattern.

---

## Response/Error Shape

| Option | Description | Selected |
|--------|-------------|----------|
| Shared response envelope | Use one app-renderable shape for success, schema failure, no-AI/manual fallback, and provider failure. | yes |
| Route-local response shapes | Preserve current route-local differences and document them. | |

**User's choice:** "the correct arch"
**Notes:** The shared envelope should preserve current behavior such as 422 for invalid structured output and 501 for no configured AI route, but expose stable machine-readable fields.

---

## Telemetry and Cost Labels

| Option | Description | Selected |
|--------|-------------|----------|
| Strict labels | Require stable skill/action labels and route operation names for every bounded AI call. | yes |
| Best-effort labels | Preserve labels when convenient, tolerate missing fields. | |
| Defer details | Leave telemetry strictness to later phases. | |

**User's choice:** "not sure"
**Notes:** The agent chose strict labels under delegated discretion because Phase 3 will need per-feature cost accounting and no-AI regression tests. Usage telemetry must remain metadata-only and must not store prompts, JDs, resumes, candidate facts, or raw outputs.

---

## Native Structured Outputs

| Option | Description | Selected |
|--------|-------------|----------|
| Adopt native structured outputs now | Use provider-native schema-constrained output where supported. | yes |
| Keep fenced JSON only | Continue the current prompt/extract/validate/retry pattern and defer native support. | |
| Hybrid abstraction | Use native output when available, with existing validation and retry/fallback behavior behind a wrapper. | yes |

**User's choice:** "switch to it now no?"
**Notes:** Adopt native structured outputs now, but not as the sole trust boundary. CareerRat still validates deterministically after the model response and keeps the existing compatibility fallback for provider gaps.

## the agent's Discretion

- The agent chose strict metadata-only telemetry labels for area 3.
- The agent may choose exact module and field names during Phase 2 planning, provided the wrapper contract remains stable and provider-specific details stay hidden behind CareerRat-owned APIs.

## Deferred Ideas

- Company discovery seed schema and board cache implementation move to Phase 3.
- Prompt caching is a later optimization, not a blocker for Phase 2.
- Browser-authenticated automation remains v2.
