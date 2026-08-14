# Phase 11: Runtime Lockdown and Desktop Release - Research

**Researched:** 2026-07-06
**Domain:** Electron desktop release hardening, retained skill-runtime permissioning, and app-default route guards
**Confidence:** MEDIUM

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions
## Implementation Decisions

### Runtime Tool Lockdown
- **D-01:** The shared one-shot embedded skill runtime should become app-safe by default. Broad `Write`, `Edit`, and `Bash` must be removed from the default tool surface instead of remaining available to ordinary app button flows.
- **D-02:** Tool-heavy execution must be explicit and scoped. The preferred shape is a split between app-safe/default execution and an intentionally named tool-heavy path or per-skill/per-route tool manifest.
- **D-03:** Narrow per-call overrides are allowed when a local owner can justify them. The existing `resume-extract` pattern of passing `tools: ["Read"]` is the model: the caller narrows or explicitly declares the tools it needs rather than inheriting broad defaults.
- **D-04:** The retained runtime can still serve human-watched, long-running, browser/auth, interview, or explicitly chosen agent workflows. It must not be a hidden implementation detail for cheap deterministic app work.
- **D-05:** `permissionMode: "bypassPermissions"` is only acceptable behind a narrow tool list. The safety boundary for headless execution is the allowed tool surface plus allowlisted skills, not a skipped permission prompt.

### App-Default Ban Boundary
- **D-06:** Static checks should treat React `/app`, product HTTP routes, onboarding, search, deep-ingest, packet/evaluate/apply surfaces, and Electron product wiring as app-default surfaces.
- **D-07:** App-default surfaces must call local APIs, DB verbs, bounded AI helpers, or explicit chat handoffs. They must not add hidden direct calls to `POST /api/skill/run` when a local owner exists.
- **D-08:** CLI commands, debug/export compatibility endpoints, retained legacy/static pages, and explicitly labeled full-skill or chat handoffs may still reference skill runtime, but those references must be classified so static guards do not normalize them as product defaults.
- **D-09:** The guard should be slice-aware rather than a repo-wide string ban. It should fail new product/default uses while preserving explicit retained-runtime tests and routes.

### Desktop Pilot Release Bar
- **D-10:** The desktop pilot bar is the full release-hardening bar: first-run routing, database initialization/migrations under `CAREERRAT_HOME`, BYOK key storage path, error recovery, app routing, packaged resource staging, smoke verification, external-link containment, signing, notarization, and update readiness.
- **D-11:** Because the user has an Apple developer account, notarization should be treated as a real pilot requirement, not only a deferred note. Planning should wire the electron-builder/notarytool path without storing Apple credentials in the repo.
- **D-12:** A signed and notarized macOS DMG is the pilot target. Local/offline unsigned or signed-only builds may remain useful for development, but they should not be the final pilot success signal.
- **D-13:** Auto-update infrastructure does not need to become a large new product feature in this phase. The release bar should at least verify the existing update path/readiness story and avoid claiming auto-update exists if it does not.
- **D-14:** Desktop verification should prove the packaged app does not depend on the checkout, writes user data outside the signed resources tree, boots a fresh workspace into `/app/onboarding`, opens an existing candidate into `/app`, and fails with recoverable UI/logging rather than a blank window.

### Product Docs Posture
- **D-15:** Do not spend this phase on a broad documentation rewrite. The app is a separate product from the other version, and its docs will align to that product outside this context-capture decision.
- **D-16:** Phase 11 still owns release-critical documentation truthfulness: desktop README/release notes/app-first docs should not tell pilot users that compatibility tracker/static surfaces are the normal product path.
- **D-17:** Treat DESK-02 as "make app-first product docs accurate enough for pilot and avoid misleading compatibility guidance," not "rewrite all open-core/agent docs now."

### the agent's Discretion
The user delegated the exact implementation mechanics for runtime lockdown and static-guard boundaries. Downstream agents should choose the cleanest shape that fits the existing code: route names, config flags, tool-manifest format, allowlist defaults, static-scan implementation, test file layout, notarization config shape, and release verification commands. Preserve the locked intent above: strict app-safe defaults, explicit tool-heavy execution, slice-aware app-default guards, full desktop pilot bar, real notarization with developer-account credentials kept outside source, and minimal release-critical docs only.

### Deferred Ideas (OUT OF SCOPE)
- Broad product documentation rewrite for the separate paid app can happen outside this phase.
- Full auto-update infrastructure remains separate unless planning finds a small readiness-only check already supported by the existing update command.
</user_constraints>

## Summary

Phase 11 should be planned as a boundary-hardening phase, not as another workflow migration. The app-default product path already has an architectural policy of local APIs, DB verbs, bounded AI, explicit chat handoffs, and retained skill runtime only for workflows that need a tool loop. That policy is documented in `docs/ARCHITECTURE.md` and reinforced by Phase 11 decisions. [VERIFIED: codebase grep]

The central runtime risk is that `src/core/ai/skill-runtime.mjs` currently defines broad default tools including `Write`, `Edit`, and `Bash`, and `runSkillStream()` uses `permissionMode: "bypassPermissions"` when it invokes the Agent SDK. The SDK documents `tools`, `disallowedTools`, `permissionMode`, `skills`, and `env` options; it also documents that `canUseTool` is not invoked for calls already approved by allowed tools/settings/permission mode. The planner should therefore make the default tool list narrow and make any tool-heavy path explicit. [VERIFIED: codebase grep] [CITED: https://code.claude.com/docs/en/agent-sdk/typescript]

The desktop side is close to pilotable but not yet release-grade: the Electron shell already sets packaged `CAREERRAT_HOME`, stages resources, has first-run route logic, and has smoke helpers; `electron-builder.yml` currently ships a macOS arm64 DMG with hardened runtime but notarization disabled. Electron and electron-builder official docs both treat signing/notarization as separate release steps for distributed macOS apps, and electron-builder supports notarization with credentials kept outside tracked config. [VERIFIED: codebase grep] [CITED: https://www.electronjs.org/docs/latest/tutorial/code-signing] [CITED: https://www.electron.build/docs/features/code-signing/notarization/]

**Primary recommendation:** Use the existing stack, add no new package by default, split runtime tools into `app-safe` and explicitly declared `tool-heavy`, add slice-aware static guards for app-default surfaces, then make the desktop pilot gate require signed/notarized DMG verification plus first-run/data-root/package smoke tests. [VERIFIED: codebase grep] [CITED: https://www.electron.build/docs/features/code-signing/notarization/]

## Project Constraints (from AGENTS.md)

- Skills are the procedure contracts for CareerRat workflows; agents should open and follow the owning skill instead of improvising workflow behavior. [VERIFIED: AGENTS.md]
- The app default for company discovery is the local proposal path: `/api/discovery/company-proposals` and `/api/discovery/company-proposal-decisions`. Local proposal errors must not silently start chat, `/api/chat/*`, full skill runtime, or `POST /api/skill/run`. [VERIFIED: AGENTS.md]
- `/api/discovery/quick-start` and `/api/discovery/next` are explicit user-selected chat handoffs. `POST /api/skill/run` remains the retained allowlisted full skill runtime for tool-heavy, long-running, or human-watched workflows, not the default app path for deterministic validation, dedupe, proposal creation, proposal decisions, or confirmed writes. [VERIFIED: AGENTS.md]
- Local AI key storage is owned by `src/core/ai/ai-env.mjs`; with `CAREERRAT_HOME` set, BYOK credentials live at `<CAREERRAT_HOME>/internal/ai.env`, otherwise legacy mode uses `.internal/ai.env`; the file is chmod `0600`, loaded at server boot, and never echoed back by the API. [VERIFIED: AGENTS.md]
- In DB workspaces, tracker-visible mutations must go through `careerrat data <verb>` and generated `workspace/tracker.json` / `workspace/activity.jsonl` must not be hand-edited. [VERIFIED: AGENTS.md]
- Browser, mail, calendar, and message automation capabilities are opt-in and capability-gated; session-browser or authenticated automation must not become an implicit app-default behavior. [VERIFIED: AGENTS.md] [VERIFIED: project skills grep]
- Candidate-specific facts, current compensation, private notes, local paths, raw prompts, raw AI output, page bodies, and job postings must not leak into public or release artifacts. [VERIFIED: AGENTS.md] [VERIFIED: docs/ARCHITECTURE.md]
- If the implementation mutates tracker-visible state, it must follow the DB write contract or legacy tracker write contract and run the required verification/render steps. Phase 11 research itself does not mutate tracker state. [VERIFIED: AGENTS.md]

## Architectural Responsibility Map

| Capability | Primary Tier | Secondary Tier | Rationale |
|------------|--------------|----------------|-----------|
| App-safe skill runtime defaults | API / Backend | Skill Contract Layer | `runSkillStream()` and `/api/skill/run` own SDK invocation, allowed tools, skill allowlists, abort handling, and status mapping. [VERIFIED: codebase grep] |
| Explicit tool-heavy retained runtime | API / Backend | Conversational Chat / Skill Runtime | Tool-heavy workflows remain valid only when the route, skill, or manifest classifies them explicitly. [VERIFIED: 11-CONTEXT.md] |
| App-default ban guard | Test / Quality Gate | Browser / Client and API / Backend | The guard must scan React `/app`, product HTTP routes, onboarding, search, deep-ingest, packet/evaluate/apply, and Electron wiring while allowing classified retained-runtime surfaces. [VERIFIED: 11-CONTEXT.md] |
| First-run desktop routing | Desktop Main Process | Browser / Client | `apps/desktop/main.mjs` starts the local server and `desktop-routing.mjs` decides `/app/onboarding` versus `/app`. [VERIFIED: codebase grep] |
| Packaged data root and BYOK storage | Desktop Main Process | API / Backend | The packaged shell sets `CAREERRAT_HOME`; `ai-env.mjs` owns BYOK credential file placement and permissions. [VERIFIED: codebase grep] [VERIFIED: AGENTS.md] |
| macOS signing/notarization | Build / Release | Desktop Packaging | `electron-builder.yml` owns DMG packaging and should own notarization wiring while credentials stay in keychain/CI env. [VERIFIED: codebase grep] [CITED: https://www.electron.build/docs/features/code-signing/notarization/] |
| Update readiness | Build / Release | Documentation | Electron auto-update on macOS requires signed apps and update metadata; Phase 11 should verify and document readiness without claiming full auto-update if not implemented. [CITED: https://www.electronjs.org/docs/latest/api/auto-updater] [CITED: https://www.electron.build/docs/features/auto-update/] |
| Product docs truthfulness | Documentation / Release | Desktop Packaging | DESK-02 is limited to app-first pilot docs and release notes, not a broad docs migration. [VERIFIED: 11-CONTEXT.md] |

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|------------------|
| SEC-01 | Static checks fail new app-default calls to full skill runtime where a local API owner exists. | Use a slice-aware static scan that covers product/app files and requires explicit classification for retained runtime references. [VERIFIED: 11-CONTEXT.md] [VERIFIED: tests/db-app-shell-regression.test.mjs] |
| SEC-02 | The retained skill runtime removes broad `Write`, `Edit`, and `Bash` tools by default; tool-heavy execution is explicit. | Change `RUNTIME_TOOLS`/`runSkillStream()` defaults to an app-safe profile, retain narrow per-call overrides, and add explicit tool-heavy manifests/routes for allowed workflows. [VERIFIED: src/core/ai/skill-runtime.mjs] [CITED: https://code.claude.com/docs/en/agent-sdk/typescript] |
| DESK-01 | Electron first-run, database initialization, routing, packaging, error recovery, and update/notarization readiness are verified for pilot use. | Extend existing desktop routing, smoke, package resources, release-safety, and builder config coverage; require signed/notarized DMG verification for pilot success. [VERIFIED: apps/desktop/*] [CITED: https://www.electron.build/docs/features/code-signing/notarization/] |
| DESK-02 | Product docs teach the app-first workflow and no longer present compatibility surfaces as the normal path. | Update only release-critical desktop/app-first docs and add doc guards for compatibility-surface wording in pilot-facing files. [VERIFIED: 11-CONTEXT.md] |
</phase_requirements>

## Standard Stack

### Core

| Library / Tool | Version | Purpose | Why Standard |
|----------------|---------|---------|--------------|
| Node.js | 24.18.0 available; project engine `>=24` | Runtime and test execution | The repo declares Node `>=24`, and the local runtime matches it. [VERIFIED: package.json] [VERIFIED: local command] |
| npm | 11.16.0 | Workspace package manager | The repo declares `packageManager: npm@11.16.0`, and the local npm version matches it. [VERIFIED: package.json] [VERIFIED: local command] |
| Electron `electron` [WARNING: package-legitimacy seam flagged as suspicious due to too-new latest publish; verify before upgrading.] | 43.0.0 installed/latest | Desktop shell | Existing desktop workspace uses Electron 43.0.0; official Electron docs provide the security and signing baseline. [VERIFIED: npm registry] [CITED: https://www.electronjs.org/docs/latest/tutorial/security] |
| electron-builder `electron-builder` [WARNING: package-legitimacy seam flagged as suspicious due to too-new latest publish; verify before upgrading.] | 26.15.3 installed/latest | macOS DMG packaging, signing, notarization wiring | Existing desktop package uses electron-builder; official electron-builder docs cover macOS notarization, entitlements, and verification. [VERIFIED: npm registry] [CITED: https://www.electron.build/docs/features/code-signing/notarization/] |
| `@anthropic-ai/claude-agent-sdk` [WARNING: package-legitimacy seam flagged as suspicious due to too-new latest publish; verify before upgrading.] | 0.3.199 installed; 0.3.201 latest | Retained skill runtime and chat runtime | Existing runtime uses SDK `query()` with `tools`, `skills`, `permissionMode`, and env options. [VERIFIED: npm registry] [CITED: https://code.claude.com/docs/en/agent-sdk/typescript] |
| Node `node:test` | Built-in | Unit and static guard tests | Existing repo test script is `node --test 'tests/**/*.test.mjs'`. [VERIFIED: package.json] |

### Supporting

| Library / Tool | Version | Purpose | When to Use |
|----------------|---------|---------|-------------|
| `xcrun notarytool` | 1.1.2 available | Apple notarization upload/history/store-credentials workflow | Use for Developer ID notarization credentials kept outside source. [VERIFIED: local command] |
| `xcrun stapler` | Available | Staple and validate notarization tickets for DMG/app artifacts | Use after notarization or via electron-builder automatic stapling when notarize is enabled. [VERIFIED: local command] [CITED: https://www.electron.build/docs/features/code-signing/notarization/] |
| macOS signing identity | Developer ID Application: Scott Benson (3524374A2S) present | Sign pilot DMG/app for distribution | Electron docs state macOS release distribution requires signing then notarization. [VERIFIED: local command] [CITED: https://www.electronjs.org/docs/latest/tutorial/code-signing] |
| `mammoth` | 1.12.0 installed/latest | Existing deterministic DOCX intake support | Not central to Phase 11, but retained as existing package surface for release/package audit. [VERIFIED: npm registry] |

### Alternatives Considered

| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| App-safe default tool profile | Keep broad `RUNTIME_TOOLS` and rely on skill allowlists | This preserves the current risk: `bypassPermissions` plus `Write`/`Edit`/`Bash` gives headless flows broad mutation power. Use app-safe defaults. [VERIFIED: codebase grep] |
| Explicit `tools` / tool profile manifest | Agent SDK `canUseTool` callback alone | SDK docs state `canUseTool` is not invoked for calls already allowed by settings/permission mode, so it is not sufficient as the sole gate. [CITED: https://code.claude.com/docs/en/agent-sdk/typescript] |
| electron-builder notarization | Hand-written notary upload/staple scripts | electron-builder already owns the package pipeline and documents signing, notarization, and stapling as integrated when configured. [CITED: https://www.electron.build/docs/features/code-signing/notarization/] |
| Add `electron-updater` now | Update-readiness docs/config checks only | Electron-builder auto-update docs require installing `electron-updater`, publishing metadata, and macOS zip artifacts; Phase 11 decision D-13 says do not turn auto-update into a large feature. [CITED: https://www.electron.build/docs/features/auto-update/] [VERIFIED: 11-CONTEXT.md] |
| Repo-wide string ban on `/api/skill/run` | Slice-aware static guard | The repo intentionally retains CLI/debug/legacy/chat/full-runtime surfaces, so a repo-wide ban would create false positives and pressure unsafe workarounds. [VERIFIED: 11-CONTEXT.md] |

**Installation:**

```bash
# No new packages are recommended for Phase 11.
# Use existing workspace dependencies and verify before upgrading SUS packages.
npm install
```

## Package Legitimacy Audit

| Package | Registry | Age | Downloads | Source Repo | Verdict | Disposition |
|---------|----------|-----|-----------|-------------|---------|-------------|
| `electron` | npm | Created 2012-05-18; latest published 2026-06-30 | 4.3M/week | github.com/electron/electron | SUS | Keep existing 43.0.0; planner must add checkpoint before upgrading because seam flagged latest publish as too-new. [VERIFIED: npm registry] |
| `electron-builder` | npm | Created 2015-05-26; latest published 2026-06-09 | 2.6M/week | github.com/electron-userland/electron-builder | SUS | Keep existing 26.15.3; planner must add checkpoint before upgrading because seam flagged latest publish as too-new. [VERIFIED: npm registry] |
| `@anthropic-ai/claude-agent-sdk` | npm | Created 2025-09-27; latest published 2026-07-03 | 6.8M/week | github.com/anthropics/claude-agent-sdk-typescript | SUS | Keep installed 0.3.199 unless an explicit checkpoint approves moving to 0.3.201. [VERIFIED: npm registry] |
| `mammoth` | npm | Created 2013-05-06; latest published 2026-03-12 | 5.2M/week | github.com/mwilliamson/mammoth.js | OK | Approved existing dependency; no Phase 11 install required. [VERIFIED: npm registry] |

**Packages removed due to [SLOP] verdict:** none. [VERIFIED: package-legitimacy seam]

**Packages flagged as suspicious [SUS]:** `electron`, `electron-builder`, `@anthropic-ai/claude-agent-sdk`. Planner should include human-checkpoint tasks before upgrading or newly installing these packages. [VERIFIED: package-legitimacy seam]

**Postinstall audit:** `npm view <pkg> scripts.postinstall` returned no package-level postinstall script for `electron`, `electron-builder`, `@anthropic-ai/claude-agent-sdk`, or `mammoth`; the root repo itself has a `postinstall` script for local skill installation. [VERIFIED: npm registry] [VERIFIED: package.json]

## Architecture Patterns

### System Architecture Diagram

```text
User action in /app or Electron shell
  -> App-default surface classifier
    -> Local API / DB verb / bounded AI helper
       -> SQLite product state / local artifacts / bounded manual fallback
    -> Explicit chat handoff selected by user
       -> /api/chat/* -> chat runtime -> visible session
    -> Explicit retained full-skill action
       -> /api/skill/run -> runtime tool manifest
          -> Agent SDK query() with narrow app-safe tools by default
          -> Tool-heavy tools only for classified routes/skills

Build/release path
  -> npm run app:build
  -> apps/desktop/scripts/stage.mjs
  -> electron-builder
  -> Developer ID signing
  -> notarization and stapling
  -> packaged smoke: fresh workspace, existing workspace, data root, external links, recovery UI/logging
```

### Recommended Project Structure

```text
src/core/ai/
├── runtime-tools.mjs          # App-safe/tool-heavy tool profiles and manifest helpers
├── skill-runtime.mjs          # One-shot retained runtime, defaulting to app-safe tools
└── chat-runtime.mjs           # Explicit conversational runtime, separately classified

src/cli/
└── skill-run-route.mjs        # SSE route, runtime config, explicit profile validation

apps/desktop/
├── main.mjs                   # Shell boot, CAREERRAT_HOME, link containment, smoke mode
├── electron-builder.yml       # Signing/notarization release config
├── build/                     # Entitlements and release-only signing metadata templates
└── README.md                  # Pilot-accurate desktop docs

tests/
├── skill-runtime.test.mjs     # Default app-safe tools, explicit tool-heavy profile
├── skill-run-route.test.mjs   # Route config/profile/status behavior
├── app-default-runtime-guard.test.mjs  # Slice-aware hidden-runtime guard
├── desktop-package-resources.test.mjs  # Staging/signing/notarization config
├── desktop-smoke.test.mjs     # Fresh/existing package smoke helpers
└── release-safety.test.mjs    # Private data/package/docs safety guards
```

### Pattern 1: Tool Profiles as the Runtime Boundary

**What:** Centralize the tool surface into named profiles and make `app-safe` the default. Keep `tools` per-call override for narrower cases such as `resume-extract`. [VERIFIED: src/core/ai/skill-runtime.mjs] [CITED: https://code.claude.com/docs/en/agent-sdk/typescript]

**When to use:** Every `runSkillStream()` caller should either accept the app-safe default, narrow the tools further, or name a tool-heavy profile with justification. [VERIFIED: 11-CONTEXT.md]

**Example:**

```javascript
// Source: Agent SDK TypeScript docs and existing runSkillStream({ tools }) seam.
export const APP_SAFE_TOOLS = Object.freeze(["Read", "Glob", "Grep", "WebFetch", "Skill"]);
export const TOOL_HEAVY_TOOLS = Object.freeze([
  ...APP_SAFE_TOOLS,
  "Write",
  "Edit",
  "Bash",
]);

export function resolveRuntimeTools({ tools, profile = "app-safe" } = {}) {
  if (Array.isArray(tools)) return tools;
  if (profile === "tool-heavy") return TOOL_HEAVY_TOOLS;
  return APP_SAFE_TOOLS;
}
```

**Planning note:** `Skill` must remain in explicit tool lists when the SDK is expected to load a skill; the SDK docs state that when both `skills` and `tools` are passed, `Skill` must be included to use skills. [CITED: https://code.claude.com/docs/en/agent-sdk/typescript]

### Pattern 2: Route-Level Runtime Classification

**What:** Expose runtime capability metadata as classified actions instead of an undifferentiated "skill run available" boolean. `/api/runtime/config` already returns skill and AI metadata and is a natural place to publish `appSafe`, `toolHeavy`, and `chatHandoff` categories without secrets. [VERIFIED: src/cli/skill-run-route.mjs] [VERIFIED: STATE.md]

**When to use:** Product UI should show local/bounded actions first, explicit chat handoffs second, and retained full-skill actions only when the action is intentionally classified. [VERIFIED: docs/ARCHITECTURE.md]

**Example:**

```javascript
// Source: existing /api/runtime/config response shape.
const runtimeConfig = {
  ai: { available: true },
  skillRuntime: {
    available: true,
    defaultProfile: "app-safe",
    toolHeavy: ["apply-job", "sync-status", "interview-prep"],
  },
  chat: {
    available: true,
    handoffs: ["research-boards", "discover-companies", "search-jobs"],
  },
};
```

### Pattern 3: Slice-Aware Static Guard

**What:** Scan known app-default files for hidden full-runtime calls while allowing explicitly classified compatibility/debug/chat/full-runtime files. Existing static guards already strip comments before token scans and use path slices rather than repo-wide bans. [VERIFIED: tests/db-app-shell-regression.test.mjs] [VERIFIED: tests/quick-onboarding-auto-sourcing-regression.test.mjs]

**When to use:** For SEC-01, guard React `/app`, product route modules, onboarding/search/deep-ingest/packet/evaluate/apply surfaces, and Electron product wiring. [VERIFIED: 11-CONTEXT.md]

**Example:**

```javascript
// Source: existing regression guard style in tests/db-app-shell-regression.test.mjs.
const APP_DEFAULT_FILES = [
  "apps/web/src/App.jsx",
  "src/cli/discovery-route.mjs",
  "src/cli/onboard-route.mjs",
  "src/cli/search-route.mjs",
  "apps/desktop/main.mjs",
];

const RETAINED_RUNTIME_FILES = new Set([
  "src/cli/skill-run-route.mjs",
  "src/core/ai/skill-runtime.mjs",
  "src/core/ai/chat-runtime.mjs",
]);

for (const file of APP_DEFAULT_FILES) {
  const source = stripJavaScriptComments(readFileSync(file, "utf8"));
  assert.equal(source.includes("/api/skill/run"), false, `${file} hides full runtime`);
}
```

### Pattern 4: Release-Grade Electron Packaging

**What:** Keep electron-builder as the packaging owner, enable real signing/notarization for pilot builds, and verify artifacts with local Apple tooling. electron-builder documents signing, notarization, stapling, and verification as separate concerns that it can orchestrate when configured. [CITED: https://www.electron.build/docs/features/code-signing/notarization/]

**When to use:** DESK-01 pilot release success should require a signed and notarized macOS DMG, not merely a local unsigned dev build. [VERIFIED: 11-CONTEXT.md]

**Example:**

```yaml
# Source: electron-builder notarization docs.
mac:
  target:
    - target: dmg
      arch:
        - arm64
    - target: zip
      arch:
        - arm64
  category: public.app-category.productivity
  hardenedRuntime: true
  forceCodeSigning: true
  entitlements: build/entitlements.mac.plist
  entitlementsInherit: build/entitlements.mac.inherit.plist
  notarize: true
```

### Pattern 5: External-Link Containment

**What:** Keep navigation inside the local CareerRat origin and send only validated external URLs to `shell.openExternal`. Electron security docs warn that opening untrusted content with `shell.openExternal` can compromise the host. [VERIFIED: apps/desktop/main.mjs] [CITED: https://www.electronjs.org/docs/latest/tutorial/security]

**When to use:** Update both `setWindowOpenHandler` and `will-navigate` logic so malicious or unexpected protocols do not leave the Electron app. [CITED: https://www.electronjs.org/docs/latest/tutorial/security]

**Example:**

```javascript
// Source: Electron security checklist for navigation/window/openExternal controls.
function isAllowedExternalUrl(value) {
  const url = new URL(value);
  return url.protocol === "https:" || url.protocol === "mailto:";
}
```

### Anti-Patterns to Avoid

- **Broad default runtime tools:** Do not leave `Write`, `Edit`, or `Bash` in the default one-shot runtime path while using `permissionMode: "bypassPermissions"`. [VERIFIED: src/core/ai/skill-runtime.mjs] [VERIFIED: 11-CONTEXT.md]
- **Hidden app-default `/api/skill/run`:** Do not let product buttons silently invoke the full skill runtime where a local API owner exists. [VERIFIED: docs/ARCHITECTURE.md]
- **Repo-wide runtime string ban:** Do not block all runtime references; explicit retained routes, chat handoffs, debug/export compatibility routes, and tests need classified references. [VERIFIED: 11-CONTEXT.md]
- **Unsigned pilot artifact:** Do not define pilot success as an unsigned/offline DMG when notarization is a locked requirement. [VERIFIED: 11-CONTEXT.md]
- **Docs drift:** Do not update broad docs while leaving pilot-facing desktop docs saying tracker/static compatibility pages are the normal product path. [VERIFIED: 11-CONTEXT.md]

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| macOS signing/notarization | Custom notarization uploader/stapler scripts | electron-builder notarization plus `notarytool`/keychain credentials | electron-builder documents the supported config, credential env/profile shapes, and stapling behavior. [CITED: https://www.electron.build/docs/features/code-signing/notarization/] |
| Tool permission safety | Interactive permission prompts in a headless local server | Narrow SDK `tools` profile plus explicit tool-heavy manifest | The current runtime intentionally bypasses permission prompts, so allowed tools are the practical safety boundary. [VERIFIED: src/core/ai/skill-runtime.mjs] |
| Runtime authorization policy | Scattered inline arrays in routes | Central `runtime-tools.mjs` or equivalent manifest helper | Existing runtime already centralizes allowlists; central profiles keep SEC-02 testable. [VERIFIED: src/core/ai/skill-runtime.mjs] |
| Product route migration checks | Manual review of every `/api/skill/run` occurrence | Slice-aware static guard with classified allowed files | Existing regression tests use static guard patterns for DB/app-shell boundaries. [VERIFIED: tests/db-app-shell-regression.test.mjs] |
| Update feature | Claiming auto-update from `careerrat update` or DMG packaging alone | Readiness check and truthful docs unless `electron-updater` is actually implemented | Electron-builder docs require `electron-updater`, published metadata, and macOS zip artifacts for auto-update. [CITED: https://www.electron.build/docs/features/auto-update/] |
| Candidate data protection | Copying workspace/candidate files into desktop resources | Existing staged package allowlist and release-safety scans | Current staging uses package `files[]`, and release-safety tests already guard private data leakage. [VERIFIED: apps/desktop/scripts/stage.mjs] [VERIFIED: tests/release-safety.test.mjs] |

**Key insight:** The phase is not about removing the retained runtime. It is about making the cheap/default product path incapable of reaching broad tool power by accident while preserving explicit, visible, tool-heavy lanes for workflows that genuinely need them. [VERIFIED: 11-CONTEXT.md] [VERIFIED: docs/ARCHITECTURE.md]

## Common Pitfalls

### Pitfall 1: `bypassPermissions` Makes the Tool List the Real Boundary

**What goes wrong:** A product action can mutate the workspace or run shell commands if it reaches the current broad default runtime. [VERIFIED: src/core/ai/skill-runtime.mjs]

**Why it happens:** The current one-shot runtime supplies `Write`, `Edit`, and `Bash` by default while bypassing SDK permission prompts. [VERIFIED: src/core/ai/skill-runtime.mjs]

**How to avoid:** Make app-safe tools the default and require explicit tool-heavy classification. [VERIFIED: 11-CONTEXT.md]

**Warning signs:** Any unclassified caller to `runSkillStream()` or product file reference to `/api/skill/run`. [VERIFIED: codebase grep]

### Pitfall 2: Relying on `canUseTool` as the Only Gate

**What goes wrong:** A callback-based gate can be skipped for pre-approved tool calls. [CITED: https://code.claude.com/docs/en/agent-sdk/typescript]

**Why it happens:** SDK docs state that `canUseTool` is not invoked for calls already approved by allowed tools, settings, or permission mode. [CITED: https://code.claude.com/docs/en/agent-sdk/typescript]

**How to avoid:** Gate with narrow `tools` and optional `disallowedTools`; treat callbacks/hooks as defense-in-depth, not the main control. [CITED: https://code.claude.com/docs/en/agent-sdk/typescript]

**Warning signs:** A plan that adds `canUseTool` but leaves broad `RUNTIME_TOOLS` in place. [VERIFIED: src/core/ai/skill-runtime.mjs]

### Pitfall 3: Breaking SDK Skill Loading by Omitting `Skill`

**What goes wrong:** Passing explicit `tools` can disable skill usage if `Skill` is omitted. [CITED: https://code.claude.com/docs/en/agent-sdk/typescript]

**Why it happens:** SDK docs state that when both `skills` and `tools` are supplied, the `tools` list must include `Skill` for skills to be usable. [CITED: https://code.claude.com/docs/en/agent-sdk/typescript]

**How to avoid:** Include `Skill` in app-safe/tool-heavy profiles when the runtime expects `skills: [skill]`; keep narrower per-call overrides only where skill loading is not required or already validated. [VERIFIED: src/core/ai/skill-runtime.mjs]

**Warning signs:** Runtime tests pass `skills` and explicit tools but fail to emit skill-driven events. [VERIFIED: tests/skill-runtime.test.mjs]

### Pitfall 4: `shell.openExternal` Without URL Validation

**What goes wrong:** A malicious or malformed link can trigger an unsafe external open. [CITED: https://www.electronjs.org/docs/latest/tutorial/security]

**Why it happens:** The current shell opens target URLs externally when they are outside the local base URL, but Phase 11 should validate allowed schemes before calling `shell.openExternal`. [VERIFIED: apps/desktop/main.mjs]

**How to avoid:** Allow only known-safe schemes such as `https:` and `mailto:`; deny everything else and log recoverably. [CITED: https://www.electronjs.org/docs/latest/tutorial/security]

**Warning signs:** `shell.openExternal(targetUrl)` called directly on route/window navigation input. [VERIFIED: apps/desktop/main.mjs]

### Pitfall 5: Notarization Config That Looks Enabled But Cannot Ship

**What goes wrong:** A DMG builds locally but is unsigned, not notarized, or not stapled, so it is not a valid pilot success artifact. [VERIFIED: apps/desktop/electron-builder.yml] [CITED: https://www.electronjs.org/docs/latest/tutorial/code-signing]

**Why it happens:** Current config has `hardenedRuntime: true` but `notarize: false`; notarization also requires Apple credentials outside the repo. [VERIFIED: apps/desktop/electron-builder.yml] [CITED: https://www.electron.build/docs/features/code-signing/notarization/]

**How to avoid:** Add release config, entitlements, credential instructions, and verification commands; keep local unsigned/dev builds as non-pilot. [CITED: https://www.electron.build/docs/features/code-signing/notarization/]

**Warning signs:** README or release notes say "notarization deferred" while DESK-01/D-11/D-12 require notarized pilot artifacts. [VERIFIED: apps/desktop/README.md] [VERIFIED: 11-CONTEXT.md]

### Pitfall 6: Packaged App Depending on the Checkout

**What goes wrong:** A desktop artifact passes on a developer machine but fails for a pilot user because it reads the repo checkout or root `node_modules`. [VERIFIED: apps/desktop/scripts/stage.mjs]

**Why it happens:** The desktop app dynamically imports staged runtime files from `process.resourcesPath/careerrat` in packaged mode; staging and package resources must be complete. [VERIFIED: apps/desktop/main.mjs] [VERIFIED: apps/desktop/scripts/stage.mjs]

**How to avoid:** Extend package-resource tests and packaged smoke to assert no checkout dependency, staged SDK presence, web dist presence, and data writes under `CAREERRAT_HOME`. [VERIFIED: tests/desktop-package-resources.test.mjs]

**Warning signs:** Smoke passes only with repo root present or after deleting staged resources it still appears to work. [VERIFIED: apps/desktop/desktop-smoke.mjs]

## Code Examples

Verified patterns from official sources and current source:

### Safe Runtime Invocation

```javascript
// Source: src/core/ai/skill-runtime.mjs and Agent SDK TypeScript docs.
const abortController = new AbortController();
const toolsForCall = resolveRuntimeTools({ profile: "app-safe" });

const stream = query({
  prompt,
  abortController,
  options: {
    cwd: root,
    tools: toolsForCall,
    skills: [skill],
    permissionMode: "bypassPermissions",
    env: buildChildEnv({ env: process.env, root }),
  },
});
```

### Tool-Heavy Manifest Shape

```javascript
// Source: Phase 11 D-02/D-04 and existing runtime allowlist pattern.
export const TOOL_HEAVY_RUNTIME_SKILLS = Object.freeze({
  "apply-job": "browser/auth supervised application workflow",
  "sync-status": "authenticated portal/status polling workflow",
  "interview-prep": "long-running human-watched prep workflow",
});

export function requireToolHeavySkill(skill) {
  if (!Object.hasOwn(TOOL_HEAVY_RUNTIME_SKILLS, skill)) {
    throw Object.assign(new Error(`Skill ${skill} is not tool-heavy allowlisted`), {
      code: "TOOL_HEAVY_NOT_ALLOWED",
    });
  }
}
```

### Desktop Notarization Verification Commands

```bash
# Source: electron-builder notarization docs and local Apple tooling.
npm run app:build
npm --workspace apps/desktop run stage
npm --workspace apps/desktop run dist
for dmg in apps/desktop/dist/*.dmg; do
  xcrun stapler validate "$dmg"
  spctl --assess --type open --context context:primary-signature --verbose "$dmg"
done
codesign --verify --deep --strict --verbose=2 "apps/desktop/dist/mac-arm64/CareerRat.app"
```

### Release-Safety Static Guard

```javascript
// Source: tests/release-safety.test.mjs and package allowlist behavior.
const forbiddenReleaseTokens = [
  "candidate/profile",
  "workspace/tracker.json",
  "current_base",
  "/Users/",
];

for (const file of releaseFacingFiles) {
  const source = stripJavaScriptComments(readFileSync(file, "utf8"));
  for (const token of forbiddenReleaseTokens) {
    assert.equal(source.includes(token), false, `${file} leaks ${token}`);
  }
}
```

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| Electron renderers commonly had Node integration enabled | Disable Node integration for renderers that display remote or untrusted content | Electron security checklist current docs | Prevents XSS from escalating directly into Node/RCE. [CITED: https://www.electronjs.org/docs/latest/tutorial/security] |
| Context isolation was optional | Context isolation is default in Electron 12+ and should stay enabled | Electron 12 | Electron APIs and preload APIs stay isolated from renderer content. [CITED: https://www.electronjs.org/docs/latest/tutorial/security] |
| Renderer sandboxing was opt-in | Renderer sandbox is default in Electron 20+ and should stay enabled for sandboxable renderers | Electron 20 | Reduces renderer privilege if content is compromised. [CITED: https://www.electronjs.org/docs/latest/tutorial/security] |
| macOS release could be treated as signing only | macOS distribution requires signing plus notarization for outside-Mac-App-Store release | Current Electron code-signing docs | Phase 11 pilot success should be signed and notarized. [CITED: https://www.electronjs.org/docs/latest/tutorial/code-signing] |
| Auto-update claim from packaging alone | Auto-update needs update integration, metadata, hosting, signing, and macOS zip artifacts | Current electron-builder auto-update docs | Phase 11 should avoid claiming auto-update unless those pieces exist. [CITED: https://www.electron.build/docs/features/auto-update/] |

**Deprecated/outdated:**

- `altool`-style notarization planning is outdated; use `notarytool`/keychain profile flow for current macOS notarization. [CITED: https://developer.apple.com/documentation/security/notarizing-macos-software-before-distribution] [VERIFIED: local command]
- Desktop docs that present static tracker compatibility pages as the normal product path are outdated for v2 because `/app` plus SQLite is the canonical product surface. [VERIFIED: .planning/STATE.md] [VERIFIED: docs/ARCHITECTURE.md]

## Assumptions Log

| # | Claim | Section | Risk if Wrong |
|---|-------|---------|---------------|
| A1 | No new runtime or desktop package is necessary for Phase 11 if the planner treats auto-update as readiness/docs rather than implementation. [ASSUMED] | Standard Stack | If auto-update is pulled into scope, `electron-updater` and publishing metadata need separate package legitimacy, tests, and release tasks. |
| A2 | The keychain profile name can be chosen during implementation, with `careerrat-notary` as an example rather than a locked existing profile. [ASSUMED] | Resolved Open Questions / Environment Availability | If a specific CI/keychain profile already exists, docs and commands should use that exact name. |
| A3 | Explicit conversational chat handoffs are retained only as visible, human-watched paths with named profile/classification checks. [ASSUMED] | Resolved Open Questions | If implementation finds a chat path that is not visible to the user, the Phase 11 guard should fail it as an app-default regression. |
| A4 | `spctl` and `codesign` are expected to be available through local macOS command line tools but were not separately version-probed. [ASSUMED] | Environment Availability | If missing, release verification needs an Xcode command line tools setup task. |

## Open Questions (RESOLVED)

1. **Does a `notarytool` keychain profile already exist for this project?**
   - What we know: Developer ID Application identity is present locally, and `notarytool store-credentials` supports keychain-profile storage. [VERIFIED: local command]
   - Resolution: Plan 11-05 remains non-autonomous and includes a blocking credential checkpoint that runs `xcrun notarytool history --keychain-profile careerrat-notary --limit 1` or pauses for the exact keychain profile or CI secret path. Plan 11-07 repeats notarized-artifact evidence in the release rollup and does not allow unsigned or signed-only success for D-11/D-12. Credentials stay outside tracked source.

2. **Will Phase 10 finish removing packet/evaluate app defaults before Phase 11 lands?**
   - What we know: Phase 11 context says Phase 10 moves evaluate/gate and packet generation to local APIs, and Phase 11 guards packet/evaluate/apply surfaces. [VERIFIED: 11-CONTEXT.md]
   - Resolution: Plan 11-01 uses slice-aware guards that enforce local-owner/app-default paths and classify retained legacy/static/debug/chat/full-runtime paths by name. Phase 10 ordering is handled by local product slice ownership: packet/evaluate/apply app-default paths must be clean, while retained compatibility surfaces must be explicitly classified instead of silently broadening the app-default allowance.

3. **Should chat runtime tools also narrow in Phase 11?**
   - What we know: `chat-runtime.mjs` inherits broad runtime tools and adds `WebSearch`, but context primarily targets shared one-shot embedded runtime and app-default paths. [VERIFIED: src/core/ai/chat-runtime.mjs] [VERIFIED: 11-CONTEXT.md]
   - Resolution: Plan 11-03 makes chat runtime scope explicit and human-watched. Chat uses named tool profiles or route/session classification from `runtime-tools.mjs`, and `/api/runtime/config` exposes non-secret capability metadata. Chat is allowed only as a visible handoff or classified retained workflow, not as a hidden broad default behind product buttons.

## Environment Availability

| Dependency | Required By | Available | Version | Fallback |
|------------|-------------|-----------|---------|----------|
| Node.js | Build/test/runtime | yes | v24.18.0 | None needed. [VERIFIED: local command] |
| npm | Workspace install/build | yes | 11.16.0 | None needed. [VERIFIED: local command] |
| Electron binary | Desktop smoke/build | yes | 43.0.0 | `npm install` if missing from workspace. [VERIFIED: local command] |
| electron-builder | Desktop DMG build | yes | 26.15.3 | None for pilot packaging; use existing workspace dependency. [VERIFIED: local command] |
| Xcode `xcrun notarytool` | Notarization | yes | 1.1.2 | Blocking for notarized pilot if unavailable. [VERIFIED: local command] |
| Xcode `xcrun stapler` | Staple/validate notarization ticket | yes | available | Blocking for local stapling validation if unavailable. [VERIFIED: local command] |
| Developer ID Application certificate | macOS signing | yes | Scott Benson (3524374A2S) | Blocking for pilot signing if unavailable. [VERIFIED: local command] |
| Apple notarization credentials/keychain profile | Notarization | unknown | -- | Planner must add setup/check task; credentials must not be tracked. [ASSUMED] [CITED: https://www.electron.build/docs/features/code-signing/notarization/] |
| `spctl` / `codesign` verification | Release verification | expected on macOS | -- | Use local Xcode command line tools; planner should verify in release task. [ASSUMED] |

**Missing dependencies with no fallback:**

- Apple notarization credentials/keychain profile are not verified; a signed/notarized pilot artifact is blocked until a profile or CI credential path exists. [ASSUMED]

**Missing dependencies with fallback:**

- None for implementation and focused tests. Local unsigned builds can remain development-only, but they are not an acceptable pilot release fallback. [VERIFIED: 11-CONTEXT.md]

## Validation Architecture

### Test Framework

| Property | Value |
|----------|-------|
| Framework | Node `node:test` built into Node 24.18.0. [VERIFIED: package.json] [VERIFIED: local command] |
| Config file | none; package script runs `node --test 'tests/**/*.test.mjs'`. [VERIFIED: package.json] |
| Quick run command | `node --test tests/skill-runtime.test.mjs tests/skill-run-route.test.mjs tests/desktop-routing.test.mjs tests/desktop-package-resources.test.mjs tests/release-safety.test.mjs` |
| Full suite command | `npm test` |

### Phase Requirements -> Test Map

| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|--------------|
| SEC-01 | Product/app-default slices cannot add hidden `/api/skill/run` calls when local owners exist. | static/unit | `node --test tests/app-default-runtime-guard.test.mjs` | No - Wave 0 |
| SEC-01 | Classified retained runtime, chat, legacy, debug, and test references remain allowed. | static/unit | `node --test tests/app-default-runtime-guard.test.mjs tests/db-app-shell-regression.test.mjs` | Partial - Wave 0 |
| SEC-02 | `runSkillStream()` default tools exclude `Write`, `Edit`, and `Bash`; explicit tool-heavy profile includes them only when declared. | unit | `node --test tests/skill-runtime.test.mjs` | Partial - update existing |
| SEC-02 | `/api/skill/run` exposes safe runtime metadata and rejects/marks unclassified tool-heavy requests. | unit/integration | `node --test tests/skill-run-route.test.mjs` | Partial - update existing |
| DESK-01 | Fresh packaged workspace boots to `/app/onboarding`; existing candidate boots to `/app`. | unit/smoke | `node --test tests/desktop-routing.test.mjs tests/desktop-smoke.test.mjs` | Partial - extend existing |
| DESK-01 | Staged desktop runtime is self-contained, writes user data under `CAREERRAT_HOME`, and excludes private workspace/candidate data. | unit/static | `node --test tests/desktop-package-resources.test.mjs tests/release-safety.test.mjs` | Partial - extend existing |
| DESK-01 | macOS release config supports signing, hardened runtime, entitlements, notarization, and verification commands. | static/manual gate | `node --test tests/desktop-package-resources.test.mjs` plus manual notarization command | Partial - extend existing |
| DESK-02 | Pilot-facing docs teach `/app` desktop workflow and do not present tracker/static compatibility surfaces as normal. | static/docs | `node --test tests/release-safety.test.mjs tests/desktop-docs-release.test.mjs` | No - Wave 0 |

### Sampling Rate

- **Per task commit:** `node --test tests/skill-runtime.test.mjs tests/skill-run-route.test.mjs tests/desktop-routing.test.mjs tests/desktop-package-resources.test.mjs tests/release-safety.test.mjs`
- **Per wave merge:** Focused Phase 11 suite plus any touched slice tests, especially `tests/db-app-shell-regression.test.mjs`, `tests/quick-onboarding-auto-sourcing-regression.test.mjs`, `tests/public-intel-route.test.mjs`, `tests/sourcing-route.test.mjs`, and `tests/deep-ingest-route.test.mjs`.
- **Phase gate:** `npm test` when upstream blockers are resolved; otherwise record that repo-wide `npm test` remains blocked by the existing Phase 08 deep-ingest AI gaps listed in `.planning/STATE.md`. [VERIFIED: .planning/STATE.md]
- **Release gate:** Build, stage, sign/notarize, staple/assess, and smoke a packaged app with both fresh and existing data roots. [CITED: https://www.electron.build/docs/features/code-signing/notarization/]

### Wave 0 Gaps

- [ ] `tests/app-default-runtime-guard.test.mjs` - covers SEC-01 slice-aware product/default runtime ban.
- [ ] `tests/desktop-docs-release.test.mjs` - covers DESK-02 pilot docs truthfulness.
- [ ] Extend `tests/skill-runtime.test.mjs` - cover app-safe default tools and explicit tool-heavy profile.
- [ ] Extend `tests/skill-run-route.test.mjs` - cover route config/profile behavior and unclassified tool-heavy rejection/classification.
- [ ] Extend `tests/desktop-package-resources.test.mjs` - cover signing/notarization config, entitlements, zip readiness if update-readiness checks require it, and staged runtime completeness.
- [ ] Extend `tests/desktop-smoke.test.mjs` or add a packaged-smoke helper - cover packaged fresh/existing workspace and recoverable failure behavior.

## Security Domain

### Applicable ASVS Categories

| ASVS Category | Applies | Standard Control |
|---------------|---------|------------------|
| V2 Authentication | no | No user auth service is introduced in Phase 11; BYOK credential storage is a data-protection concern. [VERIFIED: 11-CONTEXT.md] |
| V3 Session Management | yes | Explicit chat sessions and runtime abort/shutdown remain server-owned and must not be hidden app-default escalations. [VERIFIED: src/core/ai/chat-runtime.mjs] |
| V4 Access Control | yes | Runtime skill allowlists, tool profiles, explicit tool-heavy manifests, static guards, and route classification own access to tools. [VERIFIED: src/core/ai/skill-runtime.mjs] |
| V5 Input Validation | yes | Existing `/api/skill/run` body caps/parsing and product route validation should remain; model output stays schema-validated in bounded AI lanes. [VERIFIED: src/cli/skill-run-route.mjs] [VERIFIED: docs/ARCHITECTURE.md] |
| V6 Cryptography | yes | Use Apple code signing/notarization and chmod `0600` BYOK storage; do not hand-roll cryptography. [CITED: https://www.electronjs.org/docs/latest/tutorial/code-signing] [VERIFIED: AGENTS.md] |
| V8 Data Protection | yes | Keep candidate/workspace/private data out of staged resources, release artifacts, public sync, and docs examples. [VERIFIED: AGENTS.md] [VERIFIED: tests/release-safety.test.mjs] |
| V10 Malicious Code | yes | Minimize Electron renderer privilege, validate external links, keep Electron current, and gate Agent SDK tool power. [CITED: https://www.electronjs.org/docs/latest/tutorial/security] |

### Known Threat Patterns for Electron + Embedded Agent Runtime

| Pattern | STRIDE | Standard Mitigation |
|---------|--------|---------------------|
| Product action reaches `Bash`/`Write`/`Edit` under `bypassPermissions` | Elevation of Privilege / Tampering | App-safe default tools, explicit tool-heavy manifest, allowlisted skills, and static guard. [VERIFIED: src/core/ai/skill-runtime.mjs] |
| Hidden full-runtime dispatch from local product route | Elevation of Privilege / Repudiation | Slice-aware static guard and runtime capability classification. [VERIFIED: 11-CONTEXT.md] |
| Untrusted JD/email/web content prompt-injects retained runtime | Tampering / Information Disclosure | Treat external content as untrusted; bounded AI schema validation for local lanes; retained runtime only for explicit human-watched workflows. [VERIFIED: docs/ARCHITECTURE.md] [VERIFIED: untrusted-input-boundary.md] |
| Unsafe external navigation/openExternal target | Elevation of Privilege / Spoofing | Restrict navigation/window creation and validate URL scheme before `shell.openExternal`. [CITED: https://www.electronjs.org/docs/latest/tutorial/security] |
| Unsigned or unnotarized pilot artifact | Tampering / Repudiation | Developer ID signing, notarization, stapling, and verification commands. [CITED: https://www.electronjs.org/docs/latest/tutorial/code-signing] |
| Private workspace data included in packaged resources | Information Disclosure | Package from allowlisted staged resources and extend release-safety scans. [VERIFIED: apps/desktop/scripts/stage.mjs] |
| Apple credentials committed to source | Information Disclosure | Use keychain profile, env vars, or CI secrets; never tracked config. [CITED: https://www.electron.build/docs/features/code-signing/notarization/] |
| Dependency upgrade drift in fast-moving packages | Tampering / Supply Chain | Package legitimacy checkpoint before upgrading SUS packages; verify versions and postinstall scripts on npm. [VERIFIED: package-legitimacy seam] |

## Sources

### Primary (HIGH confidence)

- `.planning/phases/11-runtime-lockdown-and-desktop-release/11-CONTEXT.md` - locked decisions, phase boundary, canonical refs. [VERIFIED: codebase grep]
- `.planning/REQUIREMENTS.md` - SEC-01, SEC-02, DESK-01, DESK-02 descriptions and traceability. [VERIFIED: codebase grep]
- `.planning/STATE.md` - app-first runtime decisions and current Phase 10/11 status. [VERIFIED: codebase grep]
- `AGENTS.md` and `candidate/AGENTS.md` - runtime routing, DB write, privacy, automation, and skill contract constraints. [VERIFIED: codebase grep]
- `docs/ARCHITECTURE.md` - local API / bounded AI / chat handoff / retained skill runtime policy. [VERIFIED: codebase grep]
- `src/core/ai/skill-runtime.mjs`, `src/cli/skill-run-route.mjs`, `src/core/ai/chat-runtime.mjs` - runtime implementation and current tool surfaces. [VERIFIED: codebase grep]
- `apps/desktop/main.mjs`, `apps/desktop/electron-builder.yml`, `apps/desktop/scripts/stage.mjs`, `apps/desktop/package.json`, `apps/desktop/README.md` - desktop release implementation. [VERIFIED: codebase grep]
- `tests/skill-runtime.test.mjs`, `tests/skill-run-route.test.mjs`, `tests/db-app-shell-regression.test.mjs`, `tests/desktop-package-resources.test.mjs`, `tests/desktop-smoke.test.mjs`, `tests/release-safety.test.mjs` - existing validation patterns and gaps. [VERIFIED: codebase grep]
- npm registry plus package-legitimacy seam - versions, publish dates, weekly download signals, source repos, package verdicts, and postinstall checks. [VERIFIED: npm registry]

### Secondary (MEDIUM confidence)

- https://www.electronjs.org/docs/latest/tutorial/security - Electron security checklist: Node integration, context isolation, sandboxing, navigation/window creation, `shell.openExternal`, fuses, and current Electron guidance. [CITED: https://www.electronjs.org/docs/latest/tutorial/security]
- https://www.electronjs.org/docs/latest/tutorial/code-signing - Electron code signing and macOS notarization baseline. [CITED: https://www.electronjs.org/docs/latest/tutorial/code-signing]
- https://www.electron.build/docs/features/code-signing/notarization/ - electron-builder notarization prerequisites, config, credentials, entitlements, stapling, and verification. [CITED: https://www.electron.build/docs/features/code-signing/notarization/]
- https://www.electron.build/docs/mac/ - electron-builder macOS identity, target, and notarize option behavior. [CITED: https://www.electron.build/docs/mac/]
- https://www.electronjs.org/docs/latest/api/auto-updater - Electron autoUpdater macOS signing requirement. [CITED: https://www.electronjs.org/docs/latest/api/auto-updater]
- https://www.electron.build/docs/features/auto-update/ - electron-builder auto-update requirements, `electron-updater`, metadata, and macOS zip target. [CITED: https://www.electron.build/docs/features/auto-update/]
- https://code.claude.com/docs/en/agent-sdk/typescript - Agent SDK `query()` options, `tools`, `disallowedTools`, `skills`, `env`, `permissionMode`, settings precedence, and `canUseTool` caveat. [CITED: https://code.claude.com/docs/en/agent-sdk/typescript]
- Local `xcrun notarytool help store-credentials`, `xcrun stapler --help`, and `security find-identity` outputs. [VERIFIED: local command]

### Tertiary (LOW confidence)

- Assumptions A1 through A4 in the Assumptions Log. [ASSUMED]

## Metadata

**Confidence breakdown:**

- Standard stack: MEDIUM - versions and installed packages were verified, but three fast-moving packages were flagged SUS by the package legitimacy seam due to recent publishes. [VERIFIED: npm registry]
- Architecture: HIGH - runtime, desktop, docs, and tests were inspected directly in the repository and aligned with locked Phase 11 decisions. [VERIFIED: codebase grep]
- Pitfalls: HIGH - main risks are directly visible in current code or official Electron/SDK docs. [VERIFIED: codebase grep] [CITED: https://www.electronjs.org/docs/latest/tutorial/security] [CITED: https://code.claude.com/docs/en/agent-sdk/typescript]
- Desktop release readiness: MEDIUM - local tools and signing identity exist, but notarization credentials/keychain profile were not verified. [VERIFIED: local command] [ASSUMED]

**Research date:** 2026-07-06
**Valid until:** 2026-07-13 for Electron/Agent SDK release details; 2026-08-05 for codebase architecture if no runtime/desktop refactor lands first.
