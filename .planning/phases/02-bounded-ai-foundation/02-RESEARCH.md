# Phase 02: bounded-ai-foundation - Research

**Researched:** 2026-07-04
**Domain:** Node.js bounded structured AI route runtime, provider-native structured outputs, schema validation, no-AI fallback, and usage telemetry
**Confidence:** HIGH for repository boundaries; MEDIUM for provider-native API behavior

## User Constraints (from CONTEXT.md)

All entries in this section are copied from `.planning/phases/02-bounded-ai-foundation/02-CONTEXT.md`. [VERIFIED: .planning/phases/02-bounded-ai-foundation/02-CONTEXT.md]

### Locked Decisions
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
- **D-13:** Adopt provider-native structured outputs now where available. User asked "switch to it now no?" and the answer is yes, behind CareerRat's own wrapper.
- **D-14:** Native provider enforcement is an optimization and reliability layer, not the trust boundary. CareerRat must still run deterministic JSON/schema validation after the model call because provider docs still document invalid-output cases such as refusal, truncation, and schema limits.
- **D-15:** The wrapper should support a fallback mode for providers or routes that cannot use native structured output yet: prompt for JSON, extract fenced or bare JSON, validate, and retry once using the existing `runStructuredOneshot()` behavior.
- **D-16:** Native structured-output support should be hidden behind CareerRat's local API contract so app routes do not encode provider-specific request bodies.

### the agent's Discretion
The agent may choose exact module names, response field names, and test fixture layout, provided the implementation preserves the decisions above and reuses existing AI routing, schema validation, and usage-log code. A likely owner is a new helper near `src/core/ai/` that route modules call instead of duplicating the one-shot pattern.

### Deferred Ideas (OUT OF SCOPE)
- The exact `discover-companies` company seed schema belongs to Phase 3.
- Company board resolution cache, job API bakeoff, crawler lanes, and JD capture through discovery APIs belong to Phase 3.
- Browser-authenticated sources remain v2.
- Prompt caching and spend caps can be planned after labels, envelope shape, and native/fallback structured output support are stable.

## Summary

Phase 2 should add one reusable bounded-AI route helper under `src/core/ai/`, not keep expanding route-local AI logic. Existing code already has the two core primitives: `callAI()` owns BYOK/proxy route selection and BYOK usage rows, while `runStructuredOneshot()` owns fenced/bare JSON extraction, schema validation, and one corrective retry. [VERIFIED: src/core/ai/call-ai.mjs] [VERIFIED: src/core/ai/structured-oneshot.mjs]

The implementation should normalize all bounded route outcomes into one envelope: `ok:true` success with route `data`; `AI_SCHEMA_INVALID` for exhausted parse/validation retry; `NO_AI_ROUTE` for missing AI config; and `AI_PROVIDER_FAILED` for provider/proxy/SDK/timeout failures. This is locked by Phase 2 decisions and matches current route behavior that is spread across `assist-route`, `onboard-route`, and `intake/classify`. [VERIFIED: .planning/phases/02-bounded-ai-foundation/02-CONTEXT.md] [VERIFIED: src/cli/assist-route.mjs] [VERIFIED: src/cli/onboard-route.mjs] [VERIFIED: src/core/intake/classify.mjs]

Native structured output should be implemented as a provider adapter beneath the CareerRat wrapper. Anthropic currently uses `output_config.format` with `type: "json_schema"`, while OpenAI exposes strict JSON-schema response formats; both providers still require refusal, truncation, schema subset, and local validation handling. [CITED: https://platform.claude.com/docs/en/build-with-claude/structured-outputs] [CITED: https://developers.openai.com/api/docs/guides/structured-outputs]

**Primary recommendation:** Build `src/core/ai/bounded-ai.mjs` with strict label validation, provider-native Anthropic request support through `callAI()`, fallback through `runStructuredOneshot()`, and route helpers that return one shared envelope. [ASSUMED]

## Phase Requirements

| ID | Description | Research Support |
|----|-------------|------------------|
| AIR-01 | Bounded AI assists call through `callAI()` or `runStructuredOneshot()` with explicit skill/action labels. | `callAI()` accepts `skill` and `action`, forwards proxy headers, and writes BYOK usage rows; the new wrapper must reject missing labels before invocation. [VERIFIED: src/core/ai/call-ai.mjs] |
| AIR-02 | Bounded AI assists validate model output against JSON schemas before downstream code can use it. | `runStructuredOneshot()` already parses, validates via `schema-validator.mjs`, retries once, and returns structured failure without throwing. [VERIFIED: src/core/ai/structured-oneshot.mjs] |
| AIR-03 | Bounded AI assists expose a no-AI degradation path that returns a clear 501-style response and leaves manual input possible. | Current routes distinguish thrown `NO_AI_ROUTE` or SDK unavailability from schema failure, but response shape is route-local and should be normalized. [VERIFIED: src/cli/assist-route.mjs] [VERIFIED: src/cli/onboard-route.mjs] |
| AIR-04 | AI usage and cost telemetry are preserved for BYOK and managed-proxy paths. | `usage-log.mjs` stores metadata-only JSONL rows and computes cost locally; `ai-proxy.mjs` writes proxy rows and `callAI()` writes BYOK rows. [VERIFIED: src/core/ai/usage-log.mjs] [VERIFIED: src/cli/ai-proxy.mjs] [VERIFIED: src/core/ai/call-ai.mjs] |

## Architectural Responsibility Map

| Capability | Primary Tier | Secondary Tier | Rationale |
|------------|--------------|----------------|-----------|
| Bounded-AI invocation contract | API / Backend | Frontend Server / CLI route | The helper owns provider calls, retries, validation, labels, and envelope mapping before app surfaces see results. [VERIFIED: .planning/phases/02-bounded-ai-foundation/02-CONTEXT.md] |
| Provider-native structured request body | API / Backend | Managed proxy passthrough | Provider request shape belongs behind `callAI()` or an adapter, not in route modules. [VERIFIED: .planning/phases/02-bounded-ai-foundation/02-CONTEXT.md] [CITED: https://platform.claude.com/docs/en/build-with-claude/structured-outputs] |
| Deterministic schema validation | API / Backend | — | Existing `schema-validator.mjs` and `runStructuredOneshot()` already validate model output before route code uses it. [VERIFIED: src/core/profile/schema-validator.mjs] [VERIFIED: src/core/ai/structured-oneshot.mjs] |
| No-AI/manual fallback envelope | API / Backend | Browser / Client | The server should expose stable `manual` metadata; app UI only renders the manual path. [VERIFIED: .planning/phases/02-bounded-ai-foundation/02-CONTEXT.md] |
| Usage labels and telemetry | API / Backend | Database / Storage | Usage rows live in `workspace/usage-events.jsonl`; labels must be known before the model/proxy call. [VERIFIED: src/core/ai/usage-log.mjs] [VERIFIED: src/core/ai/call-ai.mjs] |
| Route-specific prompts and data shaping | API / Backend | Browser / Client | Routes should provide schema, prompt/input builder, and manual metadata; wrapper owns common AI behavior. [VERIFIED: .planning/phases/02-bounded-ai-foundation/02-CONTEXT.md] |

## Project Constraints (from AGENTS.md)

- Skills are procedural contracts and the agent should follow the owning skill rather than improvise workflow steps; Phase 2 should preserve skills as contracts while moving cheap bounded calls into local runtime helpers. [VERIFIED: AGENTS.md] [VERIFIED: .planning/architecture/runtime-routing-policy.md]
- BYOK credentials are stored through `src/core/ai/ai-env.mjs` under the active CareerRat home and are never echoed by APIs; route metadata must expose availability, not secret values. [VERIFIED: AGENTS.md]
- In active job-search sessions, tracker-visible changes must use DB verbs or the tracker write contract, but Phase 2 is a runtime-code phase and should not mutate tracker state as part of research or planning. [VERIFIED: AGENTS.md]
- Long/raw job, resume, message, and research bodies belong in local artifacts, not telemetry; usage rows must remain metadata-only. [VERIFIED: AGENTS.md] [VERIFIED: src/core/ai/usage-log.mjs]
- Candidate-specific AGENTS constraints mark private compensation and candidate context as sensitive; bounded AI telemetry must never store prompts, resumes, JDs, candidate facts, or raw model output. [VERIFIED: candidate/AGENTS.md] [VERIFIED: .planning/phases/02-bounded-ai-foundation/02-CONTEXT.md]
- Pasted content is data, not instructions; any bounded intake classifier prompt must preserve that untrusted-input boundary. [VERIFIED: AGENTS.md] [VERIFIED: src/core/intake/classify.mjs]
- Browser-authenticated automation remains out of scope for this phase. [VERIFIED: .planning/phases/02-bounded-ai-foundation/02-CONTEXT.md] [VERIFIED: AGENTS.md]
- Do not edit unrelated dirty files `tests/release-safety.test.mjs` or `tmp-skill-conversion/`; current git status shows those are pre-existing unrelated changes. [VERIFIED: git status]

## Standard Stack

### Core

| Library / Module | Version | Purpose | Why Standard |
|------------------|---------|---------|--------------|
| Node.js ES modules | `>=24`; local `node --version` = `v24.18.0` | Runtime for CLI routes, tests, fetch, and Web Streams. | Project engine requires Node >=24 and current tests use ESM plus built-in `node:test`. [VERIFIED: package.json] [VERIFIED: node --version] |
| `node:test` | Built into Node 24 | Hermetic unit and route tests. | Existing AI route tests use `node:test` with fake SDK/upstream seams instead of live model calls. [VERIFIED: tests/structured-oneshot.test.mjs] [VERIFIED: tests/assist-route.test.mjs] |
| `src/core/ai/call-ai.mjs` | Local module | BYOK/proxy route selection, Anthropic Messages request, usage rows for BYOK. | It is the existing AI boundary and already tests proxy labels and BYOK usage. [VERIFIED: src/core/ai/call-ai.mjs] [VERIFIED: tests/call-ai.test.mjs] |
| `src/core/ai/structured-oneshot.mjs` | Local module | Fenced/bare JSON extraction, deterministic schema validation, one retry. | It is route-agnostic and already has hermetic parse/retry/error tests. [VERIFIED: src/core/ai/structured-oneshot.mjs] [VERIFIED: tests/structured-oneshot.test.mjs] |
| `src/core/profile/schema-validator.mjs` | Local module | Dependency-free JSON Schema subset validator. | It is already used by structured one-shot and candidate/config validation. [VERIFIED: src/core/profile/schema-validator.mjs] |
| `src/core/ai/usage-log.mjs` | Local module | Metadata-only usage ledger and cost calculation. | It centralizes cost, cache token fields, and no-content telemetry. [VERIFIED: src/core/ai/usage-log.mjs] [VERIFIED: tests/usage-log.test.mjs] |

### Supporting

| Library / Module | Version | Purpose | When to Use |
|------------------|---------|---------|-------------|
| `src/cli/ai-proxy.mjs` | Local module | Managed proxy, server-side metering, upstream pass-through. | Use for proxy-path telemetry parity and label propagation tests. [VERIFIED: src/cli/ai-proxy.mjs] |
| `@anthropic-ai/claude-agent-sdk` | `^0.3.199` in devDependencies; npm latest observed `0.3.201` | Existing full skill and current bare one-shot runtime dependency. | Keep for routes that need skill/tool runtime, especially résumé file reading; do not add new install in Phase 2. [VERIFIED: package.json] [VERIFIED: npm view] |
| `@biomejs/biome` | `^2.5.0` in devDependencies; npm latest observed `2.5.2` | Existing formatter/linter. | Use existing project scripts only; no Phase 2 package change needed. [VERIFIED: package.json] [VERIFIED: npm view] |
| `playwright` | `^1.60.0` in devDependencies; npm latest observed `1.61.1` | Existing browser test/capture dependency. | Not needed for Phase 2 bounded-AI foundation unless existing tests require full suite. [VERIFIED: package.json] [VERIFIED: npm view] |

### Alternatives Considered

| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| Local `schema-validator.mjs` | Add AJV or Zod | Unnecessary dependency churn; current schemas and tests already use the local validator subset. [VERIFIED: src/core/profile/schema-validator.mjs] |
| Shared bounded wrapper | Route-local 422/501 handling | Route-local code already drifted across assist, onboard, and intake paths; Phase 2 decisions reject this pattern. [VERIFIED: src/cli/assist-route.mjs] [VERIFIED: src/cli/onboard-route.mjs] [VERIFIED: src/core/intake/classify.mjs] |
| Native structured output only | Trust provider schema enforcement | Provider docs still document refusal, truncation, schema limits, and schema subset constraints, so local validation remains required. [CITED: https://platform.claude.com/docs/en/build-with-claude/structured-outputs] [CITED: https://developers.openai.com/api/docs/guides/structured-outputs] |
| Full skill runtime | `POST /api/skill/run` | Full skill runtime is reserved for tool-heavy, long-running, or human-watched workflows, not cheap bounded app assists. [VERIFIED: .planning/architecture/runtime-routing-policy.md] |

**Installation:**
```bash
# No new package install recommended for Phase 2.
npm install
```

**Version verification:** Existing package metadata was checked with `npm view`; the phase should not upgrade or install packages unless implementation uncovers a concrete blocker. [VERIFIED: npm view] [VERIFIED: package.json]

## Package Legitimacy Audit

No new external packages are recommended for this phase. [VERIFIED: package.json]

| Package | Registry | Age | Downloads | Source Repo | Verdict | Disposition |
|---------|----------|-----|-----------|-------------|---------|-------------|
| `@anthropic-ai/claude-agent-sdk` | npm | latest published 2026-07-03 | 6,763,825/week | `github.com/anthropics/claude-agent-sdk-typescript` | SUS: too-new latest release | Existing devDependency only; no new install. [VERIFIED: package.json] [VERIFIED: package-legitimacy seam] |
| `@biomejs/biome` | npm | latest published 2026-07-01 | 9,836,633/week | `github.com/biomejs/biome` | SUS: too-new latest release | Existing devDependency only; no new install. [VERIFIED: package.json] [VERIFIED: package-legitimacy seam] |
| `playwright` | npm | latest published 2026-06-23 | 63,813,303/week | `github.com/microsoft/playwright` | SUS: too-new latest release | Existing devDependency only; no new install. [VERIFIED: package.json] [VERIFIED: package-legitimacy seam] |

**Packages removed due to [SLOP] verdict:** none. [VERIFIED: package-legitimacy seam]
**Packages flagged as suspicious [SUS]:** existing latest releases above are flagged by the seam because they are too new; planner should avoid package changes in this phase. [VERIFIED: package-legitimacy seam]

## Architecture Patterns

### System Architecture Diagram

```text
Route handler
  -> validate request / build bounded input
  -> bounded AI helper
       -> assert labels: skill + action + operation
       -> choose invocation adapter
            -> provider-native direct adapter via callAI()
            -> compatibility adapter via runStructuredOneshot()
            -> skill/tool adapter only for existing resume-extract Read-tool case
       -> parse provider text
       -> deterministic schema validation
       -> optional corrective retry
       -> classify outcome
  -> shared envelope
       -> 200 ok:true + data + ai metadata
       -> 422 AI_SCHEMA_INVALID + manual metadata
       -> 501 NO_AI_ROUTE + manual metadata
       -> 502/500 AI_PROVIDER_FAILED + manual metadata
  -> UI renders data or manual path
  -> usage ledger/proxy stores metadata-only telemetry
```

This data flow follows the Phase 2 context and existing route/test seams. [VERIFIED: .planning/phases/02-bounded-ai-foundation/02-CONTEXT.md] [VERIFIED: tests/assist-route.test.mjs] [VERIFIED: tests/onboard-route.test.mjs]

### Recommended Project Structure

```text
src/core/ai/
├── bounded-ai.mjs              # shared helper, envelope, label checks, provider/native/fallback orchestration [ASSUMED]
├── call-ai.mjs                 # extend request body options for native structured output [VERIFIED: src/core/ai/call-ai.mjs]
├── structured-oneshot.mjs      # keep parse/validate/retry fallback [VERIFIED: src/core/ai/structured-oneshot.mjs]
└── usage-log.mjs               # preserve metadata-only usage rows [VERIFIED: src/core/ai/usage-log.mjs]
tests/
├── bounded-ai.test.mjs         # new wrapper contract tests [ASSUMED]
├── assist-route.test.mjs       # update route envelope assertions [VERIFIED: tests/assist-route.test.mjs]
├── onboard-route.test.mjs      # update resume-ai envelope assertions [VERIFIED: tests/onboard-route.test.mjs]
└── call-ai.test.mjs            # add native output request-shape and label tests [VERIFIED: tests/call-ai.test.mjs]
```

### Pattern 1: Labels First, Provider Call Second

**What:** Validate `skill`, `action`, and route `operation` before any model/proxy call. [VERIFIED: .planning/phases/02-bounded-ai-foundation/02-CONTEXT.md]
**When to use:** Every bounded-AI helper entry point. [VERIFIED: .planning/phases/02-bounded-ai-foundation/02-CONTEXT.md]
**Example:**
```js
// Source: Phase 2 decisions + current callAI label fields.
const labels = requireBoundedLabels({ skill, action, operation });
const result = await runBoundedAI({ labels, schema, buildPrompt, manual });
```

The reason is concrete: `callAI()` only forwards proxy label headers when label values are present, and current usage rows normalize blanks to `null`. [VERIFIED: src/core/ai/call-ai.mjs] [VERIFIED: src/core/ai/usage-log.mjs]

### Pattern 2: Native Structured Output Is an Adapter, Not a Route Concern

**What:** Extend `callAI()` or a lower-level adapter to accept provider-native output schema options, while route modules pass only CareerRat schema/config. [VERIFIED: .planning/phases/02-bounded-ai-foundation/02-CONTEXT.md]
**When to use:** Direct tool-less bounded calls such as assist suggestions and future company seed generation. [VERIFIED: src/cli/assist-route.mjs] [VERIFIED: .planning/architecture/discover-companies-target-contract.md]
**Example:**
```js
// Source: Anthropic docs use output_config.format; local code should hide it.
await callAI({
  messages,
  maxTokens,
  skill,
  action,
  outputSchema: schema,
  outputMode: "native-preferred",
});
```

Anthropic's current native request shape is `output_config.format` with `type: "json_schema"` and a schema object. [CITED: https://platform.claude.com/docs/en/build-with-claude/structured-outputs]

### Pattern 3: Envelope Mapping Around Existing Outcomes

**What:** Map helper outcomes to a stable shared JSON envelope and keep route-specific output under `data`. [VERIFIED: .planning/phases/02-bounded-ai-foundation/02-CONTEXT.md]
**When to use:** Every HTTP route returning bounded AI output. [VERIFIED: .planning/phases/02-bounded-ai-foundation/02-CONTEXT.md]
**Example:**
```js
// Source: Phase 2 response decisions.
{
  ok: false,
  code: "AI_SCHEMA_INVALID",
  error: { message: "Model output did not match the route schema." },
  ai: { used: true, mode: "native", retried: true, skill, action, operation, model },
  manual: { available: true, reason: "schema_invalid" }
}
```

Existing routes already return 422 and 501 statuses, but fields differ and sometimes omit `ok`. [VERIFIED: src/cli/assist-route.mjs] [VERIFIED: src/cli/onboard-route.mjs]

### Anti-Patterns to Avoid

- **Route-local model plumbing:** It repeats invocation, parse/retry, no-AI, and telemetry logic that Phase 2 explicitly centralizes. [VERIFIED: .planning/phases/02-bounded-ai-foundation/02-CONTEXT.md]
- **Trusting native structured output without local validation:** Provider docs document refusal, max-token truncation, and schema limits. [CITED: https://platform.claude.com/docs/en/build-with-claude/structured-outputs]
- **Logging raw prompts or model output in usage rows:** Usage rows are designed for model, labels, token counts, cache counts, upstream, and costs only. [VERIFIED: src/core/ai/usage-log.mjs]
- **Using full skill runtime for direct bounded assists:** Routing policy reserves full runtime for broader tool/agent workflows. [VERIFIED: .planning/architecture/runtime-routing-policy.md]
- **Moving Phase 3 discovery schema/cache into Phase 2:** Company seed schema and board cache are explicitly deferred. [VERIFIED: .planning/phases/02-bounded-ai-foundation/02-CONTEXT.md]

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| BYOK/proxy route selection | New env resolver per route | `resolveAIRoute()` / `callAI()` | Existing tests cover BYOK precedence, proxy fallback, and no-route errors. [VERIFIED: src/core/ai/call-ai.mjs] [VERIFIED: tests/call-ai.test.mjs] |
| JSON extraction and retry | New regex/retry loop per route | `runStructuredOneshot()` and `parseStructuredJson()` | Existing helper handles last fenced block, bare JSON, schema errors, retry, and thrown invocation errors. [VERIFIED: src/core/ai/structured-oneshot.mjs] |
| Schema validation | New validator package | `schema-validator.mjs` | Current schema subset is dependency-free and already integrated. [VERIFIED: src/core/profile/schema-validator.mjs] |
| Usage cost calculation | Route-local pricing math | `appendUsageEvent()` / `computeCost()` | Cost table and cache-token pricing live in one module. [VERIFIED: src/core/ai/usage-log.mjs] |
| Proxy metering | Client-side proxy duplication | `ai-proxy.mjs` | Proxy already writes metadata-only rows from JSON and SSE usage data. [VERIFIED: src/cli/ai-proxy.mjs] |
| Manual fallback shape | Route-specific ad hoc errors | Shared bounded envelope | Phase 2 locks a shared envelope for success, schema failure, no-AI, and provider failure. [VERIFIED: .planning/phases/02-bounded-ai-foundation/02-CONTEXT.md] |

**Key insight:** The hard part is not parsing JSON; it is preserving the same no-AI, schema-failure, provider-failure, manual-fallback, and cost-label semantics across direct calls, proxy calls, and current skill-runtime one-shots. [VERIFIED: src/cli/assist-route.mjs] [VERIFIED: src/cli/onboard-route.mjs] [VERIFIED: src/core/intake/classify.mjs]

## Common Pitfalls

### Pitfall 1: Label Drift Between BYOK And Proxy
**What goes wrong:** Proxy requests only include `x-careerrat-skill` and `x-careerrat-action` if the caller passed them, and usage rows normalize empty labels to null. [VERIFIED: src/core/ai/call-ai.mjs] [VERIFIED: src/core/ai/usage-log.mjs]
**Why it happens:** Label validation is currently caller discipline, not an enforced helper contract. [VERIFIED: src/core/ai/call-ai.mjs]
**How to avoid:** Add wrapper-level `requireBoundedLabels()` and tests that prove missing/blank `skill`, `action`, and `operation` fail before invocation. [ASSUMED]
**Warning signs:** Tests that inspect only response bodies but not usage rows or proxy headers. [VERIFIED: tests/assist-route.test.mjs] [VERIFIED: tests/call-ai.test.mjs]

### Pitfall 2: Treating Native Structured Output As Complete Trust Boundary
**What goes wrong:** Refusals or max-token truncation can produce non-schema output even with native structured output. [CITED: https://platform.claude.com/docs/en/build-with-claude/structured-outputs]
**Why it happens:** Provider-native constrained decoding is reliable for normal cases but still documents exception paths. [CITED: https://platform.claude.com/docs/en/build-with-claude/structured-outputs]
**How to avoid:** Always run local `parseStructuredJson()`/`validate()` or equivalent deterministic validation after the model returns. [VERIFIED: src/core/ai/structured-oneshot.mjs]
**Warning signs:** Route code directly trusts `response.content[0].text` without schema validation. [CITED: https://platform.claude.com/docs/en/build-with-claude/structured-outputs]

### Pitfall 3: Schema Too Complex For Provider Native Mode
**What goes wrong:** Native structured output providers impose schema subset and complexity limits, including required fields and `additionalProperties: false` constraints. [CITED: https://developers.openai.com/api/docs/guides/structured-outputs] [CITED: https://platform.claude.com/docs/en/build-with-claude/structured-outputs]
**Why it happens:** Provider-native schema grammars are compiled and constrained; not every local JSON Schema construct is equally supported. [CITED: https://platform.claude.com/docs/en/build-with-claude/structured-outputs]
**How to avoid:** Keep Phase 2 route schemas shallow, explicit, and route-specific; preserve fallback mode for unsupported schemas. [ASSUMED]
**Warning signs:** Deep `anyOf`, many optional fields, union-heavy nullability, or route schemas reused as broad app DTOs. [CITED: https://developers.openai.com/api/docs/guides/structured-outputs]

### Pitfall 4: Returning Raw Model Output In Errors
**What goes wrong:** Current `resume-ai` 422 response includes `raw: outcome.raw`, which conflicts with the Phase 2 no-raw-output/privacy direction. [VERIFIED: src/cli/onboard-route.mjs] [VERIFIED: .planning/phases/02-bounded-ai-foundation/02-CONTEXT.md]
**Why it happens:** Existing route-local behavior predates the shared envelope. [VERIFIED: src/cli/onboard-route.mjs]
**How to avoid:** Envelope should expose stable codes and validation summaries, not raw prompt or model output. [VERIFIED: .planning/phases/02-bounded-ai-foundation/02-CONTEXT.md]
**Warning signs:** Any `raw`, `prompt`, `bodyText`, `resume`, or `jd` field in a response or usage event. [VERIFIED: src/core/ai/usage-log.mjs]

### Pitfall 5: Breaking Deterministic Shortcuts
**What goes wrong:** Intake classification can call AI unnecessarily if the wrapper hides deterministic pre-checks. [VERIFIED: src/core/intake/classify.mjs]
**Why it happens:** Common helpers can encourage every route to call AI first. [ASSUMED]
**How to avoid:** Keep deterministic classification/resolution before invoking the bounded helper; helper starts only after route-local deterministic checks choose AI. [VERIFIED: src/core/intake/classify.mjs]
**Warning signs:** `loadSdk` or `callAI` invoked for a fully resolved known-ATS URL. [VERIFIED: tests/intake-classify.test.mjs]

## Code Examples

Verified patterns from official sources and local code:

### Current Parse / Validate / Retry Contract
```js
// Source: src/core/ai/structured-oneshot.mjs
const outcome = await runStructuredOneshot({
  schema,
  maxRetries: 1,
  invoke: async ({ correction }) => {
    const prompt = correction ? `${basePrompt}\n\n${correction}` : basePrompt;
    return runBareOneshot({ prompt, repoRoot, env, skillLabel, loadSdk });
  },
});
```

This pattern already separates schema failure (`ok:false`) from invocation failure (`throw`). [VERIFIED: src/core/ai/structured-oneshot.mjs]

### Current Direct Call Label Path
```js
// Source: src/core/ai/call-ai.mjs
await callAI({
  model,
  messages,
  maxTokens,
  skill: "discover-companies",
  action: "seed-generate",
  root: repoRoot,
});
```

Proxy calls forward `x-careerrat-skill` and `x-careerrat-action`; BYOK calls write usage rows directly when `root` is supplied. [VERIFIED: src/core/ai/call-ai.mjs]

### Recommended Bounded Helper Shape
```js
// Source: synthesis from Phase 2 decisions and existing route contracts. [ASSUMED]
const result = await runBoundedAI({
  labels: { skill: "assist", action: "suggest", operation: "titles" },
  schema,
  messages,
  maxTokens: 512,
  manual: { available: true, kind: "edit-fields" },
  nativeStructured: true,
  root: repoRoot,
  env,
});

sendJson(res, result.status, result.body);
```

The route supplies the route-specific pieces; the helper owns labels, invocation, validation, retry, and envelope mapping. [VERIFIED: .planning/phases/02-bounded-ai-foundation/02-CONTEXT.md]

### Anthropic Native Structured Output Request Shape
```js
// Source: Anthropic structured outputs docs.
{
  model,
  max_tokens: maxTokens,
  messages,
  output_config: {
    format: {
      type: "json_schema",
      schema
    }
  }
}
```

Anthropic documents JSON outputs under `output_config.format` and says response text contains JSON matching the schema in normal cases. [CITED: https://platform.claude.com/docs/en/build-with-claude/structured-outputs]

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| Prompt-only fenced JSON | Provider-native JSON schema plus local validation fallback | Anthropic docs now describe GA `output_config.format` and note old beta `output_format` transition behavior. [CITED: https://platform.claude.com/docs/en/build-with-claude/structured-outputs] | Planner should add native support behind `callAI()` but keep `runStructuredOneshot()` fallback. |
| Route-specific errors | Shared bounded envelope | Locked by Phase 2 user decisions. [VERIFIED: .planning/phases/02-bounded-ai-foundation/02-CONTEXT.md] | Planner should create helper tests before route migrations. |
| Optional caller labels | Required bounded-call labels | Locked by Phase 2 user decisions. [VERIFIED: .planning/phases/02-bounded-ai-foundation/02-CONTEXT.md] | Missing labels become a wrapper regression test. |
| Prompt caching as optimization | Defer until labels/envelope stable | Anthropic cache telemetry is already represented by current usage fields; Phase 2 context defers caching. [CITED: https://platform.claude.com/docs/en/build-with-claude/prompt-caching] [VERIFIED: .planning/phases/02-bounded-ai-foundation/02-CONTEXT.md] | Planner should not make cache-control implementation a Wave 1 task. |

**Deprecated/outdated:**
- Anthropic beta-only `output_format` should not be the new implementation target; current docs point to `output_config.format`. [CITED: https://platform.claude.com/docs/en/build-with-claude/structured-outputs]
- Route-specific 501/422 JSON bodies are now architectural debt for bounded AI routes. [VERIFIED: src/cli/assist-route.mjs] [VERIFIED: src/cli/onboard-route.mjs] [VERIFIED: .planning/phases/02-bounded-ai-foundation/02-CONTEXT.md]

## Assumptions Log

| # | Claim | Section | Risk if Wrong |
|---|-------|---------|---------------|
| A1 | Recommended module name is `src/core/ai/bounded-ai.mjs`. | Summary / Project Structure | Low; planner can rename while preserving boundaries. |
| A2 | Wrapper tests should live in `tests/bounded-ai.test.mjs`. | Project Structure | Low; test file name can change. |
| A3 | Direct tool-less calls should prefer a `callAI()` adapter for native structured output. | Architecture Patterns | Medium; if Agent SDK query exposes a stable native structured-output option for this use case, planner can use it behind the same helper. |
| A4 | Keep route schemas shallow and reduce optional/union-heavy fields for native mode. | Pitfalls | Medium; exact provider limits can shift, but current provider docs support this posture. |

## Open Questions (RESOLVED)

1. **RESOLVED: Should Phase 2 migrate all current bounded routes or only add the helper plus one exemplar migration?**
   - What we know: Phase decisions allow incremental migration and name assist, onboard resume-ai, and intake classification as first consumers. [VERIFIED: .planning/phases/02-bounded-ai-foundation/02-CONTEXT.md]
   - Answer reflected in plans: Phase 2 migrates the shared helper plus all three named current bounded consumers: `assist-route` in Plan 02-04, `intake/classify` in Plan 02-05, and `resume-ai` in Plan 02-06. [RESOLVED: .planning/phases/02-bounded-ai-foundation/02-04-PLAN.md] [RESOLVED: .planning/phases/02-bounded-ai-foundation/02-05-PLAN.md] [RESOLVED: .planning/phases/02-bounded-ai-foundation/02-06-PLAN.md]
   - Scope boundary: discovery company seed generation and other Phase 3 API behavior remain out of scope per the deferred ideas in CONTEXT.md. [VERIFIED: .planning/phases/02-bounded-ai-foundation/02-CONTEXT.md]

2. **RESOLVED: Does Phase 2 need OpenAI runtime support or only an abstraction that will not block it later?**
   - What we know: Current runtime is Anthropic-shaped through `callAI()` and `ai-proxy`; OpenAI docs are selected as cross-provider reference. [VERIFIED: src/core/ai/call-ai.mjs] [VERIFIED: src/cli/ai-proxy.mjs] [CITED: https://developers.openai.com/api/docs/guides/structured-outputs]
   - Answer reflected in plans: Phase 2 implements provider-neutral local API fields and Anthropic native structured-output request support through `callAI()` and the bounded helper. It does not add an OpenAI provider adapter in this phase because no locked decision or requirement scopes that provider implementation. [RESOLVED: .planning/phases/02-bounded-ai-foundation/02-02-PLAN.md] [RESOLVED: .planning/phases/02-bounded-ai-foundation/02-03-PLAN.md]
   - Cross-provider constraint retained: app routes must call CareerRat's local helper/API shape instead of encoding provider-specific request bodies, preserving D-16. [VERIFIED: .planning/phases/02-bounded-ai-foundation/02-CONTEXT.md]

3. **RESOLVED: Should provider failures use HTTP 500 or 502?**
   - What we know: Current proxy unreachable returns 502; route-local unexpected AI failures often return 500. [VERIFIED: src/cli/ai-proxy.mjs] [VERIFIED: src/cli/assist-route.mjs]
   - Answer reflected in plans: Provider, proxy, SDK, timeout, and transport failures use status 502 with `code:"AI_PROVIDER_FAILED"` and manual fallback metadata when available. Internal wrapper bugs are not classified as provider failures. [RESOLVED: .planning/phases/02-bounded-ai-foundation/02-01-PLAN.md]
   - Regression policy: final Phase 2 tests verify provider-failure envelopes do not expose raw prompts, raw model output, resumes, JDs, candidate facts, or page bodies. [RESOLVED: .planning/phases/02-bounded-ai-foundation/02-07-PLAN.md]

## Environment Availability

| Dependency | Required By | Available | Version | Fallback |
|------------|-------------|-----------|---------|----------|
| Node.js | Runtime and tests | yes | `v24.18.0` | None needed; package requires `>=24`. [VERIFIED: node --version] [VERIFIED: package.json] |
| npm | Scripts and package metadata | yes | `11.16.0` | None needed. [VERIFIED: npm --version] |
| Network to providers | Real AI integration tests | not required for unit plan | not probed with live key | Use fake SDK/upstream tests; current tests already do this. [VERIFIED: tests/assist-route.test.mjs] [VERIFIED: tests/call-ai.test.mjs] |
| `ANTHROPIC_API_KEY` or `CAREERRAT_AI_PROXY_URL` | Live AI calls | not required for hermetic tests | environment-dependent | No-AI envelope should return 501/manual metadata. [VERIFIED: src/core/ai/call-ai.mjs] |

**Missing dependencies with no fallback:** none for planning and hermetic implementation tests. [VERIFIED: package.json]

**Missing dependencies with fallback:** live provider credentials can be absent because tests should use fake invokers/upstreams. [VERIFIED: tests/structured-oneshot.test.mjs] [VERIFIED: tests/call-ai.test.mjs]

## Validation Architecture

### Test Framework

| Property | Value |
|----------|-------|
| Framework | Node built-in `node:test` on Node `v24.18.0`. [VERIFIED: package.json] [VERIFIED: node --version] |
| Config file | none required for `node:test`; package script is in `package.json`. [VERIFIED: package.json] |
| Quick run command | `node --test tests/bounded-ai.test.mjs tests/call-ai.test.mjs tests/structured-oneshot.test.mjs` [ASSUMED] |
| Full suite command | `npm test` [VERIFIED: package.json] |

### Phase Requirements -> Test Map

| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|--------------|
| AIR-01 | Missing/blank `skill`, `action`, or `operation` fails before model invocation; valid labels reach usage/proxy path. | unit | `node --test tests/bounded-ai.test.mjs` | No, Wave 0. [ASSUMED] |
| AIR-02 | Native and fallback outputs are locally parsed/validated; malformed JSON retries once; schema rejection returns `AI_SCHEMA_INVALID`. | unit | `node --test tests/bounded-ai.test.mjs tests/structured-oneshot.test.mjs` | Partial; new wrapper tests needed. [VERIFIED: tests/structured-oneshot.test.mjs] |
| AIR-03 | No-AI returns 501-style envelope with `manual.available:true` and `ai.used:false`. | route/unit | `node --test tests/bounded-ai.test.mjs tests/assist-route.test.mjs` | Partial; route tests exist, wrapper tests missing. [VERIFIED: tests/assist-route.test.mjs] |
| AIR-04 | BYOK and proxy paths preserve metadata-only usage rows and expose route metadata without content leakage. | unit/integration-fake | `node --test tests/bounded-ai.test.mjs tests/call-ai.test.mjs tests/ai-proxy.test.mjs` | Partial; wrapper tests missing. [VERIFIED: tests/call-ai.test.mjs] [VERIFIED: tests/ai-proxy.test.mjs] |

### Sampling Rate

- **Per task commit:** `node --test tests/bounded-ai.test.mjs tests/call-ai.test.mjs tests/structured-oneshot.test.mjs` once wrapper exists. [ASSUMED]
- **Per wave merge:** `npm test` or at minimum all touched route tests. [VERIFIED: package.json]
- **Phase gate:** Full suite green before `$gsd-verify-work`. [VERIFIED: .planning/config.json]

### Wave 0 Gaps

- [ ] `tests/bounded-ai.test.mjs` - covers envelope mapping, labels, no-AI, provider failure, schema failure, native/fallback modes, and no content leakage. [ASSUMED]
- [ ] Add `callAI()` request-shape tests for `output_config.format` without live provider calls. [ASSUMED]
- [ ] Add route tests that assert migrated routes use the shared envelope, not legacy top-level route-specific fields. [ASSUMED]
- [ ] Add usage label regression tests for both BYOK and proxy paths. [ASSUMED]

## Security Domain

### Applicable ASVS Categories

| ASVS Category | Applies | Standard Control |
|---------------|---------|------------------|
| V2 Authentication | no | Phase 2 does not change user auth; AI route credentials remain env/local-key based. [VERIFIED: .planning/phases/02-bounded-ai-foundation/02-CONTEXT.md] |
| V3 Session Management | no | Phase 2 does not add sessions or browser-authenticated automation. [VERIFIED: .planning/phases/02-bounded-ai-foundation/02-CONTEXT.md] |
| V4 Access Control | yes | Preserve existing skill-runtime allowlist for tool/skill cases; bounded helper should not bypass it for `resume-extract`. [VERIFIED: src/core/ai/skill-runtime.mjs] |
| V5 Input Validation | yes | Validate request JSON/body caps, parse model output, and validate schemas before use. [VERIFIED: src/cli/assist-route.mjs] [VERIFIED: src/core/ai/structured-oneshot.mjs] |
| V6 Cryptography | yes | Do not change local key storage or token compare logic; proxy uses hashed/timing-safe token comparison. [VERIFIED: AGENTS.md] [VERIFIED: src/cli/ai-proxy.mjs] |
| V7 Error Handling and Logging | yes | Stable error codes and metadata-only telemetry; no prompts, resumes, JDs, candidate facts, or raw model output in logs. [VERIFIED: .planning/phases/02-bounded-ai-foundation/02-CONTEXT.md] [VERIFIED: src/core/ai/usage-log.mjs] |

### Known Threat Patterns for Bounded AI Routes

| Pattern | STRIDE | Standard Mitigation |
|---------|--------|---------------------|
| Prompt injection from pasted content | Tampering | Treat pasted/user content as data in prompts and validate output deterministically. [VERIFIED: src/core/intake/classify.mjs] |
| Sensitive data leakage through telemetry | Information Disclosure | Usage rows store labels, model, upstream, token counts, cache counts, and cost only. [VERIFIED: src/core/ai/usage-log.mjs] |
| Provider refusal/truncation mistaken for valid data | Tampering | Check stop reason/provider outcome and run local schema validation before `data` exposure. [CITED: https://platform.claude.com/docs/en/build-with-claude/structured-outputs] |
| Missing labels hide spend attribution | Repudiation | Wrapper rejects missing labels before invocation and tests enforce regression. [VERIFIED: .planning/phases/02-bounded-ai-foundation/02-CONTEXT.md] |
| Raw model output returned to UI on 422 | Information Disclosure | Envelope returns stable code and validation summary, not raw content. [VERIFIED: src/cli/onboard-route.mjs] [VERIFIED: .planning/phases/02-bounded-ai-foundation/02-CONTEXT.md] |

## Sources

### Primary (HIGH confidence)
- `.planning/phases/02-bounded-ai-foundation/02-CONTEXT.md` - locked Phase 2 decisions, scope, deferred items. [VERIFIED: codebase grep]
- `.planning/REQUIREMENTS.md` - AIR-01 through AIR-04 requirement text. [VERIFIED: codebase grep]
- `.planning/ROADMAP.md` - Phase 2 success criteria. [VERIFIED: codebase grep]
- `.planning/architecture/runtime-routing-policy.md` - route class boundaries. [VERIFIED: codebase grep]
- `src/core/ai/call-ai.mjs`, `structured-oneshot.mjs`, `usage-log.mjs`, `ai-proxy.mjs`, route modules, and tests listed above. [VERIFIED: codebase grep]

### Secondary (MEDIUM confidence)
- Anthropic structured outputs docs - native `output_config.format`, invalid outputs, schema limits, caching interaction. [CITED: https://platform.claude.com/docs/en/build-with-claude/structured-outputs]
- OpenAI structured outputs docs - strict JSON schema request shape and schema restrictions. [CITED: https://developers.openai.com/api/docs/guides/structured-outputs]
- Anthropic prompt caching docs - cache token fields and cost implications. [CITED: https://platform.claude.com/docs/en/build-with-claude/prompt-caching]

### Tertiary (LOW confidence)
- Recommended exact module and test file names. [ASSUMED]

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH - based on `package.json`, local source, tests, and local command probes. [VERIFIED: package.json] [VERIFIED: node --version]
- Architecture: HIGH - Phase 2 decisions and Phase 1 routing policy explicitly define the wrapper boundary. [VERIFIED: .planning/phases/02-bounded-ai-foundation/02-CONTEXT.md] [VERIFIED: .planning/architecture/runtime-routing-policy.md]
- Provider-native behavior: MEDIUM - based on official docs fetched on 2026-07-04; provider APIs can evolve. [CITED: https://platform.claude.com/docs/en/build-with-claude/structured-outputs] [CITED: https://developers.openai.com/api/docs/guides/structured-outputs]
- Pitfalls: HIGH for local telemetry/route drift; MEDIUM for provider schema limitations. [VERIFIED: src/core/ai/usage-log.mjs] [CITED: https://platform.claude.com/docs/en/build-with-claude/structured-outputs]

**Research date:** 2026-07-04
**Valid until:** 2026-07-11 for provider API shape; 2026-08-03 for repository architecture if Phase 2 remains unimplemented.
