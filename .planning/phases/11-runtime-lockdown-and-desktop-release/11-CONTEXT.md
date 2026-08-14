# Phase 11: Runtime Lockdown and Desktop Release - Context

**Gathered:** 2026-07-06T14:03:05Z
**Status:** Ready for planning

<domain>
## Phase Boundary

Phase 11 locks down CareerRat's app-default runtime path and hardens the Electron desktop product for pilot distribution. The phase should remove broad full-skill tool power from normal product actions, add static guards against new hidden `POST /api/skill/run` app defaults where local owners exist, verify first-run and packaged desktop behavior, wire real macOS signing/notarization readiness for a developer-account pilot, and keep release-critical product docs truthful.

This phase does not rebuild the app product surface, migrate another workflow to local APIs, add auto-submit, or perform a broad documentation rewrite. Compatibility surfaces and the retained skill runtime can remain, but they must be explicit, classified, and outside normal product defaults.

</domain>

<decisions>
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

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Product Direction
- `.planning/PROJECT.md` - App-first local runtime, DB source-of-truth posture, retained skill runtime boundary, and key v2 decisions.
- `.planning/APP-PRODUCT-PLAN.md` - Phase 11 product gap: narrow tool runtime, harden Electron packaging, and update product docs.
- `.planning/ROADMAP.md` - Phase 11 goal and SEC-01, SEC-02, DESK-01, DESK-02 success criteria.
- `.planning/REQUIREMENTS.md` - Runtime and desktop hardening requirements and traceability.
- `AGENTS.md` - Repository app-first routing contract, DB write contract, dashboard/dev-server behavior, and actionability invariants.
- `docs/ARCHITECTURE.md` - Route-class policy: local APIs and DB verbs first, bounded AI for finite judgment, explicit chat handoff, retained full skill runtime only when tool loops are needed.

### Prior Phase Decisions
- `.planning/phases/06-canonical-db-app-shell/06-CONTEXT.md` - `/app` plus SQLite is canonical; generated tracker/activity files are compatibility/export only.
- `.planning/phases/07-quick-onboarding-and-auto-sourcing/07-CONTEXT.md` - First search and repeat sourcing use deterministic local run state, not hidden chat or skill runtime.
- `.planning/phases/08-deep-ingest-lane/08-CONTEXT.md` - Deep ingest uses SQLite-native proposal/review state and no hidden full-runtime dispatch.
- `.planning/phases/09-public-company-intelligence-and-scanner-cascade/09-CONTEXT.md` - Public scanner paths are local-first, with bounded AI only for ambiguous reachable text and no hidden runtime escalation.
- `.planning/phases/10-local-packet-engine/10-CONTEXT.md` - Evaluate/gate and packet generation move to local APIs with bounded AI, not default `evaluate-job`, `tailor-application`, or `answer-question` full-skill runs.
- `.planning/phases/02-bounded-ai-foundation/02-CONTEXT.md` - Bounded AI envelopes, schema validation, no-AI/manual degradation, and metadata-only telemetry.
- `.planning/phases/03-company-discovery-api/03-CONTEXT.md` - Thin local APIs, deterministic validation around AI output, confirm-first writes, and DB-owned proposal state.

### Runtime Owners
- `src/core/ai/skill-runtime.mjs` - Current one-shot runtime allowlist, `RUNTIME_TOOLS`, `runSkillStream()`, permission bypass, per-call `tools` override, BYOK/proxy child env, and usage logging.
- `src/cli/skill-run-route.mjs` - `POST /api/skill/run` SSE route, `/api/runtime/config`, body caps, abort handling, and status-code behavior.
- `src/core/ai/chat-runtime.mjs` - Conversational skill runtime, chat skill allowlist, `CHAT_TOOLS`, session lifecycle, and explicit chat handoff boundary.
- `src/cli/discovery-route.mjs` - Example of local proposal routes coexisting with explicit discovery chat handoffs.
- `src/cli/intake-route.mjs` - Example of special-case skill runtime use and completion watching for user-visible lanes.
- `src/core/onboarding/packet-page.mjs` - Legacy/static packet page context; Phase 10/11 should ensure normal product packet actions no longer default to `tailor-application`.
- `src/core/ai/answer-page.mjs` - Legacy/static answer page context; useful for guarding remaining explicit retained-runtime surfaces.

### Desktop and Release Owners
- `apps/desktop/main.mjs` - Electron shell boot, packaged `CAREERRAT_HOME`, dynamic engine import, first-run routing, external link handling, smoke-window verification, and shutdown behavior.
- `apps/desktop/desktop-routing.mjs` - Testable first-run route decision: `/app/onboarding` vs `/app`.
- `apps/desktop/desktop-smoke.mjs` - HTTP smoke verification of health, SPA root, and built app assets.
- `apps/desktop/electron-builder.yml` - macOS DMG target, hardened runtime, signing/notarization config, and staged resource inclusion.
- `apps/desktop/scripts/stage.mjs` - Packaged runtime staging, npm `files[]` reuse, `.agents`/`.claude` skill mirroring, web dist validation, and staged SDK install.
- `apps/desktop/package.json` - Desktop dev/dist scripts and Electron/electron-builder versions.
- `apps/desktop/README.md` - Current desktop run, packaging, signing, notarization, BYOK, and POC boundary documentation.
- `src/core/update/update-core.mjs` - Existing privacy-guarded update plumbing relevant to update-readiness wording and checks.

### Tests and Guards
- `tests/skill-runtime.test.mjs` - Current runtime allowlist, default tool list, per-call tool override, env routing, abort, and usage logging coverage.
- `tests/skill-run-route.test.mjs` - `/api/runtime/config` and `/api/skill/run` HTTP behavior.
- `tests/chat-runtime.test.mjs` - Conversational runtime allowlist/tool/session behavior.
- `tests/packet-page.test.mjs` and `tests/answer-page.test.mjs` - Existing expectations around legacy runtime pages that may need to change or be reclassified.
- `tests/db-app-shell-regression.test.mjs` - Static DB app-shell/product-surface guard patterns.
- `tests/quick-onboarding-auto-sourcing-regression.test.mjs` - No-hidden-runtime pattern for first/manual sourcing.
- `tests/desktop-routing.test.mjs` - First-run route selection coverage.
- `tests/desktop-smoke.test.mjs` - Desktop smoke HTTP surface coverage.
- `tests/desktop-package-resources.test.mjs` - Desktop staging and resource inclusion coverage.
- `tests/app-shell-dist.test.mjs` - Built SPA route fallback coverage.
- `tests/release-safety.test.mjs` - Package allowlist, personal-data leakage, reachable-script shipping, and release privacy checks.

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- `resolveAllowedSkills()` and `resolveSkillAllowlist()` already centralize embedded-runtime allowlist behavior and support an explicit empty-env lockout.
- `runSkillStream({ tools })` already supports per-call tool narrowing; `resume-extract` uses this path with `tools: ["Read"]`.
- `RUNTIME_TOOLS` is the current broad default (`Read`, `Glob`, `Grep`, `WebFetch`, `Write`, `Edit`, `Bash`, `Skill`) and is the main lockdown target.
- `/api/runtime/config` already exposes runtime capability metadata without secrets and can support more explicit app-safe/tool-heavy capability booleans.
- Chat handoffs already have a separate allowlist (`CAREERRAT_CHAT_SKILLS`) and route surface, which gives planners a natural place to keep explicit human-watched workflows separate from headless app defaults.
- `apps/desktop/main.mjs` already sets packaged `CAREERRAT_HOME`, avoids a global `ELECTRON_RUN_AS_NODE`, routes first-run workspaces to `/app/onboarding`, opens external links outside the app, and verifies renderer mount in smoke mode.
- `apps/desktop/scripts/stage.mjs` already stages from the npm package allowlist, mirrors skills, validates the built SPA, and installs the Agent SDK into the staged runtime.
- Release-safety and desktop tests already cover package allowlists, private-data leakage, staged resources, route selection, and smoke asset loading.

### Established Patterns
- Product routes fail closed without SQLite and do not treat generated tracker/activity files as product state.
- Route modules stay thin; durable behavior belongs in core modules, DB verbs, bounded-AI helpers, and scanner/packet owners.
- Explicit chat handoffs are allowed when the user chooses them; hidden runtime escalation from a local product action is not.
- Static guards should be slice-aware because this repo intentionally retains explicit compatibility/debug/full-runtime paths.
- Electron should keep the renderer locked down: no Node integration, context isolation on, limited navigation/window creation, and external-link handling guarded.
- Release artifacts must exclude local candidate/workspace/private data and must not depend on a live checkout or root `node_modules`.

### Integration Points
- Replace `RUNTIME_TOOLS` with an app-safe default and add explicit tool-heavy execution configuration or manifests for the few retained workflows that need broad tools.
- Update `/api/runtime/config` and product UI gating so product actions know whether they are local, bounded-AI, chat, or explicitly retained-runtime actions.
- Add static scans that classify allowed retained-runtime references and fail unclassified app-default uses of `/api/skill/run`.
- Extend desktop packaging tests to cover notarization/signing readiness, packaged data-root behavior, and fresh/existing workspace route behavior.
- Wire electron-builder notarization through local/CI credentials while keeping Apple identifiers, app-specific passwords, and keychain profile secrets out of tracked source.
- Update only the product/release docs needed for pilot truthfulness; do not make this phase a broad documentation migration.

</code_context>

<specifics>
## Specific Ideas

- The user said "whatever is right" for runtime lockdown and app-default guard boundaries. Interpret that as delegation to strict engineering defaults consistent with the prior app-first decisions.
- The user selected "all" for the desktop pilot release bar and stated they have an Apple developer account. Treat notarization as feasible for this phase.
- The user said the app is a separate product from the other version and docs will align to it, so do not over-invest in docs during this phase beyond release-critical truthfulness.
- External guidance consulted during discussion:
  - `https://www.electronjs.org/docs/latest/tutorial/security` - Electron security checklist: disable Node integration for remote content, enable context isolation/sandboxing, restrict navigation/window creation, avoid unsafe `shell.openExternal`, and use CSP.
  - `https://www.electronjs.org/docs/latest/tutorial/code-signing` - Electron distribution guidance that packaged apps should be code signed.
  - `https://developer.apple.com/documentation/security/notarizing-macos-software-before-distribution` - Apple notarization guidance for software distributed outside the Mac App Store.

</specifics>

<deferred>
## Deferred Ideas

- Broad product documentation rewrite for the separate paid app can happen outside this phase.
- Full auto-update infrastructure remains separate unless planning finds a small readiness-only check already supported by the existing update command.

</deferred>

---

*Phase: 11-Runtime Lockdown and Desktop Release*
*Context gathered: 2026-07-06T14:03:05Z*
