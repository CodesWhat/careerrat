# Phase 2: Bounded AI Foundation - Context

**Gathered:** 2026-07-04
**Status:** Ready for planning

<domain>
## Phase Boundary

Phase 2 makes bounded structured AI calls a first-class Rolester runtime primitive. It should deliver the reusable wrapper, response envelope, validation path, telemetry labels, and no-AI/manual fallback behavior needed by later app APIs. It does not implement the `discover-companies` pipeline yet, choose a job data vendor, or migrate browser-authenticated automation.

</domain>

<decisions>
## Implementation Decisions

### Invocation Wrapper
- **D-01:** Phase 2 should create a single bounded-AI helper/route contract around the existing `callAI()` and `runStructuredOneshot()` behavior. User selected this as "the correct arch."
- **D-02:** New bounded-AI routes should not directly hand-roll model invocation, parse/retry behavior, no-AI handling, and telemetry labels. Existing routes can be migrated incrementally, but the new wrapper is the default for new app primitives.
- **D-03:** The wrapper should keep bounded calls tool-less, low-turn, schema-first, and cheap. Full `POST /api/skill/run` remains reserved for tool-heavy, long-running, or human-watched workflows.

### Response and Error Shape
- **D-04:** Every bounded-AI route should return a shared JSON envelope so app surfaces can render success, manual fallback, schema failure, and provider failure consistently.
- **D-05:** Success should be a 200 response with `ok: true`, route-specific `data`, and non-sensitive AI metadata such as label, action, native-vs-fallback mode, retry flag, and model where available.
- **D-06:** Model output that never validates after retry should be a 422-style response with `ok: false`, a stable machine code such as `AI_SCHEMA_INVALID`, and `manual.available: true` when the user can continue by editing or entering data manually.
- **D-07:** Missing AI configuration should be a 501-style response with `ok: false`, a stable machine code such as `NO_AI_ROUTE`, `ai.used: false`, and manual fallback metadata. This preserves the current "no key -> assists degrade, never hard-block" behavior.
- **D-08:** Provider, proxy, SDK, timeout, or transport failures should use a stable provider-failure code and preserve manual fallback metadata when the caller has a manual path. Prompts, resumes, JDs, and raw candidate facts must not be logged.

### Telemetry and Cost Labels
- **D-09:** The user delegated telemetry strictness. Use strict labels: every bounded AI call must carry stable `skill` and `action` labels, plus a route-level operation name where practical.
- **D-10:** Missing or blank labels should be treated as a testable regression for the bounded-AI wrapper. This is the cost-control boundary for later discovery work.
- **D-11:** Usage telemetry remains metadata-only: source, labels, model, provider/upstream, token counts, cache token counts, search counts if any, and cost fields. It must not store prompts, raw model output, resumes, JDs, candidate facts, or page bodies.
- **D-12:** BYOK and managed-proxy paths should preserve comparable usage rows. Proxy metering can remain server-side, but app-visible route metadata should still expose enough information to explain whether AI was used or skipped.

### Native Structured Outputs
- **D-13:** Adopt provider-native structured outputs now where available. User asked "switch to it now no?" and the answer is yes, behind Rolester's own wrapper.
- **D-14:** Native provider enforcement is an optimization and reliability layer, not the trust boundary. Rolester must still run deterministic JSON/schema validation after the model call because provider docs still document invalid-output cases such as refusal, truncation, and schema limits.
- **D-15:** The wrapper should support a fallback mode for providers or routes that cannot use native structured output yet: prompt for JSON, extract fenced or bare JSON, validate, and retry once using the existing `runStructuredOneshot()` behavior.
- **D-16:** Native structured-output support should be hidden behind Rolester's local API contract so app routes do not encode provider-specific request bodies.

### the agent's Discretion
The agent may choose exact module names, response field names, and test fixture layout, provided the implementation preserves the decisions above and reuses existing AI routing, schema validation, and usage-log code. A likely owner is a new helper near `src/core/ai/` that route modules call instead of duplicating the one-shot pattern.

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### GSD Project Direction
- `.planning/PROJECT.md` - Project-level decision that skills become contracts while deterministic code owns deterministic work and AI owns bounded judgment.
- `.planning/REQUIREMENTS.md` - AIR-01 through AIR-04 define the Phase 2 requirement surface.
- `.planning/ROADMAP.md` - Phase 2 success criteria and later dependency on Phase 3 company discovery.
- `.planning/phases/01-decomposition-map/01-CONTEXT.md` - Prior decisions on cheapest-first sourcing, bounded AI, and retained full skill runtime.
- `.planning/architecture/skill-decomposition.yml` - Machine-readable Phase 1 decomposition inventory and decision IDs.
- `.planning/architecture/runtime-routing-policy.md` - Route selection policy for local APIs, bounded AI, chat, and full skill runtime.
- `.planning/architecture/discover-companies-target-contract.md` - Later consumer of this Phase 2 bounded-AI foundation.

### Existing Runtime Owners
- `src/core/ai/call-ai.mjs` - BYOK/proxy route selection, Anthropic Messages request path, and BYOK usage event writing.
- `src/core/ai/structured-oneshot.mjs` - Existing fenced/bare JSON extraction, schema validation, corrective retry, and structured failure return.
- `src/core/ai/usage-log.mjs` - Metadata-only usage ledger, pricing table, and cost calculation.
- `src/core/ai/skill-runtime.mjs` - Full skill runtime, SDK message mapping, BYOK usage handling, and retained `POST /api/skill/run` behavior.
- `src/cli/assist-route.mjs` - Current small bounded route with route-local prompt, tool-less SDK query, retry, 422, and 501 behavior.
- `src/cli/onboard-route.mjs` - Current resume AI route using `runStructuredOneshot()` and route-local fallback handling.
- `src/core/intake/classify.mjs` - Current deterministic-first intake classifier that skips AI when possible and degrades to manual classification when no AI route is available.

### Existing Tests
- `tests/structured-oneshot.test.mjs` - Hermetic parse, schema failure, retry, and thrown-invoke behavior tests.
- `tests/assist-route.test.mjs` - Current app-route expectations for tool-less AI, retry, 422, 501, and response shape.
- `tests/intake-classify.test.mjs` - Deterministic no-AI shortcut and degraded/manual fallback examples.
- `tests/call-ai.test.mjs` - BYOK/proxy route behavior and usage-event coverage.

### Provider References
- [Anthropic structured outputs](https://platform.claude.com/docs/en/build-with-claude/structured-outputs) - Native schema-constrained output behavior and documented invalid-output cases.
- [OpenAI structured outputs](https://developers.openai.com/api/docs/guides/structured-outputs) - Provider-native structured output reference for cross-provider wrapper shape.
- [Anthropic prompt caching](https://platform.claude.com/docs/en/build-with-claude/prompt-caching) - Optional later cost optimization; not a Phase 2 dependency.

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- `callAI()` already centralizes BYOK-first then managed-proxy routing and writes BYOK usage rows when a workspace root is supplied.
- `runStructuredOneshot()` already provides the core "invoke -> parse -> validate -> one corrective retry" loop and cleanly separates schema failure from invocation failure.
- `usage-log.mjs` already enforces metadata-only rows and computes cost from model/token fields instead of trusting callers.
- `assist-route.mjs`, `onboard-route.mjs`, and `intake/classify.mjs` prove the desired bounded-call shape exists, but it is spread across route-local implementations.

### Established Patterns
- No-AI configuration is an expected degraded state, not a crash. Current app routes use 501-style responses or manual fallback objects.
- Deterministic shortcuts should run before model calls. Intake classification already skips AI for fully resolved known-ATS URLs.
- Model output is never write-ready. It must pass JSON parsing, schema validation, and route-specific deterministic validation before downstream code uses it.
- Full skill runtime remains useful, but it is not the default implementation path for cheap app assists.

### Integration Points
- A new bounded-AI wrapper should likely live under `src/core/ai/` and be dependency-injected enough for hermetic tests.
- Route modules should provide schema, prompt builder, labels, and manual fallback metadata; the wrapper should own invocation, native/fallback structured mode, validation, retry, and response normalization.
- `callAI()` may need a provider-native structured-output request option or a lower-level request adapter while preserving existing call sites.
- Existing route tests should be updated or complemented with wrapper tests that assert labels, 501/no-AI envelope, 422/schema envelope, provider failure handling, and no prompt/body leakage into usage logs.

</code_context>

<specifics>
## Specific Ideas

- Treat "native structured output" as the primary mode, with fenced JSON validation/retry as the compatibility fallback.
- Use strict cost labels now so Phase 3 company seed generation can be measured per feature/action without retrofitting telemetry later.
- Keep prompts small before investing in prompt caching. Prompt caching can help repeated context, but Phase 2 should first make the bounded call path observable and testable.
- The first consumers to migrate or model after are `POST /api/assist/suggest`, `POST /api/onboard/resume-ai`, and intake classification.

</specifics>

<deferred>
## Deferred Ideas

- The exact `discover-companies` company seed schema belongs to Phase 3.
- Company board resolution cache, job API bakeoff, crawler lanes, and JD capture through discovery APIs belong to Phase 3.
- Browser-authenticated sources remain v2.
- Prompt caching and spend caps can be planned after labels, envelope shape, and native/fallback structured output support are stable.

</deferred>

---

*Phase: 2-Bounded AI Foundation*
*Context gathered: 2026-07-04*
