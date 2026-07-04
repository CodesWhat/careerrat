# State: Rolester Skill-to-API Runtime

## Project Reference

See: `.planning/PROJECT.md` (updated 2026-07-04)

**Core value:** Rolester must complete job-search work locally with predictable cost: deterministic code does deterministic work, and AI is reserved for judgment that actually needs a model.
**Current focus:** Phase 1 - Decomposition Map

## Current Status

- **Project initialized:** 2026-07-04
- **Current phase:** 1
- **Current phase status:** Not started
- **Next command:** `$gsd-discuss-phase 1`
- **Research mode:** Skipped during initialization; repo context and current roadmap are sufficient for the first pass.
- **Execution mode:** YOLO with coarse vertical-MVP phases.
- **Model profile:** inherit

## Working Assumptions

- GSD should operate from `/Users/sbenson/code/rolester/.planning`, not the parent `/Users/sbenson/code/.planning`.
- Formal GSD project subagents are not installed in this runtime, so initialization was performed inline.
- Existing user changes in `tests/release-safety.test.mjs` and `tmp-skill-conversion/` are not part of this GSD initialization.
- The first implementation target is `discover-companies` because the AI-vs-code boundary is clear and cost-sensitive.

## Open Questions

- What exact schema should company seed generation return?
- Should the migrated discovery API be exposed as a new `/api/discovery/companies/*` route, a `rolester data` verb, or both?
- Which current app screen should own proposal confirmation: `/search`, `/app`, or a dedicated discovery drawer?
- Should skill decomposition live in docs only, or as machine-readable metadata that routes can consume?

## Next Steps

1. Run `$gsd-discuss-phase 1`.
2. Produce the decomposition inventory and routing policy.
3. Plan Phase 1 with source-grounding against current files.

---
*State initialized: 2026-07-04*
