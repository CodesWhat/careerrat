import assert from "node:assert/strict";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { mountOnboardRoutes } from "../src/cli/onboard-route.mjs";
import { closeAll } from "../src/core/db/connection.mjs";
import {
  candidateConfigGet,
  candidateEvidenceMerge,
  candidateSetupInitialize,
} from "../src/core/db/verbs.mjs";
import {
  CANDIDATE_FILES,
  COPY_ONLY_CANDIDATE_FILES,
  OPTIONAL_CANDIDATE_FILES,
} from "../src/core/profile/candidate-setup.mjs";

const cleanupRoots = [];
const REAL_ROOT = fileURLToPath(new URL("..", import.meta.url));

function tempRepo() {
  const repoRoot = mkdtempSync(join(tmpdir(), "careerrat-onboard-public-sync-"));
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
  copyFileSync(join(REAL_ROOT, "templates/AGENTS.md"), join(repoRoot, "templates/AGENTS.md"));
  copyFileSync(
    join(REAL_ROOT, "templates/automation.example.yml"),
    join(repoRoot, "templates/automation.example.yml")
  );
  copyFileSync(
    join(REAL_ROOT, "config/automation.schema.json"),
    join(repoRoot, "config/automation.schema.json")
  );
  copyFileSync(
    join(REAL_ROOT, "config/resume-extract.schema.json"),
    join(repoRoot, "config/resume-extract.schema.json")
  );

  candidateSetupInitialize({ repoRoot });
  return repoRoot;
}

function bootServer(repoRoot, extra = {}) {
  const routes = new Map();
  function addRoute(method, path, handler) {
    routes.set(`${method} ${path}`, handler);
  }
  mountOnboardRoutes({ addRoute, repoRoot, env: {}, ...extra });
  return { routes };
}

async function invokeJson(server, method, path, payload) {
  const route = server.routes.get(`${method} ${path}`);
  assert.ok(route, `missing route: ${method} ${path}`);
  let resolveEnded;
  const ended = new Promise((resolve) => {
    resolveEnded = resolve;
  });
  const req = Readable.from(payload === undefined ? [] : [Buffer.from(JSON.stringify(payload))]);
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

function getJson(server, path) {
  return invokeJson(server, "GET", path);
}

function postJson(server, path, payload) {
  return invokeJson(server, "POST", path, payload);
}

after(() => {
  closeAll();
  for (const root of cleanupRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

test("onboarding state reports public sync preference enabled by default", async () => {
  const repoRoot = tempRepo();
  const server = bootServer(repoRoot);

  const { status, body } = await getJson(server, "/api/onboard/state");
  assert.equal(status, 200);
  assert.equal(body.ok, true);
  assert.deepEqual(body.publicSyncPreference, {
    enabled: true,
    source: "default",
    updatedAt: null,
  });
});

test("evidence replacement route updates one whole validated section and rejects unsafe partial writes", async () => {
  const repoRoot = tempRepo();
  candidateEvidenceMerge({
    repoRoot,
    claims: [
      { id: "seed-001", claim: "Original claim", evidence: "Resume" },
      { id: "seed-002", claim: "Omitted claim", evidence: "Notes" },
    ],
  });
  const server = bootServer(repoRoot);

  const replaced = await postJson(server, "/api/onboard/candidate/evidence/replace", {
    claims: [{ id: "seed-001", claim: "Edited claim", evidence: "Resume v2" }],
  });
  assert.equal(replaced.status, 200);
  assert.deepEqual(candidateConfigGet({ repoRoot }).evidence.claims, [
    { id: "seed-001", claim: "Edited claim", evidence: "Resume v2" },
  ]);

  const rejected = await postJson(server, "/api/onboard/candidate/evidence/replace", {
    claims: [
      { id: "seed-001", claim: "Would otherwise write", evidence: "Resume" },
      { id: "seed-002", claim: "TODO replace me", evidence: "Notes" },
    ],
  });
  assert.equal(rejected.status, 400);
  assert.deepEqual(candidateConfigGet({ repoRoot }).evidence.claims, [
    { id: "seed-001", claim: "Edited claim", evidence: "Resume v2" },
  ]);
});

test("evidence replacement requires SQLite and never writes a compatibility file", async () => {
  const repoRoot = tempRepo();
  closeAll();
  rmSync(join(repoRoot, ".careerrat"), { recursive: true, force: true });
  const server = bootServer(repoRoot);

  const result = await postJson(server, "/api/onboard/candidate/evidence/replace", {
    claims: [{ id: "seed-001", claim: "Should not write", evidence: "Resume" }],
  });

  assert.equal(result.status, 409);
  assert.match(result.body.error, /SQLite candidate setup is required/);
  assert.equal(existsSync(join(repoRoot, "candidate/evidence.yml")), false);
});

test("POST /api/onboard/public-sync-preference persists local opt-out and opt-in", async () => {
  const repoRoot = tempRepo();
  const server = bootServer(repoRoot);

  const off = await postJson(server, "/api/onboard/public-sync-preference", { enabled: false });
  assert.equal(off.status, 200);
  assert.equal(off.body.ok, true);
  assert.equal(off.body.publicSyncPreference.enabled, false);
  assert.equal(off.body.publicSyncPreference.source, "user");

  const stateOff = await getJson(server, "/api/onboard/state");
  assert.equal(stateOff.body.publicSyncPreference.enabled, false);

  const on = await postJson(server, "/api/onboard/public-sync-preference", { enabled: true });
  assert.equal(on.status, 200);
  assert.equal(on.body.publicSyncPreference.enabled, true);

  const invalid = await postJson(server, "/api/onboard/public-sync-preference", {
    enabled: "yes please",
  });
  assert.equal(invalid.status, 400);
  assert.match(invalid.body.error.message, /enabled/i);
});
