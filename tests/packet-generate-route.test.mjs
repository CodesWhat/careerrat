// tests/packet-generate-route.test.mjs
// RED contracts for Phase 10 Wave 0: local packet gate/generate APIs.
// These tests intentionally fail until src/cli/packet-route.mjs grows the
// POST routes and src/core/packet/* owners planned for later Phase 10 waves.

import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, test } from "node:test";
import { mountPacketRoutes } from "../src/cli/packet-route.mjs";
import { closeAll, openDb } from "../src/core/db/connection.mjs";
import { importFromTracker } from "../src/core/db/import-from-tracker.mjs";
import {
  candidateArtifactPut,
  candidateConfigPatch,
  candidateEvidenceMerge,
} from "../src/core/db/verbs/candidate.mjs";
import { evaluatePacketGate } from "../src/core/packet/gate.mjs";
import { dispatchHttpRoute } from "../src/core/tracker/route-dispatch.mjs";

const cleanupRoots = [];

function typedGateVerdict({ gate = "keep" } = {}) {
  return {
    gate,
    fitScore: gate === "keep" ? 91 : 68,
    fitSummary:
      gate === "keep"
        ? "Strong applied-AI workflow delivery match."
        : "Relevant scope needs human review.",
    compensation: {
      status: "clears-floor",
      currency: "USD",
      minBase: 212000,
      maxBase: 286000,
      source: "job-description",
      summary: "$212k–$286k base clears the candidate floor.",
    },
    action: gate === "keep" ? "generate-packet" : "resolve-review",
    fitReasons: ["JD centers on production AI workflow delivery"],
    fitRisks: gate === "keep" ? [] : ["Confirm customer-facing scope"],
    confidence: "high",
  };
}

function tempRepo() {
  const repoRoot = mkdtempSync(join(tmpdir(), "careerrat-packet-generate-route-"));
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
  assert.equal(
    existsSync(join(repoRoot, "workspace/tracker.json")),
    false,
    "packet generate tests seed SQLite directly and must not require generated tracker exports"
  );
}

function seedPacketReadyApp(
  repoRoot,
  { sourceResume = true, packetGate = "keep", evaluatedAt, reviewApproval } = {}
) {
  const jdPath = writeWorkspaceFile(
    repoRoot,
    "jobs/acme-applied-ai-engineer.md",
    [
      "---",
      'company: "Acme AI"',
      'role: "Applied AI Engineer"',
      "---",
      "# Job Description",
      "",
      "Build agentic workflow prototypes with customers and turn them into deployed tools.",
    ].join("\n")
  );
  const questionsPath = writeWorkspaceFile(
    repoRoot,
    "jobs/acme-applied-ai-engineer.questions.json",
    JSON.stringify(
      {
        // Matches capturePacketQuestions' actual artifactPayload() shape
        // (packetQuestionCaptureArtifactSchema requires capturedAt/
        // answerableIds/excludedIds/demographicSectionPresent) — a capture
        // that fails that schema is now a real BAD_PACKET_QUESTIONS error
        // rather than silently degrading to "no capture".
        source: "manual",
        url: null,
        capturedAt: "2026-07-06T13:00:00Z",
        questions: [
          {
            id: "q1",
            label: "Why are you interested in building agentic workflows at Acme AI?",
            type: "text",
            required: true,
          },
        ],
        excluded: [],
        answerableIds: ["q1"],
        excludedIds: [],
        demographicSectionPresent: false,
      },
      null,
      2
    )
  );

  importTrackerFixture(repoRoot, [
    {
      id: "app-packet",
      company: "Acme AI",
      role: "Applied AI Engineer",
      status: "reviewed-hold",
      fitBasis: "evaluated",
      fitBucket: "high",
      evaluation: {
        gate: packetGate,
        ...(evaluatedAt ? { evaluatedAt } : {}),
      },
      ...(reviewApproval ? { reviewApproval } : {}),
      artifacts: {
        jd: jdPath,
        packetQuestionsSource: questionsPath,
        packetQuestionsCapturedAt: "2026-07-06T13:00:00Z",
        packetQuestionCount: 1,
        packetQuestionExcludedCount: 0,
      },
    },
  ]);

  // The generated resume/cover letter draw their content from the candidate
  // profile + evidence bank — without these the engine correctly produces an
  // empty shell, and the content assertions downstream have nothing to match.
  candidateConfigPatch({
    repoRoot,
    name: "profile",
    patch: { candidate: { full_name: "Alex Rivera" } },
  });
  candidateEvidenceMerge({
    repoRoot,
    claims: [
      {
        id: "ev-agentic-pilots",
        claim: "Shipped three production AI workflow pilots into daily customer use",
        evidence: "Source: resume (Experience — Northwind Digital).",
      },
    ],
  });
  if (sourceResume) seedSourceResume(repoRoot);
}

function seedSourceResume(repoRoot) {
  candidateArtifactPut({
    repoRoot,
    id: "source-resume",
    kind: "source-resume",
    data: {
      text: [
        "Northwind Digital | New York, NY | 2020 - 2024",
        "Applied AI Engineer | 2022 - 2024",
        "Shipped production AI workflow pilots using OpenAI API and SQLite.",
      ].join("\n"),
      source: "test",
    },
  });
}

function seedPacketCandidate(repoRoot, { sourceResume = true } = {}) {
  candidateConfigPatch({
    repoRoot,
    name: "profile",
    patch: { candidate: { full_name: "Alex Rivera" } },
  });
  candidateEvidenceMerge({
    repoRoot,
    claims: [
      {
        id: "ev-agentic-pilots",
        claim: "Shipped three production AI workflow pilots into daily customer use",
        evidence: "Source: resume (Experience — Northwind Digital).",
      },
    ],
  });
  if (sourceResume) seedSourceResume(repoRoot);
}

function validPacketResumeCall() {
  return {
    model: "resume-test-double",
    content: [
      {
        type: "text",
        text: JSON.stringify({
          summary: "Applied AI engineer building grounded customer workflows.",
          experience: [
            {
              company: "Northwind Digital",
              location: "New York, NY",
              dates: "2020 - 2024",
              roles: [
                {
                  title: "Applied AI Engineer",
                  dates: "2022 - 2024",
                  bullets: ["Shipped production AI workflow pilots into daily customer use."],
                },
              ],
            },
          ],
          skillGroups: [{ label: "Delivery", items: ["OpenAI API", "SQLite"] }],
        }),
      },
    ],
  };
}

function validPacketCoverLetterCall() {
  return {
    model: "cover-test-double",
    content: [
      {
        type: "text",
        text: JSON.stringify({
          blocks: [
            {
              text: "Acme AI matches my production AI workflow delivery experience.",
              evidenceIds: ["ev-agentic-pilots"],
            },
          ],
        }),
      },
    ],
  };
}

function validPacketCalls(overrides = {}) {
  return {
    packetResumeCall: async () => validPacketResumeCall(),
    packetCoverLetterCall: async () => validPacketCoverLetterCall(),
    ...overrides,
  };
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

async function requestPacketGeneration(repoRoot) {
  let resumeCalls = 0;
  let coverCalls = 0;
  const server = await bootServer(
    repoRoot,
    validPacketCalls({
      packetResumeCall: async () => {
        resumeCalls += 1;
        return validPacketResumeCall();
      },
      packetCoverLetterCall: async () => {
        coverCalls += 1;
        return validPacketCoverLetterCall();
      },
    })
  );
  try {
    const response = await postJson(server, "/api/packet/generate", {
      appId: "app-packet",
      applyIntent: false,
      formats: [],
    });
    return { ...response, resumeCalls, coverCalls };
  } finally {
    await closeServer(server);
  }
}

async function getJson(server, path) {
  const res = await fetch(`${baseUrl(server)}${path}`);
  const body = await res.json().catch(() => ({}));
  return { status: res.status, body };
}

async function postRaw(server, path, bodyText) {
  const res = await fetch(`${baseUrl(server)}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: bodyText,
  });
  const body = await res.json().catch(() => ({}));
  return { status: res.status, body };
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

test("POST /api/packet/gate: 409 when SQLite has not been initialized", async () => {
  const repoRoot = tempRepo();
  const server = await bootServer(repoRoot);
  try {
    const { status, body } = await postJson(server, "/api/packet/gate", {
      appId: "app-packet",
    });
    assert.equal(status, 409);
    assert.match(body.error?.message || body.error || "", /database|data import|data init/i);
  } finally {
    await closeServer(server);
  }
});

test("POST /api/packet/gate: malformed JSON is a local 400, not a skill-runtime handoff", async () => {
  const repoRoot = tempRepo();
  seedPacketReadyApp(repoRoot);
  const server = await bootServer(repoRoot, validPacketCalls());
  try {
    const { status, body } = await postRaw(server, "/api/packet/gate", "{");
    assert.equal(status, 400);
    assert.equal(body.code, "BAD_REQUEST");
    assert.doesNotMatch(JSON.stringify(body), /\/api\/skill\/run|evaluate-job/);
  } finally {
    await closeServer(server);
  }
});

test("POST /api/packet/gate: captures supplied JD body and stamps artifacts.jd before AI", async () => {
  const repoRoot = tempRepo();
  seedPacketReadyApp(repoRoot);
  const seen = [];
  const server = await bootServer(repoRoot, {
    packetGateInvoke: async ({ prompt }) => {
      seen.push(prompt);
      return ["```json", JSON.stringify(typedGateVerdict()), "```"].join("\n");
    },
  });
  try {
    const { status, body } = await postJson(server, "/api/packet/gate", {
      applicationId: "app-packet",
      jobBody:
        "Own agentic workflow prototypes with customers and ship deployed AI workflow tools.",
      jobUrl: "https://example.test/jobs/app-packet",
    });
    assert.equal(status, 200);
    assert.equal(body.ok, true);
    assert.equal(body.data?.gate, "keep");
    assert.equal(body.data?.fitScore, 91);
    assert.equal(body.data?.fitBucket, "high");
    assert.equal(body.data?.compensation?.minBase, 212000);
    assert.match(body.data?.evaluatedAt || "", /^\d{4}-\d{2}-\d{2}T/);
    assert.equal(body.data?.manual?.required, false);
    assert.equal(seen.length, 1, "readable supplied JD should allow one bounded AI call");

    const app = readApp(repoRoot, "app-packet");
    const jdPath = app?.artifacts?.jd;
    assert.match(String(jdPath || ""), /^workspace\/jobs\/.+\.md$/);
    assert.ok(existsSync(join(repoRoot, jdPath)), "captured JD artifact should exist locally");
    assert.match(String(app?.artifacts?.jdGeneratedAt || ""), /^\d{4}-\d{2}-\d{2}T/);
    assert.deepEqual(app.evaluation, body.data);
    assert.equal(app.packetGate, undefined, "typed evaluation is the sole current verdict");
    assert.equal(app.fitScore, 91);
    assert.equal(app.fitBucket, "high");
    assert.equal(app.fitBasis, "evaluated");
    assert.equal(app.base, "$212,000 - $286,000");
    assert.equal(app.compNote, "$212k–$286k base clears the candidate floor.");
    assert.deepEqual(app.roleFit, {
      why: ["JD centers on production AI workflow delivery"],
      risks: [],
    });
    assert.match(seen[0], /minimum_base|targeting|evidence/i);
    assert.match(seen[0], /complete plain-English sentences/i);
    assert.match(seen[0], /fitReasons.*72 characters/i);
  } finally {
    await closeServer(server);
  }
});

test("POST /api/packet/gate: an excluded-company posting forces CUT without an AI call", async () => {
  const repoRoot = tempRepo();
  seedPacketReadyApp(repoRoot);
  candidateConfigPatch({
    repoRoot,
    name: "targeting",
    patch: { excluded_companies: ["Acme AI"] },
  });
  const server = await bootServer(repoRoot, {
    packetGateInvoke: async () => {
      throw new Error("excluded-company gate must not call the AI");
    },
  });
  try {
    const { status, body } = await postJson(server, "/api/packet/gate", {
      applicationId: "app-packet",
      jobBody:
        "Own agentic workflow prototypes with customers and ship deployed AI workflow tools.",
    });
    assert.equal(status, 200);
    assert.equal(body.ok, true);
    assert.equal(body.data?.gate, "cut");
    assert.equal(body.data?.manual?.required, false);
    assert.equal(body.data?.ai?.used, false);
    assert.match(body.data?.fitRisks?.[0] || "", /excluded/i);

    const app = readApp(repoRoot, "app-packet");
    assert.equal(app.evaluation.gate, "cut");
  } finally {
    await closeServer(server);
  }
});

test("POST /api/packet/gate: the shared exclusion matcher also hard-cuts an excluded title", async () => {
  const repoRoot = tempRepo();
  seedPacketReadyApp(repoRoot);
  candidateConfigPatch({
    repoRoot,
    name: "targeting",
    patch: { excluded_companies: ["Applied   AI Engineer"] },
  });
  const server = await bootServer(repoRoot, {
    packetGateInvoke: async () => {
      throw new Error("excluded-title gate must not call the AI");
    },
  });
  try {
    const { status, body } = await postJson(server, "/api/packet/gate", {
      applicationId: "app-packet",
      jobBody:
        "Own agentic workflow prototypes with customers and ship deployed AI workflow tools.",
    });
    assert.equal(status, 200);
    assert.equal(body.data?.gate, "cut");
    assert.equal(body.data?.ai?.used, false);
  } finally {
    await closeServer(server);
  }
});

test("POST /api/packet/gate: a cut_signal match in the JD forces REVIEW without an AI call", async () => {
  const repoRoot = tempRepo();
  seedPacketReadyApp(repoRoot);
  candidateConfigPatch({
    repoRoot,
    name: "targeting",
    patch: { cut_signals: ["unpaid overtime expected"] },
  });
  const server = await bootServer(repoRoot, {
    packetGateInvoke: async () => {
      throw new Error("cut-signal gate must not call the AI");
    },
  });
  try {
    const { status, body } = await postJson(server, "/api/packet/gate", {
      applicationId: "app-packet",
      jobBody:
        "Own agentic workflow prototypes with customers. Unpaid overtime expected during launches.",
    });
    assert.equal(status, 200);
    assert.equal(body.ok, true);
    assert.equal(body.data?.gate, "review");
    assert.equal(body.data?.manual?.required, true);
    assert.equal(body.data?.manual?.code, "CUT_SIGNAL_MATCH");
    assert.equal(body.data?.ai?.used, false);
    assert.match(body.data?.fitRisks?.[0] || "", /unpaid overtime expected/i);
  } finally {
    await closeServer(server);
  }
});

test("packet gate reserves output budget for model reasoning plus the typed verdict", async () => {
  const repoRoot = tempRepo();
  seedPacketReadyApp(repoRoot);
  let seenOptions = null;

  const result = await evaluatePacketGate({
    repoRoot,
    body: { applicationId: "app-packet" },
    runAI: async (options) => {
      seenOptions = options;
      return {
        body: {
          ok: true,
          ai: { used: true, model: "claude-test" },
          data: typedGateVerdict(),
        },
      };
    },
  });

  assert.equal(result.status, 200);
  assert.equal(result.body.data.gate, "keep");
  assert.ok(
    seenOptions.maxTokens >= 4096,
    "the packet gate must leave room for model reasoning before its JSON verdict"
  );
  assert.equal(seenOptions.effort, "low");
});

test("POST /api/packet/gate: keeps budget-limited evaluation copy readable", async () => {
  const repoRoot = tempRepo();
  seedPacketReadyApp(repoRoot);
  const clippedReason =
    "Riley owns discovery-through-deployment AI rollouts for enterprise customers,cut";
  const clippedRisk =
    "The role requires three days per week in an office; Riley is open to hybrid and";
  const clippedComp =
    "Posted annual salary range is $200,000–$320,000 USD. The minimum clears Riley’s $190,000 base floor, and the range includes the $215,000base";
  assert.equal(clippedReason.length, 80);
  assert.equal(clippedRisk.length, 79);
  assert.equal(clippedComp.length, 140);
  const server = await bootServer(repoRoot, {
    packetGateInvoke: async () =>
      [
        "```json",
        JSON.stringify({
          ...typedGateVerdict(),
          compensation: { ...typedGateVerdict().compensation, summary: clippedComp },
          fitReasons: [clippedReason],
          fitRisks: [clippedRisk],
        }),
        "```",
      ].join("\n"),
  });

  try {
    const { status, body } = await postJson(server, "/api/packet/gate", {
      applicationId: "app-packet",
    });
    assert.equal(status, 200);
    assert.ok(body.data.fitReasons[0].length <= 80);
    assert.ok(body.data.fitRisks[0].length <= 80);
    assert.ok(body.data.compensation.summary.length <= 130);
    assert.match(body.data.fitReasons[0], /…$/);
    assert.match(body.data.fitRisks[0], /…$/);
    assert.doesNotMatch(body.data.fitRisks[0], /\band…$/i);
    assert.match(body.data.compensation.summary, /…$/);
  } finally {
    await closeServer(server);
  }
});

test("POST /api/packet/gate: preserves complete fit copy within the persisted budget", async () => {
  const repoRoot = tempRepo();
  seedPacketReadyApp(repoRoot);
  const completeReason =
    "The remote United States role suits a New York base and remote work preference.";
  assert.equal(completeReason.length, 79);
  const server = await bootServer(repoRoot, {
    packetGateInvoke: async () =>
      [
        "```json",
        JSON.stringify({ ...typedGateVerdict(), fitReasons: [completeReason] }),
        "```",
      ].join("\n"),
  });

  try {
    const { status, body } = await postJson(server, "/api/packet/gate", {
      applicationId: "app-packet",
    });
    assert.equal(status, 200);
    assert.equal(body.data.fitReasons[0], completeReason);
  } finally {
    await closeServer(server);
  }
});

test("POST /api/packet/gate: accepts an ordinary wait instruction without a correction retry", async () => {
  const repoRoot = tempRepo();
  seedPacketReadyApp(repoRoot);
  const attempts = [];
  const action = "Wait for the recruiter response.";
  const server = await bootServer(repoRoot, {
    packetGateInvoke: async ({ attempt }) => {
      attempts.push(attempt);
      return `\`\`\`json\n${JSON.stringify({ ...typedGateVerdict(), action })}\n\`\`\``;
    },
  });

  try {
    const { status, body } = await postJson(server, "/api/packet/gate", {
      applicationId: "app-packet",
    });
    assert.equal(status, 200);
    assert.equal(body.ok, true);
    assert.deepEqual(attempts, [0]);
    assert.equal(body.data.action, action);
  } finally {
    await closeServer(server);
  }
});

test("POST /api/packet/gate: retries drafting residue and never persists the rejected evaluation copy", async () => {
  const repoRoot = tempRepo();
  seedPacketReadyApp(repoRoot);
  const attempts = [];
  const badReason =
    "Has production Python and backend platform experience at scale shock? Wait typo.";
  const correctedReason = "Has production Python and backend platform experience at scale.";
  const server = await bootServer(repoRoot, {
    packetGateInvoke: async ({ attempt, correction }) => {
      attempts.push({ attempt, correction });
      const verdict = {
        ...typedGateVerdict(),
        fitReasons: [attempt === 0 ? badReason : correctedReason],
      };
      return `\`\`\`json\n${JSON.stringify(verdict)}\n\`\`\``;
    },
  });

  try {
    const { status, body } = await postJson(server, "/api/packet/gate", {
      applicationId: "app-packet",
    });
    assert.equal(status, 200);
    assert.equal(body.ok, true);
    assert.equal(attempts.length, 2, "drafting residue must trigger the bounded correction retry");
    assert.match(attempts[1].correction || "", /fitReasons\[0\].*final user-facing copy/i);
    assert.deepEqual(body.data.fitReasons, [correctedReason]);
    assert.equal(body.data.ai.retried, true);

    const app = readApp(repoRoot, "app-packet");
    assert.deepEqual(app.evaluation.fitReasons, [correctedReason]);
    assert.deepEqual(app.roleFit.why, [correctedReason]);
    assert.doesNotMatch(JSON.stringify(app), /scale shock|wait typo/i);
  } finally {
    await closeServer(server);
  }
});

test("POST /api/packet/gate: replaces blank summaries with the typed fallbacks", async () => {
  const repoRoot = tempRepo();
  seedPacketReadyApp(repoRoot);
  const server = await bootServer(repoRoot, {
    packetGateInvoke: async () =>
      `\`\`\`json\n${JSON.stringify({
        ...typedGateVerdict(),
        fitSummary: "   ",
        compensation: { ...typedGateVerdict().compensation, summary: "" },
      })}\n\`\`\``,
  });

  try {
    const { status, body } = await postJson(server, "/api/packet/gate", {
      applicationId: "app-packet",
    });
    assert.equal(status, 200);
    assert.equal(body.data.fitSummary, "Fit needs review.");
    assert.equal(body.data.compensation.summary, "Compensation needs review.");
  } finally {
    await closeServer(server);
  }
});

test("POST /api/packet/gate: reuses existing artifacts.jd when no body is supplied", async () => {
  const repoRoot = tempRepo();
  seedPacketReadyApp(repoRoot);
  const prompts = [];
  const server = await bootServer(repoRoot, {
    packetGateInvoke: async ({ prompt }) => {
      prompts.push(prompt);
      return `\`\`\`json\n${JSON.stringify(typedGateVerdict({ gate: "review" }))}\n\`\`\``;
    },
  });
  try {
    const { status, body } = await postJson(server, "/api/packet/gate", {
      applicationId: "app-packet",
    });
    assert.equal(status, 200);
    assert.equal(body.ok, true);
    assert.equal(body.data?.gate, "review");
    assert.equal(readApp(repoRoot, "app-packet")?.evaluation?.gate, "review");
    assert.equal(prompts.length, 1);
    assert.match(prompts[0], /Build agentic workflow prototypes/);
  } finally {
    await closeServer(server);
  }
});

// Regression for the QA-reproduced bug: a captured JD that resolves to an
// EXISTING application (trackerMatch company_role dedup) runs a fresh
// re-evaluation. The verdict landed on the nested `evaluation` object but
// the top-level gate/status/note — stamped from the FIRST evaluation — never
// resynced, so the Jobs list showed Stage "Reviewed Hold" next to Fit
// "Cut" for the same row, and the job-detail header badge contradicted the
// Evaluate card.
test("POST /api/packet/gate: a re-evaluation to CUT resyncs top-level gate/status/note", async () => {
  const repoRoot = tempRepo();
  // packetGate: "review" seeds the exact stale shape QA hit: nested
  // evaluation.gate "review" with no top-level gate/status resync from that
  // first pass (status stays the seed default "reviewed-hold").
  seedPacketReadyApp(repoRoot, { packetGate: "review" });
  const server = await bootServer(repoRoot, {
    packetGateInvoke: async () =>
      `\`\`\`json\n${JSON.stringify(typedGateVerdict({ gate: "cut" }))}\n\`\`\``,
  });
  try {
    const { status, body } = await postJson(server, "/api/packet/gate", {
      applicationId: "app-packet",
    });
    assert.equal(status, 200);
    assert.equal(body.data?.gate, "cut");

    const app = readApp(repoRoot, "app-packet");
    assert.equal(app.evaluation.gate, "cut");
    assert.equal(app.gate, "cut", "top-level gate must match the fresh verdict");
    assert.equal(app.status, "cut", "top-level status must match the fresh verdict");
    assert.match(app.note, /gate cut/, "top-level note must reflect the fresh verdict");
  } finally {
    await closeServer(server);
  }
});

test("POST /api/packet/gate: a re-evaluation never regresses an already-applied status", async () => {
  const repoRoot = tempRepo();
  seedPacketReadyApp(repoRoot, { packetGate: "keep" });
  // The candidate applied and advanced by hand since the first evaluation.
  importTrackerFixture(repoRoot, [
    {
      id: "app-packet",
      company: "Acme AI",
      role: "Applied AI Engineer",
      status: "interview",
      fitBasis: "evaluated",
      fitBucket: "high",
      evaluation: { gate: "keep" },
      artifacts: readApp(repoRoot, "app-packet").artifacts,
    },
  ]);
  const server = await bootServer(repoRoot, {
    packetGateInvoke: async () =>
      `\`\`\`json\n${JSON.stringify(typedGateVerdict({ gate: "cut" }))}\n\`\`\``,
  });
  try {
    const { status, body } = await postJson(server, "/api/packet/gate", {
      applicationId: "app-packet",
    });
    assert.equal(status, 200);
    assert.equal(body.data?.gate, "cut");

    const app = readApp(repoRoot, "app-packet");
    assert.equal(app.evaluation.gate, "cut", "nested evaluation still refreshes");
    assert.equal(app.status, "interview", "an already-applied status must never regress");
  } finally {
    await closeServer(server);
  }
});

test("POST /api/packet/gate: refuses to treat an explicitly partial saved JD as complete", async () => {
  const repoRoot = tempRepo();
  seedPacketReadyApp(repoRoot);
  writeFileSync(
    join(repoRoot, "workspace/jobs/acme-applied-ai-engineer.md"),
    [
      "---",
      'company: "Acme AI"',
      'role: "Applied AI Engineer"',
      "partial: true",
      "---",
      "# Job Description",
      "",
      "This is a readable but shortened feed preview, not the complete posting.",
    ].join("\n"),
    "utf8"
  );
  let invoked = 0;
  const server = await bootServer(repoRoot, {
    packetGateInvoke: async () => {
      invoked += 1;
      return `\`\`\`json\n${JSON.stringify(typedGateVerdict())}\n\`\`\``;
    },
  });
  try {
    const { status, body } = await postJson(server, "/api/packet/gate", {
      applicationId: "app-packet",
    });
    assert.equal(status, 200);
    assert.equal(body.ok, true);
    assert.equal(body.data?.gate, "review");
    assert.equal(body.data?.manual?.code, "MISSING_JOB_BODY");
    assert.equal(invoked, 0, "a shortened preview must never reach the evaluator as a full JD");
  } finally {
    await closeServer(server);
  }
});

test("POST /api/packet/gate: preserves unknown compensation as null instead of a fake $0 band", async () => {
  const repoRoot = tempRepo();
  seedPacketReadyApp(repoRoot);
  const verdict = {
    ...typedGateVerdict({ gate: "review" }),
    compensation: {
      status: "unknown",
      currency: null,
      minBase: null,
      maxBase: null,
      source: "job-description",
      summary: "No base compensation range is included in the saved job description.",
    },
  };
  const server = await bootServer(repoRoot, {
    packetGateInvoke: async () => `\`\`\`json\n${JSON.stringify(verdict)}\n\`\`\``,
  });

  try {
    const { status, body } = await postJson(server, "/api/packet/gate", {
      applicationId: "app-packet",
    });
    assert.equal(status, 200);
    assert.equal(body.data?.compensation?.minBase, null);
    assert.equal(body.data?.compensation?.maxBase, null);

    const app = readApp(repoRoot, "app-packet");
    assert.equal(app.base, null);
    assert.equal(app.compEstimate?.lowK, null);
    assert.equal(app.compEstimate?.midpointK, null);
    assert.equal(app.compEstimate?.highK, null);
    assert.equal(app.compEstimate?.source, "none");
  } finally {
    await closeServer(server);
  }
});

test("POST /api/packet/gate: missing JD body returns review/manual state and skips AI", async () => {
  const repoRoot = tempRepo();
  importTrackerFixture(repoRoot, [
    {
      id: "app-no-jd",
      company: "Acme AI",
      role: "Applied AI Engineer",
      status: "reviewed-hold",
      fitScore: 81,
      fitBasis: "triage",
      fitBucket: "high",
      base: "$200–235K",
      compEstimate: { source: "comparables", lowK: 200, midpointK: 218, highK: 235 },
      artifacts: {},
    },
  ]);
  let aiCalls = 0;
  const server = await bootServer(repoRoot, {
    packetGateInvoke: async () => {
      aiCalls += 1;
      return "{}";
    },
  });
  try {
    const { status, body } = await postJson(server, "/api/packet/gate", {
      applicationId: "app-no-jd",
    });
    assert.equal(status, 200);
    assert.equal(body.ok, true);
    assert.equal(body.data?.gate, "review");
    assert.equal(body.data?.manual?.required, true);
    assert.equal(body.data?.manual?.code, "MISSING_JOB_BODY");
    assert.equal(aiCalls, 0, "missing JD body must not call bounded AI");
    const app = readApp(repoRoot, "app-no-jd");
    assert.equal(app?.artifacts?.jd ?? null, null);
    assert.equal(app.fitScore, 81);
    assert.equal(app.fitBasis, "triage");
    assert.equal(app.fitBucket, "high");
    assert.equal(app.base, "$200–235K");
    assert.deepEqual(app.compEstimate, {
      source: "comparables",
      lowK: 200,
      midpointK: 218,
      highK: 235,
    });
  } finally {
    await closeServer(server);
  }
});

test("POST /api/packet/gate: no AI route stays reviewable and does not fabricate KEEP", async () => {
  const repoRoot = tempRepo();
  seedPacketReadyApp(repoRoot);
  const server = await bootServer(repoRoot, {
    packetGateInvoke: async () => {
      const err = new Error("no AI route configured");
      err.code = "NO_AI_ROUTE";
      throw err;
    },
  });
  try {
    const { status, body } = await postJson(server, "/api/packet/gate", {
      applicationId: "app-packet",
    });
    assert.equal(status, 200);
    assert.equal(body.ok, true);
    assert.equal(body.data?.gate, "review");
    assert.equal(body.data?.manual?.required, true);
    assert.equal(body.data?.manual?.code, "NO_AI_ROUTE");
    assert.notEqual(body.data?.gate, "keep");
  } finally {
    await closeServer(server);
  }
});

test("POST /api/packet/gate delegates the Evaluate button to workspace-main when mounted", async () => {
  const repoRoot = tempRepo();
  seedPacketReadyApp(repoRoot);
  const evaluation = typedGateVerdict();
  const calls = [];
  const server = await bootServer(repoRoot, {
    workspaceAgentRuntime: {
      async executeIntent(input) {
        calls.push(input);
        return {
          thread: { id: "workspace-main" },
          messages: [
            {
              role: "assistant",
              kind: "action_result",
              artifacts: [
                {
                  kind: "job_evaluation",
                  applicationId: "app-packet",
                  evaluation,
                },
              ],
            },
          ],
        };
      },
    },
    packetGateInvoke: async () => {
      throw new Error("direct packet gate must not run when workspace-main is mounted");
    },
  });

  try {
    const { status, body } = await postJson(server, "/api/packet/gate", {
      applicationId: "app-packet",
    });
    assert.equal(status, 200);
    assert.deepEqual(body, { ok: true, data: evaluation });
    assert.deepEqual(calls, [
      {
        intent: {
          type: "job.evaluate",
          entity: { type: "application", id: "app-packet" },
        },
      },
    ]);
  } finally {
    await closeServer(server);
  }
});

test("POST /api/packet/generate: stamps packet source/export artifacts through DB without tracker input", async () => {
  const repoRoot = tempRepo();
  seedPacketReadyApp(repoRoot);
  assert.equal(
    existsSync(join(repoRoot, "workspace/tracker.json")),
    false,
    "generated tracker export must not be required before packet generation"
  );

  const server = await bootServer(repoRoot, validPacketCalls());
  try {
    const { status, body } = await postJson(server, "/api/packet/generate", {
      appId: "app-packet",
      applyIntent: true,
      formats: ["pdf"],
    });
    assert.equal(status, 200);
    assert.equal(body.ok, true);
    assert.equal(body.data?.appId, "app-packet");
    assert.notEqual(body.data?.submitted, true, "packet generation prepares files only");

    const app = readApp(repoRoot, "app-packet");
    const artifacts = app?.artifacts || {};
    for (const key of [
      "packetManifest",
      "resume",
      "resumeSource",
      "coverLetter",
      "coverLetterSource",
      "answers",
      "answersSource",
      "resumePdf",
      "coverLetterPdf",
      "answersPdf",
    ]) {
      assert.match(
        String(artifacts[key] || ""),
        /^workspace\//,
        `${key} should be workspace-stamped`
      );
      assert.ok(
        existsSync(join(repoRoot, artifacts[key])),
        `${key} should point at a local artifact file`
      );
    }
    for (const key of ["resumeGeneratedAt", "coverLetterGeneratedAt", "answersGeneratedAt"]) {
      assert.match(String(artifacts[key] || ""), /^\d{4}-\d{2}-\d{2}T/);
    }
    assert.equal(artifacts.resume, artifacts.resumeSource);
    assert.equal(artifacts.coverLetter, artifacts.coverLetterSource);
    assert.equal(artifacts.answers, artifacts.answersSource);
    assert.match(artifacts.coverLetterPdf, /-cover-letter\.pdf$/);

    const readBack = await getJson(server, "/api/packet?id=app-packet");
    assert.equal(readBack.status, 200);
    assert.match(readBack.body.artifacts.resume.markdown, /Alex Rivera|production AI/i);
    assert.match(readBack.body.artifacts.coverLetter.markdown, /Hiring Team|Acme AI/i);
    assert.match(readBack.body.artifacts.answers.markdown, /Why are you interested/i);
    assert.equal(artifacts.resumeDocx ?? null, null, "DOCX should not be generated by default");
    assert.equal(
      artifacts.coverLetterDocx ?? null,
      null,
      "cover-letter DOCX should not be generated by default"
    );
  } finally {
    await closeServer(server);
  }
});

test("POST /api/packet/generate delegates document work to workspace-main when mounted", async () => {
  const repoRoot = tempRepo();
  seedPacketReadyApp(repoRoot);
  const generation = {
    appId: "app-packet",
    applicationId: "app-packet",
    submitted: false,
    uploadReady: false,
    status: "reviewable",
    artifacts: { resume: "workspace/tailored/acme-resume.md" },
    gaps: [{ kind: "answers", message: "Capture questions first." }],
    manual: { required: true },
  };
  const calls = [];
  const server = await bootServer(repoRoot, {
    workspaceAgentRuntime: {
      async executeIntent(input) {
        calls.push(input);
        return {
          thread: { id: "workspace-main" },
          operationResult: generation,
          messages: [
            {
              role: "assistant",
              kind: "action_result",
              artifacts: [
                {
                  kind: "packet_generation",
                  applicationId: "app-packet",
                  status: "reviewable",
                  uploadReady: false,
                  artifacts: generation.artifacts,
                  gaps: generation.gaps,
                },
              ],
            },
          ],
        };
      },
    },
    packetResumeCall: async () => {
      throw new Error("direct packet generator must not run when workspace-main is mounted");
    },
  });

  try {
    const { status, body } = await postJson(server, "/api/packet/generate", {
      applicationId: "app-packet",
      applyIntent: false,
      formats: ["pdf"],
    });
    assert.equal(status, 200);
    assert.deepEqual(body, { ok: true, data: generation });
    assert.deepEqual(calls, [
      {
        intent: {
          type: "job.generate-documents",
          entity: { type: "application", id: "app-packet" },
          input: { applyIntent: false, formats: ["pdf"] },
        },
      },
    ]);
  } finally {
    await closeServer(server);
  }
});

test("POST /api/packet/export delegates packaging to workspace-main when mounted", async () => {
  const repoRoot = tempRepo();
  seedPacketReadyApp(repoRoot);
  const exported = {
    appId: "app-packet",
    applicationId: "app-packet",
    formats: ["pdf"],
    artifacts: { resumePdf: "workspace/tailored/acme-resume.pdf" },
    userFacing: {
      resume: [
        {
          format: "pdf",
          path: "workspace/tailored/acme-resume.pdf",
          name: "acme-resume.pdf",
        },
      ],
      coverLetter: [],
      answers: [],
    },
  };
  const calls = [];
  const server = await bootServer(repoRoot, {
    workspaceAgentRuntime: {
      async executeIntent(input) {
        calls.push(input);
        return { operationResult: exported };
      },
    },
  });

  try {
    const { status, body } = await postJson(server, "/api/packet/export", {
      applicationId: "app-packet",
      formats: ["pdf"],
    });
    assert.equal(status, 200);
    assert.deepEqual(body, { ok: true, data: exported });
    assert.deepEqual(calls, [
      {
        intent: {
          type: "job.export-documents",
          entity: { type: "application", id: "app-packet" },
          input: { formats: ["pdf"] },
        },
      },
    ]);
  } finally {
    await closeServer(server);
  }
});

test("packet generation gate: current REVIEW approval generates", async () => {
  const repoRoot = tempRepo();
  const evaluatedAt = "2026-08-25T12:00:00.000Z";
  seedPacketReadyApp(repoRoot, {
    packetGate: "review",
    evaluatedAt,
    reviewApproval: {
      evaluatedAt,
      approvedAt: "2026-08-25T12:01:00.000Z",
    },
  });

  const generated = await requestPacketGeneration(repoRoot);

  assert.notEqual(generated.body.code, "PACKET_GATE_REQUIRED");
  assert.equal(generated.status, 200);
  assert.equal(generated.body.ok, true);
  assert.equal(generated.resumeCalls, 1);
  assert.match(generated.body.data.sources.resume, /Northwind Digital/);
});

test("packet generation gate: REVIEW without approval is rejected before generation", async () => {
  const repoRoot = tempRepo();
  seedPacketReadyApp(repoRoot, {
    packetGate: "review",
    evaluatedAt: "2026-08-25T12:00:00.000Z",
  });

  const generated = await requestPacketGeneration(repoRoot);

  assert.equal(generated.status, 409);
  assert.equal(generated.body.code, "PACKET_GATE_REQUIRED");
  assert.equal(generated.resumeCalls, 0);
  assert.equal(generated.coverCalls, 0);
});

test("packet generation gate: REVIEW approval for another evaluation is rejected", async () => {
  const repoRoot = tempRepo();
  seedPacketReadyApp(repoRoot, {
    packetGate: "review",
    evaluatedAt: "2026-08-25T12:00:00.000Z",
    reviewApproval: {
      evaluatedAt: "2026-08-24T12:00:00.000Z",
      approvedAt: "2026-08-24T12:01:00.000Z",
    },
  });

  const generated = await requestPacketGeneration(repoRoot);

  assert.equal(generated.status, 409);
  assert.equal(generated.body.code, "PACKET_GATE_REQUIRED");
  assert.equal(generated.resumeCalls, 0);
  assert.equal(generated.coverCalls, 0);
});

test("packet generation gate: KEEP behavior still generates", async () => {
  const repoRoot = tempRepo();
  seedPacketReadyApp(repoRoot, {
    packetGate: "keep",
    evaluatedAt: "2026-08-25T12:00:00.000Z",
  });

  const generated = await requestPacketGeneration(repoRoot);

  assert.equal(generated.status, 200);
  assert.equal(generated.body.ok, true);
  assert.equal(generated.resumeCalls, 1);
  assert.match(generated.body.data.sources.resume, /Northwind Digital/);
});

test("POST /api/packet/generate: standalone tailoring ignores saved application questions", async () => {
  const repoRoot = tempRepo();
  seedPacketReadyApp(repoRoot);
  let resumeCallCount = 0;
  const packetResumeCall = async () => {
    resumeCallCount += 1;
    return validPacketResumeCall();
  };
  let packetAnswersCallCount = 0;
  const packetAnswersCall = async () => {
    packetAnswersCallCount += 1;
    throw new Error("standalone tailoring must not draft application answers");
  };
  const server = await bootServer(
    repoRoot,
    validPacketCalls({ packetResumeCall, packetAnswersCall })
  );
  try {
    const generated = await postJson(server, "/api/packet/generate", {
      appId: "app-packet",
      applyIntent: false,
      formats: [],
    });
    assert.equal(generated.status, 200);
    assert.equal(generated.body.ok, true);
    assert.equal(resumeCallCount, 1);
    assert.equal(packetAnswersCallCount, 0);
    assert.match(
      generated.body.data.sources.resume,
      /\*\*Northwind Digital\*\* - New York, NY \| 2020 - 2024/
    );
    assert.match(generated.body.data.sources.resume, /### Applied AI Engineer \| 2022 - 2024/);
    assert.equal(generated.body.data.sources.answers ?? null, null);
    assert.equal(generated.body.data.artifacts.answers ?? null, null);
    assert.equal(generated.body.data.artifacts.answersSource ?? null, null);
    assert.equal(generated.body.data.manifest.questions.length, 0);
    assert.equal(generated.body.data.manifest.questionCaptureSource ?? null, null);
  } finally {
    await closeServer(server);
  }
});

test("POST /api/packet/generate: returns 409 when no source resume is on file", async () => {
  const repoRoot = tempRepo();
  seedPacketReadyApp(repoRoot, { sourceResume: false });
  let resumeCalls = 0;
  const server = await bootServer(
    repoRoot,
    validPacketCalls({
      packetResumeCall: async () => {
        resumeCalls += 1;
        return validPacketResumeCall();
      },
    })
  );
  try {
    const generated = await postJson(server, "/api/packet/generate", {
      appId: "app-packet",
      applyIntent: false,
      formats: [],
    });
    assert.equal(generated.status, 409);
    assert.equal(generated.body.code, "NO_SOURCE_RESUME");
    assert.match(generated.body.error.message, /no source résumé on file/i);
    assert.equal(resumeCalls, 0);
    assert.deepEqual(readApp(repoRoot, "app-packet").artifacts, {
      jd: "workspace/jobs/acme-applied-ai-engineer.md",
      packetQuestionsSource: "workspace/jobs/acme-applied-ai-engineer.questions.json",
      packetQuestionsCapturedAt: "2026-07-06T13:00:00Z",
      packetQuestionCount: 1,
      packetQuestionExcludedCount: 0,
    });
  } finally {
    await closeServer(server);
  }
});

test("POST /api/packet/generate: returns 503 when the resume AI call is unavailable", async () => {
  const repoRoot = tempRepo();
  seedPacketReadyApp(repoRoot);
  let resumeCalls = 0;
  const server = await bootServer(
    repoRoot,
    validPacketCalls({
      packetResumeCall: async () => {
        resumeCalls += 1;
        const err = new Error("no AI route configured");
        err.code = "NO_AI_ROUTE";
        throw err;
      },
    })
  );
  try {
    const generated = await postJson(server, "/api/packet/generate", {
      appId: "app-packet",
      applyIntent: false,
      formats: [],
    });
    assert.equal(generated.status, 503);
    assert.equal(generated.body.code, "PACKET_AI_UNAVAILABLE");
    assert.match(generated.body.error.message, /document generation needs AI/i);
    assert.equal(resumeCalls, 1);
  } finally {
    await closeServer(server);
  }
});

test("POST /api/packet/generate: no capture degrades without apply intent and skips answers", async () => {
  const repoRoot = tempRepo();
  const jdPath = writeWorkspaceFile(
    repoRoot,
    "jobs/northstar-solutions-engineer.md",
    "# Job Description\n\nBuild customer-facing workflow automations.\n"
  );
  importTrackerFixture(repoRoot, [
    {
      id: "app-no-questions",
      company: "Northstar",
      role: "Solutions Engineer",
      status: "reviewed-hold",
      packetGate: { gate: "keep" },
      artifacts: { jd: jdPath },
    },
  ]);
  seedPacketCandidate(repoRoot);
  const server = await bootServer(repoRoot, validPacketCalls());
  try {
    const generated = await postJson(server, "/api/packet/generate", {
      applicationId: "app-no-questions",
      applyIntent: false,
      formats: ["pdf"],
    });
    assert.equal(generated.status, 200);
    assert.equal(generated.body.ok, true);
    assert.match(generated.body.data.artifacts.resume, /^workspace\//);
    assert.match(generated.body.data.artifacts.coverLetter, /^workspace\//);
    assert.equal(generated.body.data.artifacts.answers ?? null, null);
    assert.equal(generated.body.data.artifacts.answersSource ?? null, null);
    assert.ok(
      generated.body.data.gaps.some(
        (gap) =>
          gap.kind === "answers" &&
          gap.code === "QUESTION_CAPTURE_DEFERRED" &&
          /skipped.*no application questions/i.test(gap.message)
      )
    );

    const app = readApp(repoRoot, "app-no-questions");
    assert.equal(app.artifacts.answers ?? null, null);
    assert.equal(app.artifacts.answersPdf ?? null, null);
  } finally {
    await closeServer(server);
  }
});

test("POST /api/packet/generate: no capture with apply intent returns BAD_QUESTION_CAPTURE", async () => {
  const repoRoot = tempRepo();
  importTrackerFixture(repoRoot, [
    {
      id: "app-apply-no-questions",
      company: "Northstar",
      role: "Solutions Engineer",
      status: "reviewed-hold",
      packetGate: { gate: "keep" },
      artifacts: {},
    },
  ]);
  const server = await bootServer(repoRoot);
  try {
    const generated = await postJson(server, "/api/packet/generate", {
      applicationId: "app-apply-no-questions",
      applyIntent: true,
    });
    assert.equal(generated.status, 400);
    assert.equal(generated.body.code, "BAD_QUESTION_CAPTURE");
  } finally {
    await closeServer(server);
  }
});

test("POST /api/packet/generate: apply intent rejects a schema-invalid saved capture", async () => {
  const repoRoot = tempRepo();
  seedPacketReadyApp(repoRoot);
  writeFileSync(
    join(repoRoot, "workspace/jobs/acme-applied-ai-engineer.questions.json"),
    JSON.stringify({ source: "manual", questions: "not-an-array" }),
    "utf8"
  );
  const server = await bootServer(repoRoot);
  try {
    const generated = await postJson(server, "/api/packet/generate", {
      applicationId: "app-packet",
      applyIntent: true,
    });
    assert.equal(generated.status, 400);
    assert.equal(generated.body.code, "BAD_PACKET_QUESTIONS");
    assert.match(generated.body.error.message, /invalid/i);
  } finally {
    await closeServer(server);
  }
});
