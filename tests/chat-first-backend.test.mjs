import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

import { closeAll, openDb } from "../src/core/db/connection.mjs";
import { ALL_MIGRATIONS } from "../src/core/db/migrations.mjs";
import {
  appScheduleInterview,
  appSetStatus,
  appUpsert,
  candidateConfigPatch,
  commCaptureInbound,
  commUpsert,
  DEEP_INGEST_REQUIRED_LANES,
  deepIngestLaneSetState,
} from "../src/core/db/verbs.mjs";

const cleanupRoots = [];

function tempRepo() {
  const repoRoot = mkdtempSync(join(tmpdir(), "careerrat-chat-first-backend-"));
  cleanupRoots.push(repoRoot);
  openDb({ repoRoot });
  return repoRoot;
}

after(() => {
  closeAll();
  for (const root of cleanupRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

async function chatFirstApi() {
  const api = await import("../src/core/db/verbs.mjs");
  for (const name of [
    "chatFirstStateGet",
    "deepIngestPromptDismiss",
    "deepIngestThreadOpen",
    "jobThreadMessageAppend",
    "jobThreadSetArchived",
    "jobThreadSetPinned",
    "jobThreadTurn",
    "missionCreate",
    "missionCreateForJobs",
    "missionRun",
    "missionSetStatus",
    "missionStepSetStatus",
    "mockInterviewEnd",
    "mockInterviewFeedbackAppend",
    "mockInterviewMessageAppend",
    "mockInterviewStart",
    "mockInterviewStartWithAI",
    "mockInterviewTurn",
    "sourcedDecisionSet",
    "touchDueDismiss",
  ]) {
    assert.equal(typeof api[name], "function", `${name} must be exported by the DB verbs barrel`);
  }
  return api;
}

function seedApplication(repoRoot, row) {
  appUpsert({
    repoRoot,
    row: {
      id: row.id,
      company: row.company || "Aperture Science",
      role: row.role || "Staff Engineer",
      status: row.status || "applied",
      ...row,
    },
  });
}

test("migration 012 creates durable chat-first thread, mission, and mock interview tables", () => {
  assert.equal(
    ALL_MIGRATIONS.find((migration) => migration.id === 12)?.name,
    "chat-first-workspace"
  );

  const repoRoot = tempRepo();
  const db = openDb({ repoRoot });
  const tables = new Set(
    db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all()
      .map((row) => row.name)
  );
  for (const table of [
    "job_threads",
    "job_thread_messages",
    "missions",
    "mission_steps",
    "mock_interview_sessions",
    "mock_interview_messages",
    "mock_interview_feedback",
  ]) {
    assert.equal(tables.has(table), true, `${table} should exist`);
  }
});

test("chat-first state hydrates durable research threads and their saved or discarded decisions", async () => {
  const api = await import("../src/core/db/verbs.mjs");
  const repoRoot = tempRepo();

  api.skillChatMessageAppend({
    repoRoot,
    skill: "research-company",
    role: "assistant",
    text: "Research ready for review.",
    runtimeSessionId: "runtime-chat-1",
    now: new Date("2026-08-24T15:00:00.000Z"),
  });
  api.skillChatDecisionSet({
    repoRoot,
    skill: "research-company",
    decisionId: "discovery:company:acme",
    action: "save",
    resultText: "Saved research for Acme to your workspace.",
    now: new Date("2026-08-24T15:01:00.000Z"),
  });
  api.skillChatMessageAppend({
    repoRoot,
    skill: "research-comp",
    role: "assistant",
    text: "Benchmark ready for review.",
    runtimeSessionId: "runtime-chat-2",
    now: new Date("2026-08-24T15:02:00.000Z"),
  });
  api.skillChatDecisionSet({
    repoRoot,
    skill: "research-comp",
    decisionId: "discovery:comp:staff-new-york",
    action: "discard",
    resultText: "Discarded the benchmark. Nothing was saved.",
    now: new Date("2026-08-24T15:03:00.000Z"),
  });

  closeAll();
  const state = api.chatFirstStateGet({ repoRoot });
  expectSkillChat(state.skillChats, "research-company", {
    message: "Research ready for review.",
    decisionAction: "save",
  });
  expectSkillChat(state.skillChats, "research-comp", {
    message: "Benchmark ready for review.",
    decisionAction: "discard",
  });
});

test("skill chat persists a binary prompt and resolves typed text once", async () => {
  const api = await import("../src/core/db/verbs.mjs");
  const repoRoot = tempRepo();
  const assistant = api.skillChatMessageAppend({
    repoRoot,
    skill: "ingest-profile",
    role: "assistant",
    text: "Should I keep this role direction?",
    metadata: { answerMode: "yes-no" },
    now: new Date("2026-08-27T16:00:00.000Z"),
  }).message;

  assert.equal(assistant.metadata.answerMode, undefined);
  assert.equal(assistant.metadata.choicePrompt.threadId, "skill:ingest-profile");
  assert.equal(assistant.metadata.choicePrompt.messageId, assistant.id);
  const user = api.skillChatMessageAppend({
    repoRoot,
    skill: "ingest-profile",
    role: "user",
    text: "Nope",
    now: new Date("2026-08-27T16:01:00.000Z"),
  }).message;

  closeAll();
  const reloaded = api.skillChatThreadRead({ repoRoot, skill: "ingest-profile" });
  assert.equal(reloaded.messages[0].metadata.choicePrompt.state, "resolved");
  assert.deepEqual(reloaded.messages[0].metadata.choicePrompt.selectedOptionIds, ["no"]);
  assert.deepEqual(user.metadata.choiceResolution.optionIds, ["no"]);
});

function expectSkillChat(threads, skill, { message, decisionAction }) {
  const thread = threads.find((candidate) => candidate.skill === skill);
  assert.ok(thread, `${skill} thread should be present`);
  assert.equal(thread.messages[0].text, message);
  assert.equal(thread.decisions[0].action, decisionAction);
}

test("deep ingest prompt dismissal is durable and idempotent", async () => {
  const api = await import("../src/core/db/verbs.mjs");
  const repoRoot = tempRepo();

  assert.deepEqual(api.chatFirstStateGet({ repoRoot }).deepIngestPrompt, {
    visible: true,
    dismissed: false,
    completed: false,
    dismissedAt: null,
  });

  const first = api.deepIngestPromptDismiss({
    repoRoot,
    now: new Date("2026-08-23T17:00:00.000Z"),
  });
  assert.equal(first.reused, false);
  assert.deepEqual(first.prompt, {
    visible: false,
    dismissed: true,
    completed: false,
    dismissedAt: "2026-08-23T17:00:00.000Z",
  });

  closeAll();
  assert.deepEqual(api.chatFirstStateGet({ repoRoot }).deepIngestPrompt, first.prompt);
  const replay = api.deepIngestPromptDismiss({
    repoRoot,
    now: new Date("2026-08-24T17:00:00.000Z"),
  });
  assert.equal(replay.reused, true);
  assert.equal(replay.prompt.dismissedAt, "2026-08-23T17:00:00.000Z");
});

test("deep ingest open creates one durable derived thread and reuses it after restart", async () => {
  const api = await import("../src/core/db/verbs.mjs");
  const repoRoot = tempRepo();

  assert.equal(api.chatFirstStateGet({ repoRoot }).deepIngestThread, null);
  const first = api.deepIngestThreadOpen({
    repoRoot,
    now: new Date("2026-08-24T15:00:00.000Z"),
  });
  assert.equal(first.reused, false);
  assert.deepEqual(first.thread, {
    id: "ingest",
    title: "Deep ingest",
    subtitle: "add work history and review grounded evidence",
    startedAt: "2026-08-24T15:00:00.000Z",
  });

  closeAll();
  assert.deepEqual(api.chatFirstStateGet({ repoRoot }).deepIngestThread, first.thread);
  const replay = api.deepIngestThreadOpen({
    repoRoot,
    now: new Date("2026-08-24T16:00:00.000Z"),
  });
  assert.equal(replay.reused, true);
  assert.deepEqual(replay.thread, first.thread);
});

test("saved Deep ingest state earns the same thread without a separate open write", async () => {
  const api = await import("../src/core/db/verbs.mjs");
  const repoRoot = tempRepo();
  api.deepIngestSourceCreate({
    repoRoot,
    input: {
      sourceKind: "paste",
      targetShape: "auto",
      text: "Led a platform migration and cut deploy time in half.",
      createdAt: "2026-08-24T15:30:00.000Z",
      updatedAt: "2026-08-24T15:30:00.000Z",
    },
  });

  assert.deepEqual(api.chatFirstStateGet({ repoRoot }).deepIngestThread, {
    id: "ingest",
    title: "Deep ingest",
    subtitle: "add work history and review grounded evidence",
    startedAt: "2026-08-24T15:30:00.000Z",
  });
});

test("deep ingest completion hides an undismissed prompt from canonical lane state", async () => {
  const api = await import("../src/core/db/verbs.mjs");
  const repoRoot = tempRepo();

  for (const lane of DEEP_INGEST_REQUIRED_LANES) {
    deepIngestLaneSetState({ repoRoot, lane, status: "completed" });
  }

  assert.deepEqual(api.chatFirstStateGet({ repoRoot }).deepIngestPrompt, {
    visible: false,
    dismissed: false,
    completed: true,
    dismissedAt: null,
  });
});

test("an inbound human or scheduled interview earns a durable job thread, while applying alone does not", async () => {
  const api = await chatFirstApi();
  const repoRoot = tempRepo();
  seedApplication(repoRoot, { id: "app-applied", company: "Applied Only" });
  seedApplication(repoRoot, { id: "app-inbound", company: "Inbound Corp" });
  seedApplication(repoRoot, { id: "app-interview", company: "Interview Corp" });

  commCaptureInbound({
    repoRoot,
    applicationId: "app-inbound",
    company: "Inbound Corp",
    role: "Staff Engineer",
    summary: "The recruiter asked to schedule a call.",
    sourceId: "mail-1",
    at: "2026-08-23T15:00:00.000Z",
  });
  appScheduleInterview({
    repoRoot,
    id: "app-interview",
    at: "2026-08-28T14:00:00.000Z",
    round: "recruiter screen",
  });

  const state = api.chatFirstStateGet({
    repoRoot,
    now: new Date("2026-08-23T16:00:00.000Z"),
  });
  const byApp = Object.fromEntries(
    state.jobThreads.map((thread) => [thread.applicationId, thread])
  );
  assert.equal(byApp["app-applied"], undefined, "applying must not create a job conversation");
  assert.deepEqual(byApp["app-inbound"].earnedBy, ["human-entered"]);
  assert.deepEqual(byApp["app-interview"].earnedBy, ["human-entered"]);

  closeAll();
  const reopened = api.chatFirstStateGet({ repoRoot });
  assert.deepEqual(reopened.jobThreads.map((thread) => thread.applicationId).sort(), [
    "app-inbound",
    "app-interview",
  ]);
});

test("pinning, messaging, and manual archive state survive restart without copying job lifecycle facts", async () => {
  const api = await chatFirstApi();
  const repoRoot = tempRepo();
  seedApplication(repoRoot, {
    id: "app-pinned",
    company: "Tyrell Corp",
    status: "offer",
    location: "New York, NY",
    mode: "hybrid",
  });

  api.jobThreadSetPinned({
    repoRoot,
    applicationId: "app-pinned",
    pinned: true,
    now: new Date("2026-08-23T16:00:00.000Z"),
  });
  api.jobThreadMessageAppend({
    repoRoot,
    applicationId: "app-pinned",
    role: "user",
    text: "Coach me through the offer call.",
    metadata: { state: "reviewable" },
    artifacts: [{ kind: "screening_answers", title: "Offer answers" }],
    now: new Date("2026-08-23T16:01:00.000Z"),
  });
  api.jobThreadSetArchived({
    repoRoot,
    applicationId: "app-pinned",
    archived: true,
    now: new Date("2026-08-23T16:02:00.000Z"),
  });

  closeAll();
  const state = api.chatFirstStateGet({ repoRoot });
  const thread = state.jobThreads.find((row) => row.applicationId === "app-pinned");
  assert.equal(thread.pinned, true);
  assert.equal(thread.archived, true);
  assert.equal(thread.archiveReason, "user");
  assert.equal(thread.messages.length, 1);
  assert.equal(thread.messages[0].text, "Coach me through the offer call.");
  assert.equal(thread.location, "New York, NY");
  assert.equal(thread.mode, "hybrid");
  assert.deepEqual(thread.messages[0].metadata, { state: "reviewable" });
  assert.deepEqual(thread.messages[0].artifacts, [
    { kind: "screening_answers", title: "Offer answers" },
  ]);

  const db = openDb({ repoRoot });
  const stored = JSON.parse(
    db.prepare("SELECT data FROM job_threads WHERE application_id = ?").get("app-pinned").data
  );
  assert.equal(stored.archiveEligible, undefined);
  assert.equal(stored.touchDue, undefined);
});

test("job threads expose live packet gaps without leaking the packet manifest", async () => {
  const api = await chatFirstApi();
  const repoRoot = tempRepo();
  seedApplication(repoRoot, {
    id: "app-packet-review",
    company: "Hightouch",
    status: "reviewed-hold",
    packetManifest: {
      applicationId: "app-packet-review",
      status: "reviewable",
      uploadReady: false,
      gapCount: 2,
      artifacts: { answersSource: "workspace/private-answer-path.md" },
      gaps: [
        {
          kind: "answers",
          code: "ANSWER_CONFIRMATION_REQUIRED",
          questionId: "linkedin-profile",
          message: "Answer “LinkedIn Profile”.",
        },
        {
          kind: "answers",
          code: "ANSWER_CONFIRMATION_REQUIRED",
          questionId: "north-america",
          message: "Answer “Are you currently located in North America?”.",
        },
      ],
    },
  });
  api.jobThreadSetPinned({ repoRoot, applicationId: "app-packet-review" });

  const thread = api
    .chatFirstStateGet({ repoRoot })
    .jobThreads.find((row) => row.applicationId === "app-packet-review");

  assert.deepEqual(thread.packetReview, {
    status: "reviewable",
    uploadReady: false,
    gapCount: 2,
    canResume: false,
    gaps: [
      {
        id: "linkedin-profile",
        questionId: "linkedin-profile",
        kind: "answers",
        code: "ANSWER_CONFIRMATION_REQUIRED",
        label: "LinkedIn Profile",
        message: "Answer “LinkedIn Profile”.",
        answerable: true,
      },
      {
        id: "north-america",
        questionId: "north-america",
        kind: "answers",
        code: "ANSWER_CONFIRMATION_REQUIRED",
        label: "Are you currently located in North America?",
        message: "Answer “Are you currently located in North America?”.",
        answerable: true,
      },
    ],
  });
  assert.equal(JSON.stringify(thread.packetReview).includes("private-answer-path"), false);
});

test("job threads expose deferred question capture as form preparation, not a candidate question", async () => {
  const api = await chatFirstApi();
  const repoRoot = tempRepo();
  seedApplication(repoRoot, {
    id: "app-question-capture",
    company: "Hightouch",
    status: "reviewed-hold",
    packetManifest: {
      applicationId: "app-question-capture",
      status: "upload-ready",
      uploadReady: true,
      gapCount: 1,
      gaps: [
        {
          kind: "answers",
          code: "QUESTION_CAPTURE_DEFERRED",
          message:
            "answers artifact skipped: no application questions captured yet; capture the form questions (packet questions step), then regenerate, to produce answers",
        },
      ],
    },
  });
  api.jobThreadSetPinned({ repoRoot, applicationId: "app-question-capture" });

  const thread = api
    .chatFirstStateGet({ repoRoot })
    .jobThreads.find((row) => row.applicationId === "app-question-capture");

  assert.deepEqual(thread.packetReview, {
    status: "upload-ready",
    uploadReady: true,
    gapCount: 0,
    canResume: false,
    canPrepare: true,
    questionCaptureRequired: true,
    questionCaptureMessage:
      "Open and prepare the application form so CareerRat can discover its questions.",
    gaps: [],
  });
  assert.equal(JSON.stringify(thread.packetReview).includes("answers artifact skipped"), false);
  assert.equal(JSON.stringify(thread.packetReview).includes("packet questions step"), false);
});

test("scanner rows preserve whether the saved job description is partial", async () => {
  const { sourcedRowsFromScanOffers } = await import("../src/core/scoring/sourced-persistence.mjs");
  const rows = sourcedRowsFromScanOffers([
    {
      company: "Partial Co",
      title: "Platform Engineer",
      url: "https://jobs.example.test/partial",
      bodyText: "Only the visible excerpt was available.",
      bodyPartial: true,
    },
    {
      company: "Complete Co",
      title: "Staff Engineer",
      url: "https://jobs.example.test/complete",
      bodyText: "The complete job description was captured.",
      bodyPartial: false,
    },
  ]);

  assert.equal(rows[0].scanner.bodyPartial, true);
  assert.equal(rows[1].scanner.bodyPartial, false);
});

test("promoted scanner facts reach job threads and their AI context", async () => {
  const api = await chatFirstApi();
  const repoRoot = tempRepo();
  const { sourcedPromote, sourcedUpsertBatch } = await import("../src/core/db/verbs.mjs");
  const { sourcedRowsFromScanOffers } = await import("../src/core/scoring/sourced-persistence.mjs");
  const [row] = sourcedRowsFromScanOffers(
    [
      {
        company: "Scanner Facts Corp",
        title: "Staff JavaScript Engineer",
        url: "https://jobs.example.test/scanner-facts",
        location: "Remote - United States",
        comp: "$185,000 - $215,000",
        fit: "high",
        score: 91,
      },
    ],
    "2026-08-24T15:00:00.000Z"
  );
  sourcedUpsertBatch({ repoRoot, rows: [row] });
  sourcedPromote({ repoRoot, id: row.id });
  api.jobThreadMessageAppend({
    repoRoot,
    applicationId: row.id,
    role: "user",
    text: "What should I know about this job?",
  });

  const thread = api
    .chatFirstStateGet({ repoRoot })
    .jobThreads.find((item) => item.applicationId === row.id);
  assert.equal(thread.location, "Remote - United States");
  assert.equal(thread.mode, "remote");
  assert.equal(thread.comp, "$185,000 - $215,000");

  let request;
  await api.jobThreadTurn({
    repoRoot,
    applicationId: row.id,
    text: "Does the location and compensation fit?",
    call: async (options) => {
      request = options;
      return {
        content: [{ type: "text", text: JSON.stringify({ reply: "Yes.", answerMode: null }) }],
      };
    },
  });
  const application = JSON.parse(request.messages[0].content).canonicalContext.application;
  assert.match(request.system, /natural, conversational plain English/i);
  assert.match(request.system, /short, direct sentences/i);
  assert.match(request.system, /raw JSON/i);
  assert.match(request.system, /tool narration/i);
  assert.equal(request.aiOperation, "paul.conversation");
  assert.equal(request.tier, undefined);
  assert.equal(application.location, "Remote - United States");
  assert.equal(application.mode, "remote");
  assert.equal(application.compensation, "$185,000 - $215,000");
});

test("earned job threads project canonical conversations and communications without storing copies", async () => {
  const api = await chatFirstApi();
  const repoRoot = tempRepo();
  const conversation = {
    kind: "hiring manager",
    at: "2026-08-22T14:00:00.000Z",
    notes: "Discussed the platform migration and the next technical round.",
  };
  seedApplication(repoRoot, {
    id: "app-thread-projection",
    company: "Projection Corp",
    conversations: [conversation],
  });
  const communication = {
    id: "comm-thread-projection",
    applicationId: "app-thread-projection",
    company: "Projection Corp",
    role: "Staff Engineer",
    channel: "email",
    status: "waiting",
    summary: "Recruiter confirmed the technical round.",
    messages: [
      {
        direction: "inbound",
        at: "2026-08-22T15:00:00.000Z",
        body: "The technical round is confirmed for Friday.",
      },
    ],
  };
  commUpsert({ repoRoot, row: communication });
  api.jobThreadSetPinned({ repoRoot, applicationId: "app-thread-projection" });

  const thread = api
    .chatFirstStateGet({ repoRoot })
    .jobThreads.find((row) => row.applicationId === "app-thread-projection");
  assert.deepEqual(thread.conversations, [conversation]);
  assert.deepEqual(thread.communications, [communication]);

  const db = openDb({ repoRoot });
  const stored = JSON.parse(
    db.prepare("SELECT data FROM job_threads WHERE application_id = ?").get("app-thread-projection")
      .data
  );
  assert.equal(stored.conversations, undefined);
  assert.equal(stored.communications, undefined);
});

test("job-thread turns persist and hydrate one resolved binary choice", async () => {
  const api = await chatFirstApi();
  const repoRoot = tempRepo();
  seedApplication(repoRoot, {
    id: "app-binary-question",
    company: "Binary Corp",
  });

  const result = await api.jobThreadTurn({
    repoRoot,
    applicationId: "app-binary-question",
    text: "Check whether you need permission.",
    call: async () => ({
      content: [
        {
          type: "text",
          text: JSON.stringify({
            reply: "Should I draft the recruiter reply now?",
            answerMode: "yes-no",
          }),
        },
      ],
    }),
  });

  assert.equal(result.assistantMessage.text, "Should I draft the recruiter reply now?");
  const prompt = result.assistantMessage.metadata.choicePrompt;
  assert.equal(result.assistantMessage.metadata.answerMode, undefined);
  assert.equal(prompt.threadId, "job:app-binary-question");
  assert.equal(prompt.messageId, result.assistantMessage.id);
  assert.equal(prompt.state, "pending");

  await api.jobThreadTurn({
    repoRoot,
    applicationId: "app-binary-question",
    text: "Yes",
    call: async () => ({
      content: [
        { type: "text", text: JSON.stringify({ reply: "I’ll draft it.", answerMode: null }) },
      ],
    }),
  });

  closeAll();
  const hydrated = api.chatFirstStateGet({ repoRoot });
  const thread = hydrated.jobThreads.find(
    (candidate) => candidate.applicationId === "app-binary-question"
  );
  const question = thread.messages.find((message) => message.id === result.assistantMessage.id);
  const answer = thread.messages.find(
    (message) => message.metadata?.choiceResolution?.promptId === prompt.id
  );
  assert.equal(question.metadata.choicePrompt.state, "resolved");
  assert.deepEqual(question.metadata.choicePrompt.selectedOptionIds, ["yes"]);
  assert.deepEqual(answer.metadata.choiceResolution.optionIds, ["yes"]);
});

test("unpinning an application that never earned a conversation does not create one", async () => {
  const api = await chatFirstApi();
  const repoRoot = tempRepo();
  seedApplication(repoRoot, {
    id: "app-never-threaded",
    company: "No Thread Corp",
  });
  assert.throws(
    () =>
      api.jobThreadSetPinned({
        repoRoot,
        applicationId: "app-never-threaded",
        pinned: false,
      }),
    /no job thread/
  );
  assert.deepEqual(api.chatFirstStateGet({ repoRoot }).jobThreads, []);
});

test("job-thread turns retain authoritative messages and advance an exact rolling checkpoint boundary", async () => {
  const api = await chatFirstApi();
  const repoRoot = tempRepo();
  seedApplication(repoRoot, {
    id: "app-checkpoint",
    company: "Checkpoint Corp",
  });
  for (let index = 1; index <= 18; index += 1) {
    api.jobThreadMessageAppend({
      repoRoot,
      applicationId: "app-checkpoint",
      role: index % 2 ? "user" : "assistant",
      text: `historical message ${index}`,
    });
  }
  let request;
  const result = await api.jobThreadTurn({
    repoRoot,
    applicationId: "app-checkpoint",
    text: "What should I do next?",
    call: async (options) => {
      request = options;
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({ reply: "Prepare the screen examples.", answerMode: null }),
          },
        ],
      };
    },
  });

  assert.equal(result.thread.messages.length, 20);
  assert.equal(result.thread.checkpoint.throughSequence, 8);
  assert.match(result.thread.checkpoint.summary, /historical message 8/);
  const context = JSON.parse(request.messages[0].content).canonicalContext.thread;
  assert.equal(context.checkpoint.throughSequence, 7);
  assert.equal(context.messages[0].sequence, 8);
  closeAll();
  const restarted = api
    .chatFirstStateGet({ repoRoot })
    .jobThreads.find((thread) => thread.applicationId === "app-checkpoint");
  assert.equal(restarted.messages.length, 20);
  assert.equal(restarted.checkpoint.throughSequence, 8);
});

test("rolling checkpoints keep an early durable decision after later prose exceeds the summary budget", async () => {
  const api = await chatFirstApi();
  const repoRoot = tempRepo();
  seedApplication(repoRoot, { id: "app-decision", company: "Decision Corp" });
  api.jobThreadMessageAppend({
    repoRoot,
    applicationId: "app-decision",
    role: "user",
    text: "Decision: I will not relocate from Boston for this role.",
  });
  for (let index = 2; index <= 48; index += 1) {
    api.jobThreadMessageAppend({
      repoRoot,
      applicationId: "app-decision",
      role: index % 2 ? "user" : "assistant",
      text: `background ${index} ${"filler ".repeat(100)}`,
    });
  }

  let request;
  await api.jobThreadTurn({
    repoRoot,
    applicationId: "app-decision",
    text: "What constraint should I keep in mind?",
    call: async (options) => {
      request = options;
      return {
        content: [
          { type: "text", text: JSON.stringify({ reply: "Stay in Boston.", answerMode: null }) },
        ],
      };
    },
  });

  const serialized = request.messages[0].content;
  assert.match(serialized, /will not relocate from Boston/);
});

test("bounded job-thread context allowlists professional facts and redacts contact, secret, link, path, and current-comp prose", async () => {
  const api = await chatFirstApi();
  const repoRoot = tempRepo();
  seedApplication(repoRoot, {
    id: "app-private-context",
    company: "Privacy Corp",
    role: "Platform Engineer",
    statusNote: "Email me at private@example.test or call 212-555-0188",
  });
  const db = openDb({ repoRoot });
  db.prepare("INSERT INTO candidate_profile (id, data) VALUES (1, ?)").run(
    JSON.stringify({
      name: "Private Person",
      email: "profile@example.test",
      phone: "+1 646 555 0102",
      headline: "Platform leader",
      summary: "I currently make $230,000 and keep notes at /Users/private/candidate.md",
      api_key: "super-secret-value",
    })
  );
  db.prepare("INSERT INTO candidate_targeting (id, data) VALUES (1, ?)").run(
    JSON.stringify({
      role_buckets: [{ name: "Platform Engineering" }],
      home_coordinates: { latitude: 40.7, longitude: -74.0 },
      notes: "Book me at https://calendly.com/private-person/interview",
    })
  );
  commUpsert({
    repoRoot,
    row: {
      id: "comm-private-context",
      applicationId: "app-private-context",
      company: "Privacy Corp",
      role: "Platform Engineer",
      channel: "email",
      status: "waiting",
      summary: "Recruiter secret@example.test said current salary is 200k.",
      participants: [{ name: "Private Recruiter", email: "recruiter@example.test" }],
      messages: [],
    },
  });

  let request;
  await api.jobThreadTurn({
    repoRoot,
    applicationId: "app-private-context",
    text: "Use my Platform Engineering background, not api_key=another-secret.",
    call: async (options) => {
      request = options;
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({ reply: "Use the platform example.", answerMode: null }),
          },
        ],
      };
    },
  });

  const serialized = request.messages[0].content;
  assert.match(serialized, /Privacy Corp/);
  assert.match(serialized, /Platform Engineering/);
  for (const privateValue of [
    "private@example.test",
    "profile@example.test",
    "secret@example.test",
    "recruiter@example.test",
    "212-555-0188",
    "646 555 0102",
    "230,000",
    "200k",
    "calendly.com",
    "/Users/private",
    "super-secret-value",
    "another-secret",
    "home_coordinates",
    "participants",
  ]) {
    assert.equal(serialized.includes(privateValue), false, `AI context leaked ${privateValue}`);
  }
});

test("job-thread candidate context includes worldwide remote scope without widening local modes", async () => {
  const api = await chatFirstApi();
  const repoRoot = tempRepo();
  seedApplication(repoRoot, {
    id: "app-location-scope",
    company: "Scope Corp",
  });
  candidateConfigPatch({
    repoRoot,
    name: "profile",
    patch: {
      location: {
        home: "New York, NY",
        remote: true,
        remote_scope: "worldwide",
        hybrid: true,
        onsite: true,
        relocation: [],
      },
    },
  });

  let request;
  await api.jobThreadTurn({
    repoRoot,
    applicationId: "app-location-scope",
    text: "Where can I work?",
    call: async (options) => {
      request = options;
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({ reply: "Worldwide remote.", answerMode: null }),
          },
        ],
      };
    },
  });

  const serialized = request.messages[0].content;
  assert.match(serialized, /"remoteScope":"worldwide"/);
  assert.match(serialized, /"home":"New York, NY"/);
  assert.match(serialized, /"hybrid":true/);
  assert.match(serialized, /"onsite":true/);
});

test("job-thread AI context includes redacted recent inbound and draft communication bodies", async () => {
  const api = await chatFirstApi();
  const repoRoot = tempRepo();
  seedApplication(repoRoot, {
    id: "app-recent-comms",
    company: "Recent Comms Corp",
  });
  commUpsert({
    repoRoot,
    row: {
      id: "comm-recent-comms",
      applicationId: "app-recent-comms",
      company: "Recent Comms Corp",
      role: "Staff Engineer",
      channel: "email",
      status: "drafted",
      summary: "Interview scheduling is in progress.",
      draft: {
        subject: "Re: interview",
        body: "Tuesday works for me. api_key=do-not-leak and I currently make $230k.",
      },
      messages: [
        {
          direction: "inbound",
          at: "2026-08-23T14:00:00.000Z",
          body: "The panel is Tuesday. Reply to recruiter@example.test or call 212-555-0188.",
        },
      ],
    },
  });

  let request;
  await api.jobThreadTurn({
    repoRoot,
    applicationId: "app-recent-comms",
    text: "What should I send?",
    call: async (options) => {
      request = options;
      return {
        content: [
          { type: "text", text: JSON.stringify({ reply: "Confirm Tuesday.", answerMode: null }) },
        ],
      };
    },
  });

  const serialized = request.messages[0].content;
  assert.match(serialized, /The panel is Tuesday/);
  assert.match(serialized, /Tuesday works for me/);
  assert.match(serialized, /\[contact removed\]/);
  assert.match(serialized, /\[secret removed\]/);
  assert.match(serialized, /\[private compensation removed\]/);
  for (const privateValue of ["recruiter@example.test", "212-555-0188", "do-not-leak", "$230k"]) {
    assert.equal(serialized.includes(privateValue), false, `AI context leaked ${privateValue}`);
  }
});

test("compound job-thread turns treat a committed compatibility-export failure as success without duplicate or false-error messages", async () => {
  const api = await chatFirstApi();
  const repoRoot = tempRepo();
  seedApplication(repoRoot, {
    id: "app-export-failure",
    company: "Canonical DB Corp",
  });
  rmSync(join(repoRoot, "workspace", "tracker.json"), { force: true });
  mkdirSync(join(repoRoot, "workspace", "tracker.json"), { recursive: true });

  let calls = 0;
  const result = await api.jobThreadTurn({
    repoRoot,
    applicationId: "app-export-failure",
    text: "Save this exactly once.",
    call: async () => {
      calls += 1;
      return {
        content: [
          { type: "text", text: JSON.stringify({ reply: "Saved once.", answerMode: null }) },
        ],
      };
    },
  });

  assert.equal(calls, 1);
  assert.deepEqual(
    result.thread.messages.map((message) => [message.role, message.kind, message.text]),
    [
      ["user", "text", "Save this exactly once."],
      ["assistant", "text", "Saved once."],
    ]
  );
});

test("closed-job archive state and touch-due people are derived from application and communication data", async () => {
  const api = await chatFirstApi();
  const repoRoot = tempRepo();
  seedApplication(repoRoot, {
    id: "app-closed",
    company: "Initrode",
    status: "interview",
    nextAction: "Nudge William Bell",
    nextActionDue: "2026-08-22",
  });
  api.jobThreadSetPinned({
    repoRoot,
    applicationId: "app-closed",
    pinned: true,
  });
  commUpsert({
    repoRoot,
    row: {
      id: "comm-touch",
      applicationId: "app-closed",
      company: "Initrode",
      role: "Staff Engineer",
      status: "waiting",
      channel: "email",
      nextAction: "Nudge William Bell",
      nextActionDue: "2026-08-22",
      participants: [{ name: "William Bell", role: "Recruiter" }],
      messages: [],
    },
  });
  appSetStatus({ repoRoot, id: "app-closed", to: "rejected" });

  const state = api.chatFirstStateGet({
    repoRoot,
    now: new Date("2026-08-23T16:00:00.000Z"),
  });
  const thread = state.jobThreads.find((row) => row.applicationId === "app-closed");
  assert.equal(thread.archiveEligible, true);
  assert.equal(thread.archived, true);
  assert.equal(thread.archiveReason, "job-closed");
  assert.deepEqual(state.touchDue, [
    {
      id: "comm-touch",
      applicationId: "app-closed",
      company: "Initrode",
      name: "William Bell",
      role: "Recruiter",
      dueAt: "2026-08-22",
      nextAction: "Nudge William Bell",
      source: "communication",
    },
  ]);
  assert.equal(
    state.needsYou.some(
      (item) => item.kind === "application-next-action" && item.applicationId === "app-closed"
    ),
    false,
    "a closed job's stale application next action is not actionable"
  );
});

test("touch-due dismissal clears the canonical owner, keeps an audit receipt, and is idempotent for communication and application sources", async () => {
  const api = await chatFirstApi();
  const repoRoot = tempRepo();
  seedApplication(repoRoot, {
    id: "app-touch-dismiss",
    company: "Touch Corp",
    nextAction: "Follow up with the hiring manager",
    nextActionDue: "2026-08-20",
  });
  commUpsert({
    repoRoot,
    row: {
      id: "comm-touch-dismiss",
      applicationId: "app-touch-dismiss",
      company: "Touch Corp",
      role: "Staff Engineer",
      status: "waiting",
      channel: "email",
      nextAction: "Nudge the recruiter",
      nextActionDue: "2026-08-21",
      participants: [{ name: "Recruiter", role: "Recruiter" }],
      messages: [],
    },
  });
  const db = openDb({ repoRoot });
  db.prepare("INSERT INTO kv (key, data) VALUES ('relationshipLeads', ?)").run(
    JSON.stringify([
      {
        id: "lead-touch-dismiss",
        applicationId: "app-touch-dismiss",
        company: "Touch Corp",
        name: "Hiring Manager",
        type: "Hiring manager",
        status: "identified",
      },
    ])
  );

  const now = new Date("2026-08-23T16:00:00.000Z");
  const communication = api.touchDueDismiss({
    repoRoot,
    id: "comm-touch-dismiss",
    source: "communication",
    now,
  });
  assert.equal(communication.reused, false);
  assert.equal(communication.dismissal.previousDueAt, "2026-08-21");
  assert.deepEqual(
    communication.state.touchDue.map((item) => [item.id, item.source]),
    [["application:app-touch-dismiss", "application"]]
  );
  const storedCommunication = JSON.parse(
    db.prepare("SELECT data FROM communications WHERE id = ?").get("comm-touch-dismiss").data
  );
  assert.equal(storedCommunication.nextActionDue, null);
  assert.equal(storedCommunication.chatFirstTouchDismissals.length, 1);
  assert.equal(communication.event.operation, "touch-due:dismiss");

  const eventCount = db.prepare("SELECT count(*) AS count FROM activity_events").get().count;
  const metaVersion = communication.meta.version;
  const repeated = api.touchDueDismiss({
    repoRoot,
    id: "comm-touch-dismiss",
    source: "communication",
    now,
  });
  assert.equal(repeated.reused, true);
  assert.equal(repeated.meta, null);
  assert.equal(db.prepare("SELECT count(*) AS count FROM activity_events").get().count, eventCount);
  assert.equal(
    db.prepare("SELECT version FROM meta WHERE id = 1").get().version,
    metaVersion,
    "an idempotent repeat must not bump canonical freshness"
  );

  const storedApplicationBefore = JSON.parse(
    db.prepare("SELECT data FROM applications WHERE id = ?").get("app-touch-dismiss").data
  );
  assert.equal(storedApplicationBefore.nextActionDue, "2026-08-20");
  const application = api.touchDueDismiss({
    repoRoot,
    id: "application:app-touch-dismiss",
    source: "application",
    now,
  });
  assert.equal(application.reused, false);
  assert.deepEqual(application.state.touchDue, []);
  const storedApplication = JSON.parse(
    db.prepare("SELECT data FROM applications WHERE id = ?").get("app-touch-dismiss").data
  );
  assert.equal(storedApplication.nextActionDue, null);
  assert.equal(storedApplication.chatFirstTouchDismissals.length, 1);

  assert.throws(
    () =>
      api.touchDueDismiss({
        repoRoot,
        id: "application:missing",
        source: "communication",
        now,
      }),
    (error) => error?.code === "NOT_FOUND"
  );
});

test("aggregate state exposes configured agent name and typed stable needs-you owners and actions", async () => {
  const api = await chatFirstApi();
  const repoRoot = tempRepo();
  const { sourcedUpsertBatch } = await import("../src/core/db/verbs.mjs");
  sourcedUpsertBatch({
    repoRoot,
    rows: [
      {
        id: "source-needs",
        company: "Needs Corp",
        role: "Platform Engineer",
        status: "sourced",
        deadline: "2026-08-30T18:00:00.000Z",
      },
    ],
  });
  seedApplication(repoRoot, {
    id: "app-needs",
    company: "Action Corp",
    nextAction: "Review the hiring manager prep packet",
    nextActionDue: "2026-08-30",
  });
  commUpsert({
    repoRoot,
    row: {
      id: "comm-needs",
      applicationId: "app-needs",
      company: "Action Corp",
      role: "Staff Engineer",
      channel: "email",
      status: "waiting",
      nextAction: "Follow up with the recruiter",
      nextActionDue: "2026-08-22",
      participants: [{ name: "Alex Recruiter", role: "Recruiter" }],
      messages: [],
    },
  });
  candidateConfigPatch({
    repoRoot,
    name: "modes",
    patch: { agent_name: "Scout" },
  });

  const state = api.chatFirstStateGet({
    repoRoot,
    now: new Date("2026-08-23T16:00:00.000Z"),
  });
  assert.equal(state.agentName, "Scout");

  const sourced = state.needsYou.find((item) => item.id === "sourced:source-needs:decision");
  assert.equal(sourced.kind, "sourced-decision");
  assert.deepEqual(sourced.owner, { type: "sourced", id: "source-needs" });
  assert.deepEqual(
    sourced.actions.map((action) => [action.id, action.method, action.path, action.body]),
    [
      [
        "apply",
        "POST",
        "/api/chat-first/sourced/decision",
        { id: "source-needs", decision: "apply", mode: "prepare-to-submit" },
      ],
      [
        "skip",
        "POST",
        "/api/chat-first/sourced/decision",
        { id: "source-needs", decision: "skip" },
      ],
    ]
  );
  assert.equal(sourced.deadline, "2026-08-30T18:00:00.000Z");

  const application = state.needsYou.find(
    (item) => item.id === "application:app-needs:next-action"
  );
  assert.equal(application.kind, "application-next-action");
  assert.deepEqual(application.owner, {
    type: "application",
    id: "app-needs",
    applicationId: "app-needs",
  });
  assert.equal(application.action.kind, "open-owner");

  const touch = state.needsYou.find((item) => item.id === "touch:communication:comm-needs");
  assert.equal(touch.kind, "touch-due");
  assert.deepEqual(touch.owner, {
    type: "communication",
    id: "comm-needs",
    applicationId: "app-needs",
  });
  assert.deepEqual(touch.actions.at(-1), {
    id: "dismiss",
    label: "Skip",
    kind: "api",
    method: "POST",
    path: "/api/chat-first/touch-due/dismiss",
    body: { id: "comm-needs", source: "communication" },
  });
});

test("application touch-due metadata points to the canonical application owner id", async () => {
  const api = await chatFirstApi();
  const repoRoot = tempRepo();
  seedApplication(repoRoot, {
    id: "app-touch-owner",
    company: "Touch Owner Corp",
    nextAction: "Follow up with the hiring manager",
    nextActionDue: "2026-08-22",
  });
  const db = openDb({ repoRoot });
  db.prepare("INSERT INTO kv (key, data) VALUES ('relationshipLeads', ?)").run(
    JSON.stringify([
      {
        id: "lead-touch-owner",
        applicationId: "app-touch-owner",
        company: "Touch Owner Corp",
        name: "Hiring Manager",
        type: "Hiring manager",
        status: "identified",
      },
    ])
  );

  const touch = api
    .chatFirstStateGet({ repoRoot, now: new Date("2026-08-23T16:00:00.000Z") })
    .needsYou.find((item) => item.kind === "touch-due");
  assert.equal(touch.touchId, "application:app-touch-owner");
  assert.deepEqual(touch.owner, {
    type: "application",
    id: "app-touch-owner",
    applicationId: "app-touch-owner",
  });
});

test("sourced decisions skip and restore idempotently while apply creates one no-submit mission", async () => {
  const api = await chatFirstApi();
  const repoRoot = tempRepo();
  const { sourcedUpsertBatch } = await import("../src/core/db/verbs.mjs");
  sourcedUpsertBatch({
    repoRoot,
    rows: [
      {
        id: "source-decision",
        company: "Decision Source Corp",
        role: "Backend Engineer",
        status: "sourced",
      },
    ],
  });

  const skipped = api.sourcedDecisionSet({
    repoRoot,
    id: "source-decision",
    decision: "skip",
  });
  assert.equal(skipped.reused, false);
  assert.equal(skipped.row.status, "cut");
  assert.equal(
    skipped.state.needsYou.some((item) => item.id === "sourced:source-decision:decision"),
    false
  );
  const db = openDb({ repoRoot });
  const versionAfterSkip = db.prepare("SELECT version FROM meta WHERE id = 1").get().version;
  const repeatedSkip = api.sourcedDecisionSet({
    repoRoot,
    id: "source-decision",
    decision: "skip",
  });
  assert.equal(repeatedSkip.reused, true);
  assert.equal(repeatedSkip.meta, null);
  assert.equal(db.prepare("SELECT version FROM meta WHERE id = 1").get().version, versionAfterSkip);

  const restored = api.sourcedDecisionSet({
    repoRoot,
    id: "source-decision",
    decision: "restore",
  });
  assert.equal(restored.row.status, "sourced");
  assert.equal(
    restored.state.needsYou.some((item) => item.id === "sourced:source-decision:decision"),
    true
  );

  const applied = api.sourcedDecisionSet({
    repoRoot,
    id: "source-decision",
    decision: "apply",
  });
  assert.equal(applied.reused, false);
  assert.equal(applied.mission.mode, "prepare-to-submit");
  assert.deepEqual(
    applied.mission.metadata.jobs.map((job) => [job.type, job.id]),
    [["sourced", "source-decision"]]
  );
  assert.equal(
    applied.mission.steps.some((step) => step.action === "submit-gate"),
    true
  );
  assert.equal(
    applied.mission.steps.some((step) => step.action === "submit"),
    false
  );
  const repeatedApply = api.sourcedDecisionSet({
    repoRoot,
    id: "source-decision",
    decision: "apply",
  });
  assert.equal(repeatedApply.reused, true);
  assert.equal(repeatedApply.mission.id, applied.mission.id);
  assert.equal(api.chatFirstStateGet({ repoRoot }).missions.length, 1);
});

test("a new human inbound reopens a manually archived active-job conversation", async () => {
  const api = await chatFirstApi();
  const repoRoot = tempRepo();
  seedApplication(repoRoot, { id: "app-reopen", company: "Massive Dynamic" });
  api.jobThreadSetPinned({ repoRoot, applicationId: "app-reopen" });
  api.jobThreadSetArchived({
    repoRoot,
    applicationId: "app-reopen",
    archived: true,
  });
  commCaptureInbound({
    repoRoot,
    applicationId: "app-reopen",
    company: "Massive Dynamic",
    role: "Staff Engineer",
    summary: "The recruiter replied with next steps.",
    sourceId: "mail-reopen",
  });

  const thread = api
    .chatFirstStateGet({ repoRoot })
    .jobThreads.find((row) => row.applicationId === "app-reopen");
  assert.equal(thread.archived, false);
  assert.equal(thread.status, "active");
});

test("missions durably track run steps and enforce pause, resume, and terminal state transitions", async () => {
  const api = await chatFirstApi();
  const repoRoot = tempRepo();
  const created = api.missionCreate({
    repoRoot,
    id: "mission-apply-2",
    title: "Apply to 2 roles",
    steps: [
      { id: "evaluate", label: "Evaluate both roles" },
      { id: "packet", label: "Draft both packets" },
    ],
    now: new Date("2026-08-23T16:00:00.000Z"),
  });
  assert.equal(created.mission.status, "running");
  assert.deepEqual(
    created.mission.steps.map((step) => step.status),
    ["pending", "pending"]
  );

  api.missionStepSetStatus({
    repoRoot,
    missionId: "mission-apply-2",
    stepId: "evaluate",
    status: "running",
  });
  api.missionSetStatus({ repoRoot, id: "mission-apply-2", status: "paused" });
  api.missionStepSetStatus({
    repoRoot,
    missionId: "mission-apply-2",
    stepId: "evaluate",
    status: "completed",
    result: { qualified: 2 },
  });
  api.missionSetStatus({ repoRoot, id: "mission-apply-2", status: "running" });
  api.missionStepSetStatus({
    repoRoot,
    missionId: "mission-apply-2",
    stepId: "packet",
    status: "running",
  });
  api.missionStepSetStatus({
    repoRoot,
    missionId: "mission-apply-2",
    stepId: "packet",
    status: "completed",
  });

  closeAll();
  const mission = api
    .chatFirstStateGet({ repoRoot })
    .missions.find((row) => row.id === "mission-apply-2");
  assert.equal(mission.status, "completed");
  assert.deepEqual(mission.steps[0].result, { qualified: 2 });

  const db = openDb({ repoRoot });
  const missionEvents = db
    .prepare("SELECT data FROM activity_events ORDER BY rowid ASC")
    .all()
    .map((row) => JSON.parse(row.data))
    .filter((event) => event.skill === "chat-first" && event.operation?.startsWith("mission:"));
  assert.ok(missionEvents.length >= 7);
});

test("a mission resumes its durable remaining work after a process restart without submitting", async () => {
  const api = await import("../src/core/db/verbs.mjs");
  const repoRoot = tempRepo();
  seedApplication(repoRoot, {
    id: "app-resume-mission",
    company: "Restart Corp",
    evaluation: { gate: "keep" },
  });
  api.missionCreateForJobs({
    repoRoot,
    id: "mission-restart",
    mode: "prepare-to-submit",
    jobs: [{ type: "application", id: "app-resume-mission" }],
  });
  closeAll();

  assert.equal(typeof api.missionResume, "function");
  const calls = [];
  const resumed = await api.missionResume({
    repoRoot,
    id: "mission-restart",
    executeIntent: async ({ intent }) => {
      calls.push(intent.type);
      return {
        operationResult: { ok: true },
        ...(intent.type === "job.prepare-submit"
          ? { messages: [{ metadata: { state: "awaiting-submit" } }] }
          : {}),
      };
    },
  });

  assert.equal(resumed.mission.status, "paused");
  assert.deepEqual(calls, ["job.generate-documents", "job.prepare-submit"]);
  assert.equal(calls.includes("job.apply"), false);
  assert.equal(
    resumed.mission.steps.find((step) => step.action === "submit-gate").result.requiresUserSubmit,
    true
  );
});

test("mission validation rejects duplicate steps and impossible transitions before a write", async () => {
  const api = await chatFirstApi();
  const repoRoot = tempRepo();
  const db = openDb({ repoRoot });
  const before = db.prepare("SELECT version FROM meta WHERE id = 1").get().version;
  assert.throws(
    () =>
      api.missionCreate({
        repoRoot,
        title: "Bad mission",
        steps: [
          { id: "same", label: "One" },
          { id: "same", label: "Two" },
        ],
      }),
    /unique/
  );
  const after = db.prepare("SELECT version FROM meta WHERE id = 1").get().version;
  assert.equal(after, before);
});

test("an operational job mission promotes sourced roles, evaluates applications, builds apply-intent packets, and stops at submit gates", async () => {
  const api = await chatFirstApi();
  const repoRoot = tempRepo();
  seedApplication(repoRoot, { id: "app-existing", company: "Existing Corp" });
  const { sourcedUpsertBatch } = await import("../src/core/db/verbs.mjs");
  sourcedUpsertBatch({
    repoRoot,
    rows: [
      {
        id: "source-new",
        company: "New Corp",
        role: "Platform Engineer",
        status: "sourced",
      },
    ],
  });

  const created = api.missionCreateForJobs({
    repoRoot,
    id: "mission-operational",
    jobs: [
      { type: "application", id: "app-existing" },
      { type: "sourced", id: "source-new" },
    ],
  });
  const calls = [];
  await api.missionRun({
    repoRoot,
    id: created.mission.id,
    executeIntent: async ({ intent }) => {
      calls.push(intent);
      if (intent.type === "sourced.promote") {
        return { operationResult: { id: "app-promoted" } };
      }
      return {
        operationResult: { ok: true },
        ...(intent.type === "job.prepare-submit"
          ? { messages: [{ metadata: { state: "awaiting-submit" } }] }
          : {}),
      };
    },
  });

  assert.deepEqual(
    calls.map((intent) => intent.type),
    [
      "job.evaluate",
      "job.generate-documents",
      "job.prepare-submit",
      "sourced.promote",
      "job.evaluate",
      "job.generate-documents",
      "job.prepare-submit",
    ]
  );
  assert.equal(
    calls.some((intent) => intent.type === "job.apply"),
    false
  );
  for (const intent of calls.filter((entry) => entry.type === "job.generate-documents")) {
    assert.equal(intent.input.applyIntent, true);
  }
  assert.equal(calls[4].entity.id, "app-promoted");

  const mission = api
    .chatFirstStateGet({ repoRoot })
    .missions.find((row) => row.id === "mission-operational");
  assert.equal(mission.status, "paused");
  const gates = mission.steps.filter((step) => step.action === "submit-gate");
  assert.equal(gates.length, 2);
  assert.equal(
    gates.every((step) => step.status === "blocked"),
    true
  );
  assert.equal(
    gates.every((step) => step.result?.requiresUserSubmit === true),
    true
  );
});

test("mission pause requests stop the runner before it claims the next step", async () => {
  const api = await chatFirstApi();
  const repoRoot = tempRepo();
  seedApplication(repoRoot, { id: "app-pause-one", company: "Pause One" });
  seedApplication(repoRoot, { id: "app-pause-two", company: "Pause Two" });
  const created = api.missionCreateForJobs({
    repoRoot,
    id: "mission-user-pause",
    jobs: [
      { type: "application", id: "app-pause-one" },
      { type: "application", id: "app-pause-two" },
    ],
  });
  const calls = [];
  const result = await api.missionRun({
    repoRoot,
    id: created.mission.id,
    executeIntent: async ({ intent }) => {
      calls.push(intent.type);
      if (calls.length === 1) {
        setImmediate(() =>
          api.missionSetStatus({ repoRoot, id: created.mission.id, status: "paused" })
        );
      }
      return { operationResult: { ok: true } };
    },
  });

  assert.deepEqual(calls, ["job.evaluate"]);
  assert.equal(result.mission.status, "paused");
  assert.equal(result.mission.steps[0].status, "completed");
  assert.equal(result.mission.steps[1].status, "pending");
});

test("submit gates preserve real sourced deadlines and derive packet and answered-question state", async () => {
  const api = await chatFirstApi();
  const repoRoot = tempRepo();
  const { sourcedPromote, sourcedUpsertBatch } = await import("../src/core/db/verbs.mjs");
  sourcedUpsertBatch({
    repoRoot,
    rows: [
      {
        id: "source-gate-data",
        company: "Gate Data Corp",
        role: "Infrastructure Engineer",
        status: "sourced",
        deadline: "2026-08-30T18:00:00.000Z",
        expiryLabel: "EXPIRES AUG 30",
        artifacts: {
          resume: "workspace/tailored/gate-data-resume.pdf",
          coverLetter: "workspace/tailored/gate-data-cover-letter.pdf",
          answers: "workspace/tailored/gate-data-answers.pdf",
        },
        packetManifest: {
          questions: { answerableCount: 4 },
          answerLineage: {
            answeredQuestionIds: ["q1", "q2", "q2", "q3", "portfolio"],
            skippedQuestionIds: ["portfolio"],
          },
        },
      },
    ],
  });
  const created = api.missionCreateForJobs({
    repoRoot,
    id: "mission-gate-data",
    jobs: [{ type: "sourced", id: "source-gate-data" }],
  });
  await api.missionRun({
    repoRoot,
    id: created.mission.id,
    executeIntent: async ({ intent }) => {
      if (intent.type === "sourced.promote") {
        const promoted = sourcedPromote({
          repoRoot,
          id: "source-gate-data",
          appRow: { id: "app-gate-data" },
        });
        return { operationResult: { id: promoted.id } };
      }
      return {
        operationResult: { ok: true },
        ...(intent.type === "job.prepare-submit"
          ? { messages: [{ metadata: { state: "awaiting-submit" } }] }
          : {}),
      };
    },
  });

  const state = api.chatFirstStateGet({ repoRoot });
  const mission = state.missions.find((item) => item.id === "mission-gate-data");
  const gate = mission.steps.find((step) => step.action === "submit-gate");
  assert.deepEqual(
    {
      deadline: gate.result.deadline,
      expiryLabel: gate.result.expiryLabel,
      answeredCount: gate.result.answeredCount,
      questionCount: gate.result.questionCount,
      packet: gate.result.packet,
    },
    {
      deadline: "2026-08-30T18:00:00.000Z",
      expiryLabel: "EXPIRES AUG 30",
      answeredCount: 3,
      questionCount: 4,
      packet: [
        {
          id: "resume",
          name: "resume.pdf",
          path: "workspace/tailored/gate-data-resume.pdf",
        },
        {
          id: "coverLetter",
          name: "cover-letter.pdf",
          path: "workspace/tailored/gate-data-cover-letter.pdf",
        },
        {
          id: "answers",
          name: "application-answers.pdf",
          path: "workspace/tailored/gate-data-answers.pdf",
        },
      ],
    }
  );
  const need = state.needsYou.find(
    (item) => item.kind === "submit-gate" && item.missionId === "mission-gate-data"
  );
  assert.equal(need.deadline, gate.result.deadline);
  assert.equal(need.answeredCount, 3);
  assert.deepEqual(need.packet, gate.result.packet);
  assert.equal(need.actions[0].policy, "user-submit-only");

  seedApplication(repoRoot, {
    id: "app-gate-no-deadline",
    company: "No Deadline Corp",
  });
  api.missionCreateForJobs({
    repoRoot,
    id: "mission-gate-no-deadline",
    jobs: [{ type: "application", id: "app-gate-no-deadline" }],
  });
  await api.missionRun({
    repoRoot,
    id: "mission-gate-no-deadline",
    executeIntent: async ({ intent }) => ({
      operationResult: { ok: true },
      ...(intent.type === "job.prepare-submit"
        ? { messages: [{ metadata: { state: "awaiting-submit" } }] }
        : {}),
    }),
  });
  const noDeadlineGate = api
    .chatFirstStateGet({ repoRoot })
    .missions.find((item) => item.id === "mission-gate-no-deadline")
    .steps.find((step) => step.action === "submit-gate");
  assert.equal(Object.hasOwn(noDeadlineGate.result, "deadline"), false);
  assert.equal(Object.hasOwn(noDeadlineGate.result, "expiryLabel"), false);
});

test("job mission mode separates draft-only tailoring from supervised prepare-to-submit work", async () => {
  const api = await chatFirstApi();
  const repoRoot = tempRepo();
  seedApplication(repoRoot, { id: "app-mode", company: "Mode Corp" });

  const draft = api.missionCreateForJobs({
    repoRoot,
    id: "mission-draft",
    mode: "draft",
    jobs: [{ type: "application", id: "app-mode" }],
  });
  assert.equal(draft.mission.mode, "draft");
  assert.deepEqual(
    draft.mission.steps.map((step) => step.action),
    ["evaluate", "generate-documents"]
  );
  const draftCalls = [];
  const draftRun = await api.missionRun({
    repoRoot,
    id: "mission-draft",
    executeIntent: async ({ intent }) => {
      draftCalls.push(intent);
      return { operationResult: { ok: true } };
    },
  });
  assert.equal(draftRun.mission.status, "completed");
  assert.equal(draftCalls[1].type, "job.generate-documents");
  assert.equal(draftCalls[1].input.applyIntent, false);

  const prepared = api.missionCreateForJobs({
    repoRoot,
    id: "mission-prepare",
    jobs: [{ type: "application", id: "app-mode" }],
  });
  assert.equal(prepared.mission.mode, "prepare-to-submit");
  assert.deepEqual(
    prepared.mission.steps.map((step) => step.action),
    ["evaluate", "generate-documents", "prepare-submit", "submit-gate"]
  );
  const prepareCalls = [];
  const prepareRun = await api.missionRun({
    repoRoot,
    id: "mission-prepare",
    executeIntent: async ({ intent }) => {
      prepareCalls.push(intent);
      return {
        operationResult: { ok: true },
        messages: [
          {
            metadata: {
              state: intent.type === "job.prepare-submit" ? "awaiting-submit" : "ready",
            },
            ...(intent.type === "job.prepare-submit"
              ? {
                  artifacts: [
                    {
                      kind: "application_handoff",
                      url: "https://jobs.example.test/app-mode",
                      submissionVerified: false,
                      session: { provider: "test-browser", filledCount: 8 },
                    },
                  ],
                }
              : {}),
          },
        ],
      };
    },
  });
  assert.equal(prepareRun.mission.status, "paused");
  assert.deepEqual(
    prepareCalls.map((intent) => intent.type),
    ["job.evaluate", "job.generate-documents", "job.prepare-submit"]
  );
  assert.equal(
    prepareCalls.some((intent) => intent.type === "job.apply"),
    false
  );
  assert.equal(
    prepareRun.mission.steps.find((step) => step.action === "prepare-submit").result.state,
    "awaiting-submit"
  );
  assert.deepEqual(
    prepareRun.mission.steps.find((step) => step.action === "prepare-submit").result.handoff,
    {
      kind: "application_handoff",
      url: "https://jobs.example.test/app-mode",
      submissionVerified: false,
      session: { provider: "test-browser", filledCount: 8 },
    }
  );
});

test("job mission mode validation fails before a durable write", async () => {
  const api = await chatFirstApi();
  const repoRoot = tempRepo();
  seedApplication(repoRoot, { id: "app-bad-mode", company: "Mode Corp" });
  assert.throws(
    () =>
      api.missionCreateForJobs({
        repoRoot,
        id: "mission-bad-mode",
        mode: "automatic-submit",
        jobs: [{ type: "application", id: "app-bad-mode" }],
      }),
    /mode/
  );
  assert.equal(
    api
      .chatFirstStateGet({ repoRoot })
      .missions.some((mission) => mission.id === "mission-bad-mode"),
    false
  );
});

test("mission execution persists leased attempt identity, idempotency classification, provenance, and receipts", async () => {
  const api = await chatFirstApi();
  const repoRoot = tempRepo();
  seedApplication(repoRoot, {
    id: "app-attempts",
    company: "Receipts Corp",
    evaluation: { gate: "keep" },
  });
  api.missionCreateForJobs({
    repoRoot,
    id: "mission-attempts",
    mode: "draft",
    jobs: [{ type: "application", id: "app-attempts" }],
  });
  const intents = [];
  await api.missionRun({
    repoRoot,
    id: "mission-attempts",
    executeIntent: async ({ intent, attemptId, idempotencyKey }) => {
      intents.push(intent);
      assert.equal(intent.input.missionAttempt.attemptId, attemptId);
      assert.equal(intent.input.missionAttempt.idempotencyKey, idempotencyKey);
      return { operationResult: { status: "ready" } };
    },
  });

  const mission = api.chatFirstStateGet({ repoRoot }).missions[0];
  assert.equal(mission.status, "completed");
  assert.equal(mission.steps.length, 1);
  const attempt = mission.steps[0].attempts[0];
  assert.match(attempt.id, /^attempt-/);
  assert.equal(attempt.status, "completed");
  assert.equal(attempt.idempotency.classification, "receipt-required");
  assert.equal(attempt.idempotency.key, "mission-attempts:job-1-documents");
  assert.equal(attempt.receipt.outcome, "completed");
  assert.equal(attempt.receipt.result.status, "ready");
  assert.equal(intents[0].type, "job.generate-documents");
});

test("a claimed mission step rejects settlement without its attempt identity", async () => {
  const api = await chatFirstApi();
  const repoRoot = tempRepo();
  seedApplication(repoRoot, {
    id: "app-attempt-fence",
    company: "Fence Corp",
    evaluation: { gate: "keep" },
  });
  api.missionCreateForJobs({
    repoRoot,
    id: "mission-attempt-fence",
    mode: "draft",
    jobs: [{ type: "application", id: "app-attempt-fence" }],
  });

  let releaseIntent;
  let markIntentStarted;
  const intentStarted = new Promise((resolve) => {
    markIntentStarted = resolve;
  });
  const intentReleased = new Promise((resolve) => {
    releaseIntent = resolve;
  });
  const running = api.missionRun({
    repoRoot,
    id: "mission-attempt-fence",
    executeIntent: async () => {
      markIntentStarted();
      await intentReleased;
      return { operationResult: { status: "ready" } };
    },
  });
  await intentStarted;

  const claimedStep = api
    .chatFirstStateGet({ repoRoot })
    .missions[0].steps.find((step) => step.currentAttempt);
  assert.ok(claimedStep?.currentAttempt?.id);
  assert.throws(
    () =>
      api.missionStepSetStatus({
        repoRoot,
        missionId: "mission-attempt-fence",
        stepId: claimedStep.id,
        status: "completed",
        result: { id: "app-forged" },
      }),
    /mission step attempt is stale/
  );

  releaseIntent();
  const result = await running;
  assert.equal(result.mission.status, "completed");
  assert.equal(result.mission.steps[0].result.status, "ready");
});

test("application mission attempts freeze their provider-neutral plan and reuse it when the submit handoff resumes", async () => {
  const api = await chatFirstApi();
  const repoRoot = tempRepo();
  seedApplication(repoRoot, {
    id: "app-plan-reuse",
    company: "Frozen Plan Corp",
    evaluation: { gate: "keep" },
  });
  api.missionCreate({
    repoRoot,
    id: "mission-plan-reuse",
    title: "Prepare Frozen Plan Corp",
    mode: "prepare-to-submit",
    steps: [
      {
        id: "prepare",
        label: "Prepare form",
        action: "prepare-submit",
        jobRef: { type: "application", id: "app-plan-reuse" },
      },
      {
        id: "submit",
        label: "Submit form",
        action: "submit-gate",
        jobRef: { type: "application", id: "app-plan-reuse" },
      },
    ],
  });
  const frozenPlan = {
    policyVersion: 1,
    operation: "application.drafting",
    runtimeId: "codex",
    adapterVersion: 1,
    requested: { quality: "best", reasoning: "medium" },
    resolved: {
      quality: "best",
      reasoning: "medium",
      model: "gpt-5.6-sol",
      modelSource: "alias",
      effort: "medium",
      speedTier: null,
    },
    fallback: null,
  };
  let resolverCalls = 0;
  const seen = [];
  const resolveExecutionPlan = () => {
    resolverCalls += 1;
    return resolverCalls === 1 ? frozenPlan : { ...frozenPlan, runtimeId: "claude" };
  };
  const executeIntent = async ({ intent }) => {
    seen.push(intent);
    return {
      messages: [{ metadata: { state: "awaiting-submit" } }],
      operationResult: { status: "ready" },
    };
  };

  const initial = await api.missionRun({
    repoRoot,
    id: "mission-plan-reuse",
    resolveExecutionPlan,
    executeIntent,
  });
  assert.equal(initial.mission.status, "paused");
  assert.deepEqual(seen[0].input.executionPlan, frozenPlan);
  assert.deepEqual(initial.mission.steps[0].attempts[0].executionPlan, frozenPlan);

  const resumed = await api.missionResume({
    repoRoot,
    id: "mission-plan-reuse",
    focusApplicationId: "app-plan-reuse",
    resolveExecutionPlan,
    executeIntent,
  });
  assert.equal(resumed.mission.status, "paused");
  assert.equal(seen.length, 2);
  assert.equal(seen[1].input.focusSession, true);
  assert.deepEqual(seen[1].input.executionPlan, frozenPlan);
  assert.equal(resolverCalls, 1, "handoff resume must reuse the persisted plan");
  assert.deepEqual(
    resumed.mission.steps[0].attempts.map((attempt) => attempt.executionPlan),
    [frozenPlan, frozenPlan]
  );
});

test("mission execution pauses an expired uncertain operation instead of replaying it and refuses a live lease", async () => {
  const api = await chatFirstApi();
  const repoRoot = tempRepo();
  seedApplication(repoRoot, {
    id: "app-stale-attempt",
    company: "Lease Corp",
    evaluation: { gate: "keep" },
  });
  api.missionCreateForJobs({
    repoRoot,
    id: "mission-stale-attempt",
    mode: "draft",
    jobs: [{ type: "application", id: "app-stale-attempt" }],
  });
  const db = openDb({ repoRoot });
  const row = db
    .prepare("SELECT data FROM mission_steps WHERE mission_id = ?")
    .get("mission-stale-attempt");
  const staleStep = JSON.parse(row.data);
  staleStep.status = "running";
  staleStep.currentAttempt = {
    id: "attempt-crashed",
    status: "running",
    startedAt: "2026-08-23T10:00:00.000Z",
    leaseExpiresAt: "2026-08-23T10:01:00.000Z",
    idempotency: {
      key: "mission-stale-attempt:job-1-documents",
      classification: "receipt-required",
    },
  };
  db.prepare("UPDATE mission_steps SET data = ? WHERE mission_id = ? AND id = ?").run(
    JSON.stringify(staleStep),
    "mission-stale-attempt",
    staleStep.id
  );
  let calls = 0;
  const recovered = await api.missionRun({
    repoRoot,
    id: "mission-stale-attempt",
    now: new Date("2026-08-23T10:05:00.000Z"),
    executeIntent: async () => {
      calls += 1;
      return { operationResult: { status: "ready" } };
    },
  });
  assert.equal(recovered.mission.status, "paused");
  assert.equal(calls, 0);
  assert.equal(recovered.mission.steps[0].status, "blocked");
  assert.equal(recovered.mission.steps[0].result.reason, "stale-outcome-uncertain");
  assert.deepEqual(
    recovered.mission.steps[0].attempts.map((attempt) => attempt.status),
    ["expired"]
  );

  api.missionCreateForJobs({
    repoRoot,
    id: "mission-live-attempt",
    mode: "draft",
    jobs: [{ type: "application", id: "app-stale-attempt" }],
  });
  const liveRow = db
    .prepare("SELECT data FROM mission_steps WHERE mission_id = ?")
    .get("mission-live-attempt");
  const liveStep = JSON.parse(liveRow.data);
  liveStep.status = "running";
  liveStep.currentAttempt = {
    id: "attempt-live",
    status: "running",
    startedAt: "2026-08-23T10:04:00.000Z",
    leaseExpiresAt: "2026-08-23T10:10:00.000Z",
    idempotency: {
      key: "mission-live-attempt:job-1-documents",
      classification: "receipt-required",
    },
  };
  db.prepare("UPDATE mission_steps SET data = ? WHERE mission_id = ? AND id = ?").run(
    JSON.stringify(liveStep),
    "mission-live-attempt",
    liveStep.id
  );
  await assert.rejects(
    () =>
      api.missionRun({
        repoRoot,
        id: "mission-live-attempt",
        now: new Date("2026-08-23T10:05:00.000Z"),
        executeIntent: async () => {
          calls += 1;
          return { operationResult: { status: "ready" } };
        },
      }),
    /lease/
  );
  assert.equal(calls, 0);

  closeAll();
  const restartRecovered = await api.missionResume({
    repoRoot,
    id: "mission-live-attempt",
    now: new Date("2026-08-23T10:05:00.000Z"),
    executeIntent: async () => {
      calls += 1;
      return { operationResult: { status: "ready" } };
    },
  });
  assert.equal(restartRecovered.mission.status, "paused");
  assert.equal(restartRecovered.mission.steps[0].result.reason, "stale-outcome-uncertain");
  assert.equal(calls, 0);
});

test("mission execution renews and fences its lease while a workspace intent is in flight", async () => {
  const api = await chatFirstApi();
  const repoRoot = tempRepo();
  seedApplication(repoRoot, {
    id: "app-renew-lease",
    company: "Renew Corp",
    evaluation: { gate: "keep" },
  });
  api.missionCreateForJobs({
    repoRoot,
    id: "mission-renew-lease",
    mode: "draft",
    jobs: [{ type: "application", id: "app-renew-lease" }],
  });

  let firstExpiry;
  const result = await api.missionRun({
    repoRoot,
    id: "mission-renew-lease",
    leaseMs: 5_000,
    executeIntent: async ({ attemptId }) => {
      const db = openDb({ repoRoot });
      const before = JSON.parse(
        db.prepare("SELECT data FROM mission_steps WHERE mission_id = ?").get("mission-renew-lease")
          .data
      );
      firstExpiry = before.currentAttempt.leaseExpiresAt;
      assert.equal(before.currentAttempt.id, attemptId);
      await new Promise((resolve) => setTimeout(resolve, 1_900));
      const renewed = JSON.parse(
        db.prepare("SELECT data FROM mission_steps WHERE mission_id = ?").get("mission-renew-lease")
          .data
      );
      assert.equal(renewed.currentAttempt.id, attemptId);
      assert.ok(renewed.currentAttempt.leaseExpiresAt > firstExpiry);
      assert.ok(Number(renewed.currentAttempt.fence) >= 1);
      return { operationResult: { status: "ready" } };
    },
  });

  assert.equal(result.mission.status, "completed");
});

test("mission compound writes continue from canonical DB commits when compatibility export fails", async () => {
  const api = await chatFirstApi();
  const repoRoot = tempRepo();
  seedApplication(repoRoot, {
    id: "app-mission-export",
    company: "Mission Export Corp",
    evaluation: { gate: "keep" },
  });
  api.missionCreateForJobs({
    repoRoot,
    id: "mission-export-failure",
    mode: "draft",
    jobs: [{ type: "application", id: "app-mission-export" }],
  });
  rmSync(join(repoRoot, "workspace", "tracker.json"), { force: true });
  mkdirSync(join(repoRoot, "workspace", "tracker.json"), { recursive: true });

  let calls = 0;
  const result = await api.missionRun({
    repoRoot,
    id: "mission-export-failure",
    executeIntent: async () => {
      calls += 1;
      return { operationResult: { status: "ready" } };
    },
  });

  assert.equal(calls, 1);
  assert.equal(result.mission.status, "completed");
  assert.equal(result.mission.steps[0].attempts.length, 1);
});

test("pausing during an in-flight mission step lets that step settle and prevents the next step from starting", async () => {
  const api = await chatFirstApi();
  const repoRoot = tempRepo();
  seedApplication(repoRoot, { id: "app-pause-live", company: "Pause Corp" });
  api.missionCreateForJobs({
    repoRoot,
    id: "mission-pause-live",
    jobs: [{ type: "application", id: "app-pause-live" }],
  });
  const calls = [];
  const result = await api.missionRun({
    repoRoot,
    id: "mission-pause-live",
    executeIntent: async ({ intent }) => {
      calls.push(intent.type);
      api.missionSetStatus({
        repoRoot,
        id: "mission-pause-live",
        status: "paused",
      });
      return { operationResult: { ok: true } };
    },
  });

  assert.deepEqual(calls, ["job.evaluate"]);
  assert.equal(result.mission.status, "paused");
  assert.equal(result.mission.steps[0].status, "completed");
  assert.equal(result.mission.steps[1].status, "pending");
});

test("job missions reuse a saved KEEP evaluation and never prepare documents after a fresh CUT", async () => {
  const api = await chatFirstApi();
  const repoRoot = tempRepo();
  seedApplication(repoRoot, {
    id: "app-keep",
    company: "Keep Corp",
    gate: "keep",
    evaluation: { gate: "keep" },
  });
  seedApplication(repoRoot, { id: "app-cut", company: "Cut Corp" });

  api.missionCreateForJobs({
    repoRoot,
    id: "mission-keep",
    jobs: [{ type: "application", id: "app-keep" }],
  });
  const keepCalls = [];
  await api.missionRun({
    repoRoot,
    id: "mission-keep",
    executeIntent: async ({ intent }) => {
      keepCalls.push(intent.type);
      return {
        operationResult: { ok: true },
        ...(intent.type === "job.prepare-submit"
          ? { messages: [{ metadata: { state: "awaiting-submit" } }] }
          : {}),
      };
    },
  });
  assert.deepEqual(keepCalls, ["job.generate-documents", "job.prepare-submit"]);

  api.missionCreateForJobs({
    repoRoot,
    id: "mission-cut",
    jobs: [{ type: "application", id: "app-cut" }],
  });
  const cutCalls = [];
  await api.missionRun({
    repoRoot,
    id: "mission-cut",
    executeIntent: async ({ intent }) => {
      cutCalls.push(intent.type);
      return {
        operationResult: { ok: true },
        messages: [{ metadata: { state: "cut" } }],
      };
    },
  });
  assert.deepEqual(cutCalls, ["job.evaluate"]);
  const cutMission = api
    .chatFirstStateGet({ repoRoot })
    .missions.find((mission) => mission.id === "mission-cut");
  assert.equal(cutMission.status, "completed");
  assert.deepEqual(
    cutMission.steps.map((step) => step.status),
    ["completed", "skipped", "skipped", "skipped"]
  );
});

test("mock interview sessions persist questions, answers, coaching feedback, and ended state", async () => {
  const api = await chatFirstApi();
  const repoRoot = tempRepo();
  seedApplication(repoRoot, {
    id: "app-cyberdyne",
    company: "Cyberdyne Systems",
    role: "Staff Platform Engineer",
    status: "interview",
  });

  const started = api.mockInterviewStart({
    repoRoot,
    id: "mock-cyberdyne",
    applicationId: "app-cyberdyne",
    title: "Technical mock interview",
    questionTotal: 6,
    context: {
      dossierPath: "workspace/interview-prep/cyberdyne.md",
      interviewer: "Miles",
    },
  });
  assert.equal(started.session.status, "active");
  const question = api.mockInterviewMessageAppend({
    repoRoot,
    sessionId: "mock-cyberdyne",
    role: "assistant",
    kind: "question",
    questionNumber: 1,
    text: "Tell me about a platform migration you led.",
  });
  const answer = api.mockInterviewMessageAppend({
    repoRoot,
    sessionId: "mock-cyberdyne",
    role: "user",
    kind: "answer",
    questionNumber: 1,
    text: "I led a three-team migration with no P1 incidents.",
  });
  api.mockInterviewFeedbackAppend({
    repoRoot,
    sessionId: "mock-cyberdyne",
    messageId: answer.message.id,
    questionNumber: 1,
    worked: "Clear ownership and outcome.",
    tighten: "Name the migration scale and tradeoff.",
  });
  api.mockInterviewEnd({
    repoRoot,
    sessionId: "mock-cyberdyne",
    summary: "Strong evidence. Sharpen scale and tradeoffs.",
  });

  closeAll();
  const session = api
    .chatFirstStateGet({ repoRoot })
    .mockSessions.find((row) => row.id === "mock-cyberdyne");
  assert.equal(session.status, "ended");
  assert.equal(session.messages[0].id, question.message.id);
  assert.equal(session.messages[1].id, answer.message.id);
  assert.deepEqual(session.feedback[0], {
    id: session.feedback[0].id,
    sessionId: "mock-cyberdyne",
    messageId: answer.message.id,
    questionNumber: 1,
    worked: "Clear ownership and outcome.",
    tighten: "Name the migration scale and tradeoff.",
    createdAt: session.feedback[0].createdAt,
  });
  assert.throws(
    () =>
      api.mockInterviewMessageAppend({
        repoRoot,
        sessionId: "mock-cyberdyne",
        role: "user",
        text: "Late answer",
      }),
    /ended/
  );
});

test("mock start retries the same empty active session after AI failure and turns cannot answer before question one exists", async () => {
  const api = await chatFirstApi();
  const repoRoot = tempRepo();
  seedApplication(repoRoot, {
    id: "app-mock-retry",
    company: "Retry Interview Corp",
    role: "Platform Engineer",
    status: "interview",
  });

  await assert.rejects(
    () =>
      api.mockInterviewStartWithAI({
        repoRoot,
        id: "mock-retry",
        applicationId: "app-mock-retry",
        questionTotal: 2,
        context: {
          interviewer: "Hiring manager",
          arbitrarySecret: "do-not-send-this",
          schedulingLink: "https://calendly.com/private/mock",
        },
        runAI: async () => ({
          status: 502,
          body: {
            ok: false,
            code: "AI_PROVIDER_FAILED",
            error: { message: "temporary outage" },
            ai: { used: false },
          },
        }),
      }),
    /temporary outage/
  );

  await assert.rejects(
    () =>
      api.mockInterviewTurn({
        repoRoot,
        sessionId: "mock-retry",
        text: "This must not be persisted without a question.",
        runAI: async () => {
          throw new Error("AI should not run before question one exists");
        },
      }),
    (error) => error?.code === "CONFLICT" && /question/i.test(error.message)
  );
  let session = api
    .chatFirstStateGet({ repoRoot })
    .mockSessions.find((row) => row.id === "mock-retry");
  assert.equal(
    session.messages.some((message) => message.kind === "answer"),
    false
  );

  let request;
  const retried = await api.mockInterviewStartWithAI({
    repoRoot,
    id: "mock-retry",
    applicationId: "app-mock-retry",
    questionTotal: 2,
    context: {
      interviewer: "Hiring manager",
      arbitrarySecret: "do-not-send-this",
      schedulingLink: "https://calendly.com/private/mock",
    },
    runAI: async (options) => {
      request = options;
      return {
        status: 200,
        body: {
          ok: true,
          data: { question: "Tell me about a platform migration." },
          ai: { used: true },
        },
      };
    },
  });

  assert.equal(retried.session.id, "mock-retry");
  assert.equal(retried.question.questionNumber, 1);
  assert.equal(request.aiOperation, "coach.deep");
  assert.equal(request.tier, undefined);
  session = api.chatFirstStateGet({ repoRoot }).mockSessions.find((row) => row.id === "mock-retry");
  assert.equal(session.messages.filter((message) => message.kind === "question").length, 1);
  const serialized = request.messages[0].content;
  const requestedContext = JSON.parse(serialized).canonicalContext.session.requestedContext;
  assert.deepEqual(requestedContext, {
    interviewer: "Hiring manager",
    round: null,
    audience: null,
    focusAreas: [],
  });
});

test("mock start resumes the newest empty active session without an explicit session id", async () => {
  const api = await chatFirstApi();
  const repoRoot = tempRepo();
  seedApplication(repoRoot, {
    id: "app-mock-generated-id",
    company: "Generated Session Corp",
    role: "Platform Engineer",
    status: "interview",
  });

  await assert.rejects(
    () =>
      api.mockInterviewStartWithAI({
        repoRoot,
        applicationId: "app-mock-generated-id",
        runAI: async () => ({
          status: 502,
          body: {
            ok: false,
            code: "AI_PROVIDER_FAILED",
            error: { message: "temporary outage" },
            ai: { used: false },
          },
        }),
      }),
    /temporary outage/
  );

  const existing = api
    .chatFirstStateGet({ repoRoot })
    .mockSessions.find((session) => session.applicationId === "app-mock-generated-id");
  const resumed = await api.mockInterviewStartWithAI({
    repoRoot,
    applicationId: "app-mock-generated-id",
    runAI: async () => ({
      status: 200,
      body: {
        ok: true,
        data: { question: "Tell me about a platform migration." },
        ai: { used: true },
      },
    }),
  });

  assert.equal(resumed.session.id, existing.id);
  assert.equal(resumed.question.questionNumber, 1);
});

test("mock start repairs descriptive model metadata into an interview question", async () => {
  const api = await chatFirstApi();
  const repoRoot = tempRepo();
  seedApplication(repoRoot, {
    id: "app-mock-question-repair",
    company: "Question Repair Corp",
    role: "Platform Engineer",
    status: "interview",
  });

  const started = await api.mockInterviewStartWithAI({
    repoRoot,
    id: "mock-question-repair",
    applicationId: "app-mock-question-repair",
    runAI: async () => ({
      status: 200,
      body: {
        ok: true,
        data: {
          question:
            "Behavioral interview prompt focused on migration leadership and cross-functional tradeoffs.",
        },
        ai: { used: true },
      },
    }),
  });

  assert.equal(
    started.question.text,
    "Walk me through a specific example involving migration leadership and cross-functional tradeoffs."
  );
});

test("mock start unwraps a JSON-encoded question string from an installed runtime", async () => {
  const api = await chatFirstApi();
  const repoRoot = tempRepo();
  seedApplication(repoRoot, {
    id: "app-mock-question-json",
    company: "Question JSON Corp",
    role: "Platform Engineer",
    status: "interview",
  });

  const started = await api.mockInterviewStartWithAI({
    repoRoot,
    id: "mock-question-json",
    applicationId: "app-mock-question-json",
    runAI: async () => ({
      status: 200,
      body: {
        ok: true,
        data: {
          question:
            '{"question":"How would you keep a dispatcher cache fast without surfacing stale data?"}',
        },
        ai: { used: true },
      },
    }),
  });

  assert.equal(
    started.question.text,
    "How would you keep a dispatcher cache fast without surfacing stale data?"
  );
});

test("mock start preserves a contextual multi-sentence question", async () => {
  const api = await chatFirstApi();
  const repoRoot = tempRepo();
  seedApplication(repoRoot, {
    id: "app-mock-context-question",
    company: "Context Question Corp",
    role: "Product Engineer",
    status: "interview",
  });
  const question =
    "At Curri, drivers use the product in the field. How would you measure whether a new feature works for them? Walk me through your first week.";

  const started = await api.mockInterviewStartWithAI({
    repoRoot,
    id: "mock-context-question",
    applicationId: "app-mock-context-question",
    runAI: async () => ({
      status: 200,
      body: { ok: true, data: { question }, ai: { used: true } },
    }),
  });

  assert.equal(started.question.text, question);
});

test("chat-first reads fail closed and never create a database implicitly", async () => {
  const api = await chatFirstApi();
  const repoRoot = mkdtempSync(join(tmpdir(), "careerrat-chat-first-no-db-"));
  cleanupRoots.push(repoRoot);
  assert.throws(
    () => api.chatFirstStateGet({ repoRoot }),
    (error) => error?.code === "NO_DATABASE"
  );
});
