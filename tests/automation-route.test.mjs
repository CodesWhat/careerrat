import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { test } from "node:test";

import { mountAutomationRoutes } from "../src/cli/automation-route.mjs";
import { closeAll } from "../src/core/db/connection.mjs";
import { candidateConfigGet, candidateSetupInitialize } from "../src/core/db/verbs/candidate.mjs";
import { parseYaml } from "../src/core/profile/yaml.mjs";

const repoRoot = join(new URL("..", import.meta.url).pathname);

function invokeJson(handler, body) {
  return new Promise((resolve, reject) => {
    const req = Readable.from([Buffer.from(JSON.stringify(body))]);
    req.headers = { "content-type": "application/json" };
    let status;
    let responseBody = "";
    const res = {
      writeHead(value) {
        status = value;
      },
      end(value = "") {
        responseBody += value;
        try {
          resolve({ status, body: JSON.parse(responseBody) });
        } catch (error) {
          reject(error);
        }
      },
    };
    Promise.resolve(handler(req, res)).catch(reject);
  });
}

test("GET automation settings returns the canonical Basic all-off matrix", () => {
  const repoRoot = mkdtempSync(join(tmpdir(), "careerrat-automation-route-"));
  try {
    const routes = new Map();
    mountAutomationRoutes({
      addRoute: (method, path, handler) => routes.set(`${method} ${path}`, handler),
      repoRoot,
    });
    const handler = routes.get("GET /api/settings/automation");
    assert.ok(handler);
    let status;
    let body;
    handler(
      {},
      {
        writeHead(value) {
          status = value;
        },
        end(value) {
          body = JSON.parse(value);
        },
      }
    );
    assert.equal(status, 200);
    assert.equal(body.mode, "basic");
    assert.equal(body.liveCount, 0);
    assert.equal(
      body.capabilities.every(({ enabled }) => enabled === false),
      true
    );
    assert.equal(
      body.capabilities.every(({ platforms }) => platforms.every(({ allowed }) => !allowed)),
      true
    );
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test("GET automation settings resolves a fresh packaged auto provider to bundled Playwright", () => {
  const careerratHome = mkdtempSync(join(tmpdir(), "careerrat-automation-route-packaged-"));
  try {
    const routes = new Map();
    mountAutomationRoutes({
      addRoute: (method, path, handler) => routes.set(`${method} ${path}`, handler),
      repoRoot,
      env: { CAREERRAT_HOME: careerratHome, CAREERRAT_PACKAGED_DESKTOP: "1" },
    });
    const handler = routes.get("GET /api/settings/automation");
    let body;
    handler(
      {},
      {
        writeHead() {},
        end(value) {
          body = JSON.parse(value);
        },
      }
    );

    assert.equal(body.session.provider, "auto");
    assert.equal(body.session.effectiveProvider, "playwright");
    assert.equal(body.session.options.find(({ id }) => id === "auto").automatedApply, true);
  } finally {
    rmSync(careerratHome, { recursive: true, force: true });
  }
});

test("POST automation session persists a supported provider through the canonical settings route", async () => {
  const careerratHome = mkdtempSync(join(tmpdir(), "careerrat-automation-route-write-"));
  const env = { CAREERRAT_HOME: careerratHome, CAREERRAT_PACKAGED_DESKTOP: "1" };
  try {
    const routes = new Map();
    mountAutomationRoutes({
      addRoute: (method, path, handler) => routes.set(`${method} ${path}`, handler),
      repoRoot,
      env,
    });

    const result = await invokeJson(routes.get("POST /api/settings/automation/session"), {
      provider: "playwright",
    });

    assert.equal(result.status, 200);
    assert.equal(result.body.ok, true);
    assert.equal(result.body.automation.session.provider, "playwright");
    assert.equal(result.body.automation.session.effectiveProvider, "playwright");
    const savedPath = join(careerratHome, "candidate", "automation.yml");
    assert.equal(existsSync(savedPath), true);
    assert.equal(parseYaml(readFileSync(savedPath, "utf8")).session.provider, "playwright");
  } finally {
    rmSync(careerratHome, { recursive: true, force: true });
  }
});

test("POST automation session rejects unknown providers without creating config", async () => {
  const careerratHome = mkdtempSync(join(tmpdir(), "careerrat-automation-route-reject-"));
  const env = { CAREERRAT_HOME: careerratHome, CAREERRAT_PACKAGED_DESKTOP: "1" };
  try {
    const routes = new Map();
    mountAutomationRoutes({
      addRoute: (method, path, handler) => routes.set(`${method} ${path}`, handler),
      repoRoot,
      env,
    });

    const result = await invokeJson(routes.get("POST /api/settings/automation/session"), {
      provider: "browser-with-no-policy",
    });

    assert.equal(result.status, 400);
    assert.equal(result.body.code, "AUTOMATION_PROVIDER_UNKNOWN");
    assert.equal(existsSync(join(careerratHome, "candidate", "automation.yml")), false);
  } finally {
    rmSync(careerratHome, { recursive: true, force: true });
  }
});

test("POST automation session writes the canonical SQLite candidate settings in DB workspaces", async () => {
  const careerratHome = mkdtempSync(join(tmpdir(), "careerrat-automation-route-db-"));
  const env = { CAREERRAT_HOME: careerratHome, CAREERRAT_PACKAGED_DESKTOP: "1" };
  try {
    candidateSetupInitialize({ repoRoot, env });
    const routes = new Map();
    mountAutomationRoutes({
      addRoute: (method, path, handler) => routes.set(`${method} ${path}`, handler),
      repoRoot,
      env,
    });

    const result = await invokeJson(routes.get("POST /api/settings/automation/session"), {
      provider: "playwright",
    });

    assert.equal(result.status, 200);
    assert.equal(candidateConfigGet({ repoRoot, env }).automation.session.provider, "playwright");
    assert.equal(existsSync(join(careerratHome, "candidate", "automation.yml")), false);
  } finally {
    closeAll();
    rmSync(careerratHome, { recursive: true, force: true });
  }
});
