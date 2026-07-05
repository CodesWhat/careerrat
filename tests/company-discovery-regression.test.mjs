import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { after, test } from "node:test";
import { mountDiscoveryRoutes } from "../src/cli/discovery-route.mjs";
import { BOUNDED_AI_CODES } from "../src/core/ai/bounded-ai.mjs";
import { closeAll } from "../src/core/db/connection.mjs";
import {
  candidateConfigPatch,
  candidateSetupInitialize,
  companyAtsUpsert,
  companyProposalBatchGet,
  companyProposalBatchPut,
  sourceConfigGet,
  sourcedUpsertBatch,
} from "../src/core/db/verbs.mjs";
import { buildCompanyProposal } from "../src/core/discovery/company-proposal-gate.mjs";
import { userPath } from "../src/core/paths/workspace.mjs";

const cleanupRoots = [];
const FIXED_NOW = new Date("2026-07-04T12:00:00.000Z");
const PRIVATE_CURRENT_BASE = 145 * 1000;

const PROPOSAL_CONTRACT_FIELDS = [
  "proposalId",
  "company",
  "why",
  "roleFamily",
  "roleSeen",
  "careersUrl",
  "jobBoardUrl",
  "atsProvider",
  "classification",
  "confidenceTier",
  "provenance",
  "scanSummary",
  "jdCapture",
  "proposedAction",
  "reviewReasons",
  "rejectReasons",
  "capturedOffers",
  "version",
];

function tempRepo() {
  const repoRoot = mkdtempSync(join(tmpdir(), "rolester-company-discovery-regression-"));
  cleanupRoots.push(repoRoot);
  return repoRoot;
}

after(() => {
  closeAll();
  for (const root of cleanupRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function setupRepo() {
  const repoRoot = tempRepo();
  candidateSetupInitialize({ repoRoot });
  candidateConfigPatch({
    repoRoot,
    name: "profile",
    patch: {
      candidate: { domain: "identity automation and applied AI" },
      location: { home: "New York, NY", remote: true, hybrid: true, onsite: false },
      compensation: {
        currency: "USD",
        current_comp_shareable: true,
        current_base: PRIVATE_CURRENT_BASE,
        minimum_base: 200000,
        target_base: 225 * 1000,
        oe_min_base: 100000,
      },
    },
  });
  candidateConfigPatch({
    repoRoot,
    name: "targeting",
    patch: {
      role_buckets: [
        {
          name: "Applied AI",
          priority: "primary",
          titles: ["Applied AI Engineer", "Forward Deployed Engineer"],
        },
      ],
      keep_signals: ["agentic developer workflows", "customer-facing prototypes"],
      cut_signals: ["pure ML research"],
      tracked_companies: ["Tracked Seed Co"],
      excluded_companies: ["Excluded Co"],
    },
  });
  return repoRoot;
}

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

function bootServer(repoRoot, opts = {}) {
  const routes = new Map();
  function addRoute(method, path, handler) {
    routes.set(`${method} ${path}`, handler);
  }
  const chatRuntime = opts.chatRuntime || fakeChatRuntime();
  mountDiscoveryRoutes({
    addRoute,
    repoRoot,
    env: {},
    chatRuntime,
    loadAgentGuidance: () => null,
    fetchImpl: opts.fetchImpl,
    resolveCompanyBoard: opts.resolveCompanyBoard,
    scanCompaniesImpl: opts.scanCompaniesImpl,
    gateProposal: opts.gateProposal,
    seedCall: opts.seedCall,
    now: opts.now || FIXED_NOW,
    companyAtsUpsertImpl: opts.companyAtsUpsertImpl,
    sourcedUpsertBatchImpl: opts.sourcedUpsertBatchImpl,
  });
  return { routes, chatRuntime };
}

async function invokeJson(server, method, path, rawBody) {
  const route = server.routes.get(`${method} ${path}`);
  assert.ok(route, `missing route: ${method} ${path}`);

  let resolveEnded;
  const ended = new Promise((resolve) => {
    resolveEnded = resolve;
  });
  const req = Readable.from(rawBody === undefined ? [] : [Buffer.from(rawBody)]);
  req.method = method;
  req.url = path;

  const res = {
    status: null,
    headers: null,
    rawBody: "",
    writeHead(status, headers) {
      this.status = status;
      this.headers = headers;
      return this;
    },
    end(chunk = "") {
      this.rawBody += chunk;
      resolveEnded();
      return this;
    },
  };

  await route(req, res);
  if (res.status === null) await ended;
  return { status: res.status, body: res.rawBody ? JSON.parse(res.rawBody) : {} };
}

function postJson(server, path, payload = {}) {
  return invokeJson(server, "POST", path, JSON.stringify(payload));
}

function postRaw(server, path, rawBody) {
  return invokeJson(server, "POST", path, rawBody);
}

function getJson(server, path) {
  return invokeJson(server, "GET", path);
}

function assertNoCurrentCompLeak(value) {
  const serialized = JSON.stringify(value);
  assert.equal(serialized.includes("current_base"), false, "must not leak current_base key");
  assert.equal(
    serialized.includes("current_comp_shareable"),
    false,
    "must not leak current_comp_shareable key"
  );
  assert.equal(
    serialized.includes(String(PRIVATE_CURRENT_BASE)),
    false,
    "must not leak private current base value"
  );
}

function assertProposalContract(proposal) {
  assert.deepEqual(Object.keys(proposal), PROPOSAL_CONTRACT_FIELDS);
}

function supportedResolution(seed, overrides = {}) {
  const slug = String(seed.name || "company")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-");
  return {
    ok: true,
    companyName: seed.name,
    companyDomain: seed.domain_hint || `${slug}.example`,
    careersUrl: `https://jobs.lever.co/${slug}`,
    jobBoardUrl: `https://jobs.lever.co/${slug}`,
    atsProvider: "lever",
    apiUrl: `https://api.lever.co/v0/postings/${slug}`,
    confidence: "high",
    provenance: [{ source: "regression-fixture", url: `https://${slug}.example` }],
    ...overrides,
  };
}

function matchingOffer(company, overrides = {}) {
  const slug = String(company || "company")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-");
  return {
    company,
    title: "Applied AI Engineer",
    url: `https://jobs.lever.co/${slug}/applied-ai-engineer`,
    location: "Remote",
    comp: "$220,000 - $260,000",
    bodyText: "Build agentic developer workflows and customer-facing AI prototypes.",
    fit: "high",
    score: 91,
    gate: "likely-keep",
    ratingReason: "matches keep signal",
    reqId: `${slug}-applied-ai-engineer`,
    key: `lever:${slug}:applied-ai-engineer`,
    ruleFlags: [],
    ...overrides,
  };
}

function supportedProposal(overrides = {}) {
  const companyName = overrides.company?.name || "Refresh AI";
  const offer = overrides.capturedOffers?.[0] || {
    ...matchingOffer(companyName),
    bodyChars: 68,
    artifacts: { jd: "workspace/jobs/refresh-ai-applied-ai-engineer.md" },
  };
  return {
    proposalId: overrides.proposalId || "proposal-refresh-ai",
    company: { name: companyName, domain: "refresh.example", ...(overrides.company || {}) },
    why: "Strong applied AI fit.",
    roleFamily: "Applied AI",
    roleSeen: "Applied AI Engineer",
    careersUrl: "https://jobs.lever.co/refresh-ai",
    jobBoardUrl: "https://jobs.lever.co/refresh-ai",
    atsProvider: "lever",
    classification: "supported_ats",
    confidenceTier: "high-confidence",
    provenance: [{ source: "regression", url: "https://jobs.lever.co/refresh-ai" }],
    scanSummary: {
      status: "matching-roles-found",
      currentRoleCount: 1,
      matchingRoleCount: 1,
      errors: [],
      compStatus: "clears-floor",
    },
    jdCapture: { status: "captured", capturedCount: 1 },
    proposedAction: "approve-supported-ats",
    reviewReasons: [],
    rejectReasons: [],
    capturedOffers: [offer],
    version: 1,
    ...overrides,
  };
}

function pendingBatch({ batchId = "batch-refresh-ai", proposals = [supportedProposal()] } = {}) {
  return {
    batchId,
    status: "pending",
    createdAt: FIXED_NOW.toISOString(),
    version: 1,
    proposals,
    rejected: [],
    counts: { seeds: proposals.length, proposals: proposals.length, rejected: 0 },
  };
}

test("manual proposal create, latest pending read, approval, and sourced promotion stay local and deterministic", async () => {
  const repoRoot = setupRepo();
  const calls = [];
  const server = bootServer(repoRoot, {
    seedCall: async () => {
      throw new Error("manual proposal creation must not invoke bounded AI");
    },
    resolveCompanyBoard: async ({ seed }) => {
      calls.push({ name: "resolveCompanyBoard", seed });
      return supportedResolution(seed);
    },
    scanCompaniesImpl: async (config) => {
      calls.push({ name: "scanCompanies", config });
      return { offers: [matchingOffer(config.tracked_companies[0].name)], errors: [] };
    },
    companyAtsUpsertImpl: (args) => {
      calls.push({ name: "companyAtsUpsert", args });
      return companyAtsUpsert(args);
    },
    sourcedUpsertBatchImpl: (args) => {
      calls.push({ name: "sourcedUpsertBatch", args });
      return sourcedUpsertBatch(args);
    },
  });

  const created = await postJson(server, "/api/discovery/company-proposals", {
    manualSeeds: [
      {
        name: "Local Deterministic AI",
        domain_hint: "local-deterministic.example",
        why: "Strong applied AI fit.",
        role_family_hint: "Applied AI",
      },
    ],
  });

  assert.equal(created.status, 200);
  assert.equal(created.body.ok, true);
  assert.equal(created.body.data.proposals.length, 1);
  const proposal = created.body.data.proposals[0];
  assertProposalContract(proposal);
  assert.equal(proposal.confidenceTier, "high-confidence");
  assert.equal(proposal.proposedAction, "approve-supported-ats");
  assert.equal(proposal.jdCapture.status, "captured");
  assert.match(proposal.capturedOffers[0].artifacts.jd, /^workspace\/jobs\//);
  assert.equal(server.chatRuntime.starts.length, 0);
  assert.equal(calls.filter((call) => call.name === "resolveCompanyBoard").length, 1);
  assert.equal(calls.filter((call) => call.name === "scanCompanies").length, 1);
  assert.equal(existsSync(userPath({ repoRoot }, "workspace/tracker.json")), false);
  assert.equal(existsSync(userPath({ repoRoot }, "workspace/activity.jsonl")), false);

  const latest = await getJson(server, "/api/discovery/company-proposals");
  assert.equal(latest.status, 200);
  assert.equal(latest.body.ok, true);
  assert.equal(latest.body.data.batch.batchId, created.body.data.batchId);
  assert.equal(latest.body.data.batch.proposals[0].proposalId, proposal.proposalId);

  const approved = await postJson(server, "/api/discovery/company-proposal-decisions", {
    batchId: created.body.data.batchId,
    proposalId: proposal.proposalId,
    action: "approve-supported-ats",
    expectedVersion: proposal.version,
  });

  assert.equal(approved.status, 200);
  assert.equal(approved.body.ok, true);
  assert.equal(approved.body.data.sourceConfig.status, "added");
  assert.equal(approved.body.data.sourced.rows, 1);
  assert.equal(calls.filter((call) => call.name === "companyAtsUpsert").length, 1);
  assert.equal(calls.filter((call) => call.name === "sourcedUpsertBatch").length, 1);
  assert.deepEqual(sourceConfigGet({ repoRoot, name: "sourced-scan" }).data.tracked_companies, [
    { name: "Local Deterministic AI", careers_url: "https://jobs.lever.co/local-deterministic-ai" },
  ]);
});

test("AI seed prompts, route data, telemetry, proposals, and rejections omit private current comp", async () => {
  const repoRoot = setupRepo();
  sourceConfigGet({ repoRoot, name: "sourced-scan" });
  const aiCalls = [];
  const server = bootServer(repoRoot, {
    seedCall: async (options) => {
      aiCalls.push(options);
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              companies: [
                {
                  name: "Private Safe AI",
                  domain_hint: "private-safe.example",
                  why: "Matches agentic workflow keep signal.",
                  role_family_hint: "Applied AI",
                  confidence: "high",
                  source_hint: "bounded-ai",
                },
              ],
            }),
          },
        ],
        model: "claude-native-test",
      };
    },
    resolveCompanyBoard: async ({ seed }) => supportedResolution(seed),
    scanCompaniesImpl: async (config) => ({
      offers: [matchingOffer(config.tracked_companies[0].name)],
      errors: [],
    }),
  });

  const response = await postJson(server, "/api/discovery/company-proposals", {
    requestedCount: 1,
  });

  assert.equal(response.status, 200);
  assert.equal(response.body.ok, true);
  assert.equal(aiCalls.length, 1);
  assert.equal(aiCalls[0].skill, "discover-companies");
  assert.equal(aiCalls[0].action, "seed-generate");
  assert.equal(aiCalls[0].outputMode, "native");
  assert.match(aiCalls[0].messages[0].content, /identity automation and applied AI/);
  assert.match(aiCalls[0].messages[0].content, /Applied AI/);
  assert.match(aiCalls[0].messages[0].content, /agentic developer workflows/);
  assert.match(aiCalls[0].messages[0].content, /Excluded Co/);
  assert.match(aiCalls[0].messages[0].content, /200000/);
  assert.equal(response.body.meta.ai.skill, "discover-companies");
  assert.equal(response.body.meta.ai.action, "seed-generate");
  assert.equal(response.body.meta.ai.operation, "company-seeds");
  assertNoCurrentCompLeak(aiCalls);
  assertNoCurrentCompLeak(response.body);
});

test("proposal contract and comp plausibility gates stay aligned end to end", async () => {
  const repoRoot = setupRepo();
  const scanFixtures = new Map([
    ["Clear Comp Co", matchingOffer("Clear Comp Co")],
    [
      "Below Floor Co",
      matchingOffer("Below Floor Co", {
        comp: "$120,000 - $170,000",
        gate: "likely-cut",
        ruleFlags: ["comp-below-floor"],
      }),
    ],
    [
      "Unposted Co",
      matchingOffer("Unposted Co", { comp: "", gate: "review", ruleFlags: ["comp-unposted"] }),
    ],
    [
      "Top Band Co",
      matchingOffer("Top Band Co", {
        comp: "$170,000 - $220,000",
        gate: "review",
        ruleFlags: ["top-of-band-only"],
      }),
    ],
  ]);
  const server = bootServer(repoRoot, {
    resolveCompanyBoard: async ({ seed }) => supportedResolution(seed),
    scanCompaniesImpl: async (config) => ({
      offers: [scanFixtures.get(config.tracked_companies[0].name)],
      errors: [],
    }),
  });

  const response = await postJson(server, "/api/discovery/company-proposals", {
    manualSeeds: [...scanFixtures.keys()].map((name) => ({ name })),
  });

  assert.equal(response.status, 200);
  assert.equal(response.body.ok, true);
  assertNoCurrentCompLeak(response.body);
  const byName = new Map(
    response.body.data.proposals.map((proposal) => [proposal.company.name, proposal])
  );
  const rejected = new Map(
    response.body.data.rejected.map((proposal) => [proposal.company.name, proposal])
  );
  assertProposalContract(byName.get("Clear Comp Co"));
  assert.equal(byName.get("Clear Comp Co").confidenceTier, "high-confidence");
  assert.equal(byName.get("Unposted Co").confidenceTier, "borderline");
  assert.ok(byName.get("Unposted Co").reviewReasons.includes("comp-unposted"));
  assert.equal(byName.get("Top Band Co").confidenceTier, "borderline");
  assert.ok(byName.get("Top Band Co").reviewReasons.includes("top-of-band-only"));
  assert.equal(rejected.get("Below Floor Co").confidenceTier, "rejected");
  assert.ok(rejected.get("Below Floor Co").rejectReasons.includes("comp-below-floor"));
});

test("refresh force-revalidates, rescans, regates, versions state, preserves JD artifacts, and performs no confirmed writes", async () => {
  const repoRoot = setupRepo();
  const proposal = supportedProposal();
  companyProposalBatchPut({ repoRoot, batch: pendingBatch({ proposals: [proposal] }) });
  const calls = [];
  const server = bootServer(repoRoot, {
    resolveCompanyBoard: async (args) => {
      calls.push({ name: "resolveCompanyBoard", args });
      assert.equal(args.forceRefresh, true);
      assert.equal(args.refreshReason, "explicit-refresh");
      return supportedResolution({ name: "Refresh AI", domain_hint: "refresh.example" });
    },
    scanCompaniesImpl: async (config) => {
      calls.push({ name: "scanCompanies", config });
      return { offers: [matchingOffer("Refresh AI")], errors: [] };
    },
    gateProposal: (args) => {
      calls.push({ name: "gateProposal", args });
      assert.equal(args.version, 2);
      assert.equal(args.capturedOffers[0].artifacts.jd, proposal.capturedOffers[0].artifacts.jd);
      return buildCompanyProposal(args);
    },
    companyAtsUpsertImpl: () => {
      throw new Error("refresh must not write source config");
    },
    sourcedUpsertBatchImpl: () => {
      throw new Error("refresh must not persist sourced rows");
    },
  });

  const response = await postJson(server, "/api/discovery/company-proposal-decisions", {
    batchId: "batch-refresh-ai",
    proposalId: "proposal-refresh-ai",
    action: "refresh",
    expectedVersion: 1,
  });

  assert.equal(response.status, 200);
  assert.equal(response.body.ok, true);
  assert.equal(response.body.data.decision.action, "refresh");
  assert.equal(response.body.data.refreshedProposal.version, 2);
  assert.equal(
    response.body.data.refreshedProposal.capturedOffers[0].artifacts.jd,
    proposal.capturedOffers[0].artifacts.jd
  );
  assert.equal(response.body.meta.version, 2);
  assert.equal(calls.filter((call) => call.name === "resolveCompanyBoard").length, 1);
  assert.equal(calls.filter((call) => call.name === "scanCompanies").length, 1);
  assert.equal(calls.filter((call) => call.name === "gateProposal").length, 1);
  assert.equal(server.chatRuntime.starts.length, 0);
  assert.deepEqual(sourceConfigGet({ repoRoot, name: "sourced-scan" }).data.tracked_companies, []);
  assert.equal(existsSync(userPath({ repoRoot }, "workspace/tracker.json")), false);

  const stored = companyProposalBatchGet({ repoRoot, batchId: "batch-refresh-ai" }).batch;
  assert.equal(stored.version, 2);
  assert.equal(stored.proposals[0].version, 2);
});

test("route status envelopes cover 400, 409, 422, 501, and 502 failures", async () => {
  const repoRoot = setupRepo();
  let server = bootServer(repoRoot);
  let response = await postRaw(server, "/api/discovery/company-proposals", '{"manualSeeds": [');
  assert.equal(response.status, 400);
  assert.equal(response.body.ok, false);
  assert.equal(response.body.code, "BAD_REQUEST");

  const noAi = new Error("no AI route configured");
  noAi.code = BOUNDED_AI_CODES.NO_AI_ROUTE;
  server = bootServer(repoRoot, {
    seedCall: async () => {
      throw noAi;
    },
  });
  response = await postJson(server, "/api/discovery/company-proposals", { requestedCount: 1 });
  assert.equal(response.status, 501);
  assert.equal(response.body.ok, false);
  assert.equal(response.body.code, "NO_AI_ROUTE");

  server = bootServer(repoRoot, {
    seedCall: async () => {
      throw new Error("provider unavailable");
    },
  });
  response = await postJson(server, "/api/discovery/company-proposals", { requestedCount: 1 });
  assert.equal(response.status, 502);
  assert.equal(response.body.ok, false);
  assert.equal(response.body.code, "AI_PROVIDER_FAILED");

  server = bootServer(repoRoot);
  response = await postJson(server, "/api/discovery/company-proposal-decisions", {
    batchId: "missing-batch",
    proposalId: "missing-proposal",
    action: "reject",
    expectedVersion: 1,
  });
  assert.equal(response.status, 409);
  assert.equal(response.body.ok, false);
  assert.equal(response.body.code, "CONFLICT");

  companyProposalBatchPut({
    repoRoot,
    batch: pendingBatch({
      batchId: "batch-borderline",
      proposals: [
        supportedProposal({
          proposalId: "proposal-borderline",
          confidenceTier: "borderline",
          proposedAction: "review",
          reviewReasons: ["scanner-review"],
        }),
      ],
    }),
  });
  response = await postJson(server, "/api/discovery/company-proposal-decisions", {
    batchId: "batch-borderline",
    proposalId: "proposal-borderline",
    action: "approve-supported-ats",
    expectedVersion: 1,
  });
  assert.equal(response.status, 422);
  assert.equal(response.body.ok, false);
  assert.equal(response.body.code, "VALIDATION_FAILED");
});

test("static ownership checks reject generated-file write seams and require supported approval verbs", () => {
  const discoveryFiles = [
    "src/core/discovery/company-board-resolver.mjs",
    "src/core/discovery/company-context.mjs",
    "src/core/discovery/company-seeds.mjs",
    "src/core/discovery/company-proposal-gate.mjs",
    "src/core/discovery/company-proposals.mjs",
    "src/core/discovery/company-proposal-decisions.mjs",
  ];
  for (const file of discoveryFiles) {
    const source = readFileSync(file, "utf8");
    assert.doesNotMatch(source, /runSkillStream|startSession|\/api\/skill\/run/);
    assert.doesNotMatch(source, /writeFileSync|appendFileSync|createWriteStream/);
    assert.doesNotMatch(source, /workspace\/tracker\.html|workspace\/activity\.jsonl/);
  }

  const routeSource = readFileSync("src/cli/discovery-route.mjs", "utf8");
  const companyRouteSlice = routeSource.slice(
    routeSource.indexOf('addRoute("POST", "/api/discovery/company-proposals"'),
    routeSource.indexOf('addRoute("GET", "/api/discovery/state"')
  );
  assert.doesNotMatch(companyRouteSlice, /runSkillStream|startSession|\/api\/skill\/run/);
  assert.doesNotMatch(companyRouteSlice, /writeTracker|captureAndPersistOffersIfDb/);

  const decisions = readFileSync("src/core/discovery/company-proposal-decisions.mjs", "utf8");
  assert.match(decisions, /companyAtsUpsert/);
  assert.match(decisions, /sourcedUpsertBatch/);
  assert.doesNotMatch(decisions, /sourceConfigPut|config\/sourced-scan\.json/);
});

test("VER-01 deterministic discovery paths do not call AI, chat, or retained full skill runtime", () => {
  const directAISeams = /\b(?:callAI\s*\(|runBoundedAI\b)/;
  const chatOrFullRuntimeSeams = /\b(?:runSkillStream|startSession)\b|\/api\/skill\/run/;
  const deterministicDiscoveryFiles = [
    "src/core/discovery/company-board-resolver.mjs",
    "src/core/discovery/company-context.mjs",
    "src/core/discovery/company-proposal-gate.mjs",
    "src/core/discovery/company-proposals.mjs",
    "src/core/discovery/company-proposal-decisions.mjs",
  ];

  for (const file of deterministicDiscoveryFiles) {
    const source = readFileSync(file, "utf8");
    assert.doesNotMatch(source, directAISeams, `${file} must not call direct AI seams`);
    assert.doesNotMatch(
      source,
      chatOrFullRuntimeSeams,
      `${file} must not start chat or retained skill runtime`
    );
  }

  const seedSource = readFileSync("src/core/discovery/company-seeds.mjs", "utf8");
  assert.match(seedSource, /runBoundedAI/, "company seed generation owns bounded AI usage");
  assert.match(seedSource, /skill:\s*"discover-companies"/);
  assert.match(seedSource, /action:\s*"seed-generate"/);
  assert.doesNotMatch(seedSource, /\bcallAI\s*\(/, "seed generation must not bypass bounded AI");

  const routeSource = readFileSync("src/cli/discovery-route.mjs", "utf8");
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
    assert.doesNotMatch(
      slice,
      chatOrFullRuntimeSeams,
      `${label} route must not start chat or retained skill runtime`
    );
  }
});
