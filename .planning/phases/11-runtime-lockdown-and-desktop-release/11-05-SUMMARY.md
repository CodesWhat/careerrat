---
phase: 11-runtime-lockdown-and-desktop-release
plan: "05"
subsystem: desktop-release
tags: [desktop, electron-builder, notarization, signing, release-safety, tdd]

requires:
  - phase: 11-runtime-lockdown-and-desktop-release
    provides: [desktop packaged runtime paths, BYOK data-root hardening]
provides:
  - Signed and notarized macOS DMG electron-builder configuration
  - Hardened runtime app and inherited entitlements
  - Static package-resource coverage for signing, notarization, credential exclusion, and staged runtime resources
  - Verified local Apple notarytool keychain-profile readiness
affects: [desktop-release, packaged-runtime, release-verification, DESK-01]

tech-stack:
  added: []
  patterns:
    - Credential-neutral electron-builder notarization config
    - Minimal hardened runtime entitlement plists
    - Non-destructive notarytool credential readiness check

key-files:
  created:
    - apps/desktop/build/entitlements.mac.plist
    - apps/desktop/build/entitlements.mac.inherit.plist
  modified:
    - apps/desktop/electron-builder.yml
    - tests/desktop-package-resources.test.mjs

key-decisions:
  - "Pilot macOS packaging now requires forceCodeSigning, hardened runtime entitlements, and electron-builder notarization."
  - "Apple credentials remain outside tracked source; the repo only records credential-neutral keychain/CI environment expectations."
  - "The local notarization readiness gate uses the rolester-notary keychain profile and does not generate or commit release artifacts."

patterns-established:
  - "Desktop package tests pin release config without contacting Apple services."
  - "Notary readiness is verified with notarytool history against a keychain profile, keeping account/password values out of source and logs."

requirements-completed: [DESK-01]

coverage:
  - id: D1
    description: "electron-builder macOS pilot config requires signed, hardened-runtime, notarized DMG packaging without tracked Apple credentials."
    requirement: DESK-01
    verification:
      - kind: unit
        ref: "node --test tests/desktop-package-resources.test.mjs tests/release-safety.test.mjs"
        status: pass
    human_judgment: false
  - id: D2
    description: "Hardened runtime entitlement files exist and avoid credential, device, and personal-information entitlements."
    requirement: DESK-01
    verification:
      - kind: unit
        ref: "tests/desktop-package-resources.test.mjs#electron-builder macOS pilot config requires signing, entitlements, and notarization"
        status: pass
    human_judgment: false
  - id: D3
    description: "The local Apple notarization keychain profile is available for final release verification."
    requirement: DESK-01
    verification:
      - kind: manual_procedural
        ref: "xcrun notarytool history --keychain-profile rolester-notary"
        status: pass
    human_judgment: false

duration: 2 min continuation
completed: 2026-07-06
status: complete
---

# Phase 11 Plan 05: Signed and Notarized Desktop Pilot Packaging Summary

**Rolester desktop pilot packaging now requires signed, hardened-runtime, notarized macOS DMG builds with Apple credentials kept outside source.**

## Performance

- **Duration:** 2 min continuation after the credential checkpoint was resolved
- **Started:** 2026-07-06T16:57:50Z
- **Completed:** 2026-07-06T16:59:32Z
- **Tasks:** 3
- **Files modified:** 4

## Accomplishments

- Added static release tests that pin signing, hardened runtime entitlements, notarization, credential exclusion, and staged runtime resource expectations.
- Enabled electron-builder macOS pilot packaging with `forceCodeSigning`, `hardenedRuntime`, app/inherited entitlements, and `mac.notarize: true`.
- Confirmed the `rolester-notary` keychain profile with a non-destructive notarytool history check; no DMG, app bundle, Apple credential, or local release artifact was committed.

## Task Commits

Each implementation task was committed atomically:

1. **Task 1: Pin signed/notarized package configuration in tests** - `c354a37` (test)
2. **Task 2: Configure macOS pilot signing and notarization** - `a248416` (feat)
3. **Task 3: Verify Apple notarization credential readiness** - no code commit; checkpoint verification completed with `rolester-notary`

**Plan metadata:** committed after this SUMMARY is written.

## Files Created/Modified

- `apps/desktop/build/entitlements.mac.plist` - Minimal hardened runtime entitlement file for the app bundle.
- `apps/desktop/build/entitlements.mac.inherit.plist` - Minimal inherited hardened runtime entitlement file for child processes.
- `apps/desktop/electron-builder.yml` - Enables force code signing, hardened runtime entitlements, and notarization without tracked Apple credentials.
- `tests/desktop-package-resources.test.mjs` - Pins release-package config, credential exclusion, staged runtime resources, and private-root exclusions.

`apps/desktop/package.json` was inspected and left unchanged because its existing `dist` script already builds the web app before staging and then runs electron-builder.

## Verification

- PASS: prior commits `c354a37` and `a248416` exist in the current branch ancestry, and the working tree was clean before Task 3.
- PASS: `node --test tests/desktop-package-resources.test.mjs tests/release-safety.test.mjs`
- PASS: `xcrun notarytool history --keychain-profile rolester-notary`
- PASS: Apple credential scan found no real Apple ID, app-specific password, or credential value in the plan-touched source files; only placeholder setup text and test regex literals appear in docs/tests.
- PASS: generated `apps/desktop/dist/` and `apps/desktop/staging/` remain ignored and untracked.

## Decisions Made

- Use electron-builder's built-in notarization path for pilot packaging instead of custom notary upload/staple scripts.
- Leave Apple account, password, team, and keychain-profile values out of tracked config; local keychain or CI environment owns credentials.
- Treat unsigned/local desktop builds as development-only. The pilot success path remains a signed and notarized macOS DMG, with final artifact evidence deferred to Plan 11-07.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] Used the installed notarytool-compatible history command**
- **Found during:** Task 3 (Verify Apple notarization credential readiness)
- **Issue:** The plan's exact command included `--limit 1`, but the installed `xcrun notarytool` 1.1.2 rejects that option as unknown.
- **Fix:** Re-ran the same non-destructive credential readiness check without the unsupported limit flag: `xcrun notarytool history --keychain-profile rolester-notary`.
- **Files modified:** None.
- **Verification:** The compatible notarytool command succeeded and returned submission history for the keychain profile.
- **Committed in:** Plan metadata commit.

---

**Total deviations:** 1 auto-fixed (Rule 3).
**Impact on plan:** No source behavior changed. The credential readiness gate still used notarytool and confirmed the same `rolester-notary` keychain profile without exposing secrets.

## Issues Encountered

- The desktop README still contains pre-11-05 wording that describes notarization as deferred. That is intentionally left to Plan 11-06, which explicitly covers DESK-02 docs truthfulness and names this exact stale wording as its RED condition.
- `state.advance-plan` still cannot parse this workspace's older STATE.md current-plan shape, matching the Plan 11-04 close-out behavior. The registered `state.update-progress`, `state.record-metric`, `state.add-decision`, `state.record-session`, `roadmap.update-plan-progress`, and `requirements.mark-complete` handlers were run; progress now reflects 50/65 completed plans and ROADMAP shows Phase 11 at 5/7. `state.update-progress` reported 77% but left the nested YAML `progress.percent` line stale, so that single line was corrected to match the handler's computed value.

## Authentication Gates

- The Apple notarization credential checkpoint from the prior executor was resolved by the user before this continuation. The follow-up `notarytool history` check succeeded with `rolester-notary`.

## User Setup Required

None remaining for this plan. The local `rolester-notary` keychain profile is confirmed. Plan 11-07 still owns final signed/notarized artifact evidence, stapling or Gatekeeper assessment, code-sign verification, and packaged smoke evidence.

## Known Stubs

None. Stub-pattern scanning of the created/modified plan files found no TODO, FIXME, placeholder UI text, empty UI data source, or unfinished runtime value.

## Threat Flags

None. The release signing/notarization and Apple credential boundaries are covered by the plan threat model (`T-11-12`, `T-11-13`, and `T-11-14`), and no new network endpoint, auth path, schema, or file-access trust boundary was introduced beyond that scope.

## TDD Gate Compliance

- RED gate: `c354a37` added failing static package-resource tests against the prior disabled notarization config.
- GREEN gate: `a248416` enabled notarized pilot packaging and added entitlements so the focused suite passed.
- Refactor gate was not needed.

## Next Phase Readiness

DESK-01 package configuration and local notarization credential readiness are complete. Phase 11 can continue to Plan 11-06 for release-critical docs truthfulness and Plan 11-07 for the final focused verification and signed/notarized artifact evidence.

## Self-Check: PASSED

- Found `.planning/phases/11-runtime-lockdown-and-desktop-release/11-05-SUMMARY.md`.
- Found `apps/desktop/build/entitlements.mac.plist`.
- Found `apps/desktop/build/entitlements.mac.inherit.plist`.
- Found task commits `c354a37` and `a248416`.
- Re-ran `node --test tests/desktop-package-resources.test.mjs tests/release-safety.test.mjs` successfully after Task 3 verification.

---
*Phase: 11-runtime-lockdown-and-desktop-release*
*Completed: 2026-07-06*
