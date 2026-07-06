// tests/packet-generate-route.test.mjs
// RED contracts for Phase 10 Wave 0: local packet gate/generate APIs.
// These tests intentionally fail until src/cli/packet-route.mjs grows the
// POST routes and src/core/packet/* owners planned for later Phase 10 waves.

import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, test } from "node:test";
import { mountPacketRoutes } from "../src/cli/packet-route.mjs";
import { closeAll, openDb } from "../src/core/db/connection.mjs";
import { importFromTracker } from "../src/core/db/import-from-tracker.mjs";

const cleanupRoots = [];

function tempRepo() {
  const repoRoot = mkdtempSync(join(tmpdir(), "rolester-packet-generate-route-"));
  cleanupRoots.push(repoRoot);
  mkdirSync(join(repoRoot, "workspace/jobs"), { recursive: true });
  mkdirSync(join(repoRoot, "workspace/tailored"), { recursive: true });
  return repoRoot;
}

function writeWorkspaceFile(repoRoot, relPath, content) {
  const full = join(repoRoot, "workspace", relPath);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, content, "utf8");
  return `workspace/${relPath}`;
}

function importTrackerFixture(repoRoot, applications) {
  const sourceDir = join(repoRoot, "fixture-source");
  mkdirSync(sourceDir, { recursive: true });
  writeFileSync(
    join(sourceDir, "tracker.json"),
    JSON.stringify(
      { meta: {}, applications, sourced: [], sources: [], communications: [] },
      null,
      2
    )
  );
  importFromTracker({ repoRoot, sourceDir });
  assert.equal(
    existsSync(join(repoRoot, "workspace/tracker.json")),
    false,
    "packet generate tests seed SQLite directly and must not require generated tracker exports"
  );
}

function seedPacketReadyApp(repoRoot) {
  const jdPath = writeWorkspaceFile(
    repoRoot,
    "jobs/acme-applied-ai-engineer.md",
    [
      "---",
      'company: "Acme AI"',
      'role: "Applied AI Engineer"',
      "---",
      "# Job Description",
      "",
      "Build agentic workflow prototypes with customers and turn them into deployed tools.",
    ].join("\n")
  );
  const questionsPath = writeWorkspaceFile(
    repoRoot,
    "jobs/acme-applied-ai-engineer.questions.json",
    JSON.stringify(
      {
        source: "manual",
        questions: [
          {
            id: "q1",
            label: "Why are you interested in building agentic workflows at Acme AI?",
            type: "text",
            required: true,
          },
        ],
        excluded: [],
      },
      null,
      2
    )
  );

  importTrackerFixture(repoRoot, [
    {
      id: "app-packet",
      company: "Acme AI",
      role: "Applied AI Engineer",
      status: "reviewed-hold",
      fitBasis: "evaluated",
      fitBucket: "high",
      artifacts: {
        jd: jdPath,
        packetQuestionsSource: questionsPath,
        packetQuestionsCapturedAt: "2026-07-06T13:00:00Z",
        packetQuestionCount: 1,
        packetQuestionExcludedCount: 0,
      },
    },
  ]);
}

function readApp(repoRoot, id) {
  const db = openDb({ repoRoot, env: {} });
  const row = db.prepare("SELECT data FROM applications WHERE id = ?").get(id);
  return row ? JSON.parse(row.data) : null;
}

function bootServer(repoRoot, opts = {}) {
  const routes = new Map();
  function addRoute(method, path, handler) {
    routes.set(`${method} ${path}`, handler);
  }
  mountPacketRoutes({ addRoute, repoRoot, env: {}, ...opts });

  const server = createServer((req, res) => {
    const url = (req.url || "/").split("?")[0];
    const route = routes.get(`${req.method} ${url}`);
    if (!route) {
      res.writeHead(404).end();
      return;
    }
    route(req, res);
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve(server));
  });
}

function baseUrl(server) {
  const { port } = server.address();
  return `http://127.0.0.1:${port}`;
}

function closeServer(server) {
  return new Promise((resolve) => server.close(resolve));
}

async function postJson(server, path, payload) {
  const res = await fetch(`${baseUrl(server)}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  const body = await res.json().catch(() => ({}));
  return { status: res.status, body };
}

async function postRaw(server, path, bodyText) {
  const res = await fetch(`${baseUrl(server)}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: bodyText,
  });
  const body = await res.json().catch(() => ({}));
  return { status: res.status, body };
}

after(() => {
  closeAll();
  for (const root of cleanupRoots.splice(0)) {
    try {
      rmSync(root, { recursive: true, force: true });
    } catch {
      // best-effort cleanup
    }
  }
});

test("POST /api/packet/gate: 409 when SQLite has not been initialized", async () => {
  const repoRoot = tempRepo();
  const server = await bootServer(repoRoot);
  try {
    const { status, body } = await postJson(server, "/api/packet/gate", {
      appId: "app-packet",
    });
    assert.equal(status, 409);
    assert.match(body.error?.message || body.error || "", /database|data import|data init/i);
  } finally {
    await closeServer(server);
  }
});

test("POST /api/packet/gate: malformed JSON is a local 400, not a skill-runtime handoff", async () => {
  const repoRoot = tempRepo();
  seedPacketReadyApp(repoRoot);
  const server = await bootServer(repoRoot);
  try {
    const { status, body } = await postRaw(server, "/api/packet/gate", "{");
    assert.equal(status, 400);
    assert.equal(body.code, "BAD_REQUEST");
    assert.doesNotMatch(JSON.stringify(body), /\/api\/skill\/run|evaluate-job/);
  } finally {
    await closeServer(server);
  }
});

test("POST /api/packet/generate: stamps packet source/export artifacts through DB without tracker input", async () => {
  const repoRoot = tempRepo();
  seedPacketReadyApp(repoRoot);
  assert.equal(
    existsSync(join(repoRoot, "workspace/tracker.json")),
    false,
    "generated tracker export must not be required before packet generation"
  );

  const server = await bootServer(repoRoot);
  try {
    const { status, body } = await postJson(server, "/api/packet/generate", {
      appId: "app-packet",
      applyIntent: true,
      formats: ["pdf"],
    });
    assert.equal(status, 200);
    assert.equal(body.ok, true);
    assert.equal(body.data?.appId, "app-packet");
    assert.notEqual(body.data?.submitted, true, "packet generation prepares files only");

    const app = readApp(repoRoot, "app-packet");
    const artifacts = app?.artifacts || {};
    for (const key of [
      "packetManifest",
      "resumeSource",
      "coverLetterSource",
      "answersSource",
      "resumePdf",
      "coverLetterPdf",
      "answersPdf",
    ]) {
      assert.match(
        String(artifacts[key] || ""),
        /^workspace\//,
        `${key} should be workspace-stamped`
      );
      assert.ok(
        existsSync(join(repoRoot, artifacts[key].replace(/^workspace\//, "workspace/"))),
        `${key} should point at a local artifact file`
      );
    }
    assert.equal(artifacts.resumeDocx ?? null, null, "DOCX should not be generated by default");
    assert.equal(
      artifacts.coverLetterDocx ?? null,
      null,
      "cover-letter DOCX should not be generated by default"
    );
  } finally {
    await closeServer(server);
  }
});
