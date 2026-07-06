// Phase 08 Plan 09 regression rollup.
//
// Decision coverage: D-01 SQLite-native state, D-02 no candidate-file product
// dependency, D-03 deep-ingest DB shape, D-04 target-shaped review, D-05
// proposal-first trust boundary, D-06 typed review surface, D-07 no AI
// interview lane, D-08 bounded schema extraction, D-09 untrusted model output,
// D-10/D-11 terminal lane semantics, D-12 durable readiness, D-13 active scan,
// D-14 bounded source parsing, D-15 explicit unsafe/unavailable outcomes.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { mountDeepIngestRoutes } from "../src/cli/deep-ingest-route.mjs";
import { BOUNDED_AI_CODES } from "../src/core/ai/bounded-ai.mjs";
import { closeAll, openDb } from "../src/core/db/connection.mjs";
import { deepIngestLaneSetState } from "../src/core/db/verbs/deep-ingest.mjs";
import {
  candidateConfigGet,
  candidateConfigPatch,
  candidateEvidenceMerge,
  candidateSetupInitialize,
} from "../src/core/db/verbs.mjs";
import { proposeEvidenceFromSource } from "../src/core/deep-ingest/proposals/evidence.mjs";
import { scanDeepIngestSource } from "../src/core/deep-ingest/source-scanner.mjs";
import { userPath } from "../src/core/paths/workspace.mjs";
import { loadLibrarySnapshot } from "../src/core/tracker/library-snapshot.mjs";

const fixtureUrl = new URL("./fixtures/deep-ingest/evals/source-cases.json", import.meta.url);
const expectedUrl = new URL("./fixtures/deep-ingest/evals/expected-outcomes.json", import.meta.url);
const SOURCE_CASES = JSON.parse(readFileSync(fixtureUrl, "utf8"));
const EXPECTED = JSON.parse(readFileSync(expectedUrl, "utf8"));
const cleanupRoots = [];

const REQUIRED_DECISIONS = Array.from(
  { length: 15 },
  (_, index) => `D-${String(index + 1).padStart(2, "0")}`
);

const REQUIRED_LANES = [
  "source_coverage",
  "evidence_claims",
  "story_bank",
  "honesty_boundaries",
  "writing_voice",
  "role_signals",
  "open_gaps",
];

const FORBIDDEN_RUNTIME_TOKENS = [
  "/api/skill/run",
  "/api/chat",
  "skillRuntime",
  "chatRuntime",
  "chatId",
  "handoff",
  "AI interview",
  "guided interview",
];

after(() => {
  closeAll();
  for (const root of cleanupRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function tempRepo(prefix) {
  const repoRoot = mkdtempSync(join(tmpdir(), prefix));
  cleanupRoots.push(repoRoot);
  return repoRoot;
}

function seedCandidate(repoRoot) {
  candidateSetupInitialize({ repoRoot });
  candidateConfigPatch({
    repoRoot,
    name: "profile",
    patch: {
      candidate: { full_name: "Synthetic Candidate", email: "candidate@example.test" },
      location: { home: "New York, NY", remote: true },
      compensation: { minimum_base: 123456, target_base: 156789 },
      authorization: { work_authorized: true, requires_sponsorship: false },
    },
  });
  candidateConfigPatch({
    repoRoot,
    name: "targeting",
    patch: {
      role_buckets: [{ name: "Applied AI", titles: ["Applied AI Engineer"] }],
      keep_signals: ["agent workflow builder"],
      cut_signals: ["unverified credential inflation"],
    },
  });
  candidateEvidenceMerge({
    repoRoot,
    claims: [{ claim: "Uses source-grounded evidence.", evidence: "Synthetic seed" }],
  });
}

function bootServer({ repoRoot, proposalBuilders = null, fetchImpl = fetch, scanSource } = {}) {
  const routes = new Map();
  function addRoute(method, path, handler) {
    routes.set(`${method} ${path}`, handler);
  }
  mountDeepIngestRoutes({
    addRoute,
    repoRoot,
    fetchImpl,
    scanSource,
    proposalBuilders,
  });
  const server = createServer((req, res) => {
    const path = (req.url || "/").split("?")[0];
    const route = routes.get(`${req.method} ${path}`);
    if (!route) {
      res.writeHead(404).end();
      return;
    }
    route(req, res);
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server)));
}

function closeServer(server) {
  return new Promise((resolve) => server.close(resolve));
}

function baseUrl(server) {
  return `http://127.0.0.1:${server.address().port}`;
}

async function postJson(server, path, payload) {
  const res = await fetch(`${baseUrl(server)}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

async function getJson(server, path) {
  const res = await fetch(`${baseUrl(server)}${path}`);
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

function assertNoRuntimeTokens(value) {
  const body = JSON.stringify(value);
  for (const token of FORBIDDEN_RUNTIME_TOKENS) {
    assert.equal(body.includes(token), false, `leaked runtime token ${token}`);
  }
}

function assertVisibleOutcome(body, expectedStatus) {
  const status = body?.data?.outcome?.status || body?.data?.source?.status;
  assert.equal(status, expectedStatus);
  const flags = [
    body?.data?.proposal,
    body?.data?.manualFallback,
    body?.data?.gap,
    body?.data?.deferred,
    body?.data?.notAvailable,
    body?.data?.error,
  ].filter(Boolean);
  assert.equal(flags.length, 1, "source ingest must expose exactly one visible outcome");
}

function assertFixtureDecisionCoverage() {
  assert.deepEqual(SOURCE_CASES.decisionCoverage, REQUIRED_DECISIONS);
  assert.deepEqual(EXPECTED.decisionCoverage, REQUIRED_DECISIONS);
}

function terminalizeAllLanes(repoRoot, laneStates) {
  for (const lane of REQUIRED_LANES) {
    const state = laneStates[lane] || { status: "completed" };
    deepIngestLaneSetState({
      repoRoot,
      lane,
      status: state.status,
      reason: state.reason,
    });
  }
}

test("D-01..D-15 happy path ingests, proposes, confirms, projects Library cards, and reaches terminal readiness", async () => {
  assertFixtureDecisionCoverage();
  const fixture = SOURCE_CASES.cases.happyPath;
  const expected = EXPECTED.cases.happyPath;
  const repoRoot = tempRepo("rolester-deep-regression-happy-");
  openDb({ repoRoot });
  seedCandidate(repoRoot);

  const proposalBuilders = {
    evidence: (args) =>
      proposeEvidenceFromSource({
        ...args,
        runBoundedAI: async (options) => {
          assert.deepEqual(options.labels, expected.aiLabels);
          assert.equal(options.structuredMode, "native-preferred");
          return {
            status: 200,
            body: {
              ok: true,
              data: fixture.aiResponse,
              ai: { used: true, mode: "native", model: "stubbed-regression-model" },
              manual: { available: true, action: "Enter manually" },
            },
          };
        },
      }),
  };

  const server = await bootServer({ repoRoot, proposalBuilders });
  try {
    const source = await postJson(server, "/api/deep-ingest/sources", fixture.source);
    assert.equal(source.status, 200);
    assertVisibleOutcome(source.body, expected.sourceStatus);
    assertNoRuntimeTokens(source.body);

    const built = await postJson(server, "/api/deep-ingest/proposals", {
      sourceId: source.body.data.source.id,
      targetShape: "evidence",
    });
    assert.equal(built.status, 200);
    assert.equal(built.body.data.builder.status, "proposal_ready");
    assert.equal(built.body.data.proposals.length, 1);
    assert.equal(built.body.data.proposals[0].status, "review_needed");
    assertNoRuntimeTokens(built.body);

    const proposal = built.body.data.proposals[0];
    const confirmed = await postJson(server, "/api/deep-ingest/proposal-decisions", {
      proposalId: proposal.id,
      expectedVersion: proposal.version,
      decision: "confirm",
      edits: fixture.confirmEdits,
    });
    assert.equal(confirmed.status, 200);
    assert.equal(confirmed.body.data.proposal.status, "confirmed");
    assert.equal(
      candidateConfigGet({ repoRoot }).evidence.claims.at(-1).claim,
      fixture.confirmEdits.items[0].claim
    );

    terminalizeAllLanes(repoRoot, fixture.terminalLaneStates);
    const state = await getJson(server, "/api/deep-ingest/state");
    assert.equal(state.status, 200);
    assert.equal(state.body.data.readiness.ready, true);
    assert.equal(state.body.data.readiness.progressText, expected.progressText);

    const snapshot = loadLibrarySnapshot({ root: repoRoot });
    assert.ok(
      snapshot.cards.some(
        (card) =>
          card.kind === "evidence" &&
          card.sourceProposalId === proposal.id &&
          card.title.includes("agentic support")
      ),
      "confirmed Deep ingest evidence should project into Library cards"
    );
    assert.equal(candidateConfigGet({ repoRoot }).setup.readiness.deep_ingest_complete, true);
    assert.equal(readFileMaybe(userPath({ repoRoot }, "candidate/evidence.yml")), null);
  } finally {
    await closeServer(server);
  }
});

test("D-07/D-08/D-10/D-11/D-12 no-AI fallback keeps source reviewable and terminal lanes explicit", async () => {
  assertFixtureDecisionCoverage();
  const fixture = SOURCE_CASES.cases.noAiManualFallback;
  const expected = EXPECTED.cases.noAiManualFallback;
  const repoRoot = tempRepo("rolester-deep-regression-noai-");
  openDb({ repoRoot });
  seedCandidate(repoRoot);

  const proposalBuilders = {
    evidence: (args) =>
      proposeEvidenceFromSource({
        ...args,
        runBoundedAI: async () => ({
          status: 501,
          body: {
            ok: false,
            code: BOUNDED_AI_CODES.NO_AI_ROUTE,
            ai: { used: false },
            manual: fixture.manualFallback,
          },
        }),
      }),
  };

  const server = await bootServer({ repoRoot, proposalBuilders });
  try {
    const source = await postJson(server, "/api/deep-ingest/sources", fixture.source);
    assert.equal(source.status, 200);
    assertVisibleOutcome(source.body, "proposal_ready");

    const beforeClaims = candidateConfigGet({ repoRoot }).evidence.claims.length;
    const built = await postJson(server, "/api/deep-ingest/proposals", {
      sourceId: source.body.data.source.id,
      targetShape: "evidence",
    });
    assert.equal(built.status, 200);
    assert.equal(built.body.data.builder.status, expected.builderStatus);
    assert.equal(built.body.data.builder.manual.available, true);
    assert.equal(built.body.data.proposals[0].proposal.status, "manual_fallback");
    assert.equal(candidateConfigGet({ repoRoot }).evidence.claims.length, beforeClaims);
    assertNoRuntimeTokens(built.body);

    terminalizeAllLanes(repoRoot, fixture.terminalLaneStates);
    const state = await getJson(server, "/api/deep-ingest/state");
    assert.equal(state.body.data.readiness.ready, true);
    assert.deepEqual(
      state.body.data.todos.map((todo) => todo.lane),
      expected.todos
    );
    assert.deepEqual(
      state.body.data.gaps.map((gap) => gap.lane),
      expected.gaps
    );
  } finally {
    await closeServer(server);
  }
});

test("D-05/D-09/D-13/D-14/D-15 hostile sources become gaps, blocked proposals, or explicit rejection", async () => {
  assertFixtureDecisionCoverage();
  const fixture = SOURCE_CASES.cases.hostileSource;
  const expected = EXPECTED.cases.hostileSource;
  const repoRoot = tempRepo("rolester-deep-regression-hostile-");
  openDb({ repoRoot });
  seedCandidate(repoRoot);

  const oversized = await scanDeepIngestSource({
    input: fixture.oversizedUrlSource,
    limits: fixture.oversizedLimits,
    resolveHost: async () => [{ address: "93.184.216.34", family: 4 }],
    fetchImpl: async () => ({
      status: 200,
      url: fixture.oversizedUrlSource.url,
      headers: new Headers({ "content-type": "text/html" }),
      text: async () => fixture.oversizedHtml,
    }),
  });
  assert.equal(oversized.status, expected.oversizedStatus);
  assert.equal(oversized.truncated, true);
  assert.match(oversized.reason, /truncated|too large/i);

  const proposalBuilders = {
    evidence: (args) =>
      proposeEvidenceFromSource({
        ...args,
        runBoundedAI: async (options) => {
          assert.deepEqual(options.labels, expected.aiLabels);
          assert.equal(JSON.stringify(options.messages).includes("IGNORE PREVIOUS"), true);
          return {
            status: 200,
            body: {
              ok: true,
              data: fixture.aiResponse,
              ai: { used: true, mode: "native", model: "stubbed-hostile-model" },
              manual: { available: true, action: "Enter manually" },
            },
          };
        },
      }),
  };

  const server = await bootServer({ repoRoot, proposalBuilders });
  try {
    const unsafe = await postJson(server, "/api/deep-ingest/sources", fixture.unsafeUrlSource);
    assert.equal(unsafe.status, 200);
    assertVisibleOutcome(unsafe.body, expected.unsafeStatus);
    assert.match(unsafe.body.data.outcome.reason, /unsafe|unsupported/i);

    const localPath = await postJson(server, "/api/deep-ingest/sources", fixture.localPathSource);
    assert.equal(localPath.status, 200);
    assertVisibleOutcome(localPath.body, expected.localPathStatus);
    assert.match(localPath.body.data.outcome.reason, /explicit local path/i);

    const hostile = await postJson(
      server,
      "/api/deep-ingest/sources",
      fixture.promptInjectionSource
    );
    assert.equal(hostile.status, 200);
    assertVisibleOutcome(hostile.body, "proposal_ready");

    const built = await postJson(server, "/api/deep-ingest/proposals", {
      sourceId: hostile.body.data.source.id,
      targetShape: "evidence",
    });
    assert.equal(built.status, 200);
    assert.equal(built.body.data.proposals.length, fixture.aiResponse.proposals.length);
    assert.deepEqual(
      built.body.data.proposals.map((proposal) => proposal.proposal.validation.blockedReasons),
      expected.blockedReasons
    );
    assertNoRuntimeTokens(built.body);

    const blockedProposal = built.body.data.proposals[0];
    const bypass = await postJson(server, "/api/deep-ingest/proposal-decisions", {
      proposalId: blockedProposal.id,
      expectedVersion: blockedProposal.version,
      decision: "confirm",
      edits: {},
    });
    assert.equal(bypass.status, expected.reviewBypassStatus);
    assert.match(bypass.body.error, /blocked|quote/i);

    const rejected = await postJson(server, "/api/deep-ingest/proposal-decisions", {
      proposalId: blockedProposal.id,
      expectedVersion: blockedProposal.version,
      decision: "reject",
      reason: "Prompt-injection and ungrounded claims require manual review.",
    });
    assert.equal(rejected.status, 200);
    assert.equal(rejected.body.data.proposal.status, "rejected");
    assertNoRuntimeTokens(rejected.body);
  } finally {
    await closeServer(server);
  }
});

function readFileMaybe(path) {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}
