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

const cleanupRoots = [];

function tempRepo() {
  const repoRoot = mkdtempSync(join(tmpdir(), "rolester-packet-generate-route-"));
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

function seedPacketReadyApp(repoRoot, { sourceResume = true } = {}) {
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
    route(req, res);
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
      return [
        "```json",
        JSON.stringify({
          gate: "keep",
          fit: "strong match for applied AI workflow delivery",
          comp: "review",
          action: "generate-packet",
          reasons: ["JD mentions agentic workflow prototypes"],
          confidence: "high",
        }),
        "```",
      ].join("\n");
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
    assert.equal(body.data?.manual?.required, false);
    assert.equal(seen.length, 1, "readable supplied JD should allow one bounded AI call");

    const app = readApp(repoRoot, "app-packet");
    const jdPath = app?.artifacts?.jd;
    assert.match(String(jdPath || ""), /^workspace\/jobs\/.+\.md$/);
    assert.ok(
      existsSync(join(repoRoot, jdPath.replace(/^workspace\//, "workspace/"))),
      "captured JD artifact should exist locally"
    );
    assert.match(String(app?.artifacts?.jdGeneratedAt || ""), /^\d{4}-\d{2}-\d{2}T/);
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
      return '```json\n{"gate":"review","fit":"needs human review","comp":"review","action":"review","reasons":["saved body loaded"],"confidence":"medium"}\n```';
    },
  });
  try {
    const { status, body } = await postJson(server, "/api/packet/gate", {
      applicationId: "app-packet",
    });
    assert.equal(status, 200);
    assert.equal(body.ok, true);
    assert.equal(body.data?.gate, "review");
    assert.equal(prompts.length, 1);
    assert.match(prompts[0], /Build agentic workflow prototypes/);
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
    assert.equal(readApp(repoRoot, "app-no-jd")?.artifacts?.jd ?? null, null);
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
        existsSync(join(repoRoot, artifacts[key].replace(/^workspace\//, "workspace/"))),
        `${key} should point at a local artifact file`
      );
    }
    for (const key of ["resumeGeneratedAt", "coverLetterGeneratedAt", "answersGeneratedAt"]) {
      assert.match(String(artifacts[key] || ""), /^\d{4}-\d{2}-\d{2}T/);
    }
    assert.equal(artifacts.resume, artifacts.resumeSource);
    assert.equal(artifacts.coverLetter, artifacts.coverLetterSource);
    assert.equal(artifacts.answers, artifacts.answersSource);

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

test("POST /api/packet/generate: threads packetResumeCall into tailored resume generation", async () => {
  const repoRoot = tempRepo();
  seedPacketReadyApp(repoRoot);
  let resumeCallCount = 0;
  const packetResumeCall = async () => {
    resumeCallCount += 1;
    return validPacketResumeCall();
  };
  const server = await bootServer(repoRoot, validPacketCalls({ packetResumeCall }));
  try {
    const generated = await postJson(server, "/api/packet/generate", {
      appId: "app-packet",
      applyIntent: false,
      formats: [],
    });
    assert.equal(generated.status, 200);
    assert.equal(generated.body.ok, true);
    assert.equal(resumeCallCount, 1);
    assert.match(
      generated.body.data.sources.resume,
      /\*\*Northwind Digital\*\* - New York, NY \| 2020 - 2024/
    );
    assert.match(generated.body.data.sources.resume, /### Applied AI Engineer \| 2022 - 2024/);
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
        (gap) => gap.kind === "answers" && /skipped.*no application questions/i.test(gap.message)
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

test("POST /api/packet/generate: schema-invalid saved capture returns BAD_PACKET_QUESTIONS", async () => {
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
      applyIntent: false,
    });
    assert.equal(generated.status, 400);
    assert.equal(generated.body.code, "BAD_PACKET_QUESTIONS");
    assert.match(generated.body.error.message, /invalid/i);
  } finally {
    await closeServer(server);
  }
});
