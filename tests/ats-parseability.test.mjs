// tests/ats-parseability.test.mjs
// node:test suite for scoreAtsParseability (src/core/documents/ats-parseability.mjs).

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { scoreAtsParseability } from "../src/core/documents/ats-parseability.mjs";
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

// ---------------------------------------------------------------------------
// CLI output path
// ---------------------------------------------------------------------------

test("careerrat export --ats --json includes the ATS parseability score", (t) => {
  const workDir = mkdtempSync(join(tmpdir(), "careerrat-ats-cli-"));
  t.after(() => rmSync(workDir, { recursive: true, force: true }));

  const mdPath = join(workDir, "resume.md");
  writeFileSync(mdPath, CLEAN_RESUME, "utf8");

  const out = execFileSync(
    process.execPath,
    ["src/cli/export.mjs", mdPath, "--pdf", "--ats", "--json", "--out", join(workDir, "resume")],
    { cwd: repo, encoding: "utf8" }
  );
  const parsed = JSON.parse(out);
  assert.equal(parsed.pdf, join(workDir, "resume.pdf"));
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
    ["src/cli/export.mjs", mdPath, "--pdf", "--json", "--out", join(workDir, "resume")],
    { cwd: repo, encoding: "utf8" }
  );
  const parsed = JSON.parse(out);
  assert.equal(parsed.ats, null);
});
