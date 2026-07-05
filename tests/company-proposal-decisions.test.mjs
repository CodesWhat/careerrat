import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Readable } from "node:stream";
import { after, test } from "node:test";

import { mountDiscoveryRoutes } from "../src/cli/discovery-route.mjs";
import { closeAll, openDb } from "../src/core/db/connection.mjs";
import { sourcedUpsertBatch } from "../src/core/db/verbs/sourced.mjs";
import {
  candidateSetupInitialize,
  companyAtsUpsert,
  companyProposalBatchGet,
  companyProposalBatchPut,
  sourceConfigGet,
} from "../src/core/db/verbs.mjs";
import { buildCompanyProposal } from "../src/core/discovery/company-proposal-gate.mjs";
import { userPath } from "../src/core/paths/workspace.mjs";

const cleanupRoots = [];
const FIXED_NOW = new Date("2026-07-04T12:00:00.000Z");

function tempRepo() {
  const repoRoot = mkdtempSync(join(tmpdir(), "rolester-company-proposal-decisions-"));
  cleanupRoots.push(repoRoot);
  return repoRoot;
}

function setupRepo() {
  const repoRoot = tempRepo();
  candidateSetupInitialize({ repoRoot });
  return repoRoot;
}

after(() => {
  closeAll();
  for (const root of cleanupRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function fakeChatRuntime() {
  return {
    startSession() {
      throw new Error("company proposal decisions must not start chat runtime");
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
  mountDiscoveryRoutes({
    addRoute,
    repoRoot,
    env: {},
    chatRuntime: fakeChatRuntime(),
    loadAgentGuidance: () => null,
    now: opts.now || FIXED_NOW,
    resolveCompanyBoard: opts.resolveCompanyBoard,
    scanCompaniesImpl: opts.scanCompaniesImpl,
    gateProposal: opts.gateProposal,
    companyAtsUpsertImpl: opts.companyAtsUpsertImpl,
    sourcedUpsertBatchImpl: opts.sourcedUpsertBatchImpl,
    captureAndPersistOffersIfDbImpl: opts.captureAndPersistOffersIfDbImpl,
    writeTrackerImpl: opts.writeTrackerImpl,
  });
  return { routes };
}

async function postJson(server, path, payload = {}) {
  const route = server.routes.get(`POST ${path}`);
  assert.ok(route, `missing route: POST ${path}`);

  let resolveEnded;
  const ended = new Promise((resolve) => {
    resolveEnded = resolve;
  });
  const req = Readable.from([Buffer.from(JSON.stringify(payload))]);
  req.method = "POST";
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

function capturedOffer(company = "Acme AI", overrides = {}) {
  return {
    company,
    title: "Applied AI Engineer",
    url: `https://jobs.lever.co/${company.toLowerCase().replace(/[^a-z0-9]+/g, "-")}/ai-engineer`,
    location: "Remote",
    comp: "$220,000 - $260,000",
    bodyText: "Build agentic developer workflows and customer-facing AI prototypes.",
    fit: "high",
    score: 91,
    gate: "likely-keep",
    ratingReason: "matches keep signal",
    reqId: "ai-engineer",
    key: "lever:ai-engineer",
    bodyChars: 71,
    artifacts: {
      jd: `workspace/jobs/${company.toLowerCase().replace(/[^a-z0-9]+/g, "-")}-ai-engineer.md`,
    },
    ...overrides,
  };
}

function writeJobArtifact(repoRoot, offer) {
  const absPath = userPath({ repoRoot }, offer.artifacts.jd);
  mkdirSync(dirname(absPath), { recursive: true });
  writeFileSync(absPath, `# ${offer.title}\n\n${offer.bodyText}\n`);
}

function supportedProposal(overrides = {}) {
  const companyName = overrides.company?.name || "Acme AI";
  const offer = overrides.capturedOffers?.[0] || capturedOffer(companyName);
  return {
    proposalId: overrides.proposalId || "proposal-acme",
    company: { name: companyName, domain: "acme.example", ...(overrides.company || {}) },
    why: "Strong applied AI fit.",
    roleFamily: "Applied AI",
    roleSeen: "Applied AI Engineer",
    careersUrl: "https://jobs.lever.co/acme",
    jobBoardUrl: "https://jobs.lever.co/acme",
    atsProvider: "lever",
    classification: "supported_ats",
    confidenceTier: "high-confidence",
    provenance: [{ source: "test", url: "https://jobs.lever.co/acme" }],
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

function pendingBatch({
  batchId = "batch-acme",
  proposals = [supportedProposal()],
  rejected = [],
} = {}) {
  return {
    batchId,
    status: "pending",
    createdAt: FIXED_NOW.toISOString(),
    version: 1,
    proposals,
    rejected,
    counts: {
      seeds: proposals.length + rejected.length,
      proposals: proposals.length,
      rejected: rejected.length,
    },
  };
}

function putBatch(repoRoot, batch) {
  companyProposalBatchPut({ repoRoot, batch });
  return batch;
}

function forbidden(name, calls) {
  return (...args) => {
    calls.push({ name, args });
    throw new Error(`${name} must not be called`);
  };
}

function decisionRequest(overrides = {}) {
  return {
    batchId: "batch-acme",
    proposalId: "proposal-acme",
    action: "approve-supported-ats",
    expectedVersion: 1,
    ...overrides,
  };
}

test("POST /api/discovery/company-proposal-decisions approves a pending supported ATS proposal and promotes captured sourced rows", async () => {
  const repoRoot = setupRepo();
  const proposal = supportedProposal();
  writeJobArtifact(repoRoot, proposal.capturedOffers[0]);
  putBatch(repoRoot, pendingBatch({ proposals: [proposal] }));

  const calls = [];
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

  const { status, body } = await postJson(
    server,
    "/api/discovery/company-proposal-decisions",
    decisionRequest()
  );

  assert.equal(status, 200);
  assert.equal(body.ok, true);
  assert.equal(body.data.decision.action, "approve-supported-ats");
  assert.equal(body.data.sourceConfig.status, "added");
  assert.equal(body.data.sourced.created, 1);
  assert.equal(body.data.proposal.version, 2);
  assert.equal(body.meta.version, 2);

  assert.equal(calls.filter((call) => call.name === "companyAtsUpsert").length, 1);
  assert.deepEqual(calls[0].args.entry, {
    name: "Acme AI",
    careers_url: "https://jobs.lever.co/acme",
  });
  assert.equal(calls.filter((call) => call.name === "sourcedUpsertBatch").length, 1);
  assert.equal(
    calls.find((call) => call.name === "sourcedUpsertBatch").args.rows[0].artifacts.jd,
    proposal.capturedOffers[0].artifacts.jd
  );

  assert.deepEqual(sourceConfigGet({ repoRoot, name: "sourced-scan" }).data.tracked_companies, [
    { name: "Acme AI", careers_url: "https://jobs.lever.co/acme" },
  ]);
  assert.equal(existsSync(userPath({ repoRoot }, "config/sourced-scan.json")), false);

  const rows = openDb({ repoRoot })
    .prepare("SELECT data FROM sourced ORDER BY rowid ASC")
    .all()
    .map((row) => JSON.parse(row.data));
  assert.equal(rows.length, 1);
  assert.equal(rows[0].company, "Acme AI");
  assert.equal(rows[0].role, "Applied AI Engineer");
  assert.equal(rows[0].artifacts.jd, proposal.capturedOffers[0].artifacts.jd);

  const tracker = JSON.parse(
    readFileSync(userPath({ repoRoot }, "workspace/tracker.json"), "utf8")
  );
  assert.equal(tracker.sourced.length, 1);
  assert.equal(tracker.sourced[0].id, rows[0].id);
});

test("reject, suppress, and escalate decisions update proposal state without confirmed writes", async () => {
  const repoRoot = setupRepo();
  const calls = [];
  const server = bootServer(repoRoot, {
    companyAtsUpsertImpl: forbidden("companyAtsUpsert", calls),
    sourcedUpsertBatchImpl: forbidden("sourcedUpsertBatch", calls),
    captureAndPersistOffersIfDbImpl: forbidden("captureAndPersistOffersIfDb", calls),
    writeTrackerImpl: forbidden("writeTracker", calls),
  });

  for (const action of ["reject", "suppress", "escalate"]) {
    const batchId = `batch-${action}`;
    const proposalId = `proposal-${action}`;
    putBatch(
      repoRoot,
      pendingBatch({
        batchId,
        proposals: [supportedProposal({ proposalId, company: { name: `${action} Co` } })],
      })
    );

    const { status, body } = await postJson(server, "/api/discovery/company-proposal-decisions", {
      batchId,
      proposalId,
      action,
      expectedVersion: 1,
      reason: `${action}-by-user`,
    });

    assert.equal(status, 200, action);
    assert.equal(body.ok, true);
    assert.equal(body.data.decision.action, action);
    assert.equal(body.data.proposal.version, 2);
    assert.equal(body.data.proposal.decision.reason, `${action}-by-user`);

    const stored = companyProposalBatchGet({ repoRoot, batchId }).batch;
    assert.equal(stored.version, 2);
    assert.equal(stored.proposals[0].decision.action, action);
  }

  assert.equal(calls.length, 0);
  assert.deepEqual(sourceConfigGet({ repoRoot, name: "sourced-scan" }).data.tracked_companies, []);
  assert.equal(existsSync(userPath({ repoRoot }, "workspace/tracker.json")), false);
  assert.equal(existsSync(userPath({ repoRoot }, "workspace/activity.jsonl")), false);
});

test("refresh forces resolver refresh, rescans, reruns the gate, preserves captured JD artifacts, and performs no confirmed writes", async () => {
  const repoRoot = setupRepo();
  const proposal = supportedProposal();
  writeJobArtifact(repoRoot, proposal.capturedOffers[0]);
  putBatch(repoRoot, pendingBatch({ proposals: [proposal] }));

  const calls = [];
  const server = bootServer(repoRoot, {
    resolveCompanyBoard: async (args) => {
      calls.push({ name: "resolveCompanyBoard", args });
      assert.equal(args.forceRefresh, true);
      assert.equal(args.refreshReason, "explicit-refresh");
      return {
        ok: true,
        companyName: "Acme AI",
        companyDomain: "acme.example",
        careersUrl: "https://jobs.lever.co/acme",
        jobBoardUrl: "https://jobs.lever.co/acme",
        atsProvider: "lever",
        apiUrl: "https://api.lever.co/v0/postings/acme",
        confidence: "high",
        provenance: [{ source: "refresh", url: "https://jobs.lever.co/acme" }],
      };
    },
    scanCompaniesImpl: async (config) => {
      calls.push({ name: "scanCompanies", config });
      return { offers: [capturedOffer("Acme AI")], errors: [] };
    },
    gateProposal: (args) => {
      calls.push({ name: "gateProposal", args });
      assert.equal(args.proposalId, "proposal-acme");
      assert.equal(args.version, 2);
      assert.equal(args.capturedOffers[0].artifacts.jd, proposal.capturedOffers[0].artifacts.jd);
      return buildCompanyProposal(args);
    },
    companyAtsUpsertImpl: forbidden("companyAtsUpsert", calls),
    sourcedUpsertBatchImpl: forbidden("sourcedUpsertBatch", calls),
    captureAndPersistOffersIfDbImpl: forbidden("captureAndPersistOffersIfDb", calls),
    writeTrackerImpl: forbidden("writeTracker", calls),
  });

  const { status, body } = await postJson(
    server,
    "/api/discovery/company-proposal-decisions",
    decisionRequest({ action: "refresh" })
  );

  assert.equal(status, 200);
  assert.equal(body.ok, true);
  assert.equal(body.data.decision.action, "refresh");
  assert.equal(body.data.refreshedProposal.proposalId, "proposal-acme");
  assert.equal(body.data.refreshedProposal.version, 2);
  assert.equal(
    body.data.refreshedProposal.capturedOffers[0].artifacts.jd,
    proposal.capturedOffers[0].artifacts.jd
  );
  assert.equal(body.meta.version, 2);
  assert.equal(calls.filter((call) => call.name === "resolveCompanyBoard").length, 1);
  assert.equal(calls.filter((call) => call.name === "scanCompanies").length, 1);
  assert.equal(calls.filter((call) => call.name === "gateProposal").length, 1);
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
  assert.deepEqual(sourceConfigGet({ repoRoot, name: "sourced-scan" }).data.tracked_companies, []);
  assert.equal(existsSync(userPath({ repoRoot }, "workspace/tracker.json")), false);

  const stored = companyProposalBatchGet({ repoRoot, batchId: "batch-acme" }).batch;
  assert.equal(stored.version, 2);
  assert.equal(stored.proposals[0].version, 2);
});

test("refresh returns rejected metadata when the refreshed gate rejects the proposal", async () => {
  const repoRoot = setupRepo();
  putBatch(repoRoot, pendingBatch());
  const server = bootServer(repoRoot, {
    resolveCompanyBoard: async () => ({
      ok: true,
      companyName: "Acme AI",
      companyDomain: "acme.example",
      careersUrl: "https://jobs.lever.co/acme",
      jobBoardUrl: "https://jobs.lever.co/acme",
      atsProvider: "lever",
      provenance: [{ source: "refresh", url: "https://jobs.lever.co/acme" }],
    }),
    scanCompaniesImpl: async () => ({ offers: [], errors: [] }),
  });

  const { status, body } = await postJson(
    server,
    "/api/discovery/company-proposal-decisions",
    decisionRequest({ action: "refresh" })
  );

  assert.equal(status, 200);
  assert.equal(body.ok, true);
  assert.equal(body.data.decision.action, "refresh");
  assert.equal(body.data.refreshedProposal, null);
  assert.equal(body.data.rejected.proposalId, "proposal-acme");
  assert.ok(body.data.rejected.rejectReasons.includes("no-current-role-signal"));

  const stored = companyProposalBatchGet({ repoRoot, batchId: "batch-acme" }).batch;
  assert.equal(stored.version, 2);
  assert.equal(stored.proposals.length, 0);
  assert.equal(stored.rejected[0].proposalId, "proposal-acme");
});

test("decision endpoint fails closed for missing records, stale versions, decided proposals, unsupported actions, and invalid approvals", async () => {
  const repoRoot = setupRepo();
  const server = bootServer(repoRoot);

  let response = await postJson(
    server,
    "/api/discovery/company-proposal-decisions",
    decisionRequest({ batchId: "missing-batch" })
  );
  assert.equal(response.status, 409);
  assert.equal(response.body.code, "CONFLICT");

  putBatch(repoRoot, pendingBatch());
  response = await postJson(
    server,
    "/api/discovery/company-proposal-decisions",
    decisionRequest({ proposalId: "missing-proposal" })
  );
  assert.equal(response.status, 409);
  assert.equal(response.body.code, "CONFLICT");

  response = await postJson(
    server,
    "/api/discovery/company-proposal-decisions",
    decisionRequest({ expectedVersion: 0 })
  );
  assert.equal(response.status, 409);
  assert.equal(response.body.code, "CONFLICT");

  response = await postJson(
    server,
    "/api/discovery/company-proposal-decisions",
    decisionRequest({ action: "launch-full-skill" })
  );
  assert.equal(response.status, 400);
  assert.equal(response.body.code, "BAD_REQUEST");

  putBatch(
    repoRoot,
    pendingBatch({
      batchId: "batch-decided",
      proposals: [
        {
          ...supportedProposal({ proposalId: "proposal-decided" }),
          version: 2,
          decision: { action: "reject", status: "rejected" },
        },
      ],
    })
  );
  response = await postJson(server, "/api/discovery/company-proposal-decisions", {
    batchId: "batch-decided",
    proposalId: "proposal-decided",
    action: "reject",
    expectedVersion: 2,
  });
  assert.equal(response.status, 409);
  assert.equal(response.body.code, "CONFLICT");

  for (const [label, proposal] of [
    [
      "borderline",
      supportedProposal({
        proposalId: "proposal-borderline",
        confidenceTier: "borderline",
        proposedAction: "review",
        reviewReasons: ["scanner-review"],
      }),
    ],
    [
      "unsupported",
      supportedProposal({
        proposalId: "proposal-unsupported",
        classification: "unsupported_public",
        atsProvider: "",
        jobBoardUrl: "",
        confidenceTier: "borderline",
        proposedAction: "cache-only",
      }),
    ],
  ]) {
    const batchId = `batch-${label}`;
    putBatch(repoRoot, pendingBatch({ batchId, proposals: [proposal] }));
    response = await postJson(server, "/api/discovery/company-proposal-decisions", {
      batchId,
      proposalId: proposal.proposalId,
      action: "approve-supported-ats",
      expectedVersion: 1,
    });
    assert.equal(response.status, 422, label);
    assert.equal(response.body.code, "VALIDATION_FAILED");
  }

  putBatch(
    repoRoot,
    pendingBatch({
      batchId: "batch-rejected",
      proposals: [],
      rejected: [
        {
          proposalId: "proposal-rejected",
          company: { name: "Rejected Co", domain: "rejected.example" },
          classification: "rejected",
          confidenceTier: "rejected",
          proposedAction: "reject",
          rejectReasons: ["comp-below-floor"],
          version: 1,
        },
      ],
    })
  );
  response = await postJson(server, "/api/discovery/company-proposal-decisions", {
    batchId: "batch-rejected",
    proposalId: "proposal-rejected",
    action: "approve-supported-ats",
    expectedVersion: 1,
  });
  assert.equal(response.status, 422);
  assert.equal(response.body.code, "VALIDATION_FAILED");
});

test("VER-04 invalid and review-only decisions fail closed without confirmed writes", async () => {
  assert.fail("VER-04 invalid decision write-safety assertions are not implemented yet");
});
