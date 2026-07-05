# Phase 04: Runtime Routing - Pattern Map

**Mapped:** 2026-07-05
**Files analyzed:** 9
**Analogs found:** 9 / 9

## File Classification

| New/Modified File | Role | Data Flow | Closest Analog | Match Quality |
|-------------------|------|-----------|----------------|---------------|
| `apps/web/src/lib/api.js` | utility/API client | request-response | `apps/web/src/lib/api.js` existing wrapper groups | exact |
| `apps/web/src/onboarding/steps/CompaniesStep.jsx` | React component | request-response + event-driven UI state | `apps/web/src/onboarding/steps/FinishStep.jsx` | role-match |
| `apps/web/src/onboarding/steps/CompaniesStep.test.jsx` | frontend test | transform/render assertions + async request-response helpers | `apps/web/src/onboarding/steps/FinishStep.test.jsx` | role-match |
| `apps/web/src/onboarding/steps/FinishStep.jsx` | React component | explicit chat handoff request-response | existing `FinishStep.jsx` handoff helpers | exact |
| `src/cli/skill-run-route.mjs` | route/controller | request-response + SSE streaming | existing `src/cli/skill-run-route.mjs` runtime config and skill route | exact |
| `tests/skill-run-route.test.mjs` | backend route test | request-response + SSE assertions | existing `tests/skill-run-route.test.mjs` route harness | exact |
| `src/cli/discovery-route.mjs` | route/controller | request-response orchestration | existing company proposal and discovery handoff routes | exact |
| `tests/discovery-route.test.mjs` / company proposal tests | backend route tests | request-response orchestration with forbidden runtime assertions | `tests/company-proposals-route.test.mjs`, `tests/company-proposal-decisions.test.mjs`, `tests/discovery-route.test.mjs` | exact |
| `.planning/architecture/runtime-routing-policy.md` and/or `docs/ARCHITECTURE.md` | docs | routing contract documentation | existing runtime routing policy + architecture docs | exact |

## Pattern Assignments

### `apps/web/src/lib/api.js` (utility/API client, request-response)

**Analog:** existing route-wrapper groups in `apps/web/src/lib/api.js`

**Import/error pattern** (`apps/web/src/lib/api.js` lines 10-38):

```javascript
export class ApiError extends Error {
  constructor(status, body) {
    super(`request failed with status ${status}`);
    this.name = "ApiError";
    this.status = status;
    this.body = body;
  }
}

async function apiFetch(path, options = {}) {
  const res = await fetch(path, {
    ...options,
    headers: {
      "content-type": "application/json",
      ...(options.headers || {}),
    },
  });
  const text = await res.text();
  let body = {};
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = { raw: text };
    }
  }
  if (!res.ok) throw new ApiError(res.status, body);
  return body;
}
```

**Wrapper grouping pattern** (`apps/web/src/lib/api.js` lines 68-73, 132-142):

```javascript
// ---------------------------------------------------------------------------
// M8 — the /app/onboarding wizard's surface. Every function below is a thin
// wrapper over an M8 backend route ...
// ---------------------------------------------------------------------------

export function getDiscoveryState() {
  return apiFetch("/api/discovery/state");
}

export function startDiscoveryQuickStart() {
  return apiFetch("/api/discovery/quick-start", { method: "POST" });
}

export function startDiscoveryNext() {
  return apiFetch("/api/discovery/next", { method: "POST" });
}
```

**Assignment:** add company proposal wrappers beside the existing discovery wrappers:

- `createCompanyProposals(payload)` -> `POST /api/discovery/company-proposals`
- `getCompanyProposals({ status } = {})` -> `GET /api/discovery/company-proposals?status=...`
- `decideCompanyProposal(payload)` -> `POST /api/discovery/company-proposal-decisions`

Keep them thin; do not duplicate proposal gating, resolver, scanner, or write logic in the browser.

---

### `apps/web/src/onboarding/steps/CompaniesStep.jsx` (component, request-response + UI state)

**Analog:** `apps/web/src/onboarding/steps/FinishStep.jsx`

**Imports/state pattern** (`FinishStep.jsx` lines 1-14, 171-180):

```javascript
import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { useDashboardSnapshot } from "../../app-shell/DashboardContext.jsx";
import { Button } from "../../components/Button.jsx";
import { Card } from "../../components/Card.jsx";
import { InlineAlert } from "../../components/Toast.jsx";
import {
  addBoard,
  previewBoards,
  startDiscoveryNext,
  startDiscoveryQuickStart,
  writeConfig,
} from "../../lib/api.js";
import { ChatPanel } from "../ChatPanel.jsx";

export function FinishStep({ state, reload, goBack, aiEnabled = true }) {
  const dashboard = useDashboardSnapshot();
  const [writing, setWriting] = useState(false);
  const [written, setWritten] = useState(null);
  const [error, setError] = useState(null);
  const [quickStarting, setQuickStarting] = useState(false);
  const [quickStartResult, setQuickStartResult] = useState(null);
  const [discoveryStarting, setDiscoveryStarting] = useState(false);
  const [discoveryChat, setDiscoveryChat] = useState(null);
  const [discoveryChatError, setDiscoveryChatError] = useState(null);
```

**Async handler pattern** (`FinishStep.jsx` lines 214-245):

```javascript
async function handleQuickStart() {
  setQuickStarting(true);
  setError(null);
  setDiscoveryChatError(null);
  try {
    const { result, chat, chatError } = await runQuickStartHandoff({ refreshWorkspace });
    setQuickStartResult(result);
    setWritten(result.written || []);
    setDiscoveryChat(chat);
    setDiscoveryChatError(chatError);
  } catch (err) {
    setError(errorMessage(err, "quick-start failed"));
  } finally {
    setQuickStarting(false);
  }
}
```

**Secondary chat handoff pattern** (`FinishStep.jsx` lines 343-386):

```javascript
<Card
  title="Discovery pipeline"
  actions={
    discoveryAiEnabled && discoveryGuidance ? (
      <Button
        variant="secondary"
        onClick={handleContinueDiscovery}
        disabled={discoveryStarting || dashboard.noDatabase}
      >
        {discoveryStarting ? "Starting..." : discoveryGuidance.ctaLabel}
      </Button>
    ) : null
  }
>
  ...
  {discoveryChat ? (
    <div style={{ marginTop: 12 }}>
      <ChatPanel
        key={discoveryChat.chatId}
        skill={
          discoveryChat.skill || discoveryGuidance?.nextSkill || quickStartResult?.nextSkill
        }
        kickoffLabel="Run discovery"
        initialChatId={discoveryChat.chatId}
      />
    </div>
  ) : null}
</Card>
```

**Current anti-pattern to replace** (`CompaniesStep.jsx` lines 239-252):

```javascript
<div>
  <p className="field__label" style={{ margin: "0 0 6px" }}>
    Roland — find companies for you
  </p>
  {aiEnabled ? (
    <ChatPanel skill="discover-companies" kickoffLabel="Ask Roland to find companies" />
  ) : (
    <p className="field__hint">Add an AI key in the earlier step to use Roland's search.</p>
  )}
  <p className="field__hint">
    Roland proposes companies confirm-first in the panel above and adds accepted ones to your
    scan list separately — company chips added here are just your own shortlist.
  </p>
</div>
```

**Assignment:** make local company proposals the primary card. Use `createCompanyProposals` / `getCompanyProposals` / `decideCompanyProposal` in async handlers with `loading`, `error`, `batch`, and per-proposal decision state. Preserve a visibly secondary `ChatPanel skill="discover-companies"` or discovery handoff button for agent-led workflows; do not silently fall back to chat on local route failure.

---

### `apps/web/src/onboarding/steps/CompaniesStep.test.jsx` (frontend test, render + helper assertions)

**Analog:** `apps/web/src/onboarding/steps/FinishStep.test.jsx`

**Vitest/mock pattern** (`FinishStep.test.jsx` lines 1-24):

```javascript
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";

const dashboardMock = vi.hoisted(() => ({
  snapshot: {
    data: null,
    noDatabase: false,
    refetch: async () => {},
  },
}));

vi.mock("../../app-shell/DashboardContext.jsx", () => ({
  useDashboardSnapshot: () => dashboardMock.snapshot,
}));
```

**Pure helper test pattern** (`FinishStep.test.jsx` lines 146-175):

```javascript
describe("runQuickStartHandoff", () => {
  it("calls the backend discovery quick-start route, refreshes state, and exposes the returned chat", async () => {
    const calls = [];
    const outcome = await runQuickStartHandoff({
      quickStart: async () => {
        calls.push("quickStart");
        return {
          ok: true,
          written: ["config/search-sources.yml"],
          nextSkill: "research-boards",
          chat: { chatId: "chat-1", skill: "research-boards", state: "running" },
        };
      },
      refreshWorkspace: async () => {
        calls.push("refreshWorkspace");
      },
    });

    expect(calls).toEqual(["quickStart", "refreshWorkspace"]);
    expect(outcome.chat).toEqual({ chatId: "chat-1", skill: "research-boards", state: "running" });
    expect(outcome.guidance.nextSkill).toBe("research-boards");
  });
});
```

**Static render assertion pattern** (`FinishStep.test.jsx` lines 283-313):

```javascript
describe("FinishStep", () => {
  it("hides discovery CTAs without an AI key while keeping the manual finish path available", () => {
    const html = renderToStaticMarkup(
      <MemoryRouter>
        <FinishStep
          state={SEARCH_READY_STATE}
          aiEnabled={false}
          reload={async () => {}}
          goBack={() => {}}
        />
      </MemoryRouter>
    );

    expect(html).not.toContain(">Prepare sourcing<");
    expect(html).not.toContain(">Run research-boards<");
    expect(html).toContain("Add an AI key in the earlier step");
    expect(html).toContain(">Write config<");
  });
});
```

**Assignment:** create tests that prove:

- the primary company discovery helper calls proposal APIs, not `startChat` / `ChatPanel`;
- manual seeds can use local proposal routes without requiring full chat;
- secondary agent-led text/control remains visible when AI/chat is available;
- no-AI state does not hide local/manual proposal reads behind chat availability.

---

### `apps/web/src/onboarding/steps/FinishStep.jsx` (component, explicit chat handoff)

**Analog:** existing `FinishStep.jsx`

**Guidance allowlist pattern** (`FinishStep.jsx` lines 39-40, 120-130):

```javascript
const DISCOVERY_CHAT_SKILLS = ["research-boards", "discover-companies", "search-jobs"];
const NO_AI_DISCOVERY_HINT = "Add an AI key in the earlier step to use Roland's search.";

export function extractDiscoveryGuidance(snapshot) {
  const guidance =
    snapshot?.data?.agentGuidance || snapshot?.agentGuidance || snapshot?.guidance || null;
  const nextSkill = String(guidance?.nextSkill || "").trim();
  if (!DISCOVERY_CHAT_SKILLS.includes(nextSkill)) return null;
  return {
    nextSkill,
    message: guidance?.message || `Ask your agent to run ${nextSkill} next.`,
    ctaLabel: guidance?.ctaLabel || `Run ${nextSkill}`,
  };
}
```

**Handoff helpers** (`FinishStep.jsx` lines 132-159):

```javascript
export async function runQuickStartHandoff({
  quickStart = startDiscoveryQuickStart,
  reload,
  refreshWorkspace,
} = {}) {
  const result = await quickStart();
  await (refreshWorkspace || reload)?.();
  return {
    result,
    chat: result.chat || null,
    chatError: result.chatError || null,
    guidance: extractDiscoveryGuidance(result),
  };
}

export async function runNextDiscoveryHandoff({
  continueDiscovery = startDiscoveryNext,
  refreshWorkspace,
} = {}) {
  const result = await continueDiscovery();
  await refreshWorkspace?.();
  return {
    result,
    guidance: extractDiscoveryGuidance(result),
    chat: result.chat || null,
    chatError: result.chatError || null,
  };
}
```

**Assignment:** change this file only if runtime capability config replaces the `aiEnabled` prop or if chat handoff copy/tests need preserving. Do not remove `runQuickStartHandoff`, `runNextDiscoveryHandoff`, or `DISCOVERY_CHAT_SKILLS`; Phase 04 depends on explicit handoffs remaining available.

---

### `src/cli/skill-run-route.mjs` (route/controller, request-response + SSE)

**Analog:** existing `src/cli/skill-run-route.mjs`

**Shared JSON/body-cap pattern** (`skill-run-route.mjs` lines 31-45, 56-91):

```javascript
import { resolveAllowedSkills } from "../core/ai/skill-runtime.mjs";

export function sendJson(res, status, body) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(JSON.stringify(body));
}

export function readJsonBodyCapped(req, maxBytes) {
  return new Promise((resolve, reject) => {
    let size = 0;
    let overflowed = false;
    const chunks = [];
    ...
  });
}
```

**Runtime config pattern to extend** (`skill-run-route.mjs` lines 132-135):

```javascript
export function mountSkillRunRoute({ addRoute, repoRoot, runSkillStream, env = process.env }) {
  addRoute("GET", "/api/runtime/config", (_req, res) => {
    sendJson(res, 200, { skills: resolveAllowedSkills({ repoRoot, env }) });
  });
```

**Pre-stream status mapping pattern** (`skill-run-route.mjs` lines 123-130, 196-211):

```javascript
function statusForRunError(err) {
  if (err?.code === "SDK_NOT_INSTALLED") return 501;
  if (err?.code === "SKILL_NOT_ALLOWED" || err?.code === "NO_AI_ROUTE") return 400;
  return 500;
}

try {
  await runSkillStream({
    skill,
    input,
    repoRoot,
    onEvent: emit,
    signal: controller.signal,
  });
} catch (err) {
  if (!started) {
    sendJson(res, statusForRunError(err), { error: err.message });
    return;
  }
  emit({ type: "error", data: { message: err.message } });
}
```

**Assignment:** extend only `GET /api/runtime/config` for capability metadata. Keep `POST /api/skill/run` validation, body cap, SSE headers, heartbeat, abort, and pre-stream error semantics unchanged. Import or share chat allowlist and AI route helpers rather than hardcoding browser booleans.

---

### `tests/skill-run-route.test.mjs` (backend route test, request-response + SSE)

**Analog:** existing `tests/skill-run-route.test.mjs`

**Route harness pattern** (`skill-run-route.test.mjs` lines 14-35):

```javascript
function bootRouteServer(runSkillStream) {
  const routes = new Map();
  function addRoute(method, path, handler) {
    routes.set(`${method} ${path}`, handler);
  }
  mountSkillRunRoute({ addRoute, repoRoot: "/fake/repo", runSkillStream });

  const server = createServer((req, res) => {
    const url = (req.url || "/").split("?")[0];
    const route = routes.get(`${req.method} ${url}`);
    if (!route) {
      res.writeHead(404).end();
      return;
    }
    route(req, res);
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve(server));
  });
}
```

**Validation assertions pattern** (`skill-run-route.test.mjs` lines 70-122):

```javascript
test("POST /api/skill/run: 400 when body.skill is missing", async () => {
  let called = false;
  const server = await bootRouteServer(async () => {
    called = true;
  });
  ...
  assert.equal(res.status, 400);
  const body = await res.json();
  assert.match(body.error, /skill.*required/);
  assert.equal(called, false);
});
```

**SSE assertion pattern** (`skill-run-route.test.mjs` lines 210-253):

```javascript
test("POST /api/skill/run: streams mapped events as SSE and passes skill/input through", async () => {
  let received = null;
  const server = await bootRouteServer(async ({ skill, input, onEvent }) => {
    received = { skill, input };
    onEvent({ type: "system", data: { subtype: "init" } });
    onEvent({ type: "result", data: { ok: true, durationMs: 42 } });
    return { ok: true, durationMs: 42 };
  });
  ...
  assert.match(text, /event: system\ndata: \{"subtype":"init"\}/);
});
```

**Assignment:** add `GET /api/runtime/config` assertions to this file. Build temporary `.agents/skills` fixtures if needed, mirroring `tests/skill-runtime.test.mjs` allowlist fixtures, and assert the config is read-only and exposes one-shot skills, chat skills, AI availability/route, and discovery capability flags without calling `runSkillStream`.

---

### `src/cli/discovery-route.mjs` (route/controller, request-response orchestration)

**Analog:** existing company proposal and discovery handoff routes

**Route ownership/import pattern** (`discovery-route.mjs` lines 6-16):

```javascript
import { DISCOVERY_PIPELINE } from "../core/agent-guidance.mjs";
import { dbExists } from "../core/db/connection.mjs";
import { companyProposalBatchLatest } from "../core/db/verbs/company-discovery.mjs";
import { candidateConfigGet } from "../core/db/verbs.mjs";
import { applyCompanyProposalDecision } from "../core/discovery/company-proposal-decisions.mjs";
import { createCompanyProposalBatch } from "../core/discovery/company-proposals.mjs";
import { loadAgentGuidanceSnapshot } from "../core/tracker/agent-guidance-snapshot.mjs";
import { prepareQuickStartSourcing } from "./onboard-route.mjs";
import { readJsonBodyCapped, sendJson } from "./skill-run-route.mjs";

export const DISCOVERY_CHAT_SKILLS = ["research-boards", "discover-companies", "search-jobs"];
```

**Proposal route pattern** (`discovery-route.mjs` lines 186-222):

```javascript
addRoute("POST", "/api/discovery/company-proposals", async (req, res) => {
  let body;
  try {
    body = await readJsonBodyCapped(req, COMPANY_PROPOSAL_BODY_MAX_BYTES);
  } catch (err) {
    sendJson(res, err.status || 400, {
      ok: false,
      code: err.status === 413 ? "PAYLOAD_TOO_LARGE" : "BAD_REQUEST",
      error: { message: err.message },
    });
    return;
  }

  try {
    const result = await createCompanyProposalBatch({
      repoRoot,
      env,
      body,
      fetchImpl,
      resolveCompanyBoard,
      scanCompaniesImpl,
      seedCall,
      now,
    });
    if (result.body) {
      sendJson(res, result.status || 500, result.body);
      return;
    }
    sendJson(res, 200, { ok: true, data: result.data, meta: result.meta });
  } catch (err) {
    sendJson(res, err.status || 500, {
      ok: false,
      code: err.code || "COMPANY_PROPOSAL_FAILED",
      error: { message: err.message },
    });
  }
});
```

**Decision route pattern** (`discovery-route.mjs` lines 240-266):

```javascript
addRoute("POST", "/api/discovery/company-proposal-decisions", async (req, res) => {
  let body;
  try {
    body = await readJsonBodyCapped(req, COMPANY_PROPOSAL_BODY_MAX_BYTES);
  } catch (err) {
    discoveryRouteError(res, err, err.status || 400);
    return;
  }

  try {
    const result = await applyCompanyProposalDecision({
      repoRoot,
      env,
      body,
      fetchImpl,
      resolveCompanyBoard,
      scanCompaniesImpl,
      gateProposal,
      now,
      companyAtsUpsertImpl,
      sourcedUpsertBatchImpl,
    });
    sendJson(res, 200, { ok: true, data: result.data, meta: result.meta });
  } catch (err) {
    discoveryRouteError(res, err, err.status || 500);
  }
});
```

**Chat handoff pattern to preserve** (`discovery-route.mjs` lines 330-360):

```javascript
addRoute("POST", "/api/discovery/next", async (_req, res) => {
  const rawGuidance = loadAgentGuidance({ root: repoRoot, env });
  const guidance = normalizeDiscoveryGuidance(rawGuidance);
  if (!guidance) {
    sendJson(res, 200, {
      ok: true,
      locked: true,
      pipeline: DISCOVERY_PIPELINE,
      guidance: rawGuidance || null,
      chat: null,
      activeDiscoveryChat: findActiveDiscoveryChat(chatRuntime),
    });
    return;
  }

  try {
    const handoff = await startOrReuseDiscoveryChat({
      chatRuntime,
      guidance,
      source: "Continue discovery from the app.",
    });
    sendJson(res, 200, {
      ok: true,
      pipeline: DISCOVERY_PIPELINE,
      guidance,
      ...handoff,
    });
  } catch (err) {
    sendJson(res, err.status || 500, { ok: false, error: err.message });
  }
});
```

**Assignment:** no new discovery route is implied by Phase 04 unless capability config needs to report route support. UI should call these existing routes. Preserve the separation: proposal routes must not start chat; handoff routes may start/reuse chat explicitly.

---

### `tests/discovery-route.test.mjs`, `tests/company-proposals-route.test.mjs`, `tests/company-proposal-decisions.test.mjs` (backend tests)

**Analogs:** existing discovery route tests

**Forbidden chat/full-runtime pattern for proposal route** (`company-proposals-route.test.mjs` lines 36-55, 247-360):

```javascript
function fakeChatRuntime() {
  const starts = [];
  return {
    starts,
    startSession(args) {
      starts.push(args);
      throw new Error("company proposal route must not start chat runtime");
    },
    findBySkill() {
      return null;
    },
  };
}

function forbidden(name, calls) {
  return (...args) => {
    calls.push({ name, args });
    throw new Error(`${name} must not be called by company proposal generation`);
  };
}
```

**Confirmed decision write pattern** (`company-proposal-decisions.test.mjs` lines 212-274):

```javascript
test("POST /api/discovery/company-proposal-decisions approves a pending supported ATS proposal and promotes captured sourced rows", async () => {
  const repoRoot = setupRepo();
  const proposal = supportedProposal();
  writeJobArtifact(repoRoot, proposal.capturedOffers[0]);
  putBatch(repoRoot, pendingBatch({ proposals: [proposal] }));

  const calls = [];
  const server = bootServer(repoRoot, {
    companyAtsUpsertImpl: (args) => {
      calls.push({ name: "companyAtsUpsert", args });
      return companyAtsUpsert(args);
    },
    sourcedUpsertBatchImpl: (args) => {
      calls.push({ name: "sourcedUpsertBatch", args });
      return sourcedUpsertBatch(args);
    },
  });

  const { status, body } = await postJson(
    server,
    "/api/discovery/company-proposal-decisions",
    decisionRequest()
  );

  assert.equal(status, 200);
  assert.equal(body.ok, true);
  assert.equal(body.data.decision.action, "approve-supported-ats");
  assert.equal(body.data.sourceConfig.status, "added");
  assert.equal(body.data.sourced.created, 1);
});
```

**Explicit handoff pattern** (`discovery-route.test.mjs` lines 111-130, 150-168, 189-207):

```javascript
test("POST /api/discovery/quick-start prepares sources and starts the visible research-boards chat", async () => {
  const { server, chatRuntime } = await bootServer();
  const { status, body } = await postJson(server, "/api/discovery/quick-start");
  assert.equal(status, 200);
  assert.equal(body.ok, true);
  assert.equal(body.chat.skill, "research-boards");
  assert.equal(chatRuntime.starts.length, 1);
  assert.equal(chatRuntime.starts[0].skill, "research-boards");
  assert.match(chatRuntime.starts[0].input, /research-boards -> discover-companies -> search-jobs/);
  assert.match(chatRuntime.starts[0].input, /Do not run evaluate-job/i);
});
```

**Assignment:** keep proposal-route tests proving no hidden chat/full skill runtime starts. Keep handoff-route tests proving chat starts only via `/api/discovery/quick-start` or `/api/discovery/next`. Add or preserve UI-facing route assertions if wrappers are covered indirectly through `CompaniesStep.test.jsx`.

---

### Runtime allowlist sources (`src/core/ai/skill-runtime.mjs`, `src/core/ai/chat-runtime.mjs`)

**Analogs:** existing allowlist helpers

**One-shot runtime allowlist** (`skill-runtime.mjs` lines 45-100):

```javascript
export function discoverSkillDirs(repoRoot) {
  const skillsRoot = join(repoRoot, ".agents/skills");
  if (!existsSync(skillsRoot)) return [];
  return readdirSync(skillsRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && existsSync(join(skillsRoot, entry.name, "SKILL.md")))
    .map((entry) => entry.name)
    .sort();
}

const DEFAULT_RUNTIME_SKILLS = "evaluate-job,answer-question,tailor-application,resume-extract";

export function resolveAllowedSkills({ repoRoot, env = process.env } = {}) {
  return resolveSkillAllowlist({
    repoRoot,
    env,
    envVar: "ROLESTER_RUNTIME_SKILLS",
    defaultValue: DEFAULT_RUNTIME_SKILLS,
  });
}
```

**Chat runtime allowlist** (`chat-runtime.mjs` lines 60-90):

```javascript
const DEFAULT_CHAT_SKILLS =
  "ingest-profile,research-boards,discover-companies,search-jobs,email-comms,track-outcomes";

export function resolveAllowedChatSkills({ repoRoot, env = process.env } = {}) {
  return resolveSkillAllowlist({
    repoRoot,
    env,
    envVar: "ROLESTER_CHAT_SKILLS",
    defaultValue: DEFAULT_CHAT_SKILLS,
  });
}
```

**Assignment:** runtime config should use these helpers rather than duplicating default skill names in React. If `GET /api/runtime/config` reports `chatSkills`, import `resolveAllowedChatSkills` from `chat-runtime.mjs`.

---

### Docs (`.planning/architecture/runtime-routing-policy.md`, `docs/ARCHITECTURE.md`)

**Analog:** `.planning/architecture/runtime-routing-policy.md`

**Core route boundary** (`runtime-routing-policy.md` lines 16-24):

```markdown
- Use existing deterministic code, local API routes, DB verbs, and CLI helpers
  for work that already has a local owner.
- Use bounded structured AI only for model-shaped judgment or ambiguity where a
  small schema-validated result is enough.
- Use `/api/chat/*` for conversational skill handoffs where the user is present
  and the workflow should proceed turn by turn.
- Use `POST /api/skill/run` only for allowlisted full skill execution that needs
  broad tools, long orchestration, live stream visibility, or retained
  human-watched agent behavior.
```

**Decision matrix rows** (`runtime-routing-policy.md` lines 52-58):

```markdown
| conversational skill handoff | The user wants an agent-led workflow, the flow is confirm-first, or the skill needs turn-by-turn questions while keeping the app in control. | `/api/chat/*` backed by `src/core/ai/chat-runtime.mjs`, with current discovery handoffs from `src/cli/discovery-route.mjs` for `/api/discovery/quick-start` and `/api/discovery/next`. | Cheap deterministic scans, DB writes with local verbs, or one-shot bounded assists that do not need a live skill session. |
| full skill runtime | The workflow is tool-heavy, long-running, broad, hard to bound, watched by the user, or still intentionally retained as SKILL.md execution. Use `POST /api/skill/run` only through the allowlisted runtime surface. | `src/cli/skill-run-route.mjs` and `runSkillStream` in `src/core/ai/skill-runtime.mjs`. | Routine scan/search refreshes, source-config writes, deterministic validation, dedupe, schema-only model assists, or confirmed source writes with existing local owners. |
```

**Architecture docs style** (`docs/ARCHITECTURE.md` lines 82-105):

```markdown
## Layers

### Skill Layer

Skills make judgment calls:

- what to ask during onboarding
- whether a job passes the body-read gate
- how to rate fit

### Script Layer

Scripts should be deterministic:

- validate setup
- build source URLs from config
- parse saved jobs
- dedupe sourced roles
```

**Assignment:** if docs change in Phase 04, update the routing policy first because it already names local API vs chat vs full skill runtime owners. Update `docs/ARCHITECTURE.md` only for durable public-facing layer language; keep it concise and domain-neutral.

## Shared Patterns

### Thin HTTP Routes

**Source:** `src/cli/discovery-route.mjs` lines 186-222 and `src/cli/skill-run-route.mjs` lines 132-222

**Apply to:** runtime config and any touched route tests

Routes should parse/cap bodies, call a core seam, and return stable JSON envelopes or SSE. Business logic stays in core modules.

### No Hidden Runtime Escalation

**Source:** `tests/company-proposals-route.test.mjs` lines 36-55 and lines 336-360

**Apply to:** company proposal UI and route coverage

Proposal generation and decisions must not start `ChatPanel`, `/api/chat/*`, `runSkillStream`, or `POST /api/skill/run` as a fallback. Explicit chat handoff remains a separate user action.

### Allowlists Are Runtime-Owned

**Source:** `src/core/ai/skill-runtime.mjs` lines 81-100 and `src/core/ai/chat-runtime.mjs` lines 83-90

**Apply to:** `GET /api/runtime/config`, UI capability gating, tests

Resolve runtime skills from `.agents/skills` plus `ROLESTER_RUNTIME_SKILLS`; resolve chat skills from `.agents/skills` plus `ROLESTER_CHAT_SKILLS`. Do not hardcode the lists in React.

### React Async State

**Source:** `apps/web/src/onboarding/steps/FinishStep.jsx` lines 214-245 and `apps/web/src/onboarding/steps/CompaniesStep.jsx` lines 85-116

**Apply to:** company proposal create/read/decision handlers

Use local `useState` flags, clear prior errors at handler start, catch `ApiError` through a small `errorMessage` helper or direct `err?.body?.error`, and reset loading flags in `finally`.

### Vitest Component Coverage

**Source:** `apps/web/src/onboarding/steps/FinishStep.test.jsx` lines 1-24, 146-175, and 283-313

**Apply to:** new `CompaniesStep.test.jsx`

Prefer exported pure helpers for async route orchestration and `renderToStaticMarkup` for coarse UI assertions. Mock app context with `vi.hoisted` when needed.

## No Analog Found

None. Every Phase 04 file has a close existing analog. The only new surface is the proposal review UI inside `CompaniesStep.jsx`; compose it from existing onboarding `Card`, `Button`, `InlineAlert`, chip-row/company-row conventions, and the existing proposal route contract instead of introducing a new design system.

## Metadata

**Analog search scope:** `apps/web/src/lib`, `apps/web/src/onboarding`, `src/cli`, `src/core/ai`, `tests`, `.planning/architecture`, `docs`

**Files scanned:** primary 14 files:

- `apps/web/src/lib/api.js`
- `apps/web/src/onboarding/steps/CompaniesStep.jsx`
- `apps/web/src/onboarding/steps/FinishStep.jsx`
- `apps/web/src/onboarding/steps/FinishStep.test.jsx`
- `src/cli/skill-run-route.mjs`
- `src/cli/discovery-route.mjs`
- `src/core/ai/skill-runtime.mjs`
- `src/core/ai/chat-runtime.mjs`
- `tests/skill-run-route.test.mjs`
- `tests/skill-runtime.test.mjs`
- `tests/chat-runtime.test.mjs`
- `tests/discovery-route.test.mjs`
- `tests/company-proposals-route.test.mjs`
- `tests/company-proposal-decisions.test.mjs`

**Pattern extraction date:** 2026-07-05
