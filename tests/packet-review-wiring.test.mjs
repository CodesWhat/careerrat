// The AI review pass is wired into generatePacket for cover letters and answers
// only, and every edit it applies has to pass the fact check.

import assert from "node:assert/strict";
import { test } from "node:test";
import { generatePacket } from "../src/core/packet/generate.mjs";
import { reviewArtifact } from "../src/core/packet/reviewer.mjs";

const CONTEXT = {
  application: { id: "app-r", company: "Acme Freight", role: "Dispatch Manager" },
  profile: { candidate: { full_name: "Jordan Rivera" } },
  evidence: { claims: [{ id: "ev-1", claim: "Cut dispatch delays by 40% across 12 depots." }] },
  job: {
    frontmatter: { company: "Acme Freight", role: "Dispatch Manager" },
    body: "Run dispatch.",
  },
  sourceResume: { text: "Northwind Labs. Cut dispatch delays by 40% across 12 depots with Excel." },
};
const QUESTIONS = {
  source: "manual",
  questions: [{ id: "q1", label: "Why this role?", type: "textarea", required: true }],
  excluded: [],
};
const COVER = "I cut dispatch delays by 40% across 12 depots. I worked with Excel.";
const ANSWER = "I cut dispatch delays by 40% and I like running dispatch.";

const RESUME = async () => ({
  proposal: {
    summary: "Dispatch manager.",
    experience: [],
    sections: [],
    skillGroups: [],
    education: [],
  },
  gaps: [],
});

function run(overrides = {}) {
  const reviewed = [];
  const options = {
    context: CONTEXT,
    questionCapture: QUESTIONS,
    modes: {},
    draftResumeProposal: async (input) => {
      reviewed.push("resume-draft");
      return RESUME(input);
    },
    draftCoverLetterBlocks: async () => ({ blocks: [{ text: COVER, evidenceIds: ["ev-1"] }] }),
    draftPacketAnswers: async () => ({
      answers: [{ questionId: "q1", answer: ANSWER, evidenceIds: ["ev-1"] }],
      gaps: [],
    }),
    exportPacketArtifacts: async () => ({ formats: ["pdf"], outputs: {} }),
    ...overrides,
  };
  return { options, reviewed };
}

// Mocked model: proposes one safe edit and one that adds a fact, to whichever
// artifact it is shown. Real reviewArtifact + real fact check do the judging.
function mockedReview(edits, kinds = []) {
  return (input) => {
    kinds.push(input.kind);
    return reviewArtifact({
      ...input,
      runAI: async () => ({ body: { ok: true, ai: { used: true }, data: { edits } } }),
    });
  };
}

test("cover letters and answers are reviewed by default, and only fact-safe edits apply", async () => {
  const kinds = [];
  const { options } = run({
    reviewArtifact: mockedReview(
      [
        { find: "I worked with Excel.", replace: "I used Excel daily.", reason: "tighter" },
        { find: "40%", replace: "65%", reason: "stronger" },
        {
          find: "I like running dispatch.",
          replace: "I like running dispatch at Globex.",
          reason: "name",
        },
      ],
      kinds
    ),
  });
  const result = await generatePacket(options);
  assert.deepEqual(kinds, ["cover letter", "application answers"]);
  assert.match(result.sources.coverLetter, /I used Excel daily\./);
  assert.match(result.sources.coverLetter, /40%/);
  assert.doesNotMatch(result.sources.coverLetter, /65%/);
  assert.doesNotMatch(result.sources.answers, /Globex/);
  assert.equal(result.review.coverLetter.applied, 1);
  assert.equal(result.review.coverLetter.reviewed, true);
});

test("the résumé is never reviewed", async () => {
  const kinds = [];
  const { options } = run({ reviewArtifact: mockedReview([], kinds) });
  await generatePacket(options);
  assert.ok(kinds.every((kind) => kind !== "resume" && kind !== "résumé"));
  assert.equal(kinds.length, 2);
});

test("ai_review in modes turns each kind off", async () => {
  const kinds = [];
  const { options } = run({
    modes: { ai_review: { cover_letter: false } },
    reviewArtifact: mockedReview([], kinds),
  });
  await generatePacket(options);
  assert.deepEqual(kinds, ["application answers"]);
  const off = [];
  await generatePacket({
    ...run({ reviewArtifact: mockedReview([], off) }).options,
    modes: { ai_review: { cover_letter: false, answers: false } },
  });
  assert.deepEqual(off, []);
});

test("a failed review keeps the draft and records why", async () => {
  const { options } = run({
    reviewArtifact: (input) =>
      reviewArtifact({
        ...input,
        runAI: async () => ({ body: { ok: false, error: { message: "model offline" } } }),
      }),
  });
  const result = await generatePacket(options);
  assert.match(result.sources.coverLetter, /I worked with Excel\./);
  const codes = result.manifest.warnings.map((warning) => warning.code);
  assert.ok(codes.includes("REVIEW_UNAVAILABLE"));
  assert.match(
    result.manifest.warnings.find((warning) => warning.code === "REVIEW_UNAVAILABLE").message,
    /model offline/
  );
  assert.equal(result.review.coverLetter.reviewed, false);
});

test("a review that throws keeps the draft and records why", async () => {
  const { options } = run({
    reviewArtifact: async () => {
      throw new Error("boom");
    },
  });
  const result = await generatePacket(options);
  assert.match(result.sources.coverLetter, /I worked with Excel\./);
  assert.ok(result.manifest.warnings.some((warning) => warning.code === "REVIEW_FAILED"));
});
