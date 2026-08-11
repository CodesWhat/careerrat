import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { afterEach, test } from "node:test";

import {
  HOSTED_INTEREST_RELPATH,
  mountHostedInterestRoutes,
} from "../src/cli/hosted-interest-route.mjs";
import { userPath } from "../src/core/paths/workspace.mjs";

const roots = new Set();

function root() {
  const value = mkdtempSync(join(tmpdir(), "careerrat-hosted-interest-route-"));
  roots.add(value);
  return value;
}

afterEach(() => {
  for (const value of roots) rmSync(value, { recursive: true, force: true });
  roots.clear();
});

function boot({ env = { ROLESTER_DESKTOP_SHELL: "1" } } = {}) {
  const repoRoot = root();
  const routes = new Map();
  mountHostedInterestRoutes({
    addRoute: (method, path, handler) => routes.set(`${method} ${path}`, handler),
    repoRoot,
    env,
  });
  return { routes, repoRoot, env };
}

async function request(server, method, path, body) {
  const req = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]);
  req.headers = body === undefined ? {} : { "content-type": "application/json" };
  let status = null;
  let text = "";
  const res = {
    writeHead(value) {
      status = value;
      return this;
    },
    end(value = "") {
      text += value;
    },
  };
  const handler = server.routes.get(`${method} ${path}`);
  assert.ok(handler, `missing ${method} ${path}`);
  await handler(req, res);
  return { status, body: JSON.parse(text) };
}

function readInterestFile(server) {
  const path = userPath({ repoRoot: server.repoRoot, env: server.env }, HOSTED_INTEREST_RELPATH);
  // A rejected (400) request never writes the file at all — a 0-record
  // result is a legitimate "nothing appended" outcome, not a test error.
  if (!existsSync(path)) return [];
  return JSON.parse(readFileSync(path, "utf8"));
}

test("POST /api/hosted-interest with a valid email appends a requested_at/source/email record and responds ok", async () => {
  const server = boot({});
  const response = await request(server, "POST", "/api/hosted-interest", {
    email: "morgan@example.com",
  });
  assert.equal(response.status, 200);
  assert.deepEqual(response.body, { ok: true });

  const records = readInterestFile(server);
  assert.equal(records.length, 1);
  assert.equal(records[0].source, "engine-screen");
  assert.equal(records[0].email, "morgan@example.com");
  assert.equal(Number.isNaN(Date.parse(records[0].requested_at)), false);
});

test("multiple presses append rather than overwrite", async () => {
  const server = boot({});
  await request(server, "POST", "/api/hosted-interest", { email: "morgan@example.com" });
  await request(server, "POST", "/api/hosted-interest", { email: "morgan@example.com" });
  await request(server, "POST", "/api/hosted-interest", { email: "morgan@example.com" });

  const records = readInterestFile(server);
  assert.equal(records.length, 3);
  for (const record of records) {
    assert.equal(record.source, "engine-screen");
    assert.equal(record.email, "morgan@example.com");
    assert.equal(Number.isNaN(Date.parse(record.requested_at)), false);
  }
});

test("rejects a missing email with 400 and writes nothing", async () => {
  const server = boot({});
  const response = await request(server, "POST", "/api/hosted-interest", {});
  assert.equal(response.status, 400);
  assert.equal(response.body.ok, false);
  assert.ok(response.body.error);

  const records = readInterestFile(server);
  assert.equal(records.length, 0);
});

test("rejects an obviously-malformed email with 400 and writes nothing", async () => {
  const server = boot({});
  const response = await request(server, "POST", "/api/hosted-interest", {
    email: "not-an-email",
  });
  assert.equal(response.status, 400);
  assert.equal(response.body.ok, false);

  const records = readInterestFile(server);
  assert.equal(records.length, 0);
});
