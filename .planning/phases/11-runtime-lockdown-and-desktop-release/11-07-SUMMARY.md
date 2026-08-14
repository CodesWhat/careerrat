---
phase: 11-runtime-lockdown-and-desktop-release
plan: "07"
subsystem: desktop-release-verification
tags: [desktop, electron-builder, notarization, runtime-lockdown, release-verification, packaged-smoke]

requires:
  - phase: 11-runtime-lockdown-and-desktop-release
    provides: [SEC-01 guard, SEC-02 app-safe runtime profiles, DESK-01 desktop packaging, DESK-02 pilot docs]
provides:
  - Final Phase 11 verification rollup
  - Signed, notarized, stapled macOS app and DMG evidence
  - Packaged smoke evidence for fresh and existing data roots
  - Packaged CAREERRAT_HOME SQLite and BYOK storage evidence
  - Regression fix for packaged `desktop-runtime.mjs`
affects: [runtime-lockdown, desktop-release, pilot-release, phase-11-closeout]

tech-stack:
  added: []
  patterns:
    - Focused phase rollup with exact command evidence
    - Credential-neutral Apple notarization through local keychain profile
    - Packaged smoke using isolated `--user-data-dir` roots

key-files:
  created:
    - .planning/phases/11-runtime-lockdown-and-desktop-release/11-VERIFICATION-ROLLUP.md
    - .planning/phases/11-runtime-lockdown-and-desktop-release/11-07-SUMMARY.md
  modified:
    - apps/desktop/electron-builder.yml
    - tests/desktop-package-resources.test.mjs

key-decisions:
  - "The generated DMG is explicitly code-signed, notarized, and stapled after electron-builder notarizes the app bundle, because the raw builder DMG did not initially carry its own stapled ticket."
  - "Packaged smoke uses isolated `--user-data-dir` roots so verification does not mutate the user's normal Electron Application Support data."
  - "The unrelated Phase 08 `npm test` failures are recorded separately and do not mask Phase 11 focused verification."

patterns-established:
  - "Final release rollups record both app-bundle and container-artifact notarization evidence."
  - "Desktop packaging regressions that manifest as app.asar import failures are pinned by static app.asar file-allowlist tests before manual smoke."

requirements-completed: [SEC-01, SEC-02, DESK-01, DESK-02]

coverage:
  - id: D1
    description: "SEC-01 and SEC-02 runtime lockdown checks pass for app-default guards, app-safe one-shot tools, explicit tool-heavy route profiles, and chat runtime classification."
    requirement: SEC-01
    verification:
      - kind: unit
        ref: "node --test tests/app-default-runtime-guard.test.mjs tests/skill-runtime.test.mjs tests/skill-run-route.test.mjs tests/chat-runtime.test.mjs"
        status: pass
    human_judgment: false
  - id: D2
    description: "DESK-01 desktop runtime, routing, smoke, package-resource, packaged DB migration, and BYOK path checks pass."
    requirement: DESK-01
    verification:
      - kind: unit
        ref: "node --test tests/desktop-runtime.test.mjs tests/desktop-routing.test.mjs tests/desktop-smoke.test.mjs tests/desktop-package-resources.test.mjs tests/ai-env.test.mjs tests/db-migrations.test.mjs"
        status: pass
    human_judgment: false
  - id: D3
    description: "The packaged app and DMG are signed, notarized, stapled, accepted by Gatekeeper, and smoke-tested from isolated data roots."
    requirement: DESK-01
    verification:
      - kind: manual_procedural
        ref: ".planning/phases/11-runtime-lockdown-and-desktop-release/11-VERIFICATION-ROLLUP.md#signed-and-notarized-artifact"
        status: pass
      - kind: manual_procedural
        ref: ".planning/phases/11-runtime-lockdown-and-desktop-release/11-VERIFICATION-ROLLUP.md#packaged-smoke"
        status: pass
    human_judgment: false
  - id: D4
    description: "DESK-02 pilot-facing docs remain app-first, runtime-lockdown accurate, credential-neutral, and free of unresolved placeholders."
    requirement: DESK-02
    verification:
      - kind: unit
        ref: "node --test tests/desktop-docs-release.test.mjs tests/release-safety.test.mjs && npm run lint:placeholders"
        status: pass
    human_judgment: false

duration: 15 min
completed: 2026-07-06
status: complete
---

# Phase 11 Plan 07: Final Verification Rollup Summary

**Phase 11 now has signed/notarized desktop pilot evidence, focused runtime-lockdown verification, packaged smoke coverage, and a fix for the missing `desktop-runtime.mjs` app.asar regression.**

## Performance

- **Duration:** 15 min
- **Started:** 2026-07-06T17:28:08Z
- **Completed:** 2026-07-06T17:43:06Z
- **Tasks:** 2
- **Files modified:** 4

## Accomplishments

- Created `11-VERIFICATION-ROLLUP.md` with exact automated, package, notarization, Gatekeeper, smoke, DB, BYOK, and known-blocker evidence.
- Fixed the packaged app crash shown in the screenshot by including `desktop-runtime.mjs` in the electron-builder app file allowlist and pinning that with a package-resource test.
- Built the desktop artifact, signed and notarized the app bundle, explicitly signed/notarized/stapled the DMG, and verified both through Gatekeeper.
- Ran packaged smoke checks for fresh and existing isolated user data roots.
- Proved packaged SQLite and BYOK writes land under `<USER_DATA>/data`, not under signed resources.

## Task Commits

1. **Task 1/2 support fix: Include desktop runtime helper in packaged app.asar** - `b51d71c` (fix)

**Plan metadata:** committed with this SUMMARY and the verification rollup.

## Files Created/Modified

- `.planning/phases/11-runtime-lockdown-and-desktop-release/11-VERIFICATION-ROLLUP.md` - Final Phase 11 command, manual-check, and requirement coverage evidence.
- `.planning/phases/11-runtime-lockdown-and-desktop-release/11-07-SUMMARY.md` - Plan close-out summary.
- `apps/desktop/electron-builder.yml` - Adds `desktop-runtime.mjs` to the packaged app file allowlist.
- `tests/desktop-package-resources.test.mjs` - Fails if a main-process module imported by `main.mjs` is missing from electron-builder's `files` list.

## Verification

- PASS: Focused Phase 11 suite: 133 tests, 131 pass, 2 skipped live Agent SDK integration tests, 0 fail.
- PASS: `npm run lint:placeholders`
- PASS: `npm run build`
- PASS: `node --test tests/desktop-package-resources.test.mjs tests/release-safety.test.mjs`
- PASS: `APPLE_KEYCHAIN_PROFILE=careerrat-notary npm run desktop:dist`
- PASS: App bundle `codesign --verify --deep --strict`, stapler validation, and Gatekeeper execution assessment.
- PASS: DMG explicit code-sign, notary submission id `bfc42d9c-6536-4ead-b8bc-314f13ac73c3`, stapling, stapler validation, and Gatekeeper open assessment.
- PASS: Packaged `--smoke` with isolated fresh and existing user data roots.
- PASS: Packaged `CAREERRAT_HOME` evidence: SQLite at `<USER_DATA>/data/db/careerrat.db`, `PRAGMA user_version=9`, 9 migration rows, BYOK at `<USER_DATA>/data/internal/ai.env`, mode `0600`, no writes under signed resources.
- FAIL, unrelated: `npm test` still fails only in existing Phase 08 `tests/deep-ingest-ai.test.mjs` gaps for missing deep-ingest proposal schema/modules/validators.

## Decisions Made

- Keep Apple credentials out of tracked config and use the existing `careerrat-notary` keychain profile only at command time.
- Treat the DMG as the pilot release container and notarize/staple it explicitly after electron-builder's app-bundle notarization.
- Record generated `apps/desktop/dist/` and `apps/desktop/staging/` artifacts as ignored local evidence, not tracked project files.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Packaged app.asar omitted `desktop-runtime.mjs`**
- **Found during:** Task 2 packaged launch verification
- **Issue:** The packaged app crashed with `ERR_MODULE_NOT_FOUND` because `main.mjs` imported `./desktop-runtime.mjs` but electron-builder's `files` allowlist did not include it.
- **Fix:** Added `desktop-runtime.mjs` to `apps/desktop/electron-builder.yml` and extended `tests/desktop-package-resources.test.mjs` to assert every desktop main-process module imported by `main.mjs` is embedded.
- **Files modified:** `apps/desktop/electron-builder.yml`, `tests/desktop-package-resources.test.mjs`
- **Verification:** `node --test tests/desktop-package-resources.test.mjs tests/release-safety.test.mjs`, app.asar listing, and packaged `--smoke` all passed.
- **Committed in:** `b51d71c`

**2. [Rule 3 - Blocking] DMG needed explicit container signing/notarization**
- **Found during:** Task 2 signed/notarized pilot artifact verification
- **Issue:** electron-builder notarized and stapled the app bundle, but the generated DMG initially had no stapled ticket and Gatekeeper rejected it with `source=no usable signature`.
- **Fix:** Explicitly code-signed the DMG, submitted it to Apple notarization with `careerrat-notary`, stapled it, and reran Gatekeeper assessment.
- **Files modified:** None tracked; generated `apps/desktop/dist/CareerRat-0.1.0-arm64.dmg` only.
- **Verification:** `codesign --verify`, `xcrun notarytool submit ... --wait`, `xcrun stapler validate`, and `spctl --assess --type open --context context:primary-signature` all passed.
- **Committed in:** Not applicable; generated artifact only.

---

**Total deviations:** 2 auto-fixed (1 bug, 1 blocking release artifact issue).
**Impact on plan:** The deviations were required to satisfy the planned DESK-01 release evidence. No credentials or generated release artifacts were committed.

## Issues Encountered

- `npm test` remains blocked by the pre-existing Phase 08 deep-ingest AI gaps. The failing tests are isolated to `tests/deep-ingest-ai.test.mjs` and missing files outside Phase 11 scope. See `11-VERIFICATION-ROLLUP.md`.
- The first packaged smoke attempt without `--user-data-dir` resolved to the normal macOS Application Support path. Subsequent fresh/existing checks used isolated `--user-data-dir` roots to avoid mutating normal user data.

## Authentication Gates

- The local `careerrat-notary` keychain profile was already configured by the user before final packaging. `xcrun notarytool history --keychain-profile careerrat-notary` and final app/DMG submissions succeeded without printing secrets.

## User Setup Required

None remaining for Phase 11. The local Apple keychain profile and Developer ID certificate were available and verified.

## Known Stubs

None. Placeholder lint passed, and generated desktop artifacts remain ignored.

## Threat Flags

None new. The release artifact trust boundary is covered by signed/notarized/stapled app and DMG checks; Apple credentials were used only from Keychain and were not committed or printed.

## TDD Gate Compliance

- RED/GREEN for the screenshot regression was handled in commit `b51d71c`: the test now fails if main-process imports are missing from the packaged app `files` allowlist, and the config includes `desktop-runtime.mjs`.
- The final release checks are procedural verification, not production feature changes.

## Next Phase Readiness

Phase 11 is ready to close. The remaining repo-wide test blocker belongs to Phase 08 deep-ingest AI proposal modules and should be handled before treating `npm test` as globally green.

## Self-Check: PASSED

- Found `.planning/phases/11-runtime-lockdown-and-desktop-release/11-VERIFICATION-ROLLUP.md`.
- Found `.planning/phases/11-runtime-lockdown-and-desktop-release/11-07-SUMMARY.md`.
- Found commit `b51d71c`.
- Re-ran focused Phase 11 suite, placeholder lint, root build, package-resource tests, signing/notarization checks, Gatekeeper checks, packaged smoke, and packaged data-root evidence.

---
*Phase: 11-runtime-lockdown-and-desktop-release*
*Completed: 2026-07-06*
