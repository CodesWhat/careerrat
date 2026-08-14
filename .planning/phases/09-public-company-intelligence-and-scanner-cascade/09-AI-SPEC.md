# AI-SPEC - Phase 09: Public Company Intelligence and Scanner Cascade

> AI design contract generated for `$gsd-ai-integration-phase`. Consumed by `gsd-planner` and `gsd-eval-auditor`.
> Locks framework selection, implementation guidance, and evaluation strategy before planning begins.

---

## 1. System Classification

**System Type:** Structured extraction fallback

**Description:**
Phase 09 is not a new autonomous AI workflow. It extends the existing CareerRat bounded-AI seam so public careers-page scanner output can use a model only after deterministic ATS and public-page parsing found reachable page text but could not confidently structure it. Good behavior means AI reduces manual review for genuinely ambiguous public pages without becoming a source of final URLs, provider identity, source-config writes, or publishable public records.

**Critical Failure Modes:**
1. AI sees or returns candidate-private data, local paths, tracker IDs, fit scores, compensation floors, private notes, or personal application context.
2. AI output is trusted as a final careers URL, ATS/provider identity, source-config write, or public-sync payload without deterministic validation and scrub checks.
3. AI is invoked for empty, blocked, robots-disallowed, login-gated, or useless pages where no usable public text exists.
4. AI turns "found nothing" into a review item instead of allowing the scanner to record metadata and move on silently.
5. AI fallback causes unbounded cost, repeated retries, or full skill/runtime handoffs from local discovery APIs.

---

## 1b. Domain Context

> Researched for job-search source discovery, public company metadata, and local-first privacy constraints.

**Industry Vertical:** Job-search automation / developer tooling

**User Population:** Local CareerRat users configuring company and board discovery during onboarding and recurring search sweeps.

**Stakes Level:** High

**Output Consequence:** Scanner output can alter future search-source coverage and publish public metadata to sync-home. It must never leak private candidate data or create trusted source writes from model guesses.

### What Domain Experts Evaluate Against

| Dimension | Good | Bad | Stakes | Source |
|-----------|------|-----|--------|--------|
| Privacy separation | Public records contain company/board metadata only | Candidate profile, tracker, local path, comp, or fit data appears in any publish payload | High | Phase 09 discussion decisions and CareerRat data contracts |
| Source authority | Deterministic resolver validates URL, provider, freshness, and conflicts | Model-suggested URL or provider is written directly | High | Prior Phase 03/05 discovery decisions |
| Cost control | AI runs only on ambiguous reachable public text | AI runs on every custom page, empty page, or known failure | Medium | Phase 09 discussion decisions |
| User review burden | Review queue contains only ambiguous/conflicting extraction | Clean "found nothing" or unsupported board results interrupt the user | Medium | Phase 09 discussion decisions |
| Reproducibility | Every AI-assisted result has input hash, schema result, confidence, and deterministic validation status | Final state cannot explain why a board/company was accepted or suppressed | High | CareerRat tracker and DB write contracts |

### Known Failure Modes in This Domain

- Careers pages often contain marketing copy, nav links, stale "no roles" text, or embedded third-party widgets; AI can over-infer a provider or jobs page from generic text.
- Job boards and company pages may be public but custom; deterministic extraction should capture metadata and confidence without pretending unsupported custom boards are actionable ATS sources.
- Empty or blocked pages are common in scraping. They are not ambiguity; they are no-AI conditions.
- Users care about saving calls and attention. A failed scan should not become a chat handoff or review task unless it has a concrete ambiguous/conflicting decision.
- Public sync data can become shared infrastructure, so any leak is more severe than a local-only mistake.

### Regulatory / Compliance Context

No sector-specific regulation is identified for public company metadata itself. The controlling compliance posture is privacy-by-design: local candidate data and job-search state must not leave the machine through public sync or model prompts, and all publish paths must fail closed on scrub violations.

### Domain Expert Roles for Evaluation

| Role | Responsibility |
|------|----------------|
| CareerRat maintainer | Calibrate privacy scrub fixtures, scanner cascade semantics, and cost thresholds |
| Power user / job-search operator | Review ambiguous scanner items for whether the requested decision is useful |
| Security reviewer | Validate public/private table boundaries, prompt input allowlist, and publish payload scrub invariants |

---

## 2. Framework Decision

**Selected Framework:** Existing CareerRat bounded-AI helpers (`runBoundedAI()`, `callAI()`, `parseStructuredJson()`, JSON Schema validation)

**Version:** Repo-local modules in `src/core/ai/*`; no new package dependency

**Rationale:**
The phase needs a small structured extraction fallback, not an agent framework. Existing CareerRat architecture already centralizes provider routing, labels, structured-output parsing, schema validation, corrective retry, BYOK/proxy selection, and public envelope normalization. Reusing that seam preserves the "deterministic first, AI only for judgment" core value and avoids adding orchestration overhead for a last-resort parser.

**Alternatives Considered:**

| Framework | Ruled Out Because |
|-----------|------------------|
| LangChain | Too broad for one structured fallback; would add dependency and abstraction around code that already exists |
| LangGraph | Stateful graph/checkpointing is unnecessary because the scanner cascade is deterministic code with one optional model call |
| OpenAI Agents SDK | The phase is not an agent with tools/handoffs; provider-native lock-in would conflict with current Anthropic/proxy route |
| CrewAI | Multi-agent role/task decomposition is irrelevant to scanner extraction |
| LlamaIndex | The problem is not RAG or document retrieval |

**Vendor Lock-In Accepted:** Partial. The current `callAI()` route is Anthropic/proxy shaped, but the bounded-AI caller must remain provider-neutral at the scanner boundary by relying on JSON Schema validation and deterministic post-validation.

---

## 3. Framework Quick Reference

> Based on existing CareerRat source instead of external framework docs.

### Installation

```bash
# No new dependency.
# Optional AI route configuration is existing CareerRat config:
export ANTHROPIC_API_KEY=...
# or
export CAREERRAT_AI_PROXY_URL=...
export CAREERRAT_AI_PROXY_TOKEN=...
```

### Core Imports

```js
import { runBoundedAI, BOUNDED_AI_MODES } from "../ai/bounded-ai.mjs";
import { validate } from "../profile/schema-validator.mjs";
```

### Entry Point Pattern

```js
export async function extractAmbiguousCareersPage({ pageText, pageUrl, inputHash, root, signal }) {
  if (!hasUsablePublicText(pageText)) {
    return { kind: "no-ai", reason: "no-usable-public-text" };
  }

  const envelope = await runBoundedAI({
    labels: {
      skill: "discover-companies",
      action: "scanner-cascade",
      operation: "public-careers-extract",
    },
    schema: PUBLIC_CAREERS_EXTRACTION_SCHEMA,
    messages: [
      { role: "user", content: buildPublicOnlyExtractionPrompt({ pageText, pageUrl, inputHash }) },
    ],
    manual: {
      available: true,
      reason: "AI extraction unavailable or invalid",
      action: "Keep public metadata and require deterministic validation",
    },
    structuredMode: "native-preferred",
    outputName: "public_careers_extraction",
    maxRetries: 1,
    root,
    signal,
  });

  if (!envelope.body.ok) return { kind: "review", envelope };
  return validateExtractionDeterministically(envelope.body.data, { pageUrl, inputHash });
}
```

### Key Abstractions

| Concept | What It Is | When You Use It |
|---------|------------|-----------------|
| `runBoundedAI()` | Shared bounded structured-output wrapper | Any small schema-validated model call |
| `callAI()` | Provider/proxy routing seam | Only below bounded helpers, never directly in scanner routes |
| JSON Schema | Trust boundary for model output shape | Every AI result before deterministic validation |
| Deterministic validator | URL/provider/scrub/freshness authority | After AI suggests structure, before any write |
| Manual envelope | Local fallback metadata | When AI route is missing, invalid, or provider fails |

### Common Pitfalls

1. Do not call AI before supported ATS APIs, deterministic public-page extraction, and scraper/API fallback have had a chance.
2. Do not prompt with candidate profile, tracker rows, local paths, fit scores, compensation floors, notes, or source-config private state.
3. Do not convert model output directly into `public_*` rows or source config writes.
4. Do not use AI for pages with no usable public text; that is a deterministic no-result or unavailable condition.
5. Do not emit review items for clean no-result scans.

### Recommended Project Structure

```text
src/core/discovery/
  public-intel-schema.mjs
  public-intel-scrub.mjs
  scanner-cascade.mjs
  careers-page-extractor.mjs
  public-sync.mjs
src/cli/
  discovery-routes.mjs
tests/
  public-intel-*.test.mjs
```

---

## 4. Implementation Guidance

**Model Configuration:**
Use the existing `callAI()` model resolution. Caller may pass no model and inherit `config/ai.json` or environment overrides. Keep `maxTokens` low enough for extraction output; prompt must use truncated/sanitized public page text and should include input hashes rather than raw private provenance.

**Core Pattern:**
Scanner cascade owns the decision tree:
1. Supported ATS API/resolver.
2. Generic deterministic public-page extraction.
3. Optional scraper/API fallback for reachable public pages.
4. Bounded AI only when prior paths found usable public text but structure is ambiguous.
5. Deterministic validation and scrub checks before any write or publish.

**Tool Use:**
No agent tools, no retained skill runtime, no browser session, and no chat handoff from the local scanner path. If authenticated/session browser access is needed for a page, that is outside public sync and must not publish private/session-derived data.

**State Management:**
AI calls do not write. The scanner writes only through DB-owned verbs or local APIs after validation. Persist AI-assisted metadata as provenance/confidence/review reason, not raw prompts, raw model text, or page bodies in public sync payloads.

**Context Window Strategy:**
Prompt only the smallest sanitized public text excerpt needed to identify careers structure. Strip script/style/nav noise, truncate deterministically, and include source URL plus content hash. Never include candidate targeting context or search intent.

---

## 4b. AI Systems Best Practices

### Structured Outputs with Pydantic

CareerRat source uses JSON Schema validation in JavaScript, not Pydantic at runtime. The Pydantic-equivalent contract below documents the shape evaluators should expect; implementation must remain JSON Schema based.

```python
from pydantic import BaseModel, Field, HttpUrl
from typing import Literal

class PublicCareersExtraction(BaseModel):
    company_name: str | None = Field(default=None, max_length=160)
    careers_url: HttpUrl | None = None
    ats_provider_hint: Literal["ashby", "greenhouse", "lever", "workday", "custom", "unknown"]
    confidence: float = Field(ge=0, le=1)
    review_required: bool
    review_reason: str | None = Field(default=None, max_length=240)
    evidence: list[str] = Field(default_factory=list, max_length=5)
```

Runtime equivalent: define `PUBLIC_CAREERS_EXTRACTION_SCHEMA`, pass it to `runBoundedAI()`, then validate URLs/providers/freshness with deterministic code.

### Async-First Design

Scanner and AI fallback should be async and cancellable through `AbortSignal`. Never run AI inside a DB transaction; DB transactions remain synchronous and side-effect free except their intended writes.

### Prompt Engineering Discipline

Use a system prompt that says: extract only from provided public text, never infer missing URLs/providers, return `unknown` when evidence is insufficient, and set `review_required` for ambiguity. User prompt contains only sanitized public page text and public URL metadata.

### Context Window Management

Use deterministic page-text reduction: visible text only, remove navigation repetition, cap by character budget, and include a hash for provenance. Do not feed entire HTML unless the extractor explicitly needs markup and scrub tests cover it.

### Cost and Latency Budget

Default to zero AI calls for supported ATS, deterministic success, empty/no-result pages, blocked pages, robots-disallowed pages, and unsupported-but-unambiguous metadata. Allow at most one initial call plus one corrective retry through `runBoundedAI()`. Record usage through existing BYOK/proxy usage labels.

---

## 5. Evaluation Strategy

### Dimensions

| Dimension | Rubric | Measurement Approach | Priority |
|-----------|--------|---------------------|----------|
| Privacy scrub | Pass if prompt, result, and publish payload contain no private/candidate fields or local paths | Code fixtures plus static field denylist | Critical |
| Cascade gating | Pass if AI is called only for ambiguous reachable public text after deterministic attempts | Unit tests with fake AI seam | Critical |
| Schema validity | Pass if invalid model output yields manual/review envelope and never writes | Code tests for parse failure, retry, schema rejection | Critical |
| Deterministic authority | Pass if model-suggested URL/provider must pass resolver/validator before write | Integration tests with malicious model hints | High |
| Review burden | Pass if clean no-result scans write metadata silently and ambiguous/conflicting scans create review items | Route/API tests | High |
| Cost cap | Pass if each eligible page has max one retry and no loops/full skill handoff | Unit tests on invocation counter | Medium |

### Eval Tooling

**Primary Tool:** Node test runner plus existing schema-validator fixtures

**Setup:**

```bash
npm test -- tests/public-intel-*.test.mjs
```

**CI/CD Integration:**

```bash
npm test
npm run lint:placeholders
```

### Reference Dataset

**Size:** 16 fixtures to start

**Composition:**
Supported ATS page, custom careers page with clear jobs link, custom page with ambiguous provider, no open roles page, generic marketing page, blocked/robots-disallowed page, login-gated page, empty page, stale cached provider conflict, malicious model URL hint, private-field contamination fixture, local-path contamination fixture, unsupported board page, board with public metadata only, scraper success, scraper parse ambiguity.

**Labeling:**
Maintainer labels expected cascade branch, review requirement, confidence band, and whether AI may be invoked. Security reviewer labels private-field denylist fixtures.

---

## 6. Guardrails

### Online (Real-Time)

| Guardrail | Trigger | Intervention |
|-----------|---------|--------------|
| Private field scrub | Prompt or publish payload contains candidate/private/local-path field | Block and surface local scrub failure |
| No usable public text | Empty, blocked, robots-disallowed, login-gated, or useless page | Do not call AI; record no-result/unavailable metadata |
| Schema failure | Model output fails JSON parse/schema after retry | Return manual/review envelope; no write |
| Deterministic validation failure | AI-suggested URL/provider fails resolver or provider check | Keep public metadata only or create review item |
| Invocation budget exceeded | More than configured call/retry count for one page | Abort AI path and return manual fallback |

### Offline (Flywheel)

| Metric | Sampling Strategy | Action on Degradation |
|--------|------------------|----------------------|
| AI invocation rate per scan | Every scan run summary | Tighten deterministic extraction or gating thresholds |
| Review usefulness | Sample review items after decisions | Adjust ambiguity/conflict criteria |
| False provider hints | All AI-assisted validations that fail deterministic resolver | Harden prompt and post-validator |
| Scrub near misses | Every blocked scrub failure | Add denylist fixture and publish-path test |

---

## 7. Production Monitoring

**Tracing Tool:** Existing BYOK/proxy usage logging via `callAI()` labels; optional future local aggregate in scanner run summaries.

**Key Metrics to Track:**
- AI calls per scanner run and per eligible ambiguous page.
- AI schema failure and corrective retry rates.
- Deterministic validation failures after AI output.
- Scrub failures blocked before publish.
- Review queue creation rate by reason.

**Planner Checklist:**
- [x] Reuse existing bounded-AI helpers rather than adding an AI framework.
- [x] Keep AI behind deterministic scanner gates.
- [x] Validate model output with JSON Schema and deterministic URL/provider checks.
- [x] Fail closed on private-field scrub violations.
- [x] Do not call AI for empty, blocked, robots-disallowed, login-gated, or no-result pages.
- [x] Keep public sync payloads free of raw prompt, raw model text, page body, and private state.
