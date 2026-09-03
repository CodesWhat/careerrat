// Tests for checkTemplateLeftovers (src/core/profile/candidate-setup.mjs) and its
// wiring into `careerrat doctor` (src/cli/doctor.mjs). Follows the buildTempRoot
// pattern in tests/candidate-setup.test.mjs — every check runs inside a fresh temp
// directory, never against the real repo's candidate/ directory.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { platform, tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { closeAll, dbExists, openDb } from "../src/core/db/connection.mjs";
import { displayPath, userPath } from "../src/core/paths/workspace.mjs";
import {
  CANDIDATE_FILES,
  COPY_ONLY_CANDIDATE_FILES,
  checkTemplateLeftovers,
  ensureCandidateFiles,
  OPTIONAL_CANDIDATE_FILES,
  TEMPLATE_LEFTOVER_MARKERS,
} from "../src/core/profile/candidate-setup.mjs";
import { stringifyYaml } from "../src/core/profile/yaml.mjs";

const REAL_ROOT = fileURLToPath(new URL("..", import.meta.url));

after(() => {
  closeAll();
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildTempRoot() {
  const tempRoot = mkdtempSync(join(tmpdir(), "careerrat-template-leftovers-"));
  mkdirSync(join(tempRoot, "templates"), { recursive: true });
  mkdirSync(join(tempRoot, "config"), { recursive: true });
  for (const entry of CANDIDATE_FILES) {
    copyFileSync(join(REAL_ROOT, entry.templatePath), join(tempRoot, entry.templatePath));
    copyFileSync(join(REAL_ROOT, entry.schemaPath), join(tempRoot, entry.schemaPath));
  }
  for (const entry of OPTIONAL_CANDIDATE_FILES) {
    copyFileSync(join(REAL_ROOT, entry.templatePath), join(tempRoot, entry.templatePath));
    copyFileSync(join(REAL_ROOT, entry.schemaPath), join(tempRoot, entry.schemaPath));
  }
  for (const entry of COPY_ONLY_CANDIDATE_FILES) {
    copyFileSync(join(REAL_ROOT, entry.templatePath), join(tempRoot, entry.templatePath));
  }
  return tempRoot;
}

function candidatePath(root, relPath) {
  return userPath({ repoRoot: root }, relPath);
}

function realisticProfile() {
  return {
    candidate: {
      full_name: "Sam Smith",
      preferred_name: "Sam",
      email: "sam@example.org",
      phone: "+1-415-555-9999",
      location: "San Francisco, CA",
      linkedin: "https://linkedin.com/in/samsmith",
      github: "https://github.com/samsmith",
      portfolio: "https://samsmith.dev",
    },
    compensation: {
      currency: "USD",
      current_comp_shareable: false,
      current_base: null,
      target_base: 200000,
      minimum_base: 180000,
      target_total_comp: null,
      cash_over_equity: true,
    },
    location: {
      home: "San Francisco, CA",
      remote: true,
      hybrid: true,
      onsite: false,
      relocation: [],
      travel_tolerance: "low",
    },
    authorization: {
      work_authorized: true,
      requires_sponsorship: false,
      notice_period: "2 weeks",
    },
  };
}

function realisticHonesty() {
  return {
    education: { highest_degree: null, add_education_section: false },
    tools: { confirmed: ["Python"], adjacent: ["Go"], do_not_claim: ["Rust"] },
    claims: { do_not_fabricate: ["degrees"] },
    style: { prefer: ["plain language"], avoid: ["buzzwords"] },
  };
}

function realisticEvidence() {
  return {
    claims: [
      {
        id: "project-001",
        claim: "Shipped a real production feature.",
        evidence: "Led the rollout end to end for a real internal customer.",
        metrics: ["30% faster onboarding"],
        links: ["https://example.com/real-project"],
        role_signals: ["prototype-to-production"],
        allowed_wording: ["production workflow"],
        forbidden_wording: ["model training"],
      },
    ],
  };
}

function realisticTargeting() {
  return {
    role_buckets: [
      {
        name: "Primary",
        priority: "primary",
        titles: ["Registered Nurse"],
        notes: "Focus on acute-care units with strong nurse-to-patient ratios.",
      },
    ],
    keep_signals: ["patient-facing care"],
    cut_signals: ["administrative only"],
    excluded_companies: [],
    tracked_companies: [],
    degree_policy: "Apply regardless of degree requirements.",
  };
}

function realisticFormDefaults() {
  return {
    source: "Referral",
    option_aliases: { source: ["Other"], location: [] },
    work_authorization: "Yes",
    requires_sponsorship: "No",
    current_employer: "Acme Health",
    current_title: "Registered Nurse",
    expected_base: "95000",
    linkedin: "https://linkedin.com/in/samsmith",
    eeo_default: "Prefer not to answer",
    voluntary_self_identification: {
      enabled: false,
      default_action: "leave_blank",
      answers: {},
    },
    screening_answers: {},
    confirm_current_role: false,
  };
}

// Writes personalized (non-template) content for every one of CANDIDATE_FILES,
// so a test asserting "clean" isn't accidentally passing because two of the
// five files were left as unedited template copies.
function writeRealisticCandidateFiles(root) {
  writeFileSync(
    candidatePath(root, "candidate/profile.yml"),
    stringifyYaml(realisticProfile()),
    "utf8"
  );
  writeFileSync(
    candidatePath(root, "candidate/honesty.yml"),
    stringifyYaml(realisticHonesty()),
    "utf8"
  );
  writeFileSync(
    candidatePath(root, "candidate/evidence.yml"),
    stringifyYaml(realisticEvidence()),
    "utf8"
  );
  writeFileSync(
    candidatePath(root, "candidate/targeting.yml"),
    stringifyYaml(realisticTargeting()),
    "utf8"
  );
  writeFileSync(
    candidatePath(root, "candidate/form-defaults.yml"),
    stringifyYaml(realisticFormDefaults()),
    "utf8"
  );
}

// ---------------------------------------------------------------------------
// checkTemplateLeftovers
// ---------------------------------------------------------------------------

describe("checkTemplateLeftovers", () => {
  it("a clean, personalized workspace passes", () => {
    const tempRoot = buildTempRoot();
    try {
      ensureCandidateFiles({ root: tempRoot });
      writeRealisticCandidateFiles(tempRoot);
      const result = checkTemplateLeftovers({ root: tempRoot });
      assert.equal(
        result.clean,
        true,
        `expected no findings; got: ${JSON.stringify(result.findings)}`
      );
      assert.equal(result.status, "clean");
      assert.deepEqual(result.findings, []);
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it("reports one leftover marker with the redacted { file, key, marker } shape", () => {
    const tempRoot = buildTempRoot();
    try {
      ensureCandidateFiles({ root: tempRoot });
      const profile = realisticProfile();
      profile.candidate.email = "jane@example.com"; // still carries the template's email
      writeFileSync(
        candidatePath(tempRoot, "candidate/profile.yml"),
        stringifyYaml(profile),
        "utf8"
      );

      const result = checkTemplateLeftovers({ root: tempRoot });
      assert.equal(result.clean, false);
      const findings = result.findings.filter((f) => f.file.endsWith("candidate/profile.yml"));
      assert.equal(findings.length, 1);
      const [finding] = findings;
      assert.equal(finding.key, "candidate.email");
      assert.equal(finding.marker, "jane@example.com");
      // Redacted to the marker only — never the surrounding record or other real fields.
      assert.equal(Object.keys(finding).sort().join(","), "file,key,marker");
      assert.ok(!finding.marker.includes("Sam Smith"));
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it("freshly-copied templates report every known persona/placeholder marker", () => {
    const tempRoot = buildTempRoot();
    try {
      ensureCandidateFiles({ root: tempRoot }); // first run copies templates verbatim
      const result = checkTemplateLeftovers({ root: tempRoot });
      assert.equal(result.clean, false);
      const markersSeen = new Set(result.findings.map((f) => f.marker));
      for (const { marker } of TEMPLATE_LEFTOVER_MARKERS) {
        assert.ok(markersSeen.has(marker), `expected marker "${marker}" to be reported`);
      }
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it("returns clean=true when no candidate files exist", () => {
    const tempRoot = buildTempRoot();
    try {
      const result = checkTemplateLeftovers({ root: tempRoot });
      assert.equal(result.clean, true);
      assert.equal(result.status, "clean");
      assert.deepEqual(result.findings, []);
      assert.deepEqual(result.files, []);
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it("targeting.yml and form-defaults.yml copied straight from their templates are no longer invisible", () => {
    // Regression for the review finding: these two templates carry no
    // "Jane Candidate"-style persona marker, so an unedited copy used to slip
    // through with zero findings. targeting.yml gets one from a curated marker
    // (persona notes text); form-defaults.yml has no distinctive value at all,
    // so it depends entirely on the whole-file "unedited copy" fallback.
    const tempRoot = buildTempRoot();
    try {
      ensureCandidateFiles({ root: tempRoot });
      const result = checkTemplateLeftovers({ root: tempRoot });
      const targetingDisplay = displayPath({ repoRoot: tempRoot }, "candidate/targeting.yml");
      const formDefaultsDisplay = displayPath(
        { repoRoot: tempRoot },
        "candidate/form-defaults.yml"
      );
      assert.ok(
        result.findings.some((f) => f.file === targetingDisplay),
        "expected a finding for an unedited candidate/targeting.yml"
      );
      const formDefaultsFindings = result.findings.filter((f) => f.file === formDefaultsDisplay);
      assert.equal(formDefaultsFindings.length, 1);
      assert.equal(formDefaultsFindings[0].key, "(whole file)");
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it("a legitimate phrase containing another file's marker text does not warn (cross-file, finding 3)", () => {
    const tempRoot = buildTempRoot();
    try {
      ensureCandidateFiles({ root: tempRoot });
      writeRealisticCandidateFiles(tempRoot);
      // "Adjacent Tool" is a honesty.yml marker; a legitimate evidence claim
      // mentioning it in a different context/file must not trip it.
      writeFileSync(
        candidatePath(tempRoot, "candidate/evidence.yml"),
        stringifyYaml({
          claims: [
            {
              id: "project-001",
              claim: "Shipped a real production feature.",
              evidence: "Rolled out an Adjacent Tool integration for a real internal customer.",
              metrics: ["30% faster onboarding"],
              links: ["https://example.com/real-project"],
              role_signals: ["prototype-to-production"],
              allowed_wording: ["production workflow"],
              forbidden_wording: ["model training"],
            },
          ],
        }),
        "utf8"
      );

      const result = checkTemplateLeftovers({ root: tempRoot });
      assert.equal(
        result.clean,
        true,
        `expected no findings; got: ${JSON.stringify(result.findings)}`
      );
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it("a legitimate value that merely contains a short marker as a substring does not warn (word boundary)", () => {
    const tempRoot = buildTempRoot();
    try {
      ensureCandidateFiles({ root: tempRoot });
      writeFileSync(
        candidatePath(tempRoot, "candidate/honesty.yml"),
        stringifyYaml({
          education: { highest_degree: null, add_education_section: false },
          // "Example Toolkit" contains the "Example Tool" marker as a bare
          // substring but is a real, different tool name.
          tools: { confirmed: ["Example Toolkit"], adjacent: [], do_not_claim: [] },
          claims: { do_not_fabricate: ["degrees"] },
          style: { prefer: ["plain language"], avoid: ["buzzwords"] },
        }),
        "utf8"
      );

      const result = checkTemplateLeftovers({ root: tempRoot });
      const honestyFindings = result.findings.filter((f) =>
        f.file.endsWith("candidate/honesty.yml")
      );
      assert.deepEqual(
        honestyFindings,
        [],
        `expected no findings for a distinct tool name; got: ${JSON.stringify(honestyFindings)}`
      );
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it("reverse coverage: every shipped template, used unmodified as its candidate file, produces at least one finding for that file", () => {
    const tempRoot = buildTempRoot();
    try {
      ensureCandidateFiles({ root: tempRoot }); // copies every template verbatim
      const result = checkTemplateLeftovers({ root: tempRoot });
      for (const entry of CANDIDATE_FILES) {
        const display = displayPath({ repoRoot: tempRoot }, entry.candidatePath);
        const findingsForFile = result.findings.filter((f) => f.file === display);
        assert.ok(
          findingsForFile.length > 0,
          `expected at least one finding for ${display} (from ${entry.templatePath})`
        );
      }
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it("a malformed candidate YAML file is reported unreadable, not silently clean (finding 2)", () => {
    const tempRoot = buildTempRoot();
    try {
      ensureCandidateFiles({ root: tempRoot });
      writeRealisticCandidateFiles(tempRoot); // every other file is clean, so status isolates to this one
      // Unbalanced quote / bad structure: parseYaml throws on this.
      writeFileSync(
        candidatePath(tempRoot, "candidate/profile.yml"),
        'candidate:\n  full_name: "Sam Smith\n    bad: [unterminated\n',
        "utf8"
      );

      const result = checkTemplateLeftovers({ root: tempRoot });
      const display = displayPath({ repoRoot: tempRoot }, "candidate/profile.yml");
      const fileEntry = result.files.find((f) => f.file === display);
      assert.ok(fileEntry, "expected a files[] entry for the malformed profile.yml");
      assert.equal(fileEntry.status, "unreadable");
      assert.equal(
        result.findings.some((f) => f.file === display),
        false,
        "an unreadable file must not silently produce zero findings and read as clean"
      );
      assert.equal(result.clean, false, "clean must not be true when a file couldn't be checked");
      assert.equal(result.status, "indeterminate");
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it("an unreadable candidate file (chmod 000) is reported unreadable, not silently clean (finding 2)", () => {
    if (platform() === "win32") return; // chmod bits don't apply on Windows
    const tempRoot = buildTempRoot();
    try {
      ensureCandidateFiles({ root: tempRoot });
      writeRealisticCandidateFiles(tempRoot); // every other file is clean, so status isolates to this one
      const target = candidatePath(tempRoot, "candidate/profile.yml");

      let readIsActuallyBlocked = false;
      chmodSync(target, 0o000);
      try {
        readFileSync(target, "utf8");
      } catch {
        readIsActuallyBlocked = true;
      }
      if (!readIsActuallyBlocked) return; // running as root; permission bits are a no-op

      const result = checkTemplateLeftovers({ root: tempRoot });
      const display = displayPath({ repoRoot: tempRoot }, "candidate/profile.yml");
      const fileEntry = result.files.find((f) => f.file === display);
      assert.ok(fileEntry, "expected a files[] entry for the unreadable profile.yml");
      assert.equal(fileEntry.status, "unreadable");
      assert.equal(result.clean, false);
      assert.equal(result.status, "indeterminate");
    } finally {
      chmodSync(candidatePath(tempRoot, "candidate/profile.yml"), 0o600);
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it("a missing candidate file is skipped, not reported unreadable", () => {
    const tempRoot = buildTempRoot();
    try {
      ensureCandidateFiles({ root: tempRoot });
      writeRealisticCandidateFiles(tempRoot);
      rmSync(candidatePath(tempRoot, "candidate/targeting.yml"));

      const result = checkTemplateLeftovers({ root: tempRoot });
      const targetingDisplay = displayPath({ repoRoot: tempRoot }, "candidate/targeting.yml");
      assert.equal(
        result.files.some((f) => f.file === targetingDisplay),
        false,
        "a missing file must not appear in files[] at all"
      );
      assert.equal(
        result.findings.some((f) => f.file === targetingDisplay),
        false
      );
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// TEMPLATE_LEFTOVER_MARKERS — coverage vs. the shipped templates
// ---------------------------------------------------------------------------
// Every marker names the template file it came from. If a template edit drops
// or rewords the value a marker targets, this test fails instead of the doctor
// check silently going blind — the two data sources cannot drift apart.

describe("TEMPLATE_LEFTOVER_MARKERS coverage", () => {
  it("every marker still appears verbatim in the template file it names", () => {
    const templateCache = new Map();
    for (const { marker, template } of TEMPLATE_LEFTOVER_MARKERS) {
      if (!templateCache.has(template)) {
        templateCache.set(template, readFileSync(join(REAL_ROOT, template), "utf8"));
      }
      const text = templateCache.get(template);
      assert.ok(
        text.includes(marker),
        `marker "${marker}" not found in ${template} — TEMPLATE_LEFTOVER_MARKERS has drifted from the shipped template`
      );
    }
  });

  it("every candidate template file contributes at least one marker, except form-defaults", () => {
    const coveredTemplates = new Set(TEMPLATE_LEFTOVER_MARKERS.map((m) => m.template));
    // profile, honesty, evidence, and targeting carry persona/placeholder content;
    // form-defaults has no distinctive literal value at all (every value in it is
    // a genuine default a real candidate might keep), so it relies entirely on
    // checkTemplateLeftovers's whole-file "unedited copy" fallback instead — see
    // the reverse-coverage test above, which covers it via that path.
    for (const template of [
      "templates/profile.example.yml",
      "templates/honesty.example.yml",
      "templates/evidence.example.yml",
      "templates/targeting.example.yml",
    ]) {
      assert.ok(coveredTemplates.has(template), `expected at least one marker for ${template}`);
    }
    assert.ok(
      !coveredTemplates.has("templates/form-defaults.example.yml"),
      "form-defaults intentionally has no curated marker; if this now fails, update this comment"
    );
  });
});

// ---------------------------------------------------------------------------
// Wiring into `careerrat doctor`
// ---------------------------------------------------------------------------

function spawnDoctor(home) {
  return spawnSync(process.execPath, [join(REAL_ROOT, "src/cli/doctor.mjs"), "--json"], {
    cwd: REAL_ROOT,
    encoding: "utf8",
    env: { ...process.env, CAREERRAT_HOME: home },
  });
}

function runDoctorJson(home) {
  return JSON.parse(spawnDoctor(home).stdout);
}

describe("doctor --json templateLeftovers wiring", () => {
  it("the demo seed comes out clean", () => {
    const home = mkdtempSync(join(tmpdir(), "careerrat-demo-seed-"));
    try {
      const init = spawnSync(
        process.execPath,
        [join(REAL_ROOT, "src/cli/data.mjs"), "init", "--demo", "--json"],
        { cwd: REAL_ROOT, encoding: "utf8", env: { ...process.env, CAREERRAT_HOME: home } }
      );
      assert.equal(init.status, 0, init.stderr);

      const result = runDoctorJson(home);
      assert.ok(result.templateLeftovers, "doctor --json must include a templateLeftovers field");
      assert.equal(
        result.templateLeftovers.clean,
        true,
        `demo seed should be clean; got findings: ${JSON.stringify(result.templateLeftovers.findings)}`
      );
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("a file-based workspace with unedited templates surfaces findings without failing doctor", () => {
    const home = mkdtempSync(join(tmpdir(), "careerrat-leftover-doctor-"));
    try {
      mkdirSync(join(home, "candidate"), { recursive: true });
      for (const entry of CANDIDATE_FILES) {
        copyFileSync(join(REAL_ROOT, entry.templatePath), join(home, entry.candidatePath));
      }

      const result = runDoctorJson(home);
      assert.ok(result.templateLeftovers.findings.length > 0);
      assert.equal(
        result.missingUser.length,
        0,
        "candidate files exist, so missingUser should be empty"
      );
      // Non-blocking by design: unedited personalization must not gate doctor's ok field.
      assert.equal(
        result.ok,
        true,
        `doctor.ok should stay true despite template leftovers; result: ${JSON.stringify(result)}`
      );
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("templateLeftovers JSON shape includes status and per-file status (finding 2)", () => {
    const home = mkdtempSync(join(tmpdir(), "careerrat-leftover-shape-"));
    try {
      mkdirSync(join(home, "candidate"), { recursive: true });
      for (const entry of CANDIDATE_FILES) {
        copyFileSync(join(REAL_ROOT, entry.templatePath), join(home, entry.candidatePath));
      }

      const res = spawnDoctor(home);
      assert.equal(
        res.status,
        0,
        `exit code should be unchanged (non-blocking); stderr: ${res.stderr}`
      );
      const result = JSON.parse(res.stdout);
      assert.equal(result.templateLeftovers.status, "leftovers");
      assert.ok(Array.isArray(result.templateLeftovers.files));
      assert.ok(result.templateLeftovers.files.length > 0);
      for (const file of result.templateLeftovers.files) {
        assert.ok(["clean", "leftovers", "unreadable"].includes(file.status));
      }
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("a malformed candidate file surfaces as indeterminate without changing doctor's exit code", () => {
    const home = mkdtempSync(join(tmpdir(), "careerrat-leftover-malformed-"));
    try {
      mkdirSync(join(home, "candidate"), { recursive: true });
      // Every file except profile.yml is personalized and clean, so the
      // "indeterminate" status below can only be coming from the malformed
      // profile.yml, not from unrelated leftover findings elsewhere.
      writeFileSync(join(home, "candidate/honesty.yml"), stringifyYaml(realisticHonesty()), "utf8");
      writeFileSync(
        join(home, "candidate/evidence.yml"),
        stringifyYaml(realisticEvidence()),
        "utf8"
      );
      writeFileSync(
        join(home, "candidate/targeting.yml"),
        stringifyYaml(realisticTargeting()),
        "utf8"
      );
      writeFileSync(
        join(home, "candidate/form-defaults.yml"),
        stringifyYaml(realisticFormDefaults()),
        "utf8"
      );
      writeFileSync(
        join(home, "candidate/profile.yml"),
        'candidate:\n  full_name: "Sam Smith\n    bad: [unterminated\n',
        "utf8"
      );

      const res = spawnDoctor(home);
      assert.equal(
        res.status,
        0,
        `exit code should be unchanged (non-blocking); stderr: ${res.stderr}`
      );
      const result = JSON.parse(res.stdout);
      assert.equal(result.templateLeftovers.status, "indeterminate");
      assert.equal(result.templateLeftovers.clean, false);
      assert.equal(
        result.ok,
        true,
        `doctor.ok should stay true despite an unreadable file; result: ${JSON.stringify(result)}`
      );
      const profileFile = result.templateLeftovers.files.find((f) =>
        f.file.endsWith("candidate/profile.yml")
      );
      assert.ok(profileFile, "expected a files[] entry for the malformed profile.yml");
      assert.equal(profileFile.status, "unreadable");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("a DB-backed workspace skips the check with the same non-blocking JSON shape (DB-mode skip)", () => {
    const home = mkdtempSync(join(tmpdir(), "careerrat-leftover-db-"));
    try {
      openDb({ repoRoot: REAL_ROOT, env: { ...process.env, CAREERRAT_HOME: home } });
      closeAll();
      assert.equal(
        dbExists({ repoRoot: REAL_ROOT, env: { ...process.env, CAREERRAT_HOME: home } }),
        true,
        "test setup: db file should exist before spawning doctor"
      );

      // Exit code isn't asserted here: a brand-new DB workspace has other
      // doctor gates (candidate setup readiness, etc.) still outstanding and
      // unrelated to templateLeftovers, so result.ok can legitimately be
      // false. What matters for this fix is that templateLeftovers itself
      // stays the same non-blocking, always-clean shape in DB mode.
      const res = spawnDoctor(home);
      const result = JSON.parse(res.stdout);
      assert.deepEqual(result.templateLeftovers, {
        clean: true,
        status: "clean",
        findings: [],
        files: [],
      });
    } finally {
      closeAll();
      rmSync(home, { recursive: true, force: true });
    }
  });
});
