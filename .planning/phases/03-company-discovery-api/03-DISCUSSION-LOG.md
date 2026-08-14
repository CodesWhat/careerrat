# Phase 3: Company Discovery API - Discussion Log

> **Audit trail only.** Do not use as input to planning, research, or execution agents.
> Decisions are captured in CONTEXT.md - this log preserves the alternatives considered.

**Date:** 2026-07-04T22:53:29Z
**Phase:** 03-company-discovery-api
**Areas discussed:** Discussion scope, API surface, seed schema, resolver cache, proposal gate, write path

---

## Discussion Scope

| Option | Description | Selected |
|--------|-------------|----------|
| All areas | Cover the seed schema, resolver cache, proposal gate, and route/write surface for a high-quality plan. |  |
| Core API only | Focus on the local API, DB cache, supported ATS promotion, and confirmation path first. |  |
| Sources first | Focus on job APIs, scrapers/crawlers, unsupported pages, and when AI search is allowed. |  |
| Modern best practices | Delegate technical API/cache/schema decisions to the agent using modern best practices. | yes |

**User's choice:** "these are all jsut use modern best practices no?"
**Notes:** Interpreted as approval to cover all Phase 3 decision areas while using modern local-first/API best practices instead of continuing an interview on purely technical choices.

---

## API Surface

| Option | Description | Selected |
|--------|-------------|----------|
| Resource-like local discovery routes | Extend `/api/discovery` with company proposal and decision resources; keep route handlers thin over core modules. | yes |
| Whole-skill app handoff | Keep launching `discover-companies` through skill chat for the app action. |  |
| New unrelated service namespace | Build a separate local service/API namespace for company discovery. |  |

**User's choice:** Agent discretion under modern best practices.
**Notes:** Existing app route patterns favor small local HTTP routes that call shared core functions. `POST /api/skill/run` remains visible as fallback, not default.

---

## Seed Schema

| Option | Description | Selected |
|--------|-------------|----------|
| Bounded AI untrusted seed schema | Use `companySeedSchema` for candidate company names/reasons/hints only; deterministic code validates URLs and writes. | yes |
| Model-generated final URLs | Let AI return careers/job board URLs as trusted write inputs. |  |
| No AI seed generation | Require only pasted/manual company lists. |  |

**User's choice:** Agent discretion under modern best practices.
**Notes:** Phase 1 already locked model output as advisory only. Phase 2 provides the bounded-AI helper and telemetry labels needed here.

---

## Resolver Cache

| Option | Description | Selected |
|--------|-------------|----------|
| DB-owned resolution cache | Store company board resolution metadata in durable DB-owned state with TTL/failure/provenance fields. | yes |
| Re-resolve every run | Do no cache and search/fetch every sweep again. |  |
| Write unsupported pages to sourced-scan | Collapse supported ATS tracked companies and unsupported public pages into one config list. |  |

**User's choice:** Agent discretion under modern best practices.
**Notes:** Prior decisions require resolving once, reusing cache, and separating supported ATS promotion from unsupported public-page cache.

---

## Proposal Gate

| Option | Description | Selected |
|--------|-------------|----------|
| Confirm-first with hard gates | Dedup/exclusion/relevance/provider/JD capture gates run before presentation; writes require user approval. | yes |
| Auto-write every high-confidence seed | Add companies directly when confidence is high. |  |
| Show raw seed list | Present AI seed output without deterministic resolution or scan proof. |  |

**User's choice:** Agent discretion under modern best practices.
**Notes:** Existing discover-companies and research-boards contracts are confirm-first. Auto-add can remain a future explicit mode, not the default.

---

## Write Path

| Option | Description | Selected |
|--------|-------------|----------|
| Existing source-config/company verbs | Approved supported ATS proposals write through `companyAtsUpsert()` and existing sourced persistence where jobs are confirmed. | yes |
| Direct tracker/config edits | Write generated tracker or compatibility config files directly from the API. |  |
| New parallel source system | Create a separate company-source store disconnected from current scanner/source config owners. |  |

**User's choice:** Agent discretion under modern best practices.
**Notes:** DB mode is canonical. Existing source-config and sourced persistence owners should be reused.

---

## the Agent's Discretion

- Exact endpoint names, module names, DB schema details, TTL values, batch size limits, and proposal identifiers.
- Whether proposal batches are stored as a dedicated DB table or another DB-owned source/discovery verb, as long as the cache and confirmation contracts are durable and testable.
- Exact status code mapping when it follows the established local route patterns and shared bounded-AI envelopes.

## Deferred Ideas

- Full frontend proposal confirmation UI.
- Browser-authenticated discovery sources.
- Generic unsupported public-page extraction as a first-class sourced-scan source.
- Paid provider or crawler vendor commitment.
