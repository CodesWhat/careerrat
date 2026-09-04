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
import JSZip from "jszip";
import { exportArtifact, MARKDOWN_SOURCE_MAX_BYTES } from "../src/core/documents/export.mjs";

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

// ---------------------------------------------------------------------------
// Markdown source size cap: exportArtifact is the one shared entry point
// every caller funnels a Markdown source through, so the cap applies before
// any format-specific parsing (parseMdBlocks/parseRuns, the DOCX writer, the
// ATS PDF HTML build) ever runs.
// ---------------------------------------------------------------------------

test("exportArtifact rejects a markdown source over the export size limit before writing anything", async () => {
  const packetDir = tempDir("careerrat-export-oversize-");
  const outBase = join(packetDir, "resume");
  const markdown = "a".repeat(10 * 1024 * 1024);
  assert.ok(markdown.length > MARKDOWN_SOURCE_MAX_BYTES);

  await assert.rejects(
    () => exportArtifact({ markdown, outBase, formats: ["text"] }),
    /exceeds the .* export limit/
  );

  assert.equal(existsSync(`${outBase}.txt`), false, "no file was written for an oversized source");
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

test("exportArtifact's written .txt file joins soft-wrapped source lines into one paragraph", async () => {
  // Regression: the plain-text renderer used to treat every consecutive
  // non-blank source line as its own paragraph, so an ordinary
  // soft-wrapped CommonMark paragraph fragmented into one line per
  // paragraph in the exported .txt file, with a spurious blank line
  // between each fragment. Assert the actual file on disk, not just the
  // in-memory renderer, since a fix could regress in the write path
  // without this catching it.
  const packetDir = tempDir("careerrat-export-softwrap-");
  const outBase = join(packetDir, "resume");

  const result = await exportArtifact({
    markdown:
      "Led payment infrastructure across three regions,\nshipping a rewrite that cut latency by 40%\nwhile keeping the team headcount flat.\n",
    outBase,
    formats: ["text"],
  });

  assert.equal(
    readFileSync(result.text, "utf8"),
    "Led payment infrastructure across three regions, shipping a rewrite that cut latency by 40% while keeping the team headcount flat."
  );
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

// ---------------------------------------------------------------------------
// PDF/DOCX confinement: the same trusted-root and symlink-destination guards
// the text writer already has, applied to the other two formats. Both checks
// run inside renderFormatConfined before the format-specific render callback
// is ever invoked, so these assertions don't need chromium or pandoc
// installed: a rejection here means the renderer was never reached.
// ---------------------------------------------------------------------------

test("exportArtifact rejects a PDF destination whose ancestor directory is a symlink escaping the trusted root", async () => {
  const workspaceDir = tempDir("careerrat-export-workspace-");
  const outsideDir = tempDir("careerrat-export-outside-");

  const tailoredLink = join(workspaceDir, "tailored");
  symlinkSync(outsideDir, tailoredLink);

  const outBase = join(tailoredLink, "resume");
  await assert.rejects(
    () =>
      exportArtifact({
        markdown: "# Resume\n\nRendered body.\n",
        outBase,
        formats: ["pdf"],
        root: workspaceDir,
      }),
    /escapes the trusted root/
  );

  assert.equal(
    existsSync(join(outsideDir, "resume.pdf")),
    false,
    "no PDF was written outside the trusted root"
  );
});

test("exportArtifact rejects a DOCX destination whose ancestor directory is a symlink escaping the trusted root", async () => {
  const workspaceDir = tempDir("careerrat-export-workspace-");
  const outsideDir = tempDir("careerrat-export-outside-");

  const tailoredLink = join(workspaceDir, "tailored");
  symlinkSync(outsideDir, tailoredLink);

  const outBase = join(tailoredLink, "resume");
  await assert.rejects(
    () =>
      exportArtifact({
        markdown: "# Resume\n\nRendered body.\n",
        outBase,
        formats: ["docx"],
        root: workspaceDir,
      }),
    /escapes the trusted root/
  );

  assert.equal(
    existsSync(join(outsideDir, "resume.docx")),
    false,
    "no DOCX was written outside the trusted root"
  );
});

test("exportArtifact refuses a dangling PDF destination symlink instead of following it", async () => {
  const packetDir = tempDir("careerrat-export-packet-");
  const outsideDir = tempDir("careerrat-export-outside-");
  const outsideTarget = join(outsideDir, "secret.pdf");
  // Intentionally does not exist: a dangling symlink still must not be
  // followed, since lstat (not stat) is what refuseSymlinkDestination uses.
  const destPath = join(packetDir, "resume.pdf");
  symlinkSync(outsideTarget, destPath);
  assert.ok(lstatSync(destPath).isSymbolicLink(), "test setup: destination starts as a symlink");

  const outBase = join(packetDir, "resume");
  await assert.rejects(
    () =>
      exportArtifact({
        markdown: "# Resume\n\nRendered body.\n",
        outBase,
        formats: ["pdf"],
      }),
    /refusing to write/
  );

  assert.equal(
    lstatSync(destPath).isSymbolicLink(),
    true,
    "the dangling symlink was left in place, not followed or replaced"
  );
  assert.equal(
    existsSync(outsideTarget),
    false,
    "nothing was created at the dangling symlink target"
  );
});

test("exportArtifact refuses a dangling DOCX destination symlink instead of following it", async () => {
  const packetDir = tempDir("careerrat-export-packet-");
  const outsideDir = tempDir("careerrat-export-outside-");
  const outsideTarget = join(outsideDir, "secret.docx");
  const destPath = join(packetDir, "resume.docx");
  symlinkSync(outsideTarget, destPath);
  assert.ok(lstatSync(destPath).isSymbolicLink(), "test setup: destination starts as a symlink");

  const outBase = join(packetDir, "resume");
  await assert.rejects(
    () =>
      exportArtifact({
        markdown: "# Resume\n\nRendered body.\n",
        outBase,
        formats: ["docx"],
      }),
    /refusing to write/
  );

  assert.equal(
    lstatSync(destPath).isSymbolicLink(),
    true,
    "the dangling symlink was left in place, not followed or replaced"
  );
  assert.equal(
    existsSync(outsideTarget),
    false,
    "nothing was created at the dangling symlink target"
  );
});

test("exportArtifact's built-in OOXML DOCX writer serializes both hard-break forms as <w:br/>, not a literal newline", async () => {
  // Regression: hard breaks (a two-space trailing line, or a trailing
  // backslash) became newline-only text runs, and runsToWml serialized
  // every run as <w:t>. WordprocessingML has no text-based line break: a
  // raw "\n" inside <w:t> is just whitespace to Word, never a forced
  // break, so a fallback DOCX export (no pandoc/soffice) silently collapsed
  // an address or contact block onto one line. Force the built-in path by
  // clearing PATH so detectDocxCapability finds neither pandoc nor soffice.
  const dir = tempDir("careerrat-docx-hardbreak-");
  const savedPath = process.env.PATH;

  try {
    process.env.PATH = "";
    const markdown = "Jordan Rivera  \n123 Main Street\\\nAnytown, ST 00000\n";
    const result = await exportArtifact({
      markdown,
      outBase: join(dir, "resume"),
      formats: ["docx"],
      title: "Resume",
    });

    assert.equal(result.docxTool, "ooxml");

    const documentXml = await (await JSZip.loadAsync(readFileSync(result.docx)))
      .file("word/document.xml")
      .async("string");

    // The two-space hard break (Jordan Rivera -> 123 Main Street) and the
    // backslash hard break (123 Main Street -> Anytown, ST 00000) each
    // become their own <w:br/> run.
    assert.equal(
      (documentXml.match(/<w:br\s*\/>/g) || []).length,
      2,
      "both the two-space and backslash hard breaks must serialize as <w:br/>"
    );
    assert.doesNotMatch(
      documentXml,
      /<w:t[^>]*>[^<]*\n[^<]*<\/w:t>/,
      "no hard break should survive as a raw newline embedded inside a <w:t> run"
    );
    assert.match(documentXml, /<w:t>Jordan Rivera<\/w:t>/);
    assert.match(documentXml, /<w:t>123 Main Street<\/w:t>/);
    assert.match(documentXml, /<w:t>Anytown, ST 00000<\/w:t>/);
  } finally {
    process.env.PATH = savedPath;
  }
});
