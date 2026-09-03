// tests/ats-parseability.test.mjs
// node:test suite for scoreAtsParseability (src/core/documents/ats-parseability.mjs).

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  detectArtifactKind,
  scoreAtsParseability,
} from "../src/core/documents/ats-parseability.mjs";
import { validateAtsSafe } from "../src/core/documents/tailor.mjs";

const repo = join(import.meta.dirname, "..");

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const CLEAN_RESUME = `# Jane Smith
jane@example.com | +1 415 555 0100 | San Francisco, CA

## Summary

Senior backend engineer with a decade of experience designing reliable,
high-throughput distributed systems and leading cross-functional platform
teams across multiple time zones.

## Experience

- Led the infrastructure team that shipped three agentic pipelines end to
  end, from prototype through production rollout across several engineering
  teams, reducing incident rates along the way.
- Reduced deployment lead time by building observability tooling that was
  adopted org-wide and cut on-call load for every downstream team.

## Skills

**Core:** Python, Kubernetes, Docker, PostgreSQL, distributed systems, CI/CD pipelines.
`;

// ---------------------------------------------------------------------------
// Clean resume
// ---------------------------------------------------------------------------

test("scoreAtsParseability gives a clean resume the top score with no findings", () => {
  const { score, findings } = scoreAtsParseability(CLEAN_RESUME);
  assert.equal(score, 100);
  assert.deepEqual(findings, []);
});

// ---------------------------------------------------------------------------
// Individual heuristics
// ---------------------------------------------------------------------------

test("scoreAtsParseability flags very little text", () => {
  const md =
    "# Jane Smith\njane@example.com | 415-555-0100\n\n## Experience\n\n- Worked.\n\n## Skills\n\nPython.";
  const { score, findings } = scoreAtsParseability(md);
  const finding = findings.find((f) => f.id === "low-text-content");
  assert.ok(finding, `expected low-text-content finding, got: ${JSON.stringify(findings)}`);
  assert.equal(finding.severity, "warn");
  assert.ok(finding.fix.length > 0);
  assert.ok(score < 100);
});

test("scoreAtsParseability flags a missing Experience/Highlights heading", () => {
  const md = CLEAN_RESUME.replace("## Experience", "## Roles");
  const { findings } = scoreAtsParseability(md);
  const finding = findings.find((f) => f.id === "missing-experience-section");
  assert.ok(
    finding,
    `expected missing-experience-section finding, got: ${JSON.stringify(findings)}`
  );
  assert.equal(finding.severity, "warn");
});

test("scoreAtsParseability accepts a Highlights heading as the Experience equivalent", () => {
  const md = CLEAN_RESUME.replace("## Experience", "## Highlights");
  const { findings } = scoreAtsParseability(md);
  assert.equal(
    findings.some((f) => f.id === "missing-experience-section"),
    false
  );
});

test("scoreAtsParseability flags a missing Skills heading", () => {
  const md = CLEAN_RESUME.replace("## Skills", "## Abilities");
  const { findings } = scoreAtsParseability(md);
  const finding = findings.find((f) => f.id === "missing-skills-section");
  assert.ok(finding, `expected missing-skills-section finding, got: ${JSON.stringify(findings)}`);
  assert.equal(finding.severity, "warn");
});

test("scoreAtsParseability flags a missing email address", () => {
  const md = CLEAN_RESUME.replace(
    "jane@example.com | +1 415 555 0100 | San Francisco, CA",
    "San Francisco, CA"
  );
  const { findings } = scoreAtsParseability(md);
  const finding = findings.find((f) => f.id === "missing-email");
  assert.ok(finding, `expected missing-email finding, got: ${JSON.stringify(findings)}`);
  assert.equal(finding.severity, "warn");
});

test("scoreAtsParseability flags a missing phone number (info tier only)", () => {
  const md = CLEAN_RESUME.replace(
    "jane@example.com | +1 415 555 0100 | San Francisco, CA",
    "jane@example.com | San Francisco, CA"
  );
  const { findings } = scoreAtsParseability(md);
  const finding = findings.find((f) => f.id === "missing-phone");
  assert.ok(finding, `expected missing-phone finding, got: ${JSON.stringify(findings)}`);
  assert.equal(finding.severity, "info");
});

test("scoreAtsParseability does not mistake a bare year range for a phone number", () => {
  const md = CLEAN_RESUME.replace(
    "jane@example.com | +1 415 555 0100 | San Francisco, CA",
    "jane@example.com | Employed 2019 - 2024 | San Francisco, CA"
  );
  const { findings } = scoreAtsParseability(md);
  assert.ok(findings.some((f) => f.id === "missing-phone"));
});

// ---------------------------------------------------------------------------
// Block tier mirrors validateAtsSafe
// ---------------------------------------------------------------------------

test("scoreAtsParseability's block tier mirrors validateAtsSafe for a markdown table", () => {
  const md = "| Column A | Column B |\n|----------|----------|\n| value 1  | value 2  |";
  const ats = validateAtsSafe(md);
  assert.equal(ats.ok, false);
  const { findings } = scoreAtsParseability(md);
  const finding = findings.find((f) => f.id === "markdown-table");
  assert.ok(finding, `expected markdown-table finding, got: ${JSON.stringify(findings)}`);
  assert.equal(finding.severity, "block");
});

test("scoreAtsParseability's block tier mirrors validateAtsSafe for every issue type", () => {
  const cases = [
    { md: "Here is my logo: ![logo](logo.png)", id: "markdown-image" },
    { md: "Name: <b>Alex Rivera</b>", id: "html-tag" },
    { md: "Item:\tvalue", id: "tab-character" },
    { md: "Layout: ───", id: "box-drawing-glyph" },
  ];
  for (const { md, id } of cases) {
    const ats = validateAtsSafe(md);
    assert.equal(ats.ok, false, `expected validateAtsSafe to flag: ${md}`);
    const { findings } = scoreAtsParseability(md);
    const finding = findings.find((f) => f.id === id);
    assert.ok(finding, `expected ${id} finding for "${md}", got: ${JSON.stringify(findings)}`);
    assert.equal(finding.severity, "block");
  }
});

test("scoreAtsParseability reuses a caller-supplied validateAtsSafe result instead of recomputing", () => {
  const md = "| Column A | Column B |\n|----------|----------|\n| value 1  | value 2  |";
  const trustedAts = { ok: true, issues: [] };
  const { findings } = scoreAtsParseability(md, { ats: trustedAts });
  assert.equal(
    findings.some((f) => f.severity === "block"),
    false
  );
});

test("scoreAtsParseability falls back to a generic block finding for an unrecognized issue", () => {
  const md = CLEAN_RESUME;
  const { findings } = scoreAtsParseability(md, {
    ats: { ok: false, issues: ["some future issue"] },
  });
  const finding = findings.find((f) => f.id === "ats-unsafe");
  assert.ok(finding);
  assert.equal(finding.severity, "block");
  assert.match(finding.message, /some future issue/);
});

test("scoreAtsParseability's block tier catches a pipe-less GFM table, not just the piped form", () => {
  // No outer pipes, still a real GFM table (markdownToHtml renders it as
  // one), so validateAtsSafe's table detector has to catch it too.
  const md = "Contact | Detail\n------- | ------\nEmail | jane@example.com";
  const ats = validateAtsSafe(md);
  assert.equal(ats.ok, false, "expected validateAtsSafe to flag a pipe-less table");
  const { score, findings } = scoreAtsParseability(md);
  const finding = findings.find((f) => f.id === "markdown-table");
  assert.ok(finding, `expected markdown-table finding, got: ${JSON.stringify(findings)}`);
  assert.equal(finding.severity, "block");
  assert.ok(score <= 75, `expected the block-tier deduction to apply, got score ${score}`);
});

// ---------------------------------------------------------------------------
// Artifact kind gates the resume-only section checks
// ---------------------------------------------------------------------------

const COVER_LETTER = `Dear Hiring Team,

I'm writing to apply for the Senior Backend Engineer role. My background in
distributed systems and platform reliability lines up closely with what
you've described, and I'd welcome the chance to bring that experience here.
I've spent the last several years building and operating the kind of
high-throughput infrastructure this role calls for, and I'd love to talk
through how that experience maps onto what your team is tackling next.

jane@example.com | +1 415 555 0100

Sincerely,
Jane Smith
`;

test("detectArtifactKind reads workspace/tailored/ (and anything else) as a resume by default", () => {
  assert.equal(detectArtifactKind("workspace/tailored/Acme - Engineer.md"), "resume");
  assert.equal(detectArtifactKind("/tmp/whatever/resume.md"), "resume");
});

test("detectArtifactKind reads a cover-letter-named file as a cover letter", () => {
  assert.equal(
    detectArtifactKind("workspace/tailored/Acme - Engineer - Cover Letter.md"),
    "cover-letter"
  );
  assert.equal(detectArtifactKind("/tmp/acme-cover-letter.md"), "cover-letter");
});

test("detectArtifactKind reads workspace/interview-prep/ as a packet", () => {
  assert.equal(detectArtifactKind("workspace/interview-prep/acme-engineer.md"), "packet");
});

test("scoreAtsParseability with kind resume (the default) flags missing Experience/Skills sections", () => {
  const { findings } = scoreAtsParseability(COVER_LETTER);
  assert.ok(findings.some((f) => f.id === "missing-experience-section"));
  assert.ok(findings.some((f) => f.id === "missing-skills-section"));
});

test("scoreAtsParseability with kind cover-letter never flags missing Experience/Skills sections", () => {
  const { findings } = scoreAtsParseability(COVER_LETTER, { kind: "cover-letter" });
  assert.equal(
    findings.some(
      (f) => f.id === "missing-experience-section" || f.id === "missing-skills-section"
    ),
    false,
    `expected no resume-section findings for a cover letter, got: ${JSON.stringify(findings)}`
  );
  // Still gets the generic checks: this cover letter has real text and a
  // reachable email, so neither should fire either.
  assert.equal(
    findings.some((f) => f.id === "low-text-content" || f.id === "missing-email"),
    false
  );
});

test("scoreAtsParseability with kind packet never flags missing Experience/Skills sections", () => {
  const { findings } = scoreAtsParseability(COVER_LETTER, { kind: "packet" });
  assert.equal(
    findings.some(
      (f) => f.id === "missing-experience-section" || f.id === "missing-skills-section"
    ),
    false
  );
});

// ---------------------------------------------------------------------------
// Heading recognition: syntax is separate from vocabulary
// ---------------------------------------------------------------------------

test("scoreAtsParseability recognizes an indented ATX heading (up to 3 spaces)", () => {
  const md = CLEAN_RESUME.replace("## Experience", "   ## Experience");
  const { findings } = scoreAtsParseability(md);
  assert.equal(
    findings.some((f) => f.id === "missing-experience-section"),
    false
  );
});

test("scoreAtsParseability recognizes a Setext heading (underlined with ---)", () => {
  const md = CLEAN_RESUME.replace("## Experience\n\n", "Experience\n----------\n\n");
  const { findings } = scoreAtsParseability(md);
  assert.equal(
    findings.some((f) => f.id === "missing-experience-section"),
    false
  );
});

test("scoreAtsParseability recognizes a bold-only heading line", () => {
  const md = CLEAN_RESUME.replace("## Experience", "**Experience**");
  const { findings } = scoreAtsParseability(md);
  assert.equal(
    findings.some((f) => f.id === "missing-experience-section"),
    false
  );
});

test("scoreAtsParseability recognizes a standalone ALL-CAPS heading line", () => {
  const md = CLEAN_RESUME.replace("## Experience", "PROFESSIONAL EXPERIENCE");
  const { findings } = scoreAtsParseability(md);
  assert.equal(
    findings.some((f) => f.id === "missing-experience-section"),
    false
  );
});

// ---------------------------------------------------------------------------
// Email check stays linear on long input with no candidate
// ---------------------------------------------------------------------------

test("scoreAtsParseability scores a long no-email string well under a second", () => {
  const md = `# Jane Smith\n\n## Experience\n\n${"a".repeat(40000)}\n\n## Skills\n\nPython.`;
  const start = Date.now();
  const { findings } = scoreAtsParseability(md);
  const elapsedMs = Date.now() - start;
  assert.ok(findings.some((f) => f.id === "missing-email"));
  assert.ok(elapsedMs < 500, `expected scoring to finish well under a second, took ${elapsedMs}ms`);
});

// ---------------------------------------------------------------------------
// CLI output path
// ---------------------------------------------------------------------------
//
// These exercise the real CLI as a subprocess, so they force PATH to empty
// and use --docx (never --pdf): --pdf needs the Playwright Chromium browser
// binary, which the CI "tests" job (unlike the dedicated browser jobs) never
// installs, so a --pdf CLI test here is fine locally but reliably fails in
// CI ("Chromium not found"). An empty PATH makes detectDocxCapability find
// neither pandoc nor soffice, so exportArtifact deterministically falls back
// to the built-in OOXML writer, the same technique
// document-html-security.test.mjs uses for exportArtifact directly.

test("careerrat export --ats --json includes the ATS parseability score", (t) => {
  const workDir = mkdtempSync(join(tmpdir(), "careerrat-ats-cli-"));
  t.after(() => rmSync(workDir, { recursive: true, force: true }));

  const mdPath = join(workDir, "resume.md");
  writeFileSync(mdPath, CLEAN_RESUME, "utf8");

  const out = execFileSync(
    process.execPath,
    ["src/cli/export.mjs", mdPath, "--docx", "--ats", "--json", "--out", join(workDir, "resume")],
    { cwd: repo, encoding: "utf8", env: { ...process.env, PATH: "" } }
  );
  const parsed = JSON.parse(out);
  assert.equal(parsed.docx, join(workDir, "resume.docx"));
  assert.match(parsed.docxLabel, /built-in OOXML writer/);
  assert.ok(parsed.ats, "expected an ats result in the JSON output");
  assert.equal(parsed.ats.score, 100);
  assert.deepEqual(parsed.ats.findings, []);
});

test("careerrat export --json without --ats omits the ATS score", (t) => {
  const workDir = mkdtempSync(join(tmpdir(), "careerrat-ats-cli-"));
  t.after(() => rmSync(workDir, { recursive: true, force: true }));

  const mdPath = join(workDir, "resume.md");
  writeFileSync(mdPath, CLEAN_RESUME, "utf8");

  const out = execFileSync(
    process.execPath,
    ["src/cli/export.mjs", mdPath, "--docx", "--json", "--out", join(workDir, "resume")],
    { cwd: repo, encoding: "utf8", env: { ...process.env, PATH: "" } }
  );
  const parsed = JSON.parse(out);
  assert.equal(parsed.ats, null);
});

test("careerrat export --json prints a single JSON error object and exits 1 on a missing input file", (t) => {
  const workDir = mkdtempSync(join(tmpdir(), "careerrat-ats-cli-"));
  t.after(() => rmSync(workDir, { recursive: true, force: true }));

  const missingPath = join(workDir, "does-not-exist.md");

  let out;
  let status;
  try {
    out = execFileSync(process.execPath, ["src/cli/export.mjs", missingPath, "--json"], {
      cwd: repo,
      encoding: "utf8",
      env: { ...process.env, PATH: "" },
    });
    status = 0;
  } catch (err) {
    out = err.stdout;
    status = err.status;
  }
  assert.equal(status, 1);
  const parsed = JSON.parse(out);
  assert.equal(parsed.ok, false);
  assert.match(parsed.error, /not found/i);
});
