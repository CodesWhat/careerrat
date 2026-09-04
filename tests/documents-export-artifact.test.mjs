// tests/documents-export-artifact.test.mjs
// node:test suite for exportArtifact's "text" format output confinement
// (src/core/documents/export.mjs): a resolved-destination-stays-inside-the-
// packet-directory guard plus a symlink-safe atomic write.

import assert from "node:assert/strict";
import {
  existsSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { exportArtifact } from "../src/core/documents/export.mjs";

const cleanupRoots = [];

function tempDir(prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  cleanupRoots.push(dir);
  return dir;
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

test("exportArtifact rejects an empty outBase instead of writing under process.cwd()", async () => {
  // Reproduces the historical negative-zero bug's output directly:
  // "resume".slice(0, -"".length) === "resume".slice(0, -0) === "".
  const outBase = "resume".slice(0, -"".length);
  assert.equal(outBase, "");

  await assert.rejects(
    () => exportArtifact({ markdown: "# Resume\n\nBody.\n", outBase, formats: ["text"] }),
    /absolute path/
  );
  assert.equal(existsSync(join(process.cwd(), ".txt")), false);
});

test("exportArtifact rejects a relative outBase", async () => {
  await assert.rejects(
    () =>
      exportArtifact({
        markdown: "# Resume\n\nBody.\n",
        outBase: "relative/resume",
        formats: ["text"],
      }),
    /absolute path/
  );
});

test("exportArtifact replaces an existing symlink at the .txt destination instead of following it", async () => {
  const packetDir = tempDir("careerrat-export-packet-");
  const outsideDir = tempDir("careerrat-export-outside-");
  const outsideTarget = join(outsideDir, "secret.txt");
  writeFileSync(outsideTarget, "outside content, must not be touched\n", "utf8");

  const destPath = join(packetDir, "resume.txt");
  symlinkSync(outsideTarget, destPath);
  assert.ok(lstatSync(destPath).isSymbolicLink(), "test setup: destination starts as a symlink");

  const outBase = join(packetDir, "resume");
  const result = await exportArtifact({
    markdown: "# Resume\n\nRendered body.\n",
    outBase,
    formats: ["text"],
  });

  assert.equal(result.text, destPath);
  assert.equal(
    lstatSync(destPath).isSymbolicLink(),
    false,
    "the symlink was replaced, not followed"
  );
  assert.match(readFileSync(destPath, "utf8"), /Rendered body\./);
  assert.equal(
    readFileSync(outsideTarget, "utf8"),
    "outside content, must not be touched\n",
    "the symlink target outside the packet dir is untouched"
  );
});

test("exportArtifact writes the text artifact inside the packet directory", async () => {
  const packetDir = tempDir("careerrat-export-packet-");
  const outBase = join(packetDir, "cover-letter");

  const result = await exportArtifact({
    markdown: "Dear team,\n\nThank you.\n",
    outBase,
    formats: ["text"],
  });

  assert.equal(result.text, `${outBase}.txt`);
  assert.match(readFileSync(result.text, "utf8"), /Thank you\./);
});
