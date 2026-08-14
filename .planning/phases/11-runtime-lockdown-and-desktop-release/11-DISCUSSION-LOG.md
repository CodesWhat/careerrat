# Phase 11: Runtime Lockdown and Desktop Release - Discussion Log

> **Audit trail only.** Do not use as input to planning, research, or execution agents.
> Decisions are captured in CONTEXT.md - this log preserves the alternatives considered.

**Date:** 2026-07-06T14:03:05Z
**Phase:** 11-Runtime Lockdown and Desktop Release
**Areas discussed:** Runtime tool lockdown, App-default ban boundary, Desktop pilot release bar, Product docs posture

---

## Runtime Tool Lockdown

| Option | Description | Selected |
|--------|-------------|----------|
| Read-only/tool-light default | Remove broad `Write`, `Edit`, and `Bash` from the shared default and require explicit scoped overrides. | yes |
| Keep broad runtime | Preserve current broad runtime and rely on warnings/config. | |
| Split app-safe and tool-heavy execution | Separate normal app-safe execution from explicit tool-heavy retained workflows. | yes |

**User's choice:** "whatever is right"  
**Notes:** Interpreted as delegation to strict engineering default: app-safe/tool-light by default, explicit scoped tool-heavy execution only.

---

## App-Default Ban Boundary

| Option | Description | Selected |
|--------|-------------|----------|
| React `/app` only | Guard only normal React product code. | |
| All product UI and app route surfaces | Guard React app, product routes, onboarding/search/deep-ingest/packet surfaces, and Electron product wiring. | yes |
| Repo-wide string ban | Ban all `/api/skill/run` references. | |

**User's choice:** "whatever is right"  
**Notes:** Interpreted as slice-aware strict default. Product/default surfaces are guarded; explicit chat, debug/export, CLI, and retained-runtime routes remain allowed when classified.

---

## Desktop Pilot Release Bar

| Option | Description | Selected |
|--------|-------------|----------|
| Signed DMG only | Build and sign a packaged app, but leave other pilot checks as later work. | |
| First-run and smoke verification | Verify app boot/routing/recovery without treating notarization as required. | |
| Full pilot bar | DB init, routing, recovery, smoke, packaging, signing, notarization, and update readiness. | yes |

**User's choice:** "all, i have a dev account"  
**Notes:** Treat notarization as a real pilot requirement. Apple credentials must stay outside source control/local docs should instruct setup without embedding secrets.

---

## Product Docs Posture

| Option | Description | Selected |
|--------|-------------|----------|
| Rewrite docs now | Broadly align docs around the app product in this phase. | |
| Minimal release-critical docs only | Keep desktop/app-first release docs truthful without making docs the main work. | yes |
| Leave docs entirely alone | Do not touch docs even if pilot instructions are stale. | |

**User's choice:** "this is a seperate product fro mthe optehr version so the docs wil lalign to it donmt worry about docs right now"  
**Notes:** Interpreted as: do not spend phase scope on a broad docs migration. Keep DESK-02 limited to release-critical truthfulness for the separate app product.

---

## the agent's Discretion

- Exact runtime tool-manifest/config shape.
- Exact static-scan implementation and classification markers.
- Exact notarization config mechanics.
- Exact test file layout and verification command grouping.
- Exact release-critical doc touch points.

## Deferred Ideas

- Broad product documentation rewrite for the separate paid app.
- Full auto-update infrastructure, unless planning finds a small readiness-only check already supported by existing update plumbing.
