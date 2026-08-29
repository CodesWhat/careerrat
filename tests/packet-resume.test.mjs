import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, test } from "node:test";
import { closeAll, openDb } from "../src/core/db/connection.mjs";
import { importFromTracker } from "../src/core/db/import-from-tracker.mjs";
import {
  candidateArtifactPut,
  candidateConfigPatch,
  candidateEvidenceMerge,
} from "../src/core/db/verbs/candidate.mjs";
import { buildStructuredResumeMarkdown } from "../src/core/documents/tailor.mjs";
import {
  draftResumeProposal,
  generatePacket,
  validateResumeProposal,
} from "../src/core/packet/generate.mjs";

const cleanupRoots = [];

const PROFILE = {
  candidate: {
    full_name: "Alex Rivera",
    email: "alex@example.com",
    phone: "+1-555-0199",
    location: "New York, NY",
    linkedin: "linkedin.com/in/alexrivera",
  },
};

const EVIDENCE = {
  claims: [
    {
      id: "ev-ai",
      claim: "Built grounded AI workflows for customer operations.",
      evidence: "Source resume: Northwind Labs.",
      forbidden_wording: ["trained foundation models"],
    },
  ],
};

const BASE_PROPOSAL = {
  summary: "Applied AI engineer focused on grounded customer workflows.",
  experience: [
    {
      company: "Northwind Labs",
      location: "New York, NY",
      dates: "2020 - 2024",
      roles: [
        {
          title: "Applied AI Engineer",
          dates: "2022 - 2024",
          bullets: ["Built grounded AI workflows for customer operations."],
        },
        {
          title: "Solutions Engineer",
          dates: "2020 - 2022",
          bullets: ["Turned customer needs into deployed automations."],
        },
      ],
    },
  ],
  sections: [
    { heading: "Projects", bullets: ["Created an evidence-first packet engine."] },
    { heading: "sUmMaRy", bullets: ["This fixed heading must not be duplicated."] },
  ],
  skillGroups: [
    { label: "AI", items: ["OpenAI API", "RAG"] },
    { label: "Data", items: ["SQLite", "PostgreSQL"] },
  ],
  education: ["B.S. Computer Science, Example University"],
};

const SOURCE_TEXT = [
  "Northwind Labs | New York, NY | 2020 - 2024",
  "Applied AI Engineer | 2022 - 2024",
  "Solutions Engineer | 2020 - 2022",
  "OpenAI API, RAG, and SQLite",
].join("\n");

function aiSuccess(data, ai = { used: true }) {
  return async () => ({ body: { ok: true, ai, data } });
}

function tempRepo() {
  const repoRoot = mkdtempSync(join(tmpdir(), "careerrat-packet-resume-"));
  cleanupRoots.push(repoRoot);
  mkdirSync(join(repoRoot, "workspace/jobs"), { recursive: true });
  mkdirSync(join(repoRoot, "workspace/tailored"), { recursive: true });
  return repoRoot;
}

function writeWorkspaceFile(repoRoot, relPath, content) {
  const full = join(repoRoot, "workspace", relPath);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, content, "utf8");
  return `workspace/${relPath}`;
}

function seedPacketRepo() {
  const repoRoot = tempRepo();
  const jdPath = writeWorkspaceFile(
    repoRoot,
    "jobs/acme-applied-ai.md",
    "# Job Description\n\nBuild grounded customer-facing AI workflow products.\n"
  );
  const sourceDir = join(repoRoot, "fixture-source");
  mkdirSync(sourceDir, { recursive: true });
  writeFileSync(
    join(sourceDir, "tracker.json"),
    JSON.stringify({
      meta: {},
      applications: [
        {
          id: "app-resume",
          company: "Acme AI",
          role: "Applied AI Engineer",
          status: "reviewed-hold",
          artifacts: { jd: jdPath },
        },
      ],
      sourced: [],
      sources: [],
      communications: [],
    })
  );
  importFromTracker({ repoRoot, sourceDir });
  candidateConfigPatch({ repoRoot, name: "profile", patch: PROFILE });
  candidateEvidenceMerge({ repoRoot, claims: EVIDENCE.claims });
  candidateArtifactPut({
    repoRoot,
    id: "source-resume",
    kind: "source-resume",
    data: { text: SOURCE_TEXT, source: "test" },
  });
  return repoRoot;
}

const QUESTION_CAPTURE = {
  source: "manual",
  path: "workspace/jobs/acme-applied-ai.questions.json",
  capturedAt: "2026-07-17T12:00:00Z",
  questions: [{ id: "q1", label: "Why Acme?", type: "text", required: true }],
  excluded: [],
};

const COVER_DRAFT = async () => ({
  blocks: [{ text: "Acme AI matches my grounded AI workflow experience.", evidenceIds: ["ev-ai"] }],
  uploadReady: true,
  gaps: [],
});

const ANSWER_DRAFT = async () => ({
  answers: [
    {
      questionId: "q1",
      answer: "Acme AI's work matches my grounded AI workflow experience.",
      evidenceIds: ["ev-ai"],
    },
  ],
  uploadReady: true,
  gaps: [],
});

// These tests exercise resume drafting/assembly, not PDF export. Stub
// exportPacketArtifacts the same way tests/packet-engine.test.mjs does so the
// suite doesn't need a real Chromium to assert on generated markdown.
async function generateWithResume(repoRoot, resumeDraft, services = {}) {
  return generatePacket({
    repoRoot,
    env: {},
    appId: "app-resume",
    applyIntent: true,
    formats: [],
    questionCapture: QUESTION_CAPTURE,
    services,
    draftResumeProposal: resumeDraft,
    draftCoverLetterBlocks: COVER_DRAFT,
    draftPacketAnswers: ANSWER_DRAFT,
    exportPacketArtifacts: async () => ({ formats: [], outputs: {} }),
  });
}

after(() => {
  closeAll();
  for (const root of cleanupRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

test("buildStructuredResumeMarkdown renders grouped experience, extra sections, skills, and education", () => {
  const markdown = buildStructuredResumeMarkdown({
    profile: PROFILE,
    proposal: BASE_PROPOSAL,
    evidence: EVIDENCE,
    honesty: { education: { add_education_section: true }, tools: {} },
  });

  assert.match(markdown, /^# Alex Rivera\nalex@example\.com \| \+1-555-0199 \| New York, NY/m);
  assert.match(markdown, /## Summary\n\nApplied AI engineer focused/);
  assert.match(markdown, /\*\*Northwind Labs\*\* - New York, NY \| 2020 - 2024/);
  assert.match(markdown, /### Applied AI Engineer \| 2022 - 2024\n- Built grounded AI workflows/);
  assert.match(markdown, /### Solutions Engineer \| 2020 - 2022\n- Turned customer needs/);
  assert.match(markdown, /## Projects\n\n- Created an evidence-first packet engine\./);
  assert.doesNotMatch(markdown, /This fixed heading must not be duplicated/);
  assert.match(
    markdown,
    /## Skills\n\n\*\*AI:\*\* OpenAI API, RAG\n\n\*\*Data:\*\* SQLite, PostgreSQL/
  );
  assert.match(markdown, /## Education\n\n- B\.S\. Computer Science, Example University/);
});

test("buildStructuredResumeMarkdown omits proposal education when honesty disables it", () => {
  const markdown = buildStructuredResumeMarkdown({
    profile: PROFILE,
    proposal: BASE_PROPOSAL,
    evidence: EVIDENCE,
    honesty: { education: { add_education_section: false }, tools: {} },
  });
  assert.doesNotMatch(markdown, /## Education/);
  assert.doesNotMatch(markdown, /Example University/);
});

test("buildStructuredResumeMarkdown omits proposal education by default when honesty.education is absent or undefined", () => {
  // add_education_section is opt-in everywhere else in the app (candidate-
  // defaults.mjs, templates/honesty.example.yml, packet/generate.mjs's own
  // fallback all default it to false). An absent honesty.education, or a
  // present-but-undefined add_education_section, must NOT silently add an
  // Education section nobody opted into.
  const noEducationHonesty = { education: {}, tools: {} };
  const missingEducationHonesty = { tools: {} };

  for (const honesty of [noEducationHonesty, missingEducationHonesty, undefined]) {
    const markdown = buildStructuredResumeMarkdown({
      profile: PROFILE,
      proposal: BASE_PROPOSAL,
      evidence: EVIDENCE,
      honesty,
    });
    assert.doesNotMatch(markdown, /## Education/);
    assert.doesNotMatch(markdown, /Example University/);
  }
});

test("buildStructuredResumeMarkdown preserves forbidden-wording, placeholder, and ATS gates", () => {
  const build = (proposal, evidence = EVIDENCE) =>
    buildStructuredResumeMarkdown({
      profile: PROFILE,
      proposal,
      evidence,
      honesty: { education: { add_education_section: false }, tools: {} },
    });

  assert.throws(
    () =>
      build({
        ...BASE_PROPOSAL,
        experience: [
          {
            ...BASE_PROPOSAL.experience[0],
            roles: [
              { ...BASE_PROPOSAL.experience[0].roles[0], bullets: ["Trained foundation models."] },
            ],
          },
        ],
      }),
    /forbidden wording/i
  );
  assert.throws(
    () => build({ ...BASE_PROPOSAL, summary: "Targeting [Company]." }),
    /unresolved placeholders/i
  );
  assert.throws(
    () => build({ ...BASE_PROPOSAL, summary: "See ![diagram](https://example.com/x.png)." }),
    /ATS-unsafe output/i
  );
});

test("validateResumeProposal accepts grounded company, titles, and years", () => {
  assert.deepEqual(
    validateResumeProposal({
      context: { sourceResume: { text: SOURCE_TEXT } },
      proposal: BASE_PROPOSAL,
    }),
    { ok: true, violations: [] }
  );
});

test("validateResumeProposal reports each hard grounding violation", () => {
  const context = { sourceResume: { text: SOURCE_TEXT } };
  const missingCompany = validateResumeProposal({
    context,
    proposal: {
      ...BASE_PROPOSAL,
      experience: [{ ...BASE_PROPOSAL.experience[0], company: "Contoso" }],
    },
  });
  assert.equal(missingCompany.ok, false);
  assert.match(missingCompany.violations.join("\n"), /company "Contoso" not found/i);

  const missingTitle = validateResumeProposal({
    context,
    proposal: {
      ...BASE_PROPOSAL,
      experience: [
        {
          ...BASE_PROPOSAL.experience[0],
          roles: [{ ...BASE_PROPOSAL.experience[0].roles[0], title: "Research Scientist" }],
        },
      ],
    },
  });
  assert.equal(missingTitle.ok, false);
  assert.match(missingTitle.violations.join("\n"), /role title "Research Scientist" not found/i);

  const missingYear = validateResumeProposal({
    context,
    proposal: {
      ...BASE_PROPOSAL,
      experience: [{ ...BASE_PROPOSAL.experience[0], dates: "2018 - 2024" }],
    },
  });
  assert.equal(missingYear.ok, false);
  assert.match(missingYear.violations.join("\n"), /year 2018 not found/i);

  const privateLeak = validateResumeProposal({
    context,
    proposal: { ...BASE_PROPOSAL, summary: "My current salary is private." },
  });
  assert.equal(privateLeak.ok, false);
  assert.match(privateLeak.violations.join("\n"), /private current compensation/i);
});

test("draftResumeProposal throws NO_SOURCE_RESUME without calling AI", async () => {
  let calls = 0;
  await assert.rejects(
    draftResumeProposal({
      context: { sourceResume: { text: "   " } },
      runAI: async () => {
        calls += 1;
        throw new Error("must not run");
      },
    }),
    (err) => err.code === "NO_SOURCE_RESUME" && /no source résumé on file/i.test(err.message)
  );
  assert.equal(calls, 0);
});

test("draftResumeProposal throws PACKET_AI_UNAVAILABLE and preserves the envelope code", async () => {
  await assert.rejects(
    draftResumeProposal({
      context: { sourceResume: { text: SOURCE_TEXT } },
      runAI: async () => ({
        body: {
          ok: false,
          code: "NO_AI_ROUTE",
          ai: { used: false },
          error: { message: "offline" },
        },
      }),
    }),
    (err) =>
      err.code === "PACKET_AI_UNAVAILABLE" &&
      err.details === "NO_AI_ROUTE" &&
      /document generation needs AI.*offline/i.test(err.message)
  );
});

test("draftResumeProposal corrects an ungrounded first draft with exactly one retry", async () => {
  const calls = [];
  const ungrounded = {
    ...BASE_PROPOSAL,
    experience: [{ ...BASE_PROPOSAL.experience[0], company: "Fabricated Corp" }],
  };
  const result = await draftResumeProposal({
    context: { sourceResume: { text: SOURCE_TEXT } },
    runAI: async (options) => {
      calls.push(options);
      return {
        body: {
          ok: true,
          ai: { used: true },
          data: calls.length === 1 ? ungrounded : BASE_PROPOSAL,
        },
      };
    },
  });
  assert.equal(calls.length, 2);
  assert.equal(result.proposal.experience[0].company, "Northwind Labs");
  assert.equal(calls[0].messages.length, 1);
  assert.equal(calls[1].messages.length, 2);
  assert.match(calls[1].messages[1].content, /failed grounding validation/i);
  assert.match(calls[1].messages[1].content, /company "Fabricated Corp" not found/i);
});

test("draftResumeProposal throws PACKET_RESUME_INVALID after one failed correction retry", async () => {
  let calls = 0;
  const ungrounded = {
    ...BASE_PROPOSAL,
    experience: [{ ...BASE_PROPOSAL.experience[0], company: "Fabricated Corp" }],
  };
  await assert.rejects(
    draftResumeProposal({
      context: { sourceResume: { text: SOURCE_TEXT } },
      runAI: async () => {
        calls += 1;
        return { body: { ok: true, ai: { used: true }, data: ungrounded } };
      },
    }),
    (err) => err.code === "PACKET_RESUME_INVALID" && /Fabricated Corp/i.test(err.message)
  );
  assert.equal(calls, 2);
});

test("draftResumeProposal drops only unmatched skills and keeps the proposal", async () => {
  const result = await draftResumeProposal({
    context: {
      sourceResume: { text: SOURCE_TEXT },
      profile: PROFILE,
      evidence: EVIDENCE,
    },
    runAI: aiSuccess({
      ...BASE_PROPOSAL,
      skillGroups: [
        { label: "AI", items: [" OpenAI API ", "ImaginaryDB"] },
        { label: "Unsupported", items: ["Unknown Framework"] },
      ],
    }),
  });
  assert.ok(result.proposal);
  assert.deepEqual(result.proposal.skillGroups, [{ label: "AI", items: ["OpenAI API"] }]);
  assert.match(result.gaps[0].message, /skills omitted.*ImaginaryDB.*Unknown Framework/i);
});

test("draftResumeProposal trims runaway experience arrays to eight entries", async () => {
  const experience = Array.from({ length: 10 }, () => ({
    company: "  Northwind Labs  ",
    location: "  New York, NY  ",
    dates: "  2020 - 2024  ",
    roles: [
      {
        title: "  Applied AI Engineer  ",
        dates: "  2022 - 2024  ",
        bullets: ["  Grounded workflow delivery.  ", "   "],
      },
    ],
  }));
  const result = await draftResumeProposal({
    context: { sourceResume: { text: SOURCE_TEXT } },
    runAI: aiSuccess({ experience }),
  });
  assert.equal(result.proposal.experience.length, 8);
  assert.equal(result.proposal.experience[0].company, "Northwind Labs");
  assert.deepEqual(result.proposal.experience[0].roles[0].bullets, ["Grounded workflow delivery."]);
});

test("generatePacket writes the structured resume returned by the tailored proposal lane", async () => {
  const repoRoot = seedPacketRepo();
  const result = await generateWithResume(repoRoot, async () => ({
    proposal: BASE_PROPOSAL,
    ai: { used: true },
    gaps: [],
  }));

  assert.match(result.sources.resume, /\*\*Northwind Labs\*\* - New York, NY \| 2020 - 2024/);
  assert.match(result.sources.resume, /### Applied AI Engineer \| 2022 - 2024/);
  assert.equal(Object.hasOwn(result.sources, "resumeGaps"), false);
  assert.equal(Object.hasOwn(result.artifacts, "resumeGaps"), false);
  const resumePath = join(repoRoot, result.artifacts.resumeSource);
  assert.ok(existsSync(resumePath));
  assert.match(readFileSync(resumePath, "utf8"), /### Solutions Engineer/);
});

test("generatePacket writes nothing when the resume draft fails closed", async () => {
  const repoRoot = seedPacketRepo();
  const expected = new Error("resume drafting failed");
  expected.code = "PACKET_RESUME_INVALID";
  await assert.rejects(
    generateWithResume(repoRoot, async () => {
      throw expected;
    }),
    (err) => err === expected
  );

  assert.deepEqual(readdirSync(join(repoRoot, "workspace/tailored")), []);
  const db = openDb({ repoRoot, env: {} });
  const row = db.prepare("SELECT data FROM applications WHERE id = ?").get("app-resume");
  const app = JSON.parse(row.data);
  assert.deepEqual(app.artifacts, { jd: "workspace/jobs/acme-applied-ai.md" });
});

test("generatePacket wraps structured assembly failures as PACKET_RESUME_ERROR and writes nothing", async () => {
  const repoRoot = seedPacketRepo();
  await assert.rejects(
    generateWithResume(
      repoRoot,
      async () => ({ proposal: BASE_PROPOSAL, ai: { used: true }, gaps: [] }),
      {
        buildStructuredResumeMarkdown: () => {
          throw new Error("synthetic assembly failure");
        },
      }
    ),
    (err) => err.code === "PACKET_RESUME_ERROR" && /synthetic assembly failure/i.test(err.message)
  );
  assert.deepEqual(readdirSync(join(repoRoot, "workspace/tailored")), []);
});
