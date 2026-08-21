# Search-shape eval: Career Ops discipline vs CareerRat's agent lanes

Status: planned (analysis complete 2026-08-15)

## What the decomposition found

Career Ops (the upstream provider project whose adapters CareerRat vendors) runs a
strictly additive, cost-gated cascade: local parser scripts, then direct careers-page
navigation, then the deterministic ATS API adapters, and only last a broad WebSearch
fan-out built from hand-written query templates. The model's job at that last level is
narrow: run the templated query, extract the lead, hand it to the same deterministic
filter/dedupe chain everything else uses. An upstream rule makes the discipline
explicit: never trust WebSearch or WebFetch to certify that a posting is live; every
web-sourced lead gets a mandatory browser liveness re-check before it is trusted. The
model discovers; it never certifies.

CareerRat's deterministic sweep is architecturally the same as the upstream ATS layer,
including a pure-code fit scorer (`scoreSourcedOfferFromConfig` in
`src/core/scoring/sourced-scanner.mjs`) that writes `fitScore`/`fitBucket` before any
agent sees the entry. Two divergences from the upstream discipline:

1. The AI web-search lane (`src/core/search/ai-web-search.mjs`) has no Bash access, so
   it cannot call the deterministic scorer. It re-derives fit per posting in natural
   language at full model tier, and it persists survivors with no liveness re-check.
   The deterministic sweep has a `--verify` pass; this lane has nothing.
2. The `search-jobs` skill text tells the agent to "emit" fit fields that the scanner
   already computed and wrote into the intake file, without distinguishing "read the
   stored value" from "recompute it." Possible pure restatement cost.

Caveat: the cascade description of upstream's outer orchestrator rests on the research
note `.internal/research-careerops-websearch-2026-07-12.md` (a read of the real upstream
checkout); this repo vendors only the adapter layer. Re-verify against upstream before
citing the cascade externally.

## Eval design

Axes: recall of real relevant postings, triage precision (fitBucket agreement with a
human-labeled ground truth), freshness at capture, cost (tokens and wall-clock per 100
postings), and failure modes (dead links, duplicate floods, hallucinated postings).

- **Phase 1, fixtures only.** Run the deterministic scanner against the pinned provider
  conformance fixtures (`tests/fixtures/career-ops/providers/`) as a static corpus.
  Hand-label 50 to 100 postings across provider types as ground truth and score the
  deterministic scorer's bucket accuracy. No network, fully repeatable.
- **Phase 2, frozen-prompt LLM triage.** Feed the same labeled postings through the AI
  web-search lane's scoring logic offline (sample context from `examples/demo-workspace`,
  skip the live search call). Compare fitBucket agreement, tokens, and wall-clock per
  posting against Phase 1 on identical postings.
- **Phase 3, live pass.** The only phase that needs the network: run both lanes against
  the same live target set for N days. Measure novel-posting recall the adapters cannot
  reach (companies with no ATS presence) and the 48-hour dead-link rate of AI-lane
  survivors vs the `--verify`-checked deterministic lane.

Decision rule: if Phase 2 shows the LLM disagreeing with the deterministic scorer on
more than 10 to 15 percent of postings both can see, and Phase 3 shows a materially
higher dead-link rate in the AI lane, port the upstream discipline in rather than
abandoning the lane: the AI lane calls the deterministic scorer for fit, and its
survivors get a mandatory liveness re-check before persistence.

**Decision, 2026-08-21: HOLD the port.** Phases 1-2 ran (#165; numbers and caveats in
`SEARCH-SHAPE-EVAL-RESULTS.md`). Measured AI-vs-deterministic disagreement was 14.5%,
inside the band at its top edge, but the run cannot trigger the rule: Phase 3's
dead-link half never ran (fixtures-only scope), the deterministic baseline was
degenerate on the corpus (stretch on 62/62, so agreement measured the label
distribution rather than discrimination), and the run surfaced a confounder that
invalidates the comparison as run: `buildSearchPromptContext()` never passed
`targeting.yml`'s top-level keep/cut signals to the AI lane at all. That fix landed
(#166). The port question reopens only if Phase 3 runs after that fix and the
remeasured pair still trips both halves of the rule.

## Companion fixes (independent of the eval outcome)

- **Installed-CLI model tiering is dropped.** `callAI({tier: "smallFast"})` correctly
  routes cheap classification stages to `config/ai.json#smallFastModel` on the BYOK and
  proxy routes, and six call sites already use it. But `runInstalledAI()` in
  `src/core/ai/call-ai.mjs` ignores the per-call `model`/`tier` arguments and pins every
  installed-CLI call to the single global `CAREERRAT_INSTALLED_AI_MODEL` env var, even
  though `buildInstalledRuntimeInvocation()` already supports a per-call `--model` flag
  for both claude and codex. Fix: resolve tier the same way the non-installed branch
  does and thread the model through the existing parameter. Subscription-CLI users then
  get the same cheap/smart split as API-key users.
- **Context digests for fan-out.** The `evaluate-job` parallel subagents each re-read
  raw config from disk in a fresh context. Pass the orchestrator's already-computed
  STEP 0 digest (targeting, profile, tracker summary) in the dispatch prompt instead.
  Similarly, extend `buildSearchPromptContext` with a compact company-history and
  application-limit summary so the AI web-search lane can apply those flags at all;
  today they are scoped out by construction.
- **Skill-text tightening.** `search-jobs` STEP 3 should say "read the stored triage
  fields" explicitly so agents never recompute what the scanner already wrote.
