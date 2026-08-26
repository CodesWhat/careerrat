// tests/packet-answers.test.mjs
// RED contracts for Phase 10 Wave 0: application-question capture and
// non-EEO answer drafting. Planned packet modules are dynamic imports so the
// current failure is the missing src/core/packet owner, not fixture setup.

import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Readable } from "node:stream";
import { after, test } from "node:test";
import { mountPacketRoutes } from "../src/cli/packet-route.mjs";
import {
  normalizeAshbyForm,
  normalizeGreenhouseQuestions,
  parseManualQuestions,
} from "../src/core/apply/form-questions.mjs";
import { closeAll, openDb } from "../src/core/db/connection.mjs";
import { importFromTracker } from "../src/core/db/import-from-tracker.mjs";
import { appUpsert } from "../src/core/db/verbs/app.mjs";
import { candidateConfigPatch, candidateEvidenceMerge } from "../src/core/db/verbs/candidate.mjs";
import { dispatchHttpRoute } from "../src/core/tracker/route-dispatch.mjs";

const cleanupRoots = [];

function tempRepo() {
  const repoRoot = mkdtempSync(join(tmpdir(), "careerrat-packet-answers-"));
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

function readApp(repoRoot, id) {
  const db = openDb({ repoRoot, env: {} });
  const row = db.prepare("SELECT data FROM applications WHERE id = ?").get(id);
  return row ? JSON.parse(row.data) : null;
}

function bootServer(repoRoot, opts = {}) {
  const routes = new Map();
  function addRoute(method, path, handler) {
    routes.set(`${method} ${path}`, handler);
  }
  mountPacketRoutes({ addRoute, repoRoot, env: {}, ...opts });

  const server = createServer((req, res) => {
    const url = (req.url || "/").split("?")[0];
    const route = routes.get(`${req.method} ${url}`);
    if (!route) {
      res.writeHead(404).end();
      return;
    }
    dispatchHttpRoute(route, req, res);
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve(server));
  });
}

function mountDirectRoutes(repoRoot, opts = {}) {
  const routes = new Map();
  mountPacketRoutes({
    addRoute(method, path, handler) {
      routes.set(`${method} ${path}`, handler);
    },
    repoRoot,
    env: {},
    ...opts,
  });
  return routes;
}

async function postJsonDirect(routes, path, payload) {
  const handler = routes.get(`POST ${path}`);
  assert.ok(handler, `expected mounted route for POST ${path}`);
  const req = Readable.from([Buffer.from(JSON.stringify(payload ?? {}))]);
  req.method = "POST";
  req.url = path;
  req.headers = { "content-type": "application/json" };
  let status = 200;
  let responseBody = "";
  const res = {
    writeHead(nextStatus) {
      status = nextStatus;
      return this;
    },
    end(chunk = "") {
      responseBody += String(chunk);
    },
  };
  await handler(req, res);
  return { status, body: responseBody ? JSON.parse(responseBody) : {} };
}

function baseUrl(server) {
  const { port } = server.address();
  return `http://127.0.0.1:${port}`;
}

function closeServer(server) {
  return new Promise((resolve) => server.close(resolve));
}

async function postJson(server, path, payload) {
  const res = await fetch(`${baseUrl(server)}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  const body = await res.json().catch(() => ({}));
  return { status: res.status, body };
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

const CONFIRMED_STORY = {
  id: "story-answer-rollout",
  title: "Customer agent workflow rollout",
  situation: "A customer process depended on manual handoffs.",
  task: "Deliver a reliable workflow with visible review controls.",
  action: "Built and deployed an observable agentic workflow with the customer team.",
  result: "The customer adopted the workflow for daily operations.",
  reflection: "Grounding and review controls should be designed together.",
  competencies: ["workflow delivery"],
  roleSignals: ["customer-facing agentic workflows"],
  metrics: ["one production rollout"],
  openQuestions: [],
  supportingQuote: "Built and deployed an observable agentic workflow",
  status: "confirmed",
  updatedAt: "2026-07-19T15:00:00.000Z",
};

test("filterAnswerableQuestions excludes provider demographic metadata and manual self-ID prompts", async () => {
  const { classifySelfIdentificationQuestion, filterAnswerableQuestions } =
    await loadQuestionsModule();

  assert.equal(
    classifySelfIdentificationQuestion("Voluntary Self-Identification of Disability").excluded,
    true
  );
  assert.equal(classifySelfIdentificationQuestion("What is your veteran status?").excluded, true);
  assert.deepEqual(
    classifySelfIdentificationQuestion("Are you a person of transgender experience?"),
    { excluded: true, reason: "gender" }
  );
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

test("self-identification classifier covers standard voluntary demographic categories without catching ordinary eligibility questions", async () => {
  const { classifySelfIdentificationQuestion } = await loadQuestionsModule();
  const demographic = [
    "Do you identify as LGBTQ+?",
    "What is your religion?",
    "Religious affiliation",
    "What is your marital status?",
    "What is your national origin?",
    "Which age range are you in?",
    "What is your date of birth?",
    "Parental or caregiver status",
    "Genetic information",
  ];
  const ordinary = [
    "Are you at least 18 years old?",
    "Are you authorized to work in your country of residence?",
    "Do you have experience supporting LGBTQ+ customers?",
    "Can you work on religious holidays?",
    "Are you willing to travel nationally?",
    "What is your favorite color?",
  ];

  for (const label of demographic) {
    assert.equal(
      classifySelfIdentificationQuestion(label).excluded,
      true,
      `expected demographic exclusion for: ${label}`
    );
  }
  for (const label of ordinary) {
    assert.equal(
      classifySelfIdentificationQuestion(label).excluded,
      false,
      `expected ordinary question to remain answerable: ${label}`
    );
  }
});

test("new demographic categories are excluded before the bounded answer AI sees them", async () => {
  const { filterAnswerableQuestions } = await loadQuestionsModule();
  const { draftPacketAnswers } = await loadAnswersModule();
  const filtered = filterAnswerableQuestions({
    captures: [
      {
        questions: [
          { id: "q-role", label: "Why are you interested in this role?", required: true },
          { id: "q-lgbtq", label: "Do you identify as LGBTQ+?", required: false },
          { id: "q-religion", label: "What is your religion?", required: false },
          { id: "q-marital", label: "What is your marital status?", required: false },
          { id: "q-origin", label: "What is your national origin?", required: false },
          { id: "q-age", label: "Which age range are you in?", required: false },
        ],
      },
    ],
  });
  const seenPrompts = [];

  const result = await draftPacketAnswers({
    context: PACKET_CONTEXT,
    questions: { answerable: filtered.answerable, excluded: filtered.excluded },
    call: async (options) => {
      seenPrompts.push(options.messages.at(-1).content);
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              answers: [
                {
                  questionId: "q-role",
                  answer: "The role matches my confirmed workflow experience.",
                  evidenceIds: ["ev-ai-001"],
                },
              ],
            }),
          },
        ],
        model: "claude-test",
      };
    },
  });

  assert.equal(seenPrompts.length, 1);
  assert.match(seenPrompts[0], /Why are you interested in this role/);
  assert.doesNotMatch(seenPrompts[0], /LGBTQ|religion|marital|national origin|age range/i);
  assert.deepEqual(
    result.answers.map((answer) => answer.questionId),
    ["q-role"]
  );
  assert.deepEqual(result.excludedQuestionIds, [
    "q-lgbtq",
    "q-religion",
    "q-marital",
    "q-origin",
    "q-age",
  ]);
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

test("capturePacketQuestions accepts live rendered fields and excludes demographic prompts", async () => {
  const { capturePacketQuestions } = await loadQuestionsModule();
  const capture = await capturePacketQuestions({
    source: "rendered",
    url: "https://careers.example.test/jobs/staff-ai/apply",
    questions: [
      { id: "name", label: "First Name", type: "text", required: true },
      { id: "why", label: "Why Example?", type: "text", required: true },
      { id: "gender", label: "Gender", type: "select", required: false },
    ],
  });

  assert.equal(capture.source, "rendered");
  assert.deepEqual(
    capture.questions.map((question) => question.label),
    ["First Name", "Why Example?"]
  );
  assert.deepEqual(
    capture.excluded.map((question) => question.label),
    ["Gender"]
  );
  assert.equal(capture.demographicSectionPresent, true);
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
      // Only the parts that are actually a prompt. JSON.stringify(options)
      // swept in `options.env`, the spawn environment for the local AI CLI,
      // which is the entire process environment. That made this assertion
      // depend on the machine it ran on: a checkout under a directory whose
      // name happened to contain one of the forbidden words failed here, via
      // PWD, with nothing wrong in the code under test. It also meant a
      // genuine failure printed every environment variable, secrets included,
      // into the test output and therefore into CI logs.
      seenPrompt.push(
        JSON.stringify({
          messages: options.messages,
          system: options.system,
          outputSchema: options.outputSchema,
        })
      );
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

test("draftPacketAnswers fills onboarding facts locally and only blocks on required unknowns", async () => {
  const { draftPacketAnswers } = await loadAnswersModule();
  const seenQuestions = [];

  const result = await draftPacketAnswers({
    context: {
      ...PACKET_CONTEXT,
      application: {
        ...PACKET_CONTEXT.application,
        link: "https://job-boards.greenhouse.io/acme/jobs/123",
      },
      profile: {
        ...PACKET_CONTEXT.profile,
        candidate: {
          full_name: "Alex Rivera",
          email: "alex@example.com",
          phone: "+1-555-0199",
          linkedin: "https://linkedin.com/in/alexrivera",
        },
        location: {
          home: "Austin, TX",
          hybrid: true,
          onsite: false,
          relocation: ["San Francisco, CA", "New York, NY"],
        },
        authorization: { notice_period: "2 weeks" },
      },
    },
    questions: {
      answerable: [
        { id: "first_name", label: "First Name", type: "text", required: true },
        { id: "email", label: "Email", type: "text", required: true },
        { id: "resume", label: "Resume/CV", type: "file", required: true },
        {
          id: "hybrid",
          label: "Are you open to working in-person in one of our offices 25% of the time?",
          type: "boolean",
          required: true,
        },
        {
          id: "relocation",
          label: "Are you open to relocation for this role?",
          type: "boolean",
          required: true,
        },
        {
          id: "relocating",
          label:
            'What is the address from which you plan on working? If you would need to relocate, please type "relocating".',
          type: "text",
          required: false,
        },
        {
          id: "start",
          label: "When is the earliest you would want to start working with us?",
          type: "text",
          required: false,
        },
        {
          id: "preferences",
          label: "(Optional) Personal Preferences",
          type: "text",
          required: false,
        },
        {
          id: "policy",
          label: "AI Policy for Application",
          type: "boolean",
          required: true,
        },
      ],
      excluded: [],
    },
    runAI: async ({ messages }) => {
      const prompt = messages.at(-1).content;
      const questions = JSON.parse(prompt.split("Questions:\n")[1].split("\n\nContext:")[0]);
      seenQuestions.push(...questions.map((question) => question.id));
      return {
        body: {
          ok: true,
          ai: { used: true },
          data: {
            answers: [
              {
                questionId: "preferences",
                answer: "NEEDS YOU — add this only if you want to.",
                evidenceIds: [],
                gap: "personal preference",
              },
              {
                questionId: "policy",
                answer: "NEEDS YOU — attest to your own use of AI.",
                evidenceIds: [],
                gap: "personal attestation",
              },
            ],
          },
        },
      };
    },
  });

  assert.deepEqual(seenQuestions, ["preferences", "policy"]);
  assert.equal(result.answers.find((answer) => answer.questionId === "first_name").answer, "Alex");
  assert.equal(
    result.answers.find((answer) => answer.questionId === "email").answer,
    "alex@example.com"
  );
  assert.match(
    result.answers.find((answer) => answer.questionId === "resume").answer,
    /generated resume/i
  );
  assert.equal(result.answers.find((answer) => answer.questionId === "hybrid").answer, "Yes");
  assert.equal(result.answers.find((answer) => answer.questionId === "relocation").answer, "Yes");
  assert.equal(
    result.answers.find((answer) => answer.questionId === "relocating").answer,
    "relocating"
  );
  assert.match(result.answers.find((answer) => answer.questionId === "start").answer, /2 weeks/i);
  assert.equal(
    result.answers.find((answer) => answer.questionId === "preferences").uploadReady,
    true
  );
  assert.equal(result.answers.find((answer) => answer.questionId === "preferences").skipped, true);
  assert.equal(result.answers.find((answer) => answer.questionId === "policy").uploadReady, false);
  assert.equal(result.uploadReady, false);
});

test("draftPacketAnswers accepts a story id selected into the answers prompt", async () => {
  const { draftPacketAnswers } = await loadAnswersModule();
  const result = await draftPacketAnswers({
    context: {
      ...PACKET_CONTEXT,
      job: {
        body: "Build customer-facing agentic workflows and lead workflow delivery.",
      },
      storiesLearnings: [CONFIRMED_STORY],
    },
    questions: {
      answerable: [{ id: "q-story", label: "Describe a relevant rollout.", required: true }],
      excluded: [],
    },
    runAI: async () => ({
      body: {
        ok: true,
        ai: { used: true },
        data: {
          answers: [
            {
              questionId: "q-story",
              answer: "I built and deployed an observable workflow with a customer team.",
              evidenceIds: [`story:${CONFIRMED_STORY.id}`],
            },
          ],
        },
      },
    }),
  });

  assert.equal(result.uploadReady, true);
  assert.deepEqual(result.answers[0].evidenceIds, [`story:${CONFIRMED_STORY.id}`]);
});

test("a disclosure answer conflicting with a confirmed boundary degrades to the standard NEEDS YOU marker", async () => {
  const { draftPacketAnswers } = await loadAnswersModule();
  const result = await draftPacketAnswers({
    context: {
      ...PACKET_CONTEXT,
      profile: {
        candidate: { full_name: "Alex Rivera" },
        authorization: { work_authorized: true },
      },
      honestyBoundariesConfirmed: [
        {
          id: "boundary-work-auth",
          boundaryType: "forbidden_wording",
          forbiddenWording: "legally authorized",
          text: "Never say legally authorized.",
        },
      ],
    },
    questions: {
      answerable: [
        {
          id: "q-work-auth",
          label: "Are you legally authorized to work in the United States?",
          required: true,
        },
      ],
      excluded: [],
    },
    runAI: async () => {
      throw new Error("deterministic disclosure must not call AI");
    },
  });

  // needsYouAnswer's reason-suffixed form IS the repo's canonical marker —
  // every consumer detects it with /^NEEDS YOU:/ (see answers.mjs), so the
  // contract here is the prefix plus non-upload-readiness, not a bare literal.
  assert.match(result.answers[0].answer, /^NEEDS YOU:/);
  assert.equal(result.answers[0].uploadReady, false);
});

test("a salary disclosure answer states expected_base, never the private minimum_base floor", async () => {
  const { draftPacketAnswers } = await loadAnswersModule();
  const result = await draftPacketAnswers({
    context: {
      ...PACKET_CONTEXT,
      profile: {
        candidate: { full_name: "Alex Rivera" },
        compensation: {
          current_base: "PRIVATE_CURRENT_BASE_SENTINEL",
          minimum_base: 150000,
          expected_base: 180000,
        },
      },
    },
    questions: {
      answerable: [{ id: "q-salary", label: "What are your salary expectations?", required: true }],
      excluded: [],
    },
    runAI: async () => {
      throw new Error("deterministic disclosure must not call AI");
    },
  });

  const answer = result.answers[0];
  assert.match(answer.answer, /180,000/);
  assert.doesNotMatch(answer.answer, /150,000/);
  assert.equal(answer.disclosure, true);
  assert.equal(answer.source, "profile");
});

test("a salary disclosure question with no expected_base on file degrades to NEEDS YOU rather than stating minimum_base", async () => {
  const { draftPacketAnswers } = await loadAnswersModule();
  const result = await draftPacketAnswers({
    context: {
      ...PACKET_CONTEXT,
      profile: {
        candidate: { full_name: "Alex Rivera" },
        // minimum_base on file, expected_base is not — the private floor
        // must never be substituted in as the outbound figure.
        compensation: { current_base: "PRIVATE_CURRENT_BASE_SENTINEL", minimum_base: 150000 },
      },
    },
    questions: {
      answerable: [{ id: "q-salary", label: "What are your salary expectations?", required: true }],
      excluded: [],
    },
    runAI: async () => ({
      body: { ok: true, ai: { used: true }, data: { answers: [] } },
    }),
  });

  const answer = result.answers[0];
  assert.match(answer.answer, /^NEEDS YOU:/);
  assert.doesNotMatch(answer.answer, /150,000/);
});

test("POST /api/packet/questions persists capture before local answer drafting", async () => {
  const repoRoot = tempRepo();
  seedApp(repoRoot);
  const server = await bootServer(repoRoot);
  try {
    const questionResult = await postJson(server, "/api/packet/questions", {
      appId: "app-packet",
      source: "paste",
      manualText: [
        "1. Why Acme AI?",
        "2. Voluntary Self-Identification of Disability",
        "3. What recent tools have you used?",
      ].join("\n"),
    });
    assert.equal(questionResult.status, 200);
    assert.equal(questionResult.body.ok, true);
    assert.equal(questionResult.body.data?.questions?.length, 2);
    assert.equal(questionResult.body.data?.excluded?.length, 1);

    const app = readApp(repoRoot, "app-packet");
    const artifacts = app?.artifacts || {};
    assert.match(String(artifacts.packetQuestionsSource || ""), /^workspace\/jobs\/.+\.json$/);
    assert.equal(artifacts.packetQuestionCount, 2);
    assert.equal(artifacts.packetQuestionExcludedCount, 1);
    assert.equal(app?.packetManifest?.questions?.answerableCount, 2);
    assert.ok(existsSync(join(repoRoot, artifacts.packetQuestionsSource)));
  } finally {
    await closeServer(server);
  }
});

test("POST /api/packet/answers drafts only persisted non-EEO questions through local bounded AI", async () => {
  const repoRoot = tempRepo();
  seedApp(repoRoot);
  const seen = [];
  const server = await bootServer(repoRoot, {
    packetAnswersCall: async (options) => {
      seen.push(JSON.stringify(options));
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
                  questionId: "q3",
                  answer: "NEEDS YOU: confirm which recent tools are fair to claim.",
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
  try {
    await postJson(server, "/api/packet/questions", {
      appId: "app-packet",
      source: "paste",
      manualText: [
        "1. Why Acme AI?",
        "2. Voluntary Self-Identification of Disability",
        "3. What recent tools have you used?",
      ].join("\n"),
    });
    const answerResult = await postJson(server, "/api/packet/answers", {
      appId: "app-packet",
      context: PACKET_CONTEXT,
    });
    assert.equal(answerResult.status, 200);
    assert.equal(answerResult.body.ok, true);
    assert.deepEqual(
      answerResult.body.data?.answers?.map((a) => a.questionId),
      ["q1", "q3"]
    );
    assert.deepEqual(answerResult.body.data?.excludedQuestionIds, ["q2"]);
    assert.equal(answerResult.body.data?.answers?.[1]?.uploadReady, false);
    assert.equal(seen.length, 1);
    assert.doesNotMatch(
      JSON.stringify(answerResult.body),
      /\/api\/skill\/run|answer-question|Voluntary Self-Identification|PRIVATE_CURRENT_BASE_SENTINEL/
    );
  } finally {
    await closeServer(server);
  }
});

test("POST /api/packet/answers builds real DB context when only applicationId is supplied", async () => {
  const repoRoot = tempRepo();
  seedApp(repoRoot);
  candidateConfigPatch({
    repoRoot,
    name: "profile",
    patch: { candidate: { full_name: "Route Context Candidate" } },
  });
  candidateEvidenceMerge({
    repoRoot,
    claims: [
      {
        id: "ev-route-context",
        claim: "Built customer-facing agentic workflows from prototype to daily use.",
        evidence: "Imported test evidence.",
      },
    ],
  });
  const seen = [];
  const routes = mountDirectRoutes(repoRoot, {
    packetAnswersCall: async (options) => {
      seen.push(JSON.stringify(options));
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              answers: [
                {
                  questionId: "q1",
                  answer: "My confirmed evidence covers customer-facing agentic workflows.",
                  evidenceIds: ["ev-route-context"],
                },
              ],
            }),
          },
        ],
        model: "claude-test",
      };
    },
  });
  await postJsonDirect(routes, "/api/packet/questions", {
    appId: "app-packet",
    source: "paste",
    manualText: "1. Why Acme AI?",
  });

  const answerResult = await postJsonDirect(routes, "/api/packet/answers", {
    applicationId: "app-packet",
  });

  assert.equal(answerResult.status, 200);
  assert.equal(answerResult.body.ok, true);
  assert.equal(answerResult.body.data.answers[0].uploadReady, true);
  assert.equal(seen.length, 1);
  assert.match(seen[0], /Route Context Candidate/);
  assert.match(seen[0], /ev-route-context/);
  assert.match(seen[0], /Build customer-facing agentic workflows/i);
});

test("forced answer regeneration preserves three prior application answers and gaps only a newly captured question", async () => {
  const repoRoot = tempRepo();
  seedApp(repoRoot);
  const application = readApp(repoRoot, "app-packet");
  appUpsert({
    repoRoot,
    env: {},
    row: {
      ...application,
      link: "https://jobs.ashbyhq.com/acme-ai/example",
      packetManifest: {
        applicationId: "app-packet",
        generatedAt: "2026-08-24T12:00:00.000Z",
        uploadReady: true,
        status: "upload-ready",
        gapCount: 0,
        gaps: [],
        artifacts: {},
        confirmedAnswers: [
          {
            questionId: "q-linkedin",
            question: "LinkedIn URL*",
            answer: "https://www.linkedin.com/in/alexrivera",
            confirmedAt: "2026-08-24T12:01:00.000Z",
          },
          {
            questionId: "q-motivation",
            question: "Why Acme AI?*",
            answer: "I want to build reliable customer workflows at Acme AI.",
            confirmedAt: "2026-08-24T12:02:00.000Z",
          },
          {
            questionId: "q-founder",
            question: "Who inspired Acme AI's founding?*",
            answer: "Morgan.",
            confirmedAt: "2026-08-24T12:03:00.000Z",
          },
        ],
      },
    },
  });
  const { capturePacketQuestions } = await loadQuestionsModule();
  await capturePacketQuestions({
    repoRoot,
    env: {},
    applicationId: "app-packet",
    source: "rendered",
    questions: [
      { id: "q-linkedin", label: "LinkedIn URL*", type: "text", required: true },
      { id: "q-motivation", label: "Why Acme AI?*", type: "text", required: true },
      {
        id: "q-founder",
        label: "Who inspired Acme AI's founding?*",
        type: "text",
        required: true,
      },
      {
        id: "q-travel",
        label: "Would you be willing to travel?",
        type: "radio",
        required: true,
        options: ["Yes", "No"],
      },
    ],
  });
  const seenQuestionIds = [];
  const routes = mountDirectRoutes(repoRoot, {
    packetAnswersCall: async (options) => {
      const prompt = options.messages.at(-1).content;
      const questions = JSON.parse(prompt.split("Questions:\n")[1].split("\n\nContext:")[0]);
      seenQuestionIds.push(...questions.map(({ id }) => id));
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              answers: [
                {
                  questionId: "q-travel",
                  answer: "NEEDS YOU: choose Yes or No based on your availability.",
                  evidenceIds: [],
                  gap: "personal travel availability",
                },
              ],
            }),
          },
        ],
        model: "claude-test",
      };
    },
  });

  const result = await postJsonDirect(routes, "/api/packet/answers", {
    applicationId: "app-packet",
  });

  assert.equal(result.status, 200);
  assert.deepEqual(seenQuestionIds, ["q-travel"]);
  assert.deepEqual(
    result.body.data.answers.slice(0, 3).map(({ questionId, answer }) => ({ questionId, answer })),
    [
      { questionId: "q-linkedin", answer: "https://www.linkedin.com/in/alexrivera" },
      {
        questionId: "q-motivation",
        answer: "I want to build reliable customer workflows at Acme AI.",
      },
      { questionId: "q-founder", answer: "Morgan." },
    ]
  );
  assert.deepEqual(
    result.body.data.answers
      .filter((answer) => answer.uploadReady === false)
      .map((answer) => answer.questionId),
    ["q-travel"]
  );
  assert.equal(result.body.data.uploadReady, false);
  assert.equal(result.body.data.manual.required, true);
});
