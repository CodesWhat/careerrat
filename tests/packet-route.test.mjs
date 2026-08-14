// tests/packet-route.test.mjs
// node:test suite for the M4 /packet view's HTTP layer
// (src/cli/packet-route.mjs) — GET /api/packet/list, GET /api/packet?id=.
// Mirrors tests/search-route.test.mjs's bootServer(): a bare addRoute Map
// wrapped in http.createServer, no full tracker-dev.mjs dev server needed.
// Fixtures seed SQLite from fixture-source/tracker.json while preserving
// workspace/tailored/*.md directly under repoRoot. The packet route must not
// read workspace/tracker.json as product state, so this suite asserts the
// runtime workspace has no generated tracker export.

import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, test } from "node:test";
import { mountPacketRoutes } from "../src/cli/packet-route.mjs";
import { closeAll } from "../src/core/db/connection.mjs";
import { importFromTracker } from "../src/core/db/import-from-tracker.mjs";

const cleanupRoots = [];

function tempRepo() {
  const repoRoot = mkdtempSync(join(tmpdir(), "careerrat-packet-route-"));
  cleanupRoots.push(repoRoot);
  mkdirSync(join(repoRoot, "workspace/tailored"), { recursive: true });
  return repoRoot;
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
    "packet tests must seed DB rows without creating a generated tracker export"
  );
}

function writeArtifact(repoRoot, relPathUnderWorkspace, content) {
  const full = join(repoRoot, "workspace", relPathUnderWorkspace);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, content, "utf8");
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

async function getJson(server, path) {
  const res = await fetch(`${baseUrl(server)}${path}`);
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

// A standard fixture set exercised by most tests below:
//   app-1  reviewed-hold, no artifacts yet             → gated in (status), Generate offered
//   app-2  interview, full artifact set incl. NEEDS YOU → gated in, needsYouCount 1
//   app-3  rejected, no artifacts                       → NOT gated in (terminal + no artifacts)
//   app-4  withdrawn, but has a resume artifact          → gated in (artifacts win over terminal status)
//   app-5  reviewed-hold, resume path is a traversal attempt → gated in, but resume resolves to null
//   app-6  interview, cover letter stamped as inline text (no file on disk) → coverLetter served as markdown directly
function seedStandardFixture(repoRoot) {
  writeArtifact(
    repoRoot,
    "tailored/Globex — Director of IT.md",
    "# Globex — Director of IT\n\nTailored resume body.\n"
  );
  writeArtifact(
    repoRoot,
    "tailored/Globex — Director of IT — cover-letter.md",
    "Dear Hiring Team,\n\nI would love to join Globex.\n"
  );
  writeArtifact(
    repoRoot,
    "tailored/Globex — Director of IT — answers.md",
    "## Are you authorized to work in the US?\n\nYes.\n\n" +
      "## Expected clearance level\n\nNEEDS YOU: confirm current clearance level\n"
  );
  writeArtifact(
    repoRoot,
    "tailored/Hooli — SRE.md",
    "# Hooli — SRE\n\nWithdrawn but still on file.\n"
  );

  importTrackerFixture(repoRoot, [
    {
      id: "app-1",
      company: "Acme",
      role: "Staff Engineer",
      status: "reviewed-hold",
      artifacts: {},
      packetManifest: {
        applicationId: "app-1",
        generatedAt: "2026-07-06T14:00:00Z",
        uploadReady: false,
        status: "reviewable",
        gapCount: 1,
        gaps: [
          {
            kind: "answers",
            message: "answers artifact skipped — no application questions captured yet",
          },
        ],
        artifacts: {},
      },
    },
    {
      id: "app-2",
      company: "Globex",
      role: "Director of IT",
      status: "interview",
      artifacts: {
        resume: "workspace/tailored/Globex — Director of IT.md",
        coverLetter: "workspace/tailored/Globex — Director of IT — cover-letter.md",
        answers: "workspace/tailored/Globex — Director of IT — answers.md",
        resumeNote: "Led with the platform-migration story.",
      },
    },
    { id: "app-3", company: "Initech", role: "PM", status: "rejected", artifacts: {} },
    {
      id: "app-4",
      company: "Hooli",
      role: "SRE",
      status: "withdrawn",
      artifacts: { resume: "workspace/tailored/Hooli — SRE.md" },
    },
    {
      id: "app-5",
      company: "Evil Corp",
      role: "Analyst",
      status: "reviewed-hold",
      artifacts: { resume: "workspace/tailored/../../../../etc/passwd.md" },
    },
    {
      id: "app-6",
      company: "Umbrella",
      role: "Coordinator",
      status: "interview",
      artifacts: { coverLetter: "Dear Umbrella,\n\nInline text, never written to disk.\n" },
    },
  ]);
}

// ---------------------------------------------------------------------------
// GET /api/packet/list
// ---------------------------------------------------------------------------

test("GET /api/packet/list: only gated-in applications, with presence booleans and needsYouCount", async () => {
  const repoRoot = tempRepo();
  seedStandardFixture(repoRoot);
  const server = await bootServer(repoRoot);
  try {
    const { status, body } = await getJson(server, "/api/packet/list");
    assert.equal(status, 200);
    const ids = body.map((r) => r.id);
    assert.deepEqual(ids.sort(), ["app-1", "app-2", "app-4", "app-5", "app-6"]);
    assert.ok(!ids.includes("app-3"), "rejected + no-artifacts application must be excluded");

    const app1 = body.find((r) => r.id === "app-1");
    assert.deepEqual(app1, {
      id: "app-1",
      company: "Acme",
      role: "Staff Engineer",
      status: "reviewed-hold",
      hasResume: false,
      hasCoverLetter: false,
      hasAnswers: false,
      needsYouCount: 0,
    });

    const app2 = body.find((r) => r.id === "app-2");
    assert.equal(app2.hasResume, true);
    assert.equal(app2.hasCoverLetter, true);
    assert.equal(app2.hasAnswers, true);
    assert.equal(app2.needsYouCount, 1);

    const app4 = body.find((r) => r.id === "app-4");
    assert.equal(app4.status, "withdrawn");
    assert.equal(app4.hasResume, true);
  } finally {
    await closeServer(server);
  }
});

test("GET /api/packet/list: 409 when no database exists yet", async () => {
  const repoRoot = tempRepo();
  const server = await bootServer(repoRoot);
  try {
    const { status, body } = await getJson(server, "/api/packet/list");
    assert.equal(status, 409);
    assert.match(body.error, /database/i);
    assert.match(body.error, /data import|data init|setup/i);
  } finally {
    await closeServer(server);
  }
});

// ---------------------------------------------------------------------------
// GET /api/packet?id=
// ---------------------------------------------------------------------------

test("GET /api/packet?id=: resolves resume/coverLetter/answers to {path, markdown, html}", async () => {
  const repoRoot = tempRepo();
  seedStandardFixture(repoRoot);
  const server = await bootServer(repoRoot);
  try {
    const { status, body } = await getJson(server, "/api/packet?id=app-2");
    assert.equal(status, 200);
    assert.equal(body.company, "Globex");
    assert.equal(body.role, "Director of IT");
    assert.equal(body.resumeNote, "Led with the platform-migration story.");

    assert.equal(body.artifacts.resume.path, "workspace/tailored/Globex — Director of IT.md");
    assert.match(body.artifacts.resume.markdown, /Tailored resume body\./);
    assert.match(body.artifacts.resume.html, /<h1>Globex — Director of IT<\/h1>/);

    assert.equal(
      body.artifacts.coverLetter.path,
      "workspace/tailored/Globex — Director of IT — cover-letter.md"
    );
    assert.match(body.artifacts.coverLetter.html, /<p>/);

    assert.ok(Array.isArray(body.artifacts.answers.needsYou));
    assert.equal(body.artifacts.answers.needsYou.length, 1);
    assert.match(body.artifacts.answers.needsYou[0].text, /NEEDS YOU/);
    assert.equal(typeof body.artifacts.answers.needsYou[0].line, "number");
  } finally {
    await closeServer(server);
  }
});

test("GET /api/packet?id=: PDF artifacts return binary link metadata, not decoded markdown", async () => {
  const repoRoot = tempRepo();
  writeArtifact(repoRoot, "tailored/Acme — Staff Engineer.pdf", "%PDF-1.4\nfake pdf body\n");
  importTrackerFixture(repoRoot, [
    {
      id: "app-pdf",
      company: "Acme",
      role: "Staff Engineer",
      status: "reviewed-hold",
      artifacts: {
        resume: "workspace/tailored/Acme — Staff Engineer.pdf",
      },
    },
  ]);
  const server = await bootServer(repoRoot);
  try {
    const { status, body } = await getJson(server, "/api/packet?id=app-pdf");
    assert.equal(status, 200);
    assert.equal(body.artifacts.resume.path, "workspace/tailored/Acme — Staff Engineer.pdf");
    assert.equal(body.artifacts.resume.markdown, null);
    assert.equal(body.artifacts.resume.html, null);
    assert.equal(body.artifacts.resume.binary, true);
    assert.equal(body.artifacts.resume.kind, "pdf");
    assert.equal(body.artifacts.resume.url, "/api/packet/artifact?id=app-pdf&kind=resume");

    const artifact = await fetch(`${baseUrl(server)}${body.artifacts.resume.url}`);
    assert.equal(artifact.status, 200);
    assert.match(artifact.headers.get("content-type") || "", /application\/pdf/);
    assert.match(await artifact.text(), /^%PDF-1\.4/);

    const missingKind = await fetch(
      `${baseUrl(server)}/api/packet/artifact?id=app-pdf&kind=coverLetter`
    );
    assert.equal(missingKind.status, 404);

    const rawPath = await fetch(
      `${baseUrl(server)}/api/packet/artifact?path=${encodeURIComponent("workspace/tailored/Acme — Staff Engineer.pdf")}`
    );
    assert.equal(rawPath.status, 400);
  } finally {
    await closeServer(server);
  }
});

test("GET /api/packet/artifact: 409 when no database exists yet", async () => {
  const repoRoot = tempRepo();
  writeArtifact(repoRoot, "tailored/Acme — Staff Engineer.pdf", "%PDF-1.4\nfake pdf body\n");
  const server = await bootServer(repoRoot);
  try {
    const res = await fetch(`${baseUrl(server)}/api/packet/artifact?id=app-pdf&kind=resume`);
    assert.equal(res.status, 409);
    assert.match((await res.json()).error, /database/i);
  } finally {
    await closeServer(server);
  }
});

test("GET /api/packet?id=: missing artifacts serve as null (never generated)", async () => {
  const repoRoot = tempRepo();
  seedStandardFixture(repoRoot);
  const server = await bootServer(repoRoot);
  try {
    const { status, body } = await getJson(server, "/api/packet?id=app-1");
    assert.equal(status, 200);
    assert.equal(body.artifacts.resume, null);
    assert.equal(body.artifacts.coverLetter, null);
    assert.equal(body.artifacts.answers, null);
    assert.deepEqual(body.packet, {
      uploadReady: false,
      status: "reviewable",
      gapCount: 1,
      gaps: [
        {
          kind: "answers",
          message: "answers artifact skipped — no application questions captured yet",
        },
      ],
    });
  } finally {
    await closeServer(server);
  }
});

test("GET /api/packet?id=: an inline-text stamped artifact (no file on disk) is served directly as markdown", async () => {
  const repoRoot = tempRepo();
  seedStandardFixture(repoRoot);
  const server = await bootServer(repoRoot);
  try {
    const { status, body } = await getJson(server, "/api/packet?id=app-6");
    assert.equal(status, 200);
    assert.equal(body.artifacts.coverLetter.path, null);
    assert.match(body.artifacts.coverLetter.markdown, /Inline text, never written to disk\./);
    assert.match(body.artifacts.coverLetter.html, /<p>/);
  } finally {
    await closeServer(server);
  }
});

test("GET /api/packet?id=: a path-traversal artifact value resolves to null, not the escaped file", async () => {
  const repoRoot = tempRepo();
  seedStandardFixture(repoRoot);
  const server = await bootServer(repoRoot);
  try {
    const { status, body } = await getJson(server, "/api/packet?id=app-5");
    assert.equal(status, 200);
    assert.equal(body.artifacts.resume, null);
  } finally {
    await closeServer(server);
  }
});

test("GET /api/packet?id=: 404 for an unknown application id", async () => {
  const repoRoot = tempRepo();
  seedStandardFixture(repoRoot);
  const server = await bootServer(repoRoot);
  try {
    const { status, body } = await getJson(server, "/api/packet?id=does-not-exist");
    assert.equal(status, 404);
    assert.match(body.error, /does-not-exist/);
  } finally {
    await closeServer(server);
  }
});

test("GET /api/packet: 400 when ?id= is missing", async () => {
  const repoRoot = tempRepo();
  seedStandardFixture(repoRoot);
  const server = await bootServer(repoRoot);
  try {
    const { status, body } = await getJson(server, "/api/packet");
    assert.equal(status, 400);
    assert.match(body.error, /id/);
  } finally {
    await closeServer(server);
  }
});

test("GET /api/packet?id=: 409 when no database exists yet", async () => {
  const repoRoot = tempRepo();
  const server = await bootServer(repoRoot);
  try {
    const { status, body } = await getJson(server, "/api/packet?id=app-1");
    assert.equal(status, 409);
    assert.match(body.error, /database/i);
    assert.match(body.error, /data import|data init|setup/i);
  } finally {
    await closeServer(server);
  }
});
