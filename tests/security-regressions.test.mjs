import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import JSZip from "jszip";
import mammoth from "mammoth";
import { extractDocxResumeMarkdown } from "../src/core/onboarding/resume-docx.mjs";
import { trimEdgeCharacter } from "../src/core/text/slug.mjs";

async function smallDocx() {
  const zip = new JSZip();
  zip.file("word/document.xml", "<w:document/>");
  return zip.generateAsync({ type: "nodebuffer" });
}

test("DOCX HTML fallback decodes entities once and omits active-content bodies", async () => {
  const convertToMarkdown = mammoth.convertToMarkdown;
  const convertToHtml = mammoth.convertToHtml;
  mammoth.convertToMarkdown = undefined;
  mammoth.convertToHtml = async () => ({
    value:
      '<p><a href="https://example.test/me"><strong>Profile</strong></a></p>' +
      "<p>&amp;lt;script&amp;gt;</p><script >ignore me</script >",
  });

  try {
    const text = await extractDocxResumeMarkdown(await smallDocx());
    assert.equal(text, "Profile (https://example.test/me)\n&lt;script&gt;");
  } finally {
    mammoth.convertToMarkdown = convertToMarkdown;
    mammoth.convertToHtml = convertToHtml;
  }
});

test("slug normalization avoids the ambiguous repeated-edge alternation", () => {
  for (const path of ["src/core/ai/usage-log.mjs", "src/core/scoring/sourced-persistence.mjs"]) {
    const source = readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
    assert.doesNotMatch(source, /replace\(\/\^-\+\|-\+\$\/g/);
  }
});

test("edge-character trimming is linear and preserves interior separators", () => {
  assert.equal(trimEdgeCharacter("---career---rat---", "-"), "career---rat");
  assert.equal(trimEdgeCharacter("-----", "-"), "");
  assert.equal(trimEdgeCharacter("career-rat", "-"), "career-rat");
});
