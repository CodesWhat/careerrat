import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { after, test } from "node:test";
import JSZip from "jszip";
import { closeAll, openDb } from "../src/core/db/connection.mjs";
import { appUpsert, jobThreadMessageAppend, jobThreadSetPinned } from "../src/core/db/verbs.mjs";
import { buildWorkspaceExport } from "../src/core/export/workspace-export.mjs";

const roots = [];

after(() => {
  closeAll();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

test("export everything snapshots canonical chat-first state and readable workspace files without secrets", async () => {
  const repoRoot = mkdtempSync(join(tmpdir(), "careerrat-workspace-export-"));
  roots.push(repoRoot);
  openDb({ repoRoot, env: {} });
  appUpsert({
    repoRoot,
    env: {},
    row: { id: "app-1", company: "Aperture", role: "Engineer", status: "interview" },
  });
  jobThreadSetPinned({ repoRoot, env: {}, applicationId: "app-1", pinned: true });
  jobThreadMessageAppend({
    repoRoot,
    env: {},
    applicationId: "app-1",
    role: "user",
    text: "Keep this conversation.",
  });

  mkdirSync(join(repoRoot, "candidate"), { recursive: true });
  mkdirSync(join(repoRoot, "workspace", "jobs"), { recursive: true });
  mkdirSync(join(repoRoot, "config"), { recursive: true });
  mkdirSync(join(repoRoot, ".careerrat", "internal"), { recursive: true });
  writeFileSync(join(repoRoot, "candidate", "profile.yml"), "name: Alex\n");
  writeFileSync(join(repoRoot, "workspace", "jobs", "aperture.md"), "# Aperture\n");
  writeFileSync(join(repoRoot, "config", "search-sources.yml"), "sources: []\n");
  writeFileSync(join(repoRoot, ".careerrat", "internal", "ai.env"), "SECRET=never-export\n");

  const result = await buildWorkspaceExport({
    repoRoot,
    env: {},
    now: new Date("2026-08-23T19:30:00Z"),
  });
  assert.equal(result.filename, "careerrat-export-2026-08-23.zip");

  const zip = await JSZip.loadAsync(result.buffer);
  assert.ok(zip.file("database/careerrat.db"));
  assert.ok(zip.file("candidate/profile.yml"));
  assert.ok(zip.file("workspace/jobs/aperture.md"));
  assert.ok(zip.file("config/search-sources.yml"));
  assert.equal(zip.file("internal/ai.env"), null);
  assert.doesNotMatch(Object.keys(zip.files).join("\n"), /ai\.env/);

  const manifest = JSON.parse(await zip.file("manifest.json").async("string"));
  assert.equal(manifest.exportedAt, "2026-08-23T19:30:00.000Z");
  assert.equal(manifest.includes.canonicalDatabase, true);
  assert.equal(manifest.excludes.savedAiCredentials, true);

  const extractedDb = join(repoRoot, "exported.db");
  writeFileSync(extractedDb, await zip.file("database/careerrat.db").async("nodebuffer"));
  const snapshot = new DatabaseSync(extractedDb, { readOnly: true });
  try {
    assert.equal(
      snapshot.prepare("SELECT COUNT(*) AS count FROM job_thread_messages").get().count,
      1
    );
  } finally {
    snapshot.close();
  }
});

test("export everything retries when canonical state changes while files are being captured", async () => {
  const repoRoot = mkdtempSync(join(tmpdir(), "careerrat-workspace-export-retry-"));
  roots.push(repoRoot);
  openDb({ repoRoot, env: {} });
  appUpsert({
    repoRoot,
    env: {},
    row: { id: "app-1", company: "Aperture", role: "Engineer", status: "interview" },
  });

  let reads = 0;
  const result = await buildWorkspaceExport({
    repoRoot,
    env: {},
    now: new Date("2026-08-23T20:00:00Z"),
    afterFilesRead() {
      reads += 1;
      if (reads !== 1) return;
      appUpsert({
        repoRoot,
        env: {},
        row: { id: "app-2", company: "Black Mesa", role: "Researcher", status: "applied" },
      });
    },
  });

  assert.equal(reads, 2);
  const zip = await JSZip.loadAsync(result.buffer);
  const tracker = JSON.parse(await zip.file("workspace/tracker.json").async("string"));
  assert.deepEqual(tracker.applications.map((application) => application.id).sort(), [
    "app-1",
    "app-2",
  ]);

  const extractedDb = join(repoRoot, "retried-export.db");
  writeFileSync(extractedDb, await zip.file("database/careerrat.db").async("nodebuffer"));
  const snapshot = new DatabaseSync(extractedDb, { readOnly: true });
  try {
    assert.equal(snapshot.prepare("SELECT COUNT(*) AS count FROM applications").get().count, 2);
    assert.equal(
      snapshot.prepare("SELECT version FROM meta WHERE id = 1").get().version,
      tracker.meta.version
    );
  } finally {
    snapshot.close();
  }
});

test("export everything fails clearly when canonical state never stays stable", async () => {
  const repoRoot = mkdtempSync(join(tmpdir(), "careerrat-workspace-export-busy-"));
  roots.push(repoRoot);
  openDb({ repoRoot, env: {} });
  appUpsert({
    repoRoot,
    env: {},
    row: { id: "app-1", company: "Aperture", role: "Engineer", status: "interview" },
  });

  let writes = 0;
  await assert.rejects(
    buildWorkspaceExport({
      repoRoot,
      env: {},
      maxAttempts: 2,
      afterFilesRead() {
        writes += 1;
        appUpsert({
          repoRoot,
          env: {},
          row: {
            id: `app-${writes + 1}`,
            company: `Company ${writes + 1}`,
            role: "Engineer",
            status: "applied",
          },
        });
      },
    }),
    (error) => error?.code === "EXPORT_BUSY"
  );
  assert.equal(writes, 2);
});
