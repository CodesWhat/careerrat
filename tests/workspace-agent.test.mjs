import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { after, test } from "node:test";

import { mountWorkspaceAgentRoutes } from "../src/cli/workspace-agent-route.mjs";
import {
  captureWorkspaceIntake,
  createWorkspaceAgentRuntime,
  executeWorkspaceIntent,
  recordWorkspaceSearchCompletion,
  runWorkspaceAgentTurn,
} from "../src/core/agent/workspace-agent.mjs";
import {
  WORKSPACE_THREAD_ID,
  workspaceIntentAppend,
  workspaceMessageAppend,
  workspaceThreadOpen,
  workspaceThreadRead,
} from "../src/core/agent/workspace-thread.mjs";
import { closeAll, openDb } from "../src/core/db/connection.mjs";
import { ALL_MIGRATIONS } from "../src/core/db/migrations.mjs";
import { appUpsert } from "../src/core/db/verbs/app.mjs";
import { commUpsert } from "../src/core/db/verbs/comm.mjs";
import { intakeCapture, intakeUpdate } from "../src/core/db/verbs/intake.mjs";
import { sourcedUpsertBatch } from "../src/core/db/verbs/sourced.mjs";

const cleanupRoots = [];

function tempRepo() {
  const repoRoot = mkdtempSync(join(tmpdir(), "careerrat-workspace-agent-"));
  cleanupRoots.push(repoRoot);
  openDb({ repoRoot, env: {} });
  return repoRoot;
}

function seedApplication(repoRoot, overrides = {}) {
  const row = {
    id: "app-temporal",
    company: "Temporal Labs",
    role: "Applied AI Engineer",
    status: "reviewed-hold",
    link: "https://jobs.example.test/temporal/applied-ai-engineer",
    ...overrides,
  };
  appUpsert({ repoRoot, env: {}, row });
  return row;
}

function readApplication(repoRoot, id) {
  const row = openDb({ repoRoot, env: {} })
    .prepare("SELECT data FROM applications WHERE id = ?")
    .get(id);
  return row ? JSON.parse(row.data) : null;
}

function seedCommunication(repoRoot, overrides = {}) {
  const row = {
    id: "comm-temporal-recruiter",
    applicationId: "app-temporal",
    company: "Temporal Labs",
    role: "Applied AI Engineer",
    channel: "email",
    subject: "Interview availability",
    status: "needs-reply",
    summary: "Recruiter asked for availability next week.",
    messages: [
      {
        direction: "inbound",
        at: "2026-08-09T13:00:00.000Z",
        summary: "Can you share availability for a recruiter screen next week?",
      },
    ],
    ...overrides,
  };
  commUpsert({ repoRoot, env: {}, row });
  return row;
}

function readCommunication(repoRoot, id) {
  const row = openDb({ repoRoot, env: {} })
    .prepare("SELECT data FROM communications WHERE id = ?")
    .get(id);
  return row ? JSON.parse(row.data) : null;
}

function seedSourced(repoRoot, overrides = {}) {
  const row = {
    id: "sourced-temporal",
    company: "Temporal Labs",
    role: "Staff Platform Engineer",
    status: "sourced",
    link: "https://jobs.example.test/temporal/staff-platform-engineer",
    fitScore: 88,
    ...overrides,
  };
  sourcedUpsertBatch({ repoRoot, env: {}, rows: [row] });
  return row;
}

function readSourced(repoRoot, id) {
  const row = openDb({ repoRoot, env: {} })
    .prepare("SELECT data FROM sourced WHERE id = ?")
    .get(id);
  return row ? JSON.parse(row.data) : null;
}

after(() => {
  closeAll();
  for (const root of cleanupRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

test("migration 010 creates durable workspace thread and ordered message tables", () => {
  const repoRoot = tempRepo();
  const db = openDb({ repoRoot, env: {} });

  assert.equal(ALL_MIGRATIONS.at(-1).id, 10);
  assert.deepEqual(
    { ...db.prepare("SELECT id, name FROM _migrations WHERE id = 10").get() },
    { id: 10, name: "workspace-agent" }
  );
  for (const table of ["workspace_threads", "workspace_messages"]) {
    const sql = db
      .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?")
      .get(table)?.sql;
    assert.match(sql || "", /json_valid\(data\)/);
  }
  const messageIndexes = db
    .prepare("PRAGMA index_list('workspace_messages')")
    .all()
    .map((row) => row.name);
  assert.ok(messageIndexes.includes("idx_workspace_messages_thread_sequence"));
});

test("all ordinary messages and contextual intents append to one canonical durable thread", () => {
  const repoRoot = tempRepo();
  const opened = workspaceThreadOpen({
    repoRoot,
    env: {},
    now: new Date("2026-08-09T14:00:00.000Z"),
  });
  assert.equal(opened.thread.id, WORKSPACE_THREAD_ID);

  workspaceMessageAppend({
    repoRoot,
    env: {},
    role: "user",
    text: "I want product-facing AI roles near Brooklyn.",
    now: new Date("2026-08-09T14:01:00.000Z"),
  });
  workspaceIntentAppend({
    repoRoot,
    env: {},
    intent: {
      type: "interview.prepare",
      entity: { type: "application", id: "app-temporal" },
      input: { audience: "hiring-manager" },
    },
    now: new Date("2026-08-09T14:02:00.000Z"),
  });

  const read = workspaceThreadRead({ repoRoot, env: {} });
  assert.equal(read.thread.id, WORKSPACE_THREAD_ID);
  assert.deepEqual(
    read.messages.map(({ sequence, role, kind }) => ({ sequence, role, kind })),
    [
      { sequence: 1, role: "user", kind: "text" },
      { sequence: 2, role: "user", kind: "intent" },
    ]
  );
  assert.deepEqual(read.messages[1].intent, {
    type: "interview.prepare",
    entity: { type: "application", id: "app-temporal" },
    input: { audience: "hiring-manager" },
  });
  assert.equal(workspaceThreadOpen({ repoRoot, env: {} }).thread.id, WORKSPACE_THREAD_ID);
  assert.equal(workspaceThreadRead({ repoRoot, env: {} }).messages.length, 2);
});

test("typed intents reject unknown action types and mismatched entity types before persistence", () => {
  const repoRoot = tempRepo();
  workspaceThreadOpen({ repoRoot, env: {} });

  assert.throws(
    () =>
      workspaceIntentAppend({
        repoRoot,
        env: {},
        intent: { type: "mystery.do-anything", entity: { type: "application", id: "app-1" } },
      }),
    (error) => error.code === "UNSUPPORTED_INTENT"
  );
  assert.throws(
    () =>
      workspaceIntentAppend({
        repoRoot,
        env: {},
        intent: {
          type: "interview.prepare",
          entity: { type: "communication", id: "comm-1" },
        },
      }),
    (error) => error.code === "BAD_INTENT_ENTITY"
  );
  assert.equal(workspaceThreadRead({ repoRoot, env: {} }).messages.length, 0);
});

test("interview prep executes behind the same thread and appends its artifact result", async () => {
  const repoRoot = tempRepo();
  const calls = [];
  const result = await executeWorkspaceIntent({
    repoRoot,
    env: {},
    intent: {
      type: "interview.prepare",
      entity: { type: "application", id: "app-temporal" },
      input: { audience: "hiring-manager" },
    },
    buildInterviewDossierImpl: (input) => {
      calls.push(input);
      return {
        applicationId: "app-temporal",
        company: "Temporal Labs",
        role: "Applied AI Engineer",
        dossier: {
          title: "Temporal Labs — Applied AI Engineer",
          markdown: "# Interview Packet",
          path: "workspace/interview-prep/temporal-labs-applied-ai-engineer.md",
        },
      };
    },
    now: () => new Date("2026-08-09T14:03:00.000Z"),
  });

  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], {
    repoRoot,
    env: {},
    applicationId: "app-temporal",
    audience: "hiring-manager",
    inviteNotes: undefined,
    jobSignals: undefined,
  });
  assert.equal(result.thread.id, WORKSPACE_THREAD_ID);
  assert.deepEqual(
    result.messages.map(({ role, kind }) => ({ role, kind })),
    [
      { role: "user", kind: "intent" },
      { role: "assistant", kind: "action_result" },
    ]
  );
  assert.equal(
    result.messages[1].artifacts[0].path,
    "workspace/interview-prep/temporal-labs-applied-ai-engineer.md"
  );
  assert.match(result.messages[1].text, /Temporal Labs/);
});

test("job evaluation executes behind workspace-main and preserves the typed verdict as context", async () => {
  const repoRoot = tempRepo();
  seedApplication(repoRoot);
  const evaluation = {
    appId: "app-temporal",
    applicationId: "app-temporal",
    gate: "keep",
    fitScore: 92,
    fitBucket: "high",
    fitSummary: "Strong applied-AI delivery match.",
    compensation: {
      status: "clears-floor",
      currency: "USD",
      minBase: 205000,
      maxBase: 280000,
      source: "job-description",
      summary: "Posted base clears the candidate floor.",
    },
    action: "generate-packet",
    fitReasons: ["Production agent workflow ownership"],
    fitRisks: [],
    confidence: "high",
    manual: { required: false },
    source: { jd: "workspace/jobs/temporal.md", captured: false },
    evaluatedAt: "2026-08-09T14:03:00.000Z",
  };
  const calls = [];

  const result = await executeWorkspaceIntent({
    repoRoot,
    env: {},
    intent: {
      type: "job.evaluate",
      entity: { type: "application", id: "app-temporal" },
    },
    evaluateJobImpl: async (input) => {
      calls.push(input);
      return { status: 200, body: { ok: true, data: evaluation } };
    },
    now: () => new Date("2026-08-09T14:03:00.000Z"),
  });

  assert.deepEqual(calls, [
    {
      repoRoot,
      env: {},
      body: { applicationId: "app-temporal" },
    },
  ]);
  assert.equal(result.thread.id, WORKSPACE_THREAD_ID);
  assert.deepEqual(
    result.messages.map(({ role, kind }) => ({ role, kind })),
    [
      { role: "user", kind: "intent" },
      { role: "assistant", kind: "action_result" },
    ]
  );
  assert.deepEqual(result.messages[1].artifacts[0], {
    kind: "job_evaluation",
    title: "Temporal Labs — Applied AI Engineer — Keep",
    applicationId: "app-temporal",
    evaluation,
  });
  assert.equal(result.messages[1].metadata.state, "keep");
  assert.match(result.messages[1].text, /keep/i);

  const modelCalls = [];
  await runWorkspaceAgentTurn({
    repoRoot,
    env: {},
    text: "What did the compensation gate find?",
    callAIImpl: async (input) => {
      modelCalls.push(input);
      return { content: [{ type: "text", text: "It clears your floor." }] };
    },
  });
  assert.match(JSON.stringify(modelCalls[0].messages), /Posted base clears the candidate floor/);
});

test("document generation executes behind workspace-main and preserves artifact and gap context", async () => {
  const repoRoot = tempRepo();
  seedApplication(repoRoot, {
    evaluation: { gate: "keep" },
    artifacts: { jd: "workspace/jobs/temporal.md" },
  });
  const generation = {
    appId: "app-temporal",
    applicationId: "app-temporal",
    submitted: false,
    uploadReady: false,
    status: "reviewable",
    artifacts: {
      resume: "workspace/tailored/temporal-resume.md",
      coverLetter: "workspace/tailored/temporal-cover-letter.md",
    },
    manifest: { applicationId: "app-temporal" },
    sources: { resume: "full generated resume body intentionally not replayed" },
    gaps: [{ kind: "answers", message: "Capture application questions before applying." }],
    manual: { required: true },
  };
  const calls = [];

  const result = await executeWorkspaceIntent({
    repoRoot,
    env: {},
    intent: {
      type: "job.generate-documents",
      entity: { type: "application", id: "app-temporal" },
      input: { formats: ["pdf"] },
    },
    generateDocumentsImpl: async (input) => {
      calls.push(input);
      return generation;
    },
    now: () => new Date("2026-08-09T14:04:00.000Z"),
  });

  assert.deepEqual(calls, [
    {
      repoRoot,
      env: {},
      body: { applicationId: "app-temporal", applyIntent: false, formats: ["pdf"] },
    },
  ]);
  assert.deepEqual(result.messages[1].artifacts[0], {
    kind: "packet_generation",
    title: "Temporal Labs — Applied AI Engineer — Documents",
    applicationId: "app-temporal",
    status: "reviewable",
    uploadReady: false,
    artifacts: generation.artifacts,
    gaps: generation.gaps,
  });
  assert.equal(result.messages[1].metadata.state, "reviewable");
  assert.equal(result.messages[1].metadata.gapCount, 1);
  assert.match(result.messages[1].text, /1 item needs review/i);

  const modelCalls = [];
  await runWorkspaceAgentTurn({
    repoRoot,
    env: {},
    text: "Are the documents ready to apply with?",
    callAIImpl: async (input) => {
      modelCalls.push(input);
      return { content: [{ type: "text", text: "The answer questions still need review." }] };
    },
  });
  const modelHistory = JSON.stringify(modelCalls[0].messages);
  assert.match(modelHistory, /Capture application questions before applying/);
  assert.ok(modelHistory.includes("workspace/tailored/temporal-resume.md"));
  assert.doesNotMatch(modelHistory, /full generated resume body intentionally not replayed/);
});

test("document export executes behind workspace-main and preserves packaged file context", async () => {
  const repoRoot = tempRepo();
  seedApplication(repoRoot, { evaluation: { gate: "keep" } });
  const exported = {
    appId: "app-temporal",
    applicationId: "app-temporal",
    formats: ["pdf", "docx"],
    artifacts: {
      resumePdf: "workspace/tailored/temporal-resume.pdf",
      resumeDocx: "workspace/tailored/temporal-resume.docx",
      coverLetterPdf: "workspace/tailored/temporal-cover-letter.pdf",
    },
    userFacing: {
      resume: [
        {
          format: "pdf",
          path: "workspace/tailored/temporal-resume.pdf",
          name: "temporal-resume.pdf",
        },
      ],
      coverLetter: [],
      answers: [],
    },
    downloadsErrors: [{ kind: "coverLetter", format: "pdf", message: "Downloads unavailable" }],
    registered: { id: "app-temporal" },
  };
  const calls = [];

  const result = await executeWorkspaceIntent({
    repoRoot,
    env: {},
    intent: {
      type: "job.export-documents",
      entity: { type: "application", id: "app-temporal" },
      input: { formats: ["pdf", "docx"] },
    },
    exportDocumentsImpl: async (input) => {
      calls.push(input);
      return exported;
    },
  });

  assert.deepEqual(calls, [
    {
      repoRoot,
      env: {},
      applicationId: "app-temporal",
      formats: ["pdf", "docx"],
      exportArtifact: undefined,
    },
  ]);
  assert.equal(result.operationResult, exported);
  assert.deepEqual(result.messages[1].artifacts[0], {
    kind: "packet_export",
    title: "Temporal Labs — Applied AI Engineer — Exported files",
    applicationId: "app-temporal",
    formats: ["pdf", "docx"],
    artifacts: exported.artifacts,
    userFacing: exported.userFacing,
    downloadsErrors: exported.downloadsErrors,
  });
  assert.equal(result.messages[1].metadata.state, "exported");
  assert.match(result.messages[1].text, /exported 3 packaged files/i);

  const modelCalls = [];
  await runWorkspaceAgentTurn({
    repoRoot,
    env: {},
    text: "Where is the PDF I should upload?",
    callAIImpl: async (input) => {
      modelCalls.push(input);
      return { content: [{ type: "text", text: "Use the exported resume PDF." }] };
    },
  });
  assert.match(JSON.stringify(modelCalls[0].messages), /temporal-resume\.pdf/);
  assert.match(JSON.stringify(modelCalls[0].messages), /Downloads unavailable/);
});

test("ISSUE-032 search buttons start work in workspace-main and preserve bounded search context", async () => {
  const repoRoot = tempRepo();
  const started = {
    ok: true,
    reused: false,
    run: {
      id: "manual-search-2026-08-09",
      purpose: "manual-search",
      status: "running",
      label: "Searching",
    },
    sources: {
      enabledSearches: 2,
      enabledTrackedCompanies: 1,
      deterministicSources: { attempted: 3, rss: 1, boards: 1, supportedAtsCompanies: 1 },
    },
  };
  const calls = [];

  const result = await executeWorkspaceIntent({
    repoRoot,
    env: {},
    intent: {
      type: "search.run",
      entity: { type: "workspace", id: WORKSPACE_THREAD_ID },
      input: { purpose: "manual-search" },
    },
    startManualSearchImpl: async (input) => {
      calls.push(input);
      return started;
    },
    now: () => new Date("2026-08-09T14:05:00.000Z"),
  });

  assert.deepEqual(calls, [{ repoRoot, env: {}, fetchImpl: undefined }]);
  assert.equal(result.operationResult, started);
  assert.deepEqual(
    result.messages.map(({ role, kind }) => ({ role, kind })),
    [
      { role: "user", kind: "intent" },
      { role: "assistant", kind: "action_result" },
    ]
  );
  assert.deepEqual(result.messages[1].artifacts[0], {
    kind: "search_run",
    title: "Job search — Searching",
    purpose: "manual-search",
    runId: "manual-search-2026-08-09",
    status: "running",
    reused: false,
    parked: false,
    sources: started.sources,
    summary: null,
    error: null,
  });
  assert.equal(result.messages[1].metadata.state, "running");
  assert.match(result.messages[1].text, /search started/i);
});

test("completed search results return to the same agent without replaying fetched job bodies", async () => {
  const repoRoot = tempRepo();
  await executeWorkspaceIntent({
    repoRoot,
    env: {},
    intent: {
      type: "search.run",
      entity: { type: "workspace", id: WORKSPACE_THREAD_ID },
      input: { purpose: "manual-search" },
    },
    startManualSearchImpl: async () => ({
      ok: true,
      reused: false,
      run: {
        id: "manual-search-complete-context",
        purpose: "manual-search",
        status: "running",
      },
      sources: { deterministicSources: { attempted: 1 } },
    }),
  });

  const completedRun = {
    id: "manual-search-complete-context",
    purpose: "manual-search",
    status: "completed",
    completed_at: "2026-08-09T14:06:00.000Z",
    summary: {
      attemptedSources: 1,
      scanned: 55,
      qualified: 10,
      presented: 5,
      filtered: 50,
      reconciled: 55,
      reasonCounts: { "title-mismatch": 43, "location-outside-radius": 1 },
      errorCount: 0,
      errors: [],
      offerCount: 55,
      zeroResults: false,
      offers: [{ body: "full fetched job description intentionally not replayed" }],
    },
  };
  const result = recordWorkspaceSearchCompletion({ repoRoot, env: {}, run: completedRun });

  assert.equal(result.messages.at(-1).kind, "action_result");
  assert.equal(result.messages.at(-1).metadata.searchTerminal, true);
  assert.deepEqual(result.messages.at(-1).artifacts[0].summary, {
    attemptedSources: 1,
    scanned: 55,
    qualified: 10,
    presented: 5,
    filtered: 50,
    reconciled: 55,
    reasonCounts: { "title-mismatch": 43, "location-outside-radius": 1 },
    errorCount: 0,
    errors: [],
    offerCount: 55,
    zeroResults: false,
  });
  assert.match(result.messages.at(-1).text, /5 qualified roles/i);
  assert.match(result.messages.at(-1).text, /50 filtered/i);

  const duplicate = recordWorkspaceSearchCompletion({ repoRoot, env: {}, run: completedRun });
  assert.equal(duplicate.messages.length, result.messages.length);

  const modelCalls = [];
  await runWorkspaceAgentTurn({
    repoRoot,
    env: {},
    text: "What did this search find and filter out?",
    callAIImpl: async (input) => {
      modelCalls.push(input);
      return { content: [{ type: "text", text: "Five roles passed the gate." }] };
    },
  });
  const modelHistory = JSON.stringify(modelCalls[0].messages);
  assert.match(modelHistory, /location-outside-radius/);
  assert.ok(modelCalls[0].messages.some((message) => message.content.includes('"presented":5')));
  assert.doesNotMatch(modelHistory, /full fetched job description intentionally not replayed/);
});

test("a failed action is recorded in the same conversation with an actionable recovery", async () => {
  const repoRoot = tempRepo();
  const failure = new Error("Capture the job description before building interview prep.");
  failure.code = "MISSING_JOB_BODY";

  await assert.rejects(
    executeWorkspaceIntent({
      repoRoot,
      env: {},
      intent: {
        type: "interview.prepare",
        entity: { type: "application", id: "app-no-jd" },
      },
      buildInterviewDossierImpl: () => {
        throw failure;
      },
    }),
    (error) => error.code === "MISSING_JOB_BODY" && error.workspaceThreadId === WORKSPACE_THREAD_ID
  );

  const read = workspaceThreadRead({ repoRoot, env: {} });
  assert.deepEqual(
    read.messages.map(({ role, kind }) => ({ role, kind })),
    [
      { role: "user", kind: "intent" },
      { role: "assistant", kind: "action_error" },
    ]
  );
  assert.equal(read.messages[1].error.code, "MISSING_JOB_BODY");
  assert.match(read.messages[1].text, /Capture the job description/);
});

test("free-form turns call the selected AI seam with the complete durable conversation", async () => {
  const repoRoot = tempRepo();
  const calls = [];
  const callAIImpl = async (input) => {
    calls.push(input);
    return {
      content: [{ type: "text", text: calls.length === 1 ? "First answer." : "Second answer." }],
      model: "installed:codex",
      usage: null,
    };
  };

  await runWorkspaceAgentTurn({
    repoRoot,
    env: {},
    text: "Remember that I prefer hybrid roles.",
    callAIImpl,
  });
  const second = await runWorkspaceAgentTurn({
    repoRoot,
    env: {},
    text: "What work setup do I prefer?",
    callAIImpl,
  });

  assert.equal(calls.length, 2);
  assert.equal(calls[0].root, repoRoot);
  assert.match(calls[0].system, /one durable career-search workspace agent/i);
  assert.deepEqual(calls[0].messages, [
    { role: "user", content: "Remember that I prefer hybrid roles." },
  ]);
  assert.deepEqual(calls[1].messages, [
    { role: "user", content: "Remember that I prefer hybrid roles." },
    { role: "assistant", content: "First answer." },
    { role: "user", content: "What work setup do I prefer?" },
  ]);
  assert.deepEqual(
    second.messages.map(({ role, kind, text }) => ({ role, kind, text })),
    [
      { role: "user", kind: "text", text: "Remember that I prefer hybrid roles." },
      { role: "assistant", kind: "text", text: "First answer." },
      { role: "user", kind: "text", text: "What work setup do I prefer?" },
      { role: "assistant", kind: "text", text: "Second answer." },
    ]
  );
});

test("typed action outcomes are included in later free-form agent context", async () => {
  const repoRoot = tempRepo();
  await executeWorkspaceIntent({
    repoRoot,
    env: {},
    intent: {
      type: "interview.prepare",
      entity: { type: "application", id: "app-temporal" },
    },
    buildInterviewDossierImpl: () => ({
      applicationId: "app-temporal",
      company: "Temporal Labs",
      role: "Applied AI Engineer",
      dossier: {
        title: "Temporal Labs — Applied AI Engineer",
        markdown: "# Interview Packet",
        path: "workspace/interview-prep/temporal.md",
      },
    }),
  });

  const calls = [];
  await runWorkspaceAgentTurn({
    repoRoot,
    env: {},
    text: "What did we just prepare?",
    callAIImpl: async (input) => {
      calls.push(input);
      return { content: [{ type: "text", text: "Your Temporal interview packet." }] };
    },
  });

  assert.match(calls[0].messages[0].content, /Action requested: interview\.prepare/);
  assert.match(calls[0].messages[1].content, /Action completed:/);
  assert.match(calls[0].messages[1].content, /Temporal Labs/);
  assert.equal(calls[0].messages.at(-1).content, "What did we just prepare?");
});

test("chat-first paste intake is durably captured and summarized in the same agent thread", async () => {
  const repoRoot = tempRepo();
  const calls = [];
  const text = "Temporal Labs is hiring an Applied AI Engineer in New York.";

  const result = await captureWorkspaceIntake({
    repoRoot,
    env: {},
    text,
    inputKind: "text",
    captureIntakeImpl: async (input) => {
      calls.push(input);
      return {
        id: "intake-jd-1",
        status: "proposed",
        kind: "jd-text",
        inputKind: "text",
        classification: {
          proposedAction: "Evaluate Temporal Labs — Applied AI Engineer against your gate.",
          confidence: 0.98,
          needsUser: false,
        },
        dispatchSummary: "Evaluate this job before any application work.",
      };
    },
    now: () => new Date("2026-08-09T16:00:00.000Z"),
  });

  assert.deepEqual(calls, [{ repoRoot, env: {}, text, inputKind: "text" }]);
  assert.equal(result.intake.id, "intake-jd-1");
  assert.deepEqual(
    result.messages.map(({ role, kind }) => ({ role, kind })),
    [
      { role: "user", kind: "intake" },
      { role: "assistant", kind: "action_result" },
    ]
  );
  assert.equal(result.messages[0].text, text);
  assert.match(result.messages[1].text, /Captured.*job description/i);
  assert.match(result.messages[1].text, /Evaluate Temporal Labs/i);
  assert.deepEqual(result.messages[1].entity, { type: "intake", id: "intake-jd-1" });
  assert.equal(result.messages[1].metadata.intakeStatus, "proposed");
});

test("a failed chat-first intake still preserves the original paste and visible error", async () => {
  const repoRoot = tempRepo();
  const failure = new Error("Intake storage is temporarily unavailable.");
  failure.code = "INTAKE_CAPTURE_FAILED";

  await assert.rejects(
    captureWorkspaceIntake({
      repoRoot,
      env: {},
      text: "A recruiter asked me to schedule a call next Tuesday.",
      captureIntakeImpl: async () => {
        throw failure;
      },
    }),
    (error) =>
      error.code === "INTAKE_CAPTURE_FAILED" && error.workspaceThreadId === WORKSPACE_THREAD_ID
  );

  const result = workspaceThreadRead({ repoRoot, env: {} });
  assert.deepEqual(
    result.messages.map(({ role, kind }) => ({ role, kind })),
    [
      { role: "user", kind: "intake" },
      { role: "assistant", kind: "action_error" },
    ]
  );
  assert.match(result.messages[0].text, /schedule a call/);
  assert.equal(result.messages[1].error.code, "INTAKE_CAPTURE_FAILED");
});

test("ISSUE-038 confirmed recruiter intake becomes a communication through workspace-main", async () => {
  const repoRoot = tempRepo();
  seedApplication(repoRoot);
  const rawInput = [
    "From: Jordan Lee <jordan@temporal.example>",
    "Subject: Interview availability",
    "Can you share availability for a recruiter screen next week?",
  ].join("\n");
  const captured = intakeCapture({ repoRoot, env: {}, rawInput, inputKind: "text" });
  intakeUpdate({
    repoRoot,
    env: {},
    id: captured.id,
    patch: {
      status: "confirmed",
      decision: "confirm",
      kind: "recruiter-email",
      classification: {
        kind: "recruiter-email",
        entities: {
          company: "Temporal Labs",
          role: "Applied AI Engineer",
          contactName: "Jordan Lee",
          contactEmail: "jordan@temporal.example",
        },
        proposedAction: "Add this recruiter message and prepare a reply.",
      },
      trackerMatch: {
        matched: true,
        recordType: "application",
        id: "app-temporal",
        company: "Temporal Labs",
        role: "Applied AI Engineer",
        confidence: "company_role",
      },
      dispatch: {
        lane: "W",
        action: "workspace_intent",
        params: { intentType: "communication.capture-inbound" },
      },
    },
  });

  const result = await executeWorkspaceIntent({
    repoRoot,
    env: {},
    intent: {
      type: "communication.capture-inbound",
      entity: { type: "intake", id: captured.id },
    },
    now: () => new Date("2026-08-09T18:00:00.000Z"),
  });

  const comm = readCommunication(repoRoot, result.messages.at(-1).metadata.communicationId);
  assert.equal(comm.applicationId, "app-temporal");
  assert.equal(comm.status, "needs-reply");
  assert.equal(comm.subject, "Interview availability");
  assert.equal(comm.participants[0].email, "jordan@temporal.example");
  assert.equal(comm.messages[0].artifactPath, captured.item.capturedPath);
  assert.deepEqual(
    result.messages.map(({ role, kind }) => ({ role, kind })),
    [
      { role: "user", kind: "intent" },
      { role: "assistant", kind: "action_result" },
    ]
  );
  assert.deepEqual(result.messages[0].entity, { type: "intake", id: captured.id });
  assert.equal(result.messages[1].metadata.state, "needs-reply");
  assert.match(result.messages[1].text, /captured.*recruiter message/i);
});

test("confirmed interview intake is captured on the matched application through workspace-main", async () => {
  const repoRoot = tempRepo();
  seedApplication(repoRoot, { status: "applied" });
  const captured = intakeCapture({
    repoRoot,
    env: {},
    rawInput: "Jordan invited me to an interview on January 8 at 10 AM Eastern.",
    inputKind: "text",
  });
  intakeUpdate({
    repoRoot,
    env: {},
    id: captured.id,
    patch: {
      status: "confirmed",
      decision: "confirm",
      kind: "interview-transcript",
      classification: {
        kind: "interview-transcript",
        entities: {
          company: "Temporal Labs",
          role: "Applied AI Engineer",
          contactName: "Jordan Lee",
          interviewDate: "2030-01-08T15:00:00.000Z",
        },
        proposedAction: "Capture and schedule this interview.",
      },
      trackerMatch: {
        matched: true,
        recordType: "application",
        id: "app-temporal",
        company: "Temporal Labs",
        role: "Applied AI Engineer",
        confidence: "company_role",
      },
      dispatch: {
        lane: "W",
        action: "workspace_intent",
        params: { intentType: "interview.capture-context" },
      },
    },
  });

  const result = await executeWorkspaceIntent({
    repoRoot,
    env: {},
    intent: {
      type: "interview.capture-context",
      entity: { type: "intake", id: captured.id },
    },
    now: () => new Date("2026-08-09T20:00:00.000Z"),
  });

  const app = readApplication(repoRoot, "app-temporal");
  assert.equal(app.status, "interview");
  assert.equal(app.interviewAt, "2030-01-08T15:00:00.000Z");
  assert.equal(app.conversations.at(-1).artifactPath, captured.item.capturedPath);
  assert.equal(result.messages[0].intent.type, "interview.capture-context");
  assert.equal(result.messages[1].metadata.applicationId, "app-temporal");
  assert.equal(result.messages[1].metadata.scheduled, true);
  assert.match(result.messages[1].text, /captured.*interview/i);
});

test("I applied elsewhere records only the user-reported outcome in the same thread", async () => {
  const repoRoot = tempRepo();
  seedApplication(repoRoot);

  const result = await executeWorkspaceIntent({
    repoRoot,
    env: {},
    intent: {
      type: "application.record-external",
      entity: { type: "application", id: "app-temporal" },
      input: { appliedAt: "2026-08-08T19:30:00.000Z" },
    },
    now: () => new Date("2026-08-09T14:03:00.000Z"),
  });

  const app = readApplication(repoRoot, "app-temporal");
  assert.equal(app.status, "applied");
  assert.equal(app.appliedAt, "2026-08-08T19:30:00.000Z");
  assert.match(app.statusNote, /outside CareerRat/i);
  assert.deepEqual(
    result.messages.map(({ role, kind }) => ({ role, kind })),
    [
      { role: "user", kind: "intent" },
      { role: "assistant", kind: "action_result" },
    ]
  );
  assert.match(result.messages[1].text, /recorded.*applied outside CareerRat/i);
  assert.deepEqual(result.messages[1].metadata, {
    intentMessageId: result.messages[0].id,
    state: "recorded",
    recordingMode: "external_report",
    submissionVerified: false,
    appliedAt: "2026-08-08T19:30:00.000Z",
  });
});

test("chat-first outcome buttons update the application and remain visible in workspace-main", async () => {
  const repoRoot = tempRepo();
  seedApplication(repoRoot, { status: "interview" });

  const result = await executeWorkspaceIntent({
    repoRoot,
    env: {},
    intent: {
      type: "outcome.record",
      entity: { type: "application", id: "app-temporal" },
      input: { to: "rejected", note: "Role was filled internally." },
    },
  });

  const app = readApplication(repoRoot, "app-temporal");
  assert.equal(app.status, "rejected");
  assert.equal(app.statusNote, "Role was filled internally.");
  assert.equal(result.messages[0].intent.type, "outcome.record");
  assert.equal(result.messages[1].kind, "action_result");
  assert.equal(result.messages[1].metadata.previousState, "interview");
  assert.equal(result.messages[1].metadata.state, "rejected");
  assert.match(result.messages[1].text, /recorded.*rejected/i);
});

test("sourced Promote and Skip buttons execute as typed actions in workspace-main", async () => {
  const promoteRoot = tempRepo();
  seedSourced(promoteRoot);

  const promoted = await executeWorkspaceIntent({
    repoRoot: promoteRoot,
    env: {},
    intent: {
      type: "sourced.promote",
      entity: { type: "sourced", id: "sourced-temporal" },
    },
  });

  assert.equal(readSourced(promoteRoot, "sourced-temporal"), null);
  assert.equal(readApplication(promoteRoot, "sourced-temporal").status, "reviewed-hold");
  assert.equal(promoted.messages[0].intent.type, "sourced.promote");
  assert.equal(promoted.messages[1].metadata.state, "promoted");

  const skipRoot = tempRepo();
  seedSourced(skipRoot);
  const skipped = await executeWorkspaceIntent({
    repoRoot: skipRoot,
    env: {},
    intent: {
      type: "sourced.skip",
      entity: { type: "sourced", id: "sourced-temporal" },
      input: { note: "Too much travel." },
    },
  });

  assert.equal(readSourced(skipRoot, "sourced-temporal").status, "cut");
  assert.equal(skipped.messages[0].intent.type, "sourced.skip");
  assert.equal(skipped.messages[1].metadata.state, "cut");
  assert.match(skipped.messages[1].text, /skipped/i);
});

test("manual interview scheduling is a typed workspace action with canonical round context", async () => {
  const repoRoot = tempRepo();
  seedApplication(repoRoot);

  const result = await executeWorkspaceIntent({
    repoRoot,
    env: {},
    intent: {
      type: "interview.schedule",
      entity: { type: "application", id: "app-temporal" },
      input: {
        at: "2030-08-14T18:30:00.000Z",
        round: "hiring manager",
        note: "With Avery",
      },
    },
  });

  const app = readApplication(repoRoot, "app-temporal");
  assert.equal(app.interviewAt, "2030-08-14T18:30:00.000Z");
  assert.equal(app.conversations.at(-1).kind, "hiring manager");
  assert.equal(result.messages[0].intent.type, "interview.schedule");
  assert.equal(result.messages[1].metadata.state, "scheduled");
  assert.equal(result.messages[1].metadata.round, "hiring manager");
});

test("communication notes and user-reported sends stay in workspace-main", async () => {
  const repoRoot = tempRepo();
  seedApplication(repoRoot);
  seedCommunication(repoRoot, {
    status: "drafted",
    draft: { subject: "Re: Interview availability", body: "Tuesday afternoon works." },
  });

  await executeWorkspaceIntent({
    repoRoot,
    env: {},
    intent: {
      type: "communication.add-note",
      entity: { type: "communication", id: "comm-temporal-recruiter" },
      input: { summary: "Candidate prefers Tuesday afternoon." },
    },
  });
  const result = await executeWorkspaceIntent({
    repoRoot,
    env: {},
    intent: {
      type: "communication.record-external",
      entity: { type: "communication", id: "comm-temporal-recruiter" },
      input: { sentAt: "2026-08-09T17:30:00.000Z" },
    },
  });

  const comm = readCommunication(repoRoot, "comm-temporal-recruiter");
  assert.equal(comm.status, "waiting");
  assert.equal(comm.draft, null);
  assert.equal(comm.messages.at(-2).direction, "note");
  assert.equal(comm.messages.at(-1).direction, "outbound-sent");
  assert.equal(result.messages.at(-2).intent.type, "communication.record-external");
  assert.equal(result.messages.at(-1).metadata.deliveryVerified, false);
  assert.equal(result.messages.at(-1).metadata.recordingMode, "external_report");
});

test("Apply on site cannot mark an application applied without a verified executor", async () => {
  const repoRoot = tempRepo();
  seedApplication(repoRoot);

  await assert.rejects(
    executeWorkspaceIntent({
      repoRoot,
      env: {},
      intent: {
        type: "job.apply",
        entity: { type: "application", id: "app-temporal" },
      },
    }),
    (error) =>
      error.code === "APPLICATION_EXECUTOR_UNAVAILABLE" &&
      error.workspaceThreadId === WORKSPACE_THREAD_ID
  );

  assert.equal(readApplication(repoRoot, "app-temporal").status, "reviewed-hold");
  const thread = workspaceThreadRead({ repoRoot, env: {} });
  assert.deepEqual(
    thread.messages.map(({ role, kind }) => ({ role, kind })),
    [
      { role: "user", kind: "intent" },
      { role: "assistant", kind: "action_error" },
    ]
  );
  assert.equal(thread.messages[1].error.code, "APPLICATION_EXECUTOR_UNAVAILABLE");
  assert.match(thread.messages[1].text, /not marked Applied/i);
});

test("Apply on site writes Applied only after its executor returns verified confirmation", async () => {
  const repoRoot = tempRepo();
  seedApplication(repoRoot);

  await assert.rejects(
    executeWorkspaceIntent({
      repoRoot,
      env: {},
      intent: {
        type: "job.apply",
        entity: { type: "application", id: "app-temporal" },
      },
      applyJobImpl: async () => ({ verified: false, reason: "No confirmation page found." }),
    }),
    (error) => error.code === "APPLICATION_NOT_VERIFIED"
  );
  assert.equal(readApplication(repoRoot, "app-temporal").status, "reviewed-hold");

  const calls = [];
  const result = await executeWorkspaceIntent({
    repoRoot,
    env: {},
    intent: {
      type: "job.apply",
      entity: { type: "application", id: "app-temporal" },
    },
    applyJobImpl: async (input) => {
      calls.push(input);
      return {
        verified: true,
        submittedAt: "2026-08-09T15:45:00.000Z",
        confirmation: "Application received",
      };
    },
    now: () => new Date("2026-08-09T15:45:00.000Z"),
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].applicationId, "app-temporal");
  const app = readApplication(repoRoot, "app-temporal");
  assert.equal(app.status, "applied");
  assert.equal(app.appliedAt, "2026-08-09T15:45:00.000Z");
  assert.match(app.statusNote, /verified/i);
  assert.equal(result.messages.at(-1).kind, "action_result");
  assert.equal(result.messages.at(-1).metadata.submissionVerified, true);
  assert.equal(result.messages.at(-1).metadata.confirmation, "Application received");
});

test("Draft reply uses the same agent context and persists a reviewable communication draft", async () => {
  const repoRoot = tempRepo();
  seedApplication(repoRoot);
  seedCommunication(repoRoot);
  const calls = [];

  const result = await executeWorkspaceIntent({
    repoRoot,
    env: {},
    intent: {
      type: "communication.draft",
      entity: { type: "communication", id: "comm-temporal-recruiter" },
      input: { instruction: "Offer Tuesday or Wednesday afternoon." },
    },
    callAIImpl: async (input) => {
      calls.push(input);
      return {
        content: [
          {
            type: "text",
            text: "Thanks for reaching out. I’m available Tuesday or Wednesday afternoon next week.",
          },
        ],
        model: "installed:claude",
      };
    },
    now: () => new Date("2026-08-09T17:00:00.000Z"),
  });

  assert.equal(calls.length, 1);
  assert.match(calls[0].system, /Interview availability/);
  assert.match(calls[0].system, /Tuesday or Wednesday afternoon/);
  const comm = readCommunication(repoRoot, "comm-temporal-recruiter");
  assert.equal(comm.status, "drafted");
  assert.match(comm.draft.body, /Tuesday or Wednesday afternoon/);
  assert.equal(comm.nextAction, "Review and send reply");
  assert.equal(result.messages.at(-1).kind, "action_result");
  assert.equal(result.messages.at(-1).artifacts[0].kind, "communication_draft");
  assert.equal(result.messages.at(-1).metadata.sent, false);
  assert.equal(result.messages.at(-1).metadata.requiresReview, true);
});

test("Send reply cannot clear a draft until its delivery executor verifies the send", async () => {
  const repoRoot = tempRepo();
  seedApplication(repoRoot);
  seedCommunication(repoRoot, {
    status: "drafted",
    draft: { subject: "Re: Interview availability", body: "Tuesday afternoon works for me." },
  });

  await assert.rejects(
    executeWorkspaceIntent({
      repoRoot,
      env: {},
      intent: {
        type: "communication.send",
        entity: { type: "communication", id: "comm-temporal-recruiter" },
      },
    }),
    (error) => error.code === "COMMUNICATION_EXECUTOR_UNAVAILABLE"
  );
  assert.equal(readCommunication(repoRoot, "comm-temporal-recruiter").status, "drafted");
  assert.ok(readCommunication(repoRoot, "comm-temporal-recruiter").draft);

  const result = await executeWorkspaceIntent({
    repoRoot,
    env: {},
    intent: {
      type: "communication.send",
      entity: { type: "communication", id: "comm-temporal-recruiter" },
    },
    sendCommunicationImpl: async () => ({
      verified: true,
      sentAt: "2026-08-09T17:30:00.000Z",
      confirmation: "Provider accepted message",
    }),
  });

  const comm = readCommunication(repoRoot, "comm-temporal-recruiter");
  assert.equal(comm.status, "waiting");
  assert.equal(comm.draft, null);
  assert.equal(comm.messages.at(-1).direction, "outbound-sent");
  assert.equal(result.messages.at(-1).metadata.deliveryVerified, true);
  assert.equal(result.messages.at(-1).metadata.confirmation, "Provider accepted message");
});

test("AI failures stay visible in the same durable thread", async () => {
  const repoRoot = tempRepo();
  const failure = new Error("Selected CLI needs sign-in.");
  failure.code = "RUNTIME_EXIT";

  await assert.rejects(
    runWorkspaceAgentTurn({
      repoRoot,
      env: {},
      text: "Help me prioritize today.",
      callAIImpl: async () => {
        throw failure;
      },
    }),
    (error) => error.code === "RUNTIME_EXIT" && error.workspaceThreadId === WORKSPACE_THREAD_ID
  );

  const read = workspaceThreadRead({ repoRoot, env: {} });
  assert.deepEqual(
    read.messages.map(({ role, kind }) => ({ role, kind })),
    [
      { role: "user", kind: "text" },
      { role: "assistant", kind: "agent_error" },
    ]
  );
  assert.equal(read.messages[1].error.code, "RUNTIME_EXIT");
  assert.match(read.messages[1].text, /needs sign-in/i);
});

test("one workspace runtime serializes overlapping turns so later context cannot race", async () => {
  const repoRoot = tempRepo();
  const releases = [];
  const calls = [];
  const runtime = createWorkspaceAgentRuntime({
    repoRoot,
    env: {},
    callAIImpl: async (input) => {
      calls.push(input);
      await new Promise((resolve) => releases.push(resolve));
      return { content: [{ type: "text", text: `Answer ${calls.length}.` }] };
    },
  });

  const first = runtime.runTurn({ text: "First question." });
  await Promise.resolve();
  await Promise.resolve();
  const second = runtime.runTurn({ text: "Second question." });
  await Promise.resolve();
  await Promise.resolve();

  assert.equal(calls.length, 1, "the second runtime call must wait for the first answer");
  releases.shift()();
  await first;
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[1].messages, [
    { role: "user", content: "First question." },
    { role: "assistant", content: "Answer 1." },
    { role: "user", content: "Second question." },
  ]);
  releases.shift()();
  const final = await second;
  assert.deepEqual(
    final.messages.map(({ role, text }) => ({ role, text })),
    [
      { role: "user", text: "First question." },
      { role: "assistant", text: "Answer 1." },
      { role: "user", text: "Second question." },
      { role: "assistant", text: "Answer 2." },
    ]
  );
});

function mountDirect(repoRoot, executeIntentImpl, runTurnImpl, captureIntakeImpl) {
  const routes = new Map();
  mountWorkspaceAgentRoutes({
    addRoute(method, path, handler) {
      routes.set(`${method} ${path}`, handler);
    },
    repoRoot,
    env: {},
    executeIntentImpl,
    runTurnImpl,
    captureIntakeImpl,
  });
  return routes;
}

async function callDirect(routes, method, path, payload) {
  const handler = routes.get(`${method} ${path}`);
  assert.ok(handler, `expected mounted route for ${method} ${path}`);
  const req = Readable.from(
    payload === undefined ? [] : [Buffer.from(JSON.stringify(payload), "utf8")]
  );
  req.method = method;
  req.url = path;
  req.headers = payload === undefined ? {} : { "content-type": "application/json" };
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

test("workspace agent routes expose the one thread and route button intents through it", async () => {
  const repoRoot = tempRepo();
  const seen = [];
  const routes = mountDirect(repoRoot, (input) => {
    seen.push(input);
    workspaceIntentAppend({ repoRoot, env: {}, intent: input.intent });
    workspaceMessageAppend({
      repoRoot,
      env: {},
      role: "assistant",
      kind: "action_result",
      text: "Interview packet prepared.",
    });
    return workspaceThreadRead({ repoRoot, env: {} });
  });

  const opened = await callDirect(routes, "GET", "/api/workspace/thread");
  assert.equal(opened.status, 200);
  assert.equal(opened.body.data.thread.id, WORKSPACE_THREAD_ID);

  const acted = await callDirect(routes, "POST", "/api/workspace/intent", {
    intent: {
      type: "interview.prepare",
      entity: { type: "application", id: "app-temporal" },
    },
  });
  assert.equal(acted.status, 200);
  assert.equal(seen.length, 1);
  assert.equal(acted.body.data.thread.id, WORKSPACE_THREAD_ID);
  assert.equal(acted.body.data.messages.length, 2);
});

test("workspace message route waits for the same agent turn and returns its durable reply", async () => {
  const repoRoot = tempRepo();
  const seen = [];
  const routes = mountDirect(repoRoot, undefined, async (input) => {
    seen.push(input);
    workspaceMessageAppend({ repoRoot, env: {}, role: "user", text: input.text });
    workspaceMessageAppend({ repoRoot, env: {}, role: "assistant", text: "Same thread reply." });
    return workspaceThreadRead({ repoRoot, env: {} });
  });

  const response = await callDirect(routes, "POST", "/api/workspace/message", {
    text: "Keep the context from setup.",
  });
  assert.equal(response.status, 200);
  assert.equal(seen.length, 1);
  assert.equal(response.body.data.thread.id, WORKSPACE_THREAD_ID);
  assert.equal(response.body.data.messages.at(-1).text, "Same thread reply.");
});

test("workspace intake route sends paste and link captures through the same serialized agent", async () => {
  const repoRoot = tempRepo();
  const seen = [];
  const routes = mountDirect(repoRoot, undefined, undefined, async (input) => {
    seen.push(input);
    return {
      thread: { id: WORKSPACE_THREAD_ID },
      messages: [],
      intake: { id: "intake-link-1", status: "proposed" },
    };
  });

  const response = await callDirect(routes, "POST", "/api/workspace/intake", {
    text: "https://jobs.example.test/temporal/applied-ai-engineer",
    inputKind: "url",
  });
  assert.equal(response.status, 200);
  assert.equal(seen.length, 1);
  assert.equal(seen[0].text, "https://jobs.example.test/temporal/applied-ai-engineer");
  assert.equal(seen[0].inputKind, "url");
  assert.equal(response.body.data.intake.id, "intake-link-1");
});
