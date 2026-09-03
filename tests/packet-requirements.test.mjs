// tests/packet-requirements.test.mjs
// Coverage for the evidence-tiered requirements table (Port A, slices A1
// engine + A2 contract): normalizeRequirements/deriveFitRisks
// (src/core/packet/requirements.mjs) and their wiring into the packet-gate
// AI verdict parse path (src/core/packet/gate.mjs#evaluatePacketGate).

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, test } from "node:test";
import { closeAll } from "../src/core/db/connection.mjs";
import { importFromTracker } from "../src/core/db/import-from-tracker.mjs";
import { candidateConfigPatch, candidateEvidenceMerge } from "../src/core/db/verbs/candidate.mjs";
import { evaluatePacketGate } from "../src/core/packet/gate.mjs";
import { deriveFitRisks, normalizeRequirements } from "../src/core/packet/requirements.mjs";

// ---------------------------------------------------------------------------
// normalizeRequirements
// ---------------------------------------------------------------------------

test("normalizeRequirements: drops rows without a usable requirement string", () => {
  const rows = normalizeRequirements([
    { requirement: "5+ years backend experience", importance: "critical" },
    { requirement: "", importance: "high" },
    { requirement: "   ", importance: "high" },
    { requirement: 42, importance: "high" },
    {},
    null,
    "not an object",
  ]);
  assert.deepEqual(
    rows.map((r) => r.requirement),
    ["5+ years backend experience"]
  );
});

test("normalizeRequirements: clamps importance to the allowed set, unknown falls back to meaningful", () => {
  const rows = normalizeRequirements([
    { requirement: "Own on-call rotation", importance: "critical" },
    { requirement: "Bonus: Kubernetes", importance: "nice-to-have" },
    { requirement: "No importance given" },
  ]);
  assert.equal(rows[0].importance, "critical");
  assert.equal(rows[1].importance, "meaningful");
  assert.equal(rows[2].importance, "meaningful");
});

test("normalizeRequirements: clamps evidence to the allowed set, unknown falls back to inferred", () => {
  const rows = normalizeRequirements([
    { requirement: "Must have a CPA", evidence: "stated" },
    { requirement: "Reports to the CFO", evidence: "structural" },
    { requirement: "Comfortable with ambiguity", evidence: "vibes" },
    { requirement: "No evidence given" },
  ]);
  assert.equal(rows[0].evidence, "stated");
  assert.equal(rows[1].evidence, "structural");
  assert.equal(rows[2].evidence, "inferred");
  assert.equal(rows[3].evidence, "inferred");
});

test("normalizeRequirements: clamps match to the allowed set, unknown falls back to na", () => {
  const rows = normalizeRequirements([
    { requirement: "5 years Python", match: "strong" },
    { requirement: "AWS certified", match: "partial" },
    { requirement: "PMP certified", match: "missing" },
    { requirement: "Bilingual", match: "sorta" },
    { requirement: "No match given" },
  ]);
  assert.equal(rows[0].match, "strong");
  assert.equal(rows[1].match, "partial");
  assert.equal(rows[2].match, "missing");
  assert.equal(rows[3].match, "na");
  assert.equal(rows[4].match, "na");
});

test("normalizeRequirements: truncates jdSignal to 160 chars and note to a bounded length", () => {
  const longSignal = "x".repeat(300);
  const longNote = "y".repeat(400);
  const rows = normalizeRequirements([
    { requirement: "Long JD phrase", jdSignal: longSignal, note: longNote },
  ]);
  assert.ok(rows[0].jdSignal.length <= 160);
  assert.ok(rows[0].jdSignal.endsWith("…"));
  assert.ok(rows[0].note.length < 400);
  assert.ok(rows[0].note.endsWith("…"));
});

test("normalizeRequirements: dedupes by lowercased requirement, keeping the first occurrence", () => {
  const rows = normalizeRequirements([
    { requirement: "5+ years Python", match: "strong", note: "first" },
    { requirement: "5+ Years PYTHON", match: "missing", note: "second" },
    { requirement: "Different requirement" },
  ]);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].note, "first");
});

test("normalizeRequirements: caps at 20 rows", () => {
  const raw = Array.from({ length: 30 }, (_, i) => ({ requirement: `Requirement ${i}` }));
  const rows = normalizeRequirements(raw);
  assert.equal(rows.length, 20);
  assert.equal(rows[0].requirement, "Requirement 0");
  assert.equal(rows[19].requirement, "Requirement 19");
});

test("normalizeRequirements: never throws on garbage input", () => {
  for (const garbage of [null, undefined, "a string", 42, {}, true, [null, undefined, 1, "x"]]) {
    assert.doesNotThrow(() => normalizeRequirements(garbage));
    assert.deepEqual(normalizeRequirements(garbage), []);
  }
});

// ---------------------------------------------------------------------------
// deriveFitRisks
// ---------------------------------------------------------------------------

test("deriveFitRisks: generates a risk for an uncovered missing critical row", () => {
  const requirements = normalizeRequirements([
    {
      requirement: "5+ years Kubernetes in production",
      importance: "critical",
      match: "missing",
      note: "No Kubernetes experience on record.",
    },
  ]);
  const risks = deriveFitRisks(requirements, []);
  assert.deepEqual(risks, [
    "5+ years Kubernetes in production is missing: No Kubernetes experience on record.",
  ]);
});

test("deriveFitRisks: generates a risk without a trailing colon when note is empty", () => {
  const requirements = normalizeRequirements([
    { requirement: "CPA license", importance: "high", match: "partial", note: "" },
  ]);
  const risks = deriveFitRisks(requirements, []);
  assert.deepEqual(risks, ["CPA license is partial"]);
});

test("deriveFitRisks: reuses an existing fitRisk string that already names the row", () => {
  const requirements = normalizeRequirements([
    {
      requirement: "Kubernetes production experience",
      importance: "critical",
      match: "missing",
      note: "No direct experience.",
    },
  ]);
  const risks = deriveFitRisks(requirements, [
    "No direct Kubernetes production experience on record",
  ]);
  assert.deepEqual(risks, ["No direct Kubernetes production experience on record"]);
});

test("deriveFitRisks: never names a strong/na or low-importance row", () => {
  const requirements = normalizeRequirements([
    { requirement: "5 years Python", importance: "critical", match: "strong" },
    { requirement: "Nice to have: Rust", importance: "low_signal", match: "missing" },
    { requirement: "Some preferred skill", importance: "preferred", match: "missing" },
    { requirement: "Meaningful but not gating", importance: "meaningful", match: "missing" },
  ]);
  const risks = deriveFitRisks(requirements, []);
  assert.deepEqual(risks, []);
});

test("deriveFitRisks: appends an uncovered existing risk at the end instead of dropping it", () => {
  const requirements = normalizeRequirements([
    { requirement: "On-call rotation", importance: "critical", match: "missing", note: "None." },
  ]);
  const risks = deriveFitRisks(requirements, ["Travel is 50%, candidate prefers under 10%"]);
  assert.deepEqual(risks, [
    "On-call rotation is missing: None.",
    "Travel is 50%, candidate prefers under 10%",
  ]);
});

test("deriveFitRisks: each existing risk string is consumed at most once", () => {
  const requirements = normalizeRequirements([
    { requirement: "Kubernetes", importance: "critical", match: "missing" },
    { requirement: "Docker", importance: "high", match: "missing" },
  ]);
  const risks = deriveFitRisks(requirements, [
    "No Kubernetes or Docker experience shows up anywhere on record",
  ]);
  // The single existing string covers both rows textually but can only be
  // reused once; the second row falls back to a synthesized entry.
  assert.equal(risks.length, 2);
  assert.equal(risks[0], "No Kubernetes or Docker experience shows up anywhere on record");
  assert.match(risks[1], /^Docker is missing/);
});

test("deriveFitRisks: empty requirements table returns existing risks unchanged", () => {
  const risks = deriveFitRisks([], ["Some prior risk copy"]);
  assert.deepEqual(risks, ["Some prior risk copy"]);
});

test("deriveFitRisks: never throws on garbage input", () => {
  assert.doesNotThrow(() => deriveFitRisks(null, null));
  assert.doesNotThrow(() => deriveFitRisks("not an array", "also not an array"));
  assert.deepEqual(deriveFitRisks(null, null), []);
});

// ---------------------------------------------------------------------------
// evaluatePacketGate parse path (Port A slice A2: the AI verdict contract)
// ---------------------------------------------------------------------------

const cleanupRoots = [];

after(async () => {
  closeAll();
  for (const root of cleanupRoots.splice(0)) {
    try {
      rmSync(root, { recursive: true, force: true });
    } catch {
      // best-effort cleanup
    }
  }
});

function tempRepo() {
  const repoRoot = mkdtempSync(join(tmpdir(), "careerrat-packet-requirements-"));
  cleanupRoots.push(repoRoot);
  mkdirSync(join(repoRoot, "workspace/jobs"), { recursive: true });
  return repoRoot;
}

function writeWorkspaceFile(repoRoot, relPath, content) {
  const full = join(repoRoot, "workspace", relPath);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, content, "utf8");
  return `workspace/${relPath}`;
}

function seedApp(repoRoot) {
  const jdPath = writeWorkspaceFile(
    repoRoot,
    "jobs/acme-platform-engineer.md",
    [
      "---",
      'company: "Acme"',
      'role: "Platform Engineer"',
      "---",
      "# Job Description",
      "",
      "Own the Kubernetes platform. 5+ years of production Kubernetes required.",
    ].join("\n")
  );
  const sourceDir = join(repoRoot, "fixture-source");
  mkdirSync(sourceDir, { recursive: true });
  writeFileSync(
    join(sourceDir, "tracker.json"),
    JSON.stringify(
      {
        meta: {},
        applications: [
          {
            id: "app-requirements",
            company: "Acme",
            role: "Platform Engineer",
            status: "sourced",
            artifacts: { jd: jdPath },
          },
        ],
        sourced: [],
        sources: [],
        communications: [],
      },
      null,
      2
    )
  );
  importFromTracker({ repoRoot, sourceDir });
  candidateConfigPatch({
    repoRoot,
    name: "profile",
    patch: { candidate: { full_name: "Alex Rivera" } },
  });
  candidateEvidenceMerge({
    repoRoot,
    claims: [
      {
        id: "ev-platform",
        claim: "Ran a production platform team",
        evidence: "Source: resume.",
      },
    ],
  });
}

function fixtureVerdictWithRequirements() {
  return {
    gate: "review",
    fitScore: 68,
    fitSummary: "Solid platform background but no direct Kubernetes production ownership.",
    compensation: {
      status: "unknown",
      currency: null,
      minBase: null,
      maxBase: null,
      minAnnualEarnings: null,
      maxAnnualEarnings: null,
      basis: null,
      source: "unknown",
      summary: "Compensation not posted in the job description.",
    },
    action: "manual",
    fitReasons: ["Strong platform engineering background"],
    fitRisks: [],
    confidence: "medium",
    requirements: [
      {
        requirement: "5+ years production Kubernetes",
        importance: "critical",
        evidence: "stated",
        jdSignal: "5+ years of production Kubernetes required.",
        match: "missing",
        note: "No Kubernetes experience on record.",
      },
      {
        requirement: "Platform ownership",
        importance: "high",
        evidence: "stated",
        jdSignal: "Own the Kubernetes platform.",
        match: "strong",
        note: "Ran a production platform team.",
      },
    ],
  };
}

test("evaluatePacketGate: parses a fixture verdict with a requirements table and derives fitRisks from it", async () => {
  const repoRoot = tempRepo();
  seedApp(repoRoot);

  const result = await evaluatePacketGate({
    repoRoot,
    body: { applicationId: "app-requirements" },
    runAI: async () => ({
      body: {
        ok: true,
        ai: { used: true, model: "test-model" },
        data: fixtureVerdictWithRequirements(),
      },
    }),
  });

  assert.equal(result.status, 200);
  assert.equal(result.body.ok, true);
  const evaluation = result.body.data;
  assert.equal(evaluation.requirements.length, 2);
  assert.equal(evaluation.requirements[0].requirement, "5+ years production Kubernetes");
  assert.equal(evaluation.requirements[0].match, "missing");
  // fitRisks is derived from the table, not the model's own (empty) fitRisks:
  // the one missing/critical row produces exactly one synthesized risk, and
  // the strong/high row never appears.
  assert.deepEqual(evaluation.fitRisks, [
    "5+ years production Kubernetes is missing: No Kubernetes experience on record.",
  ]);
});

test("evaluatePacketGate: an old verdict without a requirements field still parses", async () => {
  const repoRoot = tempRepo();
  seedApp(repoRoot);

  const legacyVerdict = {
    gate: "keep",
    fitScore: 90,
    fitSummary: "Strong platform match.",
    compensation: {
      status: "unknown",
      currency: null,
      minBase: null,
      maxBase: null,
      minAnnualEarnings: null,
      maxAnnualEarnings: null,
      basis: null,
      source: "unknown",
      summary: "Compensation not posted.",
    },
    action: "generate-packet",
    fitReasons: ["Strong platform background"],
    fitRisks: ["No direct Kubernetes production experience on record"],
    confidence: "high",
    // no `requirements` key at all — pre-existing verdict shape.
  };

  const result = await evaluatePacketGate({
    repoRoot,
    body: { applicationId: "app-requirements" },
    runAI: async () => ({
      body: { ok: true, ai: { used: true, model: "test-model" }, data: legacyVerdict },
    }),
  });

  assert.equal(result.status, 200);
  assert.equal(result.body.ok, true);
  const evaluation = result.body.data;
  assert.deepEqual(evaluation.requirements, []);
  // With no table to align against, the model's own fitRisks copy survives
  // untouched (appended, nothing silently dropped).
  assert.deepEqual(evaluation.fitRisks, ["No direct Kubernetes production experience on record"]);
});
