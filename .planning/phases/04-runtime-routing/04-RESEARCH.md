# Phase 04: runtime-routing - Research

**Researched:** 2026-07-05
**Domain:** Local runtime routing, discovery UI routing, allowlisted skill runtime, runtime capability config
**Confidence:** HIGH

## User Constraints

No Phase 04 CONTEXT.md exists; the user explicitly selected "continue without context and research first." [VERIFIED: init.phase-op]

Phase 04 must address RUNT-01, RUNT-02, and RUNT-03. [VERIFIED: .planning/REQUIREMENTS.md]

Phase 04 success criteria are: discovery controls call the new company discovery API by default, `POST /api/skill/run` stays documented and allowlisted, discovery chat handoffs remain available for agent-led workflows, and runtime config exposes enough capability information for the UI to hide or degrade unavailable AI controls. [VERIFIED: .planning/ROADMAP.md]

## Project Constraints (from AGENTS.md)

- Skills are workflow contracts and procedural "how-to" sources; runtime work should use the owning skill when doing job-search execution, but this phase is planning research and should not execute job-search skills. [VERIFIED: AGENTS.md]
- Discovery workflow order is `setup-searches -> research-boards -> discover-companies -> search-jobs`; Phase 4 must not remove the chat handoffs that support this order. [VERIFIED: AGENTS.md]
- DB workspaces use `rolester data <verb>` for tracker-visible mutations; generated `workspace/tracker.json` and `workspace/activity.jsonl` must not be hand-edited in DB mode. [VERIFIED: AGENTS.md]
- Consequential discovery writes remain confirm-first; accepted company/source writes must go through the existing source-config or company write path, not UI-side JSON edits. [VERIFIED: AGENTS.md]
- The browser automation permission model stays opt-in and is outside this phase's default local discovery route. [VERIFIED: AGENTS.md]
- Code and UI must stay domain-neutral and must not hardcode real employer, role, compensation, or candidate-preference defaults. [VERIFIED: AGENTS.md]
- Current compensation is private; code may use minimum and target compensation screens where already approved, but must not expose `current_base` or current-comp fields in prompts or public responses. [VERIFIED: AGENTS.md]
- Dashboard-visible state changes require the established write, verify, render/export, and activity pulse contracts; Phase 4 should reuse Phase 3 decision routes rather than adding a new writer. [VERIFIED: AGENTS.md]

<phase_requirements>

## Phase Requirements

| ID | Description | Research Support |
|----|-------------|------------------|
| RUNT-01 | `POST /api/skill/run` remains allowlisted and documented as the path for tool-heavy or long-running skill workflows. [VERIFIED: .planning/REQUIREMENTS.md] | Existing one-shot runtime is isolated in `src/cli/skill-run-route.mjs` and `src/core/ai/skill-runtime.mjs`; focused tests already cover allowlist, body cap, SSE framing, abort, no-AI, SDK missing, and default skills. [VERIFIED: codebase grep] [VERIFIED: tests] |
| RUNT-02 | App discovery controls call local API routes for deterministic or bounded-AI work instead of launching a whole skill session. [VERIFIED: .planning/REQUIREMENTS.md] | Phase 3 shipped local proposal and decision routes, but `CompaniesStep.jsx` still renders `ChatPanel skill="discover-companies"` as the default company discovery control. [VERIFIED: codebase grep] |
| RUNT-03 | Conversational agent handoffs still have a clear prompt/spec path for cases where the user wants the agent to drive the workflow. [VERIFIED: .planning/REQUIREMENTS.md] | `/api/discovery/quick-start`, `/api/discovery/next`, `ChatPanel`, and chat-runtime tests already preserve explicit discovery chat handoffs for `research-boards`, `discover-companies`, and `search-jobs`. [VERIFIED: codebase grep] [VERIFIED: tests] |

</phase_requirements>

## Summary

Phase 4 is primarily a routing and capability-surface phase, not a new discovery-engine phase. Phase 3 already shipped `POST /api/discovery/company-proposals`, `GET /api/discovery/company-proposals`, and `POST /api/discovery/company-proposal-decisions`; those routes delegate to core proposal and decision functions, persist proposal state, and write confirmed supported ATS additions only through existing source-config/sourced paths. [VERIFIED: .planning/phases/03-company-discovery-api/03-VERIFICATION.md] [VERIFIED: codebase grep]

The current app still contains chat-first discovery controls: `CompaniesStep.jsx` renders `ChatPanel skill="discover-companies"` as the "Roland - find companies for you" control, and `FinishStep.jsx` uses `/api/discovery/quick-start` and `/api/discovery/next` to start or reuse discovery chats. [VERIFIED: codebase grep] The planning boundary is therefore to reroute the default company-discovery affordance to the local proposal APIs while preserving explicit agent-led discovery handoffs. [VERIFIED: .planning/ROADMAP.md] [ASSUMED]

**Primary recommendation:** add app API wrappers and a proposal confirmation UI for the Phase 3 company proposal routes, expose runtime capability metadata from `/api/runtime/config`, make the default Companies step use local proposals, and keep chat handoff controls as an explicit secondary path for agent-led discovery. [VERIFIED: codebase grep] [ASSUMED]

## Architectural Responsibility Map

| Capability | Primary Tier | Secondary Tier | Rationale |
|------------|--------------|----------------|-----------|
| Default company discovery control | Browser / Client | API / Backend | The current default control lives in `apps/web/src/onboarding/steps/CompaniesStep.jsx`; it should call app API wrappers instead of embedding a chat panel as the default action. [VERIFIED: codebase grep] |
| Company proposal generation | API / Backend | Bounded AI | `src/cli/discovery-route.mjs` owns `POST /api/discovery/company-proposals`, and core proposal generation calls bounded/manual seeds plus deterministic resolver/scanner/gate logic. [VERIFIED: codebase grep] [VERIFIED: 03-VERIFICATION.md] |
| Proposal confirmation writes | API / Backend | Database / Storage | `POST /api/discovery/company-proposal-decisions` delegates to `applyCompanyProposalDecision()` and the confirmed write seams, preserving expected-version conflict handling and source-config/sourced ownership. [VERIFIED: codebase grep] [VERIFIED: .planning/STATE.md] |
| Retained full skill runtime | API / Backend | Local Agent SDK runtime | `POST /api/skill/run` is mounted by `src/cli/skill-run-route.mjs`, streams SSE, and is narrowed by `resolveAllowedSkills()` over `ROLESTER_RUNTIME_SKILLS`. [VERIFIED: codebase grep] |
| Discovery chat handoffs | API / Backend | Browser / Client | `/api/discovery/quick-start` and `/api/discovery/next` start or reuse `/api/chat/*` sessions, while `ChatPanel.jsx` subscribes to the visible session. [VERIFIED: codebase grep] |
| Runtime capability exposure | API / Backend | Browser / Client | `GET /api/runtime/config` currently returns only one-shot skill names; Phase 4 should extend this read-only route so UI controls do not infer AI/chat availability from hardcoded booleans. [VERIFIED: codebase grep] [ASSUMED] |

## Standard Stack

### Core

| Library / Module | Version | Purpose | Why Standard |
|------------------|---------|---------|--------------|
| Node.js | >=24; local command reports v24.18.0 | HTTP route mounters, `node:test`, filesystem and DB-backed local runtime | The repo requires Node >=24 and current backend tests run under Node v24.18.0. [VERIFIED: package.json] [VERIFIED: command output] |
| React | ^19.0.0 | App onboarding and dashboard UI controls | The app workspace already uses React for `CompaniesStep`, `FinishStep`, `ChatPanel`, and shared components. [VERIFIED: apps/web/package.json] [VERIFIED: codebase grep] |
| Vite | ^6.0.0 | Web app build/test tooling | The app workspace uses Vite scripts for build/dev and Vitest test execution. [VERIFIED: apps/web/package.json] |
| Vitest | ^3.0.0; local command reports 3.2.6 | React unit/render tests | Existing `FinishStep.test.jsx` uses Vitest and passed in this research run. [VERIFIED: apps/web/package.json] [VERIFIED: command output] |
| Node built-in `node:test` | Node v24.18.0 | Backend route/runtime tests | Existing route and runtime tests use `node:test` and passed focused gates in this research run. [VERIFIED: tests] [VERIFIED: command output] |
| `@anthropic-ai/claude-agent-sdk` | ^0.3.199 | Retained full skill and chat runtime | Existing runtime code lazy-loads the SDK and tests cover missing-SDK degradation; Phase 4 should not add a replacement. [VERIFIED: package.json] [VERIFIED: codebase grep] |

### Supporting

| Library / Module | Version | Purpose | When to Use |
|------------------|---------|---------|-------------|
| `src/cli/discovery-route.mjs` | local module | Company proposal routes and discovery chat handoff routes | Use as the single HTTP mount for Phase 4 discovery routing changes. [VERIFIED: codebase grep] |
| `src/core/discovery/company-proposals.mjs` | local module | Seed -> resolver -> scanner -> capture -> gate -> proposal batch | Use for default app company proposals; do not duplicate this pipeline in React. [VERIFIED: 03-VERIFICATION.md] |
| `src/core/discovery/company-proposal-decisions.mjs` | local module | Approve/reject/suppress/escalate/refresh proposal decisions | Use for confirmation UI actions and expected-version conflict handling. [VERIFIED: codebase grep] [VERIFIED: tests] |
| `src/core/ai/skill-runtime.mjs` | local module | One-shot full skill runtime and allowlist | Keep for RUNT-01 and existing evaluate/answer/tailor/resume flows. [VERIFIED: codebase grep] |
| `src/core/ai/chat-runtime.mjs` | local module | Multi-turn chat runtime for agent-led workflows | Keep for RUNT-03 handoffs and explicit discovery chat. [VERIFIED: codebase grep] |

### Alternatives Considered

| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| Local company proposal API | `ChatPanel skill="discover-companies"` by default | Current behavior is available but starts a full conversational skill session for work Phase 3 decomposed into cheaper local APIs. [VERIFIED: codebase grep] [VERIFIED: .planning/PROJECT.md] |
| Existing decision route | UI-side source-config writes | Direct UI writes would bypass DB/source-config validation, expected-version handling, and confirm-first decision state. [VERIFIED: AGENTS.md] [VERIFIED: 03-VERIFICATION.md] |
| Extended `/api/runtime/config` | More independent settings endpoints | The existing runtime config route is already mounted with `POST /api/skill/run` and consumed by old runtime pages, so extending it keeps app capability checks in one read-only surface. [VERIFIED: codebase grep] [ASSUMED] |

**Installation:**

No new packages are recommended for Phase 4. [VERIFIED: package.json]

## Package Legitimacy Audit

No external packages should be installed for Phase 4; the plan should reuse existing Node, React, Vite, Vitest, route modules, runtime modules, and Phase 3 discovery modules. [VERIFIED: package.json] [VERIFIED: codebase grep]

**Packages removed due to [SLOP] verdict:** none. [VERIFIED: package.json]
**Packages flagged as suspicious [SUS]:** none. [VERIFIED: package.json]

## Architecture Patterns

### System Architecture Diagram

```text
User clicks company discovery control
  -> React Companies step
  -> apps/web/src/lib/api.js proposal wrapper
  -> POST /api/discovery/company-proposals
  -> createCompanyProposalBatch()
  -> manual seeds or bounded AI seeds
  -> deterministic board resolver
  -> supported ATS scanner and JD capture
  -> proposal gate and DB proposal batch
  -> React proposal review UI
  -> POST /api/discovery/company-proposal-decisions with expectedVersion
  -> applyCompanyProposalDecision()
  -> source-config/sourced DB write seams when approved

Explicit agent-led option
  -> React chat/handoff control
  -> POST /api/discovery/quick-start or POST /api/discovery/next
  -> chatRuntime.startSession()
  -> /api/chat/* visible multi-turn session

Full retained runtime
  -> explicit one-shot skill flow
  -> GET /api/runtime/config
  -> POST /api/skill/run
  -> resolveAllowedSkills()
  -> runSkillStream()
```

This diagram reflects existing Phase 3 route ownership plus the recommended Phase 4 UI routing change. [VERIFIED: codebase grep] [VERIFIED: 03-VERIFICATION.md] [ASSUMED]

### Recommended Project Structure

```text
apps/web/src/lib/api.js                         # add proposal read/create/decision wrappers [VERIFIED: codebase grep]
apps/web/src/onboarding/steps/CompaniesStep.jsx # default company proposal UX; keep chat secondary [VERIFIED: codebase grep] [ASSUMED]
apps/web/src/onboarding/steps/FinishStep.jsx    # keep discovery pipeline handoff UX for explicit agent-led flow [VERIFIED: codebase grep]
apps/web/src/onboarding/steps/*.test.jsx        # add CompaniesStep tests and update FinishStep tests [VERIFIED: codebase grep]
src/cli/skill-run-route.mjs                     # extend runtime config shape; keep POST /api/skill/run behavior [VERIFIED: codebase grep]
src/core/ai/skill-runtime.mjs                   # allowlisted one-shot runtime remains unchanged unless config helper is extracted [VERIFIED: codebase grep]
src/core/ai/chat-runtime.mjs                    # chat allowlist and capability source for discovery handoffs [VERIFIED: codebase grep]
tests/*runtime*.test.mjs                        # preserve allowlist/config/chat behavior [VERIFIED: tests]
tests/company-*discovery*.test.mjs              # preserve local proposal and decision route behavior [VERIFIED: tests]
```

### Pattern 1: Thin Route Adapters Over Core Seams

**What:** Route modules parse/cap bodies, call core functions, and map stable envelopes; business logic stays in core modules. [VERIFIED: codebase grep]

**When to use:** Use this pattern for any Phase 4 route/config extension so tests can inject seams and avoid SDK/network work. [VERIFIED: tests]

**Example:**

```javascript
// Source: src/cli/discovery-route.mjs [VERIFIED: codebase grep]
addRoute("POST", "/api/discovery/company-proposals", async (req, res) => {
  const body = await readJsonBodyCapped(req, COMPANY_PROPOSAL_BODY_MAX_BYTES);
  const result = await createCompanyProposalBatch({ repoRoot, env, body, fetchImpl });
  sendJson(res, 200, { ok: true, data: result.data, meta: result.meta });
});
```

### Pattern 2: Browser Calls API Wrappers, Not Raw Runtime Endpoints

**What:** `apps/web/src/lib/api.js` centralizes app fetch wrappers and comments the route contract. [VERIFIED: codebase grep]

**When to use:** Add `createCompanyProposals`, `getCompanyProposals`, and `decideCompanyProposal` wrappers before modifying React components. [ASSUMED]

**Example:**

```javascript
// Source pattern: apps/web/src/lib/api.js [VERIFIED: codebase grep]
export function startDiscoveryNext() {
  return apiFetch("/api/discovery/next", { method: "POST" });
}
```

### Pattern 3: Capability Config Is Read-Only and Conservative

**What:** `GET /api/runtime/config` currently returns the allowlisted one-shot skills; Phase 4 should extend it with one-shot skills, chat skills, discovery route support, and no-AI capability flags that the UI can use for hiding/degrading controls. [VERIFIED: codebase grep] [ASSUMED]

**When to use:** Use for page-load UI gating; do not make it perform writes or start SDK sessions. [VERIFIED: codebase grep]

**Recommended shape:**

```json
{
  "skills": ["evaluate-job", "answer-question", "tailor-application", "resume-extract"],
  "chatSkills": ["ingest-profile", "research-boards", "discover-companies", "search-jobs"],
  "ai": { "route": "byok|proxy|none", "available": true },
  "discovery": {
    "companyProposals": true,
    "chatHandoffs": true,
    "manualCompanySeeds": true
  }
}
```

This exact shape is a recommendation, not a locked user decision. [ASSUMED]

### Pattern 4: Explicit Agent-Led Fallback, Not Hidden Escalation

**What:** Chat handoffs should remain a visible user choice via `/api/discovery/quick-start`, `/api/discovery/next`, or `ChatPanel`; local proposal failures should not silently start chat. [VERIFIED: .planning/architecture/runtime-routing-policy.md] [VERIFIED: codebase grep]

**When to use:** Keep an "agent-led discovery" affordance after the local proposal control, especially for research-boards, ambiguous discovery, or user-led workflows. [VERIFIED: AGENTS.md] [ASSUMED]

### Anti-Patterns to Avoid

- **Defaulting company discovery to `ChatPanel`:** This keeps the expensive conversational runtime as the normal route even though Phase 3 shipped local proposal APIs. [VERIFIED: codebase grep] [VERIFIED: .planning/PROJECT.md]
- **Silent fallback from local route failure to chat:** This hides runtime cost and can turn deterministic failures into long tool sessions. [VERIFIED: .planning/architecture/runtime-routing-policy.md]
- **React-side proposal persistence:** This bypasses expected-version conflict protection and the source-config/sourced write seams. [VERIFIED: 03-VERIFICATION.md]
- **Expanding `ROLESTER_RUNTIME_SKILLS` to discovery by default:** Discovery chat belongs to `ROLESTER_CHAT_SKILLS`; one-shot full runtime defaults are currently evaluate/answer/tailor/resume. [VERIFIED: codebase grep] [VERIFIED: tests]
- **Treating model/manual URL hints as trusted URLs:** Phase 3 decisions require resolver validation before supported ATS promotion. [VERIFIED: .planning/STATE.md]

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Company proposal generation | A React-side seed/resolver/scanner loop | `POST /api/discovery/company-proposals` | Existing route already enforces body caps, batch bounds, resolver/scanner/gate flow, no confirmed writes, and stable envelopes. [VERIFIED: tests] |
| Proposal decision and confirmed writes | Direct source-config or tracker JSON edits | `POST /api/discovery/company-proposal-decisions` | Existing route owns expectedVersion, approve/reject/suppress/escalate/refresh, and confirmed write seams. [VERIFIED: tests] |
| Skill allowlist checks | Hardcoded UI skill lists only | `resolveAllowedSkills()` via `/api/runtime/config` | Existing runtime allowlist filters env requests against installed `.agents/skills`. [VERIFIED: codebase grep] |
| Chat session management | New SSE/chat transport | `/api/chat/*` and `ChatPanel.jsx` | Existing runtime owns long-lived sessions, reconnect/reuse, state events, interrupt, close, and chat allowlist. [VERIFIED: codebase grep] [VERIFIED: tests] |
| Runtime body parsing | Ad hoc JSON body reads | `readJsonBodyCapped()` | Existing helper enforces caps and clean 400/413 behavior. [VERIFIED: codebase grep] [VERIFIED: tests] |

**Key insight:** Phase 4 should route callers to owners that already exist; new code should mostly be adapter, config, UI state, and tests. [VERIFIED: .planning/PROJECT.md] [ASSUMED]

## Common Pitfalls

### Pitfall 1: Breaking Quick Start While Moving Company Discovery

**What goes wrong:** A plan removes or repurposes `/api/discovery/quick-start` even though it prepares source setup and starts the next discovery chat. [VERIFIED: codebase grep]

**Why it happens:** The current discovery UI mixes local setup prep, chat handoff, and company discovery language. [VERIFIED: codebase grep]

**How to avoid:** Move only the default company-finding control to local proposals; keep quick-start/next handoffs for explicit agent-led pipeline continuation. [ASSUMED]

**Warning signs:** Existing `tests/discovery-route.test.mjs` or `FinishStep.test.jsx` handoff tests fail without intentional replacement coverage. [VERIFIED: tests]

### Pitfall 2: Runtime Config Still Hides Important Capability State

**What goes wrong:** The UI checks only `aiEnabled` or only `skills`, so it cannot distinguish no AI route, no chat skill allowlist, local manual-seed availability, or one-shot runtime availability. [VERIFIED: codebase grep]

**Why it happens:** `GET /api/runtime/config` currently returns only `{ skills }`. [VERIFIED: codebase grep]

**How to avoid:** Extend runtime config with one-shot skill allowlist, chat skill allowlist, AI route availability, and discovery capability flags. [ASSUMED]

**Warning signs:** New controls gate local manual proposal reads behind AI even though `GET /api/discovery/company-proposals` and manual seeds do not require full chat. [VERIFIED: codebase grep] [ASSUMED]

### Pitfall 3: No-AI Path Starts a Full Skill

**What goes wrong:** A no-AI company proposal attempt falls into chat/full skill runtime instead of returning manual fallback metadata. [VERIFIED: .planning/STATE.md]

**Why it happens:** Chat is already wired and tempting as a fallback. [VERIFIED: codebase grep]

**How to avoid:** Preserve the Phase 3 behavior: no manual seeds plus no AI route returns the bounded 501 manual fallback; manual seeds and latest-pending reads remain local. [VERIFIED: .planning/STATE.md] [VERIFIED: tests]

**Warning signs:** Backend tests need to stub `chatRuntime.startSession()` as forbidden for company proposal routes. [VERIFIED: tests]

### Pitfall 4: Missing Proposal Version on Decisions

**What goes wrong:** The UI approves a stale proposal and mutates the wrong pending state. [VERIFIED: .planning/STATE.md]

**Why it happens:** Proposal cards can be refreshed or replaced while an older UI state is still visible. [ASSUMED]

**How to avoid:** Carry `proposal.version` or the expected version field through every decision POST and surface conflict errors as refresh prompts. [VERIFIED: .planning/STATE.md] [ASSUMED]

**Warning signs:** Decision tests for stale versions are removed or only exercise approve happy paths. [VERIFIED: tests]

### Pitfall 5: UI Test Coverage Stops at FinishStep

**What goes wrong:** Phase 4 changes CompaniesStep behavior without React tests covering local proposal calls or chat fallback visibility. [VERIFIED: codebase grep]

**Why it happens:** `apps/web/src/onboarding/steps/FinishStep.test.jsx` exists, but no `CompaniesStep.test.jsx` exists today. [VERIFIED: codebase grep]

**How to avoid:** Add a CompaniesStep test file in Wave 0 or the first implementation slice. [ASSUMED]

**Warning signs:** Only backend route tests change while the default UI still renders `ChatPanel skill="discover-companies"`. [VERIFIED: codebase grep]

## Code Examples

Verified patterns from local sources:

### Add API Wrappers Before Component State

```javascript
// Source pattern: apps/web/src/lib/api.js [VERIFIED: codebase grep]
export function getDiscoveryState() {
  return apiFetch("/api/discovery/state");
}

export function startDiscoveryNext() {
  return apiFetch("/api/discovery/next", { method: "POST" });
}
```

Phase 4 should add equivalent wrappers for proposal create/read/decision routes. [ASSUMED]

### Preserve Chat Handoff Prompt Guardrails

```javascript
// Source pattern: src/cli/discovery-route.mjs [VERIFIED: codebase grep]
buildDiscoveryKickoff({
  skill: normalized.nextSkill,
  message: normalized.message,
  source: "Continue discovery from the app.",
});
```

The existing kickoff text tells the skill not to auto-approve board/company writes and not to run apply/gate flows from discovery handoff. [VERIFIED: codebase grep]

### Keep Skill Runtime Status Failures Pre-Stream

```javascript
// Source pattern: src/cli/skill-run-route.mjs [VERIFIED: codebase grep]
if (!skill) {
  sendJson(res, 400, { error: "body.skill is required" });
  return;
}
```

`POST /api/skill/run` tests assert missing skill, malformed JSON, oversize body, no-AI, disallowed skill, and missing SDK return proper HTTP status before opening SSE. [VERIFIED: tests]

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| Treat skills as default app runtime | Treat skills as product contracts and route cheap work to local APIs first | Phase 1 architecture decision | Phase 4 should update callers, not rebuild the discovery engine. [VERIFIED: .planning/PROJECT.md] |
| Run `discover-companies` as chat/full workflow for company discovery | Use AI/manual seeds plus deterministic resolver/scanner/gate/proposal APIs | Phase 3 implementation | The app can now call local company proposal routes by default. [VERIFIED: 03-VERIFICATION.md] |
| Runtime config exposes only one-shot `skills` | Runtime config should expose capability metadata for one-shot, chat, AI, and discovery controls | Phase 4 planned change | UI can hide/degrade controls without guessing. [VERIFIED: codebase grep] [ASSUMED] |

**Deprecated/outdated:**

- Default `ChatPanel skill="discover-companies"` as the primary company-finding control is outdated for Phase 4 because Phase 3 shipped local proposal APIs. [VERIFIED: codebase grep] [VERIFIED: .planning/PROJECT.md]
- Direct runtime calls from new discovery UI controls are discouraged; route through `apps/web/src/lib/api.js` wrappers. [VERIFIED: codebase grep] [ASSUMED]

## Assumptions Log

| # | Claim | Section | Risk if Wrong |
|---|-------|---------|---------------|
| A1 | The default company proposal UI should live in `CompaniesStep.jsx`, with chat retained as a secondary agent-led affordance. | Summary, Architecture Patterns | If product wants `/search`, `/app`, or a dedicated drawer instead, the planner should move the same API wrapper and tests to that surface. |
| A2 | Extending `GET /api/runtime/config` is preferable to adding a separate capability route. | Standard Stack, Architecture Patterns | If maintainers want a new route, the same capability payload and tests still apply, but route docs and client wiring change. |
| A3 | Runtime config can initially report AI route/allowlist capability without proving the SDK dynamic import on every page load. | Architecture Patterns, Open Questions | If the UI requires installed-SDK precision, the planner should add an async SDK availability check with caching and tests for missing SDK. |

## Open Questions

1. **Which screen owns the final proposal review UI?**
   - What we know: `CompaniesStep.jsx` is the current company discovery surface and still defaults to `ChatPanel skill="discover-companies"`. [VERIFIED: codebase grep]
   - What's unclear: `.planning/STATE.md` still asks whether proposal confirmation belongs in `/search`, `/app`, or a dedicated discovery drawer. [VERIFIED: .planning/STATE.md]
   - Recommendation: implement the first Phase 4 slice in `CompaniesStep.jsx` and keep API wrappers reusable. [ASSUMED]

2. **How precise should runtime config be about SDK availability?**
   - What we know: `GET /api/runtime/config` currently returns only one-shot skill allowlist, while `runSkillStream()` and chat runtime return clear 501/400 errors when AI route or SDK is missing. [VERIFIED: codebase grep] [VERIFIED: tests]
   - What's unclear: whether the UI needs to know SDK install status before the user clicks an AI control. [ASSUMED]
   - Recommendation: expose AI route, one-shot allowlist, chat allowlist, and discovery capability flags first; preserve click-time 501/400 errors for SDK-specific failures unless a new cached SDK check is planned. [ASSUMED]

3. **Should quick-start be split into non-chat setup and chat start?**
   - What we know: `/api/discovery/quick-start` currently prepares source config and starts/reuses a discovery chat. [VERIFIED: codebase grep]
   - What's unclear: whether Phase 4 should decompose quick-start too or only the company discovery control. [ASSUMED]
   - Recommendation: preserve quick-start behavior for RUNT-03 and focus RUNT-02 on the company proposal control; splitting quick-start can be a later cleanup. [ASSUMED]

## Environment Availability

| Dependency | Required By | Available | Version | Fallback |
|------------|-------------|-----------|---------|----------|
| Node.js | Backend route tests and runtime server | yes | v24.18.0 | Blocking if missing; repo requires >=24. [VERIFIED: command output] [VERIFIED: package.json] |
| npm | Workspace scripts | yes | 11.16.0 | Blocking if missing for app test/build scripts. [VERIFIED: command output] |
| Vitest | React tests | yes | 3.2.6 | Use existing app workspace test script. [VERIFIED: command output] |
| `node:test` | Backend tests | yes | Node built-in | Use `node --test`. [VERIFIED: command output] |
| `.agents/skills` | Runtime allowlists and chat skills | yes | 26 skill dirs listed | Missing skills reduce allowlists through existing filters. [VERIFIED: codebase grep] [VERIFIED: command output] |
| AI route | Bounded seed generation and chat handoffs | not probed for secrets | BYOK/proxy/none via `resolveAIRoute()` | Manual seeds and latest pending proposal reads remain local; chat/full runtime return clear unavailable errors. [VERIFIED: codebase grep] [VERIFIED: tests] |

**Missing dependencies with no fallback:** none detected for planning and local tests. [VERIFIED: command output]

**Missing dependencies with fallback:** AI route was not secret-probed; existing no-AI behavior and manual seed fallbacks are covered in backend tests. [VERIFIED: tests]

## Validation Architecture

### Test Framework

| Property | Value |
|----------|-------|
| Framework | Backend: `node:test` under Node v24.18.0; Frontend: Vitest 3.2.6. [VERIFIED: command output] |
| Config file | Backend: none required for `node --test`; Frontend: app workspace Vite/Vitest defaults. [VERIFIED: package.json] |
| Quick run command | `node --test tests/discovery-route.test.mjs tests/company-proposals-route.test.mjs tests/company-proposal-decisions.test.mjs tests/skill-run-route.test.mjs tests/chat-runtime.test.mjs tests/skill-runtime.test.mjs` [VERIFIED: command output] |
| Frontend focused command | `npm --workspace apps/web run test -- src/onboarding/steps/FinishStep.test.jsx` now passes and should be expanded with CompaniesStep tests. [VERIFIED: command output] |
| Full suite command | `npm test && npm --workspace apps/web run test` [VERIFIED: package.json] |

### Phase Requirements -> Test Map

| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|--------------|
| RUNT-01 | `POST /api/skill/run` remains allowlisted, capped, SSE-based, abortable, and documented as retained full skill runtime. [VERIFIED: .planning/REQUIREMENTS.md] | backend unit/integration | `node --test tests/skill-run-route.test.mjs tests/skill-runtime.test.mjs` | yes [VERIFIED: tests] |
| RUNT-01 | `/api/runtime/config` exposes retained one-shot skills and new capability metadata without changing POST behavior. [ASSUMED] | backend route test | Add/update `tests/skill-run-route.test.mjs` | partial [VERIFIED: tests] |
| RUNT-02 | Default company discovery UI calls local proposal APIs instead of starting chat. [VERIFIED: .planning/ROADMAP.md] | frontend unit/render | Add `npm --workspace apps/web run test -- src/onboarding/steps/CompaniesStep.test.jsx` | no, Wave 0 gap [VERIFIED: codebase grep] |
| RUNT-02 | Local proposal routes never start chat/full skill runtime during generation/read. [VERIFIED: .planning/ROADMAP.md] | backend regression | `node --test tests/company-proposals-route.test.mjs tests/company-discovery-regression.test.mjs` | yes [VERIFIED: tests] |
| RUNT-03 | Explicit discovery handoffs still start/reuse visible chat for supervised steps. [VERIFIED: .planning/REQUIREMENTS.md] | backend + frontend | `node --test tests/discovery-route.test.mjs tests/chat-runtime.test.mjs && npm --workspace apps/web run test -- src/onboarding/steps/FinishStep.test.jsx` | yes [VERIFIED: tests] |
| RUNT-03 | Chat fallback remains visible as user-led option after local proposal routing. [ASSUMED] | frontend unit/render | Add assertions in `CompaniesStep.test.jsx` | no, Wave 0 gap [VERIFIED: codebase grep] |

### Sampling Rate

- **Per task commit:** run the narrow backend or frontend command for the touched surface. [VERIFIED: package.json]
- **Per wave merge:** run `node --test tests/discovery-route.test.mjs tests/company-proposals-route.test.mjs tests/company-proposal-decisions.test.mjs tests/skill-run-route.test.mjs tests/chat-runtime.test.mjs tests/skill-runtime.test.mjs` and the relevant app Vitest files. [VERIFIED: command output]
- **Phase gate:** run `npm test && npm --workspace apps/web run test`, plus `npm run app:build` if React UI code changed. [VERIFIED: package.json]

### Wave 0 Gaps

- [ ] `apps/web/src/onboarding/steps/CompaniesStep.test.jsx` - prove the default company discovery control calls proposal APIs and does not render/start chat as the primary path. [VERIFIED: codebase grep] [ASSUMED]
- [ ] `apps/web/src/lib/api.js` wrapper tests are absent; wrapper behavior can be covered through CompaniesStep tests or a small API unit if the project adds one. [VERIFIED: codebase grep] [ASSUMED]
- [ ] `tests/skill-run-route.test.mjs` should gain assertions for the expanded runtime config shape. [VERIFIED: tests] [ASSUMED]
- [ ] Existing docs should be checked after implementation for `POST /api/skill/run`, discovery chat, and company proposal route alignment. [VERIFIED: .planning/REQUIREMENTS.md]

### Baseline Test Results From This Research Run

- Backend focused gate: 87 pass, 2 skipped, 0 fail for discovery route, company proposal/decision, skill-run, chat-runtime, and skill-runtime tests. [VERIFIED: command output]
- Frontend focused gate: `FinishStep.test.jsx` passed 9 tests. [VERIFIED: command output]

## Security Domain

Security enforcement is enabled in `.planning/config.json`; Phase 4 should keep local-route access controls, input validation, and capability gating explicit. [VERIFIED: .planning/config.json]

### Applicable ASVS Categories

| ASVS Category | Applies | Standard Control |
|---------------|---------|------------------|
| V2 Authentication | no | The local tracker-dev app does not add user authentication in this phase; AI key storage remains governed by existing BYOK/local env code. [VERIFIED: AGENTS.md] [VERIFIED: codebase grep] |
| V3 Session Management | yes | Chat sessions use `chat-runtime.mjs` session IDs, lifecycle state, duplicate/max-session guards, close/interrupt, and route tests. [VERIFIED: codebase grep] [VERIFIED: tests] |
| V4 Access Control | yes | One-shot skills and chat skills are allowlisted through `ROLESTER_RUNTIME_SKILLS` and `ROLESTER_CHAT_SKILLS`, filtered against installed skill directories. [VERIFIED: codebase grep] [VERIFIED: tests] |
| V5 Input Validation | yes | Route bodies use `readJsonBodyCapped()`, proposal batch max is pinned, decision versions protect conflicts, and bounded AI output is validated before use. [VERIFIED: codebase grep] [VERIFIED: .planning/STATE.md] |
| V6 Cryptography | no new crypto | Phase 4 should not modify key storage or crypto; existing local AI key storage is documented in AGENTS.md. [VERIFIED: AGENTS.md] |

### Known Threat Patterns for Runtime Routing

| Pattern | STRIDE | Standard Mitigation |
|---------|--------|---------------------|
| Route escalation from local proposal to hidden chat/full skill | Elevation of privilege / Repudiation | Keep local proposal APIs as default; require explicit user action for `/api/chat/*` or `POST /api/skill/run`; preserve route tests that forbid chat starts in proposal generation. [VERIFIED: tests] [ASSUMED] |
| Oversized or malformed request bodies | Denial of service / Tampering | Use `readJsonBodyCapped()` and existing 400/413 behavior. [VERIFIED: codebase grep] [VERIFIED: tests] |
| Stale proposal approval | Tampering | Send expected proposal version and handle `CONFLICT` by refreshing proposal state. [VERIFIED: .planning/STATE.md] [VERIFIED: tests] |
| Model/manual seed URL hint trusted as final ATS URL | Spoofing / Tampering | Run deterministic resolver validation and supported-provider inference before proposal or approval. [VERIFIED: .planning/STATE.md] [VERIFIED: 03-VERIFICATION.md] |
| Current compensation leakage in seed prompts/responses | Information disclosure | Preserve Phase 3 prompt/privacy tests and never expose `current_base` or current-comp keys. [VERIFIED: .planning/STATE.md] [VERIFIED: tests] |
| UI enables unavailable AI controls | Reliability / Repudiation | Extend runtime config and keep click-time 501/400 failures for unavailable routes. [VERIFIED: codebase grep] [ASSUMED] |

## Sources

### Primary (HIGH confidence)

- `AGENTS.md` - project operating contract, DB write contract, discovery order, privacy/domain-neutral constraints. [VERIFIED: AGENTS.md]
- `.planning/REQUIREMENTS.md` - RUNT-01, RUNT-02, RUNT-03 definitions. [VERIFIED: .planning/REQUIREMENTS.md]
- `.planning/ROADMAP.md` - Phase 4 goal and success criteria. [VERIFIED: .planning/ROADMAP.md]
- `.planning/PROJECT.md` - current architecture state and Phase 4 boundary. [VERIFIED: .planning/PROJECT.md]
- `.planning/STATE.md` - phase state, decisions, open questions, Phase 3 invariants. [VERIFIED: .planning/STATE.md]
- `.planning/phases/03-company-discovery-api/03-VERIFICATION.md` - what Phase 3 actually shipped. [VERIFIED: 03-VERIFICATION.md]
- `.planning/phases/03-company-discovery-api/*-SUMMARY.md` - implementation summaries and tested route behavior. [VERIFIED: codebase grep]
- `src/cli/discovery-route.mjs` - proposal routes and chat handoff routes. [VERIFIED: codebase grep]
- `src/cli/skill-run-route.mjs` - runtime config and one-shot skill route. [VERIFIED: codebase grep]
- `src/core/ai/skill-runtime.mjs` - one-shot runtime allowlist and Agent SDK execution. [VERIFIED: codebase grep]
- `src/core/ai/chat-runtime.mjs` - chat runtime allowlist and multi-turn session behavior. [VERIFIED: codebase grep]
- `apps/web/src/lib/api.js`, `CompaniesStep.jsx`, `FinishStep.jsx`, `ChatPanel.jsx` - app routing surfaces. [VERIFIED: codebase grep]
- Focused test runs listed in Validation Architecture. [VERIFIED: command output]

### Secondary (MEDIUM confidence)

- None used for implementation guidance; external web search returned no Rolester-specific authoritative source. [VERIFIED: websearch]

### Tertiary (LOW confidence)

- Generic websearch results about deterministic routing and agent skills were not used for prescriptive recommendations because repository architecture and tests are the authoritative source for this phase. [VERIFIED: websearch]

## Metadata

**Confidence breakdown:**

- Standard stack: HIGH - versions and tools are from package manifests and local commands. [VERIFIED: package.json] [VERIFIED: command output]
- Architecture: HIGH - route ownership and app surfaces were verified in source, tests, and Phase 3 verification. [VERIFIED: codebase grep] [VERIFIED: tests]
- Pitfalls: HIGH for existing risks visible in code/tests; MEDIUM for UI placement assumptions because the exact proposal review surface is still an open question. [VERIFIED: codebase grep] [VERIFIED: .planning/STATE.md] [ASSUMED]

**Research date:** 2026-07-05
**Valid until:** 2026-08-04, or sooner if Phase 4 implementation changes the discovery UI or runtime config route before planning completes. [ASSUMED]
