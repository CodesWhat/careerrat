# Phase 11: Runtime Lockdown and Desktop Release - Pattern Map

**Mapped:** 2026-07-06
**Files analyzed:** 25
**Analogs found:** 23 / 25

## File Classification

| New/Modified File | Role | Data Flow | Closest Analog | Match Quality |
|-------------------|------|-----------|----------------|---------------|
| `src/core/ai/runtime-tools.mjs` | utility/config | transform | `src/core/ai/skill-runtime.mjs` + `src/core/ai/chat-runtime.mjs` | role-match |
| `src/core/ai/skill-runtime.mjs` | service | streaming, request-response | `src/core/ai/skill-runtime.mjs` | exact |
| `src/core/ai/chat-runtime.mjs` | service | streaming, event-driven | `src/core/ai/chat-runtime.mjs` | exact |
| `src/cli/skill-run-route.mjs` | route/controller | request-response, streaming | `src/cli/skill-run-route.mjs` | exact |
| `src/cli/intake-route.mjs` | route/controller | request-response, event-driven | `src/cli/intake-route.mjs` | exact |
| `apps/desktop/main.mjs` | controller | event-driven, request-response, file-I/O | `apps/desktop/main.mjs` | exact |
| `apps/desktop/desktop-routing.mjs` | utility | transform | `apps/desktop/desktop-routing.mjs` | exact |
| `apps/desktop/desktop-smoke.mjs` | utility | request-response, transform | `apps/desktop/desktop-smoke.mjs` | exact |
| `apps/desktop/scripts/stage.mjs` | utility/script | file-I/O, batch | `apps/desktop/scripts/stage.mjs` | exact |
| `apps/desktop/electron-builder.yml` | config | file-I/O, batch | `apps/desktop/electron-builder.yml` | exact |
| `apps/desktop/package.json` | config | batch | `apps/desktop/package.json` | exact |
| `apps/desktop/build/entitlements.mac.plist` | config | batch | none in codebase | none |
| `apps/desktop/build/entitlements.mac.inherit.plist` | config | batch | none in codebase | none |
| `apps/desktop/README.md` | docs | transform | `apps/desktop/README.md` | exact |
| `docs/RELEASE.md` | docs/config | batch, transform | `docs/RELEASE.md` + `tests/release-safety.test.mjs` | role-match |
| `docs/ARCHITECTURE.md` | docs | transform | `docs/ARCHITECTURE.md` | exact |
| `tests/skill-runtime.test.mjs` | test | streaming, transform | `tests/skill-runtime.test.mjs` | exact |
| `tests/skill-run-route.test.mjs` | test | request-response, streaming | `tests/skill-run-route.test.mjs` | exact |
| `tests/chat-runtime.test.mjs` | test | streaming, event-driven | `tests/chat-runtime.test.mjs` | exact |
| `tests/app-default-runtime-guard.test.mjs` | test/static guard | transform | `tests/db-app-shell-regression.test.mjs` + `tests/quick-onboarding-auto-sourcing-regression.test.mjs` | role-match |
| `tests/desktop-routing.test.mjs` | test | transform | `tests/desktop-routing.test.mjs` | exact |
| `tests/desktop-smoke.test.mjs` | test | request-response, transform | `tests/desktop-smoke.test.mjs` | exact |
| `tests/desktop-package-resources.test.mjs` | test/static guard | file-I/O, batch | `tests/desktop-package-resources.test.mjs` | exact |
| `tests/release-safety.test.mjs` | test/static guard | transform, file-I/O | `tests/release-safety.test.mjs` | exact |
| `tests/desktop-docs-release.test.mjs` | test/static guard | transform | `tests/release-safety.test.mjs` + `tests/db-app-shell-regression.test.mjs` | role-match |

## Pattern Assignments

### `src/core/ai/runtime-tools.mjs` (utility/config, transform)

**Analogs:** `src/core/ai/skill-runtime.mjs`, `src/core/ai/chat-runtime.mjs`

**Purpose:** centralize app-safe and explicit tool-heavy profiles so `runSkillStream()` no longer defaults to broad `Write`/`Edit`/`Bash`. Preserve per-call narrowing.

**Allowlist helper pattern** (`src/core/ai/skill-runtime.mjs` lines 81-99):

```javascript
export function resolveSkillAllowlist({ repoRoot, env = process.env, envVar, defaultValue } = {}) {
  const discovered = new Set(discoverSkillDirs(repoRoot));
  const raw = String(env[envVar] ?? defaultValue);
  const requested = raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return requested.filter((name) => discovered.has(name));
}

export function resolveAllowedSkills({ repoRoot, env = process.env } = {}) {
  return resolveSkillAllowlist({
    repoRoot,
    env,
    envVar: "CAREERRAT_RUNTIME_SKILLS",
    defaultValue: DEFAULT_RUNTIME_SKILLS,
  });
}
```

**Existing tool constants to replace, not preserve** (`src/core/ai/skill-runtime.mjs` line 366; `src/core/ai/chat-runtime.mjs` lines 70-82):

```javascript
export const RUNTIME_TOOLS = ["Read", "Glob", "Grep", "WebFetch", "Write", "Edit", "Bash", "Skill"];
```

```javascript
const DEFAULT_CHAT_SKILLS =
  "ingest-profile,research-boards,discover-companies,search-jobs,email-comms,track-outcomes";

const CHAT_TOOLS = [...RUNTIME_TOOLS, "WebSearch"];
```

**Pattern to implement:** put named profiles in the new helper, keep values immutable, and make app-safe the default. Include `Skill` in profiles used with `skills: [skill]`.

```javascript
export const APP_SAFE_RUNTIME_TOOLS = Object.freeze(["Read", "Glob", "Grep", "WebFetch", "Skill"]);
export const TOOL_HEAVY_RUNTIME_TOOLS = Object.freeze([
  ...APP_SAFE_RUNTIME_TOOLS,
  "Write",
  "Edit",
  "Bash",
]);

export function resolveRuntimeTools({ tools, profile = "app-safe" } = {}) {
  if (Array.isArray(tools)) return [...tools];
  if (profile === "tool-heavy") return [...TOOL_HEAVY_RUNTIME_TOOLS];
  return [...APP_SAFE_RUNTIME_TOOLS];
}
```

**Apply to:** `src/core/ai/skill-runtime.mjs`, `src/core/ai/chat-runtime.mjs`, `tests/skill-runtime.test.mjs`, `tests/chat-runtime.test.mjs`.

---

### `src/core/ai/skill-runtime.mjs` (service, streaming/request-response)

**Analog:** `src/core/ai/skill-runtime.mjs`

**Imports pattern** (lines 35-39):

```javascript
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { resolveModelConfig } from "./ai-config.mjs";
import { resolveAIRoute } from "./call-ai.mjs";
import { appendUsageEvent, computeCost } from "./usage-log.mjs";
```

Add `runtime-tools.mjs` as a sibling import. Keep SDK import lazy via `loadClaudeAgentSdk()`.

**Validation order pattern** (lines 406-424 and 432-452):

```javascript
export async function runSkillStream({
  skill,
  input,
  repoRoot,
  env = process.env,
  onEvent,
  signal,
  loadSdk = loadClaudeAgentSdk,
  tools = RUNTIME_TOOLS,
} = {}) {
  if (typeof onEvent !== "function") {
    throw new TypeError("runSkillStream: onEvent callback is required");
  }
  if (!repoRoot) {
    throw new TypeError("runSkillStream: repoRoot is required");
  }

  const allowed = resolveAllowedSkills({ repoRoot, env });
  if (!allowed.includes(skill)) {
    const err = new Error(
      `skill "${skill}" is not allowed to run via the embedded runtime (allowed: ` +
        `${allowed.join(", ") || "none"}) - set CAREERRAT_RUNTIME_SKILLS to opt more in`
    );
    err.code = "SKILL_NOT_ALLOWED";
    err.allowed = allowed;
    throw err;
  }

  const route = resolveAIRoute(env);
  if (route.type === "none") {
    const err = new Error(route.error);
    err.code = "NO_AI_ROUTE";
    throw err;
  }

  const { query } = await loadSdk();
```

Preserve this ordering: input validation -> allowlist -> AI route -> SDK load -> child env -> query. Add tool-profile validation before SDK `query()` and use error codes that `skill-run-route.mjs` can map.

**SDK query safety boundary** (lines 474-490):

```javascript
const q = query({
  prompt: buildPrompt({ skill, input }),
  options: {
    cwd: repoRoot,
    env: childEnv,
    abortController: controller,
    settingSources: ["project"],
    skills: [skill],
    tools,
    permissionMode: "bypassPermissions",
    allowDangerouslySkipPermissions: true,
  },
});
```

Keep `permissionMode: "bypassPermissions"` only behind the resolved narrow tool list. Do not add `canUseTool` as the primary gate unless the narrow `tools` list remains the boundary.

**BYOK usage pattern** (lines 528-544):

```javascript
export function writeByokUsage({ msg, skill, repoRoot, env }) {
  for (const [model, mu] of Object.entries(msg.modelUsage || {})) {
    appendUsageEvent(
      {
        source: "byok",
        skill,
        action: "skill-run",
        model,
        tokens_in: mu?.inputTokens,
        tokens_out: mu?.outputTokens,
        cache_read_tokens: mu?.cacheReadInputTokens,
        cache_creation_tokens: mu?.cacheCreationInputTokens,
      },
      { root: repoRoot, env }
    );
  }
}
```

Do not change the metering split: proxy meters server-side; BYOK writes usage rows here.

---

### `src/core/ai/chat-runtime.mjs` (service, streaming/event-driven)

**Analog:** `src/core/ai/chat-runtime.mjs`

**Imports pattern** (lines 48-58):

```javascript
import { randomUUID } from "node:crypto";
import { resolveAIRoute } from "./call-ai.mjs";
import {
  buildChildEnv,
  buildPrompt,
  loadClaudeAgentSdk,
  mapSdkMessage,
  RUNTIME_TOOLS,
  resolveSkillAllowlist,
  writeByokUsage,
} from "./skill-runtime.mjs";
```

If runtime tools move to `runtime-tools.mjs`, import profiles from there and stop deriving chat tools from a mutable one-shot constant.

**Separate chat allowlist pattern** (lines 70-90):

```javascript
const DEFAULT_CHAT_SKILLS =
  "ingest-profile,research-boards,discover-companies,search-jobs,email-comms,track-outcomes";

const CHAT_TOOLS = [...RUNTIME_TOOLS, "WebSearch"];

export function resolveAllowedChatSkills({ repoRoot, env = process.env } = {}) {
  return resolveSkillAllowlist({
    repoRoot,
    env,
    envVar: "CAREERRAT_CHAT_SKILLS",
    defaultValue: DEFAULT_CHAT_SKILLS,
  });
}
```

Keep chat as a distinct visible handoff layer. If narrowing chat tools is in scope, make it an explicit `chat` profile and update tests; do not silently reuse a tool-heavy profile.

**Session start validation and SDK options** (lines 419-469 and 498-511):

```javascript
async function startSession({ skill, input } = {}) {
  const trimmedSkill = String(skill || "").trim();
  if (!trimmedSkill) {
    const err = new Error("skill is required");
    err.code = "SKILL_REQUIRED";
    throw err;
  }

  const allowed = resolveAllowedChatSkills({ repoRoot, env });
  if (!allowed.includes(trimmedSkill)) {
    const err = new Error(
      `skill "${trimmedSkill}" is not allowed to run via the chat runtime (allowed: ` +
        `${allowed.join(", ") || "none"}) - set CAREERRAT_CHAT_SKILLS to opt more in`
    );
    err.code = "SKILL_NOT_ALLOWED";
    err.allowed = allowed;
    throw err;
  }

  const route = resolveAIRoute(env);
  if (route.type === "none") {
    const err = new Error(route.error);
    err.code = "NO_AI_ROUTE";
    throw err;
  }

  const { query } = await loadSdk();
```

```javascript
const q = query({
  prompt: pushQueue,
  options: {
    cwd: repoRoot,
    env: childEnv,
    abortController,
    settingSources: ["project"],
    skills: [trimmedSkill],
    tools: CHAT_TOOLS,
    permissionMode: "bypassPermissions",
    allowDangerouslySkipPermissions: true,
    maxTurns,
    title: `careerrat chat: ${trimmedSkill}`,
  },
});
```

---

### `src/cli/skill-run-route.mjs` (route/controller, request-response/streaming)

**Analog:** `src/cli/skill-run-route.mjs`

**Imports and constants pattern** (lines 31-42):

```javascript
import { resolveAIRoute } from "../core/ai/call-ai.mjs";
import { resolveAllowedChatSkills } from "../core/ai/chat-runtime.mjs";
import { resolveAllowedSkills } from "../core/ai/skill-runtime.mjs";

const MAX_BODY_BYTES = 1024 * 1024;
const HEARTBEAT_MS = 15000;
const DISCOVERY_CHAT_HANDOFF_SKILLS = new Set([
  "research-boards",
  "discover-companies",
  "search-jobs",
]);
```

Add imports from `runtime-tools.mjs` for public metadata and validation. Keep constants local when they are HTTP-specific.

**Shared JSON/body helpers** (lines 46-98):

```javascript
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
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > maxBytes) {
        overflowed = true;
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (overflowed) {
        const err = new Error("request body exceeds 1MB limit");
        err.status = 413;
        reject(err);
        return;
      }
      const text = Buffer.concat(chunks).toString("utf8").trim();
      if (!text) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(text));
      } catch {
        const err = new Error("invalid JSON body");
        err.status = 400;
        reject(err);
      }
    });
    req.on("error", (err) => reject(err));
  });
}
```

**Runtime config response pattern** (lines 139-157):

```javascript
addRoute("GET", "/api/runtime/config", (_req, res) => {
  const skills = resolveAllowedSkills({ repoRoot, env });
  const chatSkills = resolveAllowedChatSkills({ repoRoot, env });
  const route = resolveAIRoute(env);
  sendJson(res, 200, {
    skills,
    chatSkills,
    ai: {
      available: route.type !== "none",
      route: route.type,
    },
    discovery: {
      companyProposals: true,
      manualCompanySeeds: true,
      chatHandoffs: chatSkills.some((skill) => DISCOVERY_CHAT_HANDOFF_SKILLS.has(skill)),
    },
  });
});
```

Extend this response with non-secret `defaultProfile`, `appSafeTools`, and explicit `toolHeavy` metadata. Do not expose secrets or Apple credentials.

**SSE route pattern** (lines 159-245):

```javascript
addRoute("POST", "/api/skill/run", async (req, res) => {
  let body;
  try {
    body = await readJsonBodyCapped(req, MAX_BODY_BYTES);
  } catch (err) {
    sendJson(res, err.status || 400, { error: err.message });
    return;
  }

  const skill = String(body?.skill || "").trim();
  if (!skill) {
    sendJson(res, 400, { error: "body.skill is required" });
    return;
  }
  const input = body?.input;

  const controller = new AbortController();
  res.on("close", () => controller.abort());

  let started = false;
  let heartbeat = null;

  function ensureStarted() {
    if (started) return;
    started = true;
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
```

If a route-level `toolProfile` or `tools` body field is added, validate it before `runSkillStream()` and reject unclassified tool-heavy requests as a normal JSON error before SSE starts.

---

### `src/cli/intake-route.mjs` (route/controller, request-response/event-driven)

**Analog:** `src/cli/intake-route.mjs`

Use this as the classification model for explicit retained runtime lanes, not as an app-default loophole.

**Header boundary pattern** (lines 22-42):

```javascript
// ONE-WRITE-PATH + CONFIRM-FIRST: capture/classify never call a domain verb,
// runSkillStream, or chatRuntime. Only POST /api/intake/confirm executes
// the {lane, action, params} dispatch src/core/intake/dispatch.mjs already
// resolved at classify time.
```

**Background one-shot lane** (lines 254-282):

```javascript
function executeLaneB({ repoRoot, env, id, item, dispatch, runSkillStream }) {
  const running = intakeUpdate({ repoRoot, env, id, patch: { status: "running" } }).item;
  const skill = dispatch.params.skill;
  const input = buildLaneBInput(item);
  const controller = new AbortController();
  runSkillStream({ skill, input, repoRoot, env, onEvent: () => {}, signal: controller.signal })
    .then((resultData) => {
      const failed = resultData?.ok === false;
      intakeUpdate({
        repoRoot,
        env,
        id,
        patch: {
          status: failed ? "error" : "done",
          result: resultData,
          error: failed ? resultData?.error || "skill run did not complete" : null,
        },
      });
    })
    .catch((err) => {
      intakeUpdate({ repoRoot, env, id, patch: { status: "error", error: err.message } });
    });
  return running;
}
```

If Lane B remains tool-heavy, make the runtime profile explicit in this call and document why the dispatch lane is retained runtime.

**Visible chat handoff lane** (lines 335-358):

```javascript
async function executeLaneC({ repoRoot, env, id, item, dispatch, chatRuntime }) {
  const skill = dispatch.params.skill;
  const handoffText = buildChatHandoffText(item);
  const liveSession = chatRuntime.findBySkill(skill);
  let chatId;
  if (liveSession) {
    chatRuntime.postMessage(liveSession.chatId, handoffText);
    chatId = liveSession.chatId;
  } else {
    const started = await chatRuntime.startSession({
      skill,
      input: {
        intakeId: id,
        rawInput: item.rawInput,
        entities: item.classification?.entities || {},
      },
    });
    chatId = started.chatId;
  }
  chatRuntime.onClose(chatId, ({ reason, lastError }) => {
    intakeUpdate({ repoRoot, env, id, patch: mapCloseReasonToIntakePatch(reason, lastError) });
  });
  return intakeUpdate({ repoRoot, env, id, patch: { status: "running", result: { chatId } } }).item;
}
```

---

### `tests/app-default-runtime-guard.test.mjs` (test/static guard, transform)

**Analogs:** `tests/db-app-shell-regression.test.mjs`, `tests/quick-onboarding-auto-sourcing-regression.test.mjs`, `tests/company-discovery-regression.test.mjs`

**Imports and scanned file list pattern** (`tests/db-app-shell-regression.test.mjs` lines 1-21):

```javascript
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { relative, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));

const PRODUCT_FILES = [
  "apps/web/src/App.jsx",
  "apps/web/src/app-shell/NavList.jsx",
  "apps/web/src/app-shell/DashboardContext.jsx",
  "apps/web/src/lib/api.js",
  "src/cli/dashboard-route.mjs",
  "src/cli/data-route.mjs",
  "src/cli/packet-route.mjs",
  "src/cli/boards-route.mjs",
  "src/cli/search-route.mjs",
  "scripts/scan-sourced.mjs",
];
```

**Comment stripping and assertion helper pattern** (`tests/db-app-shell-regression.test.mjs` lines 102-170):

```javascript
function readSource(file) {
  return readFileSync(resolve(REPO_ROOT, file), "utf8");
}

function stripJavaScriptComments(source) {
  let output = "";
  let state = "code";
  let escaped = false;

  for (let i = 0; i < source.length; i += 1) {
    const char = source[i];
    const next = source[i + 1];
    // keep existing state machine; it preserves strings/templates while removing comments
  }

  return output;
}

function assertNoMatch(source, pattern, message) {
  const match = source.match(pattern);
  assert.equal(match, null, `${message}${match ? `: ${match[0]}` : ""}`);
}
```

Copy the full existing `stripJavaScriptComments()` implementation from `tests/db-app-shell-regression.test.mjs`, not the shorter regex-only helper, because this guard scans JS strings and templates.

**Forbidden runtime seam pattern** (`tests/quick-onboarding-auto-sourcing-regression.test.mjs` lines 9-30):

```javascript
const FORBIDDEN_FIRST_SEARCH_RUNTIME = [
  [/\/api\/chat\b/, "chat API"],
  [/\/api\/discovery\/(?:quick-start|next)\b/, "discovery chat handoff"],
  [/\/api\/skill\/run\b/, "retained skill runtime"],
  [/\brunSkillStream\b/, "full skill runtime"],
  [/\b(?:startSession|captureBoard|captureSearchSources|capture-board)\b/, "browser capture"],
  [/\b(?:research-boards|discover-companies)\b/, "agent discovery skill handoff"],
];

function assertNoForbiddenRuntime(text, label) {
  for (const [pattern, reason] of FORBIDDEN_FIRST_SEARCH_RUNTIME) {
    assert.doesNotMatch(text, pattern, `${label} must not invoke ${reason}`);
  }
}
```

**Slice-aware route scan pattern** (`tests/company-discovery-regression.test.mjs` lines 660-690):

```javascript
const routeSlices = [
  {
    label: "proposal create",
    start: 'addRoute("POST", "/api/discovery/company-proposals"',
    end: 'addRoute("GET", "/api/discovery/company-proposals"',
  },
  {
    label: "proposal read",
    start: 'addRoute("GET", "/api/discovery/company-proposals"',
    end: 'addRoute("POST", "/api/discovery/company-proposal-decisions"',
  },
  {
    label: "proposal decision and refresh",
    start: 'addRoute("POST", "/api/discovery/company-proposal-decisions"',
    end: 'addRoute("GET", "/api/discovery/state"',
  },
];

for (const { label, start, end } of routeSlices) {
  const startIndex = routeSource.indexOf(start);
  const endIndex = routeSource.indexOf(end);
  assert.notEqual(startIndex, -1, `${label} route start marker exists`);
  assert.notEqual(endIndex, -1, `${label} route end marker exists`);
  assert.ok(endIndex > startIndex, `${label} route slice has a valid range`);
  const slice = routeSource.slice(startIndex, endIndex);
  assert.doesNotMatch(slice, directAISeams, `${label} route must not directly call AI`);
  assert.doesNotMatch(slice, chatOrFullRuntimeSeams, `${label} route must not start chat or retained skill runtime`);
}
```

**Apply to:** `tests/app-default-runtime-guard.test.mjs`, updates to `tests/db-app-shell-regression.test.mjs`, and any docs guard that needs explicit compatibility-route classification.

---

### `apps/desktop/main.mjs` (controller, event-driven/request-response/file-I/O)

**Analog:** `apps/desktop/main.mjs`

**Imports pattern** (lines 22-28):

```javascript
import { app, BrowserWindow, shell } from "electron";
import { existsSync } from "node:fs";
import { get as httpGet } from "node:http";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { chooseDesktopRoute } from "./desktop-routing.mjs";
import { verifySmokeHttpSurface } from "./desktop-smoke.mjs";
```

**Packaged data-root pattern** (lines 58-64):

```javascript
let repoRoot;
if (app.isPackaged) {
  process.env.CAREERRAT_HOME = join(app.getPath("userData"), "data");
  repoRoot = join(process.resourcesPath, "careerrat");
} else {
  repoRoot = join(__dirname, "../..");
}
```

Keep `CAREERRAT_HOME` assignment before any CareerRat engine import.

**First-run route pattern** (lines 117-160):

```javascript
async function boot() {
  const { createDevServer } = await loadEngineModule("src/cli/tracker-dev.mjs");
  const { resolveUserPaths, userPath } = await loadEngineModule("src/core/paths/workspace.mjs");
  const { dbExists } = await loadEngineModule("src/core/db/connection.mjs");
  const { candidateConfigGet } = await loadEngineModule("src/core/db/verbs.mjs");

  dev = createDevServer({ repoRoot });
  const rendered = await dev.renderOnce();
  if (!rendered.ok) {
    log(`initial render skipped: ${rendered.error}`);
  }

  dev.startWatching();
  const port = await new Promise((resolve, reject) => {
    dev.server.once("error", reject);
    dev.server.listen(0, "127.0.0.1", () => resolve(dev.server.address().port));
  });

  const url = `http://127.0.0.1:${port}`;
  const pathCtx = { repoRoot };
  resolveUserPaths(pathCtx);
  const route = chooseDesktopRoute({
    hasCandidateSetup:
      existsSync(userPath(pathCtx, "candidate/profile.yml")) ||
      hasDbCandidateSetup({ pathCtx, dbExists, candidateConfigGet }),
  });

  return { url, route };
}
```

**External-link containment seam** (lines 189-211):

```javascript
function createWindow(url, route, { load = true } = {}) {
  win = new BrowserWindow({
    width: 1280,
    height: 860,
    title: "CareerRat",
  });

  win.webContents.setWindowOpenHandler(({ url: target }) => {
    shell.openExternal(target);
    return { action: "deny" };
  });
  win.webContents.on("will-navigate", (event, target) => {
    if (!target.startsWith(url)) {
      event.preventDefault();
      shell.openExternal(target);
    }
  });
```

Phase 11 should wrap `shell.openExternal()` behind a local `isAllowedExternalUrl()` or `openExternalSafely()` helper. Allow local loopback app URLs in-window; allow only vetted external protocols such as `https:` and `mailto:`.

**Smoke failure pattern** (lines 323-343):

```javascript
app.whenReady().then(async () => {
  const { url, route } = await boot();

  if (isSmoke) {
    try {
      await verifySmokeHttpSurface({ baseUrl: url, route, getOk: httpGetOk });

      const smokeWin = createWindow(url, route, { load: false });
      await loadAndVerifySmokeWindow(smokeWin, `${url}${route}`);

      log(`SMOKE OK ${url}`);
      await shutdown();
      app.exit(0);
    } catch (err) {
      log(`SMOKE FAILED: ${err.message}`);
      await shutdown();
      app.exit(1);
    }
    return;
  }
```

Preserve recoverable logging. Add packaged smoke variants around this path rather than moving Electron-only code into pure helpers.

---

### `apps/desktop/desktop-routing.mjs` and `apps/desktop/desktop-smoke.mjs` (utilities)

**Analogs:** `apps/desktop/desktop-routing.mjs`, `apps/desktop/desktop-smoke.mjs`

**Pure route helper pattern** (`apps/desktop/desktop-routing.mjs` lines 1-8):

```javascript
// Kept out of main.mjs so route policy is testable without importing Electron.
export function chooseDesktopRoute({ hasCandidateSetup } = {}) {
  return hasCandidateSetup ? "/app" : "/app/onboarding";
}
```

**Pure smoke helper pattern** (`apps/desktop/desktop-smoke.mjs` lines 6-23):

```javascript
export async function verifySmokeHttpSurface({ baseUrl, route, getOk }) {
  const healthBody = await getOk(new URL("/api/health", baseUrl).href);
  JSON.parse(healthBody);

  const routeBody = await getOk(new URL(route, baseUrl).href);
  if (!hasSpaRoot(routeBody)) {
    throw new Error(`GET ${route} did not return the SPA root`);
  }

  const assetPaths = extractAppAssetPaths(routeBody);
  if (assetPaths.length === 0) {
    throw new Error(`GET ${route} did not reference built app assets`);
  }

  for (const assetPath of assetPaths) {
    await getOk(new URL(assetPath, baseUrl).href);
  }
}
```

Keep new data-root/update-readiness checks pure where possible so `tests/desktop-*.test.mjs` can run without launching Electron.

---

### Desktop packaging files (config/script, file-I/O/batch)

**Files:** `apps/desktop/scripts/stage.mjs`, `apps/desktop/electron-builder.yml`, `apps/desktop/package.json`, `apps/desktop/build/entitlements.mac.plist`, `apps/desktop/build/entitlements.mac.inherit.plist`

**Stage script analog:** `apps/desktop/scripts/stage.mjs`

**Staging imports and constants** (lines 44-57):

```javascript
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const desktopDir = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const repoRoot = join(desktopDir, "../..");
const stagingRoot = join(desktopDir, "staging", "careerrat");
const webDistIndex = join(repoRoot, "apps/web/dist/index.html");

const EXCLUDE_EXACT = new Set(["examples"]);
const EXCLUDE_PREFIXES = ["docs/"];
const SKILL_PREFIX = ".agents/skills/";
```

**Package allowlist staging pattern** (`apps/desktop/scripts/stage.mjs` lines 69-81 and 193-205):

```javascript
function resolveEntries(pkg) {
  const entries = new Set();
  for (const entry of pkg.files || []) {
    if (EXCLUDE_EXACT.has(entry)) continue;
    if (EXCLUDE_PREFIXES.some((prefix) => entry.startsWith(prefix))) continue;
    if (entry.startsWith(SKILL_PREFIX)) {
      entries.add(".agents/skills");
      continue;
    }
    entries.add(entry);
  }
  return [...entries];
}
```

```javascript
function main() {
  assertWebDistBuilt();

  rmSync(stagingRoot, { recursive: true, force: true });
  mkdirSync(stagingRoot, { recursive: true });

  const pkg = readRootPackageJson();
  stageFiles();
  mirrorClaudeSkills();
  writeStagedPackageJson(pkg);
  installSdk(pkg);

  log("done.");
}
```

Do not copy `candidate/`, `workspace/`, `.internal/`, `.careerrat/`, repo root `node_modules`, tests, docs, or examples into packaged resources.

**Current builder config to update** (`apps/desktop/electron-builder.yml` lines 23-47):

```yaml
extraResources:
  - from: staging/careerrat
    to: careerrat
    filter:
      - "**/*"
      - ".agents/**"
      - ".claude/**"
      - "apps/web/dist/**"
      - "!**/.DS_Store"
  - from: staging/careerrat/node_modules
    to: careerrat/node_modules
    filter:
      - "**/*"
      - "!**/.DS_Store"
mac:
  target:
    - target: dmg
      arch:
        - arm64
  category: public.app-category.productivity
  hardenedRuntime: true
  gatekeeperAssess: false
  notarize: false
```

For Phase 11, keep `identity` and Apple account secrets out of source. Add entitlements paths, `forceCodeSigning: true`, real notarization config, and a zip target only if update-readiness checks require it. Use the entitlements plist files listed in "No Analog Found".

**Desktop package script pattern** (`apps/desktop/package.json` lines 9-17):

```json
{
  "scripts": {
    "dev": "electron .",
    "stage": "node scripts/stage.mjs",
    "dist": "npm --prefix ../.. run app:build && npm run stage && electron-builder --mac dmg"
  },
  "devDependencies": {
    "electron": "43.0.0",
    "electron-builder": "^26.15.3"
  }
}
```

Add release verification scripts only if they stay credential-neutral and deterministic. Do not upgrade Electron, electron-builder, or the Agent SDK without the package-legitimacy checkpoint from `11-RESEARCH.md`.

---

### Desktop and release tests (test/static guard)

**Files:** `tests/desktop-routing.test.mjs`, `tests/desktop-smoke.test.mjs`, `tests/desktop-package-resources.test.mjs`, `tests/release-safety.test.mjs`, `tests/desktop-docs-release.test.mjs`

**Routing test pattern** (`tests/desktop-routing.test.mjs` lines 1-13):

```javascript
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { chooseDesktopRoute } from "../apps/desktop/desktop-routing.mjs";

describe("desktop route selection", () => {
  it("opens app-first Home for existing candidate setup", () => {
    assert.equal(chooseDesktopRoute({ hasCandidateSetup: true }), "/app");
  });

  it("opens the SPA onboarding wizard for first-run workspaces", () => {
    assert.equal(chooseDesktopRoute({ hasCandidateSetup: false }), "/app/onboarding");
  });
});
```

**Smoke test pattern** (`tests/desktop-smoke.test.mjs` lines 5-27):

```javascript
describe("desktop smoke HTTP surface verification", () => {
  it("checks health, the selected SPA route, and referenced built assets", async () => {
    const requested = [];
    await verifySmokeHttpSurface({
      baseUrl: "http://127.0.0.1:61234",
      route: "/app/onboarding",
      getOk: async (url) => {
        requested.push(url);
        if (url.endsWith("/api/health")) return '{"ok":true}';
        if (url.endsWith("/app/onboarding")) {
          return '<!doctype html><div id="root"></div><script type="module" src="/app/assets/index-abc.js"></script>';
        }
        if (url.endsWith("/app/assets/index-abc.js")) return "console.log('ok');";
        throw new Error(`unexpected URL ${url}`);
      },
    });

    assert.deepEqual(requested, [
      "http://127.0.0.1:61234/api/health",
      "http://127.0.0.1:61234/app/onboarding",
      "http://127.0.0.1:61234/app/assets/index-abc.js",
    ]);
  });
});
```

**Packaging config test pattern** (`tests/desktop-package-resources.test.mjs` lines 13-63):

```javascript
test("desktop dist builds the SPA before staging the packaged runtime", async () => {
  const pkg = JSON.parse(await readText("apps/desktop/package.json"));
  const dist = pkg.scripts?.dist || "";

  const buildAt = dist.search(
    /(?:app:build|--workspace\s+apps\/web\s+run\s+build|run\s+build\s+--workspace\s+apps\/web)/
  );
  const stageAt = dist.indexOf("stage");

  assert.ok(buildAt >= 0, "desktop dist must build apps/web before packaging");
  assert.ok(stageAt >= 0, "desktop dist must stage the runtime before electron-builder");
  assert.ok(buildAt < stageAt, "apps/web build must run before staging copies apps/web/dist");
});
```

```javascript
test("electron-builder embeds the full staged runtime, including hidden skill dirs and SDK node_modules", async () => {
  const config = await readText("apps/desktop/electron-builder.yml");

  assert.match(
    config,
    /from:\s+staging\/careerrat[\s\S]*filter:/,
    "main staged runtime must use explicit filters"
  );
  for (const pattern of ["**/*", ".agents/**", ".claude/**", "apps/web/dist/**"]) {
    assert.match(
      config,
      new RegExp(`-\\s+["']?${escapeRegExp(pattern)}["']?`),
      `${pattern} must be included in extraResources`
    );
  }
});
```

Extend this file for `forceCodeSigning`, entitlements file paths, `notarize`, staged SDK presence, and any update-readiness target.

**Release privacy guard pattern** (`tests/release-safety.test.mjs` lines 39-61 and 217-266):

```javascript
test("npm package allowlist names app files, not broad private-data roots", async () => {
  const pkg = JSON.parse(await readText("package.json"));
  const files = pkg.files || [];

  assert.ok(files.includes("bin"));
  assert.ok(files.includes("src"));
  assert.ok(files.includes("config/*.schema.json"));
  assert.ok(files.includes("config/*.example.*"));
  for (const entry of files.filter((item) => item.startsWith(".agents/skills/"))) {
    await assert.doesNotReject(readText(entry), `${entry} should exist before packaging`);
  }

  assert.ok(!files.includes("config"));
  assert.ok(!files.includes(".agents"));
  assert.ok(!files.includes("docs"));
  assert.ok(!files.includes("candidate"));
  assert.ok(!files.includes("workspace"));
  assert.ok(!files.some((entry) => entry.includes("search-sources.yml")));
});
```

```javascript
test("scripts reachable from a skill or published npm-run alias are shipped", async () => {
  const { readdirSync, readFileSync } = await import("node:fs");
  const pkg = JSON.parse(await readText("package.json"));
  const files = pkg.files || [];
  const npmScripts = pkg.scripts || {};

  const aliasToScript = {};
  for (const [alias, cmd] of Object.entries(npmScripts)) {
    const m = cmd.match(/scripts\/[A-Za-z0-9_-]+\.mjs/);
    if (m) aliasToScript[alias] = m[0];
  }

  const referenced = new Set();
  for (const s of Object.values(aliasToScript)) referenced.add(s);

  const missing = [...referenced].filter((s) => !DEV_ONLY.has(s) && !files.includes(s)).sort();
  assert.deepEqual(missing, [], `Reachable script(s) missing from the package.json "files" allowlist`);
});
```

For `tests/desktop-docs-release.test.mjs`, reuse `readText()` and `assert.doesNotMatch()` from release-safety plus compatibility-route wording patterns from `tests/db-app-shell-regression.test.mjs`.

---

### Runtime route tests (test, streaming/request-response)

**Files:** `tests/skill-runtime.test.mjs`, `tests/skill-run-route.test.mjs`, `tests/chat-runtime.test.mjs`

**Skill runtime test harness** (`tests/skill-runtime.test.mjs` lines 10-23 and 32-47):

```javascript
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  buildChildEnv,
  discoverSkillDirs,
  loadClaudeAgentSdk,
  mapSdkMessage,
  RUNTIME_TOOLS,
  resolveAllowedSkills,
  runSkillStream,
} from "../src/core/ai/skill-runtime.mjs";
```

```javascript
function tempRepoWithSkill(skillNames = "test-skill") {
  const names = Array.isArray(skillNames) ? skillNames : [skillNames];
  const repoRoot = mkdtempSync(join(tmpdir(), "careerrat-skill-runtime-"));
  for (const skillName of names) {
    const skillDir = join(repoRoot, ".agents/skills", skillName);
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(
      join(skillDir, "SKILL.md"),
      `---\nname: ${skillName}\n---\n# ${skillName}\n`,
      "utf8"
    );
  }
  mkdirSync(join(repoRoot, ".agents/skills/not-a-skill"), { recursive: true });
  return repoRoot;
}
```

**Tool override tests to update** (`tests/skill-runtime.test.mjs` lines 506-551):

```javascript
test("runSkillStream: tools param - an unset caller gets RUNTIME_TOOLS passed to query()", async () => {
  const repoRoot = tempRepoWithSkill("evaluate-job");
  try {
    let seenTools = null;
    await runSkillStream({
      skill: "evaluate-job",
      input: "hi",
      repoRoot,
      env: { ANTHROPIC_API_KEY: "sk-ant-test" },
      onEvent: () => {},
      loadSdk: async () => ({
        query: ({ options }) => {
          seenTools = options.tools;
          return fakeSdk(SAMPLE_RUN).query({ options });
        },
      }),
    });
    assert.deepEqual(seenTools, RUNTIME_TOOLS);
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test("runSkillStream: an explicit tools override reaches query() verbatim, not RUNTIME_TOOLS", async () => {
  const repoRoot = tempRepoWithSkill(["evaluate-job", "resume-extract"]);
  try {
    let seenTools = null;
    await runSkillStream({
      skill: "resume-extract",
      input: "hi",
      repoRoot,
      env: { ANTHROPIC_API_KEY: "sk-ant-test" },
      tools: ["Read"],
      onEvent: () => {},
      loadSdk: async () => ({
        query: ({ options }) => {
          seenTools = options.tools;
          return fakeSdk(SAMPLE_RUN).query({ options });
        },
      }),
    });
    assert.deepEqual(seenTools, ["Read"]);
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});
```

Rename the first expectation to app-safe defaults and add explicit tool-heavy profile tests that prove `Write`, `Edit`, and `Bash` only appear when declared.

**Route test harness** (`tests/skill-run-route.test.mjs` lines 17-38):

```javascript
function bootRouteServer(runSkillStream, { repoRoot = "/fake/repo", env = {} } = {}) {
  const routes = new Map();
  function addRoute(method, path, handler) {
    routes.set(`${method} ${path}`, handler);
  }
  mountSkillRunRoute({ addRoute, repoRoot, runSkillStream, env });

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

**Config metadata test to extend** (`tests/skill-run-route.test.mjs` lines 83-129):

```javascript
test("GET /api/runtime/config: returns one-shot, chat, AI-route, and discovery capabilities without starting a skill run", async () => {
  const repoRoot = tempRepoWithSkills([
    "evaluate-job",
    "answer-question",
    "tailor-application",
    "resume-extract",
    "ingest-profile",
    "research-boards",
    "discover-companies",
    "search-jobs",
  ]);
  let called = false;
  const server = await bootRouteServer(
    async () => {
      called = true;
    },
    {
      repoRoot,
      env: {
        CAREERRAT_RUNTIME_SKILLS: "evaluate-job,answer-question",
        CAREERRAT_CHAT_SKILLS: "ingest-profile,research-boards,discover-companies,search-jobs",
        ANTHROPIC_API_KEY: "sk-ant-test",
      },
    }
  );
```

Add expected runtime profile metadata here. Add POST rejection tests for unclassified tool-heavy requests before SSE starts.

**Chat tool test to update if profiles move** (`tests/chat-runtime.test.mjs` lines 436-458):

```javascript
test("createChatRuntime.startSession: query() gets CHAT_TOOLS (RUNTIME_TOOLS + WebSearch), not the bare one-shot RUNTIME_TOOLS", async () => {
  const repoRoot = tempRepoWithSkill(["ingest-profile", "research-boards", "discover-companies"]);
  try {
    const seenToolsBySkill = new Map();
    const chatRuntime = createChatRuntime({
      repoRoot,
      env: {
        ANTHROPIC_API_KEY: "sk-ant-test",
        CAREERRAT_CHAT_SKILLS: "ingest-profile,research-boards,discover-companies",
      },
      loadSdk: async () => ({
        query: (args) => {
          seenToolsBySkill.set(args.options.skills[0], [...args.options.tools]);
          return fakeStreamingSdk([[]]).query(args);
        },
      }),
    });
    try {
      await chatRuntime.startSession({ skill: "research-boards" });
      await chatRuntime.startSession({ skill: "discover-companies" });
      assert.deepEqual(seenToolsBySkill.get("research-boards"), [...RUNTIME_TOOLS, "WebSearch"]);
      assert.deepEqual(seenToolsBySkill.get("discover-companies"), [...RUNTIME_TOOLS, "WebSearch"]);
    } finally {
      chatRuntime.shutdown();
    }
  } finally {
    cleanup(repoRoot);
  }
});
```

---

### Product and release docs (docs, transform)

**Files:** `apps/desktop/README.md`, `docs/RELEASE.md`, `docs/ARCHITECTURE.md`

**Architecture boundary to preserve** (`docs/ARCHITECTURE.md` lines 131-179):

```markdown
### Bounded AI Layer

Model calls are reserved for small schema-validated judgments:

- seed company suggestions
- classify finite pasted content
- suggest bounded onboarding fields
- normalize or rewrite a small artifact
- extract structure from ambiguous public careers-page text after deterministic
  scanner branches fail to identify a board

Bounded AI flows call `callAI()` or `runStructuredOneshot()`, return explicit
no-AI/manual fallbacks, and treat model output as advisory until deterministic
validation passes.

### Conversational Chat Handoff Layer

Agent-led workflows remain available when the user chooses them. Discovery
quick-start and next actions call `/api/discovery/quick-start` or
`/api/discovery/next`, which start or reuse visible `/api/chat/*` sessions.

### Retained Full Skill Runtime

`POST /api/skill/run` remains the allowlisted full runtime for workflows that
need broad tools, long orchestration, streamed visibility, or retained
`SKILL.md` execution. It is not the default route for deterministic scans,
proposal decisions, source writes, or local app actions with existing owners.
```

Update this only enough to name app-safe default runtime tools and explicit tool-heavy retained paths.

**Desktop README release gap to fix** (`apps/desktop/README.md` lines 31-48 and 60-88):

```markdown
## Run (dist - best-effort)

This stages a self-contained copy of the engine into `staging/careerrat`
(`scripts/stage.mjs` - the same allowlist `npm pack` ships, plus its own
`@anthropic-ai/claude-agent-sdk` install, so the packaged app doesn't reach
back into the repo checkout or its `node_modules`), then runs
`electron-builder --mac dmg`.

The packaged app writes its data (candidate/workspace/internal state) under
its own per-user data directory instead of a checkout.
```

```markdown
### Notarization (deferred)

`electron-builder.yml` sets `mac.notarize: false` explicitly.

## Honest POC boundaries

- Notarization is off (see above) - a locally-built `.dmg` will trigger
  Gatekeeper's "unidentified developer" warning until notarization is wired
  up.
- No auto-update, no crash reporting, no telemetry - none of that exists in
  this shell yet.
```

Change "best-effort" and "deferred" posture to pilot-accurate signed/notarized instructions. Keep credentials out of source.

**Release checklist pattern** (`docs/RELEASE.md` lines 15-32):

```markdown
## Release Checklist

Before tagging a release:

1. All tests pass: `npm test`
2. Doctor reports clean: `careerrat doctor`
3. Placeholder linter is clean: `npm run lint:placeholders`
4. **Privacy/public-split check** - grep all tracked files (`git ls-files`) for
   the private origin codename and any personal identity strings - must return
   nothing.
5. `docs/ROADMAP.md` (public) updated - shipped items reflect reality, planned
   list current.
6. `README.md` version badge / install snippet reflects new version (if any).
7. `package.json` version bumped.
8. Git tag created: `git tag -s v<version> -m "release: v<version>"` then pushed.
9. GitHub release created from the tag with changelog notes.
```

Add desktop pilot release gates here or in `apps/desktop/README.md`: stage, build, sign, notarize, staple, assess, smoke fresh workspace, smoke existing candidate, verify app does not need checkout, verify data root under `CAREERRAT_HOME`.

## Shared Patterns

### Runtime Safety Boundary

**Source:** `src/core/ai/skill-runtime.mjs` lines 474-490 and `src/core/ai/chat-runtime.mjs` lines 498-511

**Apply to:** all runtime and route work.

Use SDK `tools` as the primary boundary because both runtime paths intentionally use `permissionMode: "bypassPermissions"`. The default one-shot profile must exclude `Write`, `Edit`, and `Bash`. Tool-heavy paths must be named and allowlisted.

### Explicit Handoff Classes

**Source:** `docs/ARCHITECTURE.md` lines 131-179 and `src/cli/discovery-route.mjs` lines 23-88

```javascript
export const DISCOVERY_CHAT_SKILLS = ["research-boards", "discover-companies", "search-jobs"];

export function buildDiscoveryKickoff({ skill, message, source = "Continue discovery" } = {}) {
  return [
    source,
    `Current next discovery skill: ${skill}.`,
    message || "Continue the CareerRat discovery pipeline from the current workspace state.",
    `Pipeline order: ${DISCOVERY_PIPELINE.join(" -> ")}.`,
    DISCOVERY_STEP_NOTES[skill] || "Run only the current discovery step.",
    "Keep confirm-first prompts visible. Do not auto-approve board or company writes.",
    "Do not run evaluate-job, tailor-application, apply-job, fill forms, or submit applications from this handoff.",
    "If gate/apply setup is incomplete, stop with sourced or review items queued instead of guessing.",
  ].join("\n\n");
}
```

**Apply to:** route metadata, static guards, runtime docs, discovery/intake classifications.

### Static Guard Shape

**Source:** `tests/db-app-shell-regression.test.mjs` lines 10-21, 102-170, 195-205

Static guards should list exact product files, strip comments, and produce path-specific assertion messages. Use route slices for modules that intentionally contain both local product routes and explicit handoff routes.

### Desktop Shell Split

**Source:** `apps/desktop/main.mjs`, `apps/desktop/desktop-routing.mjs`, `apps/desktop/desktop-smoke.mjs`

Electron-only code stays in `main.mjs`; route decisions and smoke verification stay in pure helpers with node:test coverage. Packaged mode sets `CAREERRAT_HOME` before engine imports and uses staged resources under `process.resourcesPath`.

### Packaging Privacy

**Source:** `apps/desktop/scripts/stage.mjs` lines 37-40, 69-81, 193-205; `tests/release-safety.test.mjs` lines 39-61

Package from allowlists. Do not stage local candidate/workspace/private data. Tests should assert inclusion of necessary runtime files and exclusion of private roots.

## No Analog Found

| File | Role | Data Flow | Reason |
|------|------|-----------|--------|
| `apps/desktop/build/entitlements.mac.plist` | config | batch | No existing plist or entitlements file in the codebase. Use electron-builder/Electron notarization guidance from `11-RESEARCH.md`; keep minimal macOS hardened-runtime entitlements. |
| `apps/desktop/build/entitlements.mac.inherit.plist` | config | batch | No existing inherited entitlements analog. Pair with `electron-builder.yml#mac.entitlementsInherit`; no credentials or team identifiers in file. |

## Metadata

**Analog search scope:** `src/core/ai`, `src/cli`, `apps/desktop`, `tests`, `docs`
**Files scanned:** 34 source/test/doc files plus phase artifacts
**Strong analogs used:** `src/core/ai/skill-runtime.mjs`, `src/cli/skill-run-route.mjs`, `src/core/ai/chat-runtime.mjs`, `src/cli/intake-route.mjs`, `tests/db-app-shell-regression.test.mjs`, `apps/desktop/main.mjs`, `apps/desktop/scripts/stage.mjs`, `tests/desktop-package-resources.test.mjs`, `tests/release-safety.test.mjs`
**Pattern extraction date:** 2026-07-06
