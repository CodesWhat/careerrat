// Deterministic AI-tell check: a known AI-sounding fixture is flagged and a
// plain human fixture passes untouched. Also covers the résumé style retry and
// the reviewer's style goals.

import assert from "node:assert/strict";
import { test } from "node:test";
import { aiTellMessages, findAiTells } from "../src/core/packet/ai-tells.mjs";
import { draftResumeProposal } from "../src/core/packet/generate.mjs";
import { applyReviewEdits, reviewArtifact } from "../src/core/packet/reviewer.mjs";

const AI_TEXT =
  "I am thrilled to apply for this role. I spearheaded a seamless rollout — leveraging robust tooling. " +
  "It's not just a job, it's a calling. I bring innovation, collaboration, and creativity. " +
  "It is important to note that I have a proven track record.";
const HUMAN_TEXT =
  "I ran dispatch for twelve depots at Northwind. Delays fell by 40% after we moved scheduling into Excel. " +
  "I'd like to talk about the Dispatch Manager role. Skills: Python, Go, and Rust.";

test("AI-sounding text is flagged with a plainer alternative for each tell", () => {
  const findings = findAiTells(AI_TEXT);
  const ids = new Set(findings.map((finding) => finding.id));
  for (const id of [
    "em-dash",
    "stock-word",
    "not-x-but-y",
    "forced-triad",
    "boilerplate",
    "filler",
  ]) {
    assert.ok(ids.has(id), `missing ${id}`);
  }
  const phrases = findings.map((finding) => finding.phrase.toLowerCase());
  for (const expected of ["spearheaded", "seamless", "leveraging", "robust"]) {
    assert.ok(phrases.includes(expected), `missing ${expected}`);
  }
  assert.ok(findings.every((finding) => finding.suggestion));
  assert.ok(aiTellMessages(findings).every((line) => line.includes("reads as AI-written")));
});

test("plain human text passes with no findings, including a tool list", () => {
  assert.deepEqual(findAiTells(HUMAN_TEXT), []);
  assert.deepEqual(findAiTells(""), []);
});

test("the reviewer is shown style goals and cannot add a tell or a fact", async () => {
  const context = {
    sourceResume: { text: "Northwind Labs. Cut delays by 40% across 12 depots." },
    profile: { candidate: { full_name: "Jordan Rivera" } },
    evidence: { claims: [] },
  };
  const draft = "I spearheaded a rollout that cut delays by 40%.";
  let seen;
  const result = await reviewArtifact({
    context,
    text: draft,
    runAI: async (options) => {
      seen = options;
      return {
        body: {
          ok: true,
          ai: { used: true },
          data: {
            edits: [
              { find: "spearheaded", replace: "ran", reason: "plainer" },
              { find: "a rollout", replace: "a seamless rollout", reason: "bad" },
              { find: "40%", replace: "45%", reason: "bad" },
            ],
          },
        },
      };
    },
  });
  assert.match(seen.messages[0].content, /styleGoals/);
  assert.match(seen.messages[0].content, /spearheaded/);
  assert.equal(result.text, "I ran a rollout that cut delays by 40%.");
  assert.equal(result.accepted.length, 1);
  assert.equal(
    applyReviewEdits({
      text: draft,
      context,
      edits: [{ find: "a rollout", replace: "a seamless rollout", reason: "x" }],
    }).rejected[0].reasons[0],
    "edit adds AI-sounding phrasing"
  );
});

const RESUME_CONTEXT = {
  sourceResume: { text: "Northwind Labs\nDispatch Manager 2019 2023\nCut delays by 40%." },
  profile: { candidate: { full_name: "Jordan Rivera" } },
  evidence: { claims: [] },
};
const resumeData = (bullet) => ({
  summary: "Dispatch manager.",
  experience: [
    {
      company: "Northwind Labs",
      location: "",
      dates: "2019 2023",
      roles: [{ title: "Dispatch Manager", dates: "2019 2023", bullets: [bullet] }],
    },
  ],
  sections: [],
  skillGroups: [],
  education: [],
});

test("an AI-sounding résumé bullet gets one correction retry that is shown the tells", async () => {
  const calls = [];
  const runAI = async ({ messages }) => {
    calls.push(messages);
    const bullet =
      calls.length === 1 ? "Spearheaded a seamless cut in delays by 40%." : "Cut delays by 40%.";
    return { body: { ok: true, ai: { used: true }, data: resumeData(bullet) } };
  };
  const result = await draftResumeProposal({ context: RESUME_CONTEXT, runAI });
  assert.equal(calls.length, 2);
  assert.match(calls[1].at(-1).content, /read as AI-written/);
  assert.match(calls[1].at(-1).content, /Spearheaded/);
  assert.equal(result.proposal.experience[0].roles[0].bullets[0], "Cut delays by 40%.");
  assert.deepEqual(result.gaps, []);
});

test("a clean résumé is not retried, and a failed style retry keeps the grounded draft", async () => {
  let clean = 0;
  await draftResumeProposal({
    context: RESUME_CONTEXT,
    runAI: async () => {
      clean += 1;
      return { body: { ok: true, ai: { used: true }, data: resumeData("Cut delays by 40%.") } };
    },
  });
  assert.equal(clean, 1);

  let calls = 0;
  const result = await draftResumeProposal({
    context: RESUME_CONTEXT,
    runAI: async () => {
      calls += 1;
      if (calls === 1) {
        return {
          body: {
            ok: true,
            ai: { used: true },
            data: resumeData("Spearheaded a 40% cut in delays."),
          },
        };
      }
      return { body: { ok: false } };
    },
  });
  assert.equal(calls, 2);
  assert.match(result.proposal.experience[0].roles[0].bullets[0], /Spearheaded/);
  assert.equal(result.gaps[0].code, "AI_SOUNDING_PHRASING");
});
