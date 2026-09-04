// tests/documents-export-text.test.mjs
// node:test suite for renderResumeText (src/core/documents/export.mjs) — the
// plain-text resume/CV renderer used by the app's export flow's "Plain text
// (.txt)" option.

import assert from "node:assert/strict";
import { test } from "node:test";
import { markdownToHtml, renderResumeText } from "../src/core/documents/export.mjs";

const FIXTURE_RESUME = `# Jordan Rivera

**Staff Engineer** with 10 years building payment systems.

## Experience

- Led the **checkout team** at Example Corp ([case study](https://example.com/case))
- Reduced latency 40% using \`redis\` caching

## Skills

| Skill | Level |
| --- | --- |
| Go | Expert |
| Python | Advanced |

## Education

1. MS Computer Science, State University
2. BS Mathematics, State University
`;

function headingsFromHtml(markdown) {
  const html = markdownToHtml(markdown);
  return [...html.matchAll(/<h[1-6][^>]*>(.*?)<\/h[1-6]>/gs)].map((m) =>
    m[1].replace(/<[^>]+>/g, "").trim()
  );
}

function nonBlankLines(text) {
  return text.split("\n").filter((line) => line.trim() !== "");
}

test("renderResumeText strips every markdown syntax character the fixture exercises", () => {
  const text = renderResumeText(FIXTURE_RESUME);
  assert.doesNotMatch(text, /#/, "no ATX heading markers survive");
  assert.doesNotMatch(text, /\*\*/, "no bold markers survive");
  assert.doesNotMatch(text, /`/, "no backticks survive");
  assert.doesNotMatch(text, /\|/, "no pipe-table syntax survives");
});

test("renderResumeText renders headings in uppercase, separated by blank lines", () => {
  const text = renderResumeText(FIXTURE_RESUME);
  const lines = text.split("\n");

  for (const heading of ["EXPERIENCE", "SKILLS", "EDUCATION"]) {
    const idx = lines.indexOf(heading);
    assert.ok(idx > 0, `expected an uppercase "${heading}" heading line`);
    assert.equal(lines[idx - 1], "", `${heading} should be preceded by a blank line`);
    assert.equal(lines[idx + 1], "", `${heading} should be followed by a blank line`);
  }
});

test("renderResumeText separates sections with blank lines and never doubles them up", () => {
  const text = renderResumeText(FIXTURE_RESUME);
  assert.doesNotMatch(text, /\n\n\n/, "no run of more than one blank line");
  assert.equal(text, text.trim(), "output has no leading or trailing blank lines");
});

test("renderResumeText keeps section order identical to the ATS HTML render's heading order", () => {
  const htmlHeadings = headingsFromHtml(FIXTURE_RESUME).map((h) => h.toUpperCase());
  const text = renderResumeText(FIXTURE_RESUME);
  const textHeadings = nonBlankLines(text).filter((line) => htmlHeadings.includes(line));
  assert.deepEqual(textHeadings, htmlHeadings);
});

test("renderResumeText preserves link destinations as plain text instead of markdown syntax", () => {
  const text = renderResumeText(FIXTURE_RESUME);
  assert.match(text, /case study \(https:\/\/example\.com\/case\)/);
});

test("renderResumeText renders unordered and ordered list items without markdown bullet syntax", () => {
  const text = renderResumeText(FIXTURE_RESUME);
  assert.match(text, /^- Led the checkout team at Example Corp/m);
  assert.match(text, /^1\. MS Computer Science, State University$/m);
  assert.match(text, /^2\. BS Mathematics, State University$/m);
});

test("renderResumeText normalizes smart quotes and em dashes like the ATS PDF/DOCX path", () => {
  const text = renderResumeText("# Bio\n\nBuilt “resilient” systems — end to end.\n");
  assert.doesNotMatch(text, /[“”—–]/);
  assert.match(text, /"resilient" systems - end to end\./);
});

test("renderResumeText on an empty or whitespace-only document returns an empty string", () => {
  assert.equal(renderResumeText(""), "");
  assert.equal(renderResumeText("   \n\n  "), "");
});
