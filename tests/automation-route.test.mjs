import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { mountAutomationRoutes } from "../src/cli/automation-route.mjs";

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
    handler({}, {
      writeHead(value) {
        status = value;
      },
      end(value) {
        body = JSON.parse(value);
      },
    });
    assert.equal(status, 200);
    assert.equal(body.mode, "basic");
    assert.equal(body.liveCount, 0);
    assert.equal(body.capabilities.every(({ enabled }) => enabled === false), true);
    assert.equal(
      body.capabilities.every(({ platforms }) => platforms.every(({ allowed }) => !allowed)),
      true
    );
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

