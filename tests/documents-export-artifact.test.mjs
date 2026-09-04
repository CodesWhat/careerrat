// tests/documents-export-artifact.test.mjs
// node:test suite for exportArtifact's "text" format output confinement
// (src/core/documents/export.mjs): a resolved-destination-stays-inside-the-
// packet-directory guard plus a symlink-safe atomic write.

import assert from "node:assert/strict";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
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

// ---------------------------------------------------------------------------
// Trusted-root confinement: an ancestor symlink must not bypass the check
// ---------------------------------------------------------------------------

test("exportArtifact writes inside a passed trusted root when the destination genuinely resolves inside it", async () => {
  const workspaceDir = tempDir("careerrat-export-workspace-");
  const packetDir = join(workspaceDir, "tailored");
  mkdirSync(packetDir, { recursive: true });
  const outBase = join(packetDir, "resume");

  const result = await exportArtifact({
    markdown: "# Resume\n\nRendered body.\n",
    outBase,
    formats: ["text"],
    root: workspaceDir,
  });

  // The destination's parent is written via its realpath()-canonicalized
  // form, which on macOS may differ from the lexical outBase (/var vs.
  // /private/var), so compare through realpath on both sides.
  assert.equal(realpathSync(result.text), `${realpathSync(packetDir)}/resume.txt`);
  assert.match(readFileSync(result.text, "utf8"), /Rendered body\./);
});

test("exportArtifact rejects a destination whose ancestor directory is a symlink escaping the trusted root", async () => {
  const workspaceDir = tempDir("careerrat-export-workspace-");
  const outsideDir = tempDir("careerrat-export-outside-");

  // workspace/tailored is a symlink pointing entirely outside the
  // workspace. A lexical containment check on dirname(outBase) alone
  // would see "workspace/tailored/resume" and consider it confined; only
  // realpath()-ing both the root and the destination's parent catches
  // this.
  const tailoredLink = join(workspaceDir, "tailored");
  symlinkSync(outsideDir, tailoredLink);

  const outBase = join(tailoredLink, "resume");
  await assert.rejects(
    () =>
      exportArtifact({
        markdown: "# Resume\n\nRendered body.\n",
        outBase,
        formats: ["text"],
        root: workspaceDir,
      }),
    /escapes the trusted root/
  );

  assert.equal(
    existsSync(join(outsideDir, "resume.txt")),
    false,
    "no artifact was written outside the trusted root"
  );
});
