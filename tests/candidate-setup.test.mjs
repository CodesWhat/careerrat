// Tests for candidate-setup.mjs
// Operates entirely inside a fresh temp directory — never writes into the
// real repo's candidate/ directory.

import assert from "node:assert/strict";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { closeAll } from "../src/core/db/connection.mjs";
import {
  authorizationDeclared,
  candidateArtifactPut,
  candidateConfigGet,
  candidateConfigPatch,
  candidateSetupInitialize,
} from "../src/core/db/verbs.mjs";
import { userPath } from "../src/core/paths/workspace.mjs";
import {
  CANDIDATE_FILES,
  COPY_ONLY_CANDIDATE_FILES,
  ensureCandidateFiles,
  lintPlaceholders,
  loadCandidate,
  OPTIONAL_CANDIDATE_FILES,
} from "../src/core/profile/candidate-setup.mjs";
import { validate } from "../src/core/profile/schema-validator.mjs";

import { stringifyYaml } from "../src/core/profile/yaml.mjs";

// ---------------------------------------------------------------------------
// Resolve real repo root (this test file lives at tests/, one level below root)
// ---------------------------------------------------------------------------

const REAL_ROOT = fileURLToPath(new URL("..", import.meta.url));
const dbRoots = [];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildTempRoot() {
  const tempRoot = mkdtempSync(join(tmpdir(), "careerrat-test-"));

  // Create templates/ and config/ dirs
  mkdirSync(join(tempRoot, "templates"), { recursive: true });
  mkdirSync(join(tempRoot, "config"), { recursive: true });

  // Copy the 5 real templates and 5 real schemas into the temp root
  for (const entry of CANDIDATE_FILES) {
    copyFileSync(join(REAL_ROOT, entry.templatePath), join(tempRoot, entry.templatePath));
    copyFileSync(join(REAL_ROOT, entry.schemaPath), join(tempRoot, entry.schemaPath));
  }

  for (const entry of OPTIONAL_CANDIDATE_FILES) {
    copyFileSync(join(REAL_ROOT, entry.templatePath), join(tempRoot, entry.templatePath));
    copyFileSync(join(REAL_ROOT, entry.schemaPath), join(tempRoot, entry.schemaPath));
  }

  // Copy the freeform copy-only templates (e.g. SOURCE_RESUME.md) — no schema.
  for (const entry of COPY_ONLY_CANDIDATE_FILES) {
    copyFileSync(join(REAL_ROOT, entry.templatePath), join(tempRoot, entry.templatePath));
  }

  return tempRoot;
}

function candidatePath(root, relPath) {
  return userPath({ repoRoot: root }, relPath);
}

function buildDbRoot() {
  const repoRoot = mkdtempSync(join(tmpdir(), "careerrat-candidate-db-"));
  dbRoots.push(repoRoot);
  candidateSetupInitialize({ repoRoot });
  return repoRoot;
}

function formDefaultsSchema() {
  return JSON.parse(readFileSync(join(REAL_ROOT, "config/form-defaults.schema.json"), "utf8"));
}

function targetingSchema() {
  return JSON.parse(readFileSync(join(REAL_ROOT, "config/targeting.schema.json"), "utf8"));
}

after(() => {
  closeAll();
  for (const root of dbRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe("candidate-setup", () => {
  let tempRoot;

  before(() => {
    tempRoot = buildTempRoot();
  });

  after(() => {
    try {
      rmSync(tempRoot, { recursive: true, force: true });
    } catch {
      // best-effort cleanup
    }
  });

  // -------------------------------------------------------------------------
  it("CANDIDATE_FILES has exactly 5 entries with required shape", () => {
    assert.equal(CANDIDATE_FILES.length, 5);
    for (const entry of CANDIDATE_FILES) {
      assert.ok(typeof entry.name === "string", "name must be string");
      assert.ok(typeof entry.candidatePath === "string", "candidatePath must be string");
      assert.ok(typeof entry.templatePath === "string", "templatePath must be string");
      assert.ok(typeof entry.schemaPath === "string", "schemaPath must be string");
      // Forward-slash paths
      assert.ok(!entry.candidatePath.includes("\\"), "candidatePath must use forward slashes");
    }
  });

  // -------------------------------------------------------------------------
  it("OPTIONAL_CANDIDATE_FILES has required shape", () => {
    assert.equal(OPTIONAL_CANDIDATE_FILES.length, 1);
    for (const entry of OPTIONAL_CANDIDATE_FILES) {
      assert.ok(typeof entry.name === "string", "name must be string");
      assert.ok(typeof entry.candidatePath === "string", "candidatePath must be string");
      assert.ok(typeof entry.templatePath === "string", "templatePath must be string");
      assert.ok(typeof entry.schemaPath === "string", "schemaPath must be string");
      assert.ok(!entry.candidatePath.includes("\\"), "candidatePath must use forward slashes");
    }
  });

  // -------------------------------------------------------------------------
  it("ensureCandidateFiles — first run creates 7 files (5 required config + modes + source résumé)", () => {
    const result = ensureCandidateFiles({ root: tempRoot });
    assert.equal(result.created.length, 7, "should create 7 files on first run");
    assert.equal(result.existing.length, 0, "no files should already exist");

    // Verify files actually exist on disk
    for (const entry of CANDIDATE_FILES) {
      assert.ok(
        existsSync(candidatePath(tempRoot, entry.candidatePath)),
        `${entry.candidatePath} should exist on disk`
      );
    }
    for (const entry of OPTIONAL_CANDIDATE_FILES) {
      assert.ok(
        existsSync(candidatePath(tempRoot, entry.candidatePath)),
        `${entry.candidatePath} should exist on disk`
      );
    }
  });

  // -------------------------------------------------------------------------
  it("ensureCandidateFiles — second run does NOT overwrite existing files", () => {
    // Write a sentinel into the first candidate file
    const firstEntry = CANDIDATE_FILES[0];
    const firstPath = candidatePath(tempRoot, firstEntry.candidatePath);
    const sentinelText = "# SENTINEL-DO-NOT-OVERWRITE\n";
    writeFileSync(firstPath, sentinelText, "utf8");

    const result = ensureCandidateFiles({ root: tempRoot });
    assert.equal(result.created.length, 0, "no files should be created on second run");
    assert.equal(result.existing.length, 7, "all 7 should be reported as existing");

    // Sentinel must still be present
    const content = readFileSync(firstPath, "utf8");
    assert.ok(content.includes("SENTINEL-DO-NOT-OVERWRITE"), "sentinel must not be overwritten");
  });

  // -------------------------------------------------------------------------
  it("loadCandidate — ok after restoring valid files", () => {
    // Restore the first candidate file to a valid copy from the template
    const firstEntry = CANDIDATE_FILES[0];
    copyFileSync(
      join(tempRoot, firstEntry.templatePath),
      candidatePath(tempRoot, firstEntry.candidatePath)
    );

    const result = loadCandidate({ root: tempRoot });
    assert.equal(result.ok, true, "ok should be true when all files are valid");
    assert.equal(result.files.length, 5, "should have 5 file results");
    for (const f of result.files) {
      assert.equal(f.exists, true, `${f.name} should exist`);
      assert.equal(f.valid, true, `${f.name} should be valid`);
      assert.equal(f.errors.length, 0, `${f.name} should have no errors`);
    }
  });

  // -------------------------------------------------------------------------
  it("loadCandidate — invalid profile yields ok=false and non-empty errors", () => {
    // Overwrite profile.yml with an object missing required 'email'
    const profileEntry = CANDIDATE_FILES.find((e) => e.name === "profile");
    const profilePath = candidatePath(tempRoot, profileEntry.candidatePath);

    // Only provides candidate.full_name; missing email, and missing top-level
    // required keys: compensation, location, authorization
    const badData = {
      candidate: { full_name: "X" },
    };
    writeFileSync(profilePath, stringifyYaml(badData), "utf8");

    const result = loadCandidate({ root: tempRoot });
    assert.equal(result.ok, false, "ok should be false when a file is invalid");

    const profileResult = result.files.find((f) => f.name === "profile");
    assert.ok(profileResult, "profile result must be present");
    assert.equal(profileResult.exists, true, "profile file exists");
    assert.equal(profileResult.valid, false, "profile should be invalid");
    assert.ok(profileResult.errors.length > 0, "profile should have validation errors");
  });

  // -------------------------------------------------------------------------
  it("loadCandidate — missing file reported with exists=false and file-missing error", () => {
    // Temporarily rename one file to simulate missing
    const lastEntry = CANDIDATE_FILES[CANDIDATE_FILES.length - 1];
    const realPath = candidatePath(tempRoot, lastEntry.candidatePath);
    const hiddenPath = `${realPath}.hidden`;

    // Move it out of the way
    copyFileSync(realPath, hiddenPath);
    rmSync(realPath);

    const result = loadCandidate({ root: tempRoot });
    assert.equal(result.ok, false, "ok should be false when a file is missing");

    const missing = result.files.find((f) => f.name === lastEntry.name);
    assert.ok(missing, "missing file entry must be present");
    assert.equal(missing.exists, false);
    assert.equal(missing.valid, false);
    assert.ok(
      missing.errors.some((e) => e.message === "file missing"),
      "error should say 'file missing'"
    );

    // Restore
    copyFileSync(hiddenPath, realPath);
    rmSync(hiddenPath);
  });

  // -------------------------------------------------------------------------
  it("lintPlaceholders — freshly-copied templates contain placeholder findings", () => {
    // Restore all candidate files from templates so they have placeholder values
    for (const entry of CANDIDATE_FILES) {
      copyFileSync(
        join(tempRoot, entry.templatePath),
        candidatePath(tempRoot, entry.candidatePath)
      );
    }

    const result = lintPlaceholders({ root: tempRoot });
    assert.equal(result.clean, false, "freshly-copied templates should NOT be clean");
    assert.ok(result.findings.length > 0, "should have at least one placeholder finding");

    // Verify findings have required shape
    for (const finding of result.findings) {
      assert.ok(typeof finding.file === "string", "finding.file must be string");
      assert.ok(
        typeof finding.line === "number" && finding.line >= 1,
        "finding.line must be 1-based number"
      );
      assert.ok(typeof finding.text === "string", "finding.text must be string");
      // file is relative to root (no absolute path)
      assert.ok(!finding.file.startsWith("/"), "finding.file must be relative");
    }
  });

  // -------------------------------------------------------------------------
  it("lintPlaceholders — realistic profile clears profile-specific findings", () => {
    // Write a realistic, non-placeholder profile
    const profileEntry = CANDIDATE_FILES.find((e) => e.name === "profile");
    const profilePath = candidatePath(tempRoot, profileEntry.candidatePath);

    const realisticProfile = {
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
    writeFileSync(profilePath, stringifyYaml(realisticProfile), "utf8");

    const result = lintPlaceholders({ root: tempRoot });

    // Findings from profile.yml should be gone
    const profileFindings = result.findings.filter((f) =>
      f.file.endsWith(profileEntry.candidatePath)
    );
    assert.equal(
      profileFindings.length,
      0,
      `profile should have no placeholder findings after rewrite; got: ${JSON.stringify(profileFindings)}`
    );
  });

  // -------------------------------------------------------------------------
  it("lintPlaceholders — returns clean=true when no candidate files exist", () => {
    // Build a fresh temp root with no candidate/ dir
    const emptyRoot = mkdtempSync(join(tmpdir(), "careerrat-empty-"));
    try {
      mkdirSync(join(emptyRoot, "templates"), { recursive: true });
      mkdirSync(join(emptyRoot, "config"), { recursive: true });
      // Copy templates/schemas but do NOT run ensureCandidateFiles
      for (const entry of CANDIDATE_FILES) {
        copyFileSync(join(REAL_ROOT, entry.templatePath), join(emptyRoot, entry.templatePath));
        copyFileSync(join(REAL_ROOT, entry.schemaPath), join(emptyRoot, entry.schemaPath));
      }

      const result = lintPlaceholders({ root: emptyRoot });
      assert.equal(result.clean, true, "no candidate files → clean");
      assert.equal(result.findings.length, 0, "no findings when no candidate files");
    } finally {
      rmSync(emptyRoot, { recursive: true, force: true });
    }
  });
});

describe("candidate setup DB readiness and document formats", () => {
  it("keeps search_ready earlier than gate_ready/apply_ready when compensation is absent", () => {
    const repoRoot = buildDbRoot();

    candidateArtifactPut({
      repoRoot,
      id: "source-resume",
      kind: "source-resume",
      data: {
        format: "text",
        text: "AI builder with identity automation and agent workflow experience.",
      },
    });
    candidateConfigPatch({
      repoRoot,
      name: "targeting",
      patch: {
        role_buckets: [
          {
            name: "AI builder",
            priority: "primary",
            titles: ["Applied AI Engineer", "Forward Deployed Engineer"],
          },
        ],
        search_preferences: {
          cadence: {
            mode: "weekly",
            recommended_from: "default",
            saved_at: "2026-07-05T22:00:00Z",
          },
        },
      },
    });
    candidateConfigPatch({
      repoRoot,
      name: "profile",
      patch: {
        candidate: {
          full_name: "Scott Candidate",
          email: "scott@example.com",
        },
        location: {
          home: "New York, NY",
          remote: true,
          hybrid: true,
          onsite: false,
          relocation: [],
        },
      },
    });

    const config = candidateConfigGet({ repoRoot });
    assert.equal(config.profile.compensation.minimum_base, null);
    assert.deepEqual(config.targeting.search_preferences.cadence, {
      mode: "weekly",
      recommended_from: "default",
      saved_at: "2026-07-05T22:00:00Z",
    });
    assert.equal(config.setup.readiness.search_ready, true);
    assert.equal(config.setup.readiness.gate_ready, false);
    assert.equal(config.setup.readiness.apply_ready, false);
    assert.deepEqual(config.setup.missing.search_ready, []);
    assert.match(config.setup.missing.gate_ready.join("\n"), /compensation floor/i);
    assert.match(config.setup.missing.apply_ready.join("\n"), /compensation floor/i);
  });

  it("defaults targeting.search_preferences cadence without changing search readiness gates", () => {
    const repoRoot = buildDbRoot();
    const config = candidateConfigGet({ repoRoot });

    assert.deepEqual(config.targeting.search_preferences, {
      posting_age: { mode: "since-last-run" },
      cadence: { mode: "daily", recommended_from: "default" },
    });
    assert.equal(config.setup.readiness.search_ready, false);
    assert.ok(config.setup.missing.search_ready.includes("source resume"));
    assert.ok(!config.setup.missing.search_ready.includes("compensation floor"));
  });

  it("validates cadence search preferences and still rejects unknown search preference keys", () => {
    const schema = targetingSchema();
    const validCadence = validate(
      {
        role_buckets: [],
        keep_signals: [],
        cut_signals: [],
        search_preferences: {
          posting_age: { mode: "since-last-run" },
          cadence: {
            mode: "every-3-days",
            recommended_from: "history",
            saved_at: "2026-07-05T22:00:00Z",
          },
        },
      },
      schema
    );
    assert.equal(validCadence.valid, true, JSON.stringify(validCadence.errors));

    const invalidMode = validate(
      {
        role_buckets: [],
        keep_signals: [],
        cut_signals: [],
        search_preferences: {
          cadence: { mode: "hourly", recommended_from: "default" },
        },
      },
      schema
    );
    assert.equal(invalidMode.valid, false, "unknown cadence modes must be rejected");
    assert.match(JSON.stringify(invalidMode.errors), /cadence|hourly|enum/i);

    const unknownKey = validate(
      {
        role_buckets: [],
        keep_signals: [],
        cut_signals: [],
        search_preferences: {
          cadence: { mode: "daily", recommended_from: "default" },
          scheduler: { enabled: true },
        },
      },
      schema
    );
    assert.equal(unknownKey.valid, false, "unknown search_preferences keys must be rejected");
    assert.match(JSON.stringify(unknownKey.errors), /search_preferences|scheduler|additional/i);
  });

  it("uses local sourcing API wrappers for durable first-search runs", async () => {
    const api = await import(`../apps/web/src/lib/api.js?candidate-setup=${Date.now()}`);
    const originalFetch = globalThis.fetch;
    const calls = [];
    globalThis.fetch = async (path, options = {}) => {
      calls.push({ path: String(path), options });
      return {
        ok: true,
        status: 202,
        text: async () => JSON.stringify({ ok: true, run: { id: "run-1", status: "running" } }),
      };
    };

    try {
      assert.equal(typeof api.getSourcingRun, "function");
      assert.equal(typeof api.startFirstSearchRun, "function");
      assert.equal(typeof api.startSearchRun, "function");

      await api.getSourcingRun({ purpose: "first-search" });
      await api.startFirstSearchRun({ retry: true });
      await api.startSearchRun({ purpose: "manual-search" });
    } finally {
      globalThis.fetch = originalFetch;
    }

    assert.deepEqual(
      calls.map((call) => call.path),
      [
        "/api/sourcing/runs/latest?purpose=first-search",
        "/api/sourcing/first-run/start",
        "/api/sourcing/search/start",
      ]
    );
    assert.equal(calls[0].options.method, undefined);
    assert.equal(calls[1].options.method, "POST");
    assert.equal(calls[2].options.method, "POST");
    assert.deepEqual(JSON.parse(calls[1].options.body), { retry: true });
    assert.deepEqual(JSON.parse(calls[2].options.body), { purpose: "manual-search" });
    assert.equal(
      calls.some((call) => /\/api\/(?:discovery|chat|skill\/run)\b/.test(call.path)),
      false
    );
  });

  it("defaults form-defaults.document_formats to PDF packets with no board-required exports", () => {
    const repoRoot = buildDbRoot();
    const config = candidateConfigGet({ repoRoot });

    assert.deepEqual(config["form-defaults"].document_formats, {
      default_packet_format: "pdf",
      required_export_formats: [],
    });
  });

  it("validates DOCX as a board-required export format and rejects unknown formats", () => {
    const schema = formDefaultsSchema();

    const docxAllowed = validate(
      {
        auto_submit: false,
        document_formats: {
          default_packet_format: "pdf",
          required_export_formats: ["docx"],
        },
      },
      schema
    );
    assert.equal(docxAllowed.valid, true, JSON.stringify(docxAllowed.errors));

    const unknownRejected = validate(
      {
        auto_submit: false,
        document_formats: {
          default_packet_format: "pdf",
          required_export_formats: ["pages"],
        },
      },
      schema
    );
    assert.equal(unknownRejected.valid, false, "unknown export formats must be rejected");
    assert.match(JSON.stringify(unknownRejected.errors), /document_formats|pages|enum/i);
  });

  it("validates declined_fields — an object with declined_at, or null to clear it", () => {
    const schema = formDefaultsSchema();

    const declined = validate(
      {
        auto_submit: false,
        declined_fields: { authorization: { declined_at: "2026-08-09T12:00:00Z" } },
      },
      schema
    );
    assert.equal(declined.valid, true, JSON.stringify(declined.errors));

    const cleared = validate(
      { auto_submit: false, declined_fields: { authorization: null } },
      schema
    );
    assert.equal(cleared.valid, true, JSON.stringify(cleared.errors));

    const missingTimestamp = validate(
      { auto_submit: false, declined_fields: { authorization: {} } },
      schema
    );
    assert.equal(missingTimestamp.valid, false, "declined_at must be required when present");
  });

  it("authorizationDeclared — R3 readiness declared-split (declined, false/false via decline, absent)", () => {
    // Absent: no authorization sub-object, no decline — still missing. This is
    // also the freshly-initialized DB row's exact shape (DEFAULTS.profile.authorization
    // is {false, false}), so a plain profile-shape check can never tell "never
    // touched" apart from "explicitly answered false/false" — see this
    // function's own header comment for why the false/false case below is
    // only declared once the UI also records a decline.
    assert.equal(authorizationDeclared({}, {}), false);
    assert.equal(authorizationDeclared({ authorization: {} }, {}), false);
    assert.equal(
      authorizationDeclared(
        { authorization: { work_authorized: false, requires_sponsorship: false } },
        {}
      ),
      false,
      "false/false alone (no recorded decline) must still read as missing — same shape as an untouched default"
    );

    // True/anything and anything/true count (the pre-existing "authorized" case).
    assert.equal(
      authorizationDeclared(
        { authorization: { work_authorized: true, requires_sponsorship: false } },
        {}
      ),
      true
    );

    // An explicit false/false answer counts as declared once the interview UI
    // has also recorded it as a decline (InterviewSurface's own save path).
    assert.equal(
      authorizationDeclared(
        { authorization: { work_authorized: false, requires_sponsorship: false } },
        { declined_fields: { authorization: { declined_at: "2026-08-09T12:00:00Z" } } }
      ),
      true
    );

    // A recorded decline counts as declared even with no authorization sub-object.
    assert.equal(
      authorizationDeclared(
        {},
        { declined_fields: { authorization: { declined_at: "2026-08-09T12:00:00Z" } } }
      ),
      true
    );

    // A cleared decline (null) does not count.
    assert.equal(authorizationDeclared({}, { declined_fields: { authorization: null } }), false);
  });

  it("computeCandidateSetup — a recorded decline drops 'work authorization' from gate/apply missing", () => {
    const repoRoot = buildDbRoot();
    candidateConfigPatch({
      repoRoot,
      name: "targeting",
      patch: { role_buckets: [{ name: "Primary", priority: "primary", titles: ["Engineer"] }] },
    });
    candidateConfigPatch({
      repoRoot,
      name: "profile",
      patch: { location: { home: "Remote", remote: true, hybrid: false, onsite: false } },
    });

    candidateConfigPatch({
      repoRoot,
      name: "form-defaults",
      patch: { declined_fields: { authorization: { declined_at: "2026-08-09T12:00:00Z" } } },
    });

    const config = candidateConfigGet({ repoRoot });
    assert.ok(
      !config.setup.missing.gate_ready.includes("work authorization"),
      `expected "work authorization" to be cleared by a decline; got: ${JSON.stringify(config.setup.missing.gate_ready)}`
    );
  });
});
