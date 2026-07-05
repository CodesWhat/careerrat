---
phase: ROL-API-06-canonical-db-app-shell
plan: "08"
status: pass
generated: 2026-07-05T17:29:28Z
---

# Phase 6 Verification Rollup

Final DB app shell verification for Phase 6 passed after Wave 1 implementation plans 06-04 through 06-07 completed.

## Commands

### Backend Quick Command

```bash
node --test tests/dashboard-route.test.mjs tests/data-route.test.mjs tests/packet-route.test.mjs tests/search-route.test.mjs tests/boards-route.test.mjs tests/desktop-routing.test.mjs tests/db-app-shell-regression.test.mjs
```

**Result:** PASS

**Summary:** Node test reported 59 tests, 1 suite, 59 passing, 0 failing, 0 cancelled, 0 skipped, 0 todo, duration 784.495875 ms.

**Covered files and behaviors:** dashboard route, DB data route, packet route, search route, boards route, desktop routing, and the global DB app shell static regression guard.

### Frontend Quick Command

```bash
npm --workspace apps/web run test -- src/app-shell/NavList.test.jsx
```

**Result:** PASS

**Summary:** Vitest reported 1 test file passing and 2 tests passing, duration 556 ms.

**Covered files and behaviors:** React app shell navigation renders canonical `/app` product navigation without the legacy Classic `/tracker` affordance.

### Final Combined Acceptance Command

```bash
node --test tests/dashboard-route.test.mjs tests/data-route.test.mjs tests/packet-route.test.mjs tests/search-route.test.mjs tests/boards-route.test.mjs tests/desktop-routing.test.mjs tests/db-app-shell-regression.test.mjs && npm --workspace apps/web run test -- src/app-shell/NavList.test.jsx && test -f .planning/phases/ROL-API-06-canonical-db-app-shell/06-VERIFICATION-ROLLUP.md
```

**Result:** PASS

**Summary:** Backend quick command reported 59 tests passing and 0 failures; frontend quick command reported 1 file passing and 2 tests passing; `test -f` confirmed this rollup file exists.

## Static Guard Sequencing

The final global static guard belongs in Plan 06-08 because `tests/db-app-shell-regression.test.mjs` scans product files owned by multiple Wave 1 siblings. Running it before 06-04 through 06-07 completed would have mixed intentional in-progress failures with real regressions. This rollup runs the guard only after:

- 06-04 retired normal legacy tracker navigation and classified tracker-dev compatibility routes as debug/export-only.
- 06-05 migrated packet product APIs to DB-derived application rows.
- 06-06 migrated board/source setup writes to SQLite source config.
- 06-07 migrated scanner context, seen sets, and search product routes to DB-derived state.

## Requirement Coverage

| Requirement | Coverage note | Evidence |
| --- | --- | --- |
| APP-01 | `/app` is the canonical product surface and normal nav excludes the legacy Classic `/tracker` affordance. | Frontend quick command passed `NavList.test.jsx`; backend static guard included route-copy and product-boundary checks. |
| APP-02 | Packet, board/source setup, search results, scanner context, dashboard, tracker/activity snapshots, and DB data routes pass together as DB-derived app APIs. | Backend quick command passed dashboard, data, packet, boards, search, desktop routing, and DB app shell regression tests. |
| APP-03 | Product routes do not depend on generated `workspace/tracker.json` or `workspace/activity.jsonl` exports. | Backend quick command passed missing-DB fail-closed tests and the product-file static guard. |
| APP-04 | Static guards prevent product dependencies on generated tracker/activity files while preserving narrow debug/export compatibility routes. | Backend quick command passed `tests/db-app-shell-regression.test.mjs`, including the complete product boundary and tracker-dev debug/export classification checks. |

## Decision Coverage

| Decision | Coverage note | Evidence |
| --- | --- | --- |
| D-01 | Remove legacy product affordances from the app path. | `NavList.test.jsx` passed with no normal Classic `/tracker` nav item. |
| D-02 | Keep legacy/generated surfaces as debug/export utilities only. | `db-app-shell-regression.test.mjs` passed tracker-dev debug/export route classification checks. |
| D-03 | Treat the React app as the app structure, not a compatibility project. | Frontend nav and backend route-copy/static checks passed in the final rollup. |
| D-04 | Product routes are DB-derived and fail closed without DB. | Backend quick command passed packet, search, boards, dashboard, and data missing-DB/setup tests. |
| D-05 | Generated tracker/activity exports are not source of truth. | Backend static guard and route tests passed generated-file independence checks. |
| D-06 | Dashboard, packet, tracker/activity, scanner context, and source setup converge on DB. | Backend quick command passed the combined route suite after all Wave 1 migrations. |
| D-07 | Move source setup and scanner seams DB-first now. | `boards-route.test.mjs` and `search-route.test.mjs` passed inside the backend quick command. |
| D-08 | Use one app-local DB/API layer for later auto-sourcing. | Source setup, scanner results, and DB data APIs passed together in the backend quick command. |
| D-09 | Maintain aggressive static regression guards. | `tests/db-app-shell-regression.test.mjs` passed inside the backend quick command. |
| D-10 | Keep debug/export allowlists narrow. | tracker-dev compatibility route classification checks passed inside the static guard. |

## Conclusion

Phase 6 APP-01 through APP-04 are covered by passing backend, frontend, and global static-guard evidence. The rollup modified only planning evidence files.
