import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, test } from "node:test";

import { closeAll, openDb } from "../src/core/db/connection.mjs";
import { appUpsert, candidateConfigPatch, candidateEvidenceMerge } from "../src/core/db/verbs.mjs";
import { buildInterviewDossier } from "../src/core/interview/dossier.mjs";
import { userPath } from "../src/core/paths/workspace.mjs";

const cleanupRoots = [];

function tempRepo() {
  const repoRoot = mkdtempSync(join(tmpdir(), "careerrat-interview-dossier-"));
  cleanupRoots.push(repoRoot);
  openDb({ repoRoot, env: {} });
  return repoRoot;
}

after(() => {
  closeAll();
  for (const root of cleanupRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function seedCandidate(repoRoot) {
  candidateConfigPatch({
    repoRoot,
    env: {},
    name: "profile",
    patch: {
      candidate: { full_name: "Morgan Lee", preferred_name: "Morgan" },
      compensation: {
        currency: "USD",
        current_base: 180000,
        target_base: 205000,
        minimum_base: 195000,
      },
      authorization: { work_authorized: true, requires_sponsorship: false },
    },
  });
  candidateConfigPatch({
    repoRoot,
    env: {},
    name: "targeting",
    patch: { keep_signals: ["agentic workflow", "customer deployment"] },
  });
  candidateConfigPatch({
    repoRoot,
    env: {},
    name: "honesty",
    patch: { claims: { do_not_fabricate: ["model-training experience"] } },
  });
  candidateEvidenceMerge({
    repoRoot,
    env: {},
    claims: [
      {
        id: "ev-agentic",
        claim: "Shipped three production AI workflow pilots into daily customer use.",
        evidence: "Candidate résumé — Northwind Digital.",
        role_signals: ["agentic workflow", "customer deployment"],
        allowed_wording: ["production AI workflow delivery"],
      },
    ],
  });
}

function seedInterview(repoRoot, { id = "app-temporal", withJd = true } = {}) {
  const artifacts = {};
  if (withJd) {
    const jdPath = "workspace/jobs/temporal-applied-ai-engineer.md";
    const full = userPath({ repoRoot, env: {} }, jdPath);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(
      full,
      [
        "---",
        'company: "Temporal Labs"',
        'role: "Applied AI Engineer"',
        "---",
        "# Job Description",
        "",
        "Build agentic workflows with customers and own customer deployment into production environments.",
      ].join("\n"),
      "utf8"
    );
    artifacts.jd = jdPath;
  }

  appUpsert({
    repoRoot,
    env: {},
    row: {
      id,
      company: "Temporal Labs",
      role: "Applied AI Engineer",
      status: "interview",
      interviewAt: "2026-08-20T14:00:00.000Z",
      interviewNote: "Hiring manager — Thu Aug 20 10:00 AM ET with Priya",
      conversations: [
        {
          date: "2026-08-20T14:00:00.000Z",
          kind: "hiring manager",
          who: "Priya",
          notes: "Discuss customer delivery and production ownership.",
        },
      ],
      artifacts,
    },
  });
}

function readApp(repoRoot, id) {
  const db = openDb({ repoRoot, env: {} });
  const row = db.prepare("SELECT data FROM applications WHERE id = ?").get(id);
  return row ? JSON.parse(row.data) : null;
}

test("buildInterviewDossier renders and persists an evidence-grounded dossier", () => {
  const repoRoot = tempRepo();
  seedCandidate(repoRoot);
  seedInterview(repoRoot);

  const result = buildInterviewDossier({
    repoRoot,
    env: {},
    applicationId: "app-temporal",
    now: new Date("2026-08-09T15:00:00.000Z"),
  });

  assert.equal(result.company, "Temporal Labs");
  assert.equal(result.role, "Applied AI Engineer");
  assert.equal(result.dossier.title, "Temporal Labs, Applied AI Engineer");
  assert.equal(result.dossier.round, "Hiring manager");
  assert.equal(result.audience, "hiring-manager");
  assert.deepEqual(result.jobSignals, ["agentic workflow", "customer deployment"]);
  assert.match(result.dossier.markdown, /Morgan brings directly relevant experience/);
  assert.match(result.dossier.markdown, /Shipped three production AI workflow pilots/);
  assert.match(result.dossier.markdown, /Audience Focus \(hiring-manager\)/);
  assert.match(result.dossier.markdown, /Target base:\*\* USD 205,000/);
  assert.match(result.dossier.markdown, /model-training experience/);
  assert.doesNotMatch(result.dossier.markdown, /180,000|180000|current_base/);

  assert.equal(existsSync(userPath({ repoRoot, env: {} }, result.dossier.path)), true);
  assert.equal(
    readFileSync(userPath({ repoRoot, env: {} }, result.dossier.path), "utf8"),
    result.dossier.markdown
  );
  assert.deepEqual(readApp(repoRoot, "app-temporal").artifacts.interviewDossier, result.dossier);
  assert.equal(result.persisted.event.title, "Temporal Labs: Interview dossier created");
  assert.ok(result.persisted.event.tags.includes("operation:application:interview-prep"));
});

test("buildInterviewDossier fails actionably when the captured JD body is missing", () => {
  const repoRoot = tempRepo();
  seedCandidate(repoRoot);
  seedInterview(repoRoot, { id: "app-no-jd", withJd: false });

  assert.throws(
    () => buildInterviewDossier({ repoRoot, env: {}, applicationId: "app-no-jd" }),
    (error) =>
      error.code === "MISSING_JOB_BODY" && /capture the job description/i.test(error.message)
  );
});
