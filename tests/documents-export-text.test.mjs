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

// Test-only: pulls heading text out of the rendered HTML. Tags are removed
// until none remain, so a tag split across another tag cannot survive.
function stripTags(html) {
  let text = html;
  let previous;
  do {
    previous = text;
    text = text.replace(/<[^>]*>/g, "");
  } while (text !== previous);
  return text;
}

function headingsFromHtml(markdown) {
  const html = markdownToHtml(markdown);
  return [...html.matchAll(/<h[1-6][^>]*>(.*?)<\/h[1-6]>/gs)].map((m) => stripTags(m[1]).trim());
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

// ---------------------------------------------------------------------------
// Nested and mixed lists
// ---------------------------------------------------------------------------

test("renderResumeText preserves depth and numbering for a mixed nested list", () => {
  const text = renderResumeText("1. parent\n   - child\n2. next\n");
  const lines = text.split("\n");
  assert.deepEqual(lines, ["1. parent", "  - child", "2. next"]);
});

test("renderResumeText restarts a nested ordered list's counter under each new parent", () => {
  const text = renderResumeText(
    ["1. Fruit", "   1. Apple", "   2. Banana", "2. Veg", "   1. Carrot"].join("\n")
  );
  const lines = text.split("\n");
  assert.deepEqual(lines, ["1. Fruit", "  1. Apple", "  2. Banana", "2. Veg", "  1. Carrot"]);
});

test("renderResumeText honors an ordered list's declared start number", () => {
  const text = renderResumeText("5. fifth\n6. sixth\n");
  const lines = text.split("\n");
  assert.deepEqual(lines, ["5. fifth", "6. sixth"]);
});

// ---------------------------------------------------------------------------
// Table rows: escape-aware pipe splitting
// ---------------------------------------------------------------------------

test("renderResumeText keeps an escaped pipe as a literal character inside a table cell", () => {
  const text = renderResumeText("| Language | Level |\n| --- | --- |\n| C\\|C++ | Advanced |\n");
  assert.match(text, /^C\|C\+\+ {3}Advanced$/m);
});

// ---------------------------------------------------------------------------
// Links: balanced parentheses and escapes in the destination
// ---------------------------------------------------------------------------

test("renderResumeText keeps a link destination with balanced parentheses intact", () => {
  const text = renderResumeText("[case study](https://example.com/foo_(bar)_baz)\n");
  assert.match(text, /case study \(https:\/\/example\.com\/foo_\(bar\)_baz\)/);
  assert.doesNotMatch(text, /_baz\)\)/, "the underscore suffix must not be reparsed as italics");
});

test("renderResumeText unescapes a backslash-escaped parenthesis inside a link destination", () => {
  const text = renderResumeText("[note](https://example.com/a\\(1\\).html)\n");
  assert.match(text, /note \(https:\/\/example\.com\/a\(1\)\.html\)/);
});

// ---------------------------------------------------------------------------
// Headings: uppercase visible text only, never a link destination
// ---------------------------------------------------------------------------

test("renderResumeText uppercases heading text but preserves a link destination's case", () => {
  const text = renderResumeText("## [CaseStudy](https://Example.com/Path?Q=Value)\n");
  assert.match(text, /^CASESTUDY \(https:\/\/Example\.com\/Path\?Q=Value\)$/m);
});

// ---------------------------------------------------------------------------
// Fenced code: strip leading ATX markers, copy everything else verbatim
// ---------------------------------------------------------------------------

test("renderResumeText strips a leading ATX marker from a fenced heading-shaped line", () => {
  const text = renderResumeText("```\n# Heading\nplain code line\n```\n");
  const lines = text.split("\n");
  assert.ok(lines.includes("Heading"), "the ATX marker is stripped");
  assert.ok(!lines.some((line) => line.startsWith("#")), "no line starts with a heading marker");
  assert.ok(lines.includes("plain code line"), "non-heading fenced content is untouched");
});

test("renderResumeText leaves non-heading fenced content byte-for-byte", () => {
  const text = renderResumeText("```\nconst x = 1; // #hashtag\n```\n");
  assert.match(text, /^const x = 1; \/\/ #hashtag$/m);
});

test("renderResumeText strips a tab-separated ATX marker from a fenced heading-shaped line", () => {
  const text = renderResumeText("```\n#\tHeading\n```\n");
  const lines = text.split("\n");
  assert.ok(lines.includes("Heading"), "the ATX marker is stripped");
  assert.ok(!lines.some((line) => line.startsWith("#")), "no line starts with a heading marker");
});

// ---------------------------------------------------------------------------
// Nested inline formatting: bold/link/italic combined
// ---------------------------------------------------------------------------

test("renderResumeText resolves a bold link (bold outside) without leaking markdown syntax", () => {
  const text = renderResumeText("**[Example](https://example.com)**\n");
  assert.match(text, /^Example \(https:\/\/example\.com\)$/m);
  assert.doesNotMatch(text, /[*[\]]/);
});

test("renderResumeText resolves a bold link (bold inside) without leaking markdown syntax", () => {
  const text = renderResumeText("[**Example**](https://example.com)\n");
  assert.match(text, /^Example \(https:\/\/example\.com\)$/m);
  assert.doesNotMatch(text, /[*[\]]/);
});

test("renderResumeText appends a mixed-formatting link label's URL once, not once per formatting run", () => {
  // Regression: a link label with mixed plain/bold/italic text (e.g.
  // "Read **Example** docs") recurses into three runs — plain, bold,
  // plain — all stamped with the same href. Flattening run-by-run used to
  // append the destination after every run instead of once per link.
  const text = renderResumeText("[Read **Example** docs](https://example.com)\n");
  assert.match(text, /^Read Example docs \(https:\/\/example\.com\)$/m);
  const occurrences = text.match(/https:\/\/example\.com/g) || [];
  assert.equal(occurrences.length, 1, "the destination must appear exactly once");
});

test("renderResumeText appends a mixed plain/italic/bold link label's URL once in body text", () => {
  const text = renderResumeText(
    "See the [full *architecture* review and **appendix**](https://example.com/doc) for details.\n"
  );
  assert.match(
    text,
    /^See the full architecture review and appendix \(https:\/\/example\.com\/doc\) for details\.$/m
  );
  const occurrences = text.match(/https:\/\/example\.com\/doc/g) || [];
  assert.equal(occurrences.length, 1, "the destination must appear exactly once");
});

test("renderResumeText appends a mixed-formatting link label's URL once in a heading, uppercased and case-preserved", () => {
  const text = renderResumeText("## [Read **Example** Docs](https://Example.com/Path)\n");
  assert.match(text, /^READ EXAMPLE DOCS \(https:\/\/Example\.com\/Path\)$/m);
  const occurrences = text.match(/https:\/\/Example\.com\/Path/g) || [];
  assert.equal(occurrences.length, 1, "the destination must appear exactly once, case preserved");
});

// ---------------------------------------------------------------------------
// Lists: a same-depth type change resets the ordered counter
// ---------------------------------------------------------------------------

test("renderResumeText restarts the ordered counter after an intervening bullet at the same depth", () => {
  const text = renderResumeText("1. one\n- bullet\n5. five\n");
  const lines = text.split("\n");
  assert.deepEqual(lines, ["1. one", "- bullet", "5. five"]);
});

// ---------------------------------------------------------------------------
// Table rows: backslash-run parity for escaped pipes
// ---------------------------------------------------------------------------

test("renderResumeText treats one preceding backslash as escaping the pipe", () => {
  const text = renderResumeText("| Language | Level |\n| --- | --- |\n| C\\|C++ | Advanced |\n");
  assert.match(text, /^C\|C\+\+ {3}Advanced$/m);
});

test("renderResumeText treats two preceding backslashes as not escaping the pipe", () => {
  const text = renderResumeText("| Language | Level |\n| --- | --- |\n| C\\\\|C++ | Advanced |\n");
  assert.match(text, /^C\\\\ {3}C\+\+ {3}Advanced$/m);
});

test("renderResumeText treats three preceding backslashes as escaping the pipe again", () => {
  const text = renderResumeText(
    "| Language | Level |\n| --- | --- |\n| C\\\\\\|C++ | Advanced |\n"
  );
  assert.match(text, /^C\\\\\|C\+\+ {3}Advanced$/m);
});

// ---------------------------------------------------------------------------
// Soft-wrapped paragraphs: consecutive non-blank lines join into one
// paragraph instead of fragmenting into one paragraph per source line.
// ---------------------------------------------------------------------------

test("renderResumeText joins consecutive soft-wrapped source lines into a single paragraph", () => {
  const text = renderResumeText(
    "Led payment infrastructure across three regions,\nshipping a rewrite that cut latency by 40%\nwhile keeping the team headcount flat.\n"
  );
  assert.equal(
    text,
    "Led payment infrastructure across three regions, shipping a rewrite that cut latency by 40% while keeping the team headcount flat."
  );
});

test("renderResumeText still separates a blank-line-delimited paragraph from the one before it", () => {
  const text = renderResumeText("First paragraph line one,\nline two.\n\nSecond paragraph.\n");
  assert.equal(text, "First paragraph line one, line two.\n\nSecond paragraph.");
});

test("renderResumeText preserves an explicit trailing-two-space hard break inside a paragraph", () => {
  const text = renderResumeText("123 Main Street  \nAnytown, ST 00000\n");
  assert.equal(text, "123 Main Street\nAnytown, ST 00000");
});

test("renderResumeText preserves an explicit trailing-backslash hard break inside a paragraph", () => {
  const text = renderResumeText("123 Main Street\\\nAnytown, ST 00000\n");
  assert.equal(text, "123 Main Street\nAnytown, ST 00000");
});

test("renderResumeText keeps a heading immediately followed by prose from merging into the heading", () => {
  const text = renderResumeText("## Summary\nStaff engineer with 10 years of experience.\n");
  assert.equal(text, "SUMMARY\n\nStaff engineer with 10 years of experience.");
});

// ---------------------------------------------------------------------------
// Inline markdown spanning a soft break: parseMdBlocks used to call
// parseRuns once per source line and join the resulting runs afterward, so
// an inline construct whose delimiters land on different lines (a soft
// wrap in the middle of **bold**, *italic*, `code`, or a [link](url)) could
// never resolve, because each line was parsed before either delimiter's
// partner existed. It now assembles the whole paragraph's raw text first
// (soft breaks folded to a space) and parses it once.
// ---------------------------------------------------------------------------

test("renderResumeText resolves bold spanning a soft break instead of leaking ** markers", () => {
  const text = renderResumeText("Built **cross-region\npayments** systems.\n");
  assert.equal(text, "Built cross-region payments systems.");
});

test("renderResumeText resolves italic spanning a soft break instead of leaking * markers", () => {
  const text = renderResumeText("Ran *a multi-region\nfailover drill* last quarter.\n");
  assert.equal(text, "Ran a multi-region failover drill last quarter.");
});

test("renderResumeText resolves a code span spanning a soft break instead of leaking backticks", () => {
  const text = renderResumeText("Deployed via `terraform\napply` in CI.\n");
  assert.equal(text, "Deployed via terraform apply in CI.");
});

test("renderResumeText resolves a link whose label spans a soft break instead of leaking [] and () syntax", () => {
  const text = renderResumeText(
    "See [the engineering\nblog post](https://example.com/post) for detail.\n"
  );
  assert.equal(text, "See the engineering blog post (https://example.com/post) for detail.");
});

test("renderResumeText keeps an explicit hard break intact alongside a bold span that starts on the next line", () => {
  const text = renderResumeText("123 Main Street  \n**Anytown, ST 00000**\n");
  assert.equal(text, "123 Main Street\nAnytown, ST 00000");
});

// ---------------------------------------------------------------------------
// List item continuation lines: a soft-wrapped line indented under a list
// item belongs to that item's text, not a detached paragraph.
// ---------------------------------------------------------------------------

test("renderResumeText joins an indented continuation line into the same unordered bullet", () => {
  const text = renderResumeText("- Led migration across\n  three regions.\n");
  assert.equal(text, "- Led migration across three regions.");
});

test("renderResumeText joins an indented continuation line into the same ordered item", () => {
  const text = renderResumeText("1. Led migration across\n   three regions.\n");
  assert.equal(text, "1. Led migration across three regions.");
});

test("renderResumeText preserves an explicit hard break inside a list item's continuation", () => {
  const text = renderResumeText("- Line one  \n  Line two.\n");
  assert.equal(text, "- Line one\nLine two.");
});

test("renderResumeText ends a list item's continuation at a blank line instead of merging past it", () => {
  const text = renderResumeText("- Led migration across\n\nSeparate paragraph.\n");
  assert.equal(text, "- Led migration across\n\nSeparate paragraph.");
});

test("renderResumeText treats an indented continuation as its own nested item, not a merge, once it matches a list marker", () => {
  const text = renderResumeText("- Parent item\n  - Nested item\n");
  const lines = text.split("\n");
  assert.deepEqual(lines, ["- Parent item", "  - Nested item"]);
});

// ---------------------------------------------------------------------------
// parseRuns scaling: a paragraph with many inline constructs must parse in
// O(n), not the O(n^2) the old repeated-regex-scan-over-a-shrinking-suffix
// approach produced (reported at ~7.7s for a 256 KB paragraph).
// ---------------------------------------------------------------------------

test("renderResumeText parses a paragraph with many inline constructs, at scale, well under a second", () => {
  const unit =
    "Built **cross-region** payments *fast* using `redis` and a [status page](https://example.com/status) to track it. ";
  const repeats = Math.ceil((256 * 1024) / unit.length);
  const md = unit.repeat(repeats);
  assert.ok(md.length >= 256 * 1024);

  const start = Date.now();
  const text = renderResumeText(md);
  const elapsedMs = Date.now() - start;

  assert.doesNotMatch(
    text,
    /\*\*|`|\[|\]/,
    "every inline construct resolves; none leaks its markdown syntax"
  );
  assert.match(text, /status page \(https:\/\/example\.com\/status\)/);
  assert.ok(elapsedMs < 500, `expected parsing to finish well under a second, took ${elapsedMs}ms`);
});

// ---------------------------------------------------------------------------
// matchLinkAt scaling: a link destination that never finds its closing ")"
// used to rescan from that "(" all the way to end of text on every attempt.
// Many such attempts in one paragraph made that O(n^2): each of m
// unterminated destinations rescanned the remaining ~n characters. The fix
// (parenDeltaPrefixSums/nextEqualPrefixSum) resolves "does this destination
// ever close, and where" as an O(1) lookup instead.
// ---------------------------------------------------------------------------

test("renderResumeText resolves a malformed-link paragraph with unterminated destinations, at scale, well under a second", () => {
  // Every unit opens a real "[label](" but the destination never closes —
  // there is no ")" anywhere in the whole 256 KB paragraph — so a naive
  // rescan-to-EOF on each one would be quadratic.
  const unit =
    "Built cross-region payments and cited a broken reference [see docs](internal link that never closes for detail. ";
  const repeats = Math.ceil((256 * 1024) / unit.length);
  const md = unit.repeat(repeats);
  assert.ok(md.length >= 256 * 1024);
  assert.equal(md.includes(")"), false, "the destination must never close in this fixture");

  const start = Date.now();
  const text = renderResumeText(md);
  const elapsedMs = Date.now() - start;

  assert.ok(
    text.includes("[see docs](internal"),
    "an unresolved link with no closing paren stays literal text"
  );
  assert.ok(elapsedMs < 500, `expected parsing to finish well under a second, took ${elapsedMs}ms`);
});

test("renderResumeText resolves many unterminated links in one paragraph, at scale, well under a second", () => {
  // A dense run of minimal "[a](b" fragments with no closing paren at all —
  // pure volume of never-closing destinations, rather than realistic prose,
  // stressing the same rescan-to-EOF path from a different angle.
  const unit = "[a](b ";
  const repeats = Math.ceil((256 * 1024) / unit.length);
  const md = unit.repeat(repeats);
  assert.ok(md.length >= 256 * 1024);
  assert.equal(md.includes(")"), false, "the destination must never close in this fixture");

  const start = Date.now();
  const text = renderResumeText(md);
  const elapsedMs = Date.now() - start;

  assert.ok(text.includes("[a](b"), "an unresolved link with no closing paren stays literal text");
  assert.ok(elapsedMs < 500, `expected parsing to finish well under a second, took ${elapsedMs}ms`);
});
