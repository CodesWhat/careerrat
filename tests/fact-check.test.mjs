// CR103: a rewrite that adds a number, tool, employer or name absent from the
// source résumé and evidence is rejected, on every artifact kind.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { draftPacketAnswers } from "../src/core/packet/answers.mjs";
import { checkArtifactFacts, extractFacts } from "../src/core/packet/fact-check.mjs";
import { validatePacketEvidenceIds, validateResumeProposal } from "../src/core/packet/generate.mjs";

const SOURCE = [
  "Jordan Rivera",
  "Northwind Labs | Denver, CO | 2020 - 2024",
  "Operations Lead | 2022 - 2024",
  "Cut dispatch delays by 40% across 12 depots using Excel and SQL.",
  "Managed a $2.5M budget and a team of 8.",
].join("\n");

const CONTEXT = {
  sourceResume: { text: SOURCE },
  profile: { candidate: { full_name: "Jordan Rivera" } },
  evidence: {
    claims: [{ id: "ev-1", claim: "Trained 30 drivers on the Samsara fleet app." }],
  },
  app: { company: "Acme Freight", role: "Dispatch Manager" },
};

const cleanupDirs = [];
after(() => {
  for (const dir of cleanupDirs) rmSync(dir, { recursive: true, force: true });
});

test("extractFacts folds number formats and finds names, skipping sentence starts", () => {
  const { numbers, names } = extractFacts(
    "Cut costs 2,000,000 or $2M. Led Kubernetes and Node.js."
  );
  assert.deepEqual([...numbers.keys()], ["2000000"]);
  assert.deepEqual([...names.keys()].sort(), ["Kubernetes", "Node.js"]);
});

test("text drawn from source and evidence passes", () => {
  const result = checkArtifactFacts({
    texts: [
      "Cut dispatch delays by 40% across 12 depots with Excel and SQL.",
      "Trained 30 drivers on the Samsara fleet app.",
      "I want to join Acme Freight as Dispatch Manager. Sincerely, Jordan Rivera",
      "Managed a $2,500,000 budget at Northwind Labs.",
    ],
    context: CONTEXT,
  });
  assert.deepEqual(result.violations, []);
});

test("an added number is rejected", () => {
  const result = checkArtifactFacts({ texts: "Cut dispatch delays by 55%.", context: CONTEXT });
  assert.equal(result.ok, false);
  assert.equal(result.violations[0].kind, "number");
});

test("an added tool, employer and name are rejected", () => {
  const result = checkArtifactFacts({
    texts: "Built dashboards in Tableau at Globex after meeting Priya Shah.",
    context: CONTEXT,
  });
  const values = result.violations.map((v) => v.value);
  assert.deepEqual(values.sort(), ["Globex", "Priya", "Shah", "Tableau"]);
});

test("the job description does not vouch for a tool", () => {
  const result = checkArtifactFacts({
    texts: "Fluent in Kubernetes.",
    context: { ...CONTEXT, job: { body: "You know Kubernetes." } },
  });
  assert.equal(result.ok, false);
});

test("NEEDS YOU markers are an honest gap, not a claim", () => {
  const result = checkArtifactFacts({
    texts: "NEEDS YOU: confirm whether Kubernetes is fair to claim.",
    context: CONTEXT,
  });
  assert.equal(result.ok, true);
});

test("resume: a bullet adding a metric or tool is a validation violation", () => {
  const proposal = {
    summary: "Operations lead for Acme Freight.",
    experience: [
      {
        company: "Northwind Labs",
        dates: "2020 - 2024",
        roles: [
          {
            title: "Operations Lead",
            dates: "2022 - 2024",
            bullets: ["Cut dispatch delays by 70% using Tableau."],
          },
        ],
      },
    ],
    sections: [],
    skillGroups: [],
    education: [],
  };
  const result = validateResumeProposal({ context: CONTEXT, proposal });
  assert.equal(result.ok, false);
  assert.ok(result.violations.some((v) => /number "70"/.test(v)));
  assert.ok(result.violations.some((v) => /"Tableau"/.test(v)));
  proposal.experience[0].roles[0].bullets = ["Cut dispatch delays by 40% using Excel."];
  assert.equal(validateResumeProposal({ context: CONTEXT, proposal }).ok, true);
});

test("cover letter: a block adding a fact fails evidence validation", () => {
  const bad = validatePacketEvidenceIds({
    context: CONTEXT,
    proposals: [
      { kind: "coverLetter", text: "I grew revenue 300% at Globex.", evidenceIds: ["ev-1"] },
    ],
  });
  assert.equal(bad.ok, false);
  assert.match(bad.gaps[0].message, /unverified facts/);
  const good = validatePacketEvidenceIds({
    context: CONTEXT,
    proposals: [
      {
        kind: "coverLetter",
        text: "I trained 30 drivers at Northwind Labs.",
        evidenceIds: ["ev-1"],
      },
    ],
  });
  assert.equal(good.ok, true);
});

function answerCall(answer) {
  return async () => ({
    content: [
      {
        type: "text",
        text: JSON.stringify({
          answers: [{ questionId: "q1", answer, evidenceIds: ["ev-1"] }],
        }),
      },
    ],
    model: "claude-test",
  });
}

test("screening answers: an added fact becomes a NEEDS YOU gap", async () => {
  const questions = {
    answerable: [
      { id: "q1", label: "Describe your experience.", type: "textarea", required: true },
    ],
    excluded: [],
  };
  const bad = await draftPacketAnswers({
    context: CONTEXT,
    questions,
    call: answerCall("I led 90 engineers at Initech."),
  });
  assert.match(bad.answers[0].answer, /^NEEDS YOU: confirm these facts/);
  assert.equal(bad.answers[0].uploadReady, false);
  const good = await draftPacketAnswers({
    context: CONTEXT,
    questions,
    call: answerCall("I trained 30 drivers at Northwind Labs."),
  });
  assert.equal(good.answers[0].uploadReady, true);
});

test("outreach drafts: the fact-check CLI exits 1 on an added fact and 0 on a clean one", () => {
  const dir = mkdtempSync(join(tmpdir(), "careerrat-fact-check-"));
  cleanupDirs.push(dir);
  const source = join(dir, "source.md");
  const bad = join(dir, "bad.md");
  const good = join(dir, "good.md");
  writeFileSync(source, SOURCE);
  writeFileSync(bad, "Hi Dana, I ran 400 stores at Globex and would love to talk.");
  writeFileSync(good, "Hi Dana, I cut dispatch delays by 40% at Northwind Labs.");
  const run = (file) =>
    spawnSync(
      process.execPath,
      ["src/cli/fact-check.mjs", file, "--no-workspace", "--source", source, "--allow", "Dana"],
      { cwd: join(import.meta.dirname, ".."), encoding: "utf8" }
    );
  const badRun = run(bad);
  assert.equal(badRun.status, 1, badRun.stderr);
  assert.match(badRun.stdout, /Globex/);
  assert.equal(run(good).status, 0);
});
