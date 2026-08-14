# CareerRat App Product Plan

**Created:** 2026-07-05
**Purpose:** Carry the v2 product direction into GSD planning after the v1 skill-to-API foundation.

## Product Shape

CareerRat should be an Electron/React app backed by the local SQLite database. The app is the product surface. Agents and skills remain useful for explicit tool-heavy workflows and developer/user handoffs, but app buttons should call local APIs, DB verbs, deterministic scanners, and bounded AI calls.

The user should be able to:

1. Complete quick onboarding with enough resume/profile/targeting data to start searching.
2. Have job discovery start in the background once `search_ready` is true.
3. Continue deeper profile ingest while sourcing runs.
4. Review discovered companies and jobs from DB-backed app views.
5. Generate ATS-ready resume, cover letter, and application-answer packets without auto-submitting.

## Decisions Captured

| Decision | Planning Impact |
|----------|-----------------|
| No compatibility requirement for product paths | Legacy tracker/static/generated-file surfaces should be removed from normal UX or treated as debug/export only. |
| Start searching once quick onboarding has enough info | Phase 7 needs a DB-backed background runner, run state, progress UI, and first-search trigger. |
| Public company/job-board sync-home is opt-in, on by default, and no PII | Phase 9 needs public/private table separation, scrub tests, stable IDs, provenance, and conflict/freshness metadata. |
| Deep ingest should support both drop-all intake and AI interview | Phase 8 needs durable intake, structured review/edit, role/job-aware follow-up questions, and progress state. |
| PDF is the standard packet format | Phase 10 should produce PDF by default and support DOCX or other board-required formats when upload workflows need them. |
| Auto-apply is deferred | Phase 10 focuses on packet generation, question capture, answer packets, and supervised user action. |

## Completed Foundation

- SQLite DB verbs exist for candidate, source config, discovery cache/proposals, sourced roles, applications, communications, intake, calendar, activity, and analytics.
- Electron shell and React `/app` routes exist.
- Onboarding can capture setup state and resume intake.
- Bounded AI helpers exist with schema validation, labels, no-AI degradation, and telemetry-safe envelopes.
- Supported ATS scanners exist for Ashby, Greenhouse, Lever, Workable, and SmartRecruiters.
- Company discovery has local proposal APIs, deterministic supported-ATS resolution, gating, and confirm-first writes.

## Product Gaps

- Product routes still have compatibility/static/generated tracker dependencies that should not be canonical.
- Quick onboarding does not yet start a true background sourcing run and return the user to deep ingest.
- Deep ingest is not yet a full app-native lane for drop-all assets, project links/repos, story extraction, honesty boundaries, and AI interview follow-ups.
- Public company/board intelligence is not yet separated from candidate-specific proposal, fit, comp, notes, or tracker data.
- Generic public careers pages need a deterministic extraction/scraper/API cascade before AI fallback.
- Packet generation still leans on skill-runtime paths instead of app-local evaluate/tailor/answer APIs.
- The retained skill runtime still exposes broad tools by default and needs a narrower app-safe posture.

## GSD Phase Sequence

1. **Phase 6 - Canonical DB App Shell:** Make `/app` the canonical DB-backed surface and demote compatibility exports.
2. **Phase 7 - Quick Onboarding and Auto Sourcing:** Trigger background search at `search_ready` and show durable run state.
3. **Phase 8 - Deep Ingest Lane:** Build drop-all intake plus optional role/job-aware AI interview.
4. **Phase 9 - Public Company Intelligence and Scanner Cascade:** Add no-PII public sync-home and deeper public-page discovery.
5. **Phase 10 - Local Packet Engine:** Move evaluate/tailor/answers/artifact stamping into local APIs and board-ready exports.
6. **Phase 11 - Runtime Lockdown and Desktop Release:** Narrow tool runtime, harden Electron packaging, and update product docs.

## Non-Goals

- Auto-submit applications.
- Browser automation v2 as the immediate focus.
- Hosted private candidate data.
- Treating generated tracker files as the product source of truth.
