# Provider-neutral model and reasoning routing audit

Date: August 27, 2026  
Audited head: `9884ea4` (`docs(planning): audit chat lifecycle durability`)  
Scope: Claude Code 2.1.247, Codex CLI 0.150.1, installed-CLI calls, Anthropic-shaped BYOK/proxy calls, Paul chat, skill runs, bounded helpers, AI job search, Deep Ingest, missions, mock interviews, application work, persistence, retry, resume, settings, and usage receipts.

## Verdict

Claude Code and Codex are equal first-class engine choices at the capability gate, but they are not yet equal first-class choices for model quality and reasoning control.

CareerRat currently has three separate routing ideas:

1. engine selection chooses Claude Code or Codex correctly;
2. `tier: "smallFast"` chooses an Anthropic small model only for Claude and Anthropic API-shaped calls; and
3. a few BYOK helpers send `effort: "low"` directly to Anthropic.

There is no provider-neutral policy joining those ideas. Paul, skill runs, search, Deep Ingest, mock interviews, and application work generally resolve whatever global model happens to be configured. Installed Codex ignores the cheap tier. Both installed CLIs ignore reasoning effort. High-value coaching is sometimes forced onto the cheap tier or low effort, while background search can consume the same model as Paul. The user cannot control any of this from Settings.

The fix is not a model-provider framework. CareerRat already owns the correct abstraction boundary: an installed agent runtime plus scoped CareerRat tools. Add one operation-policy resolver above the existing Claude and Codex adapters. Its product inputs are quality preset, reasoning preference, and operation class. Its provider output is an immutable execution plan with a resolved model and effort. `usage_mode` must continue to control how much work runs, not how smart Paul is.

## What is sound today

- `src/core/ai/runtime-selection.mjs` and `src/cli/installed-runtime-route.mjs` persist and validate an installed runtime independently of provider credentials.
- `src/core/ai/installed-runtimes.mjs` gives Claude Code and Codex the same accepted workflow capabilities and applies provider-specific fixed invocation boundaries.
- `callAI`, `runBoundedAI`, `runSkillStream`, and the chat runtime are already narrow seams through which an execution plan can pass.
- `runBoundedAI` already accepts explicit `model`, `effort`, and `tier` inputs, and Anthropic BYOK already places effort in `output_config.effort`.
- Sourcing runs, mission attempts, mock sessions, skill-chat threads, and workspace messages already provide places to persist non-secret routing provenance.
- The current Codex adapter already uses per-invocation `-c` overrides for scoped MCP configuration without touching `~/.codex/config.toml`. Reasoning configuration fits the same pattern.
- Usage records never persist prompts, job descriptions, or resumes. Routing provenance can be added without weakening that privacy boundary.

## Confirmed native capability surface

### Claude Code

Local `claude --help` on 2.1.247 confirms:

- `--model <model>` with aliases such as `haiku`, `sonnet`, and `opus`;
- `--effort <level>` with `low`, `medium`, `high`, `xhigh`, and `max`; and
- `--fallback-model <model>` for overload/unavailability fallback.

The installed `@anthropic-ai/claude-agent-sdk` typings expose `options.model`, `options.effort`, `Query.supportedModels()`, and per-model `supportedEffortLevels`, `supportsAdaptiveThinking`, and `supportsFastMode`. CareerRat's SDK calls currently pass none of those options.

Official reference: <https://code.claude.com/docs/en/cli-usage>

### Codex

Local `codex exec --help` on 0.150.1 confirms `--model` and per-invocation `--config key=value`. A local parse check accepted:

`codex features list -c 'model_reasoning_effort="medium"'`

The current account's `codex debug models` catalog reports:

| Product tier | Current native candidate | Current reasoning support |
| --- | --- | --- |
| Best | `gpt-5.6-sol` | low, medium, high, xhigh, max, ultra |
| Balanced | `gpt-5.6-terra` | low, medium, high, xhigh, max, ultra |
| Fast | `gpt-5.6-luna` | low, medium, high, xhigh, max |

Those model IDs are current discovery results, not permanent product constants. Codex also reports `fast` as an additional service tier. That setting changes latency and subscription usage for the same model; it is not a quality preset and must not be silently coupled to the UI's Faster quality choice.

Official references: <https://developers.openai.com/api/docs/guides/latest-model> and <https://learn.chatgpt.com/docs/config-file/config-reference>

## Current routing map

| Surface | Current route | Current quality behavior | Durable routing provenance |
| --- | --- | --- | --- |
| Main Paul workspace chat | `callAI` in `workspace-agent.mjs:9112-9173` | CLI default/global model; no operation policy or effort | Message stores returned model, usage, engine, elapsed time only |
| Onboarding and research skill chats | `chat-runtime.mjs` | installed global model or SDK default; no effort | Transcript and turn state survive; route/model policy is in memory only |
| One-shot full skills | `skill-runtime.mjs:520-755` | installed global model or SDK default; no per-operation input | Usage may store returned model; no plan |
| AI web search | `ai-web-search.mjs:391-590` through `runSkillStream` | same global/default model as full skills | Sourcing run stores prompts/progress but no provider/model/effort plan |
| Search-prompt generation | `search-prompts.mjs:332-365` through `runBoundedAI` | default/global model | Bounded response metadata may contain model only |
| Job-thread coaching | `chat-first.mjs:780-906` | always `smallFast` | Assistant metadata can store bounded `ai.model`, not effort/policy |
| Mock interview question and feedback | `chat-first.mjs:2050-2535` through the same helper | always `smallFast` | Session, answers, feedback, and model-shaped metadata survive |
| Deep Ingest proposals | `deep-ingest/proposals/shared.mjs:174-235` | default/global except role signals use `smallFast` | Source/proposal result survives; no execution plan |
| Missions | `chat-first.mjs:1642-1916` | deterministic orchestration; each evaluation/document step independently resolves current globals | Strong attempt/lease receipts, but no provider/model plan |
| Packet gate and fit-gap coaching | `packet/gate.mjs:285-325`, `coaching/plan.mjs:259-285` | explicit `effort: "low"` on Anthropic routes; installed CLIs ignore it | Bounded model only |
| Resume, cover letter, application answers | packet bounded calls | default/global model and default effort | Result artifacts survive; no requested/resolved plan |
| Resume/intake extraction | `onboard-route.mjs:2115-2198`, `intake-route.mjs:285-321` | first resume attempt injects Anthropic fast model by environment; correction retry silently returns to global model; Codex does not receive that fast override | Uploaded input survives; execution route does not |
| Bounded assists/classifiers | `assist-route`, scheduling, outcome classification, company domain fill, public scanner | `smallFast` or explicit low effort where callers remembered to add it | Usually model only |

## Prioritized findings

### P0.1 Add one provider-neutral execution-plan contract

The missing abstraction belongs above `callAI`, `runSkillStream`, and `createChatRuntime`, not inside each feature. Every model-backed operation should resolve this shape exactly once before it starts:

```ts
type AIRequestPolicy = {
  operation: AIOperation;
  quality: "automatic" | "fast" | "balanced" | "best";
  reasoning: "automatic" | "low" | "medium" | "high";
};

type AIExecutionPlan = {
  policyVersion: number;
  operation: AIOperation;
  runtimeId: "claude" | "codex" | "anthropic-api" | "managed-anthropic";
  adapterVersion: number;
  requested: { quality: string; reasoning: string };
  resolved: {
    model: string | null;
    modelSource: "catalog" | "alias" | "operator-override" | "provider-default";
    effort: string | null;
    speedTier: string | null;
  };
  fallback: null | {
    reason: string;
    fromModel: string | null;
    toModel: string | null;
    fromEffort: string | null;
    toEffort: string | null;
  };
};
```

The plan contains no prompt or candidate data. Runtime selection remains separate. `usage_mode` remains separate. A raw provider model ID remains an Advanced operator override, not the normal product setting.

Recommended implementation seams:

- new `src/core/ai/operation-policy.mjs`: operation defaults and product preference merge;
- new `src/core/ai/runtime-adapter.mjs`: runtime catalog normalization and provider mappings;
- new `src/core/ai/ai-preferences.mjs`: 0600, atomic, `userPath`-resolved app preference owner;
- extend `callAI`, `runSkillStream`, and chat session creation to accept `executionPlan`, with legacy explicit model/effort inputs normalized through the same resolver during migration; and
- expose a read/write settings route alongside the runtime routes without merging the data into candidate modes.

### P0.2 Thread model and effort through both installed adapters and the SDK path

`buildInstalledRuntimeInvocation` accepts only `model`. `runInstalledRuntime`, `runInstalledAI`, and `runSkillStream` drop effort. The SDK calls in `skill-runtime.mjs:665-700` and `chat-runtime.mjs:1120-1135` omit both model and effort even though the installed SDK supports them.

Required mappings:

- Claude CLI: `--model <resolved>` and `--effort <resolved>`.
- Claude Agent SDK: `options.model` and `options.effort`.
- Codex CLI: `--model <resolved>` and `-c model_reasoning_effort=<TOML string>`.
- Anthropic API/proxy: existing `model` and `output_config.effort` path.

Do not use Codex `service_tier="fast"` as a reasoning or model-quality mapping. If CareerRat later exposes priority execution, treat it as a separate, capability-gated setting with clear usage implications.

Three focused test-first assertions were already present but failing during this audit:

- installed `callAI` drops `effort: "high"`;
- Claude and Codex invocation builders omit their effort flags; and
- `runSkillStream` ignores explicit operation-level model and effort.

Focused verification result: 3 tests run, 0 passed, 3 failed. These failures are the expected implementation gap, not unrelated regressions.

### P0.3 Stop spending the cheap path on Paul and consequential coaching

`runChatFirstAI` hardcodes `tier: "smallFast"` for every job-thread reply and every mock-interview question/feedback turn. Packet-gate evaluation and fit-gap coaching hardcode low effort. These are exactly the places where the product is supposed to behave like a good career coach.

Use operation defaults instead:

| Operation class | Automatic quality | Automatic reasoning | Examples |
| --- | --- | --- | --- |
| `paul.conversation` | best | medium | main Paul, onboarding interview, job-thread coaching |
| `coach.deep` | best | high | mock feedback, strategy review, career expansion, interview coaching |
| `application.judgment` | best | high | packet gate, job evaluation, answer grounding |
| `application.drafting` | best | medium | resume, cover letter, screening answers |
| `research.web` | balanced | medium | AI job search, board/company/comp research |
| `structured.extraction` | balanced | medium | resume/intake extraction, evidence and story ingest |
| `bounded.classification` | fast | low | intake routing, source-page extraction, scheduling parse, status classification, small suggestions |

Automatic should be the default UI choice. It does not mean provider default. It means the operation table above. Paul therefore defaults to the strongest suitable model, while search and bounded helpers do not.

### P0.4 Give Codex real fast/balanced/best parity

`resolveInstalledModel` in `call-ai.mjs:391-415` deliberately ignores `smallFast` for Codex because the existing config contains Anthropic model IDs. That was safe, but it leaves every Codex operation on one global/default model.

The adapter should map product tiers against a probed catalog:

| Product quality | Claude adapter | Codex adapter, current catalog |
| --- | --- | --- |
| fast | `haiku` | `gpt-5.6-luna` |
| balanced | `sonnet` | `gpt-5.6-terra` |
| best | `opus` | `gpt-5.6-sol` |

Claude aliases are documented CLI inputs. Codex IDs must come from discovery and be cached with the runtime version and checked time. If catalog discovery fails, keep the chosen provider, use its explicit provider default, and record a visible degraded plan. Never pass an Anthropic ID to Codex, never switch providers automatically, and never claim a requested preset was honored when it was not.

### P0.5 Persist the product preferences and make them understandable

Settings currently offers only “Change engine.” Add two provider-neutral controls:

- **Paul quality:** Automatic (recommended), Faster, Balanced, Best.
- **Thinking depth:** Automatic (recommended), Low, Medium, High.

Copy should explain outcomes, not provider internals:

- Automatic: “Uses the best fit for each task. Paul stays strong; searches and small helpers stay efficient.”
- Faster: “Quicker replies with a lighter model.”
- Balanced: “A middle ground for speed and depth.”
- Best: “Uses the strongest available model for Paul.”
- Thinking Automatic: “CareerRat chooses by task.”
- Low/Medium/High: “Spend less/more time reasoning before replying.”

Use a keyboard-operable radio group, show a saved state, and display a small runtime-specific receipt only in technical details. Do not expose Opus versus Sol as a provider comparison and do not call the choices “smarter” and “dumber” in the shipped UI.

Store these preferences in app-local internal state, not `candidate/modes.yml`. `usage_mode` controls breadth, prompt count, and discretionary work (`modes.mjs:3-6, 48-84`). Overloading it with model quality would make cost, behavior, and UI impossible to reason about.

### P0.6 Freeze and persist every long-running operation's route

The model route is currently re-resolved from mutable Settings and environment state inside each call. That breaks honest retry/resume:

- a multi-prompt AI search can switch runtime or model between prompts;
- a resume-extraction correction retry intentionally changes from the fast Anthropic override back to the global model without recording the escalation;
- a mission's evaluation and document steps can use different providers after a Settings change;
- a durable skill chat resumes after app restart against whatever route is current, not the route that owned an unfinished assistant turn.

Resolve the execution plan before the durable start write and store it on the owning operation:

- sourcing run: `metadata.aiExecutionPlan`, plus each prompt attempt's receipt;
- skill chat: thread/session plan and per-turn execution receipt;
- workspace chat: assistant message metadata and an awaiting-assistant turn envelope;
- mock interview: session policy plus each generated question/feedback receipt;
- mission: selected runtime and policy version on the mission, resolved plan on each AI-bearing attempt;
- Deep Ingest and resume/intake extraction: the durable operation records required by the lifecycle audit; and
- usage event: requested and effective non-secret fields.

Retries for schema correction reuse the exact plan. Provider overload/unavailability may fall back only within the same provider and declared quality class, and only when the actual model can be identified afterward. Otherwise fail with a people-shaped retry. A Settings change never mutates an in-flight plan. The next new turn may use the new preference; a resumed unfinished turn must use its stored plan or create an explicitly linked retry that says what changed.

### P1.1 Expand usage receipts beyond `model`

`usage-log.mjs:174-255` canonicalizes model, labels, counts, upstream, and cost. It discards quality, effort, runtime, policy version, and fallback information. `bounded-ai.mjs:54-66` likewise strips AI metadata down to mode and model.

Add these non-secret receipt fields:

- runtime/provider ID;
- operation class;
- requested and resolved quality;
- requested and resolved reasoning;
- requested and reported/effective model;
- requested and reported/effective effort;
- adapter and policy version;
- fallback reason; and
- owning run/turn/attempt ID where one exists.

Codex result parsing currently returns `model: null`, so usage is recorded as `installed:codex`. When CareerRat passes an explicit model, record it as `requestedModel` and mark its evidence as requested unless Codex reports the actual model. Do not mislabel an unreported provider default as a concrete model.

Installed subscription calls can remain `priced: false`; the goal is routing observability, not fabricated dollar pricing.

### P1.2 Make capability discovery tolerant and honest

Do not hardcode today's complete catalog forever.

- Claude SDK routes can read `Query.supportedModels()` after initialization and cache supported effort levels.
- Claude CLI routes can use documented aliases, version/help capability evidence, and a tolerant fallback to provider default when an alias is unavailable.
- Codex can probe its local model catalog with a short timeout, cache it by CLI path/version, and treat the probe as optional because `debug models` is not a public stability guarantee.
- Operator raw-model overrides remain valid only for the selected runtime and should be validated when the catalog is available.

The resolver returns both requested and resolved values. An unsupported effort should step down to the nearest supported value within that provider, attach a fallback reason, and show it in technical details. It must not silently route to the other provider.

### P1.3 Keep BYOK/proxy support behind the same contract

Provider fallback is Anthropic-shaped today. That is acceptable because the packaged product choices are installed Claude Code and Codex, not API vendors. Do not add LiteLLM, LangChain, or Vercel AI SDK just to normalize installed CLIs. Those frameworks abstract API calls and would not solve CareerRat's CLI session, tools, cancellation, authentication, or persistence contracts.

Replace the product-facing dependence on `config/ai.json#model/smallFastModel` with the same quality/reasoning policy. Keep raw `ANTHROPIC_MODEL`, `ANTHROPIC_SMALL_FAST_MODEL`, and config IDs as Advanced operator overrides. Managed and BYOK Anthropic routes then consume the Claude adapter mapping like installed Claude Code.

## Workflow-specific requirements

### Paul and durable skill chats

- Main Paul and job threads default to `paul.conversation`, not small-fast.
- Mock interview feedback and strategy coaching use `coach.deep`.
- Persist the plan before an assistant turn begins.
- A settings change rotates a long-lived SDK session between turns, using the durable transcript. It never changes an in-flight child.
- App restart resumes an unfinished turn with the stored plan. A normal next user turn may adopt newly saved preferences and records that boundary.

### AI job search

- Search-prompt generation may use `bounded.classification` or `research.web` depending on complexity; the web sweep itself uses `research.web`.
- One sourcing run freezes provider, policy version, quality, and effort before its two concurrent prompt workers start.
- Every prompt attempt and schema-correction retry reuses that plan.
- The existing progress, lease, shutdown abort, exact-run follow, and retry lineage remain unchanged.
- `usage_mode` still controls one, three, or five saved prompts. It does not select a smaller model.

### Deep Ingest and extraction

- Resume/intake extraction and evidence/story/honesty lanes use `structured.extraction`; simple role-signal classification may remain `bounded.classification`.
- Remove the first-attempt-only environment override. An escalation must be an explicit policy fallback and durable receipt, not a different environment object on retry.
- A source scan/proposal operation stores its route before starting and reuses completed lane results after restart.

### Missions and applications

- Missions stay provider-fixed from creation through completion. Each AI-bearing step resolves a model for its operation class under that provider.
- Evaluation/packet gate uses `application.judgment`, document generation uses `application.drafting`, and browser form fill remains deterministic/browser-controlled.
- Store the execution plan on the claimed step attempt beside the existing lease, fence, idempotency, and receipt.
- Resume/reconcile never blindly reruns an unknown side effect. Model fallback does not broaden the existing human-submit boundary.

### Mock interview

- First question and feedback use `coach.deep`, not `smallFast`.
- Persist the session policy and per-turn receipt. The existing saved-answer/reused-feedback logic remains the correct retry shape.
- If a failed answer turn is retried, reuse the same plan unless the user explicitly chooses a new retry after a clear route-change notice.

## Test and QA gate

### Unit and contract tests

1. Operation-policy matrix for every operation class, each user preset, and both runtimes.
2. Exact Claude argv: model plus effort.
3. Exact Codex argv: model plus TOML-quoted `model_reasoning_effort` override.
4. SDK query options contain model and effort in skill and chat paths.
5. Anthropic request body contains mapped model and `output_config.effort`.
6. No Claude model ID ever reaches Codex; no Codex model ID reaches Claude.
7. Unsupported model/effort produces a recorded same-provider fallback or an actionable error.
8. `usage_mode` changes work breadth only; Paul quality and reasoning preferences do not alter prompt count.
9. Every usage receipt records requested/resolved plan fields without prompt content.
10. Settings preferences survive app restart and runtime switching.

### Durability tests

For AI search, Deep Ingest, resume extraction, mission steps, mock turns, and durable chat:

1. change model settings while the operation is running;
2. close the modal, switch threads, reload, and reconnect;
3. stop and restart the app after durable start and after progress;
4. trigger a schema-correction retry;
5. make the selected model unavailable;
6. click retry twice; and
7. verify one provider, one immutable plan per attempt, explicit lineage, no duplicate write, and no silent fallback.

### Live acceptance on both installed CLIs

Run the same product fixtures with Claude Code and Codex:

- one main Paul turn and one follow-up after restart;
- one AI web search with locality filters and durable progress;
- one small bounded classification;
- one resume extraction;
- one mock-interview question/answer/feedback turn;
- one mission through evaluation and packet generation to the supervised submit gate; and
- one forced unsupported-effort fallback.

Assert domain outcomes and schema validity, not identical prose. Technical details and usage receipts must show the selected provider, product preset, resolved model, effort, and any fallback. The normal UI must never rank Claude against Codex or imply the user chose the wrong engine.

## Delivery order

1. Land the resolver contract, provider adapters, and invocation/SDK effort plumbing.
2. Convert Paul, job threads, mock interviews, packet gate/coaching, search, extraction, and bounded helpers to named operation classes.
3. Add durable app preferences and Settings controls.
4. Freeze/persist plans on sourcing runs, chats, mocks, missions, and the new durable extraction/Deep Ingest operations.
5. Extend bounded and usage receipts.
6. Add capability discovery and honest fallback handling.
7. Run unit, restart/failure-injection, and live Claude/Codex acceptance.

This order gives Codex immediate reasoning parity without waiting for the whole UI, then makes routing durable before release QA.
