import assert from "node:assert/strict";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";

import { mountOnboardRoutes } from "../src/cli/onboard-route.mjs";
import { executeWorkspaceIntent } from "../src/core/agent/workspace-agent.mjs";
import { WORKSPACE_THREAD_ID, workspaceThreadRead } from "../src/core/agent/workspace-thread.mjs";
import { closeAll } from "../src/core/db/connection.mjs";
import { candidateConfigGet, candidateSetupInitialize } from "../src/core/db/verbs.mjs";
import {
  CANDIDATE_FILES,
  COPY_ONLY_CANDIDATE_FILES,
  OPTIONAL_CANDIDATE_FILES,
} from "../src/core/profile/candidate-setup.mjs";

const cleanupRoots = [];
const REAL_ROOT = fileURLToPath(new URL("..", import.meta.url));

function tempRepo() {
  const repoRoot = mkdtempSync(join(tmpdir(), "careerrat-onboarding-write-log-"));
  cleanupRoots.push(repoRoot);
  mkdirSync(join(repoRoot, "templates"), { recursive: true });
  mkdirSync(join(repoRoot, "config"), { recursive: true });
  for (const entry of [...CANDIDATE_FILES, ...OPTIONAL_CANDIDATE_FILES]) {
    copyFileSync(join(REAL_ROOT, entry.templatePath), join(repoRoot, entry.templatePath));
    copyFileSync(join(REAL_ROOT, entry.schemaPath), join(repoRoot, entry.schemaPath));
  }
  for (const entry of COPY_ONLY_CANDIDATE_FILES) {
    copyFileSync(join(REAL_ROOT, entry.templatePath), join(repoRoot, entry.templatePath));
  }
  for (const file of [
    "templates/AGENTS.md",
    "templates/automation.example.yml",
    "config/automation.schema.json",
    "config/resume-extract.schema.json",
  ]) {
    copyFileSync(join(REAL_ROOT, file), join(repoRoot, file));
  }
  candidateSetupInitialize({ repoRoot });
  return repoRoot;
}

function bootServer(repoRoot) {
  const routes = new Map();
  mountOnboardRoutes({
    addRoute: (method, path, handler) => routes.set(`${method} ${path}`, handler),
    repoRoot,
    env: {},
  });
  return { routes };
}

async function post(server, path, payload) {
  const route = server.routes.get(`POST ${path}`);
  assert.ok(route, `missing route: POST ${path}`);
  let done;
  const ended = new Promise((resolve) => {
    done = resolve;
  });
  const req = Readable.from([Buffer.from(JSON.stringify(payload))]);
  req.method = "POST";
  req.url = path;
  const res = {
    status: null,
    rawBody: "",
    writeHead(status) {
      this.status = status;
      return this;
    },
    end(chunk = "") {
      this.rawBody += chunk;
      done();
      return this;
    },
  };
  await route(req, res);
  if (res.status === null) await ended;
  return { status: res.status, body: res.rawBody ? JSON.parse(res.rawBody) : {} };
}

function threadMessages(repoRoot) {
  return workspaceThreadRead({ repoRoot, env: {} }).messages;
}

function logged(repoRoot) {
  return threadMessages(repoRoot).filter((message) => message.metadata?.writer === "onboarding");
}

function undoIntent(message, index) {
  return {
    type: "knowledge.revert",
    entity: { type: "workspace", id: WORKSPACE_THREAD_ID },
    input: { messageId: message.id, index },
  };
}

after(() => {
  closeAll();
  for (const root of cleanupRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

test("an onboarding config save appends one action_result with an entry per value and an Undo", async () => {
  const repoRoot = tempRepo();
  const server = bootServer(repoRoot);
  const before = candidateConfigGet({ repoRoot, env: {} }).profile.candidate;
  const { status, body } = await post(server, "/api/onboard/candidate/profile", {
    source: "onboarding",
    data: { candidate: { full_name: "Ada Lovelace", email: "ada@example.test" } },
  });
  assert.equal(status, 200);
  assert.ok(body.logged);

  const messages = logged(repoRoot);
  assert.equal(messages.length, 1);
  const [message] = messages;
  assert.equal(message.kind, "action_result");
  assert.equal(message.id, body.logged);
  assert.equal(message.artifacts.length, 2);
  assert.ok(message.artifacts.every((entry) => entry.kind === "knowledge_write"));
  assert.ok(message.artifacts.every((entry) => entry.source.kind === "onboarding"));
  assert.deepEqual(message.artifacts.map((entry) => entry.path).sort(), [
    "candidate.email",
    "candidate.full_name",
  ]);
  assert.equal(message.metadata.nextActions.length, 2);
  assert.equal(message.metadata.nextActions[0].intent.type, "knowledge.revert");

  // Undo through knowledge.revert puts the earlier value back.
  const index = message.artifacts.findIndex((entry) => entry.path === "candidate.full_name");
  await executeWorkspaceIntent({ repoRoot, env: {}, intent: undoIntent(message, index) });
  const after = candidateConfigGet({ repoRoot, env: {} }).profile.candidate;
  assert.equal(after.full_name, before.full_name);
  assert.equal(after.email, "ada@example.test");
});

test("a save without source onboarding logs nothing", async () => {
  const repoRoot = tempRepo();
  const server = bootServer(repoRoot);
  const { status, body } = await post(server, "/api/onboard/candidate/profile", {
    data: { candidate: { full_name: "Grace Hopper" } },
  });
  assert.equal(status, 200);
  assert.equal(body.logged, undefined);
  assert.equal(logged(repoRoot).length, 0);
});

test("the evidence seed runs the firewall: a placeholder claim is rejected and not saved", async () => {
  const repoRoot = tempRepo();
  const server = bootServer(repoRoot);
  const { status, body } = await post(server, "/api/onboard/evidence-seed", {
    source: "onboarding",
    claims: [
      { claim: "Led the [Company] migration", evidence: "Stated during setup" },
      { claim: "Cut deploy time from 40 minutes to 8", evidence: "Stated during setup" },
    ],
  });
  assert.equal(status, 200);
  assert.equal(body.added, 1);
  assert.equal(body.rejected.length, 1);
  assert.match(body.rejected[0].reason, /placeholder/i);
  const claims = candidateConfigGet({ repoRoot, env: {} }).evidence.claims;
  assert.deepEqual(
    claims.map((claim) => claim.claim),
    ["Cut deploy time from 40 minutes to 8"]
  );

  const [message] = logged(repoRoot);
  assert.equal(message.artifacts.length, 1);
  assert.equal(message.artifacts[0].target, "evidence");
  assert.equal(message.artifacts[0].op, "add");
  assert.equal(message.artifacts[0].id, claims[0].id);

  await executeWorkspaceIntent({ repoRoot, env: {}, intent: undoIntent(message, 0) });
  assert.equal(candidateConfigGet({ repoRoot, env: {} }).evidence.claims.length, 0);
});

test("the evidence seed never overwrites a saved claim that shares a derived id", async () => {
  const repoRoot = tempRepo();
  const server = bootServer(repoRoot);
  await post(server, "/api/onboard/evidence-seed", {
    claims: [{ claim: "Ran the on-call rotation", evidence: "First evidence" }],
  });
  const again = await post(server, "/api/onboard/evidence-seed", {
    claims: [{ claim: "Ran the on-call rotation", evidence: "Different evidence" }],
  });
  assert.equal(again.body.added, 0);
  assert.equal(again.body.skipped, 1);
  const claims = candidateConfigGet({ repoRoot, env: {} }).evidence.claims;
  assert.equal(claims.length, 1);
  assert.equal(claims[0].evidence, "First evidence");
});

test("an onboarding save that lowers the pay floor needs confirmed: true", async () => {
  const repoRoot = tempRepo();
  const server = bootServer(repoRoot);
  const save = (extra = {}, minimum = 150000) =>
    post(server, "/api/onboard/candidate/profile", {
      source: "onboarding",
      data: { compensation: { minimum_base: minimum } },
      ...extra,
    });

  // First-time value and a raise apply directly.
  assert.equal((await save()).status, 200);
  assert.equal((await save({}, 160000)).status, 200);

  const refused = await save({}, 120000);
  assert.equal(refused.status, 409);
  assert.equal(refused.body.code, "CONFIRMATION_REQUIRED");
  assert.equal(refused.body.reasons.length, 1);
  assert.equal(candidateConfigGet({ repoRoot, env: {} }).profile.compensation.minimum_base, 160000);

  const confirmed = await save({ confirmed: true }, 120000);
  assert.equal(confirmed.status, 200);
  assert.equal(candidateConfigGet({ repoRoot, env: {} }).profile.compensation.minimum_base, 120000);
});

test("removing a do-not-claim entry in onboarding needs confirmed, adding one does not", async () => {
  const repoRoot = tempRepo();
  const server = bootServer(repoRoot);
  const save = (tools, extra = {}) =>
    post(server, "/api/onboard/candidate/honesty", {
      source: "onboarding",
      data: { tools },
      ...extra,
    });
  assert.equal((await save({ do_not_claim: ["Rust"] })).status, 200);
  assert.equal((await save({ do_not_claim: ["Rust", "Go"] })).status, 200);
  const refused = await save({ do_not_claim: ["Go"] });
  assert.equal(refused.status, 409);
  assert.equal(refused.body.code, "CONFIRMATION_REQUIRED");
  assert.deepEqual(candidateConfigGet({ repoRoot, env: {} }).honesty.tools.do_not_claim, [
    "Rust",
    "Go",
  ]);
  assert.equal((await save({ do_not_claim: ["Go"] }, { confirmed: true })).status, 200);
});
