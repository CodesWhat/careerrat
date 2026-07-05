import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { after, test } from "node:test";
import { mountDiscoveryRoutes } from "../src/cli/discovery-route.mjs";
import { BOUNDED_AI_CODES } from "../src/core/ai/bounded-ai.mjs";
import { closeAll } from "../src/core/db/connection.mjs";
import { companyProposalBatchLatest } from "../src/core/db/verbs/company-discovery.mjs";
import {
  appUpsert,
  candidateConfigPatch,
  candidateSetupInitialize,
  sourceConfigGet,
  sourceConfigPut,
  sourcedUpsertBatch,
} from "../src/core/db/verbs.mjs";
import { userPath } from "../src/core/paths/workspace.mjs";

const cleanupRoots = [];
const FIXED_NOW = new Date("2026-07-04T12:00:00.000Z");
const PRIVATE_CURRENT_BASE = 145 * 1000;

function tempRepo() {
  const repoRoot = mkdtempSync(join(tmpdir(), "rolester-company-proposals-route-"));
  cleanupRoots.push(repoRoot);
  return repoRoot;
}

after(() => {
  closeAll();
  for (const root of cleanupRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function fakeChatRuntime() {
  const starts = [];
  return {
    starts,
    startSession(args) {
      starts.push(args);
      throw new Error("company proposal route must not start chat runtime");
    },
    findBySkill() {
      return null;
    },
  };
}

function forbidden(name, calls) {
  return (...args) => {
    calls.push({ name, args });
    throw new Error(`${name} must not be called by company proposal generation`);
  };
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

function assertNoProposalFailureSideEffects({
  repoRoot,
  chatRuntime,
  calls,
  expectedTrackedCompanies = [],
}) {
  assert.equal(chatRuntime.starts.length, 0);
  for (const name of [
    "resolveCompanyBoard",
    "scanCompanies",
    "runSkillStream",
    "companyAtsUpsert",
    "sourcedUpsertBatch",
    "captureAndPersistOffersIfDb",
    "writeTracker",
  ]) {
    assert.equal(
      calls.some((call) => call.name === name),
      false,
      `${name} must not be called`
    );
  }
  assert.equal(companyProposalBatchLatest({ repoRoot }).batch, null);
  assert.deepEqual(
    sourceConfigGet({ repoRoot, name: "sourced-scan" }).data.tracked_companies,
    expectedTrackedCompanies
  );
  assert.equal(existsSync(userPath({ repoRoot }, "workspace/tracker.json")), false);
  assert.equal(existsSync(userPath({ repoRoot }, "workspace/activity.jsonl")), false);
}

function seedCandidateForAICompanyDiscovery(repoRoot) {
  candidateSetupInitialize({ repoRoot });
  candidateConfigPatch({
    repoRoot,
    name: "profile",
    patch: {
      candidate: { domain: "identity automation and applied AI" },
      location: {
        home: "New York, NY",
        remote: true,
        hybrid: true,
        onsite: false,
        relocation: ["NYC metro"],
      },
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
      tracked_companies: ["Candidate Target Co"],
      excluded_companies: ["Excluded Co"],
    },
  });
  sourceConfigPut({
    repoRoot,
    name: "sourced-scan",
    data: {
      tracked_companies: [{ name: "Tracked ATS Co", careers_url: "https://jobs.lever.co/tracked" }],
    },
  });
}

function bootServer(repoRoot, opts = {}) {
  const routes = new Map();
  function addRoute(method, path, handler) {
    routes.set(`${method} ${path}`, handler);
  }
  mountDiscoveryRoutes({
    addRoute,
    repoRoot,
    env: {},
    chatRuntime: opts.chatRuntime || fakeChatRuntime(),
    loadAgentGuidance: () => null,
    resolveCompanyBoard: opts.resolveCompanyBoard,
    scanCompaniesImpl: opts.scanCompaniesImpl,
    seedCall: opts.seedCall,
    fetchImpl: opts.fetchImpl,
    now: opts.now || FIXED_NOW,
    runSkillStream: opts.runSkillStream,
    companyAtsUpsert: opts.companyAtsUpsert,
    sourcedUpsertBatch: opts.sourcedUpsertBatch,
    captureAndPersistOffersIfDb: opts.captureAndPersistOffersIfDb,
    writeTracker: opts.writeTracker,
  });
  return { routes };
}

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

function assertProposalContract(proposal) {
  assert.deepEqual(Object.keys(proposal), PROPOSAL_CONTRACT_FIELDS);
}

function supportedResolution(seed, overrides = {}) {
  const slug = seed.name.toLowerCase().replace(/[^a-z0-9]+/g, "-");
  return {
    ok: true,
    companyName: seed.name,
    companyDomain: seed.domain_hint || `${slug}.example`,
    careersUrl: `https://jobs.lever.co/${slug}`,
    jobBoardUrl: `https://jobs.lever.co/${slug}`,
    atsProvider: "lever",
    apiUrl: `https://api.lever.co/v0/postings/${slug}`,
    confidence: "high",
    provenance: [{ source: "manual-domain-hint", url: `https://${slug}.example` }],
    ...overrides,
  };
}

function matchingOffer(company, overrides = {}) {
  return {
    company,
    title: "Applied AI Engineer",
    url: `https://jobs.lever.co/${company.toLowerCase().replace(/[^a-z0-9]+/g, "-")}/ai-engineer`,
    location: "Remote",
    comp: "$220,000 - $260,000",
    bodyText: "Build agentic developer workflows, LLM tool use, and customer-facing AI prototypes.",
    fit: "high",
    score: 88,
    gate: "likely-keep",
    ratingReason: "matches keep signal: agentic developer workflows",
    ruleFlags: [],
    ...overrides,
  };
}

async function postJson(server, path, payload = {}) {
  return invokeJson(server, "POST", path, JSON.stringify(payload));
}

async function postRaw(server, path, rawBody) {
  return invokeJson(server, "POST", path, rawBody);
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
  const body = res.rawBody ? JSON.parse(res.rawBody) : {};
  return { status: res.status, body };
}

test("POST /api/discovery/company-proposals creates a persisted manual-seed proposal batch without confirmed writes", async () => {
  const repoRoot = tempRepo();
  candidateSetupInitialize({ repoRoot });
  const calls = [];
  const chatRuntime = fakeChatRuntime();
  const server = bootServer(repoRoot, {
    chatRuntime,
    resolveCompanyBoard: async ({ seed }) => {
      calls.push({ name: "resolveCompanyBoard", seed });
      return {
        ok: true,
        companyName: seed.name,
        companyDomain: "acme.example",
        careersUrl: "https://jobs.lever.co/acme",
        jobBoardUrl: "https://jobs.lever.co/acme",
        atsProvider: "lever",
        apiUrl: "https://api.lever.co/v0/postings/acme",
        confidence: "high",
        provenance: [{ source: "manual-domain-hint", url: "https://acme.example" }],
      };
    },
    scanCompaniesImpl: async (config) => {
      calls.push({ name: "scanCompanies", config });
      return {
        offers: [
          {
            company: "Acme AI",
            title: "Applied AI Engineer",
            url: "https://jobs.lever.co/acme/ai-engineer",
            location: "Remote",
            comp: "$220,000 - $260,000",
            bodyText:
              "Build agentic developer workflows, LLM tool use, and customer-facing AI prototypes.",
            fit: "high",
            score: 88,
            gate: "likely-keep",
            ratingReason: "matches keep signal: agentic developer workflows",
          },
        ],
        errors: [],
      };
    },
    runSkillStream: forbidden("runSkillStream", calls),
    companyAtsUpsert: forbidden("companyAtsUpsert", calls),
    sourcedUpsertBatch: forbidden("sourcedUpsertBatch", calls),
    captureAndPersistOffersIfDb: forbidden("captureAndPersistOffersIfDb", calls),
    writeTracker: forbidden("writeTracker", calls),
  });

  const { status, body } = await postJson(server, "/api/discovery/company-proposals", {
    manualSeeds: [{ name: "Acme AI", domain_hint: "acme.example" }],
  });

  assert.equal(status, 200);
  assert.equal(body.ok, true);
  assert.equal(body.meta.version, 1);
  assert.match(body.data.batchId, /^cpb_/);
  assert.deepEqual(body.data.counts, {
    seeds: 1,
    proposals: 1,
    rejected: 0,
  });
  assert.deepEqual(body.data.rejected, []);
  assert.equal(body.data.proposals.length, 1);

  const proposal = body.data.proposals[0];
  assert.match(proposal.proposalId, /^cpp_/);
  assert.equal(proposal.company.name, "Acme AI");
  assert.equal(proposal.company.domain, "acme.example");
  assert.equal(proposal.jobBoardUrl, "https://jobs.lever.co/acme");
  assert.equal(proposal.atsProvider, "lever");
  assert.equal(proposal.confidenceTier, "high-confidence");
  assert.equal(proposal.proposedAction, "approve-supported-ats");
  assert.equal(proposal.roleSeen, "Applied AI Engineer");
  assert.equal(proposal.version, 1);
  assert.deepEqual(proposal.scanSummary, {
    status: "matching-roles-found",
    currentRoleCount: 1,
    matchingRoleCount: 1,
    errors: [],
    compStatus: "clears-floor",
  });

  const { companyProposalBatchLatest } = await import("../src/core/db/verbs/company-discovery.mjs");
  const latest = companyProposalBatchLatest({ repoRoot });
  assert.equal(latest.ok, true);
  assert.equal(latest.batch.batchId, body.data.batchId);
  assert.equal(latest.batch.proposals[0].proposalId, proposal.proposalId);

  assert.equal(chatRuntime.starts.length, 0);
  assert.equal(calls.filter((call) => call.name === "resolveCompanyBoard").length, 1);
  assert.equal(calls.filter((call) => call.name === "scanCompanies").length, 1);
  assert.equal(
    calls.some((call) => call.name === "runSkillStream"),
    false
  );
  assert.equal(
    calls.some((call) => call.name === "companyAtsUpsert"),
    false
  );
  assert.equal(
    calls.some((call) => call.name === "sourcedUpsertBatch"),
    false
  );
  assert.equal(
    calls.some((call) => call.name === "captureAndPersistOffersIfDb"),
    false
  );
  assert.equal(
    calls.some((call) => call.name === "writeTracker"),
    false
  );
  assert.deepEqual(sourceConfigGet({ repoRoot, name: "sourced-scan" }).data.tracked_companies, []);
  assert.equal(existsSync(userPath({ repoRoot }, "workspace/tracker.json")), false);
  assert.equal(existsSync(userPath({ repoRoot }, "workspace/tracker.html")), false);
  assert.equal(existsSync(userPath({ repoRoot }, "workspace/activity.jsonl")), false);
});

test("POST /api/discovery/company-proposals turns AI seeds into deterministic resolver/scanner proposals", async () => {
  const repoRoot = tempRepo();
  seedCandidateForAICompanyDiscovery(repoRoot);
  const calls = [];
  const aiCalls = [];
  const chatRuntime = fakeChatRuntime();
  const server = bootServer(repoRoot, {
    chatRuntime,
    seedCall: async (options) => {
      aiCalls.push(options);
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              companies: [
                {
                  name: "Seeded AI Co",
                  domain_hint: "seeded.example",
                  why: "Matches agentic workflows.",
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
    resolveCompanyBoard: async ({ seed }) => {
      calls.push({ name: "resolveCompanyBoard", seed });
      assert.equal(seed.name, "Seeded AI Co");
      assert.equal(seed.provider, undefined);
      assert.equal(seed.approved, undefined);
      return {
        ok: true,
        companyName: seed.name,
        companyDomain: "seeded.example",
        careersUrl: "https://jobs.lever.co/seeded",
        jobBoardUrl: "https://jobs.lever.co/seeded",
        atsProvider: "lever",
        apiUrl: "https://api.lever.co/v0/postings/seeded",
        confidence: "high",
        provenance: [{ source: "ai-domain-hint", url: "https://seeded.example" }],
      };
    },
    scanCompaniesImpl: async (config) => {
      calls.push({ name: "scanCompanies", config });
      return {
        offers: [
          {
            company: "Seeded AI Co",
            title: "Applied AI Engineer",
            url: "https://jobs.lever.co/seeded/ai-engineer",
            location: "Remote",
            comp: "$220,000 - $260,000",
            bodyText: "Build agentic developer workflows and customer-facing prototypes.",
            fit: "high",
            score: 90,
            gate: "likely-keep",
            ratingReason: "matches keep signal",
          },
        ],
        errors: [],
      };
    },
  });

  const { status, body } = await postJson(server, "/api/discovery/company-proposals", {
    requestedCount: 1,
  });

  assert.equal(status, 200);
  assert.equal(body.ok, true);
  assert.deepEqual(body.data.counts, {
    seeds: 1,
    proposals: 1,
    rejected: 0,
  });
  assert.equal(body.data.proposals.length, 1);
  assert.equal(body.data.proposals[0].company.name, "Seeded AI Co");
  assert.equal(body.data.proposals[0].confidenceTier, "high-confidence");
  assert.equal(body.meta.ai.used, true);
  assert.equal(body.meta.ai.skill, "discover-companies");
  assert.equal(body.meta.ai.action, "seed-generate");
  assert.equal(body.meta.ai.operation, "company-seeds");

  assert.equal(aiCalls.length, 1);
  assert.equal(aiCalls[0].skill, "discover-companies");
  assert.equal(aiCalls[0].action, "seed-generate");
  assert.equal(aiCalls[0].outputMode, "native");
  assert.equal(aiCalls[0].outputName, "company_seed_response");
  assert.match(aiCalls[0].messages[0].content, /identity automation and applied AI/);
  assert.match(aiCalls[0].messages[0].content, /Tracked ATS Co/);
  assert.match(aiCalls[0].messages[0].content, /Excluded Co/);
  assert.match(aiCalls[0].messages[0].content, /200000/);
  assertNoCurrentCompLeak(aiCalls[0]);
  assertNoCurrentCompLeak(body);

  assert.equal(chatRuntime.starts.length, 0);
  assert.equal(calls.filter((call) => call.name === "resolveCompanyBoard").length, 1);
  assert.equal(calls.filter((call) => call.name === "scanCompanies").length, 1);
});

test("POST /api/discovery/company-proposals maps malformed JSON to 400", async () => {
  const repoRoot = tempRepo();
  candidateSetupInitialize({ repoRoot });
  const server = bootServer(repoRoot);

  const { status, body } = await postRaw(
    server,
    "/api/discovery/company-proposals",
    '{"manualSeeds": ['
  );

  assert.equal(status, 400);
  assert.equal(body.ok, false);
  assert.equal(body.code, "BAD_REQUEST");
  assert.match(body.error.message, /invalid JSON body/);
});

test("POST /api/discovery/company-proposals rejects batches over 12 manual seeds", async () => {
  const repoRoot = tempRepo();
  candidateSetupInitialize({ repoRoot });
  const server = bootServer(repoRoot);

  const { status, body } = await postJson(server, "/api/discovery/company-proposals", {
    manualSeeds: Array.from({ length: 13 }, (_, index) => ({
      name: `Company ${index + 1}`,
      domain_hint: `company-${index + 1}.example`,
    })),
  });

  assert.equal(status, 422);
  assert.equal(body.ok, false);
  assert.equal(body.code, "VALIDATION_FAILED");
  assert.match(body.error.message, /maximum.*12/i);
});

test("POST /api/discovery/company-proposals returns the pinned high-confidence proposal contract with captured JD artifacts", async () => {
  const repoRoot = tempRepo();
  seedCandidateForAICompanyDiscovery(repoRoot);
  candidateConfigPatch({
    repoRoot,
    name: "profile",
    patch: {
      compensation: {
        current_comp_shareable: true,
        current_base: 900000,
        minimum_base: 200000,
      },
    },
  });
  const calls = [];
  const server = bootServer(repoRoot, {
    resolveCompanyBoard: async ({ seed }) => {
      calls.push({ name: "resolveCompanyBoard", seed });
      return supportedResolution(seed);
    },
    scanCompaniesImpl: async (config) => {
      calls.push({ name: "scanCompanies", config });
      return {
        offers: [matchingOffer("Contract AI")],
        errors: [],
      };
    },
    companyAtsUpsert: forbidden("companyAtsUpsert", calls),
    sourcedUpsertBatch: forbidden("sourcedUpsertBatch", calls),
    captureAndPersistOffersIfDb: forbidden("captureAndPersistOffersIfDb", calls),
    writeTracker: forbidden("writeTracker", calls),
  });

  const { status, body } = await postJson(server, "/api/discovery/company-proposals", {
    manualSeeds: [
      {
        name: "Contract AI",
        domain_hint: "contract.example",
        why: "Strong applied AI fit.",
        role_family_hint: "Applied AI",
      },
    ],
  });

  assert.equal(status, 200);
  assertNoCurrentCompLeak(body);
  assert.equal(body.data.proposals.length, 1);
  assert.deepEqual(body.data.rejected, []);
  const proposal = body.data.proposals[0];
  assertProposalContract(proposal);
  assert.equal(proposal.company.name, "Contract AI");
  assert.equal(proposal.company.domain, "contract.example");
  assert.equal(proposal.classification, "supported_ats");
  assert.equal(proposal.confidenceTier, "high-confidence");
  assert.equal(proposal.proposedAction, "approve-supported-ats");
  assert.equal(proposal.atsProvider, "lever");
  assert.equal(proposal.roleSeen, "Applied AI Engineer");
  assert.equal(proposal.scanSummary.status, "matching-roles-found");
  assert.equal(proposal.scanSummary.compStatus, "clears-floor");
  assert.equal(proposal.jdCapture.status, "captured");
  assert.equal(proposal.capturedOffers.length, 1);
  assert.match(proposal.capturedOffers[0].artifacts.jd, /^workspace\/jobs\/contract-ai-/);
  const jdText = readFileSync(
    userPath({ repoRoot }, proposal.capturedOffers[0].artifacts.jd),
    "utf8"
  );
  assert.match(jdText, /Build agentic developer workflows/);
  assert.equal(
    calls.some((call) => call.name === "companyAtsUpsert"),
    false
  );
  assert.equal(
    calls.some((call) => call.name === "sourcedUpsertBatch"),
    false
  );
  assert.equal(
    calls.some((call) => call.name === "captureAndPersistOffersIfDb"),
    false
  );
});

test("POST /api/discovery/company-proposals applies comp-plausibility flags to confidence and reject states", async () => {
  const repoRoot = tempRepo();
  seedCandidateForAICompanyDiscovery(repoRoot);
  const scanFixtures = new Map([
    [
      "Below Floor Co",
      matchingOffer("Below Floor Co", {
        comp: "$120,000 - $170,000",
        gate: "likely-cut",
        fit: "stretch",
        score: 42,
        ruleFlags: ["comp-below-floor"],
      }),
    ],
    [
      "Unposted Co",
      matchingOffer("Unposted Co", {
        comp: "",
        gate: "review",
        ruleFlags: ["comp-unposted"],
      }),
    ],
    [
      "Top Band Co",
      matchingOffer("Top Band Co", {
        comp: "$170,000 - $220,000",
        gate: "review",
        ruleFlags: ["top-of-band-only"],
      }),
    ],
    [
      "Uncertain Co",
      matchingOffer("Uncertain Co", {
        comp: "Competitive compensation; details depend on location.",
        gate: "review",
        ruleFlags: ["comp-uncertain"],
      }),
    ],
  ]);
  const server = bootServer(repoRoot, {
    resolveCompanyBoard: async ({ seed }) => supportedResolution(seed),
    scanCompaniesImpl: async (config) => {
      const company = config.tracked_companies[0].name;
      return { offers: [scanFixtures.get(company)], errors: [] };
    },
  });

  const { status, body } = await postJson(server, "/api/discovery/company-proposals", {
    manualSeeds: [...scanFixtures.keys()].map((name) => ({ name })),
  });

  assert.equal(status, 200);
  assertNoCurrentCompLeak(body);
  assert.equal(body.data.proposals.length, 3);
  assert.equal(body.data.rejected.length, 1);
  const below = body.data.rejected.find((entry) => entry.company.name === "Below Floor Co");
  assert.ok(below, "below-floor company should be rejected");
  assert.equal(below.confidenceTier, "rejected");
  assert.equal(below.classification, "rejected");
  assert.ok(below.rejectReasons.includes("comp-below-floor"));

  for (const [name, reason] of [
    ["Unposted Co", "comp-unposted"],
    ["Top Band Co", "top-of-band-only"],
    ["Uncertain Co", "comp-uncertain"],
  ]) {
    const proposal = body.data.proposals.find((entry) => entry.company.name === name);
    assert.ok(proposal, `${name} should be present for review`);
    assertProposalContract(proposal);
    assert.equal(proposal.confidenceTier, "borderline");
    assert.notEqual(proposal.proposedAction, "approve-supported-ats");
    assert.ok(proposal.reviewReasons.includes(reason));
  }
});

test("POST /api/discovery/company-proposals returns review-only non-comp borderline states", async () => {
  const repoRoot = tempRepo();
  seedCandidateForAICompanyDiscovery(repoRoot);
  const server = bootServer(repoRoot, {
    resolveCompanyBoard: async ({ seed }) => {
      if (seed.name === "Unsupported Cache Co") {
        return {
          ok: true,
          companyName: seed.name,
          companyDomain: "unsupported.example",
          careersUrl: "https://unsupported.example/careers",
          jobBoardUrl: "",
          atsProvider: "",
          classification: "unsupported_public",
          confidence: "medium",
          provenance: [{ source: "cache", url: "https://unsupported.example/careers" }],
          cacheOnly: true,
        };
      }
      return supportedResolution(seed);
    },
    scanCompaniesImpl: async (config) => {
      const company = config.tracked_companies[0].name;
      if (company === "Partial Body Co") {
        return { offers: [matchingOffer(company, { bodyText: "" })], errors: [] };
      }
      if (company === "Scanner Review Co") {
        return { offers: [matchingOffer(company, { gate: "review", ruleFlags: [] })], errors: [] };
      }
      return { offers: [], errors: [{ company, error: "unsupported provider" }] };
    },
  });

  const { status, body } = await postJson(server, "/api/discovery/company-proposals", {
    manualSeeds: ["Partial Body Co", "Scanner Review Co", "Unsupported Cache Co"],
  });

  assert.equal(status, 200);
  assert.equal(body.data.rejected.length, 0);
  assert.equal(body.data.proposals.length, 3);

  const partial = body.data.proposals.find((entry) => entry.company.name === "Partial Body Co");
  assertProposalContract(partial);
  assert.equal(partial.confidenceTier, "borderline");
  assert.equal(partial.proposedAction, "review");
  assert.ok(partial.reviewReasons.includes("jd-capture-partial"));
  assert.equal(partial.jdCapture.status, "partial");

  const scannerReview = body.data.proposals.find(
    (entry) => entry.company.name === "Scanner Review Co"
  );
  assertProposalContract(scannerReview);
  assert.equal(scannerReview.confidenceTier, "borderline");
  assert.equal(scannerReview.proposedAction, "review");
  assert.ok(scannerReview.reviewReasons.includes("scanner-review"));

  const unsupported = body.data.proposals.find(
    (entry) => entry.company.name === "Unsupported Cache Co"
  );
  assertProposalContract(unsupported);
  assert.equal(unsupported.classification, "unsupported_public");
  assert.equal(unsupported.confidenceTier, "borderline");
  assert.equal(unsupported.proposedAction, "cache-only");
  assert.ok(unsupported.reviewReasons.includes("unsupported-public-cache"));
});

test("POST /api/discovery/company-proposals hard-rejects tracked, excluded, in-play, unreachable, unsupported, and no-role companies", async () => {
  const repoRoot = tempRepo();
  seedCandidateForAICompanyDiscovery(repoRoot);
  appUpsert({
    repoRoot,
    row: {
      id: "app-applied-already",
      company: "Applied Already Co",
      role: "Applied AI Engineer",
      status: "applied",
    },
  });
  sourcedUpsertBatch({
    repoRoot,
    rows: [
      {
        id: "sourced-already",
        company: "Sourced Already Co",
        role: "Forward Deployed Engineer",
        fitScore: 82,
      },
    ],
  });
  const server = bootServer(repoRoot, {
    resolveCompanyBoard: async ({ seed }) => {
      if (seed.name === "Unreachable Co") {
        const err = new Error("unreachable company board");
        err.code = "unreachable";
        throw err;
      }
      if (seed.name === "Unsupported No Cache Co") {
        return {
          ok: false,
          companyName: seed.name,
          companyDomain: "unsupported-no-cache.example",
          careersUrl: "",
          jobBoardUrl: "",
          atsProvider: "",
          provenance: [],
        };
      }
      return supportedResolution(seed);
    },
    scanCompaniesImpl: async (config) => {
      const company = config.tracked_companies[0].name;
      if (company === "No Role Co") return { offers: [], errors: [] };
      return { offers: [matchingOffer(company)], errors: [] };
    },
  });

  const { status, body } = await postJson(server, "/api/discovery/company-proposals", {
    manualSeeds: [
      "Tracked ATS Co",
      "Excluded Co",
      "Applied Already Co",
      "Sourced Already Co",
      "Unreachable Co",
      "Unsupported No Cache Co",
      "No Role Co",
    ],
  });

  assert.equal(status, 200);
  assert.equal(body.data.proposals.length, 0);
  assert.equal(body.data.rejected.length, 7);
  const reasons = new Map(
    body.data.rejected.map((entry) => [entry.company.name, entry.rejectReasons])
  );
  assert.ok(reasons.get("Tracked ATS Co").includes("already-tracked"));
  assert.ok(reasons.get("Excluded Co").includes("excluded-company"));
  assert.ok(reasons.get("Applied Already Co").includes("already-in-play"));
  assert.ok(reasons.get("Sourced Already Co").includes("already-in-play"));
  assert.ok(reasons.get("Unreachable Co").includes("unreachable"));
  assert.ok(reasons.get("Unsupported No Cache Co").includes("unsupported-without-cache"));
  assert.ok(reasons.get("No Role Co").includes("no-current-role-signal"));
  for (const rejected of body.data.rejected) {
    assert.equal(rejected.confidenceTier, "rejected");
    assert.equal(rejected.classification, "rejected");
  }
  assertNoCurrentCompLeak(body);
});

test("VER-04 duplicate, excluded, in-play, and unsupported proposal states fail closed before confirmed writes", async () => {
  const repoRoot = tempRepo();
  seedCandidateForAICompanyDiscovery(repoRoot);
  appUpsert({
    repoRoot,
    row: {
      id: "app-ver04-applied",
      company: "Applied Already Co",
      role: "Applied AI Engineer",
      status: "applied",
    },
  });
  sourcedUpsertBatch({
    repoRoot,
    rows: [
      {
        id: "sourced-ver04-already",
        company: "Sourced Already Co",
        role: "Forward Deployed Engineer",
        fitScore: 82,
      },
    ],
  });
  const sourceBefore = JSON.parse(
    JSON.stringify(sourceConfigGet({ repoRoot, name: "sourced-scan" }).data.tracked_companies)
  );
  const trackerPath = userPath({ repoRoot }, "workspace/tracker.json");
  const activityPath = userPath({ repoRoot }, "workspace/activity.jsonl");
  const trackerBefore = existsSync(trackerPath) ? readFileSync(trackerPath, "utf8") : null;
  const activityBefore = existsSync(activityPath) ? readFileSync(activityPath, "utf8") : null;

  const calls = [];
  const chatRuntime = fakeChatRuntime();
  const server = bootServer(repoRoot, {
    chatRuntime,
    resolveCompanyBoard: async ({ seed }) => {
      calls.push({ name: "resolveCompanyBoard", seed });
      if (seed.name === "Unsupported Cache Co") {
        return {
          ok: true,
          companyName: seed.name,
          companyDomain: "unsupported-cache.example",
          careersUrl: "https://unsupported-cache.example/careers",
          jobBoardUrl: "",
          atsProvider: "",
          classification: "unsupported_public",
          confidence: "medium",
          provenance: [{ source: "cache", url: "https://unsupported-cache.example/careers" }],
          cacheOnly: true,
        };
      }
      return supportedResolution(seed);
    },
    scanCompaniesImpl: async (config) => {
      const company = config.tracked_companies[0].name;
      calls.push({ name: "scanCompanies", company });
      if (company === "Unsupported Cache Co") {
        return { offers: [], errors: [{ company, error: "unsupported provider" }] };
      }
      return { offers: [matchingOffer(company)], errors: [] };
    },
    companyAtsUpsert: forbidden("companyAtsUpsert", calls),
    sourcedUpsertBatch: forbidden("sourcedUpsertBatch", calls),
    captureAndPersistOffersIfDb: forbidden("captureAndPersistOffersIfDb", calls),
    writeTracker: forbidden("writeTracker", calls),
  });

  const { status, body } = await postJson(server, "/api/discovery/company-proposals", {
    manualSeeds: [
      "Tracked ATS Co",
      "Candidate Target Co",
      "Excluded Co",
      "Applied Already Co",
      "Sourced Already Co",
      "Unsupported Cache Co",
    ],
  });

  assert.equal(status, 200);
  assert.equal(body.ok, true);
  assert.deepEqual(body.data.counts, { seeds: 6, proposals: 1, rejected: 5 });

  const rejectedReasons = new Map(
    body.data.rejected.map((entry) => [entry.company.name, entry.rejectReasons])
  );
  for (const name of ["Tracked ATS Co", "Candidate Target Co"]) {
    assert.ok(rejectedReasons.get(name)?.includes("already-tracked"), name);
  }
  assert.ok(rejectedReasons.get("Excluded Co")?.includes("excluded-company"));
  assert.ok(rejectedReasons.get("Applied Already Co")?.includes("already-in-play"));
  assert.ok(rejectedReasons.get("Sourced Already Co")?.includes("already-in-play"));
  for (const rejected of body.data.rejected) {
    assert.equal(rejected.classification, "rejected", rejected.company.name);
    assert.equal(rejected.confidenceTier, "rejected", rejected.company.name);
    assert.equal(rejected.proposedAction, "reject", rejected.company.name);
    assert.equal(rejected.capturedOffers.length, 0, rejected.company.name);
  }

  const unsupported = body.data.proposals[0];
  assertProposalContract(unsupported);
  assert.equal(unsupported.company.name, "Unsupported Cache Co");
  assert.equal(unsupported.classification, "unsupported_public");
  assert.equal(unsupported.confidenceTier, "borderline");
  assert.equal(unsupported.proposedAction, "cache-only");
  assert.notEqual(unsupported.proposedAction, "approve-supported-ats");
  assert.equal(unsupported.atsProvider, "");
  assert.ok(unsupported.reviewReasons.includes("unsupported-public-cache"));
  assert.equal(unsupported.capturedOffers.length, 0);

  assert.equal(chatRuntime.starts.length, 0);
  for (const name of [
    "companyAtsUpsert",
    "sourcedUpsertBatch",
    "captureAndPersistOffersIfDb",
    "writeTracker",
  ]) {
    assert.equal(
      calls.some((call) => call.name === name),
      false,
      `${name} must not be called`
    );
  }
  assert.deepEqual(
    sourceConfigGet({ repoRoot, name: "sourced-scan" }).data.tracked_companies,
    sourceBefore
  );
  assert.equal(existsSync(trackerPath) ? readFileSync(trackerPath, "utf8") : null, trackerBefore);
  assert.equal(
    existsSync(activityPath) ? readFileSync(activityPath, "utf8") : null,
    activityBefore
  );
  assertNoCurrentCompLeak(body);
});

test("POST /api/discovery/company-proposals returns no-AI manual fallback without chat, full runtime, or writes", async () => {
  const repoRoot = tempRepo();
  candidateSetupInitialize({ repoRoot });
  const calls = [];
  const chatRuntime = fakeChatRuntime();
  const err = new Error("no AI route configured");
  err.code = BOUNDED_AI_CODES.NO_AI_ROUTE;
  const server = bootServer(repoRoot, {
    chatRuntime,
    seedCall: async () => {
      throw err;
    },
    resolveCompanyBoard: forbidden("resolveCompanyBoard", calls),
    scanCompaniesImpl: forbidden("scanCompanies", calls),
    runSkillStream: forbidden("runSkillStream", calls),
    companyAtsUpsert: forbidden("companyAtsUpsert", calls),
    sourcedUpsertBatch: forbidden("sourcedUpsertBatch", calls),
    captureAndPersistOffersIfDb: forbidden("captureAndPersistOffersIfDb", calls),
    writeTracker: forbidden("writeTracker", calls),
  });

  const { status, body } = await postJson(server, "/api/discovery/company-proposals", {
    requestedCount: 1,
  });

  assert.equal(status, 501);
  assert.equal(body.ok, false);
  assert.equal(body.code, BOUNDED_AI_CODES.NO_AI_ROUTE);
  assert.equal(body.manual.available, true);
  assert.equal(body.ai.used, false);
  assert.equal(body.data, undefined);
  assertNoProposalFailureSideEffects({ repoRoot, chatRuntime, calls });
});

test("POST /api/discovery/company-proposals returns AI_SCHEMA_INVALID without proposal batches or writes", async () => {
  const repoRoot = tempRepo();
  seedCandidateForAICompanyDiscovery(repoRoot);
  const trackedBefore = sourceConfigGet({ repoRoot, name: "sourced-scan" }).data.tracked_companies;
  const calls = [];
  const seedCalls = [];
  const chatRuntime = fakeChatRuntime();
  const server = bootServer(repoRoot, {
    chatRuntime,
    seedCall: async (options) => {
      seedCalls.push(options);
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              companies: [
                {
                  name: "Trusted Field Route Co",
                  domain_hint: "trusted-route.example",
                  why: "Matches agentic workflows.",
                  role_family_hint: "Applied AI",
                  confidence: "high",
                  source_hint: "bounded-ai",
                  careers_url: "https://trusted-route.example/jobs",
                },
              ],
            }),
          },
        ],
        model: "claude-native-test",
      };
    },
    resolveCompanyBoard: forbidden("resolveCompanyBoard", calls),
    scanCompaniesImpl: forbidden("scanCompanies", calls),
    runSkillStream: forbidden("runSkillStream", calls),
    companyAtsUpsert: forbidden("companyAtsUpsert", calls),
    sourcedUpsertBatch: forbidden("sourcedUpsertBatch", calls),
    captureAndPersistOffersIfDb: forbidden("captureAndPersistOffersIfDb", calls),
    writeTracker: forbidden("writeTracker", calls),
  });

  const { status, body } = await postJson(server, "/api/discovery/company-proposals", {
    requestedCount: 1,
  });

  assert.equal(seedCalls.length, 2);
  assert.match(seedCalls[1].messages.at(-1).content, /careers_url/);
  assert.equal(status, 422);
  assert.equal(body.ok, false);
  assert.equal(body.code, BOUNDED_AI_CODES.AI_SCHEMA_INVALID);
  assert.equal(body.manual.available, true);
  assert.equal(body.ai.used, true);
  assert.equal(body.ai.retried, true);
  assert.equal(body.data, undefined);
  assert.ok(
    body.error.details.some((error) => error.path.includes("careers_url")),
    "trusted URL field should be named in schema details"
  );
  assertNoCurrentCompLeak(body);
  assertNoProposalFailureSideEffects({
    repoRoot,
    chatRuntime,
    calls,
    expectedTrackedCompanies: trackedBefore,
  });
});
