import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { after, test } from "node:test";

import { closeAll, openDb } from "../src/core/db/connection.mjs";
import { appUpsert, commUpsert, sourcedUpsertBatch } from "../src/core/db/verbs.mjs";

const cleanupRoots = [];

function tempRepo({ db = true } = {}) {
  const repoRoot = mkdtempSync(join(tmpdir(), "careerrat-chat-first-route-"));
  cleanupRoots.push(repoRoot);
  if (db) openDb({ repoRoot });
  return repoRoot;
}

after(() => {
  closeAll();
  for (const root of cleanupRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

async function boot(repoRoot, options = {}) {
  const routeModule = await import("../src/cli/chat-first-route.mjs").catch(() => ({}));
  assert.equal(typeof routeModule.mountChatFirstRoutes, "function");
  const routes = new Map();
  routeModule.mountChatFirstRoutes({
    addRoute(method, path, handler) {
      routes.set(`${method} ${path}`, handler);
    },
    repoRoot,
    env: {},
    ...options,
  });
  return routes;
}

async function invoke(routes, method, path, payload) {
  const handler = routes.get(`${method} ${path}`);
  assert.ok(handler, `missing ${method} ${path}`);
  const body = payload === undefined ? "" : JSON.stringify(payload);
  const req = Readable.from(body ? [Buffer.from(body)] : []);
  req.method = method;
  req.url = path;
  let status = 200;
  let raw = "";
  await new Promise((resolve, reject) => {
    const res = {
      writeHead(nextStatus) {
        status = nextStatus;
        return res;
      },
      end(chunk = "") {
        raw = Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk);
        resolve();
      },
    };
    Promise.resolve(handler(req, res)).catch(reject);
  });
  return { status, body: raw ? JSON.parse(raw) : null };
}

async function invokeBinary(routes, method, path, payload) {
  const handler = routes.get(`${method} ${path}`);
  assert.ok(handler, `missing ${method} ${path}`);
  const req = Readable.from([Buffer.from(JSON.stringify(payload))]);
  req.method = method;
  req.url = path;
  let status = 200;
  let headers = {};
  let raw = Buffer.alloc(0);
  await new Promise((resolve, reject) => {
    const res = {
      writeHead(nextStatus, nextHeaders = {}) {
        status = nextStatus;
        headers = Object.fromEntries(
          Object.entries(nextHeaders).map(([key, value]) => [key.toLowerCase(), value])
        );
        return res;
      },
      end(chunk = "") {
        raw = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
        resolve();
      },
    };
    Promise.resolve(handler(req, res)).catch(reject);
  });
  return { status, headers, body: raw };
}

function aiReply(data) {
  return {
    content: [{ type: "text", text: JSON.stringify(data) }],
    model: "test-small",
  };
}

test("chat-first route module mounts the complete durable write surface", async () => {
  const repoRoot = tempRepo();
  const routes = await boot(repoRoot);
  for (const key of [
    "POST /api/chat-first/job-thread/pin",
    "POST /api/chat-first/job-thread/archive",
    "POST /api/chat-first/job-thread/message",
    "POST /api/chat-first/job-thread/turn",
    "POST /api/chat-first/dossier/pdf",
    "POST /api/chat-first/missions",
    "POST /api/chat-first/missions/status",
    "POST /api/chat-first/missions/step",
    "POST /api/chat-first/missions/run",
    "POST /api/chat-first/missions/resume",
    "POST /api/chat-first/mock/start",
    "POST /api/chat-first/mock/message",
    "POST /api/chat-first/mock/turn",
    "POST /api/chat-first/mock/feedback",
    "POST /api/chat-first/mock/end",
    "POST /api/chat-first/sourced/decision",
    "POST /api/chat-first/deep-ingest-prompt/dismiss",
    "POST /api/chat-first/touch-due/dismiss",
  ]) {
    assert.equal(routes.has(key), true, key);
  }
});

test("deep ingest prompt dismiss route returns the durable updated aggregate", async () => {
  const repoRoot = tempRepo();
  const routes = await boot(repoRoot);

  const dismissed = await invoke(routes, "POST", "/api/chat-first/deep-ingest-prompt/dismiss", {});

  assert.equal(dismissed.status, 200);
  assert.equal(dismissed.body.data.reused, false);
  assert.equal(dismissed.body.data.prompt.visible, false);
  assert.equal(dismissed.body.data.prompt.dismissed, true);
  assert.deepEqual(dismissed.body.data.state.deepIngestPrompt, dismissed.body.data.prompt);

  const replay = await invoke(routes, "POST", "/api/chat-first/deep-ingest-prompt/dismiss", {});
  assert.equal(replay.status, 200);
  assert.equal(replay.body.data.reused, true);
  assert.equal(replay.body.data.prompt.dismissedAt, dismissed.body.data.prompt.dismissedAt);
});

test("dossier PDF route returns a real no-store attachment from the canonical exporter", async () => {
  const repoRoot = tempRepo();
  const calls = [];
  const routes = await boot(repoRoot, {
    exportInterviewDossierPdfImpl: async (input) => {
      calls.push(input);
      return {
        applicationId: input.applicationId,
        path: "workspace/interview-prep/acme-engineer.pdf",
        filename: "acme-engineer.pdf",
        buffer: Buffer.from("%PDF-1.7\nreal dossier pdf\n%%EOF", "utf8"),
      };
    },
  });

  const response = await invokeBinary(routes, "POST", "/api/chat-first/dossier/pdf", {
    applicationId: "app-dossier",
    artifactPath: "workspace/interview-prep/acme-engineer.md",
  });

  assert.equal(response.status, 200);
  assert.equal(response.headers["content-type"], "application/pdf");
  assert.equal(response.headers["cache-control"], "no-store");
  assert.equal(response.headers["x-content-type-options"], "nosniff");
  assert.equal(response.headers["content-disposition"], 'attachment; filename="acme-engineer.pdf"');
  assert.equal(
    decodeURIComponent(response.headers["x-careerrat-artifact-path"]),
    "workspace/interview-prep/acme-engineer.pdf"
  );
  assert.match(response.body.toString("utf8"), /^%PDF-/);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].applicationId, "app-dossier");
  assert.equal(calls[0].artifactPath, "workspace/interview-prep/acme-engineer.md");
});

test("sourced decision route durably skips, restores, and creates a prepare-only apply mission", async () => {
  const repoRoot = tempRepo();
  sourcedUpsertBatch({
    repoRoot,
    rows: [
      {
        id: "source-route-decision",
        company: "Route Decision Corp",
        role: "Engineer",
        status: "sourced",
      },
    ],
  });
  const routes = await boot(repoRoot);

  const skipped = await invoke(routes, "POST", "/api/chat-first/sourced/decision", {
    id: "source-route-decision",
    decision: "skip",
  });
  assert.equal(skipped.status, 200);
  assert.equal(skipped.body.data.row.status, "cut");

  const restored = await invoke(routes, "POST", "/api/chat-first/sourced/decision", {
    id: "source-route-decision",
    decision: "restore",
  });
  assert.equal(restored.status, 200);
  assert.equal(restored.body.data.row.status, "sourced");

  const applied = await invoke(routes, "POST", "/api/chat-first/sourced/decision", {
    id: "source-route-decision",
    decision: "apply",
  });
  assert.equal(applied.status, 200);
  assert.equal(applied.body.data.mission.mode, "prepare-to-submit");
  assert.equal(
    applied.body.data.mission.steps.some((step) => step.action === "submit-gate"),
    true
  );
  assert.equal(
    applied.body.data.mission.steps.some((step) => step.action === "submit"),
    false
  );
});

test("touch-due dismiss route clears the canonical communication due state and returns refreshed aggregate state", async () => {
  const repoRoot = tempRepo();
  appUpsert({
    repoRoot,
    row: { id: "app-touch-route", company: "Route Corp", role: "Engineer", status: "applied" },
  });
  commUpsert({
    repoRoot,
    row: {
      id: "comm-touch-route",
      applicationId: "app-touch-route",
      company: "Route Corp",
      role: "Engineer",
      channel: "email",
      status: "waiting",
      nextAction: "Follow up",
      nextActionDue: "2020-01-01",
      participants: [{ name: "Recruiter" }],
      messages: [],
    },
  });
  const routes = await boot(repoRoot);
  const dismissed = await invoke(routes, "POST", "/api/chat-first/touch-due/dismiss", {
    id: "comm-touch-route",
    source: "communication",
  });

  assert.equal(dismissed.status, 200);
  assert.equal(dismissed.body.data.dismissal.id, "comm-touch-route");
  assert.equal(dismissed.body.data.reused, false);
  assert.deepEqual(dismissed.body.data.state.touchDue, []);
  const db = openDb({ repoRoot });
  const stored = JSON.parse(
    db.prepare("SELECT data FROM communications WHERE id = ?").get("comm-touch-route").data
  );
  assert.equal(stored.nextActionDue, null);
});

test("chat-first routes fail closed without a DB and reject malformed bodies", async () => {
  const noDbRoot = tempRepo({ db: false });
  const noDbRoutes = await boot(noDbRoot);
  const noDb = await invoke(noDbRoutes, "POST", "/api/chat-first/job-thread/pin", {
    applicationId: "app-1",
  });
  assert.equal(noDb.status, 409);
  assert.match(noDb.body.error, /no database yet/);

  const noDbPrompt = await invoke(
    noDbRoutes,
    "POST",
    "/api/chat-first/deep-ingest-prompt/dismiss",
    {}
  );
  assert.equal(noDbPrompt.status, 409);
  assert.match(noDbPrompt.body.error, /no database yet/);

  const repoRoot = tempRepo();
  const routes = await boot(repoRoot);
  const invalid = await invoke(routes, "POST", "/api/chat-first/missions", { jobs: [] });
  assert.equal(invalid.status, 400);
  assert.match(invalid.body.error, /non-empty array/);
});

test("mission routes invoke the existing workspace-intent runtime and stop at durable submit gates", async () => {
  const repoRoot = tempRepo();
  appUpsert({
    repoRoot,
    row: { id: "app-1", company: "Aperture Science", role: "Staff Engineer", status: "applied" },
  });
  const calls = [];
  const routes = await boot(repoRoot, {
    workspaceAgentRuntime: {
      executeIntent: async ({ intent }) => {
        calls.push(intent);
        return {
          operationResult: { ok: true },
          ...(intent.type === "job.prepare-submit"
            ? { messages: [{ metadata: { state: "awaiting-submit" } }] }
            : {}),
        };
      },
    },
  });
  const created = await invoke(routes, "POST", "/api/chat-first/missions", {
    id: "mission-http",
    jobs: [{ type: "application", id: "app-1" }],
  });
  assert.equal(created.status, 201);
  assert.equal(created.body.data.mission.status, "running");

  const run = await invoke(routes, "POST", "/api/chat-first/missions/run", {
    id: "mission-http",
  });
  assert.equal(run.status, 200);
  assert.equal(run.body.data.mission.status, "paused");
  assert.deepEqual(
    calls.map((intent) => intent.type),
    ["job.evaluate", "job.generate-documents", "job.prepare-submit"]
  );
  assert.equal(
    calls.some((intent) => intent.type === "job.apply"),
    false
  );
});

test("mission resume route continues a durable paused run and never invokes job.apply", async () => {
  const repoRoot = tempRepo();
  appUpsert({
    repoRoot,
    row: {
      id: "app-resume-http",
      company: "Restart Route Corp",
      role: "Staff Engineer",
      status: "applied",
      evaluation: { gate: "keep" },
    },
  });
  const calls = [];
  const routes = await boot(repoRoot, {
    workspaceAgentRuntime: {
      executeIntent: async ({ intent }) => {
        calls.push(intent.type);
        return {
          operationResult: { ok: true },
          ...(intent.type === "job.prepare-submit"
            ? { messages: [{ metadata: { state: "awaiting-submit" } }] }
            : {}),
        };
      },
    },
  });
  await invoke(routes, "POST", "/api/chat-first/missions", {
    id: "mission-resume-http",
    jobs: [{ type: "application", id: "app-resume-http" }],
  });
  await invoke(routes, "POST", "/api/chat-first/missions/status", {
    id: "mission-resume-http",
    status: "paused",
  });

  const resumed = await invoke(routes, "POST", "/api/chat-first/missions/resume", {
    id: "mission-resume-http",
  });

  assert.equal(resumed.status, 200);
  assert.equal(resumed.body.data.mission.status, "paused");
  assert.deepEqual(calls, ["job.generate-documents", "job.prepare-submit"]);
  assert.equal(calls.includes("job.apply"), false);
});

test("mock interview HTTP lifecycle returns validated durable session state", async () => {
  const repoRoot = tempRepo();
  appUpsert({
    repoRoot,
    row: { id: "app-1", company: "Cyberdyne", role: "Platform Engineer", status: "interview" },
  });
  const routes = await boot(repoRoot, {
    callAIImpl: async () => aiReply({ question: "Tell me about a hard migration." }),
  });
  const started = await invoke(routes, "POST", "/api/chat-first/mock/start", {
    id: "mock-http",
    applicationId: "app-1",
    questionTotal: 3,
  });
  assert.equal(started.status, 201);
  const message = await invoke(routes, "POST", "/api/chat-first/mock/message", {
    sessionId: "mock-http",
    role: "assistant",
    kind: "question",
    questionNumber: 1,
    text: "Tell me about a hard migration.",
  });
  assert.equal(message.status, 200);
  assert.equal(message.body.data.message.questionNumber, 1);
  const invalid = await invoke(routes, "POST", "/api/chat-first/mock/feedback", {
    sessionId: "mock-http",
    questionNumber: 4,
    worked: "Clear result",
    tighten: "Add scale",
  });
  assert.equal(invalid.status, 400);
});

test("mock interview routes accept the compact UI payload and derive the active question safely", async () => {
  const repoRoot = tempRepo();
  appUpsert({
    repoRoot,
    row: { id: "app-compact", company: "Tyrell", role: "Engineer", status: "interview" },
  });
  const routes = await boot(repoRoot, {
    callAIImpl: async () => aiReply({ question: "Tell me about a hard migration." }),
  });
  const started = await invoke(routes, "POST", "/api/chat-first/mock/start", {
    id: "mock-compact",
    applicationId: "app-compact",
    questionCount: 3,
  });
  assert.equal(started.body.data.session.questionTotal, 3);

  const message = await invoke(routes, "POST", "/api/chat-first/mock/message", {
    sessionId: "mock-compact",
    text: "I migrated the system in three phases.",
  });
  assert.equal(message.status, 200);
  assert.equal(message.body.data.message.role, "user");
  assert.equal(message.body.data.message.kind, "answer");
  assert.equal(message.body.data.message.questionNumber, 1);

  const feedback = await invoke(routes, "POST", "/api/chat-first/mock/feedback", {
    sessionId: "mock-compact",
    worked: "Clear sequence.",
    tighten: "Add scale.",
  });
  assert.equal(feedback.status, 200);
  assert.equal(feedback.body.data.feedback.questionNumber, 1);
});

test("job-thread turn persists both sides and grounds bounded AI in canonical application and thread context", async () => {
  const repoRoot = tempRepo();
  appUpsert({
    repoRoot,
    row: {
      id: "app-turn",
      company: "Massive Dynamic",
      role: "Staff Platform Engineer",
      status: "interview",
      statusNote: "Hiring manager screen next",
      current_base: 987654,
    },
  });
  const calls = [];
  const routes = await boot(repoRoot, {
    callAIImpl: async (options) => {
      calls.push(options);
      return aiReply({ reply: "Lead with the migration result, then name the tradeoff." });
    },
  });

  const turn = await invoke(routes, "POST", "/api/chat-first/job-thread/turn", {
    applicationId: "app-turn",
    text: "How should I frame my migration story?",
  });
  assert.equal(turn.status, 200);
  assert.equal(turn.body.data.userMessage.role, "user");
  assert.equal(turn.body.data.assistantMessage.role, "assistant");
  assert.equal(turn.body.data.thread.messages.length, 2);
  assert.equal(
    turn.body.data.thread.messages[1].text,
    "Lead with the migration result, then name the tradeoff."
  );
  assert.equal(calls.length, 1);
  assert.equal(calls[0].outputName, "chat_first_job_thread_reply");
  const prompt = JSON.stringify(calls[0].messages);
  assert.match(prompt, /Massive Dynamic/);
  assert.match(prompt, /Staff Platform Engineer/);
  assert.match(prompt, /How should I frame my migration story/);
  assert.doesNotMatch(prompt, /987654|current_base/);
});

test("AI-backed mock start and turn persist role-calibrated question, answer, feedback, and next question", async () => {
  const repoRoot = tempRepo();
  appUpsert({
    repoRoot,
    row: {
      id: "app-mock-ai",
      company: "Waystar Royco",
      role: "Operations Director",
      status: "interview",
      artifacts: {
        interviewDossier: {
          title: "Waystar interview dossier",
          markdown: "Focus on stakeholder influence and operating cadence.",
        },
      },
    },
  });
  const db = openDb({ repoRoot });
  db.prepare("INSERT INTO deep_ingest_story_bank (id, data) VALUES (?, ?)").run(
    "story-influence",
    JSON.stringify({
      id: "story-influence",
      status: "confirmed",
      title: "Aligned skeptical regional leaders",
      situation: "Regions used conflicting processes.",
      task: "Build one operating cadence.",
      action: "Co-designed a shared review with regional leaders.",
      result: "Adoption reached every region.",
      reflection: "Early co-ownership reduced resistance.",
      supportingQuote: "Adoption reached every region.",
    })
  );
  const calls = [];
  const routes = await boot(repoRoot, {
    callAIImpl: async (options) => {
      calls.push(options);
      if (options.outputName === "chat_first_mock_question") {
        return aiReply({
          question: "Tell me about a time you aligned skeptical stakeholders around a new cadence.",
        });
      }
      return aiReply({
        worked: "You made the stakeholder conflict and your ownership clear.",
        tighten: "Quantify the operating result and shorten the setup.",
        nextQuestion: "How did you decide which operating metric mattered most?",
      });
    },
  });

  const started = await invoke(routes, "POST", "/api/chat-first/mock/start", {
    id: "mock-ai",
    applicationId: "app-mock-ai",
    questionCount: 3,
  });
  assert.equal(started.status, 201);
  assert.equal(started.body.data.session.currentQuestion, 1);
  assert.equal(started.body.data.question.kind, "question");
  assert.match(started.body.data.question.text, /skeptical stakeholders/);
  const startPrompt = JSON.stringify(calls[0].messages);
  assert.match(startPrompt, /Waystar Royco/);
  assert.match(startPrompt, /Operations Director/);
  assert.match(startPrompt, /stakeholder influence and operating cadence/);
  assert.match(startPrompt, /Aligned skeptical regional leaders/);

  const turn = await invoke(routes, "POST", "/api/chat-first/mock/turn", {
    sessionId: "mock-ai",
    text: "I brought the regional leads into a weekly operating review and reached full adoption.",
  });
  assert.equal(turn.status, 200);
  assert.equal(turn.body.data.answer.kind, "answer");
  assert.equal(turn.body.data.feedback.questionNumber, 1);
  assert.match(turn.body.data.feedback.worked, /ownership clear/);
  assert.equal(turn.body.data.question.questionNumber, 2);
  assert.equal(turn.body.data.session.messages.length, 3);
  assert.equal(turn.body.data.session.feedback.length, 1);
  assert.equal(calls[1].outputName, "chat_first_mock_feedback");
});

test("invalid structured mock feedback retains one durable answer and can be retried", async () => {
  const repoRoot = tempRepo();
  appUpsert({
    repoRoot,
    row: { id: "app-mock-invalid", company: "Initech", role: "Manager", status: "interview" },
  });
  let callCount = 0;
  let feedbackValid = false;
  const routes = await boot(repoRoot, {
    callAIImpl: async (options) => {
      callCount += 1;
      if (options.outputName === "chat_first_mock_question") {
        return aiReply({ question: "Tell me about a difficult decision." });
      }
      if (feedbackValid) {
        return aiReply({
          worked: "You named the rollout tradeoff.",
          tighten: "Add the measurable result.",
          nextQuestion: "How did you know the rollout worked?",
        });
      }
      return { content: [{ type: "text", text: "not structured feedback" }] };
    },
  });
  await invoke(routes, "POST", "/api/chat-first/mock/start", {
    id: "mock-invalid",
    applicationId: "app-mock-invalid",
    questionCount: 2,
  });
  const failed = await invoke(routes, "POST", "/api/chat-first/mock/turn", {
    sessionId: "mock-invalid",
    text: "I chose the safer rollout.",
  });
  assert.equal(failed.status, 422);
  assert.equal(failed.body.code, "AI_SCHEMA_INVALID");

  const { chatFirstStateGet } = await import("../src/core/db/verbs.mjs");
  const session = chatFirstStateGet({ repoRoot }).mockSessions[0];
  assert.equal(session.messages.filter((message) => message.kind === "answer").length, 1);
  assert.equal(session.messages.filter((message) => message.kind === "question").length, 1);
  assert.equal(session.feedback.length, 0);
  assert.equal(callCount, 3);

  feedbackValid = true;
  const retried = await invoke(routes, "POST", "/api/chat-first/mock/turn", {
    sessionId: "mock-invalid",
    text: "This retry must reuse the saved answer.",
  });
  assert.equal(retried.status, 200);
  assert.equal(retried.body.data.reusedAnswer, true);
  assert.equal(
    retried.body.data.session.messages.filter((message) => message.kind === "answer").length,
    1
  );
  assert.equal(
    retried.body.data.session.messages.filter((message) => message.kind === "question").length,
    2
  );
  assert.equal(retried.body.data.session.feedback.length, 1);
});
