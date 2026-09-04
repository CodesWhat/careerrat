// tests/packet-export.test.mjs
// RED contracts for Phase 10 Wave 0: packet-specific export orchestration.
// These tests intentionally fail until src/core/packet/exports.mjs exists.

import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { after, test } from "node:test";
import JSZip from "jszip";
import { mountPacketRoutes } from "../src/cli/packet-route.mjs";
import { executeWorkspaceIntent } from "../src/core/agent/workspace-agent.mjs";
import { closeAll, openDb } from "../src/core/db/connection.mjs";
import { importFromTracker } from "../src/core/db/import-from-tracker.mjs";
import { dispatchHttpRoute } from "../src/core/tracker/route-dispatch.mjs";

const cleanupRoots = [];

function tempRepo() {
  const repoRoot = mkdtempSync(join(tmpdir(), "careerrat-packet-export-"));
  cleanupRoots.push(repoRoot);
  mkdirSync(join(repoRoot, "workspace/tailored"), { recursive: true });
  return repoRoot;
}

// exportPacketArtifacts now also copies rendered resume/cover-letter PDFs to
// a Downloads convenience folder (tailor-application SKILL.md STEP 11b).
// CAREERRAT_DOWNLOADS_DIR redirects that away from the real OS home so these
// tests never write into the machine's actual ~/Downloads.
function tempDownloadsEnv() {
  const dir = mkdtempSync(join(tmpdir(), "careerrat-packet-downloads-"));
  cleanupRoots.push(dir);
  return { CAREERRAT_DOWNLOADS_DIR: dir };
}

function writeWorkspaceFile(repoRoot, relPath, content) {
  const full = join(repoRoot, "workspace", relPath);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, content, "utf8");
  return `workspace/${relPath}`;
}

function seedPacketSources(repoRoot, suffix = "acme-staff-engineer") {
  const resumeSource = writeWorkspaceFile(
    repoRoot,
    `tailored/${suffix}-resume.md`,
    "# Acme Staff Engineer\n\nEvidence-backed resume body.\n"
  );
  const coverLetterSource = writeWorkspaceFile(
    repoRoot,
    `tailored/${suffix}-cover-letter.md`,
    "Dear Hiring Team,\n\nEvidence-backed cover-letter body.\n"
  );
  const answersSource = writeWorkspaceFile(
    repoRoot,
    `tailored/${suffix}-answers.md`,
    "## Why Acme?\n\nBecause the evidence supports it.\n"
  );
  const packetManifest = writeWorkspaceFile(
    repoRoot,
    `tailored/${suffix}-packet-manifest.json`,
    JSON.stringify(
      {
        appId: "app-export",
        generatedAt: "2026-07-06T14:00:00Z",
        uploadReady: true,
        questions: [],
      },
      null,
      2
    )
  );
  return { answersSource, coverLetterSource, packetManifest, resumeSource };
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
    "packet export tests seed SQLite directly and must not depend on generated tracker exports"
  );
}

function seedApp(repoRoot, artifacts = {}) {
  importTrackerFixture(repoRoot, [
    {
      id: "app-export",
      company: "Acme",
      role: "Staff Engineer",
      status: "reviewed-hold",
      artifacts,
    },
  ]);
}

function readApp(repoRoot, id = "app-export") {
  const db = openDb({ repoRoot, env: {} });
  const row = db.prepare("SELECT data FROM applications WHERE id = ?").get(id);
  return row ? JSON.parse(row.data) : null;
}

function workspaceRel(repoRoot, absPath) {
  return relative(repoRoot, absPath).replaceAll("\\", "/");
}

function fakeExporter(calls) {
  return async ({ markdown, outBase, formats, title, ats }) => {
    calls.push({ ats, formats: [...formats], markdown, outBase, title });
    const result = {};
    if (formats.includes("pdf")) {
      const pdfPath = `${outBase}.pdf`;
      mkdirSync(dirname(pdfPath), { recursive: true });
      writeFileSync(pdfPath, "%PDF-1.4\nfake packet pdf\n%%EOF\n", "utf8");
      result.pdf = pdfPath;
    }
    if (formats.includes("docx")) {
      const docxPath = `${outBase}.docx`;
      mkdirSync(dirname(docxPath), { recursive: true });
      const zip = new JSZip();
      zip.file("[Content_Types].xml", "<Types />");
      zip.file("word/document.xml", "<w:document />");
      writeFileSync(docxPath, await zip.generateAsync({ type: "nodebuffer" }));
      result.docx = docxPath;
      result.docxTool = "test-double";
      result.docxLabel = "test double";
    }
    if (formats.includes("text")) {
      const textPath = `${outBase}.txt`;
      mkdirSync(dirname(textPath), { recursive: true });
      writeFileSync(textPath, "fake packet plain text\n", "utf8");
      result.text = textPath;
    }
    return result;
  };
}

function bootPacketServer(repoRoot, opts = {}) {
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
    dispatchHttpRoute(route, req, res);
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

async function importPacketExports() {
  return import("../src/core/packet/exports.mjs");
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

test("exportPacketArtifacts defaults to ATS-safe PDFs and keeps markdown sources internal", async () => {
  const repoRoot = tempRepo();
  const sources = seedPacketSources(repoRoot);
  seedApp(repoRoot, sources);
  const calls = [];
  const { exportPacketArtifacts } = await importPacketExports();
  const downloadsEnv = tempDownloadsEnv();

  const result = await exportPacketArtifacts({
    repoRoot,
    env: downloadsEnv,
    appId: "app-export",
    packetSources: sources,
    exportArtifact: fakeExporter(calls),
    now: () => new Date("2026-07-06T15:00:00Z"),
  });

  assert.equal(calls.length, 3, "resume, cover letter, and answers should each export once");
  for (const call of calls) {
    assert.deepEqual(call.formats, ["pdf"]);
    assert.equal(call.ats, true, "packet PDF exports should use ATS-safe rendering");
  }

  const artifacts = readApp(repoRoot).artifacts;
  assert.equal(artifacts.resumeSource, sources.resumeSource);
  assert.equal(artifacts.coverLetterSource, sources.coverLetterSource);
  assert.equal(artifacts.answersSource, sources.answersSource);
  assert.match(artifacts.resumePdf, /^workspace\/tailored\/.+\.pdf$/);
  assert.match(artifacts.coverLetterPdf, /^workspace\/tailored\/.+\.pdf$/);
  assert.match(artifacts.answersPdf, /^workspace\/tailored\/.+\.pdf$/);
  assert.equal(artifacts.resumeDocx ?? null, null);
  assert.equal(artifacts.coverLetterDocx ?? null, null);
  assert.equal(artifacts.answersDocx ?? null, null);

  assert.deepEqual(
    result.userFacing.resume.map((file) => file.format),
    ["pdf"]
  );
  assert.equal(
    result.userFacing.resume.some((file) => file.format === "markdown"),
    false,
    "source markdown is tracked internally but not returned as the normal user-facing export"
  );
  const resumeDownload = join(downloadsEnv.CAREERRAT_DOWNLOADS_DIR, "Acme", "Acme - Resume.pdf");
  const coverDownload = join(
    downloadsEnv.CAREERRAT_DOWNLOADS_DIR,
    "Acme",
    "Acme - Cover Letter.pdf"
  );
  assert.equal(result.userFacing.resume[0].downloadsPath, resumeDownload);
  assert.equal(result.userFacing.coverLetter[0].downloadsPath, coverDownload);
  assert.equal(existsSync(resumeDownload), true);
  assert.equal(existsSync(coverDownload), true);
  assert.equal(
    result.userFacing.answers[0].downloadsPath ?? null,
    null,
    "answers PDFs are workspace artifacts only"
  );
  assert.equal(
    existsSync(join(downloadsEnv.CAREERRAT_DOWNLOADS_DIR, "Acme", "Acme - Answers.pdf")),
    false
  );
});

test("exportPacketArtifacts preserves generation readiness and gaps", async () => {
  const repoRoot = tempRepo();
  const sources = seedPacketSources(repoRoot, "northstar-staff-platform-engineer");
  importTrackerFixture(repoRoot, [
    {
      id: "app-export",
      company: "Northstar",
      role: "Staff Platform Engineer",
      status: "reviewed-hold",
      artifacts: sources,
      packetManifest: {
        applicationId: "app-export",
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
        artifacts: sources,
      },
    },
  ]);
  const { exportPacketArtifacts } = await importPacketExports();

  await exportPacketArtifacts({
    repoRoot,
    env: tempDownloadsEnv(),
    appId: "app-export",
    exportArtifact: fakeExporter([]),
    now: () => new Date("2026-07-06T15:00:00Z"),
  });

  const manifest = readApp(repoRoot).packetManifest;
  assert.equal(manifest.generatedAt, "2026-07-06T14:00:00Z");
  assert.equal(manifest.exportedAt, "2026-07-06T15:00:00.000Z");
  assert.equal(manifest.uploadReady, false);
  assert.equal(manifest.status, "reviewable");
  assert.equal(manifest.gapCount, 1);
  assert.equal(manifest.gaps.length, 1);
});

test("exportPacketArtifacts clears upload readiness when the document exporter produces no files", async () => {
  const repoRoot = tempRepo();
  const sources = seedPacketSources(repoRoot, "missing-exports");
  importTrackerFixture(repoRoot, [
    {
      id: "app-export",
      company: "Acme",
      role: "Staff Engineer",
      status: "reviewed-hold",
      artifacts: sources,
      packetManifest: {
        applicationId: "app-export",
        generatedAt: "2026-07-06T14:00:00Z",
        uploadReady: true,
        status: "upload-ready",
        gapCount: 0,
        gaps: [],
        artifacts: sources,
      },
    },
  ]);
  const { exportPacketArtifacts } = await importPacketExports();

  const result = await exportPacketArtifacts({
    repoRoot,
    env: tempDownloadsEnv(),
    appId: "app-export",
    exportArtifact: async () => ({}),
    now: () => new Date("2026-07-06T15:00:00Z"),
  });

  const manifest = readApp(repoRoot).packetManifest;
  assert.equal(result.artifacts.resumePdf ?? null, null);
  assert.equal(manifest.uploadReady, false);
  assert.equal(manifest.status, "reviewable");
  assert.equal(manifest.gapCount, 3);
  assert.deepEqual(
    manifest.gaps.map((gap) => gap.code),
    ["ARTIFACT_EXPORT_FAILED", "ARTIFACT_EXPORT_FAILED", "ARTIFACT_EXPORT_FAILED"]
  );
});

test("a successful re-export clears transient export gaps and restores prior generation readiness", async () => {
  const repoRoot = tempRepo();
  const sources = seedPacketSources(repoRoot, "retry-exports");
  importTrackerFixture(repoRoot, [
    {
      id: "app-export",
      company: "Acme",
      role: "Staff Engineer",
      status: "reviewed-hold",
      artifacts: sources,
      packetManifest: {
        applicationId: "app-export",
        generatedAt: "2026-07-06T14:00:00Z",
        uploadReady: true,
        status: "upload-ready",
        gapCount: 0,
        gaps: [],
        artifacts: sources,
      },
    },
  ]);
  const { exportPacketArtifacts } = await importPacketExports();
  const env = tempDownloadsEnv();

  await exportPacketArtifacts({
    repoRoot,
    env,
    appId: "app-export",
    exportArtifact: async () => ({}),
  });
  assert.equal(readApp(repoRoot).packetManifest.uploadReady, false);

  await exportPacketArtifacts({
    repoRoot,
    env,
    appId: "app-export",
    exportArtifact: fakeExporter([]),
  });

  const manifest = readApp(repoRoot).packetManifest;
  assert.equal(manifest.uploadReady, true);
  assert.equal(manifest.status, "upload-ready");
  assert.equal(manifest.gapCount, 0);
  assert.deepEqual(manifest.gaps, []);
});

test("exportPacketArtifacts archives a prior same-named Downloads PDF on re-export", async () => {
  const repoRoot = tempRepo();
  const sources = seedPacketSources(repoRoot);
  seedApp(repoRoot, sources);
  const downloadsEnv = tempDownloadsEnv();
  const { exportPacketArtifacts } = await importPacketExports();

  await exportPacketArtifacts({
    repoRoot,
    env: downloadsEnv,
    appId: "app-export",
    packetSources: { resumeSource: sources.resumeSource },
    exportArtifact: fakeExporter([]),
  });
  const live = join(downloadsEnv.CAREERRAT_DOWNLOADS_DIR, "Acme", "Acme - Resume.pdf");
  writeFileSync(live, "%PDF-1.4\nprior export marker\n", "utf8");

  await exportPacketArtifacts({
    repoRoot,
    env: downloadsEnv,
    appId: "app-export",
    packetSources: { resumeSource: sources.resumeSource },
    exportArtifact: fakeExporter([]),
  });

  const archived = join(
    downloadsEnv.CAREERRAT_DOWNLOADS_DIR,
    "Acme",
    "archive",
    "Acme - Resume.pdf"
  );
  assert.equal(existsSync(archived), true);
  assert.match(readFileSync(archived, "utf8"), /prior export marker/);
  assert.doesNotMatch(readFileSync(live, "utf8"), /prior export marker/);
});

test("exportPacketArtifacts reports Downloads copy failures without failing workspace export", async () => {
  const repoRoot = tempRepo();
  const sources = seedPacketSources(repoRoot);
  seedApp(repoRoot, sources);
  const blockedRoot = join(tempRepo(), "not-a-directory");
  writeFileSync(blockedRoot, "file blocks directory creation", "utf8");
  const { exportPacketArtifacts } = await importPacketExports();

  const result = await exportPacketArtifacts({
    repoRoot,
    env: { CAREERRAT_DOWNLOADS_DIR: blockedRoot },
    appId: "app-export",
    packetSources: { resumeSource: sources.resumeSource },
    exportArtifact: fakeExporter([]),
  });

  assert.match(result.artifacts.resumePdf, /^workspace\/tailored\/.+\.pdf$/);
  assert.equal(result.userFacing.resume.length, 1);
  assert.equal(result.userFacing.resume[0].downloadsPath ?? null, null);
  assert.equal(result.downloadsErrors.length, 1);
  assert.deepEqual(
    { kind: result.downloadsErrors[0].kind, format: result.downloadsErrors[0].format },
    { kind: "resume", format: "pdf" }
  );
});

test("exportPacketArtifacts generates DOCX only for explicit selection or captured upload requirement", async () => {
  const cases = [
    {
      name: "default",
      request: {},
      uploadRequirements: [],
      expectedFormats: ["pdf"],
    },
    {
      // A nonempty supported-formats request is authoritative: it replaces
      // the default rather than adding to it, so an explicit docx-only
      // request stays docx-only instead of always dragging a PDF along.
      name: "explicit docx",
      request: { formats: ["docx"] },
      uploadRequirements: [],
      expectedFormats: ["docx"],
    },
    {
      name: "captured board requirement",
      request: {},
      uploadRequirements: [{ field: "resume", formats: ["docx"], required: true }],
      expectedFormats: ["pdf", "docx"],
    },
  ];

  for (const entry of cases) {
    const repoRoot = tempRepo();
    const sources = seedPacketSources(repoRoot, entry.name.replaceAll(" ", "-"));
    seedApp(repoRoot, sources);
    const calls = [];
    const { exportPacketArtifacts } = await importPacketExports();

    await exportPacketArtifacts({
      repoRoot,
      env: tempDownloadsEnv(),
      appId: "app-export",
      packetSources: { resumeSource: sources.resumeSource },
      request: entry.request,
      uploadRequirements: entry.uploadRequirements,
      exportArtifact: fakeExporter(calls),
      now: () => new Date("2026-07-06T15:00:00Z"),
    });

    assert.equal(calls.length, 1, `${entry.name}: only the provided resume source exports`);
    assert.deepEqual(calls[0].formats, entry.expectedFormats, entry.name);

    const artifacts = readApp(repoRoot).artifacts;
    if (entry.expectedFormats.includes("pdf")) {
      assert.match(artifacts.resumePdf, /^workspace\/tailored\/.+\.pdf$/);
    } else {
      assert.equal(artifacts.resumePdf ?? null, null);
    }
    if (entry.expectedFormats.includes("docx")) {
      assert.match(artifacts.resumeDocx, /^workspace\/tailored\/.+\.docx$/);
    } else {
      assert.equal(artifacts.resumeDocx ?? null, null);
    }
  }
});

test("exportPacketArtifacts generates plain text only when explicitly requested, with no PDF fan-out", async () => {
  // Regression for the round-three finding: a nonempty supported-formats
  // request used to always get "pdf" seeded in ahead of it, so a
  // text-only request rendered (and copied to Downloads) a PDF nobody
  // asked for. requestedFormats() must treat the request as authoritative.
  const repoRoot = tempRepo();
  const sources = seedPacketSources(repoRoot);
  seedApp(repoRoot, sources);
  const calls = [];
  const downloadsEnv = tempDownloadsEnv();
  const { exportPacketArtifacts } = await importPacketExports();

  const result = await exportPacketArtifacts({
    repoRoot,
    env: downloadsEnv,
    appId: "app-export",
    packetSources: { resumeSource: sources.resumeSource },
    request: { formats: ["text"] },
    exportArtifact: fakeExporter(calls),
    now: () => new Date("2026-07-06T15:00:00Z"),
  });

  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].formats, ["text"], "no PDF format was requested from the renderer");

  const artifacts = readApp(repoRoot).artifacts;
  assert.equal(artifacts.resumePdf ?? null, null, "no PDF artifact was produced");
  assert.match(artifacts.resumeText, /^workspace\/tailored\/.+\.txt$/);
  assert.equal(artifacts.resumeDocx ?? null, null);
  assert.equal(
    result.userFacing.resume.some((entry) => entry.format === "text"),
    true
  );
  assert.equal(
    result.userFacing.resume.some((entry) => entry.format === "pdf"),
    false,
    "no pdf entry in the user-facing export list"
  );
  assert.equal((result.downloadsErrors || []).length, 0);
  assert.deepEqual(
    readdirSync(downloadsEnv.CAREERRAT_DOWNLOADS_DIR),
    [],
    "a text-only export never copies anything to Downloads"
  );
});

test("exportPacketArtifacts picks a distinct output base instead of overwriting a .txt source with its own text export", async () => {
  // Regression: a stored source path can itself be a .txt file (e.g.
  // resume.txt). Extension-stripping that to an outBase and exporting
  // "text" would rename the render onto resume.txt itself, destroying the
  // canonical source. The export must detect the collision and pick a
  // distinct base.
  const repoRoot = tempRepo();
  const originalContent = "# Acme Staff Engineer\n\nEvidence-backed resume body.\n";
  const resumeSource = writeWorkspaceFile(repoRoot, "tailored/acme-resume.txt", originalContent);
  const packetManifest = writeWorkspaceFile(
    repoRoot,
    "tailored/acme-packet-manifest.json",
    JSON.stringify(
      {
        appId: "app-export",
        generatedAt: "2026-07-06T14:00:00Z",
        uploadReady: true,
        questions: [],
      },
      null,
      2
    )
  );
  seedApp(repoRoot, { resumeSource, packetManifest });
  const calls = [];
  const { exportPacketArtifacts } = await importPacketExports();

  await exportPacketArtifacts({
    repoRoot,
    env: tempDownloadsEnv(),
    appId: "app-export",
    packetSources: { resumeSource },
    request: { formats: ["text"] },
    exportArtifact: fakeExporter(calls),
    now: () => new Date("2026-07-06T15:00:00Z"),
  });

  const sourceAbsPath = join(repoRoot, resumeSource);
  assert.equal(
    readFileSync(sourceAbsPath, "utf8"),
    originalContent,
    "the .txt source is untouched, byte-for-byte"
  );

  assert.equal(calls.length, 1);
  assert.notEqual(
    `${calls[0].outBase}.txt`,
    sourceAbsPath,
    "the export destination is distinct from the source path"
  );

  const artifacts = readApp(repoRoot).artifacts;
  assert.match(artifacts.resumeText, /^workspace\/tailored\/.+\.txt$/);
  assert.notEqual(
    artifacts.resumeText,
    resumeSource,
    "the exported text artifact is not the source itself"
  );
});

test("appRegisterPacketArtifacts stamps source and export fields through the DB-owned write path", async () => {
  const repoRoot = tempRepo();
  const sources = seedPacketSources(repoRoot);
  seedApp(repoRoot);
  const { appRegisterPacketArtifacts } = await importPacketExports();

  const pdfPath = writeWorkspaceFile(repoRoot, "tailored/acme-staff-engineer-resume.pdf", "%PDF");
  const docxPath = writeWorkspaceFile(repoRoot, "tailored/acme-staff-engineer-resume.docx", "DOCX");

  const result = await appRegisterPacketArtifacts({
    repoRoot,
    env: {},
    appId: "app-export",
    artifacts: {
      packetManifest: sources.packetManifest,
      resume: sources.resumeSource,
      resumeDocx: docxPath,
      resumeGeneratedAt: "2026-07-06T15:00:00.000Z",
      resumePdf: pdfPath,
      resumeSource: sources.resumeSource,
    },
    now: () => new Date("2026-07-06T15:00:00Z"),
  });

  const app = readApp(repoRoot);
  assert.equal(app.artifacts.packetManifest, sources.packetManifest);
  assert.equal(app.artifacts.resumeSource, sources.resumeSource);
  assert.equal(app.artifacts.resume, sources.resumeSource);
  assert.equal(app.artifacts.resumeGeneratedAt, "2026-07-06T15:00:00.000Z");
  assert.equal(app.artifacts.resumePdf, pdfPath);
  assert.equal(app.artifacts.resumeDocx, docxPath);
  assert.equal(result.id, "app-export");
  assert.ok(result.meta?.version > 0, "DB verb should stamp meta/version as part of the write");

  await assert.rejects(
    () =>
      appRegisterPacketArtifacts({
        repoRoot,
        env: {},
        appId: "app-export",
        artifacts: {
          resumePdf: workspaceRel(repoRoot, join(repoRoot, "..", "escaped.pdf")),
        },
      }),
    /workspace|artifact path/i
  );
});

test("POST /api/packet/export exports saved packet sources through the local route", async () => {
  const repoRoot = tempRepo();
  const sources = seedPacketSources(repoRoot);
  seedApp(repoRoot, sources);
  const calls = [];
  const server = await bootPacketServer(repoRoot, {
    env: tempDownloadsEnv(),
    packetExportArtifact: fakeExporter(calls),
  });

  try {
    const { status, body } = await postJson(server, "/api/packet/export", {
      appId: "app-export",
      formats: ["docx"],
    });

    assert.equal(status, 200);
    assert.equal(body.ok, true);
    assert.equal(body.data?.appId, "app-export");
    assert.deepEqual(calls[0].formats, ["docx"]);
    assert.doesNotMatch(JSON.stringify(body), /\/api\/skill\/run|tailor-application/);

    const artifacts = readApp(repoRoot).artifacts;
    assert.equal(artifacts.resumePdf ?? null, null, "no PDF was requested, so none was produced");
    assert.match(artifacts.resumeDocx, /^workspace\/tailored\/.+\.docx$/);
  } finally {
    await closeServer(server);
  }
});

test("POST /api/packet/export exports plain text through the local route with no PDF artifact, renderer call, or Downloads copy", async () => {
  // End-to-end regression for the round-three finding: the UI's Files-panel
  // "Plain text" action sends formats: ["text"], and this must come back
  // text-only through the real /api/packet/export route — no PDF renderer
  // invocation, no PDF artifact, and no convenience copy under Downloads.
  const repoRoot = tempRepo();
  const sources = seedPacketSources(repoRoot);
  seedApp(repoRoot, sources);
  const calls = [];
  const downloadsEnv = tempDownloadsEnv();
  const server = await bootPacketServer(repoRoot, {
    env: downloadsEnv,
    packetExportArtifact: fakeExporter(calls),
  });

  try {
    const { status, body } = await postJson(server, "/api/packet/export", {
      appId: "app-export",
      formats: ["text"],
    });

    assert.equal(status, 200);
    assert.equal(body.ok, true);
    assert.equal(body.data?.appId, "app-export");
    assert.deepEqual(calls[0].formats, ["text"], "the renderer was never asked for a PDF");

    const artifacts = readApp(repoRoot).artifacts;
    assert.equal(artifacts.resumePdf ?? null, null, "no PDF artifact was produced");
    assert.match(artifacts.resumeText, /^workspace\/tailored\/.+\.txt$/);
    assert.deepEqual(
      readdirSync(downloadsEnv.CAREERRAT_DOWNLOADS_DIR),
      [],
      "a text-only export never copies anything to Downloads"
    );
  } finally {
    await closeServer(server);
  }
});

test("POST /api/packet/export routes text through the workspace-agent runtime path, not a silent PDF default", async () => {
  // Regression: the workspace-agent's job.export-documents handler filtered
  // requested formats through a pdf/docx-only allowlist, so formats: ["text"]
  // was filtered down to [] and then defaulted back to ["pdf"], so a
  // Files-panel "Plain text" export would silently come back as a PDF. This
  // exercises the real executeWorkspaceIntent handler (not the local-route
  // fallback used by the tests above) so the allowlist fix is actually
  // covered.
  const repoRoot = tempRepo();
  const sources = seedPacketSources(repoRoot);
  seedApp(repoRoot, sources);
  const calls = [];
  const textPath = "workspace/tailored/acme-staff-engineer-resume.txt";
  const workspaceAgentRuntime = {
    executeIntent: ({ intent }) =>
      executeWorkspaceIntent({
        repoRoot,
        env: {},
        intent,
        exportDocumentsImpl: async (input) => {
          calls.push(input);
          return {
            appId: input.applicationId,
            applicationId: input.applicationId,
            formats: input.formats,
            artifacts: { resumeText: textPath },
            userFacing: {
              resume: [{ format: "text", path: textPath, name: "acme-staff-engineer-resume.txt" }],
              coverLetter: [],
              answers: [],
            },
            downloadsErrors: [],
          };
        },
      }),
  };
  const server = await bootPacketServer(repoRoot, { workspaceAgentRuntime });

  try {
    const { status, body } = await postJson(server, "/api/packet/export", {
      appId: "app-export",
      formats: ["text"],
    });

    assert.equal(status, 200);
    assert.equal(body.ok, true);
    // The allowlist fix: "text" survives the filter instead of being dropped
    // and defaulted back to ["pdf"].
    assert.deepEqual(calls[0].formats, ["text"]);
    assert.match(body.data?.artifacts?.resumeText, /\.txt$/);
    assert.equal(body.data?.artifacts?.resumePdf, undefined);
  } finally {
    await closeServer(server);
  }
});

test("packet export owner delegates to existing document export helpers without install-time assumptions", () => {
  const sourcePath = join(process.cwd(), "src/core/packet/exports.mjs");
  const source = readFileSync(sourcePath, "utf8");
  assert.match(source, /documents\/export\.mjs|exportArtifact/);
  assert.doesNotMatch(source, /\bnpm\s+(?:i|install)\b|\bnpx\s+playwright\s+install\b/);
  assert.doesNotMatch(source, /\bplaywright-core\b|@playwright\/test/);
});
