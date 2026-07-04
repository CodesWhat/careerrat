import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { after, test } from "node:test";
import { mountDiscoveryRoutes } from "../src/cli/discovery-route.mjs";
import { closeAll } from "../src/core/db/connection.mjs";
import { candidateSetupInitialize, sourceConfigGet } from "../src/core/db/verbs.mjs";
import { userPath } from "../src/core/paths/workspace.mjs";

const cleanupRoots = [];
const FIXED_NOW = new Date("2026-07-04T12:00:00.000Z");

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
