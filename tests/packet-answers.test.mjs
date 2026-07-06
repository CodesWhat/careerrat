// tests/packet-answers.test.mjs
// RED contracts for Phase 10 Wave 0: application-question capture and
// non-EEO answer drafting. Planned packet modules are dynamic imports so the
// current failure is the missing src/core/packet owner, not fixture setup.

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, test } from "node:test";
import {
  normalizeAshbyForm,
  normalizeGreenhouseQuestions,
  parseManualQuestions,
} from "../src/core/apply/form-questions.mjs";
import { closeAll } from "../src/core/db/connection.mjs";
import { importFromTracker } from "../src/core/db/import-from-tracker.mjs";

const cleanupRoots = [];

function tempRepo() {
  const repoRoot = mkdtempSync(join(tmpdir(), "rolester-packet-answers-"));
  cleanupRoots.push(repoRoot);
  mkdirSync(join(repoRoot, "workspace/jobs"), { recursive: true });
  return repoRoot;
}

function writeWorkspaceFile(repoRoot, relPath, content) {
  const full = join(repoRoot, "workspace", relPath);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, content, "utf8");
  return `workspace/${relPath}`;
}

function seedApp(repoRoot) {
  const sourceDir = join(repoRoot, "fixture-source");
  mkdirSync(sourceDir, { recursive: true });
  writeFileSync(
    join(sourceDir, "tracker.json"),
    JSON.stringify(
      {
        meta: {},
        applications: [
          {
            id: "app-packet",
            company: "Acme AI",
            role: "Applied AI Engineer",
            status: "reviewed-hold",
            artifacts: {
              jd: writeWorkspaceFile(
                repoRoot,
                "jobs/acme-ai-applied-ai-engineer.md",
                "# Applied AI Engineer\n\nBuild customer-facing agentic workflows."
              ),
            },
          },
        ],
        sourced: [],
        sources: [],
        communications: [],
      },
      null,
      2
    )
  );
  importFromTracker({ repoRoot, sourceDir });
}

async function loadQuestionsModule() {
  return import("../src/core/packet/questions.mjs");
}

async function loadAnswersModule() {
  return import("../src/core/packet/answers.mjs");
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

const GREENHOUSE_WITH_EEO = normalizeGreenhouseQuestions(
  {
    absolute_url: "https://job-boards.greenhouse.io/acmeai/jobs/123",
    questions: [
      {
        label: "Why Acme AI?",
        required: true,
        fields: [{ name: "why_acme", type: "textarea", values: [] }],
      },
      {
        label: "Which recent AI tools have you used?",
        required: true,
        fields: [{ name: "recent_tools", type: "input_text", values: [] }],
      },
    ],
    compliance: [
      {
        type: "eeoc",
        questions: [
          {
            label: "Gender",
            required: false,
            fields: [{ name: "gender", type: "multi_value_single_select", values: [] }],
          },
        ],
      },
    ],
    demographic_questions: { header: "Voluntary self-identification" },
  },
  { fetchedAt: "2026-07-06T13:00:00Z" }
);

const ASHBY_WITH_SURVEY = normalizeAshbyForm(
  {
    applicationForm: {
      fieldEntries: [
        {
          isRequired: true,
          field: {
            path: "cf-why",
            title: "Why are you interested in this customer engineering role?",
            type: "LongText",
          },
        },
      ],
    },
    surveyForms: [
      {
        fieldEntries: [
          {
            field: {
              path: "survey-veteran",
              title: "Veteran status",
              type: "ValueSelect",
            },
          },
        ],
      },
    ],
    surveyFormDefinitionIds: ["survey-1"],
  },
  { url: "https://jobs.ashbyhq.com/acme-ai/00000000-0000-4000-8000-000000000000" }
);

const MANUAL_WITH_SELF_ID = parseManualQuestions(
  [
    "1. Why do you want to build with Acme AI?",
    "2. Voluntary Self-Identification of Disability",
    "3. What is your veteran status?",
    "4. What recent tools have you used for agentic workflows?",
  ].join("\n")
);

const PACKET_CONTEXT = {
  application: { id: "app-packet", company: "Acme AI", role: "Applied AI Engineer" },
  profile: {
    candidate: { full_name: "Alex Rivera" },
    compensation: { current_base: "PRIVATE_CURRENT_BASE_SENTINEL" },
  },
  evidence: {
    claims: [
      {
        id: "ev-ai-001",
        claim: "Built production AI workflows from prototype to deployed customer tools.",
        role_signals: ["agentic workflow"],
      },
    ],
  },
  honesty: {
    tools: {
      confirmed: ["OpenAI API", "Claude Code"],
      do_not_claim: ["Kubernetes", "model training"],
    },
  },
};

test("filterAnswerableQuestions excludes provider demographic metadata and manual self-ID prompts", async () => {
  const { classifySelfIdentificationQuestion, filterAnswerableQuestions } =
    await loadQuestionsModule();

  assert.equal(
    classifySelfIdentificationQuestion("Voluntary Self-Identification of Disability").excluded,
    true
  );
  assert.equal(classifySelfIdentificationQuestion("What is your veteran status?").excluded, true);
  assert.equal(
    classifySelfIdentificationQuestion("Why do you want to build with Acme AI?").excluded,
    false
  );

  const filtered = filterAnswerableQuestions({
    captures: [GREENHOUSE_WITH_EEO, ASHBY_WITH_SURVEY, MANUAL_WITH_SELF_ID],
  });

  assert.deepEqual(
    filtered.answerable.map((q) => q.label),
    [
      "Why Acme AI?",
      "Which recent AI tools have you used?",
      "Why are you interested in this customer engineering role?",
      "Why do you want to build with Acme AI?",
      "What recent tools have you used for agentic workflows?",
    ]
  );
  assert.ok(filtered.excluded.some((q) => /disability/i.test(q.label)));
  assert.ok(filtered.excluded.some((q) => /veteran/i.test(q.label)));
  assert.equal(filtered.demographicSectionPresent, true);
});

test("capturePacketQuestions persists question metadata and can reload it by application id", async () => {
  const repoRoot = tempRepo();
  seedApp(repoRoot);
  const { capturePacketQuestions, loadPacketQuestionCapture } = await loadQuestionsModule();

  const capture = await capturePacketQuestions({
    repoRoot,
    env: {},
    appId: "app-packet",
    source: "manual",
    manualText: [
      "1. Why Acme AI?",
      "2. Voluntary Self-Identification of Disability",
      "3. What recent tools have you used?",
    ].join("\n"),
  });

  assert.equal(capture.appId, "app-packet");
  assert.match(capture.artifacts.packetQuestionsSource, /^workspace\/jobs\//);
  assert.equal(capture.artifacts.packetQuestionCount, 2);
  assert.equal(capture.artifacts.packetQuestionExcludedCount, 1);

  const loaded = await loadPacketQuestionCapture({ repoRoot, env: {}, appId: "app-packet" });
  assert.deepEqual(
    loaded.questions.map((q) => q.label),
    ["Why Acme AI?", "What recent tools have you used?"]
  );
  assert.deepEqual(
    loaded.excluded.map((q) => q.label),
    ["Voluntary Self-Identification of Disability"]
  );
});

test("draftPacketAnswers sends only non-EEO questions to bounded AI and preserves NEEDS YOU gaps", async () => {
  const { draftPacketAnswers } = await loadAnswersModule();
  const filteredQuestions = {
    answerable: [
      { id: "q1", label: "Why Acme AI?", type: "textarea", required: true },
      { id: "q2", label: "What recent tools have you used?", type: "text", required: true },
    ],
    excluded: [{ id: "eeo-1", label: "Voluntary Self-Identification of Disability" }],
  };
  const seenPrompt = [];

  const result = await draftPacketAnswers({
    context: PACKET_CONTEXT,
    questions: filteredQuestions,
    call: async (options) => {
      seenPrompt.push(JSON.stringify(options));
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              answers: [
                {
                  questionId: "q1",
                  answer: "Acme AI maps to my confirmed production AI workflow experience.",
                  evidenceIds: ["ev-ai-001"],
                },
                {
                  questionId: "q2",
                  answer: "NEEDS YOU: confirm whether Kubernetes is fair to claim.",
                  evidenceIds: [],
                  gap: "unsupported-tool-claim",
                },
              ],
            }),
          },
        ],
        model: "claude-test",
      };
    },
  });

  assert.equal(seenPrompt.length, 1);
  assert.doesNotMatch(
    seenPrompt[0],
    /Disability|veteran|gender|race|PRIVATE_CURRENT_BASE_SENTINEL/
  );
  assert.deepEqual(
    result.answers.map((a) => a.questionId),
    ["q1", "q2"]
  );
  assert.equal(result.answers[1].uploadReady, false);
  assert.match(result.answers[1].answer, /^NEEDS YOU:/);
  assert.deepEqual(result.excludedQuestionIds, ["eeo-1"]);
});
