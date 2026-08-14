// tests/documents-placeholder-lint.test.mjs
// node:test suite for placeholder-lint.mjs

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  assertBuildReady,
  lintArtifact,
  lintArtifacts,
  PLACEHOLDER_PATTERNS,
} from "../src/core/documents/placeholder-lint.mjs";

// ---------------------------------------------------------------------------
// PLACEHOLDER_PATTERNS shape
// ---------------------------------------------------------------------------

test("PLACEHOLDER_PATTERNS is a non-empty array of { name, re } objects", () => {
  assert.ok(Array.isArray(PLACEHOLDER_PATTERNS));
  assert.ok(PLACEHOLDER_PATTERNS.length > 0);
  for (const p of PLACEHOLDER_PATTERNS) {
    assert.ok(typeof p.name === "string", `missing name on pattern ${JSON.stringify(p)}`);
    assert.ok(p.re instanceof RegExp, `re not a RegExp on pattern ${p.name}`);
  }
});

// ---------------------------------------------------------------------------
// lintArtifact — flags known placeholder types
// ---------------------------------------------------------------------------

test("lintArtifact flags [Company] square-bracket token", () => {
  const { clean, findings } = lintArtifact("Please send your resume to [Company] HR.");
  assert.equal(clean, false);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].line, 1);
  assert.equal(findings[0].pattern, "bracket-token");
});

test("lintArtifact flags [Role] square-bracket token", () => {
  const { clean, findings } = lintArtifact("Applying for the [Role] position.");
  assert.equal(clean, false);
  assert.equal(findings[0].pattern, "bracket-token");
});

test("lintArtifact flags [Anything With Spaces] square-bracket token", () => {
  const { clean, findings } = lintArtifact("Contact [Hiring Manager Name] for details.");
  assert.equal(clean, false);
  assert.equal(findings[0].pattern, "bracket-token");
});

test("lintArtifact flags domain-style bare citation marker [levels.fyi]", () => {
  // Citation-hygiene: a bare bracket marker with no colon is residue. The dot in a
  // domain name must not let it slip past (research-comp SKILL.md promises this).
  const { clean, findings } = lintArtifact("Midpoint **$230,000** [levels.fyi].");
  assert.equal(clean, false);
  assert.equal(findings[0].pattern, "bracket-token");
});

test("lintArtifact does not flag a full [source: ...] citation marker", () => {
  // The colon (and quotes/parens) in a real marker break the bracket-token class, so
  // genuine citations stay exempt while bare markers are caught.
  const text =
    'Floor **$200,000** [source: "Example Guide" (https://example.com/x), fetched 2026-06-16, confidence: high].';
  const { clean } = lintArtifact(text);
  assert.equal(clean, true);
});

test("lintArtifact flags {candidate} curly token", () => {
  const { clean, findings } = lintArtifact("Dear {candidate}, thank you.");
  assert.equal(clean, false);
  assert.equal(findings[0].pattern, "curly-token");
});

test("lintArtifact flags {{x}} double-curly token", () => {
  const { clean, findings } = lintArtifact("Hello {{name}}, welcome.");
  assert.equal(clean, false);
  assert.equal(findings[0].pattern, "double-curly-token");
});

test("lintArtifact flags <insert metric> angle-bracket insert", () => {
  const { clean, findings } = lintArtifact("Improved performance by <insert metric>.");
  assert.equal(clean, false);
  assert.equal(findings[0].pattern, "angle-insert");
});

test("lintArtifact flags <...> angle ellipsis", () => {
  const { clean, findings } = lintArtifact("Results: <...>");
  assert.equal(clean, false);
  assert.equal(findings[0].pattern, "angle-ellipsis");
});

test("lintArtifact flags TODO (case-insensitive)", () => {
  const { clean, findings } = lintArtifact("TODO: fill in this section.");
  assert.equal(clean, false);
  assert.equal(findings[0].pattern, "TODO");
});

test("lintArtifact flags todo lowercase", () => {
  const { clean, findings } = lintArtifact("todo: add more details here");
  assert.equal(clean, false);
  assert.equal(findings[0].pattern, "TODO");
});

test("lintArtifact flags TBD", () => {
  const { clean, findings } = lintArtifact("Salary: TBD");
  assert.equal(clean, false);
  assert.equal(findings[0].pattern, "TBD");
});

test("lintArtifact flags FIXME", () => {
  const { clean, findings } = lintArtifact("FIXME: rewrite this paragraph");
  assert.equal(clean, false);
  assert.equal(findings[0].pattern, "FIXME");
});

test("lintArtifact flags XXX", () => {
  const { clean, findings } = lintArtifact("XXX verify this claim");
  assert.equal(clean, false);
  assert.equal(findings[0].pattern, "XXX");
});

test("lintArtifact flags NEEDS YOU unanswered-question marker", () => {
  const { clean, findings } = lintArtifact(
    "NEEDS YOU: security-clearance status is not in onboarding data."
  );
  assert.equal(clean, false);
  assert.equal(findings[0].pattern, "needs-you-marker");
});

test("lintArtifact does not flag lowercase 'needs you' in prose", () => {
  const { clean } = lintArtifact("This team needs you to own the platform end to end.");
  assert.equal(clean, true);
});

test("lintArtifact flags lorem ipsum", () => {
  const { clean, findings } = lintArtifact("Lorem ipsum dolor sit amet.");
  assert.equal(clean, false);
  assert.equal(findings[0].pattern, "lorem-ipsum");
});

test("lintArtifact flags lorem ipsum case-insensitive", () => {
  const { clean, findings } = lintArtifact("LOREM IPSUM is placeholder text.");
  assert.equal(clean, false);
  assert.equal(findings[0].pattern, "lorem-ipsum");
});

test("lintArtifact flags template-persona name 'Jane Candidate'", () => {
  const { clean, findings } = lintArtifact("Prepared by Jane Candidate for the interview.");
  assert.equal(clean, false);
  assert.equal(findings[0].pattern, "template-persona-name");
});

test("lintArtifact flags template-persona name case-insensitive", () => {
  const { clean, findings } = lintArtifact("contact JANE CANDIDATE at the office.");
  assert.equal(clean, false);
  assert.equal(findings[0].pattern, "template-persona-name");
});

test("lintArtifact flags template-persona email 'jane@example.com'", () => {
  const { clean, findings } = lintArtifact("Reach me at jane@example.com for more info.");
  assert.equal(clean, false);
  assert.equal(findings[0].pattern, "template-persona-email");
});

test("lintArtifact flags template-persona phone '+1-555-0100'", () => {
  const { clean, findings } = lintArtifact("Call +1-555-0100 to schedule.");
  assert.equal(clean, false);
  assert.equal(findings[0].pattern, "template-persona-phone");
});

test("lintArtifact flags template-persona slug 'janecandidate'", () => {
  const { clean, findings } = lintArtifact("Profile URL: linkedin.com/in/janecandidate");
  assert.equal(clean, false);
  assert.equal(findings[0].pattern, "template-persona-slug");
});

// ---------------------------------------------------------------------------
// lintArtifact — clean text passes
// ---------------------------------------------------------------------------

test("lintArtifact returns clean for a finished prose paragraph", () => {
  const text = [
    "Built production AI workflows from prototype to deployment.",
    "Collaborated with cross-functional teams to ship ML features on schedule.",
    "Reduced inference latency by 40% through model optimization and caching.",
  ].join("\n");
  const { clean, findings } = lintArtifact(text);
  assert.equal(clean, true);
  assert.deepEqual(findings, []);
});

test("lintArtifact returns clean for resume markdown with bold and bullets", () => {
  const text =
    "## Experience\n\n- **Led** platform migrations across three product lines.\n- Mentored junior engineers.";
  const { clean } = lintArtifact(text);
  assert.equal(clean, true);
});

test("lintArtifact does not flag square brackets in markdown links", () => {
  // markdown links look like [text](url) — the bracket token pattern requires no ) immediately after
  // Our pattern is \[[A-Za-z][\w \-/]*\] which won't match [text](url) since ] is followed by (
  const text = "See [example](https://example.com) for details.";
  const { clean } = lintArtifact(text);
  assert.equal(clean, true);
});

// ---------------------------------------------------------------------------
// lintArtifact — line/column accuracy
// ---------------------------------------------------------------------------

test("lintArtifact reports 1-based line numbers", () => {
  const text = "First line is clean.\nSecond line has [Company] in it.\nThird line clean.";
  const { findings } = lintArtifact(text);
  assert.equal(findings[0].line, 2);
});

test("lintArtifact reports 1-based column number", () => {
  const text = "Prefix [Role] suffix";
  const { findings } = lintArtifact(text);
  assert.equal(findings[0].column, 8); // '[' is at index 7, so column = 8
});

// ---------------------------------------------------------------------------
// lintArtifacts — multi-file aggregation
// ---------------------------------------------------------------------------

test("lintArtifacts aggregates findings across files with filenames", () => {
  const files = [
    { name: "resume.md", text: "Hello [Company], I am applying." },
    { name: "cover.md", text: "Clean paragraph about real work." },
    { name: "answers.md", text: "TODO: fill this in later." },
  ];
  const { clean, findings } = lintArtifacts(files);
  assert.equal(clean, false);
  assert.equal(findings.length, 2);
  assert.equal(findings[0].file, "resume.md");
  assert.equal(findings[1].file, "answers.md");
});

test("lintArtifacts returns clean when all files are clean", () => {
  const files = [
    { name: "resume.md", text: "Shipped production features under tight deadlines." },
    { name: "cover.md", text: "Excited to bring my experience to this team." },
  ];
  const { clean, findings } = lintArtifacts(files);
  assert.equal(clean, true);
  assert.deepEqual(findings, []);
});

test("lintArtifacts includes file name in each finding", () => {
  const files = [
    { name: "doc-a.md", text: "Clean." },
    { name: "doc-b.md", text: "lorem ipsum text here" },
  ];
  const { findings } = lintArtifacts(files);
  assert.equal(findings[0].file, "doc-b.md");
});

// ---------------------------------------------------------------------------
// assertBuildReady
// ---------------------------------------------------------------------------

test("assertBuildReady returns true when all files are clean", () => {
  const files = [
    { name: "resume.md", text: "Led cross-functional AI product teams to production." },
  ];
  const result = assertBuildReady(files);
  assert.equal(result, true);
});

test("assertBuildReady throws when files contain placeholders", () => {
  const files = [{ name: "resume.md", text: "Applying to [Company] for the [Role]." }];
  assert.throws(
    () => assertBuildReady(files),
    (err) => {
      assert.ok(err instanceof Error);
      assert.ok(err.message.includes("resume.md"), `missing filename in: ${err.message}`);
      assert.ok(err.message.includes("not build-ready"), `missing phrase in: ${err.message}`);
      return true;
    }
  );
});

test("assertBuildReady error message lists all findings", () => {
  const files = [{ name: "a.md", text: "Line 1 TODO fix this.\nLine 2 also {candidate} bad." }];
  assert.throws(
    () => assertBuildReady(files),
    (err) => {
      // Should mention both lines
      assert.ok(err.message.includes("a.md:1"), `line 1 not in: ${err.message}`);
      assert.ok(err.message.includes("a.md:2"), `line 2 not in: ${err.message}`);
      return true;
    }
  );
});
