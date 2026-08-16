// tests/issue-report.test.mjs
// node:test coverage for src/core/agent/issue-report.mjs — the redaction +
// assembly core behind the report-issue skill's Ask row. Exercises the
// exported pieces directly (buildIssueReport, buildIssueUrl,
// redactDiagnosticText, collectIdentifiers) rather than going through the
// full workspace-agent intent path (that wiring — the issue.report/
// issue.record-filed handlers, the 20-message error lookback, the Activity
// Pulse invariant, the matcher/ordering rules — is covered in
// tests/workspace-agent.test.mjs and tests/workspace-agent-preview.test.mjs
// instead). Follows this repo's tempRepo()/CAREERRAT_HOME-via-openDb
// convention already established in tests/workspace-agent.test.mjs.

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

import {
  buildIssueReport,
  buildIssueUrl,
  CONFIG_FAMILY_CODES,
  collectIdentifiers,
  ISSUE_REPORT_COMP_LEAK_MARKER,
  redactDiagnosticText,
} from "../src/core/agent/issue-report.mjs";
import { closeAll, openDb } from "../src/core/db/connection.mjs";
import { appUpsert } from "../src/core/db/verbs/app.mjs";
import { candidateConfigPatch } from "../src/core/db/verbs/candidate.mjs";
import { readVersion } from "../src/core/version.mjs";

const cleanupRoots = [];

function tempRepo() {
  const repoRoot = mkdtempSync(join(tmpdir(), "careerrat-issue-report-"));
  cleanupRoots.push(repoRoot);
  openDb({ repoRoot, env: {} });
  return repoRoot;
}

function seedApplication(repoRoot, overrides = {}) {
  const row = {
    id: "app-northstar",
    company: "Northstar Freight",
    role: "Staff Reliability Engineer",
    status: "reviewed-hold",
    link: "https://jobs.example.test/northstar/staff-reliability-engineer",
    ...overrides,
  };
  appUpsert({ repoRoot, env: {}, row });
  return row;
}

after(() => {
  closeAll();
  for (const root of cleanupRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const REPORT_DEFAULTS = { version: "0.0.0-test", nodeVersion: "v20.11.0", platform: "darwin" };

// ---------------------------------------------------------------------------
// redactDiagnosticText / collectIdentifiers
// ---------------------------------------------------------------------------

test("collectIdentifiers + redactDiagnosticText scrub tracked application company and role names", () => {
  const repoRoot = tempRepo();
  seedApplication(repoRoot);

  const identifiers = collectIdentifiers({ repoRoot, env: {} });
  assert.ok(identifiers.includes("Northstar Freight"));
  assert.ok(identifiers.includes("Staff Reliability Engineer"));

  const result = redactDiagnosticText(
    "Tailoring failed for Staff Reliability Engineer at Northstar Freight during document generation.",
    { identifiers }
  );
  assert.equal(result.dropped, false);
  assert.ok(!result.text.includes("Northstar Freight"));
  assert.ok(!result.text.includes("Staff Reliability Engineer"));
  assert.match(result.text, /<redacted>/);
});

test("collectIdentifiers also tracks the candidate's own name/email/phone from profile config", () => {
  const repoRoot = tempRepo();
  candidateConfigPatch({
    repoRoot,
    env: {},
    name: "profile",
    patch: {
      candidate: {
        full_name: "Jordan Vega",
        email: "jordan.vega@example.test",
        phone: "555-201-3344",
      },
    },
  });

  const identifiers = collectIdentifiers({ repoRoot, env: {} });
  assert.ok(identifiers.includes("Jordan Vega"));
  assert.ok(identifiers.includes("jordan.vega@example.test"));
  assert.ok(identifiers.includes("555-201-3344"));

  const result = redactDiagnosticText(
    "Failed while emailing jordan.vega@example.test on behalf of Jordan Vega at 555-201-3344.",
    { identifiers }
  );
  assert.equal(result.dropped, false);
  assert.doesNotMatch(result.text, /jordan\.vega@example\.test/i);
  assert.doesNotMatch(result.text, /jordan vega/i);
  assert.doesNotMatch(result.text, /555-201-3344/);
});

test("collectIdentifiers includes profile location (home + relocation) and redacts them from text", () => {
  const repoRoot = tempRepo();
  candidateConfigPatch({
    repoRoot,
    env: {},
    name: "profile",
    patch: {
      location: { home: "Lisbon", relocation: ["Berlin", "Amsterdam"] },
    },
  });

  const identifiers = collectIdentifiers({ repoRoot, env: {} });
  assert.ok(identifiers.includes("Lisbon"));
  assert.ok(identifiers.includes("Berlin"));
  assert.ok(identifiers.includes("Amsterdam"));

  const result = redactDiagnosticText(
    "Relocation check failed for Lisbon, tried Berlin and Amsterdam as fallbacks.",
    { identifiers }
  );
  assert.equal(result.dropped, false);
  assert.doesNotMatch(result.text, /lisbon/i);
  assert.doesNotMatch(result.text, /berlin/i);
  assert.doesNotMatch(result.text, /amsterdam/i);
});

test("redactDiagnosticText scrubs identifiers regardless of casing", () => {
  const repoRoot = tempRepo();
  seedApplication(repoRoot, { company: "Acme Corp", id: "app-acme-corp" });

  const identifiers = collectIdentifiers({ repoRoot, env: {} });
  assert.ok(identifiers.includes("Acme Corp"));

  const result = redactDiagnosticText(
    "Error while contacting ACME CORP the first time, then acme corp again on retry.",
    { identifiers }
  );
  assert.equal(result.dropped, false);
  assert.doesNotMatch(result.text, /acme corp/i);
});

test("redactDiagnosticText matches a stored phone identifier regardless of formatting", () => {
  const identifiers = ["555-123-4567"];
  for (const text of [
    "Call back at (555) 123-4567 please.",
    "Call back at 555.123.4567 please.",
    "Call back at 5551234567 please.",
  ]) {
    const result = redactDiagnosticText(text, { identifiers });
    assert.equal(result.dropped, false, text);
    assert.match(result.text, /<redacted>/, text);
    assert.doesNotMatch(result.text, /555/, text);
  }
});

test("redactDiagnosticText matches a multi-word identifier across wrapped or re-flowed whitespace", () => {
  const identifiers = ["Acme Corp"];
  for (const text of [
    "Failed while contacting Acme\nCorp support.",
    "Failed while contacting Acme  Corp support.",
  ]) {
    const result = redactDiagnosticText(text, { identifiers });
    assert.equal(result.dropped, false, text);
    assert.match(result.text, /<redacted>/, text);
  }
});

test("redactDiagnosticText matches an identifier across Unicode NFD/NFC composition differences", () => {
  // Built with explicit \u escapes rather than a literal accented character
  // in source, so the codepoint sequence can't get silently renormalized by
  // an editor/tool before the test even runs. Stored identifier is NFD (a
  // plain "e" plus a combining acute accent, U+0301); the diagnostic text
  // uses the single precomposed NFC "e-acute" instead.
  const nfdIdentifier = "Cafe\u0301 Corp";
  assert.notEqual(nfdIdentifier, nfdIdentifier.normalize("NFC"), "fixture must actually be NFD");
  const nfcText = "Contacted Caf\u00e9 Corp about the outage.";

  const result = redactDiagnosticText(nfcText, { identifiers: [nfdIdentifier] });
  assert.equal(result.dropped, false);
  assert.match(result.text, /<redacted>/);
  assert.doesNotMatch(result.text, /caf\u00e9/i);
});

test("redactDiagnosticText matches identifiers case-insensitively via the (text, { identifiers }) signature", () => {
  const identifiers = ["Acme Corp"];
  const result = redactDiagnosticText("Received an ACME CORP support ticket overnight.", {
    identifiers,
  });
  assert.equal(result.dropped, false);
  assert.match(result.text, /<redacted>/);
  assert.doesNotMatch(result.text, /acme corp/i);
});

test("redactDiagnosticText fails closed and drops the whole string when comp-leak residue survives the scrub", () => {
  // No identifiers involved at all — this is the general fail-closed
  // guarantee: redactDiagnosticText also runs over lastError.message inside
  // buildIssueReport, and a leaked comp phrase there must never partially
  // survive as "redacted".
  const result = redactDiagnosticText("Retried after comparing to current salary once more.", {
    identifiers: [],
  });
  assert.equal(result.dropped, true);
  assert.equal(result.text, null);
});

test("redactDiagnosticText normalizes home-directory paths to ~/ and workspace/candidate paths to <workspace>/", () => {
  const homePaths = redactDiagnosticText(
    "Wrote a backup to /Users/jordan/Downloads/notes.txt and read config from /home/jordan/.config/settings.json",
    { identifiers: [] }
  );
  assert.equal(homePaths.dropped, false);
  assert.match(homePaths.text, /~\/Downloads\/notes\.txt/);
  assert.match(homePaths.text, /~\/\.config\/settings\.json/);
  assert.doesNotMatch(homePaths.text, /\/Users\//);
  assert.doesNotMatch(homePaths.text, /\/home\//);

  const workspacePaths = redactDiagnosticText(
    "Failed to read /Users/jordan/careerrat/workspace/tailored/resume.pdf and /Users/jordan/careerrat/candidate/profile.yml",
    { identifiers: [] }
  );
  assert.equal(workspacePaths.dropped, false);
  assert.match(workspacePaths.text, /<workspace>\/tailored\/resume\.pdf/);
  assert.match(workspacePaths.text, /<workspace>\/profile\.yml/);
  assert.doesNotMatch(workspacePaths.text, /\/Users\//);
});

test("redactDiagnosticText normalizes Windows home paths and matches POSIX home paths case-insensitively", () => {
  const windowsPath = redactDiagnosticText("Wrote a backup to C:\\Users\\jdoe\\x.pdf", {
    identifiers: [],
  });
  assert.equal(windowsPath.dropped, false);
  assert.match(windowsPath.text, /~\\x\.pdf/);
  assert.doesNotMatch(windowsPath.text, /C:\\Users/);

  const shoutedPosixPath = redactDiagnosticText("Read config from /USERS/jdoe/y", {
    identifiers: [],
  });
  assert.equal(shoutedPosixPath.dropped, false);
  assert.match(shoutedPosixPath.text, /~\/y/);
  assert.doesNotMatch(shoutedPosixPath.text, /\/USERS\//);
});

// ---------------------------------------------------------------------------
// buildIssueReport
// ---------------------------------------------------------------------------

test("buildIssueReport flags a bare comp figure in the description without throwing", () => {
  const repoRoot = tempRepo();
  for (const description of [
    "Saw similar postings paying around $180,000 for comparable roles.",
    "Postings in this range seem to pay about 150k for comparable roles.",
  ]) {
    const report = buildIssueReport({
      repoRoot,
      env: {},
      description,
      lastError: null,
      ...REPORT_DEFAULTS,
    });
    assert.equal(report.state.compFlagged, true, description);
    assert.equal(report.state.hasError, false, description);
  }
});

test("buildIssueReport drops a bare comp figure that appears in machine-generated error text", () => {
  const repoRoot = tempRepo();
  const report = buildIssueReport({
    repoRoot,
    env: {},
    description: "",
    lastError: {
      code: "SOME_UNMAPPED_XYZ",
      message: "expected base $185,000 but profile has 92k",
    },
    ...REPORT_DEFAULTS,
  });
  assert.equal(report.state.errorMessageDropped, true);
  assert.doesNotMatch(report.body, /185/);
  assert.doesNotMatch(report.body, /92k/i);
  assert.match(report.body, /error text withheld because it referenced workspace data/);
});

test("buildIssueReport only flags (never drops) the same bare comp figure when the candidate writes it themselves", () => {
  const repoRoot = tempRepo();
  const report = buildIssueReport({
    repoRoot,
    env: {},
    description: "The error mentioned base $185,000 but profile has 92k, not sure why.",
    lastError: null,
    ...REPORT_DEFAULTS,
  });
  assert.equal(report.state.compFlagged, true);
  assert.equal(report.state.errorMessageDropped, false);
  // Unlike the machine-generated case above, the candidate's own words are
  // never silently dropped — flagged for review, but kept in the body.
  assert.match(report.body, /185/);
  assert.match(report.body, /92k/i);
});

test("buildIssueReport throws ISSUE_REPORT_COMP_LEAK_MARKER for explicit current-comp phrasing", () => {
  const repoRoot = tempRepo();
  assert.throws(
    () =>
      buildIssueReport({
        repoRoot,
        env: {},
        description: "My current base is $180,000 but the app just crashed for me.",
        lastError: null,
        ...REPORT_DEFAULTS,
      }),
    (error) => error.code === ISSUE_REPORT_COMP_LEAK_MARKER
  );
});

test("buildIssueReport drops the recorded error message instead of leaking when redaction fails closed", () => {
  const repoRoot = tempRepo();
  const report = buildIssueReport({
    repoRoot,
    env: {},
    description: "",
    lastError: {
      code: "SEARCH_FAILED",
      message: "Retried after comparing to current salary once more.",
    },
    ...REPORT_DEFAULTS,
  });
  assert.equal(report.state.errorMessageDropped, true);
  assert.doesNotMatch(report.body, /current salary/i);
  assert.match(report.body, /error text withheld because it referenced workspace data/);
});

test("buildIssueReport sets configHint only for the config-family error codes", () => {
  const repoRoot = tempRepo();
  for (const code of CONFIG_FAMILY_CODES) {
    const report = buildIssueReport({
      repoRoot,
      env: {},
      description: "",
      lastError: { code, message: "irrelevant detail" },
      ...REPORT_DEFAULTS,
    });
    assert.equal(report.state.configHint, true, code);
  }

  const nonConfig = buildIssueReport({
    repoRoot,
    env: {},
    description: "",
    lastError: { code: "SEARCH_FAILED", message: "irrelevant detail" },
    ...REPORT_DEFAULTS,
  });
  assert.equal(nonConfig.state.configHint, false);
});

// ---------------------------------------------------------------------------
// buildIssueUrl
// ---------------------------------------------------------------------------

test("buildIssueUrl encodes a small report without truncating", () => {
  const { url, truncated } = buildIssueUrl({
    title: "CareerRat issue report",
    body: "## What happened\nShort reproduction body.",
  });
  assert.equal(truncated, false);
  assert.ok(url.startsWith("https://github.com/CodesWhat/careerrat/issues/new?"));
  const parsed = new URL(url);
  assert.equal(parsed.searchParams.get("title"), "CareerRat issue report");
  assert.equal(parsed.searchParams.get("body"), "## What happened\nShort reproduction body.");
  assert.equal(parsed.searchParams.get("labels"), "bug");
});

test("buildIssueUrl truncates an oversized report at a whole-line boundary and appends the paste-note", () => {
  const originalLines = Array.from(
    { length: 400 },
    (_, i) => `line-${String(i).padStart(4, "0")} some filler reproduction detail padding this out`
  );
  const body = originalLines.join("\n");
  const { url, truncated } = buildIssueUrl({ title: "Oversized report", body });

  assert.equal(truncated, true);
  assert.ok(url.length <= 6000, `expected encoded url length <= 6000, got ${url.length}`);

  const decodedBody = new URL(url).searchParams.get("body");
  assert.match(decodedBody, /\[truncated - paste the full report from CareerRat\]$/);

  const suffixIndex = decodedBody.indexOf("\n\n[truncated");
  assert.ok(suffixIndex > -1);
  const keptLines = decodedBody.slice(0, suffixIndex).split("\n");
  assert.ok(keptLines.length < originalLines.length, "expected the body to actually be shortened");
  assert.deepEqual(
    originalLines.slice(0, keptLines.length),
    keptLines,
    "the kept prefix must be a whole-line prefix of the original body, not a mid-line cut"
  );
});

test("buildIssueUrl targets the CodesWhat/careerrat repo derived from package.json's bugs.url", () => {
  const pkg = JSON.parse(readFileSync("package.json", "utf8"));
  const expectedBase = String(pkg.bugs?.url || "").replace(/\/issues\/?$/i, "");
  assert.equal(expectedBase, "https://github.com/CodesWhat/careerrat");

  const { url } = buildIssueUrl({ title: "T", body: "B" });
  assert.ok(url.startsWith(`${expectedBase}/issues/new?`));
});

// ---------------------------------------------------------------------------
// readVersion (src/core/version.mjs)
// ---------------------------------------------------------------------------

test("readVersion reads the version straight out of package.json", () => {
  const pkg = JSON.parse(readFileSync("package.json", "utf8"));
  assert.equal(readVersion(), pkg.version);
});

// ---------------------------------------------------------------------------
// Invariant: issue-report.mjs never shells out
// ---------------------------------------------------------------------------

test("issue-report.mjs never imports child_process or shells out to gh", () => {
  const source = readFileSync("src/core/agent/issue-report.mjs", "utf8");
  assert.doesNotMatch(
    source,
    /child_process/,
    "issue-report.mjs must not import node:child_process"
  );
  assert.doesNotMatch(
    source,
    /\bexecFileSync?\(|\bspawnSync?\(|\bexecSync\(/,
    "issue-report.mjs must not shell out"
  );
});

test("buildIssueReport truncates astral-heavy titles and bodies without splitting surrogate pairs", () => {
  const repoRoot = tempRepo();
  // 2100 astral code points = 4200 UTF-16 units: enough to trip both the
  // 60-point title cap and the 4000-point body cap. A unit-based slice
  // would leave a lone surrogate and make buildIssueUrl's
  // encodeURIComponent throw URIError.
  const report = buildIssueReport({
    repoRoot,
    env: {},
    description: "\u{1F600}".repeat(2100),
    lastError: null,
    ...REPORT_DEFAULTS,
  });
  assert.doesNotMatch(report.title, /[\uD800-\uDBFF]$/);
  assert.doesNotMatch(report.body, /[\uD800-\uDBFF]$/);
  assert.doesNotThrow(() => buildIssueUrl({ title: report.title, body: report.body }));
});
