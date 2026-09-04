// tests/packet-export.test.mjs
// RED contracts for Phase 10 Wave 0: packet-specific export orchestration.
// These tests intentionally fail until src/core/packet/exports.mjs exists.

import assert from "node:assert/strict";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { after, test } from "node:test";
import JSZip from "jszip";
import { mountPacketRoutes } from "../src/cli/packet-route.mjs";
import { executeWorkspaceIntent } from "../src/core/agent/workspace-agent.mjs";
import { createApplyDriver } from "../src/core/apply/apply-driver.mjs";
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

// Same as fakeExporter, but the rendered PDF bytes embed `title` (which
// titleFor() derives from the document kind), so a resume export and a
// cover-letter export produce genuinely distinct bytes instead of the
// identical fixed body fakeExporter writes for every kind. Needed by any
// regression that asserts one kind's file survives byte-for-byte across an
// unrelated export -- with identical bytes, that assertion would also pass
// if the file were silently replaced by the other kind's render.
function fakeExporterDistinctBytes(calls) {
  return async ({ markdown, outBase, formats, title, ats }) => {
    calls.push({ ats, formats: [...formats], markdown, outBase, title });
    const result = {};
    if (formats.includes("pdf")) {
      const pdfPath = `${outBase}.pdf`;
      mkdirSync(dirname(pdfPath), { recursive: true });
      writeFileSync(pdfPath, `%PDF-1.4\nfake packet pdf for ${title}\n%%EOF\n`, "utf8");
      result.pdf = pdfPath;
    }
    return result;
  };
}

// A minimal ops double for createApplyDriver, just enough to drive a single
// prepareOnly run through a form page with one required "Resume" upload
// control. Mirrors tests/apply-driver.test.mjs's createFakeOps, trimmed to
// what this file needs.
function fakeApplyOps(snapshot) {
  const log = [];
  return {
    log,
    ops: {
      async openTab() {
        log.push({ op: "openTab" });
        return { pageId: "page-1" };
      },
      async snapshot() {
        log.push({ op: "snapshot" });
        return snapshot;
      },
      async clickButton(args) {
        log.push({ op: "clickButton", ...args });
      },
      async upload(args) {
        log.push({ op: "upload", ...args });
      },
      async screenshot() {
        log.push({ op: "screenshot" });
        return { data: "", format: "png" };
      },
    },
  };
}

function refsOf(entries) {
  const refs = {};
  for (const [ref, role, name, required = false] of entries) {
    refs[ref] = { role, name, required };
  }
  return refs;
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

test("a text export does not overwrite an unrelated pre-existing .txt sibling of its markdown source", async () => {
  // Codex round-9 finding: exportPacketArtifacts only reserved identities
  // it already knew about (registered sources, plain-key artifacts, other
  // kinds' formats, the manifest). An unrelated file that happens to
  // already sit at the computed destination -- a hand-placed
  // workspace/tailored/resume.txt sitting next to resume.md, never
  // registered on the application at all -- was invisible to that
  // reservation set, so the confined text writer's atomic rename silently
  // replaced it. It must be treated as unavailable and the exporter must
  // pick a distinct suffix instead.
  const repoRoot = tempRepo();
  const resumeSource = writeWorkspaceFile(
    repoRoot,
    "tailored/acme-resume.md",
    "# Acme Staff Engineer\n\nEvidence-backed resume body.\n"
  );
  const siblingContent = "a manually maintained plain-text resume, unrelated to this export\n";
  const siblingPath = writeWorkspaceFile(repoRoot, "tailored/acme-resume.txt", siblingContent);
  const packetManifest = writeWorkspaceFile(
    repoRoot,
    "tailored/acme-packet-manifest.json",
    JSON.stringify({ appId: "app-export", generatedAt: "2026-07-06T14:00:00Z", uploadReady: true })
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

  assert.equal(
    readFileSync(join(repoRoot, siblingPath), "utf8"),
    siblingContent,
    "the unrelated sibling .txt file survives byte-for-byte"
  );

  assert.equal(calls.length, 1);
  assert.notEqual(
    `${calls[0].outBase}.txt`,
    join(repoRoot, siblingPath),
    "the export lands on a suffixed destination, not the sibling's path"
  );

  const artifacts = readApp(repoRoot).artifacts;
  assert.match(artifacts.resumeText, /^workspace\/tailored\/.+\.txt$/);
  assert.notEqual(
    artifacts.resumeText,
    siblingPath,
    "the exported text artifact is not the unrelated sibling"
  );
});

test("a same-owner re-export reuses its own registered destination and overwrites it", async () => {
  // The other side of the fix above: a destination is only available for
  // reuse when it is this application's own registered prior export for
  // the same kind and format. A same-owner re-export (e.g. a candidate
  // regenerating the same resume text a second time) must still land on
  // and overwrite its own prior output rather than getting suffixed away
  // from it forever.
  const repoRoot = tempRepo();
  const sources = seedPacketSources(repoRoot);
  const priorOutBase = sources.resumeSource.replace(/\.md$/, "").replace(/^workspace\//, "");
  const priorResumeText = writeWorkspaceFile(
    repoRoot,
    `${priorOutBase}.txt`,
    "stale text from a prior export run\n"
  );
  seedApp(repoRoot, { ...sources, resumeText: priorResumeText });

  const calls = [];
  const { exportPacketArtifacts } = await importPacketExports();

  await exportPacketArtifacts({
    repoRoot,
    env: tempDownloadsEnv(),
    appId: "app-export",
    packetSources: { resumeSource: sources.resumeSource },
    request: { formats: ["text"] },
    exportArtifact: fakeExporter(calls),
    now: () => new Date("2026-07-06T15:00:00Z"),
  });

  assert.equal(calls.length, 1);
  assert.equal(
    `${calls[0].outBase}.txt`,
    join(repoRoot, priorResumeText),
    "the re-export reuses its own registered destination rather than picking a suffix"
  );
  assert.equal(
    readFileSync(join(repoRoot, priorResumeText), "utf8"),
    "fake packet plain text\n",
    "the registered destination is overwritten with the fresh export"
  );

  const artifacts = readApp(repoRoot).artifacts;
  assert.equal(artifacts.resumeText, priorResumeText);
});

test("an unrelated application's registered artifact at the computed destination survives", async () => {
  // The reuse exception is scoped per application: an existing file at
  // the computed destination that belongs to a different application's
  // registered export is exactly as unowned, from this application's
  // perspective, as any other stranger's file, and must not be replaced.
  const repoRoot = tempRepo();
  const resumeSource = writeWorkspaceFile(
    repoRoot,
    "tailored/shared-resume.md",
    "# Acme Staff Engineer\n\nEvidence-backed resume body.\n"
  );
  const otherContent = "another application's own registered plain-text resume\n";
  const otherResumeText = writeWorkspaceFile(repoRoot, "tailored/shared-resume.txt", otherContent);
  const packetManifest = writeWorkspaceFile(
    repoRoot,
    "tailored/shared-packet-manifest.json",
    JSON.stringify({ appId: "app-export", generatedAt: "2026-07-06T14:00:00Z", uploadReady: true })
  );
  importTrackerFixture(repoRoot, [
    {
      id: "app-export",
      company: "Acme",
      role: "Staff Engineer",
      status: "reviewed-hold",
      artifacts: { resumeSource, packetManifest },
    },
    {
      id: "app-other",
      company: "Globex",
      role: "Principal Engineer",
      status: "reviewed-hold",
      artifacts: { resumeText: otherResumeText },
    },
  ]);
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

  assert.equal(
    readFileSync(join(repoRoot, otherResumeText), "utf8"),
    otherContent,
    "the other application's registered artifact survives byte-for-byte"
  );

  assert.equal(calls.length, 1);
  assert.notEqual(
    `${calls[0].outBase}.txt`,
    join(repoRoot, otherResumeText),
    "app-export's export lands on a suffixed destination, not app-other's file"
  );

  const artifacts = readApp(repoRoot, "app-export").artifacts;
  assert.notEqual(artifacts.resumeText, otherResumeText);
});

test("a text-only regeneration clears a prior resumePdf so apply cannot still select it", async () => {
  // Regression for a round-four finding: exportPacketArtifacts used to
  // merge a run's artifacts onto the prior manifest/app-row artifacts
  // without clearing formats it didn't (re)produce, so an old resumePdf
  // from an earlier PDF export survived a later text-only regeneration.
  // apply-driver prefers resumePdf over resumeText, so the stale PDF could
  // still be picked and submitted after the candidate asked for a
  // text-only refresh.
  const repoRoot = tempRepo();
  const sources = seedPacketSources(repoRoot);
  const stalePdfPath = writeWorkspaceFile(repoRoot, "tailored/stale-resume.pdf", "%PDF-fake");
  seedApp(repoRoot, {
    ...sources,
    resumePdf: stalePdfPath,
    resumePdfGeneratedAt: "2026-07-01T00:00:00Z",
  });
  assert.equal(readApp(repoRoot).artifacts.resumePdf, stalePdfPath);

  const calls = [];
  const { exportPacketArtifacts } = await importPacketExports();

  await exportPacketArtifacts({
    repoRoot,
    env: tempDownloadsEnv(),
    appId: "app-export",
    packetSources: { resumeSource: sources.resumeSource },
    request: { formats: ["text"] },
    exportArtifact: fakeExporter(calls),
    now: () => new Date("2026-07-06T15:00:00Z"),
  });

  const artifacts = readApp(repoRoot).artifacts;
  assert.equal(
    artifacts.resumePdf ?? null,
    null,
    "the stale PDF from before the text-only regeneration must not survive"
  );
  assert.equal(artifacts.resumeDocx ?? null, null);
  assert.match(artifacts.resumeText, /^workspace\/tailored\/.+\.txt$/);

  const manifest = readApp(repoRoot).packetManifest;
  assert.equal(
    manifest.artifacts.resumePdf ?? null,
    null,
    "the packet manifest's own artifacts must also drop the stale PDF entry"
  );
});

test("a text-only export that clears the last PDF/DOCX resume is never left upload-ready", async () => {
  // Regression: a text-only export deletes the prior PDF/DOCX pointers
  // (see the previous test), but the manifest's uploadReady flag used to
  // stay true whenever the export itself produced no exportGaps — even
  // though the upload driver only accepts a .pdf or .docx resume and
  // intentionally rejects a .txt one. That let the apply gate accept a
  // packet the upload driver could never actually submit.
  const repoRoot = tempRepo();
  const sources = seedPacketSources(repoRoot);
  const priorPdfPath = writeWorkspaceFile(repoRoot, "tailored/prior-resume.pdf", "%PDF-fake");
  seedApp(repoRoot, { ...sources, resumePdf: priorPdfPath });

  const { exportPacketArtifacts } = await importPacketExports();

  await exportPacketArtifacts({
    repoRoot,
    env: tempDownloadsEnv(),
    appId: "app-export",
    packetSources: { resumeSource: sources.resumeSource, packetManifest: sources.packetManifest },
    request: { formats: ["text"] },
    exportArtifact: fakeExporter([]),
    now: () => new Date("2026-07-06T15:00:00Z"),
  });

  const manifest = readApp(repoRoot).packetManifest;
  assert.equal(
    manifest.uploadReady,
    false,
    "no PDF/DOCX resume survives the text-only export, so the packet cannot be upload-ready"
  );
  assert.equal(manifest.status, "reviewable");
  assert.ok(
    manifest.gaps.some((gap) => gap.code === "RESUME_UPLOAD_ARTIFACT_MISSING"),
    "a blocking gap must record why the packet is not upload-ready"
  );
});

test("a later PDF export clears the RESUME_UPLOAD_ARTIFACT_MISSING gap and restores upload readiness", async () => {
  const repoRoot = tempRepo();
  const sources = seedPacketSources(repoRoot);
  const priorPdfPath = writeWorkspaceFile(repoRoot, "tailored/prior-resume.pdf", "%PDF-fake");
  seedApp(repoRoot, { ...sources, resumePdf: priorPdfPath });

  const { exportPacketArtifacts } = await importPacketExports();

  await exportPacketArtifacts({
    repoRoot,
    env: tempDownloadsEnv(),
    appId: "app-export",
    packetSources: { resumeSource: sources.resumeSource, packetManifest: sources.packetManifest },
    request: { formats: ["text"] },
    exportArtifact: fakeExporter([]),
    now: () => new Date("2026-07-06T15:00:00Z"),
  });
  assert.equal(readApp(repoRoot).packetManifest.uploadReady, false);

  await exportPacketArtifacts({
    repoRoot,
    env: tempDownloadsEnv(),
    appId: "app-export",
    packetSources: { resumeSource: sources.resumeSource, packetManifest: sources.packetManifest },
    request: { formats: ["pdf"] },
    exportArtifact: fakeExporter([]),
    now: () => new Date("2026-07-06T16:00:00Z"),
  });

  const manifest = readApp(repoRoot).packetManifest;
  assert.equal(manifest.uploadReady, true, "a valid resume PDF must clear the blocking gap");
  assert.equal(manifest.status, "upload-ready");
  assert.deepEqual(
    manifest.gaps.filter((gap) => gap.code === "RESUME_UPLOAD_ARTIFACT_MISSING"),
    []
  );
  assert.match(readApp(repoRoot).artifacts.resumePdf, /^workspace\/tailored\/.+\.pdf$/);
});

test("a cover-letter-only export doesn't report RESUME_UPLOAD_ARTIFACT_MISSING when a valid plain resume artifact survives", async () => {
  // Regression: hasUploadableResume only checked resumePdf/resumeDocx, the
  // keys this export path itself produces. The apply driver's own upload
  // candidate list (uploadArtifacts in apply-driver.mjs) also accepts the
  // plain "resume" key as its final fallback -- a legacy application, or
  // one whose PDF was registered directly rather than exported through this
  // path. A cover-letter-only export on that application used to report
  // RESUME_UPLOAD_ARTIFACT_MISSING even though a resume the apply driver
  // can actually upload still survives untouched in the merged artifacts.
  const repoRoot = tempRepo();
  const sources = seedPacketSources(repoRoot);
  const legacyResumePdf = writeWorkspaceFile(
    repoRoot,
    "tailored/legacy-resume.pdf",
    "%PDF-1.4\nfake legacy resume\n%%EOF\n"
  );
  seedApp(repoRoot, { ...sources, resume: legacyResumePdf });

  const { exportPacketArtifacts } = await importPacketExports();

  await exportPacketArtifacts({
    repoRoot,
    env: tempDownloadsEnv(),
    appId: "app-export",
    // Cover-letter-only: resumeSource is never passed, so resumePdf and
    // resumeDocx stay whatever they already were (absent, in this fixture)
    // and the legacy plain "resume" artifact is the only uploadable resume.
    packetSources: {
      coverLetterSource: sources.coverLetterSource,
      packetManifest: sources.packetManifest,
    },
    request: { formats: ["pdf"] },
    exportArtifact: fakeExporter([]),
    now: () => new Date("2026-07-06T15:00:00Z"),
  });

  const manifest = readApp(repoRoot).packetManifest;
  assert.equal(
    manifest.gaps.some((gap) => gap.code === "RESUME_UPLOAD_ARTIFACT_MISSING"),
    false,
    "a valid plain resume artifact survives the cover-letter-only export; no gap should fire"
  );
  assert.equal(manifest.uploadReady, true);
  assert.equal(manifest.status, "upload-ready");
});

test("a docx-only regeneration clears a prior resumePdf the same way", async () => {
  const repoRoot = tempRepo();
  const sources = seedPacketSources(repoRoot);
  const stalePdfPath = writeWorkspaceFile(repoRoot, "tailored/stale-resume.pdf", "%PDF-fake");
  seedApp(repoRoot, { ...sources, resumePdf: stalePdfPath });

  const calls = [];
  const { exportPacketArtifacts } = await importPacketExports();

  await exportPacketArtifacts({
    repoRoot,
    env: tempDownloadsEnv(),
    appId: "app-export",
    packetSources: { resumeSource: sources.resumeSource },
    request: { formats: ["docx"] },
    exportArtifact: fakeExporter(calls),
    now: () => new Date("2026-07-06T15:00:00Z"),
  });

  const artifacts = readApp(repoRoot).artifacts;
  assert.equal(artifacts.resumePdf ?? null, null, "docx-only regeneration also clears the PDF");
  assert.match(artifacts.resumeDocx, /^workspace\/tailored\/.+\.docx$/);
});

test("distinctOutBase treats an uppercase-extension source as the same filesystem destination its lowercase export would pick", async () => {
  // Regression: a resumeSource stored with an uppercase extension
  // (RESUME.TXT) is a distinct string from the lowercase "resume.txt" a
  // text export naturally computes, but on a case-insensitive volume
  // they're the same inode. The old lexical Set lookup missed this and
  // would export straight over the source itself.
  const repoRoot = tempRepo();
  const resumeSource = writeWorkspaceFile(repoRoot, "tailored/resume.TXT", "the original source\n");
  const packetManifest = writeWorkspaceFile(
    repoRoot,
    "tailored/case-packet-manifest.json",
    JSON.stringify({ appId: "app-export", generatedAt: "2026-07-06T14:00:00Z", uploadReady: true })
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
    "the original source\n",
    "the uppercase-extension source is untouched, byte-for-byte"
  );

  // Only assert the collision-avoidance suffix on a case-insensitive
  // filesystem (the default on macOS and Windows); on a case-sensitive
  // volume "resume.TXT" and "resume.txt" are genuinely different files and
  // no collision exists to avoid.
  const caseInsensitiveVolume = existsSync(join(repoRoot, "workspace/tailored/RESUME.TXT"));
  if (caseInsensitiveVolume) {
    assert.notEqual(
      `${calls[0].outBase}.txt`.toLowerCase(),
      sourceAbsPath.toLowerCase(),
      "the export destination is case-insensitively distinct from the source path"
    );
  }
});

test("distinctOutBase reserves a symlink alias pointing at the source, instead of overwriting the alias", async () => {
  // Regression: a symlink that aliases the source under the export's
  // natural destination name (e.g. resume.txt -> resume.md) is not itself
  // a registered packet source, so the old lexical Set lookup — which only
  // compared against stored source strings — never saw it and would have
  // let the export write straight through the alias onto the source.
  const repoRoot = tempRepo();
  const resumeSource = writeWorkspaceFile(repoRoot, "tailored/resume.md", "# Resume\n\nBody.\n");
  const aliasPath = join(repoRoot, "workspace/tailored/resume.txt");
  symlinkSync("resume.md", aliasPath);
  const packetManifest = writeWorkspaceFile(
    repoRoot,
    "tailored/link-packet-manifest.json",
    JSON.stringify({ appId: "app-export", generatedAt: "2026-07-06T14:00:00Z", uploadReady: true })
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

  assert.equal(
    readFileSync(join(repoRoot, resumeSource), "utf8"),
    "# Resume\n\nBody.\n",
    "the source's bytes must survive, even reached through the symlink alias"
  );
  const aliasStat = lstatSync(aliasPath);
  assert.equal(
    aliasStat.isSymbolicLink(),
    true,
    "the pre-existing symlink alias must survive untouched"
  );
  assert.equal(readlinkSync(aliasPath), "resume.md");
  assert.notEqual(
    `${calls[0].outBase}.txt`,
    aliasPath,
    "the export destination must not be the alias path itself"
  );
});

test("resumeSource=application.txt and coverLetterSource=application.md do not both map to application-export.txt", async () => {
  const repoRoot = tempRepo();
  const resumeSource = writeWorkspaceFile(
    repoRoot,
    "tailored/application.txt",
    "resume source body\n"
  );
  const coverLetterSource = writeWorkspaceFile(
    repoRoot,
    "tailored/application.md",
    "cover letter source body\n"
  );
  const packetManifest = writeWorkspaceFile(
    repoRoot,
    "tailored/application-packet-manifest.json",
    JSON.stringify({ appId: "app-export", generatedAt: "2026-07-06T14:00:00Z", uploadReady: true })
  );
  seedApp(repoRoot, { resumeSource, coverLetterSource, packetManifest });
  const calls = [];
  const { exportPacketArtifacts } = await importPacketExports();

  await exportPacketArtifacts({
    repoRoot,
    env: tempDownloadsEnv(),
    appId: "app-export",
    packetSources: { resumeSource, coverLetterSource },
    request: { formats: ["text"] },
    exportArtifact: fakeExporter(calls),
    now: () => new Date("2026-07-06T15:00:00Z"),
  });

  assert.equal(calls.length, 2);
  const outBases = calls.map((call) => call.outBase);
  assert.equal(new Set(outBases).size, 2, "each source must pick a distinct output base");

  const artifacts = readApp(repoRoot).artifacts;
  assert.notEqual(
    artifacts.resumeText,
    artifacts.coverLetterText,
    "the two exports must not land on the same destination file"
  );
  assert.match(artifacts.resumeText, /^workspace\/tailored\/.+\.txt$/);
  assert.match(artifacts.coverLetterText, /^workspace\/tailored\/.+\.txt$/);
});

test("a partial export reserves every source registered on the application, not just the ones it was passed", async () => {
  // Regression: reservedIdentities used to build its collision set only
  // from the packetSources this call was given. A partial export (e.g.
  // regenerating just the resume, via packetSources: { resumeSource })
  // omits the application's other registered sources from that set, so a
  // collision with an omitted source went undetected and the atomic
  // rename silently replaced it while its artifact pointer kept pointing
  // at the now-overwritten file.
  const repoRoot = tempRepo();
  const resumeSource = writeWorkspaceFile(
    repoRoot,
    "tailored/resume-src.md",
    "# Resume\n\nOriginal resume source body.\n"
  );
  const coverLetterCanaryContent = "cover letter source body — must survive untouched\n";
  const coverLetterSource = writeWorkspaceFile(
    repoRoot,
    // Deliberately shares resumeSource's stripped base ("resume-src") once
    // resumeSource's own extension is removed, so the naive text outBase
    // for resumeSource collides with this file's own path.
    "tailored/resume-src.txt",
    coverLetterCanaryContent
  );
  const packetManifest = writeWorkspaceFile(
    repoRoot,
    "tailored/partial-packet-manifest.json",
    JSON.stringify({ appId: "app-export", generatedAt: "2026-07-06T14:00:00Z", uploadReady: true })
  );
  seedApp(repoRoot, { resumeSource, coverLetterSource, packetManifest });
  const calls = [];
  const { exportPacketArtifacts } = await importPacketExports();

  await exportPacketArtifacts({
    repoRoot,
    env: tempDownloadsEnv(),
    appId: "app-export",
    // Partial: only resumeSource is passed. coverLetterSource is still
    // registered on the application row (seeded above) but omitted here —
    // exactly the fallback-route shape a caller like the raw POST
    // /api/packet/export body can produce.
    packetSources: { resumeSource },
    request: { formats: ["text"] },
    exportArtifact: fakeExporter(calls),
    now: () => new Date("2026-07-06T15:00:00Z"),
  });

  assert.equal(
    readFileSync(join(repoRoot, coverLetterSource), "utf8"),
    coverLetterCanaryContent,
    "the omitted cover-letter source's bytes must survive, byte-for-byte"
  );

  assert.equal(calls.length, 1);
  assert.notEqual(
    `${calls[0].outBase}.txt`,
    join(repoRoot, coverLetterSource),
    "the resume export destination must not be the omitted source's path"
  );

  const artifacts = readApp(repoRoot).artifacts;
  assert.notEqual(
    artifacts.resumeText,
    coverLetterSource,
    "the resume text artifact must not point at the omitted cover-letter source"
  );
});

test("a partial export reserves a plain-key registered artifact, not just its *Source counterpart", async () => {
  // Regression: reservedIdentities only ever looked at keys ending in
  // "Source". A supported plain-key registration -- artifacts.resume,
  // artifacts.coverLetter, artifacts.answers, e.g. a legacy application, or
  // one whose cover letter was registered directly with no coverLetterSource
  // markdown -- was invisible to the collision set, so an exported resume
  // whose outBase collided with it could get atomically renamed over it
  // while artifacts.coverLetter kept pointing at the now-overwritten file.
  const repoRoot = tempRepo();
  const resumeSource = writeWorkspaceFile(
    repoRoot,
    "tailored/plain-key-resume-src.md",
    "# Resume\n\nOriginal resume source body.\n"
  );
  const coverLetterCanaryContent = "plain-key cover letter body, must survive untouched\n";
  const coverLetterPlainPath = writeWorkspaceFile(
    repoRoot,
    // Shares resumeSource's stripped base ("plain-key-resume-src") once
    // resumeSource's own extension is removed, so the naive text outBase
    // for resumeSource collides with this file's own path -- and it's
    // registered only under the plain "coverLetter" key, with no
    // coverLetterSource counterpart for sourceEntries to pick up.
    "tailored/plain-key-resume-src.txt",
    coverLetterCanaryContent
  );
  const packetManifest = writeWorkspaceFile(
    repoRoot,
    "tailored/plain-key-packet-manifest.json",
    JSON.stringify({ appId: "app-export", generatedAt: "2026-07-06T14:00:00Z", uploadReady: true })
  );
  seedApp(repoRoot, { resumeSource, coverLetter: coverLetterPlainPath, packetManifest });
  const calls = [];
  const { exportPacketArtifacts } = await importPacketExports();

  await exportPacketArtifacts({
    repoRoot,
    env: tempDownloadsEnv(),
    appId: "app-export",
    // Partial: only resumeSource is passed. The plain-key coverLetter
    // artifact is still registered on the application row (seeded above)
    // but has no coverLetterSource, so it never appears in `sources`.
    packetSources: { resumeSource },
    request: { formats: ["text"] },
    exportArtifact: fakeExporter(calls),
    now: () => new Date("2026-07-06T15:00:00Z"),
  });

  assert.equal(
    readFileSync(join(repoRoot, coverLetterPlainPath), "utf8"),
    coverLetterCanaryContent,
    "the plain-key cover-letter artifact's bytes must survive, byte-for-byte"
  );

  assert.equal(calls.length, 1);
  assert.notEqual(
    `${calls[0].outBase}.txt`,
    join(repoRoot, coverLetterPlainPath),
    "the resume export destination must not be the plain-key artifact's path"
  );

  const artifacts = readApp(repoRoot).artifacts;
  assert.notEqual(
    artifacts.resumeText,
    coverLetterPlainPath,
    "the resume text artifact must not point at the plain-key cover-letter artifact"
  );
});

test("a partial export reserves format-specific artifacts belonging to omitted document kinds", async () => {
  // Regression: reservedIdentities only ever reserved the plain
  // resume/coverLetter/answers keys and their *Source counterparts for an
  // omitted kind, never the format-specific keys the export loop itself
  // produces (resumePdf, resumeDocx, resumeText, ...). A same-stem full
  // export followed by a partial export of a different kind could
  // silently rename over a surviving resume PDF while artifacts.resumePdf
  // kept pointing at the now-overwritten file, and apply-driver's upload
  // selection would then hand the overwritten file to an ATS as the resume.
  //
  // The original version of this test used identical fixed bytes for every
  // exported PDF, so an overwrite-by-the-other-kind's-render would have
  // passed the "bytes unchanged" assertion anyway, and it mirrored
  // apply-driver's [resumePdf, resumeDocx, resume]/validUploadArtifact
  // selection logic locally instead of calling the real thing -- a bug in
  // that selection logic could never have failed this test. This version
  // gives each kind distinct bytes, seeds uploadReady before either export
  // and checks it survives both, and drives the real apply-driver upload
  // selection through createApplyDriver.
  const repoRoot = tempRepo();
  const resumeSource = writeWorkspaceFile(
    repoRoot,
    "tailored/same-stem.md",
    "# Resume\n\nOriginal resume source body.\n"
  );
  const coverLetterSource = writeWorkspaceFile(
    repoRoot,
    // Shares resumeSource's stripped base ("same-stem") once each
    // source's own extension is removed, so the two kinds' natural
    // outBase collide.
    "tailored/same-stem.txt",
    "Dear Hiring Team,\n\nCover letter source body.\n"
  );
  importTrackerFixture(repoRoot, [
    {
      id: "app-export",
      company: "Acme",
      role: "Staff Engineer",
      status: "reviewed-hold",
      artifacts: { resumeSource, coverLetterSource },
      // Seeded true before either export runs, so a later export's
      // readiness comes from actually preserving this, not from
      // incidentally deriving true from a fresh, empty prior manifest.
      packetManifest: { applicationId: "app-export", uploadReady: true, gapCount: 0, gaps: [] },
    },
  ]);
  const { exportPacketArtifacts } = await importPacketExports();

  // Full export: both kinds compete for the same natural outBase. The
  // in-run collision avoidance covered by an earlier regression pushes
  // the cover letter onto a distinct "-export" destination.
  const fullCalls = [];
  await exportPacketArtifacts({
    repoRoot,
    env: tempDownloadsEnv(),
    appId: "app-export",
    packetSources: { resumeSource, coverLetterSource },
    request: { formats: ["pdf"] },
    exportArtifact: fakeExporterDistinctBytes(fullCalls),
    now: () => new Date("2026-07-06T15:00:00Z"),
  });

  const afterFull = readApp(repoRoot);
  const resumePdfPath = afterFull.artifacts.resumePdf;
  assert.match(resumePdfPath, /^workspace\/tailored\/.+\.pdf$/);
  const resumePdfAbs = join(repoRoot, resumePdfPath);
  const resumePdfBytesBefore = readFileSync(resumePdfAbs);
  assert.match(
    resumePdfBytesBefore.toString("utf8"),
    /Acme - Staff Engineer - Resume/,
    "the resume PDF's own bytes are distinct from the cover letter's"
  );
  assert.equal(
    afterFull.packetManifest.uploadReady,
    true,
    "upload readiness survives the full export"
  );

  // Partial: regenerate only the cover letter, same stem. resumeSource is
  // omitted from this call entirely, but the resume PDF from the prior
  // full export is still registered and still live on disk.
  const partialCalls = [];
  await exportPacketArtifacts({
    repoRoot,
    env: tempDownloadsEnv(),
    appId: "app-export",
    packetSources: { coverLetterSource },
    request: { formats: ["pdf"] },
    exportArtifact: fakeExporterDistinctBytes(partialCalls),
    now: () => new Date("2026-07-06T16:00:00Z"),
  });

  const afterPartial = readApp(repoRoot);
  assert.equal(
    afterPartial.artifacts.resumePdf,
    resumePdfPath,
    "the resume PDF pointer must survive an unrelated partial export untouched"
  );
  assert.deepEqual(
    readFileSync(resumePdfAbs),
    resumePdfBytesBefore,
    "the resume PDF's bytes must be byte-for-byte unchanged, not silently replaced by the cover letter's distinct bytes"
  );
  assert.notEqual(
    `${partialCalls[0].outBase}.pdf`,
    resumePdfAbs,
    "the cover-letter-only export must not target the resume's own destination"
  );
  assert.equal(
    afterPartial.packetManifest.uploadReady,
    true,
    "upload readiness survives the unrelated partial export"
  );

  // Drive the real apply-driver upload selection (uploadArtifacts in
  // src/core/apply/apply-driver.mjs) through createApplyDriver, rather than
  // mirroring its [resumePdf, resumeDocx, resume]/validUploadArtifact logic
  // locally -- a bug in the real selection could otherwise pass this test.
  const snapshot = {
    origin: "https://job-boards.greenhouse.io/example/jobs/123",
    pageText: 'Application form\n- button "Resume" [required, ref=e1]\nSubmit application',
    refs: refsOf([
      ["e1", "button", "Resume", true],
      ["e2", "button", "Submit Application", false],
    ]),
  };
  const { ops, log } = fakeApplyOps(snapshot);
  const execute = createApplyDriver({
    ops,
    providerLabel: "orca",
    repoRoot,
    env: {},
    mayRunImpl: () => ({ allowed: true }),
    candidateConfigGetImpl: () => ({}),
    loadAnswerMapImpl: async () => new Map(),
    captureQuestionsImpl: async ({ questions }) => ({
      questions,
      excluded: [],
      demographicSectionPresent: false,
    }),
    saveScreenshotImpl: () => "workspace/captures/fake-confirmation.png",
  });

  const result = await execute({
    applicationId: "app-export",
    application: { id: "app-export", link: snapshot.origin, artifacts: afterPartial.artifacts },
    postingUrl: snapshot.origin,
    questionCapture: { state: "captured" },
    prepareOnly: true,
  });

  assert.equal(result.session.uploadedCount, 1);
  assert.deepEqual(
    log.filter((entry) => entry.op === "upload"),
    [{ op: "upload", pageId: "page-1", ref: "e1", files: resumePdfAbs }],
    "apply-driver's real upload selection must pick the surviving resume PDF, not an overwritten file"
  );
});

test("an export whose stem collides with the packet manifest's own filename does not overwrite it", async () => {
  // Regression: reservedIdentities never included the packet manifest path
  // (sourceEntries() only picks up keys ending in "Source", and
  // "packetManifest" doesn't). A resumeSource whose stripped stem happened
  // to collide with the manifest's own filename, once the selected
  // format's extension was appended, would get atomically renamed over the
  // manifest, destroying the record of the application's upload readiness
  // and gaps.
  //
  // The manifest is only genuinely at risk when this call's own final
  // manifest write can't self-heal it: that write is keyed off
  // sources.packetManifest and is skipped entirely when this call omits
  // that key (e.g. a first export call passing packetSources without
  // packetManifest, exactly like the fallback-route shape the "reserves
  // every source registered on the application" regression above already
  // covers). The already-registered manifest from a prior step is then a
  // plain foreign file this call must not collide with, same as any other
  // omitted artifact.
  const repoRoot = tempRepo();
  const priorPacketManifest = writeWorkspaceFile(
    repoRoot,
    // Matches resumeSource's stripped stem below once the requested
    // "text" format's ".txt" extension is appended.
    "tailored/collide-packet-manifest.txt",
    JSON.stringify(
      { applicationId: "app-export", uploadReady: true, gapCount: 0, gaps: [] },
      null,
      2
    )
  );
  const resumeSource = writeWorkspaceFile(
    repoRoot,
    "tailored/collide-packet-manifest.md",
    "# Resume\n\nOriginal resume source body.\n"
  );
  // The manifest is already registered on the application row (from
  // whatever earlier step produced it), but resumeSource is not yet -- this
  // call is the one that first passes it in, via packetSources only, with
  // no packetManifest key of its own.
  seedApp(repoRoot, { packetManifest: priorPacketManifest });
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

  const manifestAfter = JSON.parse(readFileSync(join(repoRoot, priorPacketManifest), "utf8"));
  assert.equal(
    manifestAfter.uploadReady,
    true,
    "the packet manifest's own JSON content must survive, not get replaced by the resume's plain-text render"
  );

  assert.equal(calls.length, 1);
  assert.notEqual(
    `${calls[0].outBase}.txt`,
    join(repoRoot, priorPacketManifest),
    "the resume export destination must not be the packet manifest's own path"
  );

  const artifacts = readApp(repoRoot).artifacts;
  assert.notEqual(
    artifacts.resumeText,
    priorPacketManifest,
    "the resume text artifact must not point at the packet manifest"
  );
});

test("exportPacketArtifacts registers a text artifact through a symlinked workspace root", async () => {
  // Regression for a round-four finding: writeTextArtifactConfined returns
  // a realpath-canonical destination once it validates against a trusted
  // root, but workspaceDisplayPath used to relativize that against the
  // lexical workspaceDir. Under a symlinked workspace root (mirroring a
  // symlinked CAREERRAT_HOME or macOS's /var-to-/private/var alias), that
  // produced workspace/../ segments that registration rejects after the
  // file and manifest were already written.
  const realRoot = mkdtempSync(join(tmpdir(), "careerrat-packet-export-real-"));
  cleanupRoots.push(realRoot);
  const linkRoot = `${realRoot}-link`;
  symlinkSync(realRoot, linkRoot);
  cleanupRoots.push(linkRoot);
  mkdirSync(join(realRoot, "workspace/tailored"), { recursive: true });

  const sources = seedPacketSources(linkRoot);
  seedApp(linkRoot, sources);
  const { exportPacketArtifacts } = await importPacketExports();
  // The real exportArtifact (not the fakeExporter test double) is required
  // here: the fake writes straight to `${outBase}.txt` with no realpath
  // involved, so it never exercises writeTextArtifactConfined's
  // trusted-root canonicalization — the exact code path this regression is
  // in. Text-only keeps this fast; no PDF/DOCX rendering is exercised.
  const { exportArtifact: realExportArtifact } = await import("../src/core/documents/export.mjs");

  const result = await exportPacketArtifacts({
    repoRoot: linkRoot,
    env: tempDownloadsEnv(),
    appId: "app-export",
    packetSources: { resumeSource: sources.resumeSource },
    request: { formats: ["text"] },
    exportArtifact: realExportArtifact,
    now: () => new Date("2026-07-06T15:00:00Z"),
  });

  assert.equal(result.registered.artifacts.resumeText.includes("../"), false);
  assert.match(result.registered.artifacts.resumeText, /^workspace\/tailored\/.+\.txt$/);

  const artifacts = readApp(linkRoot).artifacts;
  assert.match(artifacts.resumeText, /^workspace\/tailored\/.+\.txt$/);
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
