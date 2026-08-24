import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

import { closeAll, openDb } from "../src/core/db/connection.mjs";
import { appUpsert } from "../src/core/db/verbs.mjs";

const cleanupRoots = [];

function tempRepo() {
  const repoRoot = mkdtempSync(join(tmpdir(), "careerrat-dossier-pdf-"));
  cleanupRoots.push(repoRoot);
  openDb({ repoRoot });
  return repoRoot;
}

after(() => {
  closeAll();
  for (const root of cleanupRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

async function dossierPdfApi() {
  const api = await import("../src/core/documents/dossier-pdf.mjs").catch(() => ({}));
  assert.equal(typeof api.exportInterviewDossierPdf, "function");
  return api;
}

function seedDossier(repoRoot, { path = "workspace/interview-prep/acme-engineer.md" } = {}) {
  const markdown = "# Acme interview dossier\n\n## Stories\n\nLead with the migration result.";
  appUpsert({
    repoRoot,
    row: {
      id: "app-dossier",
      company: "Acme Corp",
      role: "Staff Engineer",
      status: "interview",
      artifacts: {
        interviewDossier: {
          title: "Acme interview dossier",
          round: "hiring manager",
          path,
          generatedAt: "2026-08-23T16:00:00.000Z",
          markdown,
        },
      },
    },
  });
  return markdown;
}

test("dossier PDF export renders canonical markdown to a real persisted PDF", async () => {
  const api = await dossierPdfApi();
  const repoRoot = tempRepo();
  const markdown = seedDossier(repoRoot);
  const source = join(repoRoot, "workspace", "interview-prep", "acme-engineer.md");
  mkdirSync(join(repoRoot, "workspace", "interview-prep"), { recursive: true });
  writeFileSync(source, markdown, "utf8");
  const renders = [];

  const result = await api.exportInterviewDossierPdf({
    repoRoot,
    applicationId: "app-dossier",
    artifactPath: "workspace/interview-prep/acme-engineer.md",
    renderPdfImpl: async (options) => {
      renders.push(options);
      writeFileSync(options.outPath, `%PDF-1.7\n${options.markdown}\n%%EOF`, "utf8");
      return options.outPath;
    },
  });

  assert.equal(result.applicationId, "app-dossier");
  assert.equal(result.sourcePath, "workspace/interview-prep/acme-engineer.md");
  assert.equal(result.path, "workspace/interview-prep/acme-engineer.pdf");
  assert.equal(result.filename, "acme-engineer.pdf");
  assert.match(result.buffer.toString("utf8"), /^%PDF-/);
  assert.match(readFileSync(join(repoRoot, result.path), "utf8"), /^%PDF-/);
  assert.equal(renders.length, 1);
  assert.equal(renders[0].markdown, markdown);
  assert.equal(renders[0].title, "Acme interview dossier");
});

test("dossier PDF export rejects a non-canonical requested path before rendering", async () => {
  const api = await dossierPdfApi();
  const repoRoot = tempRepo();
  const markdown = seedDossier(repoRoot);
  mkdirSync(join(repoRoot, "workspace", "interview-prep"), { recursive: true });
  writeFileSync(join(repoRoot, "workspace", "interview-prep", "acme-engineer.md"), markdown);
  let renders = 0;

  await assert.rejects(
    api.exportInterviewDossierPdf({
      repoRoot,
      applicationId: "app-dossier",
      artifactPath: "workspace/../candidate/profile.yml",
      renderPdfImpl: async () => {
        renders += 1;
      },
    }),
    (error) => error?.code === "BAD_DOSSIER_ARTIFACT"
  );
  assert.equal(renders, 0);
});

test("dossier PDF export rejects a canonical source symlink that escapes the workspace", async () => {
  const api = await dossierPdfApi();
  const repoRoot = tempRepo();
  seedDossier(repoRoot);
  const outside = join(repoRoot, "outside-dossier.md");
  writeFileSync(outside, "# outside", "utf8");
  mkdirSync(join(repoRoot, "workspace", "interview-prep"), { recursive: true });
  symlinkSync(outside, join(repoRoot, "workspace", "interview-prep", "acme-engineer.md"));

  await assert.rejects(
    api.exportInterviewDossierPdf({
      repoRoot,
      applicationId: "app-dossier",
      renderPdfImpl: async () => {
        throw new Error("renderer must not run");
      },
    }),
    (error) => error?.code === "BAD_DOSSIER_ARTIFACT"
  );
});

test("dossier PDF export requires markdown as the final canonical source extension", async () => {
  const api = await dossierPdfApi();
  const repoRoot = tempRepo();
  seedDossier(repoRoot, { path: "workspace/interview-prep/acme.md.exe" });
  mkdirSync(join(repoRoot, "workspace", "interview-prep"), { recursive: true });
  writeFileSync(join(repoRoot, "workspace", "interview-prep", "acme.md.exe"), "# not markdown");
  let renders = 0;

  await assert.rejects(
    api.exportInterviewDossierPdf({
      repoRoot,
      applicationId: "app-dossier",
      renderPdfImpl: async () => {
        renders += 1;
      },
    }),
    (error) => error?.code === "BAD_DOSSIER_ARTIFACT"
  );
  assert.equal(renders, 0);
});

test("dossier PDF export refuses invalid renderer output and leaves no published PDF", async () => {
  const api = await dossierPdfApi();
  const repoRoot = tempRepo();
  const markdown = seedDossier(repoRoot);
  const output = join(repoRoot, "workspace", "interview-prep", "acme-engineer.pdf");
  mkdirSync(join(repoRoot, "workspace", "interview-prep"), { recursive: true });
  writeFileSync(join(repoRoot, "workspace", "interview-prep", "acme-engineer.md"), markdown);

  await assert.rejects(
    api.exportInterviewDossierPdf({
      repoRoot,
      applicationId: "app-dossier",
      renderPdfImpl: async ({ outPath }) => {
        writeFileSync(outPath, "not a pdf", "utf8");
      },
    }),
    (error) => error?.code === "INVALID_DOSSIER_PDF"
  );
  assert.equal(existsSync(output), false);
});
