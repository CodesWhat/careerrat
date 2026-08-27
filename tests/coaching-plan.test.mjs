// tests/coaching-plan.test.mjs
// Unit contracts for buildCoachingPlan (src/core/coaching/plan.mjs), mirroring
// the direct-call style packet-generate-route.test.mjs uses for
// evaluatePacketGate ("packet gate reserves output budget..."). DB/web
// workspace only — buildCoachingPlan is applicationId-keyed against SQLite,
// same as evaluatePacketGate/buildPacketContext.

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, test } from "node:test";
import { buildCoachingPlan } from "../src/core/coaching/plan.mjs";
import { coachingPlanSchema } from "../src/core/coaching/schemas.mjs";
import { closeAll } from "../src/core/db/connection.mjs";
import { importFromTracker } from "../src/core/db/import-from-tracker.mjs";
import { candidateConfigPatch, candidateEvidenceMerge } from "../src/core/db/verbs/candidate.mjs";

const cleanupRoots = [];

function tempRepo() {
  const repoRoot = mkdtempSync(join(tmpdir(), "careerrat-coaching-plan-"));
  cleanupRoots.push(repoRoot);
  return repoRoot;
}

function writeWorkspaceFile(repoRoot, relPath, content) {
  const full = join(repoRoot, "workspace", relPath);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, content, "utf8");
  return `workspace/${relPath}`;
}

function importTrackerFixture(repoRoot, applications) {
  const sourceDir = join(repoRoot, "fixture-source");
  mkdirSync(sourceDir, { recursive: true });
  writeFileSync(
    join(sourceDir, "tracker.json"),
    JSON.stringify(
      { meta: {}, applications, sourced: [], sources: [], communications: [] },
      null,
      2
    )
  );
  importFromTracker({ repoRoot, sourceDir });
}

function reviewEvaluation(overrides = {}) {
  return {
    gate: "review",
    fitScore: 68,
    fitBucket: "med",
    fitSummary: "Relevant scope needs human review.",
    compensation: {
      status: "clears-floor",
      currency: "USD",
      minBase: 150000,
      maxBase: 190000,
      source: "job-description",
      summary: "$150k-$190k clears the floor.",
    },
    action: "resolve-review",
    fitReasons: ["JD centers on platform delivery"],
    fitRisks: ["No direct Kubernetes production experience on record"],
    confidence: "medium",
    evaluatedAt: "2026-08-01T12:00:00.000Z",
    ...overrides,
  };
}

function seedReviewApp(repoRoot, { evaluation = reviewEvaluation(), withEvidence = true } = {}) {
  const jdPath = writeWorkspaceFile(
    repoRoot,
    "jobs/acme-platform-engineer.md",
    [
      "---",
      'company: "Acme Platform"',
      'role: "Platform Engineer"',
      "---",
      "# Job Description",
      "",
      "Own Kubernetes-based platform delivery for internal developer tooling.",
    ].join("\n")
  );
  importTrackerFixture(repoRoot, [
    {
      id: "app-coach",
      company: "Acme Platform",
      role: "Platform Engineer",
      status: "reviewed-hold",
      fitBasis: "evaluated",
      fitBucket: evaluation?.fitBucket ?? null,
      evaluation,
      artifacts: { jd: jdPath },
    },
  ]);
  candidateConfigPatch({
    repoRoot,
    name: "profile",
    patch: { candidate: { full_name: "Alex Rivera" } },
  });
  if (withEvidence) {
    candidateEvidenceMerge({
      repoRoot,
      claims: [
        {
          id: "ev-platform-tooling",
          claim: "Built internal developer-tooling platforms used daily by 3 engineering teams.",
          evidence: "Source: resume (Experience — Northwind Digital).",
        },
      ],
    });
  }
}

function typedPlanVerdict({ kind = "evidence-claim" } = {}) {
  return {
    gaps: [
      {
        gapText: "No direct Kubernetes production experience on record",
        suggestion:
          kind === "evidence-claim"
            ? {
                kind: "evidence-claim",
                draftClaim: {
                  claim: "Ran production platform tooling used daily by 3 engineering teams.",
                  evidence: "Source: resume (Experience — Northwind Digital).",
                },
                rationale: "Grounds platform-delivery scope without claiming Kubernetes itself.",
              }
            : {
                kind: "no-close-path",
                draftClaim: null,
                rationale: "Nothing on record covers direct Kubernetes production ownership.",
              },
      },
    ],
  };
}

after(() => {
  closeAll();
  for (const root of cleanupRoots.splice(0)) {
    try {
      rmSync(root, { recursive: true, force: true });
    } catch {
      // best-effort cleanup
    }
  }
});

test("coachingPlanSchema caps gaps at 3, gapText at 80 chars, and forbids extra properties", () => {
  assert.equal(coachingPlanSchema.type, "object");
  assert.deepEqual(coachingPlanSchema.required, ["gaps"]);
  assert.equal(coachingPlanSchema.additionalProperties, false);
  assert.equal(coachingPlanSchema.properties.gaps.maxItems, 3);
  assert.equal(coachingPlanSchema.properties.gaps.items.properties.gapText.maxLength, 80);
  assert.equal(coachingPlanSchema.properties.gaps.items.additionalProperties, false);
});

test("buildCoachingPlan grounds an evidence-claim suggestion and keeps gapText verbatim from fitRisks", async () => {
  const repoRoot = tempRepo();
  seedReviewApp(repoRoot);
  let seenOptions;

  const result = await buildCoachingPlan({
    repoRoot,
    applicationId: "app-coach",
    runAI: async (options) => {
      seenOptions = options;
      return {
        body: { ok: true, ai: { used: true, model: "claude-test" }, data: typedPlanVerdict() },
      };
    },
  });

  assert.equal(result.status, 200);
  assert.equal(result.body.ok, true);
  assert.equal(seenOptions.aiOperation, "coach.deep");
  assert.equal(seenOptions.effort, undefined);
  const plan = result.body.data;
  assert.equal(plan.gaps.length, 1);
  assert.equal(
    plan.gaps[0].gapText,
    "No direct Kubernetes production experience on record",
    "gapText must be the verbatim fitRisks string, never a model restatement"
  );
  assert.equal(plan.gaps[0].suggestion.kind, "evidence-claim");
  assert.match(plan.gaps[0].suggestion.draftClaim.claim, /platform tooling/i);
  assert.equal(plan.gaps[0].status, "open");
  assert.deepEqual(plan.basedOn, {
    gate: "review",
    fitScore: 68,
    fitBucket: "med",
    evaluatedAt: "2026-08-01T12:00:00.000Z",
  });
  assert.match(plan.generatedAt, /^\d{4}-\d{2}-\d{2}T/);
});

test("buildCoachingPlan accepts an honest no-close-path suggestion as a valid outcome, not a failure", async () => {
  const repoRoot = tempRepo();
  seedReviewApp(repoRoot);

  const result = await buildCoachingPlan({
    repoRoot,
    applicationId: "app-coach",
    runAI: async () => ({
      body: {
        ok: true,
        ai: { used: true },
        data: typedPlanVerdict({ kind: "no-close-path" }),
      },
    }),
  });

  assert.equal(result.status, 200);
  const gap = result.body.data.gaps[0];
  assert.equal(gap.suggestion.kind, "no-close-path");
  assert.equal(gap.suggestion.draftClaim, null);
  assert.match(gap.suggestion.rationale, /Kubernetes/);
});

test("buildCoachingPlan downgrades an evidence-claim suggestion missing a usable draftClaim to no-close-path", async () => {
  const repoRoot = tempRepo();
  seedReviewApp(repoRoot);

  const result = await buildCoachingPlan({
    repoRoot,
    applicationId: "app-coach",
    runAI: async () => ({
      body: {
        ok: true,
        ai: { used: true },
        data: {
          gaps: [
            {
              gapText: "No direct Kubernetes production experience on record",
              suggestion: { kind: "evidence-claim", draftClaim: null, rationale: "Thin claim." },
            },
          ],
        },
      },
    }),
  });

  assert.equal(result.status, 200);
  const gap = result.body.data.gaps[0];
  assert.equal(gap.suggestion.kind, "no-close-path");
  assert.equal(gap.suggestion.draftClaim, null);
});

test("buildCoachingPlan downgrades a gap to no-close-path when the model's echoed gapText does not line up with the risk at that index", async () => {
  const repoRoot = tempRepo();
  seedReviewApp(repoRoot);

  const result = await buildCoachingPlan({
    repoRoot,
    applicationId: "app-coach",
    runAI: async () => ({
      body: {
        ok: true,
        ai: { used: true },
        data: {
          gaps: [
            {
              // Positionally this is gap 0, but the echoed text names a
              // different risk entirely — the model's array likely
              // reordered or merged gaps, so this suggestion must not be
              // trusted for the risk at index 0.
              gapText: "No fintech domain experience on record",
              suggestion: {
                kind: "evidence-claim",
                draftClaim: {
                  claim: "Ran production platform tooling.",
                  evidence: "Source: resume.",
                },
                rationale: "Grounds it.",
              },
            },
          ],
        },
      },
    }),
  });

  assert.equal(result.status, 200);
  const gap = result.body.data.gaps[0];
  assert.equal(
    gap.gapText,
    "No direct Kubernetes production experience on record",
    "gapText in the output must still be the verbatim fitRisks string"
  );
  assert.equal(gap.suggestion.kind, "no-close-path");
  assert.equal(gap.suggestion.draftClaim, null);
  assert.match(gap.suggestion.rationale, /did not line up/i);
});

test("buildCoachingPlan degrades to a manual reviewable plan on NO_AI_ROUTE without fabricating a keep", async () => {
  const repoRoot = tempRepo();
  seedReviewApp(repoRoot);

  const result = await buildCoachingPlan({
    repoRoot,
    applicationId: "app-coach",
    // runAI mirrors what runBoundedAI itself returns for a NO_AI_ROUTE
    // failure — an envelope, never a thrown error (runBoundedAI catches the
    // underlying invoke()'s throw internally; see the equivalent
    // "no AI route stays reviewable" coverage in packet-generate-route.test.mjs).
    runAI: async () => ({
      body: {
        ok: false,
        code: "NO_AI_ROUTE",
        error: { message: "no AI route configured" },
        ai: { used: false },
      },
    }),
  });

  assert.equal(result.status, 200);
  assert.equal(result.body.ok, true);
  const plan = result.body.data;
  assert.equal(plan.manual.required, true);
  assert.equal(plan.manual.code, "NO_AI_ROUTE");
  assert.equal(plan.gaps.length, 1);
  assert.equal(plan.gaps[0].suggestion.kind, "no-close-path");
  assert.equal(plan.gaps[0].suggestion.draftClaim, null);
});

test("buildCoachingPlan refuses to run on a keep verdict (nothing named to coach)", async () => {
  const repoRoot = tempRepo();
  seedReviewApp(repoRoot, { evaluation: { ...reviewEvaluation(), gate: "keep", fitRisks: [] } });

  const result = await buildCoachingPlan({
    repoRoot,
    applicationId: "app-coach",
    runAI: async () => {
      throw new Error("AI must not be called for a non-review gate");
    },
  });

  assert.equal(result.status, 409);
  assert.equal(result.body.ok, false);
  assert.equal(result.body.code, "COACHING_NOT_APPLICABLE");
});

test("buildCoachingPlan refuses to run on a review verdict with no fitRisks named", async () => {
  const repoRoot = tempRepo();
  seedReviewApp(repoRoot, { evaluation: { ...reviewEvaluation(), fitRisks: [] } });

  const result = await buildCoachingPlan({
    repoRoot,
    applicationId: "app-coach",
    runAI: async () => {
      throw new Error("AI must not be called with no named gaps");
    },
  });

  assert.equal(result.status, 409);
  assert.equal(result.body.code, "COACHING_NOT_APPLICABLE");
});

test("buildCoachingPlan returns NOT_FOUND for an unknown applicationId", async () => {
  const repoRoot = tempRepo();
  seedReviewApp(repoRoot);

  const result = await buildCoachingPlan({ repoRoot, applicationId: "does-not-exist" });
  assert.equal(result.status, 404);
  assert.equal(result.body.code, "NOT_FOUND");
});
