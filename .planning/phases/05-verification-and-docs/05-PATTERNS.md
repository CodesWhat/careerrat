# Phase 05: verification-and-docs - Pattern Mapping

**Mapped:** 2026-07-05
**Scope:** tests, static docs drift guards, route/no-AI/cost-boundary assertions, and docs alignment.
**Inputs:** `05-RESEARCH.md`, `05-VALIDATION.md`, `.planning/REQUIREMENTS.md`, `.planning/ROADMAP.md`, `.planning/PROJECT.md`, `AGENTS.md`, `candidate/AGENTS.md`.

## Summary

Phase 05 should be implemented as a verification/docs phase. The likely changes are test files plus three documentation files: `AGENTS.md`, `docs/ARCHITECTURE.md`, and `.planning/architecture/runtime-routing-policy.md`. Production code should be left alone unless a new regression test exposes an actual defect.

The strongest local patterns are already in the discovery and bounded-AI tests:

- Route tests mount `src/cli/discovery-route.mjs` directly with temp repos, fake chat runtimes, and injected seams.
- Cost-boundary tests use forbidden callbacks, source scans, and `chatRuntime.starts.length` to prove local routes do not escalate to bounded AI, chat, or `POST /api/skill/run`.
- Structured-output tests simulate malformed JSON, schema-invalid payloads, exactly one retry, and safe manual fallback envelopes without real model calls.
- Docs drift tests parse/read docs and assert ordered sections plus required route-class phrases rather than comparing whole files.

## Likely Files and Roles

| File or Cluster | Role | Data Flow | Closest Analog | Planner Guidance |
| --- | --- | --- | --- | --- |
| `tests/company-discovery-regression.test.mjs` or new `tests/verification-cost-boundaries.test.mjs` | Cost-boundary regression lock for VER-01 | Source files and mounted routes -> static assertions/injected forbidden seams -> no AI/chat/full runtime proof | `tests/company-discovery-regression.test.mjs:289`, `tests/company-discovery-regression.test.mjs:600` | Prefer extending the existing regression file if the assertions are discovery-specific. Use a new file only if the static scan becomes a standalone phase-level guard. |
| `tests/company-discovery-seeds.test.mjs` | Helper-level seed generation and no-AI behavior for VER-02/VER-03 | `generateCompanySeeds()` -> `runBoundedAI()` result -> `ai`, `manual`, schema, privacy assertions | `tests/company-discovery-seeds.test.mjs:268`, `tests/company-discovery-seeds.test.mjs:300` | Add helper-level cases here when the seam under test is `generateCompanySeeds()` or `companySeedSchema`. |
| `tests/company-proposals-route.test.mjs` | Route-level company proposal create behavior for VER-02/VER-03/VER-04 | HTTP-like `POST /api/discovery/company-proposals` -> route body/meta -> proposal batch DB, no confirmed writes | `tests/company-proposals-route.test.mjs:247`, `tests/company-proposals-route.test.mjs:365` | Add route-level no-AI/manual metadata and schema-invalid seed route coverage here. |
| `tests/company-proposal-decisions.test.mjs` | Confirm-first decision/write safety for VER-04 | Pending proposal batch -> `POST /api/discovery/company-proposal-decisions` -> source config/sourced rows only on supported approval | `tests/company-proposal-decisions.test.mjs:212`, `tests/company-proposal-decisions.test.mjs:276`, `tests/company-proposal-decisions.test.mjs:322` | Keep write-safety assertions here. Use forbidden write seams for reject/suppress/escalate/refresh. |
| `tests/db-source-config.test.mjs` | DB/source-config verb behavior | Direct DB verb call -> source config state/export behavior | `tests/db-source-config.test.mjs` | Only touch if Phase 05 needs a narrower source-config invariant. Do not duplicate decision-route coverage. |
| `tests/decomposition-map.test.mjs` or new docs drift test | Static docs alignment for VER-05 | Read docs -> section/phrase assertions -> route-class drift detection | `tests/decomposition-map.test.mjs:344` | Extend this file if the guard is architecture-policy focused. Use a new docs test if tying together `AGENTS.md`, `docs/ARCHITECTURE.md`, and route behavior would make this file too broad. |
| `apps/web/src/onboarding/OnboardingPage.test.jsx` | Runtime capability derivation for no-AI route behavior | Runtime config -> `deriveRuntimeCapabilities()` -> UI capability booleans | `apps/web/src/onboarding/OnboardingPage.test.jsx:58` | Add only capability derivation assertions here. Route-wrapper assertions belong in `CompaniesStep.test.jsx`. |
| `apps/web/src/onboarding/steps/CompaniesStep.test.jsx` | UI route wrapper and no-hidden-chat assertions | UI helper/API wrapper -> fetch calls/local errors -> no `/api/skill/run`, no chat render | `apps/web/src/onboarding/steps/CompaniesStep.test.jsx:127`, `apps/web/src/onboarding/steps/CompaniesStep.test.jsx:382` | Use this for app-level no-AI/local-manual controls and explicit secondary chat handoff ordering. |
| `AGENTS.md` | Agent-facing workflow contract | Human/agent instructions -> route policy wording -> docs drift guard | Current company-discovery text at `AGENTS.md:524` | Add concise wording that app company discovery defaults to local proposal APIs while agent-led `discover-companies` remains explicit and confirm-first. |
| `docs/ARCHITECTURE.md` | Public architecture summary | Durable route layers -> docs drift guard | `docs/ARCHITECTURE.md:85` | Keep wording concise; mirror only stable policy language. |
| `.planning/architecture/runtime-routing-policy.md` | Detailed routing authority | Route classes and drift checks -> docs/test expectations | `.planning/architecture/runtime-routing-policy.md:1`, `.planning/architecture/runtime-routing-policy.md:226` | Update this first if final wording changes, then mirror public/agent wording. |

## Data Flow Boundaries

### Default Company Proposal Path

```text
manual seeds or bounded AI seed request
  -> generateCompanySeeds()
  -> deterministic board resolver
  -> supported ATS scanner
  -> proposal gate and JD capture
  -> pending company proposal batch
  -> user decision
  -> confirmed supported approval writes source config + sourced rows
```

Pattern source: `src/core/discovery/company-proposals.mjs:111` resolves a seed, scans the resolved board, captures reachable jobs, and builds a proposal. `src/core/discovery/company-proposal-decisions.mjs:349` writes confirmed supported approvals through `companyAtsUpsertImpl()` and `sourcedUpsertBatchImpl()`.

### Boundaries to Lock

- Resolver, scanner, gate, proposal reads, refresh, and confirmed writes must not call `callAI()`, `runBoundedAI()`, `runSkillStream`, `chatRuntime.startSession`, or `POST /api/skill/run`.
- Seed generation is the only company-discovery path allowed to use bounded AI, and only when manual seeds are absent.
- No-AI seed generation must return a 501-style manual envelope with `manual.available: true` and `ai.used: false`.
- Local proposal route failures must surface locally; they must not silently start chat or full skill runtime.
- Confirmed source writes must go through source-config/DB owners, not generated `workspace/tracker.json`, `workspace/activity.jsonl`, or legacy compatibility files.

## Reusable Test Harness Patterns

### Mounted Route Harness With Fake Chat Runtime

Use the existing direct route mounting style. It avoids a real HTTP server and makes every injected seam observable.

```js
// Source analog: tests/company-discovery-regression.test.mjs:96
function fakeChatRuntime() {
  const starts = [];
  return {
    starts,
    startSession(args) {
      starts.push(args);
      throw new Error("company discovery API regressions must not start chat runtime");
    },
    findBySkill() {
      return null;
    },
  };
}

// Source analog: tests/company-discovery-regression.test.mjs:112
mountDiscoveryRoutes({
  addRoute,
  repoRoot,
  env: {},
  chatRuntime,
  resolveCompanyBoard: opts.resolveCompanyBoard,
  scanCompaniesImpl: opts.scanCompaniesImpl,
  seedCall: opts.seedCall,
  companyAtsUpsertImpl: opts.companyAtsUpsertImpl,
  sourcedUpsertBatchImpl: opts.sourcedUpsertBatchImpl,
});
```

Use this when testing `/api/discovery/company-proposals` and `/api/discovery/company-proposal-decisions`. Assert `server.chatRuntime.starts.length === 0` for routes that must not start chat.

### Forbidden Seam Pattern

Use forbidden callbacks when a path must not write or escalate.

```js
// Source analog: tests/company-proposals-route.test.mjs:289
runSkillStream: forbidden("runSkillStream", calls),
companyAtsUpsert: forbidden("companyAtsUpsert", calls),
sourcedUpsertBatch: forbidden("sourcedUpsertBatch", calls),
captureAndPersistOffersIfDb: forbidden("captureAndPersistOffersIfDb", calls),
writeTracker: forbidden("writeTracker", calls),
```

Follow up with explicit negative assertions on the collected call log and generated files:

```js
// Source analog: tests/company-proposals-route.test.mjs:336
assert.equal(chatRuntime.starts.length, 0);
assert.equal(calls.some((call) => call.name === "runSkillStream"), false);
assert.deepEqual(sourceConfigGet({ repoRoot, name: "sourced-scan" }).data.tracked_companies, []);
assert.equal(existsSync(userPath({ repoRoot }, "workspace/tracker.json")), false);
assert.equal(existsSync(userPath({ repoRoot }, "workspace/activity.jsonl")), false);
```

### Static Ownership Scan Pattern

The existing static scan is the closest analog for Phase 05 cost boundaries.

```js
// Source analog: tests/company-discovery-regression.test.mjs:600
for (const file of discoveryFiles) {
  const source = readFileSync(file, "utf8");
  assert.doesNotMatch(source, /runSkillStream|startSession|\/api\/skill\/run/);
  assert.doesNotMatch(source, /writeFileSync|appendFileSync|createWriteStream/);
  assert.doesNotMatch(source, /workspace\/tracker\.html|workspace\/activity\.jsonl/);
}

const companyRouteSlice = routeSource.slice(
  routeSource.indexOf('addRoute("POST", "/api/discovery/company-proposals"'),
  routeSource.indexOf('addRoute("GET", "/api/discovery/state"')
);
assert.doesNotMatch(companyRouteSlice, /runSkillStream|startSession|\/api\/skill\/run/);
assert.doesNotMatch(companyRouteSlice, /writeTracker|captureAndPersistOffersIfDb/);
```

For VER-01, extend the scan to explicitly forbid `callAI(` and `runBoundedAI` outside `src/core/discovery/company-seeds.mjs`, while allowing that seed module to own bounded AI.

## Structured Output and No-AI Patterns

### Helper-Level No-AI Envelope

```js
// Source analog: tests/company-discovery-seeds.test.mjs:268
const err = new Error("no AI route configured: set ANTHROPIC_API_KEY");
err.code = BOUNDED_AI_CODES.NO_AI_ROUTE;

const result = await generateCompanySeeds({
  context,
  requestedCount: 12,
  call: async () => {
    throw err;
  },
});

assert.equal(result.status, 501);
assert.equal(result.body.ok, false);
assert.equal(result.body.code, BOUNDED_AI_CODES.NO_AI_ROUTE);
assert.equal(result.body.manual.available, true);
assert.equal(result.body.ai.used, false);
```

Use this helper pattern for seed-specific assertions. For route-level VER-03, make the same assertions on the `/api/discovery/company-proposals` response and add no-chat/no-write assertions.

### Exactly One Corrective Retry

```js
// Source analog: tests/bounded-ai.test.mjs:221
const seenCorrections = [];
const result = await runBoundedAI({
  labels: LABELS,
  schema: SEED_SCHEMA,
  manual: MANUAL,
  maxRetries: 1,
  invoke: async ({ attempt, correction }) => {
    seenCorrections.push(correction);
    return `not json (attempt ${attempt})`;
  },
});

assert.equal(seenCorrections.length, 2);
assert.equal(seenCorrections[0], null);
assert.match(seenCorrections[1], /invalid JSON/);
assert.equal(result.status, 422);
assert.equal(result.body.code, BOUNDED_AI_CODES.AI_SCHEMA_INVALID);
assert.equal(result.body.ai.retried, true);
assert.equal(result.body.manual.available, true);
```

For company seed route coverage, simulate this through `seedCall` on the proposal route. The route should expose the safe `AI_SCHEMA_INVALID` envelope and should not produce a proposal batch or confirmed writes.

### Route-Level Analogs for Malformed and No-AI

`tests/company-discovery-regression.test.mjs:534` already verifies route status envelopes. Strengthen this shape rather than starting from scratch:

```js
response = await postJson(server, "/api/discovery/company-proposals", { requestedCount: 1 });
assert.equal(response.status, 501);
assert.equal(response.body.ok, false);
assert.equal(response.body.code, "NO_AI_ROUTE");
assert.equal(response.body.manual.available, true);
assert.equal(response.body.ai.used, false);
assert.equal(server.chatRuntime.starts.length, 0);
```

Add equivalent `422 AI_SCHEMA_INVALID` route assertions for malformed-then-fail and schema-invalid seed output.

## Confirm-First Write Safety Patterns

### Supported Approval Writes Through Owners

```js
// Source analog: tests/company-proposal-decisions.test.mjs:212
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

assert.equal(calls.filter((call) => call.name === "companyAtsUpsert").length, 1);
assert.equal(calls.filter((call) => call.name === "sourcedUpsertBatch").length, 1);
assert.deepEqual(sourceConfigGet({ repoRoot, name: "sourced-scan" }).data.tracked_companies, [
  { name: "Acme AI", careers_url: "https://jobs.lever.co/acme" },
]);
```

This is the pattern for the one path that is allowed to write source config and sourced rows.

### Non-Approval Decisions Do Not Write

```js
// Source analog: tests/company-proposal-decisions.test.mjs:276
const server = bootServer(repoRoot, {
  companyAtsUpsertImpl: forbidden("companyAtsUpsert", calls),
  sourcedUpsertBatchImpl: forbidden("sourcedUpsertBatch", calls),
  captureAndPersistOffersIfDbImpl: forbidden("captureAndPersistOffersIfDb", calls),
  writeTrackerImpl: forbidden("writeTracker", calls),
});

for (const action of ["reject", "suppress", "escalate"]) {
  const { status, body } = await postJson(server, "/api/discovery/company-proposal-decisions", {
    batchId,
    proposalId,
    action,
    expectedVersion: 1,
  });
  assert.equal(status, 200, action);
  assert.equal(body.ok, true);
}

assert.equal(calls.length, 0);
assert.equal(existsSync(userPath({ repoRoot }, "workspace/tracker.json")), false);
```

Refresh uses the same no-confirmed-write pattern, while still allowing resolver/scanner/gate calls. See `tests/company-proposal-decisions.test.mjs:322`.

## Web App Patterns

### API Wrappers Must Use Local Routes

```js
// Source analog: apps/web/src/onboarding/steps/CompaniesStep.test.jsx:127
await actualApi.createCompanyProposals({ manualSeeds: [{ name: "Acme AI" }] });
await actualApi.getCompanyProposals({ status: "pending" });
await actualApi.decideCompanyProposal({ batchId, proposalId, action: "reject", expectedVersion: 1 });

expect(fetchMock.mock.calls.map(([path]) => path)).toEqual([
  "/api/discovery/company-proposals",
  "/api/discovery/company-proposals?status=pending",
  "/api/discovery/company-proposal-decisions",
]);
expect(fetchMock.mock.calls.map(([path]) => path)).not.toContain("/api/skill/run");
```

### No-AI Keeps Local Controls Available

```js
// Source analog: apps/web/src/onboarding/OnboardingPage.test.jsx:58
const capabilities = deriveRuntimeCapabilities({
  onboardState: { keyConfigured: true },
  runtimeConfig: {
    skills: [],
    chatSkills: [],
    ai: { available: false, route: "none" },
    discovery: {
      companyProposals: true,
      manualCompanySeeds: true,
      chatHandoffs: false,
    },
  },
});

expect(capabilities).toMatchObject({
  aiAvailable: false,
  aiRoute: "none",
  companyProposals: true,
  manualCompanySeeds: true,
  discoveryChatHandoffs: false,
  fullSkillRun: false,
});
```

`CompaniesStep.test.jsx:404` then proves the rendered local proposal controls remain visible and no chat panel renders when chat and AI are unavailable.

## Docs Drift Guard Patterns

### Existing Helper Style

```js
// Source analog: tests/decomposition-map.test.mjs:55
function assertContains(text, needle, label) {
  const normalizedText = text.replace(/\s+/g, " ");
  const normalizedNeedle = needle.replace(/\s+/g, " ");
  assert.ok(normalizedText.includes(normalizedNeedle), `${label} should contain ${needle}`);
}

function requiredSection(text, startHeading, endHeading) {
  const start = text.indexOf(startHeading);
  assert.notEqual(start, -1, `expected section ${startHeading}`);
  const end = text.indexOf(endHeading, start + startHeading.length);
  assert.notEqual(end, -1, `expected section ${endHeading} after ${startHeading}`);
  return text.slice(start, end);
}
```

### Route-Class Guard Pattern

```js
// Source analog: tests/decomposition-map.test.mjs:344
const ui = requiredSection(routingPolicyText, "### UI", "### CLI");
assert.match(ui, /local API routes/i);
assert.match(ui, /\/api\/data\/\*/);
assert.match(ui, /bounded AI/i);
assert.match(ui, /POST \/api\/skill\/run/);
```

For Phase 05, add a guard that reads all three docs and verifies these stable phrases/classes appear consistently:

| Concept | Required Evidence |
| --- | --- |
| Local default | `/api/discovery/company-proposals` and `/api/discovery/company-proposal-decisions` |
| Seed-only bounded AI | `company seeds`, `schema`, and `manual fallback` or `no-AI` |
| Explicit chat handoff | `/api/discovery/quick-start`, `/api/discovery/next`, and `/api/chat/*` |
| Retained full runtime | `POST /api/skill/run` and `allowlisted` |
| No hidden fallback | phrase equivalent to local errors do not silently start chat/full runtime |
| Confirmed writes | `source config`, `companyAtsUpsert` or `careerrat companies`, and confirm-first wording |

Use normalized substring or section-scoped regex assertions. Avoid asserting whole paragraphs byte-for-byte; the repo already uses section/phrase checks to avoid brittle docs tests.

## Docs Update Targets

| File | Current State | Pattern for Phase 05 |
| --- | --- | --- |
| `AGENTS.md` | Describes agent-led `discover-companies` and confirm-first source-config writes, but does not yet name the app's local proposal API split in the company-discovery guidance. | Add concise app-runtime wording near the discover-companies guidance: default app company discovery uses local proposal create/read/decision routes; agent-led `discover-companies` remains explicit and confirm-first. |
| `docs/ARCHITECTURE.md` | Already names the local API/DB layer, company proposal routes, bounded AI layer, explicit chat handoff, and retained full skill runtime. | Keep this as public summary. Only adjust if the final route-doc wording changes. |
| `.planning/architecture/runtime-routing-policy.md` | Already contains the detailed route classes, caller rules, examples, and drift checks. | Treat as authority. If adding stricter test wording, update this first, then mirror stable wording to `docs/ARCHITECTURE.md` and `AGENTS.md`. |

## Command Patterns

Quick Phase 05 signal from `05-VALIDATION.md`:

```bash
node --test tests/company-discovery-regression.test.mjs tests/company-discovery-seeds.test.mjs tests/company-proposals-route.test.mjs tests/company-proposal-decisions.test.mjs tests/decomposition-map.test.mjs
```

Full Phase 05 signal:

```bash
node --test tests/bounded-ai.test.mjs tests/structured-oneshot.test.mjs tests/call-ai.test.mjs tests/ai-proxy.test.mjs tests/assist-route.test.mjs tests/onboard-route.test.mjs tests/intake-classify.test.mjs tests/company-discovery-regression.test.mjs tests/company-discovery-seeds.test.mjs tests/company-discovery-cache-db.test.mjs tests/company-proposals-route.test.mjs tests/company-proposal-decisions.test.mjs tests/discovery-route.test.mjs tests/db-source-config.test.mjs tests/companies-cli.test.mjs tests/scan-sourced.test.mjs tests/search-route.test.mjs tests/sourced-scanner.test.mjs tests/skill-run-route.test.mjs tests/chat-runtime.test.mjs tests/skill-runtime.test.mjs tests/decomposition-map.test.mjs && npm --workspace apps/web run test -- src/onboarding/OnboardingPage.test.jsx src/onboarding/steps/CompaniesStep.test.jsx src/onboarding/steps/FinishStep.test.jsx
```

Static scans from `05-VALIDATION.md`:

```bash
rg -n "company-proposals|company-proposal-decisions|/api/discovery/quick-start|/api/discovery/next|/api/chat|/api/skill/run" AGENTS.md docs/ARCHITECTURE.md .planning/architecture/runtime-routing-policy.md
rg -n "runSkillStream|startSession|/api/skill/run|callAI\\(|runBoundedAI" src/core/discovery src/cli/discovery-route.mjs
rg -n "companyAtsUpsert|sourcedUpsertBatch|sourceConfigPut|workspace/tracker\\.json|workspace/activity\\.jsonl" src/core/discovery/company-proposal-decisions.mjs src/core/discovery/company-proposals.mjs
```

`npm test` currently runs `node --test 'tests/**/*.test.mjs'`, but Phase 05 research explicitly avoids using it as the primary signal while `tests/release-safety.test.mjs` has unrelated pre-existing local edits.

## Anti-Patterns to Avoid

- Do not make real AI calls or network calls. Use injected `seedCall`, fake SDKs, temp repos, and mocked fetch.
- Do not make route failures fall through to chat or `POST /api/skill/run`.
- Do not write generated workspace files from proposal creation, reject, suppress, escalate, or refresh paths.
- Do not trust AI output for final URLs, provider names, approval state, or writes.
- Do not hand-edit production tracker/candidate/source state in tests; use temp repos and DB verbs.
- Do not broaden this phase into `research-boards`, `evaluate-job`, browser automation, communications, or other skill migrations.
- Do not edit unrelated dirty work such as `tests/release-safety.test.mjs` or `tmp-skill-conversion/`.

## Pattern Fit by Requirement

| Requirement | Best Pattern |
| --- | --- |
| VER-01 | Static ownership scan plus forbidden injected seams in mounted discovery-route tests. |
| VER-02 | Bounded-AI retry/failure helpers from `tests/bounded-ai.test.mjs`, surfaced through company seed route tests. |
| VER-03 | No-AI envelope assertions from seed helper tests plus app capability/render assertions from onboarding tests. |
| VER-04 | Decision-route approval/non-approval tests with DB owner writes and forbidden write seams. |
| VER-05 | Section/phrase docs drift guard in `tests/decomposition-map.test.mjs` or a focused new docs test. |

## Worktree Notes

Observed pre-existing local changes:

```text
 M tests/release-safety.test.mjs
?? .planning/research/
?? tmp-skill-conversion/
```

Phase 05 planning should avoid relying on or modifying those paths unless the user explicitly pulls them into scope.
