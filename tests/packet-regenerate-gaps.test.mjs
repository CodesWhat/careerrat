// Freshly generated packet validation must win over a stale stored manifest
// when exportPacketArtifacts registers the result (review finding D1).

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, test } from "node:test";
import { closeAll, openDb } from "../src/core/db/connection.mjs";
import { importFromTracker } from "../src/core/db/import-from-tracker.mjs";
import { exportPacketArtifacts } from "../src/core/packet/exports.mjs";

const cleanupRoots = [];

function tempRepo() {
  const repoRoot = mkdtempSync(join(tmpdir(), "careerrat-packet-regen-"));
  cleanupRoots.push(repoRoot);
  mkdirSync(join(repoRoot, "workspace/tailored"), { recursive: true });
  return repoRoot;
}

function writeWorkspaceFile(repoRoot, relPath, content) {
  const full = join(repoRoot, "workspace", relPath);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, content, "utf8");
  return `workspace/${relPath}`;
}

function seed(repoRoot, packetManifest) {
  const sources = {
    resumeSource: writeWorkspaceFile(repoRoot, "tailored/acme-resume.md", "# Resume\n\nBody.\n"),
    coverLetterSource: writeWorkspaceFile(
      repoRoot,
      "tailored/acme-cover-letter.md",
      "Dear Team,\n\nBody.\n"
    ),
  };
  const sourceDir = join(repoRoot, "fixture-source");
  mkdirSync(sourceDir, { recursive: true });
  writeFileSync(
    join(sourceDir, "tracker.json"),
    JSON.stringify({
      meta: {},
      applications: [
        {
          id: "app-regen",
          company: "Acme",
          role: "Staff Engineer",
          status: "reviewed-hold",
          artifacts: sources,
          packetManifest: { ...packetManifest, artifacts: sources },
        },
      ],
      sourced: [],
      sources: [],
      communications: [],
    })
  );
  importFromTracker({ repoRoot, sourceDir });
  return sources;
}

function readManifest(repoRoot) {
  const db = openDb({ repoRoot, env: {} });
  const row = db.prepare("SELECT data FROM applications WHERE id = ?").get("app-regen");
  return JSON.parse(row.data).packetManifest;
}

async function pdfExporter({ outBase, formats }) {
  const result = {};
  if (formats.includes("pdf")) {
    mkdirSync(dirname(`${outBase}.pdf`), { recursive: true });
    writeFileSync(`${outBase}.pdf`, "%PDF-1.4\nfake\n%%EOF\n", "utf8");
    result.pdf = `${outBase}.pdf`;
  }
  return result;
}

function downloadsEnv() {
  const dir = mkdtempSync(join(tmpdir(), "careerrat-packet-regen-dl-"));
  cleanupRoots.push(dir);
  return { CAREERRAT_DOWNLOADS_DIR: dir };
}

after(() => {
  closeAll();
  for (const root of cleanupRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

test("regenerating after a new required question keeps the fresh gap and uploadReady false", async () => {
  const repoRoot = tempRepo();
  const sources = seed(repoRoot, {
    applicationId: "app-regen",
    generatedAt: "2026-07-06T14:00:00Z",
    uploadReady: true,
    status: "upload-ready",
    gapCount: 0,
    gaps: [],
  });
  const freshGap = {
    kind: "answers",
    code: "ANSWER_CONFIRMATION_REQUIRED",
    questionId: "q-new",
    message: "Answer “Why Acme?”.",
  };

  await exportPacketArtifacts({
    repoRoot,
    env: downloadsEnv(),
    appId: "app-regen",
    packetSources: sources,
    exportArtifact: pdfExporter,
    freshManifest: {
      applicationId: "app-regen",
      generatedAt: "2026-07-06T15:00:00Z",
      uploadReady: false,
      status: "reviewable",
      gapCount: 1,
      gaps: [freshGap],
    },
  });

  const manifest = readManifest(repoRoot);
  assert.equal(manifest.uploadReady, false);
  assert.equal(manifest.status, "reviewable");
  assert.ok(manifest.gaps.some((gap) => gap.questionId === "q-new"));
  assert.equal(manifest.gapCount, manifest.gaps.length);
});

test("first generation after a capture keeps provenance and DB-only question state", async () => {
  const repoRoot = tempRepo();
  const sources = seed(repoRoot, {
    applicationId: "app-regen",
    questions: {
      source: "workspace/jobs/q.json",
      capturedAt: "2026-07-06T13:00:00Z",
      answerableCount: 1,
      excludedCount: 0,
      answerableIds: ["q1"],
      excludedIds: [],
      demographicSectionPresent: false,
    },
  });
  const provenance = {
    jd: { path: "workspace/jobs/acme.md", sha256: "a".repeat(64) },
    evaluation: { evaluatedAt: "2026-07-06T12:00:00Z", sha256: "b".repeat(64) },
  };

  await exportPacketArtifacts({
    repoRoot,
    env: downloadsEnv(),
    appId: "app-regen",
    packetSources: sources,
    exportArtifact: pdfExporter,
    freshManifest: {
      applicationId: "app-regen",
      generatedAt: "2026-07-06T15:00:00Z",
      uploadReady: true,
      status: "upload-ready",
      gapCount: 0,
      gaps: [],
      provenance,
    },
  });

  const manifest = readManifest(repoRoot);
  assert.deepEqual(manifest.provenance, provenance);
  assert.equal(manifest.questions.source, "workspace/jobs/q.json");
  assert.deepEqual(manifest.questions.answerableIds, ["q1"]);
  assert.equal(manifest.uploadReady, true);
});
