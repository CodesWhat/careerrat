# Phase 1: Decomposition Map - Discussion Log

**Gathered:** 2026-07-04
**Status:** Context captured

## Areas Discussed

### Sourcing Strategy

**Question:** Should v1 avoid brittle scraping and use job provider APIs first?

**User direction:** No. V1 should figure out the practical sourcing mix. Scraping is acceptable for public jobs because postings disappear, and the priority is to capture them while reachable.

**Captured decision:** Compare direct ATS scanning, local/free scraping, free-tier job APIs, Firecrawl-style crawling, AI search/extract, and full skill runtime as separate lanes in a cost/reliability cascade.

### Cost Model

**Question:** Is AI web search likely more expensive than job APIs or local scanning?

**User direction:** Treat AI search as more expensive and avoid using it for routine discovery when deterministic paths work.

**Captured decision:** AI should seed, rank, judge, or fill gaps. It should not repeatedly scan or resolve known company boards.

### Company Board Cache

**Question:** Can CareerRat discover a company job board once and save it?

**User direction:** Yes. The tool should cache the job board and avoid resolving the same company repeatedly.

**Captured decision:** Add a durable resolver cache concept in front of the existing tracked-company scanner config. Revalidate on failure, stale TTL, redirects, repeated zero-job scans, or explicit refresh.

### Scraping Posture

**Question:** Are copyright/usual scraping concerns the main blocker?

**User direction:** No. Jobs disappear, and CareerRat should prioritize durable capture of public postings.

**Captured decision:** Phase 1 should optimize for practical sourcing, reliability, cost, and JD capture. Legal/licensing metadata can be recorded where relevant, but should not block the architecture spike by default.

## Options Considered

- Job API first only: rejected as too narrow.
- Avoid brittle scraping: rejected as too restrictive for v1 learning.
- Local/free deterministic extraction plus cache: accepted as the primary direction.
- External APIs/tools as measured fallbacks: accepted.
- Browser-authenticated automation in v1: deferred to v2.

## Deferred

- Authenticated browser sources and logged-in portals.
- Committing to a paid job provider.
- Auto-submitting applications.

---

*Discussion log for `.planning/phases/01-decomposition-map/01-CONTEXT.md`.*
