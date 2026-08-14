import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Readable } from "node:stream";
import { after, test } from "node:test";

import { mountJobArtifactRoutes } from "../src/cli/job-artifact-route.mjs";
import { closeAll, openDb } from "../src/core/db/connection.mjs";
import { appUpsert, sourcedUpsertBatch } from "../src/core/db/verbs.mjs";
import { readJobDescriptionArtifact } from "../src/core/jobs/job-description.mjs";
import { userPath } from "../src/core/paths/workspace.mjs";

const cleanupRoots = [];

function tempRepo() {
  const repoRoot = mkdtempSync(join(tmpdir(), "careerrat-job-artifact-"));
  cleanupRoots.push(repoRoot);
  openDb({ repoRoot, env: {} });
  return repoRoot;
}

after(() => {
  closeAll();
  for (const root of cleanupRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function writeArtifact(repoRoot, relPath, text) {
  const full = userPath({ repoRoot, env: {} }, relPath);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, text, "utf8");
}

const COMPLETE_JD = `---
company: "Temporal Labs"
role: "Applied AI Engineer"
source: "https://jobs.ashbyhq.com/temporal/123"
sourceName: "Temporal ATS"
dateSaved: "2026-08-09"
partial: false
---

# Applied AI Engineer — Temporal Labs

## Job Description

Build production agentic workflows with customers and own deployment outcomes.
`;

test("reads a captured application JD as user metadata plus a safe first-class preview", () => {
  const repoRoot = tempRepo();
  const relPath = "workspace/jobs/temporal-applied-ai-engineer.md";
  writeArtifact(repoRoot, relPath, COMPLETE_JD);
  appUpsert({
    repoRoot,
    env: {},
    row: {
      id: "app-temporal",
      company: "Temporal Labs",
      role: "Applied AI Engineer",
      status: "reviewed-hold",
      artifacts: { jd: relPath },
    },
  });

  const result = readJobDescriptionArtifact({
    repoRoot,
    env: {},
    source: "application",
    id: "app-temporal",
  });

  assert.equal(result.id, "app-temporal");
  assert.equal(result.recordType, "application");
  assert.equal(result.company, "Temporal Labs");
  assert.equal(result.role, "Applied AI Engineer");
  assert.equal(result.artifact.kind, "job_description");
  assert.equal(result.artifact.completeness, "complete");
  assert.equal(result.artifact.capturedAt, "2026-08-09");
  assert.equal(result.artifact.sourceName, "Temporal ATS");
  assert.equal(result.artifact.sourceUrl, "https://jobs.ashbyhq.com/temporal/123");
  assert.match(result.artifact.markdown, /Build production agentic workflows/);
  assert.match(result.artifact.html, /Build production agentic workflows/);
  assert.deepEqual(result.artifact.technical, { path: relPath });
  assert.equal(JSON.stringify(result).includes(repoRoot), false);
});

test("reads sourced JDs and labels explicitly partial captures", () => {
  const repoRoot = tempRepo();
  const relPath = "workspace/jobs/northstar-platform-engineer.md";
  writeArtifact(
    repoRoot,
    relPath,
    `---
company: "Northstar"
role: "Platform Engineer"
source: "https://example.com/jobs/1"
dateSaved: "2026-08-08"
partial: true
---

# Platform Engineer

## Job Description

Only the visible summary was captured.
`
  );
  sourcedUpsertBatch({
    repoRoot,
    env: {},
    rows: [
      {
        id: "sourced-northstar",
        company: "Northstar",
        role: "Platform Engineer",
        status: "sourced",
        source: "manual capture",
        link: "https://example.com/jobs/1",
        artifacts: { jd: relPath },
      },
    ],
  });

  const result = readJobDescriptionArtifact({
    repoRoot,
    env: {},
    source: "sourced",
    id: "sourced-northstar",
  });
  assert.equal(result.recordType, "sourced");
  assert.equal(result.artifact.completeness, "partial");
  assert.equal(result.artifact.sourceName, "manual capture");
});

test("refuses missing, unsafe, and non-job artifact paths with typed errors", () => {
  const repoRoot = tempRepo();
  for (const [id, jd] of [
    ["missing", null],
    ["traversal", "workspace/jobs/../../secret.md"],
    ["wrong-root", "workspace/tailored/resume.md"],
  ]) {
    appUpsert({
      repoRoot,
      env: {},
      row: {
        id,
        company: "Acme",
        role: "Engineer",
        status: "reviewed-hold",
        artifacts: jd ? { jd } : {},
      },
    });
  }

  assert.throws(
    () =>
      readJobDescriptionArtifact({
        repoRoot,
        env: {},
        source: "application",
        id: "missing",
      }),
    (error) => error.code === "JD_NOT_CAPTURED"
  );
  for (const id of ["traversal", "wrong-root"]) {
    assert.throws(
      () => readJobDescriptionArtifact({ repoRoot, env: {}, source: "application", id }),
      (error) => error.code === "UNSAFE_ARTIFACT_PATH"
    );
  }
});

function mountDirect(repoRoot) {
  const routes = new Map();
  mountJobArtifactRoutes({
    addRoute(method, path, handler) {
      routes.set(`${method} ${path}`, handler);
    },
    repoRoot,
    env: {},
  });
  return routes;
}

async function callDirect(routes, path) {
  const handler = routes.get("GET /api/jobs/job-description");
  assert.ok(handler);
  const req = Readable.from([]);
  req.url = path;
  req.headers = {};
  let status = 200;
  let responseBody = "";
  const res = {
    writeHead(nextStatus) {
      status = nextStatus;
      return this;
    },
    end(chunk = "") {
      responseBody += String(chunk);
    },
  };
  await handler(req, res);
  return { status, body: responseBody ? JSON.parse(responseBody) : {} };
}

test("job-description route serves the typed preview and actionable failures", async () => {
  const repoRoot = tempRepo();
  const relPath = "workspace/jobs/temporal-applied-ai-engineer.md";
  writeArtifact(repoRoot, relPath, COMPLETE_JD);
  appUpsert({
    repoRoot,
    env: {},
    row: {
      id: "app-temporal",
      company: "Temporal Labs",
      role: "Applied AI Engineer",
      status: "reviewed-hold",
      artifacts: { jd: relPath },
    },
  });
  const routes = mountDirect(repoRoot);

  const ok = await callDirect(
    routes,
    "/api/jobs/job-description?source=application&id=app-temporal"
  );
  assert.equal(ok.status, 200);
  assert.equal(ok.body.data.artifact.completeness, "complete");

  const bad = await callDirect(routes, "/api/jobs/job-description?source=application");
  assert.equal(bad.status, 400);
  assert.equal(bad.body.code, "BAD_REQUEST");

  const unknown = await callDirect(
    routes,
    "/api/jobs/job-description?source=application&id=does-not-exist"
  );
  assert.equal(unknown.status, 404);
  assert.equal(unknown.body.code, "NOT_FOUND");
});
