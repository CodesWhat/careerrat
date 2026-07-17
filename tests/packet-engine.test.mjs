// tests/packet-engine.test.mjs
// RED contracts for Phase 10 Wave 0: packet generation core.
// The planned src/core/packet/* modules do not exist yet, so this suite should
// fail now and become the implementation contract for later Phase 10 waves.

import assert from "node:assert/strict";
import { test } from "node:test";
import { buildCoverLetterScaffold, buildShortAnswer } from "../src/core/documents/tailor.mjs";

const PROFILE = {
  candidate: {
    full_name: "Alex Rivera",
    email: "alex@example.com",
    phone: "+1-555-0199",
    location: "Remote, US",
    linkedin: "linkedin.com/in/alexrivera",
    github: "github.com/alexrivera",
  },
  compensation: {
    expected_base: 210000,
    current_base: "PRIVATE_CURRENT_BASE_SENTINEL",
  },
};

const EVIDENCE = {
  claims: [
    {
      id: "ev-ai-001",
      claim: "Built production AI workflows from prototype to deployed customer tools.",
      evidence: "Shipped three agentic workflow pilots into daily customer use.",
      role_signals: ["agentic workflow", "customer deployment"],
      allowed_wording: ["production AI workflows", "customer tools"],
      forbidden_wording: ["model training", "PhD"],
    },
    {
      id: "ev-iam-002",
      claim: "Led identity automation that cut manual access reviews by 40%.",
      evidence: "Owned the access-review automation rollout for an enterprise IAM program.",
      metrics: ["40% manual review reduction"],
      role_signals: ["identity automation"],
      allowed_wording: ["identity automation"],
      forbidden_wording: ["Kubernetes administrator"],
    },
  ],
};

const HONESTY = {
  education: { add_education_section: false },
  tools: {
    confirmed: ["OpenAI API", "Claude Code", "SQLite"],
    do_not_claim: ["Kubernetes", "model training", "Stanford PhD"],
  },
  claims: {
    do_not_fabricate: ["credentials", "employers", "metrics", "tools"],
  },
};

const PACKET_CONTEXT = {
  application: {
    id: "app-packet",
    company: "Acme AI",
    role: "Applied AI Engineer",
    status: "reviewed-hold",
    artifacts: {
      jd: "workspace/jobs/acme-ai-applied-ai-engineer.md",
      packetQuestionsSource: "workspace/jobs/acme-ai-applied-ai-engineer.questions.json",
    },
  },
  profile: PROFILE,
  evidence: EVIDENCE,
  honesty: HONESTY,
  writingVoice: "Direct, specific, evidence-first.",
  job: {
    frontmatter: { company: "Acme AI", role: "Applied AI Engineer" },
    body: "Build customer-facing agentic workflow prototypes and deploy them into production.",
    signals: ["agentic workflow", "customer deployment"],
  },
  sourceResume: {
    path: "workspace/profile/source-resume.md",
    text: "Confirmed resume text about production AI workflows.",
  },
  resumeFacts: {
    roles: ["Applied AI lead"],
    tools: ["OpenAI API", "SQLite"],
  },
  storiesLearnings: [
    {
      id: "story-confirmed-1",
      label: "Customer deployment",
      note: "Turned prototype into a customer-used workflow.",
      status: "confirmed",
    },
  ],
  publicCompanyIntel: {
    company: "Acme AI",
    product: "workflow automation for operations teams",
    reviewed: true,
  },
  companyResearch: {
    summary: "Acme AI sells operations workflow automation.",
    reviewed: true,
  },
  publicCompanyJobBoardContext: {
    provider: "greenhouse",
    jobCount: 4,
    reviewed: true,
  },
  deepIngest: {
    reviewed: [{ id: "story-1", summary: "Customer deployment story", status: "confirmed" }],
    rawProposals: [{ id: "raw-1", summary: "Unreviewed Kubernetes claim", status: "proposed" }],
  },
};

const CAPTURED_QUESTIONS = {
  source: "manual",
  questions: [
    {
      id: "q1",
      label: "Why do you want to build customer-facing AI workflows at Acme AI?",
      type: "textarea",
      required: true,
    },
    {
      id: "q2",
      label: "What recent tools would you use for this role?",
      type: "text",
      required: true,
    },
  ],
  excluded: [
    {
      id: "eeo-1",
      label: "Voluntary self-identification of disability",
      reason: "self-identification",
    },
  ],
};

const RESUME_DRAFT = async () => ({
  proposal: {
    summary: "Applied AI engineer focused on customer workflow delivery.",
    experience: [
      {
        company: "Confirmed Employer",
        roles: [
          {
            title: "Applied AI Lead",
            bullets: ["Built production AI workflows from prototype to deployed customer tools."],
          },
        ],
      },
    ],
  },
  ai: { used: true },
  gaps: [],
});

async function loadGenerateModule() {
  return import("../src/core/packet/generate.mjs");
}

async function loadSchemaModule() {
  return import("../src/core/packet/schemas/packet-schemas.mjs");
}

test("packetCoverLetterProposalSchema requires generated prose blocks with evidence ids before scaffold assembly", async () => {
  const { packetCoverLetterProposalSchema } = await loadSchemaModule();
  const { draftCoverLetterBlocks } = await loadGenerateModule();

  assert.equal(packetCoverLetterProposalSchema.type, "object");
  assert.deepEqual(packetCoverLetterProposalSchema.required, ["blocks"]);
  assert.equal(packetCoverLetterProposalSchema.additionalProperties, false);

  const proposal = await draftCoverLetterBlocks({
    context: PACKET_CONTEXT,
    call: async () => ({
      content: [
        {
          type: "text",
          text: JSON.stringify({
            blocks: [
              {
                text: "Acme AI needs customer-facing builders who can turn agent prototypes into reliable tools.",
                evidenceIds: ["ev-ai-001"],
              },
              {
                text: "My relevant proof is shipping production AI workflows from prototype to deployed customer tools.",
                evidenceIds: ["ev-ai-001"],
              },
            ],
          }),
        },
      ],
      model: "claude-test",
    }),
  });

  assert.deepEqual(
    proposal.blocks.map((block) => block.evidenceIds),
    [["ev-ai-001"], ["ev-ai-001"]]
  );
  assert.ok(proposal.blocks.every((block) => block.text.trim().length > 0));
});

test("draftCoverLetterBlocks throws PACKET_AI_UNAVAILABLE for an AI failure envelope", async () => {
  const { draftCoverLetterBlocks } = await loadGenerateModule();

  await assert.rejects(
    draftCoverLetterBlocks({
      context: PACKET_CONTEXT,
      runAI: async () => ({
        body: {
          ok: false,
          code: "NO_AI_ROUTE",
          error: { message: "offline" },
          ai: { used: false },
        },
      }),
    }),
    (err) => err.code === "PACKET_AI_UNAVAILABLE" && err.details === "NO_AI_ROUTE"
  );
});

test("draftCoverLetterBlocks throws PACKET_COVER_INVALID for empty or hard-invalid blocks", async () => {
  const { draftCoverLetterBlocks } = await loadGenerateModule();

  await assert.rejects(
    draftCoverLetterBlocks({
      context: PACKET_CONTEXT,
      runAI: async () => ({ body: { ok: true, ai: { used: true }, data: { blocks: [] } } }),
    }),
    (err) => err.code === "PACKET_COVER_INVALID" && /no usable blocks/i.test(err.message)
  );
  await assert.rejects(
    draftCoverLetterBlocks({
      context: PACKET_CONTEXT,
      runAI: async () => ({
        body: {
          ok: true,
          ai: { used: true },
          data: { blocks: [{ text: "Unsupported claim.", evidenceIds: ["missing-id"] }] },
        },
      }),
    }),
    (err) => err.code === "PACKET_COVER_INVALID" && /missing-id/i.test(err.message)
  );
});

test("draftCoverLetterBlocks keeps grounded blocks beside honest NEEDS YOU blocks", async () => {
  const { draftCoverLetterBlocks } = await loadGenerateModule();
  const result = await draftCoverLetterBlocks({
    context: PACKET_CONTEXT,
    runAI: async () => ({
      body: {
        ok: true,
        ai: { used: true },
        data: {
          blocks: [
            { text: "Grounded production AI workflow proof.", evidenceIds: ["ev-ai-001"] },
            { text: "NEEDS YOU: confirm a company-specific detail.", evidenceIds: [] },
          ],
        },
      },
    }),
  });

  assert.equal(result.blocks.length, 2);
  assert.equal(result.uploadReady, false);
  assert.equal(result.manual.required, true);
  assert.match(result.gaps[0].message, /user confirmation is required/i);
});

test("generatePacket never passes empty cover-letter prose blocks into the scaffold helper", async () => {
  const { generatePacket } = await loadGenerateModule();
  let scaffoldSawBlocks = false;

  const result = await generatePacket({
    context: PACKET_CONTEXT,
    questionCapture: CAPTURED_QUESTIONS,
    services: {
      buildCoverLetterScaffold: (input) => {
        scaffoldSawBlocks = true;
        assert.ok(Array.isArray(input.blocks));
        assert.ok(input.blocks.length > 0, "cover-letter prose must be generated first");
        return buildCoverLetterScaffold(input);
      },
      buildShortAnswer,
    },
    draftResumeProposal: RESUME_DRAFT,
    draftCoverLetterBlocks: async () => ({
      blocks: [
        {
          text: "Acme AI's customer workflow focus matches my production AI workflow experience.",
          evidenceIds: ["ev-ai-001"],
        },
      ],
    }),
    draftPacketAnswers: async () => ({
      answers: [
        {
          questionId: "q1",
          answer:
            "I want to build customer-facing AI workflows at Acme AI because the role maps to my confirmed production AI workflow work.",
          evidenceIds: ["ev-ai-001"],
        },
      ],
      gaps: [],
    }),
    exportPacketArtifacts: async () => ({ formats: ["pdf"], outputs: {} }),
  });

  assert.equal(scaffoldSawBlocks, true);
  assert.equal(result.manifest.applicationId, "app-packet");
  assert.match(result.sources.resume, /production AI workflows/);
  assert.match(result.sources.coverLetter, /Acme AI/);
  assert.match(result.sources.answers, /customer-facing AI workflows/);
});

test("generatePacket carries captured questions into packetManifest.questions by application id", async () => {
  const { generatePacket } = await loadGenerateModule();

  const result = await generatePacket({
    appId: "app-packet",
    context: PACKET_CONTEXT,
    questionCapture: CAPTURED_QUESTIONS,
    draftResumeProposal: RESUME_DRAFT,
    draftCoverLetterBlocks: async () => ({
      blocks: [{ text: "Evidence-backed cover letter block.", evidenceIds: ["ev-ai-001"] }],
    }),
    draftPacketAnswers: async () => ({
      answers: [
        {
          questionId: "q1",
          answer: "Evidence-backed answer.",
          evidenceIds: ["ev-ai-001"],
        },
      ],
      gaps: [],
    }),
    exportPacketArtifacts: async () => ({ formats: ["pdf"], outputs: {} }),
  });

  assert.deepEqual(
    result.manifest.questions.map((q) => q.id),
    ["q1", "q2"]
  );
  assert.equal(result.manifest.excludedQuestions.length, 1);
  assert.equal(
    result.manifest.questionCaptureSource,
    "workspace/jobs/acme-ai-applied-ai-engineer.questions.json"
  );
});

test("packet source enumeration covers every D-08 source class without private current comp", async () => {
  const { enumeratePacketSources } = await loadGenerateModule();

  const sources = enumeratePacketSources(PACKET_CONTEXT);
  assert.deepEqual(Object.keys(sources).sort(), [
    "candidateProfile",
    "capturedJobBody",
    "capturedQuestions",
    "companyIntelligence",
    "companyResearch",
    "confirmedEvidence",
    "deepIngest",
    "honestyBoundaries",
    "publicCompanyJobBoardContext",
    "resumeFacts",
    "sourceResume",
    "storiesLearnings",
    "writingVoice",
  ]);
  assert.equal(sources.candidateProfile.candidate.full_name, "Alex Rivera");
  assert.equal(sources.capturedJobBody.path, "workspace/jobs/acme-ai-applied-ai-engineer.md");
  assert.equal(
    sources.capturedQuestions.path,
    "workspace/jobs/acme-ai-applied-ai-engineer.questions.json"
  );
  assert.deepEqual(
    sources.confirmedEvidence.claims.map((claim) => claim.id),
    ["ev-ai-001", "ev-iam-002"]
  );
  assert.doesNotMatch(JSON.stringify(sources), /PRIVATE_CURRENT_BASE_SENTINEL/);
});

test("source splitting keeps raw/proposed material out of claimable packet evidence", async () => {
  const { enumeratePacketSources, splitConfirmedAndProposedPacketSources } =
    await loadGenerateModule();

  const split = splitConfirmedAndProposedPacketSources(enumeratePacketSources(PACKET_CONTEXT));
  assert.ok(
    split.claimableEvidence.some((item) => item.id === "ev-ai-001"),
    "confirmed evidence should be claimable"
  );
  assert.ok(
    split.claimableContext.some((item) => item.source === "companyResearch"),
    "reviewed company research should be usable context"
  );
  assert.ok(
    split.gapContext.some((item) => item.id === "raw-1" && item.source === "deepIngest"),
    "raw deep-ingest proposals should stay review/gap context"
  );
  assert.equal(
    split.claimableEvidence.some((item) => /Kubernetes/i.test(JSON.stringify(item))),
    false,
    "raw/proposed Kubernetes material must not become claimable evidence"
  );
});

test("unsupported claims become NEEDS YOU gaps and block upload-ready state", async () => {
  const { generatePacket, validatePacketEvidenceIds } = await loadGenerateModule();

  const unsupported = validatePacketEvidenceIds({
    context: PACKET_CONTEXT,
    proposals: [
      {
        kind: "answer",
        text: "I would use Kubernetes and cite a Stanford PhD to lead this work.",
        evidenceIds: ["missing-evidence"],
      },
    ],
  });

  assert.equal(unsupported.ok, false);
  assert.match(unsupported.gaps[0].message, /missing-evidence|Kubernetes|Stanford PhD/);

  const result = await generatePacket({
    context: PACKET_CONTEXT,
    questionCapture: CAPTURED_QUESTIONS,
    draftResumeProposal: RESUME_DRAFT,
    draftCoverLetterBlocks: async () => ({
      blocks: [{ text: "NEEDS YOU: confirm a company-specific proof point.", evidenceIds: [] }],
    }),
    draftPacketAnswers: async () => ({
      answers: [
        {
          questionId: "q2",
          answer: "NEEDS YOU: confirm whether Kubernetes is fair to claim.",
          evidenceIds: [],
        },
      ],
      gaps: [{ questionId: "q2", reason: "unsupported-tool-claim" }],
    }),
    exportPacketArtifacts: async () => ({ formats: ["pdf"], outputs: {} }),
  });

  assert.equal(result.uploadReady, false);
  assert.match(result.sources.answers, /NEEDS YOU/);
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE_CURRENT_BASE_SENTINEL/);
  assert.doesNotMatch(
    result.sources.resume + result.sources.coverLetter + result.sources.answers,
    /Kubernetes administrator/
  );
});

test("private compensation and unconfirmed claims are rejected before upload-ready manifests", async () => {
  const { validatePacketEvidenceIds } = await loadGenerateModule();

  const result = validatePacketEvidenceIds({
    context: PACKET_CONTEXT,
    proposals: [
      {
        kind: "coverLetter",
        text: "I can use PRIVATE_CURRENT_BASE_SENTINEL and the unreviewed Kubernetes claim to justify fit.",
        evidenceIds: ["ev-ai-001"],
      },
    ],
  });

  assert.equal(result.ok, false);
  assert.match(
    result.gaps.map((gap) => gap.message).join("\n"),
    /private|current|unreviewed|Kubernetes/i
  );
});
