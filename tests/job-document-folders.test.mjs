import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { closeAll, openDb } from "../src/core/db/connection.mjs";
import {
  appApplySyncedStatus,
  appRecordOutcome,
  appSetStatus,
  appUpsert,
} from "../src/core/db/verbs.mjs";
import { jobDocumentPaths } from "../src/core/documents/job-folders.mjs";

function fixture(t) {
  const repoRoot = mkdtempSync(join(tmpdir(), "careerrat-job-documents-"));
  const env = { CAREERRAT_DOWNLOADS_DIR: join(repoRoot, "documents") };
  mkdirSync(join(repoRoot, "workspace"));
  mkdirSync(join(repoRoot, "fixture-source"));
  writeFileSync(
    join(repoRoot, "fixture-source/tracker.json"),
    JSON.stringify({
      meta: {},
      applications: [],
      sourced: [],
      sources: [],
      communications: [],
    })
  );
  t.after(() => {
    closeAll();
    rmSync(repoRoot, { recursive: true, force: true });
  });
  return { repoRoot, env };
}

async function seeded(t) {
  const ctx = fixture(t);
  const { importFromTracker } = await import("../src/core/db/import-from-tracker.mjs");
  importFromTracker({ ...ctx, sourceDir: join(ctx.repoRoot, "fixture-source") });
  for (const id of ["role-a", "role-b"]) {
    appUpsert({
      ...ctx,
      row: {
        id,
        company: "Acme",
        role: id,
        status: "interview",
        artifacts: { resumePdf: `workspace/tailored/${id}.pdf` },
        conversations: [{ kind: "screen", notes: "Saved interview context" }],
      },
    });
    const path = join(ctx.env.CAREERRAT_DOWNLOADS_DIR, "Acme", `job-${id}`, "Resume.pdf");
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, id);
    writeFileSync(join(dirname(path), "Interview Notes.md"), `${id} interview notes`);
  }
  const source = join(ctx.repoRoot, "workspace/tailored/role-a.pdf");
  mkdirSync(dirname(source), { recursive: true });
  writeFileSync(source, "canonical resume");
  return { ...ctx, source };
}

for (const [name, change] of [
  ["status update", (ctx) => appSetStatus({ ...ctx, id: "role-a", to: "rejected" })],
  ["recorded outcome", (ctx) => appRecordOutcome({ ...ctx, id: "role-a", to: "rejected" })],
  ["portal sync", (ctx) => appApplySyncedStatus({ ...ctx, id: "role-a", to: "rejected" })],
  [
    "application upsert",
    (ctx) =>
      appUpsert({
        ...ctx,
        row: {
          ...JSON.parse(
            openDb(ctx).prepare("SELECT data FROM applications WHERE id = 'role-a'").get().data
          ),
          status: "withdrawn",
        },
      }),
  ],
]) {
  test(`${name} archives only the ended job and preserves its canonical history`, async (t) => {
    const ctx = await seeded(t);
    const result = change(ctx);
    const root = ctx.env.CAREERRAT_DOWNLOADS_DIR;
    assert.equal(existsSync(join(root, "Acme/job-role-a")), false);
    assert.equal(readFileSync(join(root, "_archive/Acme/job-role-a/Resume.pdf"), "utf8"), "role-a");
    assert.equal(readFileSync(join(root, "Acme/job-role-b/Resume.pdf"), "utf8"), "role-b");
    assert.equal(readFileSync(ctx.source, "utf8"), "canonical resume");
    assert.equal(
      readFileSync(join(root, "_archive/Acme/job-role-a/Interview Notes.md"), "utf8"),
      "role-a interview notes"
    );
    assert.equal(result.documentFolder.archived, true);
    const db = openDb(ctx);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM applications").get().count, 2);
    const saved = JSON.parse(
      db.prepare("SELECT data FROM applications WHERE id = 'role-a'").get().data
    );
    assert.equal(saved.artifacts.resumePdf, "workspace/tailored/role-a.pdf");
    assert.equal(saved.conversations[0].notes, "Saved interview context");
  });
}

test("reopening a rejected job restores its folder, including round history", async (t) => {
  const ctx = await seeded(t);
  const root = ctx.env.CAREERRAT_DOWNLOADS_DIR;
  const prior = join(root, "Acme/job-role-a/archive/Resume.pdf");
  mkdirSync(dirname(prior), { recursive: true });
  writeFileSync(prior, "prior round");
  appSetStatus({ ...ctx, id: "role-a", to: "rejected" });
  assert.equal(existsSync(join(root, "_archive/Acme/job-role-a/Resume.pdf")), true);
  appSetStatus({ ...ctx, id: "role-a", to: "rejected" });
  const result = appSetStatus({ ...ctx, id: "role-a", to: "interview" });
  assert.equal(existsSync(join(root, "_archive/Acme/job-role-a")), false);
  assert.equal(readFileSync(prior, "utf8"), "prior round");
  assert.equal(result.documentFolder.archived, false);
});

test("archive conflicts preserve both folders and report that the outcome was saved", async (t) => {
  const ctx = await seeded(t);
  const root = ctx.env.CAREERRAT_DOWNLOADS_DIR;
  const archived = join(root, "_archive/Acme/job-role-a/Resume.pdf");
  mkdirSync(dirname(archived), { recursive: true });
  writeFileSync(archived, "existing archive");
  assert.throws(
    () => appSetStatus({ ...ctx, id: "role-a", to: "rejected" }),
    (error) => {
      assert.equal(error.code, "DOCUMENT_FOLDER_SYNC_FAILED");
      assert.equal(error.committed, true);
      assert.match(error.message, /outcome.*saved/i);
      return true;
    }
  );
  assert.equal(readFileSync(archived, "utf8"), "existing archive");
  assert.equal(readFileSync(join(root, "Acme/job-role-a/Resume.pdf"), "utf8"), "role-a");
  const row = openDb(ctx).prepare("SELECT data FROM applications WHERE id = 'role-a'").get();
  assert.equal(JSON.parse(row.data).status, "rejected");
});

test("a rolled-back outcome never moves files", async (t) => {
  const ctx = await seeded(t);
  openDb(ctx).exec(`CREATE TRIGGER refuse_status BEFORE UPDATE ON applications
    BEGIN SELECT RAISE(ABORT, 'fixture rollback'); END`);
  assert.throws(() => appSetStatus({ ...ctx, id: "role-a", to: "rejected" }), /fixture rollback/);
  assert.equal(
    existsSync(join(ctx.env.CAREERRAT_DOWNLOADS_DIR, "Acme/job-role-a/Resume.pdf")),
    true
  );
  assert.equal(existsSync(join(ctx.env.CAREERRAT_DOWNLOADS_DIR, "_archive")), false);
});

test("a committed outcome still archives files when only the tracker mirror fails", async (t) => {
  const ctx = await seeded(t);
  const tracker = join(ctx.repoRoot, "workspace/tracker.json");
  rmSync(tracker, { force: true });
  mkdirSync(tracker);
  assert.throws(
    () => appSetStatus({ ...ctx, id: "role-a", to: "rejected" }),
    (error) => {
      assert.equal(error.code, "EXPORT_FAILED");
      assert.equal(error.committed, true);
      assert.equal(error.result.documentFolder.archived, true);
      return true;
    }
  );
  assert.equal(
    existsSync(join(ctx.env.CAREERRAT_DOWNLOADS_DIR, "_archive/Acme/job-role-a/Resume.pdf")),
    true
  );
});

test("company folder names are safe Windows path segments", () => {
  const env = { CAREERRAT_DOWNLOADS_DIR: join(tmpdir(), "careerrat-segment-docs") };
  const name = (company) =>
    jobDocumentPaths({ application: { id: "j1", company }, env }).companyName;
  assert.equal(name("Acme: Inc"), "Acme- Inc");
  assert.equal(name("A|B?C*"), "A-B-C-");
  assert.equal(name("Trailing. "), "Trailing");
  assert.equal(name("con"), "_con");
  assert.equal(name("COM1"), "_COM1");
  assert.equal(name("nul.txt"), "_nul.txt");
  assert.equal(name("Bad\u0001Name"), "Bad-Name");
  assert.equal(name(".."), "unknown");
  assert.equal(name("Acme"), "Acme");
});

test("ordinary company names keep their existing folder path", () => {
  const env = { CAREERRAT_DOWNLOADS_DIR: join(tmpdir(), "careerrat-segment-docs") };
  const { active } = jobDocumentPaths({ application: { id: "role-a", company: "Acme Corp" }, env });
  assert.equal(active, join(env.CAREERRAT_DOWNLOADS_DIR, "Acme Corp", "job-role-a"));
});
