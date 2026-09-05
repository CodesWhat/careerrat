// tests/documents-artifact-validation.test.mjs
// node:test suite for validDocumentArtifact's plain-text branch
// (src/core/documents/artifact-validation.mjs) — the UTF-8 decode check that
// rejects a corrupt/binary .txt artifact registered under a text extension.
// Also covers validUploadArtifact, the stricter sibling that restricts
// apply-driver's automatic-upload candidates to pdf/docx only.

import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import {
  validDocumentArtifact,
  validUploadArtifact,
} from "../src/core/documents/artifact-validation.mjs";

const cleanupRoots = [];

function tempDir() {
  const dir = mkdtempSync(join(tmpdir(), "careerrat-artifact-validation-"));
  cleanupRoots.push(dir);
  return dir;
}

function writeTxt(bytes) {
  const dir = tempDir();
  const path = join(dir, "artifact.txt");
  writeFileSync(path, bytes);
  return path;
}

after(() => {
  for (const root of cleanupRoots.splice(0)) {
    try {
      rmSync(root, { recursive: true, force: true });
    } catch {
      // best-effort cleanup
    }
  }
});

test("validDocumentArtifact accepts valid multibyte UTF-8 text", () => {
  const path = writeTxt(Buffer.from("Résumé, 你好, world 🎉\n", "utf8"));
  assert.equal(validDocumentArtifact(path), true);
});

test("validDocumentArtifact rejects a buffer containing an invalid UTF-8 lead byte (0xff)", () => {
  const path = writeTxt(Buffer.from([0x48, 0x69, 0xff, 0x0a])); // "Hi" + 0xFF + "\n"
  assert.equal(validDocumentArtifact(path), false);
});

test("validDocumentArtifact rejects a truncated multibyte UTF-8 sequence", () => {
  // 0xE2 0x82 0xAC is the 3-byte encoding of "€"; drop the last byte so the
  // sequence is truncated mid-character.
  const path = writeTxt(Buffer.from([0x48, 0x69, 0xe2, 0x82]));
  assert.equal(validDocumentArtifact(path), false);
});

test("validDocumentArtifact rejects text containing a NUL byte", () => {
  const path = writeTxt(Buffer.from([0x48, 0x69, 0x00, 0x0a]));
  assert.equal(validDocumentArtifact(path), false);
});

test("validDocumentArtifact rejects an empty file", () => {
  const path = writeTxt(Buffer.alloc(0));
  assert.equal(validDocumentArtifact(path), false);
});

// ---------------------------------------------------------------------------
// validUploadArtifact: restricts the apply-driver's automatic-upload
// candidates to pdf/docx even though validDocumentArtifact accepts a valid
// .txt export for rendering/registration.
// ---------------------------------------------------------------------------

test("validUploadArtifact rejects a well-formed .txt artifact that validDocumentArtifact accepts", () => {
  // Regression: apply-driver's upload candidates fall back to
  // artifacts.resume (the raw stored source, frequently a .txt Markdown
  // file) whenever no PDF or DOCX exists. That source is fine to export
  // and register, but was never meant to be handed to an ATS upload
  // control as-is.
  const path = writeTxt(Buffer.from("# Resume\n\nMarkdown source body.\n", "utf8"));
  assert.equal(validDocumentArtifact(path), true, "still a valid export/registration artifact");
  assert.equal(validUploadArtifact(path), false, "never a valid automatic-upload candidate");
});

test("validUploadArtifact accepts a well-formed PDF", () => {
  const dir = tempDir();
  const path = join(dir, "artifact.pdf");
  writeFileSync(path, "%PDF-1.4\nfake pdf\n%%EOF\n", "utf8");
  assert.equal(validUploadArtifact(path), true);
});

test("validUploadArtifact rejects a corrupt PDF the same way validDocumentArtifact does", () => {
  const dir = tempDir();
  const path = join(dir, "artifact.pdf");
  writeFileSync(path, "not actually a pdf\n", "utf8");
  assert.equal(validUploadArtifact(path), false);
});
