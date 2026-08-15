---
phase: 11-runtime-lockdown-and-desktop-release
plan: "07"
created: 2026-07-06
status: complete
requirements: [SEC-01, SEC-02, DESK-01, DESK-02]
---

# Phase 11 Verification Rollup

Final Phase 11 verification closed the runtime lockdown and desktop pilot release gates. The focused Phase 11 suite is green, the desktop app bundle and DMG are signed/notarized/stapled, Gatekeeper accepts both artifacts, and packaged smoke checks pass against isolated user data roots.

## Automated Verification

| Command | Result | Evidence |
|---|---:|---|
| `node --test tests/app-default-runtime-guard.test.mjs tests/skill-runtime.test.mjs tests/skill-run-route.test.mjs tests/chat-runtime.test.mjs tests/desktop-runtime.test.mjs tests/desktop-routing.test.mjs tests/desktop-smoke.test.mjs tests/desktop-package-resources.test.mjs tests/ai-env.test.mjs tests/db-migrations.test.mjs tests/desktop-docs-release.test.mjs tests/release-safety.test.mjs` | PASS | 133 tests, 131 pass, 2 skipped live Agent SDK integration tests, 0 fail. |
| `npm run lint:placeholders` | PASS | `No unresolved placeholders found.` |
| `npm run build` | PASS | Turbo build passed for `@careerrat/web` and `website` from cache; no build failures. |
| `node --test tests/desktop-package-resources.test.mjs tests/release-safety.test.mjs` | PASS | 12 tests, 12 pass. Includes the package-resource regression for `desktop-runtime.mjs`. |
| `npm test` | FAIL, unrelated | 1,789 tests, 1,779 pass, 4 skipped, 6 fail. Every failure is in `tests/deep-ingest-ai.test.mjs` for the existing Phase 08 missing deep-ingest proposal schema/modules/validators: `config/deep-ingest-proposal.schema.json`, `src/core/deep-ingest/proposals/evidence.mjs`, `src/core/deep-ingest/proposals/stories.mjs`, and `src/core/deep-ingest/validators/grounding.mjs`. No Phase 11 tests failed. |

## Screenshot Regression

The first packaged launch reported `ERR_MODULE_NOT_FOUND` for `app.asar/desktop-runtime.mjs` imported by `app.asar/main.mjs`. Commit `b51d71c` fixed the package file allowlist and added a package-resource regression.

Verification:

```text
main.mjs=true
desktop-runtime.mjs=true
desktop-routing.mjs=true
desktop-smoke.mjs=true
```

## Signed And Notarized Artifact

Build command:

```bash
APPLE_KEYCHAIN_PROFILE=careerrat-notary npm run desktop:dist
```

Result:

- PASS: `npm run app:build` completed before desktop staging.
- PASS: desktop staging copied the runtime allowlist, mirrored `.agents/skills` to `.claude/skills`, and installed `@anthropic-ai/claude-agent-sdk` into the staged runtime.
- PASS: electron-builder signed `apps/desktop/dist/mac-arm64/CareerRat.app` with the local Developer ID Application certificate.
- PASS: electron-builder notarized the app zip. Latest relevant notary history entry: `11b78ae9-385e-4ef0-b37f-27b892f47f41`, `CareerRat.zip`, `Accepted`, `2026-07-06T17:34:37.426Z`.
- PASS: output artifact exists at `apps/desktop/dist/CareerRat-0.1.0-arm64.dmg`.

App verification:

| Command | Result |
|---|---:|
| `codesign --verify --deep --strict --verbose=2 apps/desktop/dist/mac-arm64/CareerRat.app` | PASS: valid on disk; satisfies its Designated Requirement. |
| `codesign -dv --verbose=2 apps/desktop/dist/mac-arm64/CareerRat.app` | PASS: Developer ID Application authority and TeamIdentifier present, hardened runtime flag present, `Notarization Ticket=stapled`. |
| `xcrun stapler validate apps/desktop/dist/mac-arm64/CareerRat.app` | PASS: validate action worked. |
| `spctl --assess --type execute --verbose=4 apps/desktop/dist/mac-arm64/CareerRat.app` | PASS: accepted, `source=Notarized Developer ID`. |

DMG verification:

Electron-builder notarized and stapled the app bundle, but the generated DMG did not initially have its own stapled ticket and Gatekeeper rejected it with `source=no usable signature`. The DMG was then signed and notarized explicitly:

```bash
codesign --force --sign "$CSC_NAME" --timestamp apps/desktop/dist/CareerRat-0.1.0-arm64.dmg
xcrun notarytool submit apps/desktop/dist/CareerRat-0.1.0-arm64.dmg --keychain-profile careerrat-notary --wait --output-format json
xcrun stapler staple apps/desktop/dist/CareerRat-0.1.0-arm64.dmg
```

Final DMG evidence:

| Command | Result |
|---|---:|
| `codesign --verify --verbose=2 apps/desktop/dist/CareerRat-0.1.0-arm64.dmg` | PASS: valid on disk; satisfies its Designated Requirement. |
| `xcrun notarytool submit ... --wait --output-format json` | PASS: `Accepted`, id `bfc42d9c-6536-4ead-b8bc-314f13ac73c3`, `CareerRat-0.1.0-arm64.dmg`, `2026-07-06T17:37:51.785Z`. |
| `xcrun stapler staple apps/desktop/dist/CareerRat-0.1.0-arm64.dmg` | PASS: staple and validate action worked. |
| `xcrun stapler validate apps/desktop/dist/CareerRat-0.1.0-arm64.dmg` | PASS: validate action worked. |
| `spctl --assess --type open --context context:primary-signature --verbose=4 apps/desktop/dist/CareerRat-0.1.0-arm64.dmg` | PASS: accepted, `source=Notarized Developer ID`. |
| `codesign -dv --verbose=2 apps/desktop/dist/CareerRat-0.1.0-arm64.dmg` | PASS: Developer ID Application authority and TeamIdentifier present, `Notarization Ticket=stapled`. |

Generated release artifacts remain ignored and untracked: `apps/desktop/dist/` and `apps/desktop/staging/`.

## Packaged Smoke

Fresh workspace smoke:

```bash
apps/desktop/dist/mac-arm64/CareerRat.app/Contents/MacOS/CareerRat --user-data-dir=<FRESH_USER_DATA> --smoke
```

Result:

- PASS: packaged app booted the server from signed resources.
- PASS: smoke path loaded the selected SPA route, verified `/api/health`, verified referenced built assets, created the Electron window, and waited for React to mount under `#root`.
- PASS: output included `SMOKE OK`.
- Fresh-route behavior is pinned by `tests/desktop-routing.test.mjs`: no candidate setup selects `/app/onboarding`.

Existing workspace smoke:

```bash
apps/desktop/dist/mac-arm64/CareerRat.app/Contents/MacOS/CareerRat --user-data-dir=<EXISTING_USER_DATA> --smoke
```

Setup:

- `<EXISTING_USER_DATA>/data/candidate/profile.yml` contained a minimal candidate identity for route selection.

Result:

- PASS: packaged app booted from signed resources with the seeded candidate data root.
- PASS: smoke path loaded the selected SPA route, verified `/api/health`, verified referenced built assets, created the Electron window, and waited for React to mount under `#root`.
- PASS: output included `SMOKE OK`.
- Existing-route behavior is pinned by `tests/desktop-routing.test.mjs`: candidate setup selects `/app`.

## Packaged CAREERRAT_HOME Data Evidence

The packaged runtime source under `CareerRat.app/Contents/Resources/careerrat` was imported with `CAREERRAT_HOME=<USER_DATA>/data`.

```text
db.path=<USER_DATA>/data/db/careerrat.db
db.user_version=9
db.expected_latest=9
db.migration_count=9
byok.path=<USER_DATA>/data/internal/ai.env
byok.mode=600
byok.loaded=ANTHROPIC_API_KEY
resources.db.exists=false
resources.ai_env.exists=false
```

This proves SQLite migration state and BYOK storage land under the packaged data root and not under signed resources. The BYOK key value was not printed.

## Requirement Coverage

| Requirement | Evidence |
|---|---|
| SEC-01 | PASS: `tests/app-default-runtime-guard.test.mjs` in the focused Phase 11 suite. App/default slices cannot add hidden retained-runtime calls where local owners exist. |
| SEC-02 | PASS: `tests/skill-runtime.test.mjs`, `tests/skill-run-route.test.mjs`, and `tests/chat-runtime.test.mjs`. One-shot runtime defaults to app-safe tools; tool-heavy and chat runtime paths are explicit. |
| DESK-01 | PASS: `tests/desktop-runtime.test.mjs`, `tests/desktop-routing.test.mjs`, `tests/desktop-smoke.test.mjs`, `tests/desktop-package-resources.test.mjs`, `tests/ai-env.test.mjs`, `tests/db-migrations.test.mjs`, signed/notarized/stapled app and DMG verification, Gatekeeper checks, and packaged smoke. |
| DESK-02 | PASS: `tests/desktop-docs-release.test.mjs`, `tests/release-safety.test.mjs`, and `npm run lint:placeholders`. Pilot-facing docs are app-first, runtime-lockdown accurate, credential-neutral, and update-readiness truthful. |

## Known Blockers Outside Phase 11

Repo-wide `npm test` is still blocked by the pre-existing Phase 08 deep-ingest AI gap in `tests/deep-ingest-ai.test.mjs`.

Missing files named by the failing tests:

- `config/deep-ingest-proposal.schema.json`
- `src/core/deep-ingest/proposals/evidence.mjs`
- `src/core/deep-ingest/proposals/stories.mjs`
- `src/core/deep-ingest/validators/grounding.mjs`

This blocker is unrelated to Phase 11. The focused Phase 11 suite, root build, package-resource guard, signed/notarized desktop artifact checks, and packaged smoke checks all passed.
