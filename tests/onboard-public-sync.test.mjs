import assert from "node:assert/strict";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { mountOnboardRoutes } from "../src/cli/onboard-route.mjs";
import { closeAll } from "../src/core/db/connection.mjs";
import { candidateSetupInitialize } from "../src/core/db/verbs.mjs";
import { ONBOARD_PAGE_HTML } from "../src/core/onboarding/onboard-page.mjs";
import {
  CANDIDATE_FILES,
  COPY_ONLY_CANDIDATE_FILES,
  OPTIONAL_CANDIDATE_FILES,
} from "../src/core/profile/candidate-setup.mjs";

const cleanupRoots = [];
const REAL_ROOT = fileURLToPath(new URL("..", import.meta.url));

function tempRepo() {
  const repoRoot = mkdtempSync(join(tmpdir(), "rolester-onboard-public-sync-"));
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

test("onboarding page includes default-on public sync UI hooks and no-private-data copy", () => {
  for (const hook of [
    'data-hook="public-sync-toggle"',
    'data-hook="public-sync-status"',
    'data-hook="public-sync-copy"',
    'data-hook="public-sync-save"',
    'data-hook="public-sync-error"',
  ]) {
    assert.ok(ONBOARD_PAGE_HTML.includes(hook), `expected ${hook}`);
  }

  assert.match(ONBOARD_PAGE_HTML, /public company and board metadata/i);
  assert.match(ONBOARD_PAGE_HTML, /improve Rolester/i);
  for (const phrase of [
    /resume/i,
    /profile/i,
    /applications/i,
    /private notes/i,
    /compensation/i,
    /fit scores/i,
    /local files/i,
  ]) {
    assert.match(ONBOARD_PAGE_HTML, phrase);
  }
});

test("onboarding page script wires public sync preference without template literals", () => {
  const match = /<script>([\s\S]*?)<\/script>/.exec(ONBOARD_PAGE_HTML);
  assert.ok(match, "expected inline script");
  assert.doesNotThrow(() => {
    // eslint-disable-next-line no-new-func
    new Function(match[1]);
  });
  assert.equal(match[1].includes("`"), false);
  assert.match(match[1], /public-sync-preference/);
});
