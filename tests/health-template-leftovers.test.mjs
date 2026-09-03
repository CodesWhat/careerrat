// Tests for checkTemplateLeftovers (src/core/profile/candidate-setup.mjs) and its
// wiring into `careerrat doctor` (src/cli/doctor.mjs). Follows the buildTempRoot
// pattern in tests/candidate-setup.test.mjs — every check runs inside a fresh temp
// directory, never against the real repo's candidate/ directory.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { userPath } from "../src/core/paths/workspace.mjs";
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

// ---------------------------------------------------------------------------
// checkTemplateLeftovers
// ---------------------------------------------------------------------------

describe("checkTemplateLeftovers", () => {
  it("a clean, personalized workspace passes", () => {
    const tempRoot = buildTempRoot();
    try {
      ensureCandidateFiles({ root: tempRoot });
      writeFileSync(
        candidatePath(tempRoot, "candidate/profile.yml"),
        stringifyYaml(realisticProfile()),
        "utf8"
      );
      writeFileSync(
        candidatePath(tempRoot, "candidate/honesty.yml"),
        stringifyYaml({
          education: { highest_degree: null, add_education_section: false },
          tools: { confirmed: ["Python"], adjacent: ["Go"], do_not_claim: ["Rust"] },
          claims: { do_not_fabricate: ["degrees"] },
          style: { prefer: ["plain language"], avoid: ["buzzwords"] },
        }),
        "utf8"
      );
      writeFileSync(
        candidatePath(tempRoot, "candidate/evidence.yml"),
        stringifyYaml({
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
        }),
        "utf8"
      );
      const result = checkTemplateLeftovers({ root: tempRoot });
      assert.equal(
        result.clean,
        true,
        `expected no findings; got: ${JSON.stringify(result.findings)}`
      );
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
      assert.deepEqual(result.findings, []);
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

  it("every candidate template file contributes at least one marker", () => {
    const coveredTemplates = new Set(TEMPLATE_LEFTOVER_MARKERS.map((m) => m.template));
    // profile, honesty, and evidence carry persona/placeholder content today;
    // targeting and form-defaults have no fixed literal marker to check yet
    // (their examples are legitimate free-text a real candidate might also write).
    for (const template of [
      "templates/profile.example.yml",
      "templates/honesty.example.yml",
      "templates/evidence.example.yml",
    ]) {
      assert.ok(coveredTemplates.has(template), `expected at least one marker for ${template}`);
    }
  });
});

// ---------------------------------------------------------------------------
// Wiring into `careerrat doctor`
// ---------------------------------------------------------------------------

function runDoctorJson(home) {
  const res = spawnSync(process.execPath, [join(REAL_ROOT, "src/cli/doctor.mjs"), "--json"], {
    cwd: REAL_ROOT,
    encoding: "utf8",
    env: { ...process.env, CAREERRAT_HOME: home },
  });
  return JSON.parse(res.stdout);
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
});
