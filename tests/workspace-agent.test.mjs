import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
  workspaceOnboardingHandoff,
  workspaceThreadOpen,
  workspaceThreadRead,
} from "../src/core/agent/workspace-thread.mjs";
import { closeAll, openDb } from "../src/core/db/connection.mjs";
import { ALL_MIGRATIONS } from "../src/core/db/migrations.mjs";
import { appRegisterPacketQuestionCapture, appUpsert } from "../src/core/db/verbs/app.mjs";
import { calendarBusyUpsert } from "../src/core/db/verbs/calendar.mjs";
import { candidateConfigPatch } from "../src/core/db/verbs/candidate.mjs";
import { commUpsert } from "../src/core/db/verbs/comm.mjs";
import { intakeCapture, intakeUpdate } from "../src/core/db/verbs/intake.mjs";
import { sourcedUpsertBatch } from "../src/core/db/verbs/sourced.mjs";
import { userPath } from "../src/core/paths/workspace.mjs";
import {
  readResearch,
  researchRelPath,
  writeResearch,
} from "../src/core/research/research-store.mjs";

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

function preparedApplyDeps(overrides = {}) {
  return {
    evaluateJobImpl: async ({ body }) => ({
      status: 200,
      body: {
        ok: true,
        data: {
          applicationId: body.applicationId,
          gate: "keep",
          fitScore: 92,
          fitReasons: ["Strong fit"],
          manual: { required: false },
        },
      },
    }),
    generateDocumentsImpl: async () => ({
      status: "ready",
      uploadReady: true,
      gaps: [],
      artifacts: {
        resumePdf: "workspace/tailored/temporal-resume.pdf",
        coverLetterPdf: "workspace/tailored/temporal-cover-letter.pdf",
      },
    }),
    ...overrides,
  };
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

test("onboarding handoff prepends Paul context once without disturbing work already in flight", () => {
  const repoRoot = tempRepo();
  workspaceMessageAppend({
    repoRoot,
    env: {},
    role: "user",
    kind: "intent",
    text: "Search for qualified jobs (workspace:workspace-main).",
    intent: {
      type: "search.run",
      entity: { type: "workspace", id: WORKSPACE_THREAD_ID },
      input: { purpose: "first-search" },
    },
    entity: { type: "workspace", id: WORKSPACE_THREAD_ID },
    now: new Date("2026-08-14T20:00:00.000Z"),
    id: "existing-search-intent",
  });

  const input = {
    repoRoot,
    env: {},
    transcript: [
      { role: "receipt", text: "Résumé saved." },
      { role: "user", text: "I want product-facing fintech roles at large companies." },
      { role: "assistant", text: "Got it. I’ll keep all companies in play and focus there." },
      { role: "assistant", text: "   " },
    ],
    handoffText: "Setup is complete and your first search is underway. I’ll continue here.",
    finishedAt: "2026-08-14T20:01:00.000Z",
    now: new Date("2026-08-14T20:01:00.000Z"),
  };

  const first = workspaceOnboardingHandoff(input);
  assert.equal(first.reused, false);
  assert.deepEqual(
    workspaceThreadRead({ repoRoot, env: {} }).messages.map((message) => ({
      id: message.id,
      sequence: message.sequence,
      role: message.role,
      kind: message.kind,
      text: message.text,
      source: message.metadata?.source,
    })),
    [
      {
        id: first.messages[0].id,
        sequence: 1,
        role: "user",
        kind: "text",
        text: "I want product-facing fintech roles at large companies.",
        source: "onboarding",
      },
      {
        id: first.messages[1].id,
        sequence: 2,
        role: "assistant",
        kind: "text",
        text: "Got it. I’ll keep all companies in play and focus there.",
        source: "onboarding",
      },
      {
        id: first.messages[2].id,
        sequence: 3,
        role: "assistant",
        kind: "text",
        text: "Setup is complete and your first search is underway. I’ll continue here.",
        source: "onboarding",
      },
      {
        id: "existing-search-intent",
        sequence: 4,
        role: "user",
        kind: "intent",
        text: "Search for qualified jobs (workspace:workspace-main).",
        source: undefined,
      },
    ]
  );

  const replay = workspaceOnboardingHandoff(input);
  assert.equal(replay.reused, true);
  assert.equal(workspaceThreadRead({ repoRoot, env: {} }).messages.length, 4);

  const changed = workspaceOnboardingHandoff({
    ...input,
    transcript: [...input.transcript, { role: "user", text: "Remote is fine too." }],
    now: new Date("2026-08-14T20:02:00.000Z"),
  });
  assert.equal(changed.reused, false);
  const changedMessages = workspaceThreadRead({ repoRoot, env: {} }).messages;
  assert.deepEqual(
    changedMessages.map((message) => message.text),
    [
      "I want product-facing fintech roles at large companies.",
      "Got it. I’ll keep all companies in play and focus there.",
      "Remote is fine too.",
      "Setup is complete and your first search is underway. I’ll continue here.",
      "Search for qualified jobs (workspace:workspace-main).",
    ]
  );
  assert.equal(
    changedMessages.filter((message) => message.id === "existing-search-intent").length,
    1
  );
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

test("company discovery and proposal decisions are typed workspace intents", () => {
  const repoRoot = tempRepo();

  workspaceIntentAppend({
    repoRoot,
    env: {},
    intent: {
      type: "company.discover",
      entity: { type: "workspace", id: WORKSPACE_THREAD_ID },
    },
  });
  workspaceIntentAppend({
    repoRoot,
    env: {},
    intent: {
      type: "company.proposal-decide",
      entity: { type: "company-proposal", id: "proposal-acme" },
      input: { batchId: "batch-acme", action: "reject", expectedVersion: 1 },
    },
  });

  assert.deepEqual(
    workspaceThreadRead({ repoRoot, env: {} }).messages.map((message) => message.intent.type),
    ["company.discover", "company.proposal-decide"]
  );
});

test("job-board discovery starts a visible research session inside workspace-main", async () => {
  const repoRoot = tempRepo();
  const calls = [];

  const result = await executeWorkspaceIntent({
    repoRoot,
    env: {},
    intent: {
      type: "source.discover",
      entity: { type: "workspace", id: WORKSPACE_THREAD_ID },
      input: { request: "find more job boards for me" },
    },
    startBoardDiscoveryImpl: async (input) => {
      calls.push(input);
      return {
        chat: {
          chatId: "research-boards-chat",
          skill: "research-boards",
          state: "running",
          reused: false,
        },
      };
    },
    now: () => new Date("2026-08-09T14:02:30.000Z"),
  });

  assert.deepEqual(calls, [
    {
      repoRoot,
      env: {},
      request: "find more job boards for me",
    },
  ]);
  assert.deepEqual(
    result.messages.map(({ role, kind }) => ({ role, kind })),
    [
      { role: "user", kind: "intent" },
      { role: "assistant", kind: "action_result" },
    ]
  );
  assert.deepEqual(result.messages.at(-1).artifacts, [
    {
      kind: "board_discovery_chat",
      title: "Job board discovery",
      chatId: "research-boards-chat",
      skill: "research-boards",
      state: "running",
      reused: false,
    },
  ]);
  assert.deepEqual(result.messages.at(-1).metadata.nextActions, [
    { label: "Search jobs", href: "/jobs?tab=search" },
    { label: "Manage sources", href: "/settings" },
  ]);
});

// ---------------------------------------------------------------------------
// research.company / research.comp / company.health — the "research trio"
// (chat-start, freshness short-circuit, and resolveReferencedCompany's
// not-found/ambiguous/not-tracked guards).
// ---------------------------------------------------------------------------

test("research.company starts a visible research chat when no company research is on file", async () => {
  const repoRoot = tempRepo();
  const calls = [];

  const result = await executeWorkspaceIntent({
    repoRoot,
    env: {},
    intent: {
      type: "research.company",
      entity: { type: "company", id: "swift-logistics" },
      input: { company: "Swift Logistics" },
    },
    startCompanyResearchImpl: async (input) => {
      calls.push(input);
      return {
        chat: {
          chatId: "research-company-chat",
          skill: "research-company",
          state: "running",
          reused: false,
        },
      };
    },
    now: () => new Date("2026-08-15T14:00:00.000Z"),
  });

  assert.deepEqual(calls, [
    { repoRoot, env: {}, request: "Research Swift Logistics for the candidate." },
  ]);
  assert.deepEqual(
    result.messages.map(({ role, kind }) => ({ role, kind })),
    [
      { role: "user", kind: "intent" },
      { role: "assistant", kind: "action_result" },
    ]
  );
  assert.deepEqual(result.messages.at(-1).artifacts, [
    {
      kind: "research_chat",
      title: "Researching Swift Logistics",
      chatId: "research-company-chat",
      skill: "research-company",
      state: "running",
      reused: false,
    },
  ]);
  assert.equal(
    result.messages.at(-1).text,
    "Started researching Swift Logistics. CareerRat will cite every claim."
  );
});

test("research.comp starts a visible research chat when no fresh benchmark is on file", async () => {
  const repoRoot = tempRepo();
  const calls = [];

  const result = await executeWorkspaceIntent({
    repoRoot,
    env: {},
    intent: {
      type: "research.comp",
      entity: { type: "workspace", id: WORKSPACE_THREAD_ID },
      input: { role: "Registered Nurse", location: "Denver, CO" },
    },
    startCompResearchImpl: async (input) => {
      calls.push(input);
      return {
        chat: {
          chatId: "research-comp-chat",
          skill: "research-comp",
          state: "running",
          reused: false,
        },
      };
    },
  });

  assert.deepEqual(calls, [
    { repoRoot, env: {}, request: "Benchmark market comp for Registered Nurse in Denver, CO." },
  ]);
  assert.deepEqual(result.messages.at(-1).artifacts, [
    {
      kind: "research_chat",
      title: "Market comp research",
      chatId: "research-comp-chat",
      skill: "research-comp",
      state: "running",
      reused: false,
    },
  ]);
  assert.equal(
    result.messages.at(-1).text,
    "Started market comp research for Registered Nurse in Denver, CO. CareerRat will cite every figure."
  );
});

test("company.health starts a visible research chat for a tracked application with no rating on file", async () => {
  const repoRoot = tempRepo();
  seedApplication(repoRoot, {
    id: "app-riverside",
    company: "Riverside Health",
    role: "Registered Nurse",
  });
  const calls = [];

  const result = await executeWorkspaceIntent({
    repoRoot,
    env: {},
    intent: {
      type: "company.health",
      entity: { type: "application", id: "app-riverside" },
      input: {},
    },
    startCompanyHealthImpl: async (input) => {
      calls.push(input);
      return {
        chat: {
          chatId: "company-health-chat",
          skill: "company-health",
          state: "running",
          reused: false,
        },
      };
    },
  });

  assert.deepEqual(calls, [
    {
      repoRoot,
      env: {},
      request: "Check company health for Riverside Health (Registered Nurse role).",
    },
  ]);
  assert.deepEqual(result.messages.at(-1).artifacts, [
    {
      kind: "research_chat",
      title: "Company health — Riverside Health",
      chatId: "company-health-chat",
      skill: "company-health",
      state: "running",
      reused: false,
    },
  ]);
  assert.equal(
    result.messages.at(-1).text,
    "Started a company-health check for Riverside Health. This stays internal and never reaches the company."
  );
});

test("research.company reuses a fresh company-research artifact without starting a new chat", async () => {
  const repoRoot = tempRepo();
  const today = new Date().toISOString().slice(0, 10);
  writeResearch({
    stem: "swift-logistics",
    root: repoRoot,
    text: [
      "---",
      "type: company-research",
      "company: Swift Logistics",
      `fetchedAt: ${today}`,
      "staleness_days: 14",
      "sources:",
      '  - url: "https://example.com/swift-logistics"',
      '    title: "Swift Logistics expands regional routes"',
      "    confidence: high",
      "---",
      "",
      "## Overview",
      `Swift Logistics runs regional freight routes. [source: "Swift Logistics expands regional routes" (https://example.com/swift-logistics), fetched ${today}, confidence: high]`,
      "",
    ].join("\n"),
  });

  const result = await executeWorkspaceIntent({
    repoRoot,
    env: {},
    intent: {
      type: "research.company",
      entity: { type: "company", id: "swift-logistics" },
      input: { company: "Swift Logistics" },
    },
    startCompanyResearchImpl: async () => {
      throw new Error("must not start a new chat when research is still fresh");
    },
  });

  const artifact = result.messages.at(-1).artifacts[0];
  assert.equal(artifact.kind, "company_research");
  assert.equal(artifact.company, "Swift Logistics");
  assert.equal(artifact.slug, "swift-logistics");
  assert.equal(artifact.path, researchRelPath("swift-logistics"));
  assert.equal(artifact.stale, false);
  assert.equal(artifact.sources, 1);
  assert.match(artifact.markdown, /Swift Logistics runs regional freight routes/);
  assert.equal(result.messages.at(-1).metadata.state, "reused");
  assert.deepEqual(result.messages.at(-1).metadata.nextActions, [
    {
      label: "Refresh research",
      intent: {
        type: "research.company",
        entity: { type: "company", id: "swift-logistics" },
        input: { company: "Swift Logistics", force: true },
      },
    },
  ]);
});

test("research.comp reuses a fresh comp benchmark without starting a new chat", async () => {
  const repoRoot = tempRepo();
  const today = new Date().toISOString().slice(0, 10);
  writeResearch({
    stem: "comp-bench-registered-nurse-denver-co-2026-08",
    root: repoRoot,
    text: [
      "---",
      "type: comp-benchmark",
      "role: Registered Nurse",
      "location: Denver, CO",
      `fetchedAt: ${today}`,
      "staleness_days: 30",
      "sources:",
      '  - url: "https://example.com/nurse-pay"',
      '    title: "Denver hospital system nurse pay survey"',
      "    confidence: high",
      "benchmark:",
      "  floor: 82000",
      "  midpoint: 94000",
      "  ceiling: 108000",
      '  currency: "USD"',
      "  confidence: high",
      "---",
      "",
      "## Market range",
      `Denver registered nurses earn roughly $82,000-$108,000. [source: "Denver hospital system nurse pay survey" (https://example.com/nurse-pay), fetched ${today}, confidence: high]`,
      "",
    ].join("\n"),
  });

  const result = await executeWorkspaceIntent({
    repoRoot,
    env: {},
    intent: {
      type: "research.comp",
      entity: { type: "workspace", id: WORKSPACE_THREAD_ID },
      input: { role: "Registered Nurse", location: "Denver, CO" },
    },
    startCompResearchImpl: async () => {
      throw new Error("must not start a new chat when the benchmark is still fresh");
    },
  });

  const artifact = result.messages.at(-1).artifacts[0];
  assert.equal(artifact.kind, "comp_benchmark");
  assert.equal(artifact.role, "Registered Nurse");
  assert.equal(artifact.location, "Denver, CO");
  assert.deepEqual(artifact.benchmark, {
    floor: 82000,
    midpoint: 94000,
    ceiling: 108000,
    currency: "USD",
    confidence: "high",
  });
  assert.match(artifact.markdown, /Denver registered nurses earn roughly/);
  assert.equal(result.messages.at(-1).metadata.state, "reused");
  assert.deepEqual(result.messages.at(-1).metadata.nextActions, [
    {
      label: "Refresh benchmark",
      intent: {
        type: "research.comp",
        entity: { type: "workspace", id: WORKSPACE_THREAD_ID },
        input: { role: "Registered Nurse", location: "Denver, CO", force: true },
      },
    },
  ]);
});

test("company.health reuses a fresh rating already on the tracked row, and input.force bypasses it", async () => {
  const repoRoot = tempRepo();
  seedApplication(repoRoot, {
    id: "app-riverside",
    company: "Riverside Health",
    role: "Registered Nurse",
    companyHealth: {
      rating: "watch",
      forFunction: "clinical staffing",
      asOf: "2026-08-10",
      provenance: "built-from-data",
      dimensions: { layoffRisk: "elevated" },
      crossCut: ["stability"],
      fitDelta: -3,
      rationale: "A hiring freeze was announced for non-clinical roles.",
    },
  });

  const reused = await executeWorkspaceIntent({
    repoRoot,
    env: {},
    intent: {
      type: "company.health",
      entity: { type: "application", id: "app-riverside" },
      input: {},
    },
    startCompanyHealthImpl: async () => {
      throw new Error("must not start a new chat while the rating is still fresh");
    },
    now: () => new Date("2026-08-15T00:00:00.000Z"),
  });

  const reusedArtifact = reused.messages.at(-1).artifacts[0];
  assert.equal(reusedArtifact.kind, "company_health");
  assert.equal(reusedArtifact.applicationId, "app-riverside");
  assert.equal(reusedArtifact.rating, "watch");
  assert.equal(reusedArtifact.fitDelta, -3);
  assert.equal(reused.messages.at(-1).metadata.state, "reused");

  const calls = [];
  const forced = await executeWorkspaceIntent({
    repoRoot,
    env: {},
    intent: {
      type: "company.health",
      entity: { type: "application", id: "app-riverside" },
      input: { force: true },
    },
    startCompanyHealthImpl: async (input) => {
      calls.push(input);
      return {
        chat: {
          chatId: "company-health-chat-2",
          skill: "company-health",
          state: "running",
          reused: false,
        },
      };
    },
    now: () => new Date("2026-08-15T00:00:00.000Z"),
  });

  assert.equal(calls.length, 1, "force:true must bypass the fresh-rating short-circuit");
  assert.equal(forced.messages.at(-1).artifacts[0].kind, "research_chat");
});

test("research.company-request throws COMPANY_NOT_FOUND when no tracked company matches", async () => {
  const repoRoot = tempRepo();
  seedApplication(repoRoot, { id: "app-temporal", company: "Temporal Labs" });

  await assert.rejects(
    executeWorkspaceIntent({
      repoRoot,
      env: {},
      intent: {
        type: "research.company-request",
        entity: { type: "workspace", id: WORKSPACE_THREAD_ID },
        input: { companyReference: "Nonexistent Freight Co" },
      },
    }),
    (error) => error.code === "COMPANY_NOT_FOUND"
  );
});

test("resolveReferencedCompany caps ambiguous matches at 5 and never guesses one", async () => {
  const repoRoot = tempRepo();
  const companies = [
    "Regional Freight Co",
    "Regional Medical Center",
    "Regional Logistics Group",
    "Regional Housing Authority",
    "Regional Utilities",
    "Regional Transit Authority",
  ];
  companies.forEach((company, index) => {
    seedSourced(repoRoot, {
      id: `sourced-regional-${index}`,
      company,
      role: "Coordinator",
      link: `https://jobs.example.test/regional-${index}/coordinator`,
    });
  });

  await assert.rejects(
    executeWorkspaceIntent({
      repoRoot,
      env: {},
      intent: {
        type: "research.company-request",
        entity: { type: "workspace", id: WORKSPACE_THREAD_ID },
        input: { companyReference: "Regional" },
      },
    }),
    (error) => {
      assert.equal(error.code, "COMPANY_AMBIGUOUS");
      assert.equal(error.details.matches.length, 5, "matches must be capped at 5");
      for (const match of error.details.matches) {
        assert.ok(companies.includes(match.company), `unexpected match: ${match.company}`);
      }
      return true;
    }
  );
});

test("company.health-request throws COMPANY_NOT_TRACKED for a company with no saved job", async () => {
  const repoRoot = tempRepo();
  seedApplication(repoRoot, { id: "app-temporal", company: "Temporal Labs" });

  await assert.rejects(
    executeWorkspaceIntent({
      repoRoot,
      env: {},
      intent: {
        type: "company.health-request",
        entity: { type: "workspace", id: WORKSPACE_THREAD_ID },
        input: { companyReference: "Untracked Freight Co" },
      },
    }),
    (error) => error.code === "COMPANY_NOT_TRACKED"
  );
});

test("research.comp requires role and location when there is no open job to infer them from", async () => {
  const repoRoot = tempRepo();

  await assert.rejects(
    executeWorkspaceIntent({
      repoRoot,
      env: {},
      intent: {
        type: "research.comp",
        entity: { type: "workspace", id: WORKSPACE_THREAD_ID },
        input: {},
      },
    }),
    (error) => error.code === "RESEARCH_COMP_INPUT_REQUIRED"
  );
});

// ---------------------------------------------------------------------------
// research.record / company.health-record — the conversational-chat write
// bridge (P0 fix): an embedded chat session (CHAT_RUNTIME_TOOLS has no Bash)
// can never shell out to `careerrat research record`/`careerrat health
// record`, so it emits its finished result as a typed block and the app
// fires these confirm-first intents instead. The write itself runs through
// the exact same guards (computeResearchWrite/writeResearch,
// validateCompanyHealth) the CLI path already used.
// ---------------------------------------------------------------------------

function companyResearchDraft({ company = "Beacon Robotics", fetchedAt } = {}) {
  const today = fetchedAt || new Date().toISOString().slice(0, 10);
  return [
    "---",
    "type: company-research",
    `company: "${company}"`,
    `fetchedAt: "${today}"`,
    "staleness_days: 14",
    "sources:",
    '  - url: "https://example.com/beacon-robotics"',
    '    title: "Beacon Robotics raises Series C"',
    "    confidence: high",
    "---",
    "",
    "## Overview",
    `${company} builds warehouse automation robots. [source: "Beacon Robotics raises Series C" (https://example.com/beacon-robotics), fetched ${today}, confidence: high]`,
    "",
  ].join("\n");
}

test("research.record writes a company-research artifact through the research-store guards", async () => {
  const repoRoot = tempRepo();

  const result = await executeWorkspaceIntent({
    repoRoot,
    env: {},
    intent: {
      type: "research.record",
      entity: { type: "workspace", id: WORKSPACE_THREAD_ID },
      input: {
        type: "company-research",
        name: "Beacon Robotics",
        markdown: companyResearchDraft(),
      },
    },
  });

  const last = result.messages.at(-1);
  assert.equal(last.kind, "action_result");
  assert.equal(last.artifacts[0].kind, "company_research");
  assert.equal(last.artifacts[0].company, "Beacon Robotics");
  assert.equal(last.artifacts[0].slug, "beacon-robotics");
  assert.equal(last.artifacts[0].path, researchRelPath("beacon-robotics"));
  assert.equal(last.artifacts[0].sources, 1);
  assert.match(last.artifacts[0].markdown, /Beacon Robotics builds warehouse automation robots/);
  assert.equal(last.text, "Saved research for Beacon Robotics to your workspace.");

  const onDisk = readResearch("beacon-robotics", { root: repoRoot });
  assert.ok(onDisk, "the artifact must actually be written to workspace/research/");
  assert.equal(onDisk.frontmatter.company, "Beacon Robotics");
});

test("research.record refuses a draft that leaks the private current_base field", async () => {
  const repoRoot = tempRepo();
  const leaking = companyResearchDraft().replace(
    "## Overview",
    "## Overview\ncurrent_base: 185000"
  );

  await assert.rejects(
    executeWorkspaceIntent({
      repoRoot,
      env: {},
      intent: {
        type: "research.record",
        entity: { type: "workspace", id: WORKSPACE_THREAD_ID },
        input: { type: "company-research", name: "Beacon Robotics", markdown: leaking },
      },
    }),
    (error) => {
      assert.equal(error.code, "RESEARCH_RECORD_INVALID");
      assert.match(error.message, /current_base/);
      return true;
    }
  );
  assert.equal(readResearch("beacon-robotics", { root: repoRoot }), null);
});

function companyHealthPayload(overrides = {}) {
  return {
    rating: "watch",
    forFunction: "clinical staffing",
    asOf: "2026-08-15",
    provenance: "built-from-data",
    dimensions: { layoffRisk: { level: "mixed", note: "no function hit yet" } },
    crossCut: [],
    fitDelta: 0,
    rationale: "No function-scoped risk signal yet; company-wide hiring freeze rumored.",
    ...overrides,
  };
}

test("company.health-record writes a rating onto the application row through companyHealthSet", async () => {
  const repoRoot = tempRepo();
  seedApplication(repoRoot, {
    id: "app-riverside",
    company: "Riverside Health",
    role: "Registered Nurse",
  });

  const result = await executeWorkspaceIntent({
    repoRoot,
    env: {},
    intent: {
      type: "company.health-record",
      entity: { type: "application", id: "app-riverside" },
      input: { companyHealth: companyHealthPayload() },
    },
  });

  const last = result.messages.at(-1);
  assert.equal(last.artifacts[0].kind, "company_health");
  assert.equal(last.artifacts[0].applicationId, "app-riverside");
  assert.equal(last.artifacts[0].rating, "watch");
  assert.equal(last.text, "Riverside Health: watch for clinical staffing, as of 2026-08-15.");

  const persisted = readApplication(repoRoot, "app-riverside");
  assert.equal(persisted.companyHealth.rating, "watch");
  assert.equal(persisted.companyHealth.forFunction, "clinical staffing");
});

test("company.health-record rejects an invalid rating enum with a clean 400-family code", async () => {
  const repoRoot = tempRepo();
  seedApplication(repoRoot, {
    id: "app-riverside",
    company: "Riverside Health",
    role: "Registered Nurse",
  });

  await assert.rejects(
    executeWorkspaceIntent({
      repoRoot,
      env: {},
      intent: {
        type: "company.health-record",
        entity: { type: "application", id: "app-riverside" },
        input: { companyHealth: companyHealthPayload({ rating: "great" }) },
      },
    }),
    (error) => {
      assert.equal(error.code, "BAD_HEALTH_RATING");
      assert.doesNotMatch(error.message, /\n\s+at /, "message must not be a raw stack trace");
      return true;
    }
  );
  assert.equal(readApplication(repoRoot, "app-riverside").companyHealth, undefined);
});

test("company.health throws COMPANY_NOT_FOUND instead of starting a chat for a blank company", async () => {
  const repoRoot = tempRepo();
  seedApplication(repoRoot, { id: "app-blank", company: "", role: "Registered Nurse" });

  await assert.rejects(
    executeWorkspaceIntent({
      repoRoot,
      env: {},
      intent: {
        type: "company.health",
        entity: { type: "application", id: "app-blank" },
        input: {},
      },
      startCompanyHealthImpl: async () => {
        throw new Error("must not start a chat for an empty company name");
      },
    }),
    (error) => error.code === "COMPANY_NOT_FOUND"
  );
});

// ---------------------------------------------------------------------------
// strategy.review / strategy.apply / strategy.stamp — the native
// strategy-review Ask workflow's executor branches (src/core/strategy/
// review.mjs's draftStrategyReview/applyStrategyRecommendation/
// stampStrategyReview, injected here the same way company.health injects
// startCompanyHealthImpl above).
// ---------------------------------------------------------------------------

test("strategy.review returns a strategy_review artifact and only a 'Run it anyway' nextAction when fresh", async () => {
  const repoRoot = tempRepo();
  const calls = [];

  const result = await executeWorkspaceIntent({
    repoRoot,
    env: {},
    intent: {
      type: "strategy.review",
      entity: { type: "workspace", id: WORKSPACE_THREAD_ID },
      input: {},
    },
    draftStrategyReviewImpl: async (input) => {
      calls.push(input);
      return {
        state: "fresh",
        generatedAt: "2026-08-15T12:00:00.000Z",
        reviewSignal: { reviewed: true, outcomes: 2, newOutcomes: 0, daysSince: 1 },
        reevaluation: null,
        headline: "Nothing new since your last review.",
        findings: [],
        recommendations: [],
        lastReview: { lastReviewedAt: "2026-08-14T12:00:00.000Z" },
      };
    },
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].repoRoot, repoRoot);
  assert.equal(calls[0].force, false);

  const last = result.messages.at(-1);
  assert.equal(last.text, "Nothing new since your last strategy review.");
  assert.deepEqual(last.artifacts, [
    {
      kind: "strategy_review",
      state: "fresh",
      generatedAt: "2026-08-15T12:00:00.000Z",
      reviewSignal: { reviewed: true, outcomes: 2, newOutcomes: 0, daysSince: 1 },
      reevaluation: null,
      headline: "Nothing new since your last review.",
      findings: [],
      recommendations: [],
    },
  ]);
  assert.equal(last.metadata.state, "fresh");
  assert.deepEqual(last.metadata.nextActions, [
    {
      label: "Run it anyway",
      intent: {
        type: "strategy.review",
        entity: { type: "workspace", id: WORKSPACE_THREAD_ID },
        input: { force: true },
      },
    },
  ]);
});

test("strategy.review returns only a 'Finish review' nextAction once drafted, and passes force through to the impl", async () => {
  const repoRoot = tempRepo();
  const calls = [];

  const result = await executeWorkspaceIntent({
    repoRoot,
    env: {},
    intent: {
      type: "strategy.review",
      entity: { type: "workspace", id: WORKSPACE_THREAD_ID },
      input: { force: true },
    },
    draftStrategyReviewImpl: async (input) => {
      calls.push(input);
      return {
        state: "drafted",
        generatedAt: "2026-08-15T12:00:00.000Z",
        reviewSignal: { reviewed: true, outcomes: 7, newOutcomes: 5, daysSince: 1 },
        reevaluation: null,
        headline: "5 new rejections cluster around on-call roles.",
        findings: [{ id: "f1", title: "On-call roles are rejected", evidence: "4 of 5 rejected." }],
        recommendations: [
          {
            id: "rec-cut",
            type: "cut-signal",
            title: "Cut on-call roles",
            rationale: "Every on-call-tagged role was rejected.",
            evidenceCount: 4,
            proposal: { signal: "on-call-rotation" },
          },
        ],
      };
    },
  });

  assert.equal(calls[0].force, true);
  const last = result.messages.at(-1);
  assert.equal(
    last.text,
    "5 new rejections cluster around on-call roles. Review the findings and recommendations, then finish the review."
  );
  assert.equal(last.artifacts[0].recommendations.length, 1);
  assert.equal(last.metadata.state, "drafted");
  assert.deepEqual(last.metadata.nextActions, [
    {
      label: "Finish review",
      intent: {
        type: "strategy.stamp",
        entity: { type: "workspace", id: WORKSPACE_THREAD_ID },
      },
    },
  ]);
});

test("strategy.review renders a distinct manual-degrade sentence when the AI reviewer was unavailable", async () => {
  const repoRoot = tempRepo();

  const result = await executeWorkspaceIntent({
    repoRoot,
    env: {},
    intent: {
      type: "strategy.review",
      entity: { type: "workspace", id: WORKSPACE_THREAD_ID },
      input: {},
    },
    draftStrategyReviewImpl: async () => ({
      state: "manual",
      generatedAt: "2026-08-15T12:00:00.000Z",
      reviewSignal: { reviewed: false, outcomes: 3, newOutcomes: 3, daysSince: null },
      reevaluation: null,
      headline: "Build a measurable loop",
      findings: [],
      recommendations: [],
      manual: {
        reason: "no ai route configured",
        surfaceSummary: { title: "Build a measurable loop" },
      },
    }),
  });

  const last = result.messages.at(-1);
  assert.match(last.text, /AI reviewer wasn't available/);
  assert.equal(last.metadata.state, "manual");
  assert.deepEqual(last.metadata.nextActions, [
    {
      label: "Finish review",
      intent: {
        type: "strategy.stamp",
        entity: { type: "workspace", id: WORKSPACE_THREAD_ID },
      },
    },
  ]);
});

test("strategy.apply requires a recommendation, then routes it to applyStrategyRecommendationImpl and returns a strategy_apply artifact", async () => {
  const repoRoot = tempRepo();

  await assert.rejects(
    executeWorkspaceIntent({
      repoRoot,
      env: {},
      intent: {
        type: "strategy.apply",
        entity: { type: "workspace", id: WORKSPACE_THREAD_ID },
        input: {},
      },
    }),
    (error) => error.code === "STRATEGY_APPLY_INVALID"
  );

  const recommendation = {
    type: "keep-signal",
    title: "Keep remote-first",
    proposal: { signal: "remote-first" },
  };
  const calls = [];
  const result = await executeWorkspaceIntent({
    repoRoot,
    env: {},
    intent: {
      type: "strategy.apply",
      entity: { type: "workspace", id: WORKSPACE_THREAD_ID },
      input: { recommendation },
    },
    applyStrategyRecommendationImpl: async (input) => {
      calls.push(input);
      return {
        ok: true,
        type: "keep-signal",
        title: "Keep remote-first",
        result: { changed: true },
      };
    },
  });

  assert.deepEqual(calls[0].recommendation, recommendation);
  const last = result.messages.at(-1);
  assert.equal(last.text, "Applied: Keep remote-first.");
  assert.deepEqual(last.artifacts, [
    {
      kind: "strategy_apply",
      type: "keep-signal",
      title: "Keep remote-first",
      result: { changed: true },
    },
  ]);
  assert.equal(last.metadata.state, "applied");
});

test("strategy.stamp routes to stampStrategyReviewImpl and returns a strategy_review_stamp artifact", async () => {
  const repoRoot = tempRepo();
  const calls = [];

  const result = await executeWorkspaceIntent({
    repoRoot,
    env: {},
    intent: {
      type: "strategy.stamp",
      entity: { type: "workspace", id: WORKSPACE_THREAD_ID },
      input: {},
    },
    stampStrategyReviewImpl: (input) => {
      calls.push(input);
      return {
        ok: true,
        strategyReview: {
          lastReviewedAt: "2026-08-15T12:00:00.000Z",
          snapshot: { applied: 3, advanced: 1, rejected: 1, outcomes: 2, rejectedByFamily: null },
        },
        meta: { version: 4 },
        event: { type: "system" },
      };
    },
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].repoRoot, repoRoot);
  const last = result.messages.at(-1);
  assert.equal(
    last.text,
    "Recorded this strategy review. The review-ready nudge stays quiet until enough new outcomes accrue."
  );
  assert.deepEqual(last.artifacts, [
    {
      kind: "strategy_review_stamp",
      lastReviewedAt: "2026-08-15T12:00:00.000Z",
      snapshot: { applied: 3, advanced: 1, rejected: 1, outcomes: 2, rejectedByFamily: null },
    },
  ]);
  assert.equal(last.metadata.state, "stamped");
});

test("resolveReferencedCompany never lets a stop-worded reference fall back to a lone single-char token", async () => {
  const repoRoot = tempRepo();
  seedSourced(repoRoot, {
    id: "sourced-att-communications",
    company: "AT&T Communications",
    role: "Network Engineer",
    link: "https://jobs.example.test/att-communications/network-engineer",
  });

  await assert.rejects(
    executeWorkspaceIntent({
      repoRoot,
      env: {},
      intent: {
        type: "research.company-request",
        entity: { type: "workspace", id: WORKSPACE_THREAD_ID },
        input: { companyReference: "AT&T" },
      },
    }),
    (error) => error.code === "COMPANY_NOT_FOUND",
    '"AT&T" must not subset-match "AT&T Communications" off a lone leftover "t" token'
  );
});

test('resolveReferencedCompany still resolves an exact whole-name match like "AT&T"', async () => {
  const repoRoot = tempRepo();
  seedSourced(repoRoot, {
    id: "sourced-att",
    company: "AT&T",
    role: "Network Engineer",
    link: "https://jobs.example.test/att/network-engineer",
  });

  const result = await executeWorkspaceIntent({
    repoRoot,
    env: {},
    intent: {
      type: "research.company-request",
      entity: { type: "workspace", id: WORKSPACE_THREAD_ID },
      input: { companyReference: "AT&T" },
    },
    startCompanyResearchImpl: async () => ({
      chat: { chatId: "att-chat", skill: "research-company", state: "running", reused: false },
    }),
  });

  assert.equal(result.messages.at(-1).artifacts[0].title, "Researching AT&T");
});

test("a confirmed Ask action adds one board URL and keeps the receipt in workspace-main", async () => {
  const repoRoot = tempRepo();
  const calls = [];
  const sourceUrl = "https://remoteok.com/remote-dev-jobs?order_by=date";

  const result = await executeWorkspaceIntent({
    repoRoot,
    env: {},
    intent: {
      type: "source.add",
      entity: { type: "workspace", id: WORKSPACE_THREAD_ID },
      input: { url: sourceUrl },
    },
    addBoardSourceImpl: (input) => {
      calls.push(input);
      return {
        added: true,
        source: {
          index: 3,
          provider: "remoteok",
          label: "remoteok.com",
          target: sourceUrl,
          sourceType: "ats",
          enabled: true,
          auth: false,
        },
      };
    },
    now: () => new Date("2026-08-09T14:02:45.000Z"),
  });

  assert.deepEqual(calls, [{ repoRoot, env: {}, url: sourceUrl }]);
  assert.deepEqual(
    result.messages.map(({ role, kind }) => ({ role, kind })),
    [
      { role: "user", kind: "intent" },
      { role: "assistant", kind: "action_result" },
    ]
  );
  assert.match(result.messages.at(-1).text, /Added remoteok\.com to your search sources/i);
  assert.deepEqual(result.messages.at(-1).artifacts, [
    {
      kind: "search_source",
      title: "remoteok.com — Added",
      added: true,
      index: 3,
      provider: "remoteok",
      label: "remoteok.com",
      target: sourceUrl,
      sourceType: "ats",
      enabled: true,
      auth: false,
    },
  ]);
  assert.deepEqual(result.messages.at(-1).metadata.nextActions, [
    { label: "Search jobs", href: "/jobs?tab=search" },
    { label: "Manage sources", href: "/settings" },
  ]);
});

test("a confirmed Ask action adds one keyword search through source setup", async () => {
  const repoRoot = tempRepo();
  const calls = [];
  const result = await executeWorkspaceIntent({
    repoRoot,
    env: {},
    intent: {
      type: "source.query-add",
      entity: { type: "workspace", id: WORKSPACE_THREAD_ID },
      input: { query: "staff AI engineer" },
    },
    addSearchSourceQueryImpl: (input) => {
      calls.push(input);
      return {
        added: true,
        source: {
          index: 2,
          provider: "HiringCafe",
          label: "staff AI engineer",
          target: "staff AI engineer",
          sourceType: "url-query",
          enabled: true,
          auth: false,
        },
      };
    },
    now: () => new Date("2026-08-09T14:02:50.000Z"),
  });

  assert.deepEqual(calls, [
    { repoRoot, env: {}, query: "staff AI engineer", provider: "HiringCafe" },
  ]);
  assert.match(result.messages.at(-1).text, /Added staff AI engineer/i);
  assert.equal(result.messages.at(-1).artifacts[0].kind, "search_source");
  assert.equal(result.messages.at(-1).artifacts[0].added, true);
  assert.equal(result.messages.at(-1).artifacts[0].target, "staff AI engineer");
  assert.deepEqual(result.messages.at(-1).metadata.nextActions, [
    { label: "Search jobs", href: "/jobs?tab=search" },
    { label: "Manage sources", href: "/settings" },
  ]);
});

test("a confirmed Ask action toggles one deterministically resolved search source", async () => {
  const repoRoot = tempRepo();
  const calls = [];
  const result = await executeWorkspaceIntent({
    repoRoot,
    env: {},
    intent: {
      type: "source.set-enabled",
      entity: { type: "workspace", id: WORKSPACE_THREAD_ID },
      input: { selector: "LinkedIn", enabled: false },
    },
    setSearchSourceEnabledImpl: (input) => {
      calls.push(input);
      return {
        changed: true,
        source: {
          index: 1,
          provider: "linkedin.com",
          label: "LinkedIn search",
          target: "https://www.linkedin.com/jobs/search/?keywords=AI",
          sourceType: "browser",
          enabled: false,
          auth: true,
        },
      };
    },
    now: () => new Date("2026-08-09T14:02:55.000Z"),
  });

  assert.deepEqual(calls, [{ repoRoot, env: {}, selector: "LinkedIn", enabled: false }]);
  assert.match(result.messages.at(-1).text, /Disabled LinkedIn search/i);
  assert.deepEqual(result.messages.at(-1).artifacts, [
    {
      kind: "search_source",
      title: "LinkedIn search — Disabled",
      changed: true,
      index: 1,
      provider: "linkedin.com",
      label: "LinkedIn search",
      target: "https://www.linkedin.com/jobs/search/?keywords=AI",
      sourceType: "browser",
      enabled: false,
      auth: true,
    },
  ]);
  assert.deepEqual(result.messages.at(-1).metadata.nextActions, [
    { label: "Search jobs", href: "/jobs?tab=search" },
    { label: "Manage sources", href: "/settings" },
  ]);
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

test("job.evaluate-request resolves a URL, captures the full JD, promotes it, and saves the verdict", async () => {
  const repoRoot = tempRepo();
  const jobUrl = "https://boards.greenhouse.io/acme/jobs/12345";
  const calls = [];

  const result = await executeWorkspaceIntent({
    repoRoot,
    env: {},
    intent: {
      type: "job.evaluate-request",
      entity: { type: "workspace", id: WORKSPACE_THREAD_ID },
      input: { jobUrl },
    },
    resolveJobUrlImpl: async () => ({
      bodyFetchStatus: "resolved",
      url: jobUrl,
      provider: "greenhouse",
      title: "Senior AI Engineer",
      company: "Acme",
      location: "Remote US",
      comp: "$210,000 - $260,000",
      bodyText: "Own production agent systems and evaluation infrastructure.",
    }),
    evaluateJobImpl: async (input) => {
      calls.push(input);
      return {
        status: 200,
        body: {
          ok: true,
          data: {
            applicationId: input.body.applicationId,
            gate: "keep",
            fitScore: 91,
            fitBucket: "high",
            fitReasons: ["Production agent systems"],
            fitRisks: [],
            compensation: { summary: "Posted band clears the floor." },
            manual: { required: false },
          },
        },
      };
    },
    now: () => new Date("2026-08-14T20:00:00.000Z"),
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].body.jobUrl, jobUrl);
  assert.match(calls[0].body.jobBody, /production agent systems/i);
  const applicationId = result.messages.at(-1).metadata.applicationId;
  const application = readApplication(repoRoot, applicationId);
  assert.equal(application.company, "Acme");
  assert.equal(application.role, "Senior AI Engineer");
  assert.equal(application.link, jobUrl);
  assert.ok(application.artifacts.jd.startsWith("workspace/jobs/"));
  assert.match(
    readFileSync(userPath({ repoRoot, env: {} }, application.artifacts.jd), "utf8"),
    /Own production agent systems and evaluation infrastructure\./
  );
  assert.equal(
    openDb({ repoRoot, env: {} }).prepare("SELECT COUNT(*) AS count FROM sourced").get().count,
    0
  );
  assert.equal(result.messages.at(-1).artifacts[0].kind, "job_evaluation");
  assert.equal(result.messages.at(-1).metadata.state, "keep");
  assert.equal(
    result.messages.at(-1).metadata.nextActions[0].intent.type,
    "job.generate-documents"
  );
});

test("job.evaluate-request captures and evaluates a confirmed pasted JD inside workspace-main", async () => {
  const repoRoot = tempRepo();
  const rawInput = [
    "Acme",
    "Senior AI Engineer",
    "Own production agent systems and evaluation infrastructure.",
  ].join("\n");
  const { id } = intakeCapture({ repoRoot, env: {}, rawInput, inputKind: "text" });
  intakeUpdate({
    repoRoot,
    env: {},
    id,
    patch: {
      status: "confirmed",
      decision: "confirm",
      kind: "jd-text",
      classification: {
        kind: "jd-text",
        entities: { company: "Acme", role: "Senior AI Engineer" },
      },
    },
  });

  const result = await executeWorkspaceIntent({
    repoRoot,
    env: {},
    intent: {
      type: "job.evaluate-request",
      entity: { type: "intake", id },
    },
    evaluateJobImpl: async ({ body }) => ({
      status: 200,
      body: {
        ok: true,
        data: {
          applicationId: body.applicationId,
          gate: "keep",
          fitScore: 90,
          fitReasons: ["Production agent systems"],
          fitRisks: [],
          manual: { required: false },
        },
      },
    }),
    now: () => new Date("2026-08-14T20:00:00.000Z"),
  });

  const message = result.messages.at(-1);
  const application = readApplication(repoRoot, message.metadata.applicationId);
  assert.equal(application.company, "Acme");
  assert.equal(application.role, "Senior AI Engineer");
  assert.equal(application.link, null);
  assert.equal(application.sourceMeta.sourceIntakeId, id);
  assert.ok(application.artifacts.jd.startsWith("workspace/jobs/"));
  assert.match(
    readFileSync(userPath({ repoRoot, env: {} }, application.artifacts.jd), "utf8"),
    /Own production agent systems and evaluation infrastructure\./
  );
  assert.equal(message.artifacts[0].evaluation.fitScore, 90);
  assert.equal(message.metadata.sourceIntakeId, id);
});

test("job.prepare-request asks for the application link when a pasted JD has no URL", async () => {
  const repoRoot = tempRepo();
  const rawInput = [
    "Thornfield Labs",
    "Forward Deployed AI Engineer",
    "Own production agent systems and evaluation infrastructure.",
  ].join("\n");
  const { id } = intakeCapture({ repoRoot, env: {}, rawInput, inputKind: "text" });
  intakeUpdate({
    repoRoot,
    env: {},
    id,
    patch: {
      status: "confirmed",
      decision: "confirm",
      kind: "jd-text",
      classification: {
        kind: "jd-text",
        entities: { company: "Thornfield Labs", role: "Forward Deployed AI Engineer" },
      },
    },
  });

  const result = await executeWorkspaceIntent({
    repoRoot,
    env: {},
    intent: {
      type: "job.prepare-request",
      entity: { type: "intake", id },
    },
    evaluateJobImpl: async ({ body }) => ({
      status: 200,
      body: {
        ok: true,
        data: {
          applicationId: body.applicationId,
          gate: "keep",
          fitScore: 92,
          manual: { required: false },
        },
      },
    }),
    generateDocumentsImpl: async (input) => {
      if (input.body.applyIntent) {
        const error = new Error("Capture the application questions first.");
        error.code = "BAD_QUESTION_CAPTURE";
        throw error;
      }
      return {
        status: "reviewable",
        uploadReady: false,
        gaps: [
          {
            kind: "answers",
            code: "QUESTION_CAPTURE_DEFERRED",
            message: "The site will provide its questions later.",
          },
        ],
        artifacts: { resumePdf: "workspace/tailored/thornfield-resume.pdf" },
      };
    },
  });

  const message = result.messages.at(-1);
  const packet = message.artifacts.find((artifact) => artifact.kind === "packet_generation");
  assert.equal(message.metadata.blockingGapCount, 1);
  assert.equal(packet.blockingGapCount, 1);
  assert.ok(packet.gaps.some((gap) => gap.code === "APPLICATION_URL_REQUIRED"));
  assert.match(message.text, /paste the application link/i);
  assert.doesNotMatch(message.text, /open the site/i);
  assert.equal(
    message.artifacts.some((artifact) => artifact.kind === "application_handoff"),
    false
  );
});

test("job.evaluate-request resolves one named saved job without guessing an id", async () => {
  const repoRoot = tempRepo();
  seedApplication(repoRoot, {
    id: "app-acme",
    company: "Acme",
    role: "Senior AI Engineer",
    link: "https://jobs.example.test/acme/senior-ai",
  });
  seedSourced(repoRoot, {
    id: "sourced-northstar",
    company: "Northstar",
    role: "Staff Platform Engineer",
  });

  const result = await executeWorkspaceIntent({
    repoRoot,
    env: {},
    intent: {
      type: "job.evaluate-request",
      entity: { type: "workspace", id: WORKSPACE_THREAD_ID },
      input: { jobReference: "Can you rate the Acme role?" },
    },
    evaluateJobImpl: async ({ body }) => ({
      status: 200,
      body: {
        ok: true,
        data: {
          applicationId: body.applicationId,
          gate: "review",
          fitScore: 73,
          manual: { required: true },
        },
      },
    }),
  });

  assert.equal(result.messages.at(-1).metadata.applicationId, "app-acme");
});

test("job.evaluate-request rejects ambiguous named saved jobs instead of choosing one", async () => {
  const repoRoot = tempRepo();
  seedApplication(repoRoot, {
    id: "app-acme-ai",
    company: "Acme",
    role: "Senior AI Engineer",
  });
  seedApplication(repoRoot, {
    id: "app-acme-platform",
    company: "Acme",
    role: "Staff Platform Engineer",
    link: "https://jobs.example.test/acme/staff-platform",
  });

  await assert.rejects(
    executeWorkspaceIntent({
      repoRoot,
      env: {},
      intent: {
        type: "job.evaluate-request",
        entity: { type: "workspace", id: WORKSPACE_THREAD_ID },
        input: { jobReference: "Rate the Acme role" },
      },
    }),
    (error) =>
      error.code === "JOB_REFERENCE_AMBIGUOUS" &&
      /Senior AI Engineer/.test(error.message) &&
      error.details?.matches?.length === 2
  );
  const last = workspaceThreadRead({ repoRoot, env: {} }).messages.at(-1);
  assert.equal(last.kind, "action_error");
  assert.equal(last.error.code, "JOB_REFERENCE_AMBIGUOUS");
});

test("job.evaluate-request reuses a matching application while refreshing its JD capture", async () => {
  const repoRoot = tempRepo();
  const jobUrl = "https://jobs.lever.co/temporal/abc-123";
  seedApplication(repoRoot, { link: jobUrl, artifacts: { resume: "workspace/old-resume.pdf" } });

  const result = await executeWorkspaceIntent({
    repoRoot,
    env: {},
    intent: {
      type: "job.evaluate-request",
      entity: { type: "workspace", id: WORKSPACE_THREAD_ID },
      input: { jobUrl },
    },
    resolveJobUrlImpl: async () => ({
      bodyFetchStatus: "resolved",
      url: jobUrl,
      provider: "lever",
      title: "Applied AI Engineer",
      company: "Temporal Labs",
      bodyText: "Build reliable agent workflows.",
    }),
    evaluateJobImpl: async ({ body }) => ({
      status: 200,
      body: {
        ok: true,
        data: {
          applicationId: body.applicationId,
          gate: "review",
          fitScore: 74,
          manual: { required: true },
        },
      },
    }),
  });

  assert.equal(result.messages.at(-1).metadata.applicationId, "app-temporal");
  const application = readApplication(repoRoot, "app-temporal");
  assert.equal(application.artifacts.resume, "workspace/old-resume.pdf");
  assert.ok(application.artifacts.jd.startsWith("workspace/jobs/"));
  assert.equal(
    openDb({ repoRoot, env: {} }).prepare("SELECT COUNT(*) AS count FROM applications").get().count,
    1
  );
});

test("job.evaluate-request does not overwrite a company-role application match for a different URL", async () => {
  const repoRoot = tempRepo();
  const originalLink = "https://jobs.lever.co/temporal/original-role";
  const jobUrl = "https://jobs.lever.co/temporal/different-role";
  seedApplication(repoRoot, {
    link: originalLink,
    artifacts: { resume: "workspace/original-resume.pdf" },
  });

  const result = await executeWorkspaceIntent({
    repoRoot,
    env: {},
    intent: {
      type: "job.evaluate-request",
      entity: { type: "workspace", id: WORKSPACE_THREAD_ID },
      input: { jobUrl },
    },
    resolveJobUrlImpl: async () => ({
      bodyFetchStatus: "resolved",
      url: jobUrl,
      provider: "lever",
      title: "Applied AI Engineer",
      company: "Temporal Labs",
      bodyText: "Build a different reliable agent workflow.",
    }),
    evaluateJobImpl: async ({ body }) => ({
      status: 200,
      body: {
        ok: true,
        data: {
          applicationId: body.applicationId,
          gate: "review",
          fitScore: 74,
          manual: { required: true },
        },
      },
    }),
  });

  const applicationId = result.messages.at(-1).metadata.applicationId;
  assert.notEqual(applicationId, "app-temporal");
  assert.equal(readApplication(repoRoot, "app-temporal").link, originalLink);
  assert.equal(
    readApplication(repoRoot, "app-temporal").artifacts.resume,
    "workspace/original-resume.pdf"
  );
  assert.equal(
    openDb({ repoRoot, env: {} }).prepare("SELECT COUNT(*) AS count FROM applications").get().count,
    2
  );
});

test("job.evaluate-request does not overwrite a company-role sourced match for a different URL", async () => {
  const repoRoot = tempRepo();
  const originalLink = "https://jobs.lever.co/temporal/original-source";
  const jobUrl = "https://jobs.lever.co/temporal/different-source";
  seedSourced(repoRoot, {
    link: originalLink,
    loc: "Original location",
    base: "$190k",
  });

  const result = await executeWorkspaceIntent({
    repoRoot,
    env: {},
    intent: {
      type: "job.evaluate-request",
      entity: { type: "workspace", id: WORKSPACE_THREAD_ID },
      input: { jobUrl },
    },
    resolveJobUrlImpl: async () => ({
      bodyFetchStatus: "resolved",
      url: jobUrl,
      provider: "lever",
      title: "Staff Platform Engineer",
      company: "Temporal Labs",
      location: "New location",
      comp: "$250k",
      bodyText: "Build a different platform.",
    }),
    evaluateJobImpl: async ({ body }) => ({
      status: 200,
      body: {
        ok: true,
        data: {
          applicationId: body.applicationId,
          gate: "review",
          fitScore: 72,
          manual: { required: true },
        },
      },
    }),
  });

  const original = readSourced(repoRoot, "sourced-temporal");
  assert.equal(original.link, originalLink);
  assert.equal(original.loc, "Original location");
  assert.equal(original.base, "$190k");
  assert.notEqual(result.messages.at(-1).metadata.applicationId, "sourced-temporal");
});

test("job.evaluate-request resolves an explicitly open saved sourced role and promotes it", async () => {
  const repoRoot = tempRepo();
  seedSourced(repoRoot, {
    id: "sourced-open",
    company: "Northstar",
    role: "Staff AI Engineer",
    link: "https://jobs.example.test/northstar/staff-ai",
    artifacts: { jd: "workspace/jobs/northstar-staff-ai.md" },
  });
  const calls = [];

  const result = await executeWorkspaceIntent({
    repoRoot,
    env: {},
    intent: {
      type: "job.evaluate-request",
      entity: { type: "workspace", id: WORKSPACE_THREAD_ID },
      input: { jobId: "sourced-open" },
    },
    evaluateJobImpl: async (input) => {
      calls.push(input);
      return {
        status: 200,
        body: {
          ok: true,
          data: {
            applicationId: input.body.applicationId,
            gate: "keep",
            fitScore: 89,
            manual: { required: false },
          },
        },
      };
    },
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].body.jobUrl, "https://jobs.example.test/northstar/staff-ai");
  assert.equal(readSourced(repoRoot, "sourced-open"), null);
  const applicationId = result.messages.at(-1).metadata.applicationId;
  assert.equal(readApplication(repoRoot, applicationId).company, "Northstar");
  assert.equal(result.messages.at(-1).metadata.state, "keep");
});

test("job.prepare-request stops on CUT and does not generate documents", async () => {
  const repoRoot = tempRepo();
  const jobUrl = "https://jobs.ashbyhq.com/acme/cut-role";
  let generated = 0;

  const result = await executeWorkspaceIntent({
    repoRoot,
    env: {},
    intent: {
      type: "job.prepare-request",
      entity: { type: "workspace", id: WORKSPACE_THREAD_ID },
      input: { jobUrl },
    },
    resolveJobUrlImpl: async () => ({
      bodyFetchStatus: "resolved",
      url: jobUrl,
      title: "Travel Sales Engineer",
      company: "Acme",
      bodyText: "Travel 80 percent and work on-site five days per week.",
    }),
    evaluateJobImpl: async ({ body }) => ({
      status: 200,
      body: {
        ok: true,
        data: {
          applicationId: body.applicationId,
          gate: "cut",
          fitScore: 31,
          fitRisks: ["Travel conflicts with a hard boundary"],
          manual: { required: false },
        },
      },
    }),
    generateDocumentsImpl: async () => {
      generated += 1;
      return {};
    },
  });

  assert.equal(generated, 0);
  assert.equal(result.messages.at(-1).metadata.state, "cut");
  assert.equal(result.messages.at(-1).artifacts.length, 1);
});

test("job.prepare-request stops on REVIEW and hands the unresolved decision to the job drawer", async () => {
  const repoRoot = tempRepo();
  const jobUrl = "https://jobs.ashbyhq.com/acme/review-role";
  let generated = 0;

  const result = await executeWorkspaceIntent({
    repoRoot,
    env: {},
    intent: {
      type: "job.prepare-request",
      entity: { type: "workspace", id: WORKSPACE_THREAD_ID },
      input: { jobUrl },
    },
    resolveJobUrlImpl: async () => ({
      bodyFetchStatus: "resolved",
      url: jobUrl,
      title: "Field AI Engineer",
      company: "Acme",
      bodyText: "Work with customers on production AI systems. Compensation is not posted.",
    }),
    evaluateJobImpl: async ({ body }) => ({
      status: 200,
      body: {
        ok: true,
        data: {
          applicationId: body.applicationId,
          gate: "review",
          fitScore: 76,
          fitRisks: ["Compensation needs confirmation"],
          manual: { required: true },
        },
      },
    }),
    generateDocumentsImpl: async () => {
      generated += 1;
      return {};
    },
  });

  assert.equal(generated, 0);
  assert.equal(result.messages.at(-1).metadata.state, "review");
  assert.equal(result.messages.at(-1).metadata.nextActions[0].label, "Review this job");
  assert.match(result.messages.at(-1).metadata.nextActions[0].href, /^\/jobs\?open=/);
});

test("job.prepare-request generates a KEEP packet and returns the review/apply handoff", async () => {
  const repoRoot = tempRepo();
  const jobUrl = "https://boards.greenhouse.io/acme/jobs/keep-role";
  const generationCalls = [];

  const result = await executeWorkspaceIntent({
    repoRoot,
    env: {},
    intent: {
      type: "job.prepare-request",
      entity: { type: "workspace", id: WORKSPACE_THREAD_ID },
      input: { jobUrl },
    },
    resolveJobUrlImpl: async () => ({
      bodyFetchStatus: "resolved",
      url: jobUrl,
      title: "Staff AI Engineer",
      company: "Acme",
      bodyText: "Lead production AI systems and platform strategy.",
    }),
    evaluateJobImpl: async ({ body }) => ({
      status: 200,
      body: {
        ok: true,
        data: {
          applicationId: body.applicationId,
          gate: "keep",
          fitScore: 94,
          fitReasons: ["Production AI leadership"],
          manual: { required: false },
        },
      },
    }),
    generateDocumentsImpl: async (input) => {
      generationCalls.push(input);
      return {
        status: "ready",
        uploadReady: true,
        gaps: [],
        artifacts: { resumePdf: "workspace/tailored/acme-resume.pdf" },
      };
    },
  });

  assert.equal(generationCalls.length, 1);
  assert.equal(generationCalls[0].body.applyIntent, true);
  assert.deepEqual(
    result.messages.at(-1).artifacts.map((artifact) => artifact.kind),
    ["job_evaluation", "packet_generation", "application_handoff"]
  );
  assert.equal(result.messages.at(-1).metadata.state, "ready");
  assert.equal(result.messages.at(-1).artifacts.at(-1).url, jobUrl);
  assert.equal(
    result.messages.at(-1).metadata.nextActions[0].intent.type,
    "application.record-external"
  );
});

test("job.prepare-request captures public application questions before generating the packet", async () => {
  const repoRoot = tempRepo();
  const jobUrl = "https://boards.greenhouse.io/acme/jobs/123";
  const steps = [];

  const result = await executeWorkspaceIntent({
    repoRoot,
    env: {},
    intent: {
      type: "job.prepare-request",
      entity: { type: "workspace", id: WORKSPACE_THREAD_ID },
      input: { jobUrl },
    },
    resolveJobUrlImpl: async () => ({
      bodyFetchStatus: "resolved",
      url: jobUrl,
      title: "Staff AI Engineer",
      company: "Acme",
      bodyText: "Lead production AI systems and platform strategy.",
    }),
    evaluateJobImpl: async ({ body }) => ({
      status: 200,
      body: {
        ok: true,
        data: {
          applicationId: body.applicationId,
          gate: "keep",
          fitScore: 94,
          fitReasons: ["Production AI leadership"],
          manual: { required: false },
        },
      },
    }),
    captureQuestionsImpl: async (input) => {
      steps.push({ step: "questions", input });
      return {
        source: "greenhouse",
        questions: [
          {
            id: "why-acme",
            label: "Why do you want to work here?",
            type: "textarea",
            required: true,
            options: null,
          },
        ],
        excluded: [{ id: "eeo", label: "Voluntary self identification" }],
        demographicSectionPresent: true,
      };
    },
    generateDocumentsImpl: async (input) => {
      steps.push({ step: "packet", input });
      return {
        status: "ready",
        uploadReady: true,
        gaps: [],
        artifacts: {
          resumePdf: "workspace/tailored/acme-resume.pdf",
          answers: "workspace/tailored/acme-answers.md",
        },
      };
    },
  });

  assert.deepEqual(
    steps.map(({ step }) => step),
    ["questions", "packet"]
  );
  assert.equal(steps[0].input.applicationId, result.messages.at(-1).metadata.applicationId);
  assert.equal(steps[0].input.source, "url");
  assert.equal(steps[0].input.url, jobUrl);
  assert.equal(steps[1].input.body.applyIntent, true);
  const handoff = result.messages
    .at(-1)
    .artifacts.find((artifact) => artifact.kind === "application_handoff");
  assert.deepEqual(handoff.questionCapture, {
    state: "captured",
    source: "greenhouse",
    answerableCount: 1,
    excludedCount: 1,
    demographicSectionPresent: true,
  });
  assert.match(result.messages.at(-1).text, /captured 1 application question/i);
});

test("job.prepare-request offers the connected supervised executor as the next Apply action", async () => {
  const repoRoot = tempRepo();
  const jobUrl = "https://careers.example.test/jobs/staff-ai";

  const result = await executeWorkspaceIntent({
    repoRoot,
    env: {},
    intent: {
      type: "job.prepare-request",
      entity: { type: "workspace", id: WORKSPACE_THREAD_ID },
      input: { jobUrl },
    },
    resolveJobUrlImpl: async () => ({
      bodyFetchStatus: "resolved",
      url: jobUrl,
      title: "Staff AI Engineer",
      company: "Acme",
      bodyText: "Lead production AI systems and platform strategy.",
    }),
    evaluateJobImpl: async ({ body }) => ({
      status: 200,
      body: {
        ok: true,
        data: {
          applicationId: body.applicationId,
          gate: "keep",
          fitScore: 94,
          fitReasons: ["Production AI leadership"],
          manual: { required: false },
        },
      },
    }),
    generateDocumentsImpl: async () => ({
      status: "ready",
      uploadReady: true,
      gaps: [],
      artifacts: { resumePdf: "workspace/tailored/acme-resume.pdf" },
    }),
    applyJobImpl: async () => ({ verified: false, state: "awaiting-submit" }),
  });

  const last = result.messages.at(-1);
  const handoff = last.artifacts.find((artifact) => artifact.kind === "application_handoff");
  assert.equal(handoff.executorAvailable, true);
  assert.equal(last.metadata.nextActions[0].label, "Start supervised apply");
  assert.equal(last.metadata.nextActions[0].intent.type, "job.apply");
});

test("job.prepare-request falls back to pasted questions when public capture returns nothing", async () => {
  const repoRoot = tempRepo();
  const jobUrl = "https://boards.greenhouse.io/acme/jobs/123";

  const result = await executeWorkspaceIntent({
    repoRoot,
    env: {},
    intent: {
      type: "job.prepare-request",
      entity: { type: "workspace", id: WORKSPACE_THREAD_ID },
      input: { jobUrl },
    },
    resolveJobUrlImpl: async () => ({
      bodyFetchStatus: "resolved",
      url: jobUrl,
      title: "Staff AI Engineer",
      company: "Acme",
      bodyText: "Lead production AI systems and platform strategy.",
    }),
    evaluateJobImpl: async ({ body }) => ({
      status: 200,
      body: {
        ok: true,
        data: {
          applicationId: body.applicationId,
          gate: "keep",
          fitScore: 94,
          fitReasons: ["Production AI leadership"],
          manual: { required: false },
        },
      },
    }),
    captureQuestionsImpl: async () => ({ source: "greenhouse", questions: [], excluded: [] }),
    generateDocumentsImpl: async () => ({
      status: "ready",
      uploadReady: true,
      gaps: [],
      artifacts: { resumePdf: "workspace/tailored/acme-resume.pdf" },
    }),
  });

  const handoff = result.messages
    .at(-1)
    .artifacts.find((artifact) => artifact.kind === "application_handoff");
  assert.deepEqual(handoff.questionCapture, {
    state: "site-required",
    source: null,
    answerableCount: 0,
    excludedCount: 0,
    demographicSectionPresent: false,
    attempted: true,
  });
  assert.match(result.messages.at(-1).text, /paste the questions here/i);
});

test("job.prepare-request keeps a paste-and-resume question path for unsupported sites", async () => {
  const repoRoot = tempRepo();
  const jobUrl = "https://careers.example.test/jobs/staff-ai";
  let captureCalls = 0;

  const result = await executeWorkspaceIntent({
    repoRoot,
    env: {},
    intent: {
      type: "job.prepare-request",
      entity: { type: "workspace", id: WORKSPACE_THREAD_ID },
      input: { jobUrl },
    },
    resolveJobUrlImpl: async () => ({
      bodyFetchStatus: "resolved",
      url: jobUrl,
      title: "Staff AI Engineer",
      company: "Acme",
      bodyText: "Lead production AI systems and platform strategy.",
    }),
    evaluateJobImpl: async ({ body }) => ({
      status: 200,
      body: {
        ok: true,
        data: {
          applicationId: body.applicationId,
          gate: "keep",
          fitScore: 94,
          fitReasons: ["Production AI leadership"],
          manual: { required: false },
        },
      },
    }),
    captureQuestionsImpl: async () => {
      captureCalls += 1;
      return {};
    },
    generateDocumentsImpl: async (input) => {
      if (input.body.applyIntent) {
        const error = new Error("Capture the application questions first.");
        error.code = "BAD_QUESTION_CAPTURE";
        throw error;
      }
      return {
        status: "reviewable",
        uploadReady: false,
        gaps: [
          {
            kind: "answers",
            code: "QUESTION_CAPTURE_DEFERRED",
            message: "The site will provide its questions later.",
          },
        ],
        artifacts: { resumePdf: "workspace/tailored/acme-resume.pdf" },
      };
    },
  });

  assert.equal(captureCalls, 0);
  const handoff = result.messages
    .at(-1)
    .artifacts.find((artifact) => artifact.kind === "application_handoff");
  assert.deepEqual(handoff.questionCapture, {
    state: "site-required",
    source: null,
    answerableCount: 0,
    excludedCount: 0,
    demographicSectionPresent: false,
  });
  assert.match(result.messages.at(-1).text, /paste the questions here/i);
});

test("job.prepare-request keeps moving when application questions are not captured yet", async () => {
  const repoRoot = tempRepo();
  const jobUrl = "https://boards.greenhouse.io/acme/jobs/keep-role";
  const generationCalls = [];

  const result = await executeWorkspaceIntent({
    repoRoot,
    env: {},
    intent: {
      type: "job.prepare-request",
      entity: { type: "workspace", id: WORKSPACE_THREAD_ID },
      input: { jobUrl },
    },
    resolveJobUrlImpl: async () => ({
      bodyFetchStatus: "resolved",
      url: jobUrl,
      title: "Staff AI Engineer",
      company: "Acme",
      bodyText: "Lead production AI systems and platform strategy.",
    }),
    evaluateJobImpl: async ({ body }) => ({
      status: 200,
      body: {
        ok: true,
        data: {
          applicationId: body.applicationId,
          gate: "keep",
          fitScore: 94,
          fitReasons: ["Production AI leadership"],
          manual: { required: false },
        },
      },
    }),
    generateDocumentsImpl: async (input) => {
      generationCalls.push(input);
      if (input.body.applyIntent) {
        const error = new Error("Capture the application questions first.");
        error.code = "BAD_QUESTION_CAPTURE";
        throw error;
      }
      return {
        status: "reviewable",
        uploadReady: false,
        gaps: [
          {
            kind: "answers",
            code: "QUESTION_CAPTURE_DEFERRED",
            message: "The site will provide its questions later.",
          },
        ],
        artifacts: { resumePdf: "workspace/tailored/acme-resume.pdf" },
      };
    },
  });

  assert.deepEqual(
    generationCalls.map((call) => call.body.applyIntent),
    [true, false]
  );
  assert.equal(result.messages.at(-1).metadata.state, "reviewable");
  assert.equal(result.messages.at(-1).metadata.gapCount, 1);
  assert.equal(result.messages.at(-1).metadata.blockingGapCount, 0);
  assert.equal(result.messages.at(-1).artifacts[1].blockingGapCount, 0);
  assert.equal(result.messages.at(-1).artifacts[2].kind, "application_handoff");
  assert.equal(
    result.messages.at(-1).metadata.nextActions[0].intent.type,
    "application.record-external"
  );
  assert.match(result.messages.at(-1).text, /application questions/i);
});

test("job.tailor-request evaluates a KEEP job and generates reviewable documents without an apply handoff", async () => {
  const repoRoot = tempRepo();
  const jobUrl = "https://boards.greenhouse.io/acme/jobs/tailor-role";
  const generationCalls = [];

  const result = await executeWorkspaceIntent({
    repoRoot,
    env: {},
    intent: {
      type: "job.tailor-request",
      entity: { type: "workspace", id: WORKSPACE_THREAD_ID },
      input: { jobUrl },
    },
    resolveJobUrlImpl: async () => ({
      bodyFetchStatus: "resolved",
      url: jobUrl,
      title: "Staff AI Engineer",
      company: "Acme",
      bodyText: "Lead production AI systems and platform strategy.",
    }),
    evaluateJobImpl: async ({ body }) => ({
      status: 200,
      body: {
        ok: true,
        data: {
          applicationId: body.applicationId,
          gate: "keep",
          fitScore: 94,
          fitReasons: ["Production AI leadership"],
          manual: { required: false },
        },
      },
    }),
    generateDocumentsImpl: async (input) => {
      generationCalls.push(input);
      return {
        status: "ready",
        uploadReady: true,
        gaps: [],
        artifacts: {
          resumePdf: "workspace/tailored/acme-resume.pdf",
          coverLetterPdf: "workspace/tailored/acme-cover-letter.pdf",
        },
      };
    },
  });

  assert.equal(generationCalls.length, 1);
  assert.equal(generationCalls[0].body.applyIntent, false);
  assert.deepEqual(
    result.messages.at(-1).artifacts.map((artifact) => artifact.kind),
    ["job_evaluation", "packet_generation"]
  );
  assert.equal(result.messages.at(-1).artifacts[1].purpose, "tailoring");
  assert.equal(result.messages.at(-1).metadata.nextActions[0].label, "Export documents");
  assert.equal(result.messages.at(-1).metadata.nextActions[0].intent.type, "job.export-documents");
  assert.equal(result.messages.at(-1).metadata.nextActions[1].label, "Review documents");
  assert.match(result.messages.at(-1).metadata.nextActions[1].href, /^\/jobs\?open=/);
  assert.match(result.messages.at(-1).text, /tailored résumé and cover letter/i);
  assert.match(result.messages.at(-1).text, /tailored documents are ready to review/i);
  assert.doesNotMatch(result.messages.at(-1).text, /submission handoff|will be completed/i);
});

test("job.tailor-request leaves screening questions until the user chooses to apply", async () => {
  const repoRoot = tempRepo();
  const jobUrl = "https://boards.greenhouse.io/acme/jobs/tailor-with-questions";

  const result = await executeWorkspaceIntent({
    repoRoot,
    env: {},
    intent: {
      type: "job.tailor-request",
      entity: { type: "workspace", id: WORKSPACE_THREAD_ID },
      input: { jobUrl },
    },
    resolveJobUrlImpl: async () => ({
      bodyFetchStatus: "resolved",
      url: jobUrl,
      title: "Staff AI Engineer",
      company: "Acme",
      bodyText: "Lead production AI systems and platform strategy.",
    }),
    evaluateJobImpl: async ({ body }) => ({
      status: 200,
      body: {
        ok: true,
        data: {
          applicationId: body.applicationId,
          gate: "keep",
          fitScore: 94,
          fitReasons: ["Production AI leadership"],
          manual: { required: false },
        },
      },
    }),
    generateDocumentsImpl: async () => ({
      status: "reviewable",
      uploadReady: false,
      gaps: [
        {
          kind: "answers",
          code: "QUESTION_CAPTURE_DEFERRED",
          message: "Capture application questions before applying.",
        },
      ],
      artifacts: {
        resume: "workspace/tailored/acme-resume.md",
        coverLetter: "workspace/tailored/acme-cover-letter.md",
      },
    }),
  });

  assert.match(result.messages.at(-1).text, /only if you later choose to apply/i);
  assert.doesNotMatch(result.messages.at(-1).text, /will be completed/i);
  assert.deepEqual(
    result.messages.at(-1).artifacts.map((artifact) => artifact.kind),
    ["job_evaluation", "packet_generation"]
  );
});

test("job.tailor-request stops on CUT without generating documents", async () => {
  const repoRoot = tempRepo();
  const jobUrl = "https://boards.greenhouse.io/acme/jobs/cut-tailor-role";
  let generated = 0;

  const result = await executeWorkspaceIntent({
    repoRoot,
    env: {},
    intent: {
      type: "job.tailor-request",
      entity: { type: "workspace", id: WORKSPACE_THREAD_ID },
      input: { jobUrl },
    },
    resolveJobUrlImpl: async () => ({
      bodyFetchStatus: "resolved",
      url: jobUrl,
      title: "Regional Sales Engineer",
      company: "Acme",
      bodyText: "Travel weekly and own a quota across the territory.",
    }),
    evaluateJobImpl: async ({ body }) => ({
      status: 200,
      body: {
        ok: true,
        data: {
          applicationId: body.applicationId,
          gate: "cut",
          fitScore: 30,
          fitRisks: ["Outside target role family"],
          manual: { required: false },
        },
      },
    }),
    generateDocumentsImpl: async () => {
      generated += 1;
      return {};
    },
  });

  assert.equal(generated, 0);
  assert.equal(result.messages.at(-1).metadata.state, "cut");
  assert.deepEqual(
    result.messages.at(-1).artifacts.map((artifact) => artifact.kind),
    ["job_evaluation"]
  );
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
    gaps: [
      {
        kind: "answers",
        code: "QUESTION_CAPTURE_DEFERRED",
        message: "Capture application questions before applying.",
      },
    ],
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
    purpose: "tailoring",
    title: "Temporal Labs — Applied AI Engineer — Documents",
    applicationId: "app-temporal",
    status: "reviewable",
    uploadReady: false,
    artifacts: generation.artifacts,
    gaps: generation.gaps,
    blockingGapCount: 0,
  });
  assert.equal(result.messages[1].metadata.state, "reviewable");
  assert.equal(result.messages[1].metadata.gapCount, 1);
  assert.match(result.messages[1].text, /tailored résumé and cover letter/i);
  assert.match(result.messages[1].text, /only if you later choose to apply/i);
  assert.equal(result.messages[1].metadata.blockingGapCount, 0);
  assert.equal(result.messages[1].metadata.nextActions[0].intent.type, "job.export-documents");
  assert.equal(result.messages[1].metadata.nextActions[1].label, "Review documents");
  assert.equal(
    result.messages[1].artifacts.some((artifact) => artifact.kind === "application_handoff"),
    false
  );

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

test("apply-intent document generation degrades to base documents before question capture", async () => {
  const repoRoot = tempRepo();
  seedApplication(repoRoot, {
    evaluation: { gate: "keep" },
    artifacts: { jd: "workspace/jobs/temporal.md" },
  });
  const calls = [];

  const result = await executeWorkspaceIntent({
    repoRoot,
    env: {},
    intent: {
      type: "job.generate-documents",
      entity: { type: "application", id: "app-temporal" },
      input: { applyIntent: true, formats: ["pdf"] },
    },
    generateDocumentsImpl: async (input) => {
      calls.push(input);
      if (input.body.applyIntent) {
        const error = new Error("Capture the application questions first.");
        error.code = "BAD_QUESTION_CAPTURE";
        throw error;
      }
      return {
        applicationId: "app-temporal",
        status: "reviewable",
        uploadReady: false,
        gaps: [
          {
            kind: "answers",
            code: "QUESTION_CAPTURE_DEFERRED",
            message: "The site will provide its questions later.",
          },
        ],
        artifacts: { resumePdf: "workspace/tailored/temporal-resume.pdf" },
      };
    },
  });

  assert.deepEqual(
    calls.map((call) => call.body.applyIntent),
    [true, false]
  );
  assert.equal(result.messages.at(-1).metadata.gapCount, 1);
  assert.equal(result.messages.at(-1).metadata.blockingGapCount, 0);
  assert.equal(
    result.messages.at(-1).metadata.nextActions[0].intent.type,
    "application.record-external"
  );
  assert.match(result.messages.at(-1).text, /application questions/i);
});

test("document generation reports plural review gaps grammatically", async () => {
  const repoRoot = tempRepo();
  seedApplication(repoRoot, {
    evaluation: { gate: "keep" },
    artifacts: { jd: "workspace/jobs/temporal.md" },
  });

  const result = await executeWorkspaceIntent({
    repoRoot,
    env: {},
    intent: {
      type: "job.generate-documents",
      entity: { type: "application", id: "app-temporal" },
      input: { applyIntent: true, formats: ["pdf"] },
    },
    generateDocumentsImpl: async () => ({
      applicationId: "app-temporal",
      status: "reviewable",
      uploadReady: false,
      gaps: [
        { kind: "answers", message: "Confirm the start date." },
        { kind: "answers", message: "Confirm the office cadence." },
      ],
      artifacts: { resumePdf: "workspace/tailored/temporal-resume.pdf" },
    }),
  });

  assert.match(result.messages.at(-1).text, /2 items still need review/i);
  assert.doesNotMatch(result.messages.at(-1).text, /2 items still needs review/i);
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
    companyDiscoveryCadenceImpl: () => ({ status: "current", due: false }),
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

test("a due manual search starts recurring company discovery and returns proposals for review", async () => {
  const repoRoot = tempRepo();
  const companyCalls = [];
  const started = {
    ok: true,
    run: {
      id: "manual-search-with-companies",
      purpose: "manual-search",
      status: "running",
    },
  };
  const proposal = {
    proposalId: "proposal-recurring",
    company: { name: "Recurring Co" },
    why: "Matches the candidate's company thesis.",
    jobBoardUrl: "https://jobs.ashbyhq.com/recurring",
    atsProvider: "ashby",
    version: 1,
  };

  const result = await executeWorkspaceIntent({
    repoRoot,
    env: {},
    intent: {
      type: "search.run",
      entity: { type: "workspace", id: WORKSPACE_THREAD_ID },
      input: { purpose: "manual-search" },
    },
    startManualSearchImpl: async () => started,
    companyDiscoveryCadenceImpl: () => ({
      status: "due",
      due: true,
      reason: "weekly-cadence",
    }),
    createCompanyProposalsImpl: async (input) => {
      companyCalls.push(input);
      return {
        data: {
          batchId: "batch-recurring",
          proposals: [proposal],
          rejected: [],
          counts: { seeds: 1, proposals: 1, rejected: 0 },
        },
        meta: { version: 1, seedSource: "ai" },
      };
    },
    now: () => new Date("2026-08-17T12:00:00.000Z"),
  });

  assert.equal(companyCalls.length, 1);
  assert.deepEqual(companyCalls[0].body, {
    requestedCount: 12,
    trigger: { kind: "search-run", id: "manual-search-with-companies" },
  });
  const message = result.messages.at(-1);
  assert.deepEqual(
    message.artifacts.map((artifact) => artifact.kind),
    ["search_run", "company_proposals"]
  );
  assert.equal(message.metadata.searchTerminal, false);
  assert.equal(message.metadata.companyReview, true);
  assert.equal(message.metadata.companyDiscovery.reason, "weekly-cadence");
  assert.match(message.text, /1 company.*needs review/i);
});

test("the workspace runtime starts the job sweep before recurring company discovery finishes", async () => {
  const repoRoot = tempRepo();
  let releaseCompanyDiscovery;
  const companyDiscoveryBlocked = new Promise((resolve) => {
    releaseCompanyDiscovery = resolve;
  });
  let markBackgroundStarted;
  const backgroundStarted = new Promise((resolve) => {
    markBackgroundStarted = resolve;
  });
  const runtime = createWorkspaceAgentRuntime({
    repoRoot,
    env: {},
    startManualSearchImpl: async () => ({
      ok: true,
      run: { id: "manual-search-concurrent", purpose: "manual-search", status: "running" },
    }),
    companyDiscoveryCadenceImpl: () => ({ status: "due", due: true, reason: "never-run" }),
    createCompanyProposalsImpl: async () => {
      await companyDiscoveryBlocked;
      return {
        data: {
          batchId: "batch-concurrent",
          proposals: [],
          rejected: [],
          counts: { seeds: 0, proposals: 0, rejected: 0 },
        },
        meta: { version: 1, seedSource: "ai" },
      };
    },
    runSearchInBackgroundImpl: async ({ runId }) => {
      markBackgroundStarted(runId);
      return {
        id: runId,
        purpose: "manual-search",
        status: "completed",
        summary: { scanned: 1, presented: 1, filtered: 0, reconciled: 1 },
      };
    },
  });

  const turn = runtime.executeIntent({
    intent: {
      type: "search.run",
      entity: { type: "workspace", id: WORKSPACE_THREAD_ID },
      input: { purpose: "manual-search" },
    },
  });

  assert.equal(await backgroundStarted, "manual-search-concurrent");
  releaseCompanyDiscovery();
  await turn;
});

test("a manual search reopens pending company proposals instead of creating a duplicate batch", async () => {
  const repoRoot = tempRepo();
  let createCalls = 0;
  const result = await executeWorkspaceIntent({
    repoRoot,
    env: {},
    intent: {
      type: "search.run",
      entity: { type: "workspace", id: WORKSPACE_THREAD_ID },
      input: { purpose: "manual-search" },
    },
    startManualSearchImpl: async () => ({
      ok: true,
      run: { id: "manual-search-pending", purpose: "manual-search", status: "running" },
    }),
    companyDiscoveryCadenceImpl: () => ({
      status: "needs-review",
      due: false,
      reason: "pending-review",
      batchId: "batch-pending",
      pendingCount: 1,
    }),
    createCompanyProposalsImpl: async () => {
      createCalls += 1;
      throw new Error("must not create a duplicate batch");
    },
    getCompanyProposalBatchImpl: () => ({
      batch: {
        batchId: "batch-pending",
        status: "pending",
        version: 3,
        proposals: [
          {
            proposalId: "proposal-pending",
            company: { name: "Pending Co" },
            version: 3,
          },
        ],
        rejected: [],
        counts: { seeds: 1, proposals: 1, rejected: 0 },
      },
    }),
  });

  assert.equal(createCalls, 0);
  assert.equal(result.messages.at(-1).artifacts[1].batchId, "batch-pending");
  assert.equal(result.messages.at(-1).metadata.companyReview, true);
});

test("finishing search-triggered company review links to the running search", async () => {
  const repoRoot = tempRepo();
  const result = await executeWorkspaceIntent({
    repoRoot,
    env: {},
    intent: {
      type: "company.proposal-decide",
      entity: { type: "company-proposal", id: "proposal-recurring" },
      input: {
        batchId: "batch-recurring",
        action: "reject",
        expectedVersion: 1,
      },
    },
    decideCompanyProposalImpl: async () => ({
      data: {
        proposal: { proposalId: "proposal-recurring", company: { name: "Recurring Co" } },
      },
    }),
    getCompanyProposalBatchImpl: () => ({
      batch: {
        batchId: "batch-recurring",
        status: "rejected",
        version: 2,
        trigger: { kind: "search-run", id: "manual-search-with-companies" },
        proposals: [
          {
            proposalId: "proposal-recurring",
            company: { name: "Recurring Co" },
            version: 2,
            decision: { action: "reject", status: "rejected" },
          },
        ],
        rejected: [],
        counts: { seeds: 1, proposals: 1, rejected: 0 },
      },
    }),
  });

  assert.deepEqual(result.messages.at(-1).metadata.nextActions, [
    { label: "Review the current job search", href: "/jobs?tab=search" },
  ]);
});

test("company discovery returns reviewable proposals in workspace-main without writing sources", async () => {
  const repoRoot = tempRepo();
  const calls = [];
  const proposal = {
    proposalId: "proposal-acme",
    company: { name: "Acme AI", domain: "acme.example" },
    why: "Matches the candidate's applied AI focus.",
    roleSeen: "Applied AI Engineer",
    jobBoardUrl: "https://jobs.lever.co/acme",
    atsProvider: "lever",
    classification: "supported_ats",
    confidenceTier: "high-confidence",
    capturedOffers: [
      {
        title: "Applied AI Engineer",
        bodyText: "FULL JD BODY MUST STAY IN THE JOB ARTIFACT",
        artifacts: { jd: "workspace/jobs/acme-applied-ai-engineer.md" },
      },
    ],
    version: 1,
  };

  const result = await executeWorkspaceIntent({
    repoRoot,
    env: {},
    intent: {
      type: "company.discover",
      entity: { type: "workspace", id: WORKSPACE_THREAD_ID },
      input: { requestedCount: 8, request: "find companies like my focus examples" },
    },
    createCompanyProposalsImpl: async (input) => {
      calls.push(input);
      return {
        data: {
          batchId: "batch-acme",
          proposals: [proposal],
          rejected: [],
          counts: { seeds: 1, proposals: 1, rejected: 0 },
        },
        meta: { version: 1, seedSource: "ai", ai: { used: true } },
      };
    },
    now: () => new Date("2026-08-09T14:05:00.000Z"),
  });

  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].body, {
    requestedCount: 8,
    request: "find companies like my focus examples",
  });
  const { capturedOffers: _capturedOffers, ...compactProposal } = proposal;
  assert.equal(result.messages.at(-1).kind, "action_result");
  assert.equal(result.messages.at(-1).metadata.state, "needs-review");
  assert.deepEqual(result.messages.at(-1).artifacts[0], {
    kind: "company_proposals",
    title: "Company discovery: 1 to review",
    batchId: "batch-acme",
    version: 1,
    proposals: [compactProposal],
    rejected: [],
    counts: { seeds: 1, proposals: 1, rejected: 0 },
    seedSource: "ai",
  });
  assert.doesNotMatch(JSON.stringify(result.messages.at(-1)), /FULL JD BODY/);
  assert.match(result.messages.at(-1).text, /beyond your focus examples/i);
});

test("a confirmed company decision stays in the workspace thread and hands off to search", async () => {
  const repoRoot = tempRepo();
  const decisions = [];
  const result = await executeWorkspaceIntent({
    repoRoot,
    env: {},
    intent: {
      type: "company.proposal-decide",
      entity: { type: "company-proposal", id: "proposal-acme" },
      input: {
        batchId: "batch-acme",
        action: "approve-supported-ats",
        expectedVersion: 1,
      },
    },
    decideCompanyProposalImpl: async (input) => {
      decisions.push(input);
      return {
        data: {
          decision: { action: "approve-supported-ats", status: "approved" },
          proposal: {
            proposalId: "proposal-acme",
            company: { name: "Acme AI" },
            version: 2,
          },
        },
        meta: { version: 2 },
      };
    },
    getCompanyProposalBatchImpl: () => ({
      batch: {
        batchId: "batch-acme",
        status: "approved",
        version: 2,
        proposals: [
          {
            proposalId: "proposal-acme",
            company: { name: "Acme AI" },
            version: 2,
            decision: { action: "approve-supported-ats", status: "approved" },
          },
        ],
        rejected: [],
        counts: { seeds: 1, proposals: 1, rejected: 0 },
      },
    }),
  });

  assert.deepEqual(decisions[0].body, {
    batchId: "batch-acme",
    proposalId: "proposal-acme",
    action: "approve-supported-ats",
    expectedVersion: 1,
    userConfirmed: true,
  });
  const message = result.messages.at(-1);
  assert.match(message.text, /Tracking Acme AI/i);
  assert.equal(message.metadata.state, "complete");
  assert.equal(message.metadata.nextActions[0].intent.type, "search.run");
  assert.equal(message.artifacts[0].proposals.length, 0);
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

test("chat-first intake rejects an invalid requested action before writing the thread", async () => {
  const repoRoot = tempRepo();

  await assert.rejects(
    captureWorkspaceIntake({
      repoRoot,
      env: {},
      text: "Temporal Labs is hiring an Applied AI Engineer.",
      requestedAction: "submit-without-confirmation",
      captureIntakeImpl: async () => {
        assert.fail("invalid requested actions must not reach intake capture");
      },
    }),
    (error) => error.code === "BAD_REQUESTED_ACTION"
  );

  assert.deepEqual(workspaceThreadRead({ repoRoot, env: {} }).messages, []);
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

test("a natural user-reported application resolves one saved job and records it", async () => {
  const repoRoot = tempRepo();
  seedApplication(repoRoot);

  const result = await executeWorkspaceIntent({
    repoRoot,
    env: {},
    intent: {
      type: "application.record-external-request",
      entity: { type: "workspace", id: WORKSPACE_THREAD_ID },
      input: { jobReference: "I applied to the Temporal Labs Applied AI Engineer role." },
    },
    now: () => new Date("2026-08-15T14:30:00.000Z"),
  });

  const app = readApplication(repoRoot, "app-temporal");
  assert.equal(app.status, "applied");
  assert.equal(app.appliedAt, "2026-08-15T14:30:00.000Z");
  assert.equal(result.messages[0].intent.type, "application.record-external-request");
  assert.deepEqual(result.messages[1].entity, { type: "application", id: "app-temporal" });
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

test("natural outcome requests resolve one application and persist the typed transition", async () => {
  const repoRoot = tempRepo();
  seedApplication(repoRoot, { status: "interview" });

  const result = await executeWorkspaceIntent({
    repoRoot,
    env: {},
    intent: {
      type: "outcome.record-request",
      entity: { type: "workspace", id: WORKSPACE_THREAD_ID },
      input: {
        jobReference: "I got rejected by Temporal Labs.",
        to: "rejected",
        note: "I got rejected by Temporal Labs.",
      },
    },
  });

  const app = readApplication(repoRoot, "app-temporal");
  assert.equal(app.status, "rejected");
  assert.equal(app.statusNote, "I got rejected by Temporal Labs.");
  assert.equal(result.messages[0].intent.type, "outcome.record-request");
  assert.deepEqual(result.messages[1].entity, { type: "application", id: "app-temporal" });
  assert.equal(result.messages[1].metadata.state, "rejected");
});

test("natural outcome requests refuse an ambiguous application instead of guessing", async () => {
  const repoRoot = tempRepo();
  seedApplication(repoRoot, { id: "app-temporal-ai", role: "Applied AI Engineer" });
  seedApplication(repoRoot, { id: "app-temporal-platform", role: "Platform Engineer" });

  await assert.rejects(
    executeWorkspaceIntent({
      repoRoot,
      env: {},
      intent: {
        type: "outcome.record-request",
        entity: { type: "workspace", id: WORKSPACE_THREAD_ID },
        input: {
          jobReference: "I got rejected by Temporal Labs.",
          to: "rejected",
          note: "I got rejected by Temporal Labs.",
        },
      },
    }),
    (error) => error.code === "JOB_REFERENCE_AMBIGUOUS"
  );

  assert.equal(readApplication(repoRoot, "app-temporal-ai").status, "reviewed-hold");
  assert.equal(readApplication(repoRoot, "app-temporal-platform").status, "reviewed-hold");
  const messages = workspaceThreadRead({ repoRoot, env: {} }).messages;
  assert.equal(messages.at(-1).kind, "action_error");
  assert.match(messages.at(-1).text, /more than one saved job/i);
});

test("natural interview prep resolves one application and returns the dossier in Ask", async () => {
  const repoRoot = tempRepo();
  seedApplication(repoRoot, { status: "interview" });
  const calls = [];

  const result = await executeWorkspaceIntent({
    repoRoot,
    env: {},
    intent: {
      type: "interview.prepare-request",
      entity: { type: "workspace", id: WORKSPACE_THREAD_ID },
      input: {
        jobReference: "Prepare me for my Temporal Labs Applied AI Engineer interview.",
      },
    },
    buildInterviewDossierImpl: (input) => {
      calls.push(input);
      return {
        company: "Temporal Labs",
        role: "Applied AI Engineer",
        dossier: {
          title: "Temporal Labs interview dossier",
          path: "workspace/interview-prep/temporal.md",
          markdown: "# Temporal Labs",
        },
      };
    },
  });

  assert.equal(calls[0].applicationId, "app-temporal");
  assert.equal(result.messages[0].intent.type, "interview.prepare-request");
  assert.deepEqual(result.messages[1].entity, { type: "application", id: "app-temporal" });
  assert.equal(result.messages[1].artifacts[0].kind, "interview_dossier");
  assert.deepEqual(result.messages[1].metadata.nextActions, [
    { label: "Open dossier", href: "/jobs?dossier=app-temporal" },
  ]);
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

test("natural scheduling requests prepare a timezone-explicit draft and tentative hold in Ask", async () => {
  const repoRoot = tempRepo();
  seedApplication(repoRoot, { status: "interview" });
  const threadArtifact = "workspace/comms/temporal-interview-availability.md";
  mkdirSync(join(repoRoot, "workspace", "comms"), { recursive: true });
  writeFileSync(
    join(repoRoot, threadArtifact),
    "Avery offered Wednesday August 14 at 2:00 PM ET for the recruiter screen."
  );
  seedCommunication(repoRoot, {
    messages: [
      {
        direction: "inbound",
        at: "2026-08-09T13:00:00.000Z",
        summary: "Recruiter offered a time.",
        artifactPath: threadArtifact,
      },
    ],
  });
  candidateConfigPatch({
    repoRoot,
    env: {},
    name: "profile",
    patch: {
      candidate: { preferred_name: "Sam" },
      location: { home: "New York, NY" },
      availability: {
        timezone: "America/New_York",
        working_hours: "09:00-18:00",
        preferred_days: ["Tue", "Wed", "Thu"],
        preferred_times: "afternoons",
        buffer_minutes: 15,
        default_meeting_minutes: 30,
      },
    },
  });
  calendarBusyUpsert({
    repoRoot,
    env: {},
    blocks: [
      {
        provider: "google_calendar",
        startIso: "2030-08-13T16:00:00.000Z",
        endIso: "2030-08-13T16:30:00.000Z",
      },
    ],
  });
  const calls = [];

  const result = await executeWorkspaceIntent({
    repoRoot,
    env: {},
    intent: {
      type: "scheduling.prepare-request",
      entity: { type: "workspace", id: WORKSPACE_THREAD_ID },
      input: {
        communicationReference: "the Temporal Labs recruiter",
        instruction: "Accept Wednesday at 2 PM ET and prepare the reply.",
      },
    },
    prepareSchedulingPlanImpl: async (input) => {
      calls.push(input);
      return {
        status: "ready",
        plan: {
          state: "tentative_hold",
          timezone: "America/New_York",
          timezoneAssumed: false,
          timezoneNote: "",
          subject: "Re: Interview availability",
          body: "Hi Avery, Wednesday at 2:00 PM ET works for me. Best, Sam",
          round: "recruiter screen",
          contactName: "Avery",
          durationMinutes: 30,
          selectedSlotIndex: 0,
          slots: [
            {
              startIso: "2030-08-14T18:00:00.000Z",
              endIso: "2030-08-14T18:30:00.000Z",
              label: "Wed Aug 14, 2:00 PM ET",
            },
          ],
          missing: [],
        },
        calendarChecked: true,
        hold: {
          filename: "temporal-labs-recruiter-screen-hold-2030-08-14.ics",
          ics: "BEGIN:VCALENDAR\r\nEND:VCALENDAR",
        },
        ai: { engine: { label: "Codex" }, elapsedMs: 12 },
      };
    },
    now: () => new Date("2030-08-10T12:00:00.000Z"),
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].communication.id, "comm-temporal-recruiter");
  assert.equal(calls[0].application.id, "app-temporal");
  assert.equal(calls[0].profile.availability.timezone, "America/New_York");
  assert.equal(calls[0].calendarBusy.length, 1);
  assert.match(calls[0].communication.messages[0].body, /Wednesday August 14 at 2:00 PM ET/);
  const comm = readCommunication(repoRoot, "comm-temporal-recruiter");
  assert.equal(comm.status, "drafted");
  assert.match(comm.draft.body, /2:00 PM ET/);
  assert.equal(readApplication(repoRoot, "app-temporal").interviewAt, undefined);
  const message = result.messages.at(-1);
  assert.doesNotMatch(message.text, /—/);
  assert.equal(message.artifacts[0].kind, "scheduling_plan");
  assert.equal(message.artifacts[0].hold.filename.endsWith(".ics"), true);
  assert.equal(message.metadata.requiresReview, true);
  assert.equal(message.metadata.calendarChecked, true);
  assert.deepEqual(message.metadata.nextActions, [
    { label: "Review job and reply", href: "/jobs?open=app-temporal" },
  ]);
});

test("scheduling needs-you results do not create a draft or invent a booked interview", async () => {
  const repoRoot = tempRepo();
  seedApplication(repoRoot, { status: "interview" });
  seedCommunication(repoRoot);

  const result = await executeWorkspaceIntent({
    repoRoot,
    env: {},
    intent: {
      type: "scheduling.prepare-request",
      entity: { type: "workspace", id: WORKSPACE_THREAD_ID },
      input: {
        communicationReference: "the Temporal Labs recruiter",
        instruction: "Handle scheduling.",
      },
    },
    prepareSchedulingPlanImpl: async () => ({
      status: "needs_user",
      missing: ["availability", "timezone"],
      message: "Tell me which days or times work and confirm your timezone.",
      calendarChecked: false,
      ai: { used: false },
    }),
  });

  const comm = readCommunication(repoRoot, "comm-temporal-recruiter");
  assert.equal(comm.status, "needs-reply");
  assert.equal(comm.draft, undefined);
  assert.equal(readApplication(repoRoot, "app-temporal").interviewAt, undefined);
  const message = result.messages.at(-1);
  assert.equal(message.metadata.state, "needs-user");
  assert.equal(message.artifacts[0].kind, "scheduling_plan");
  assert.deepEqual(message.artifacts[0].missing, ["availability", "timezone"]);
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

test("communication.add-note returns a communication_note artifact and falls back from input.summary to input.note", async () => {
  const repoRoot = tempRepo();
  seedApplication(repoRoot);
  seedCommunication(repoRoot);

  const bySummary = await executeWorkspaceIntent({
    repoRoot,
    env: {},
    intent: {
      type: "communication.add-note",
      entity: { type: "communication", id: "comm-temporal-recruiter" },
      input: { summary: "  Candidate prefers Tuesday afternoon.  " },
    },
  });
  assert.deepEqual(bySummary.messages.at(-1).artifacts[0], {
    kind: "communication_note",
    communicationId: "comm-temporal-recruiter",
    company: "Temporal Labs",
    role: "Applied AI Engineer",
    note: "Candidate prefers Tuesday afternoon.",
  });

  const byNoteFallback = await executeWorkspaceIntent({
    repoRoot,
    env: {},
    intent: {
      type: "communication.add-note",
      entity: { type: "communication", id: "comm-temporal-recruiter" },
      input: { note: "They asked about remote flexibility." },
    },
  });
  assert.equal(
    byNoteFallback.messages.at(-1).artifacts[0].note,
    "They asked about remote flexibility."
  );
});

test("communication.note-request rejects a matched-but-empty note with EMPTY_COMMUNICATION_NOTE before touching the thread", async () => {
  const repoRoot = tempRepo();
  seedApplication(repoRoot);
  seedCommunication(repoRoot);

  await assert.rejects(
    executeWorkspaceIntent({
      repoRoot,
      env: {},
      intent: {
        type: "communication.note-request",
        entity: { type: "workspace", id: WORKSPACE_THREAD_ID },
        input: { reference: "Temporal Labs", note: "   " },
      },
    }),
    (error) => error.code === "EMPTY_COMMUNICATION_NOTE"
  );
  assert.equal(readCommunication(repoRoot, "comm-temporal-recruiter").messages.length, 1);
});

test("communication.note-request resolves a natural thread reference and appends the note", async () => {
  const repoRoot = tempRepo();
  seedApplication(repoRoot);
  seedCommunication(repoRoot);

  const result = await executeWorkspaceIntent({
    repoRoot,
    env: {},
    intent: {
      type: "communication.note-request",
      entity: { type: "workspace", id: WORKSPACE_THREAD_ID },
      input: { reference: "Temporal Labs", note: "Called to confirm availability." },
    },
  });

  assert.deepEqual(result.messages.at(-1).entity, {
    type: "communication",
    id: "comm-temporal-recruiter",
  });
  const comm = readCommunication(repoRoot, "comm-temporal-recruiter");
  assert.equal(comm.messages.at(-1).direction, "note");
  assert.equal(comm.messages.at(-1).summary, "Called to confirm availability.");
  const artifact = result.messages.at(-1).artifacts[0];
  assert.equal(artifact.kind, "communication_note");
  assert.equal(artifact.note, "Called to confirm availability.");
});

test("communication.record-external tiers verification by whether a draft existed", async () => {
  const repoRoot = tempRepo();
  seedApplication(repoRoot);
  seedCommunication(repoRoot, {
    id: "comm-drafted",
    status: "drafted",
    draft: { subject: "Re: Interview availability", body: "Tuesday works." },
  });
  seedCommunication(repoRoot, { id: "comm-bare", status: "needs-reply" });

  const supervised = await executeWorkspaceIntent({
    repoRoot,
    env: {},
    intent: {
      type: "communication.record-external",
      entity: { type: "communication", id: "comm-drafted" },
    },
  });
  assert.equal(supervised.operationResult.verification, "supervised");

  const userReport = await executeWorkspaceIntent({
    repoRoot,
    env: {},
    intent: {
      type: "communication.record-external",
      entity: { type: "communication", id: "comm-bare" },
    },
  });
  assert.equal(userReport.operationResult.verification, "user_report");
});

test("communication.send passes verification: 'verified' explicitly to commMarkSent", async () => {
  const repoRoot = tempRepo();
  seedApplication(repoRoot);
  seedCommunication(repoRoot, {
    status: "drafted",
    draft: { subject: "Re: Interview availability", body: "Tuesday afternoon works for me." },
  });

  await executeWorkspaceIntent({
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

  const db = openDb({ repoRoot, env: {} });
  const row = db.prepare("SELECT data FROM activity_events ORDER BY rowid DESC LIMIT 1").get();
  const event = JSON.parse(row.data);
  assert.match(event.summary, /delivery was verified/i);
});

test("communication.handoff prepares a ready-to-send artifact as a pure read — no communication write", async () => {
  const repoRoot = tempRepo();
  seedApplication(repoRoot);
  const seeded = seedCommunication(repoRoot, {
    status: "drafted",
    draft: { subject: "Re: Interview availability", body: "Tuesday afternoon works for me." },
    participants: [{ name: "Avery Recruiter", email: "avery@temporal.test" }],
  });

  const result = await executeWorkspaceIntent({
    repoRoot,
    env: {},
    intent: {
      type: "communication.handoff",
      entity: { type: "communication", id: "comm-temporal-recruiter" },
    },
  });

  const artifact = result.messages.at(-1).artifacts[0];
  assert.equal(artifact.kind, "communication_handoff");
  assert.equal(artifact.communicationId, "comm-temporal-recruiter");
  assert.equal(artifact.company, "Temporal Labs");
  assert.equal(artifact.role, "Applied AI Engineer");
  assert.equal(artifact.subject, "Re: Interview availability");
  assert.equal(artifact.to, "avery@temporal.test");
  assert.equal(artifact.state, "ready");
  assert.match(artifact.links.mailto, /^mailto:avery%40temporal\.test\?subject=/);
  assert.match(artifact.links.gmail, /^https:\/\/mail\.google\.com\/mail\//);
  assert.match(artifact.links.outlook, /^https:\/\/outlook\.live\.com\/mail\//);
  assert.deepEqual(result.messages.at(-1).metadata.nextActions, [
    {
      label: "I sent this",
      intent: {
        type: "communication.record-external",
        entity: { type: "communication", id: "comm-temporal-recruiter" },
      },
    },
  ]);

  // Pure read: the communication row is byte-for-byte unchanged.
  assert.deepEqual(readCommunication(repoRoot, "comm-temporal-recruiter"), seeded);
});

test("communication.handoff returns no-recipient when the thread has no plausible contact email", async () => {
  const repoRoot = tempRepo();
  seedApplication(repoRoot);
  seedCommunication(repoRoot, {
    status: "drafted",
    draft: { subject: "Re: Interview availability", body: "Tuesday afternoon works for me." },
  });

  const result = await executeWorkspaceIntent({
    repoRoot,
    env: {},
    intent: {
      type: "communication.handoff",
      entity: { type: "communication", id: "comm-temporal-recruiter" },
    },
  });

  const artifact = result.messages.at(-1).artifacts[0];
  assert.equal(artifact.state, "no-recipient");
  assert.equal(artifact.to, null);
  assert.match(result.messages.at(-1).text, /no contact email address/i);
});

test("communication.handoff-request resolves a natural reference and normalizes to communication.handoff", async () => {
  const repoRoot = tempRepo();
  seedApplication(repoRoot);
  seedCommunication(repoRoot, {
    status: "drafted",
    draft: { subject: "Re: Interview availability", body: "Tuesday afternoon works for me." },
    participants: [{ name: "Avery Recruiter", email: "avery@temporal.test" }],
  });

  const result = await executeWorkspaceIntent({
    repoRoot,
    env: {},
    intent: {
      type: "communication.handoff-request",
      entity: { type: "workspace", id: WORKSPACE_THREAD_ID },
      input: { communicationReference: "the Temporal Labs recruiter" },
    },
  });

  assert.equal(result.messages.at(-2).intent.type, "communication.handoff-request");
  assert.deepEqual(result.messages.at(-1).entity, {
    type: "communication",
    id: "comm-temporal-recruiter",
  });
  assert.equal(result.messages.at(-1).artifacts[0].state, "ready");
});

test("communication.handoff refuses a non-email channel with COMMUNICATION_CHANNEL_UNSUPPORTED", async () => {
  const repoRoot = tempRepo();
  seedApplication(repoRoot);
  seedCommunication(repoRoot, {
    channel: "linkedin",
    status: "drafted",
    draft: { subject: "Re: Interview availability", body: "Tuesday afternoon works for me." },
  });

  await assert.rejects(
    executeWorkspaceIntent({
      repoRoot,
      env: {},
      intent: {
        type: "communication.handoff",
        entity: { type: "communication", id: "comm-temporal-recruiter" },
      },
    }),
    (error) => {
      assert.equal(error.code, "COMMUNICATION_CHANNEL_UNSUPPORTED");
      assert.equal(error.details.channel, "linkedin");
      return true;
    }
  );
});

test("communication.handoff requires a draft before it will prepare a send", async () => {
  const repoRoot = tempRepo();
  seedApplication(repoRoot);
  seedCommunication(repoRoot, { status: "needs-reply" });

  await assert.rejects(
    executeWorkspaceIntent({
      repoRoot,
      env: {},
      intent: {
        type: "communication.handoff",
        entity: { type: "communication", id: "comm-temporal-recruiter" },
      },
    }),
    (error) => error.code === "COMMUNICATION_DRAFT_REQUIRED"
  );
});

test("communication.send also refuses a non-email channel, before checking for a draft or executor", async () => {
  const repoRoot = tempRepo();
  seedApplication(repoRoot);
  seedCommunication(repoRoot, { channel: "linkedin", status: "needs-reply" });

  await assert.rejects(
    executeWorkspaceIntent({
      repoRoot,
      env: {},
      intent: {
        type: "communication.send",
        entity: { type: "communication", id: "comm-temporal-recruiter" },
      },
    }),
    (error) => {
      assert.equal(error.code, "COMMUNICATION_CHANNEL_UNSUPPORTED");
      assert.equal(error.details.channel, "linkedin");
      return true;
    }
  );
});

test("natural recruiter requests resolve one thread for drafting and user-reported sends", async () => {
  const repoRoot = tempRepo();
  seedApplication(repoRoot);
  seedCommunication(repoRoot);

  const drafted = await executeWorkspaceIntent({
    repoRoot,
    env: {},
    intent: {
      type: "communication.draft-request",
      entity: { type: "workspace", id: WORKSPACE_THREAD_ID },
      input: {
        communicationReference: "the Temporal Labs recruiter",
        instruction: "Tuesday afternoon works.",
      },
    },
    callAIImpl: async () => ({
      content: [{ type: "text", text: "Thanks. Tuesday afternoon works for me." }],
      engine: { label: "Codex" },
    }),
  });

  assert.equal(readCommunication(repoRoot, "comm-temporal-recruiter").status, "drafted");
  assert.equal(drafted.messages[0].intent.type, "communication.draft-request");
  assert.deepEqual(drafted.messages[1].entity, {
    type: "communication",
    id: "comm-temporal-recruiter",
  });

  const sent = await executeWorkspaceIntent({
    repoRoot,
    env: {},
    intent: {
      type: "communication.record-external-request",
      entity: { type: "workspace", id: WORKSPACE_THREAD_ID },
      input: { communicationReference: "the Temporal Labs recruiter" },
    },
  });

  const communication = readCommunication(repoRoot, "comm-temporal-recruiter");
  assert.equal(communication.status, "waiting");
  assert.equal(communication.draft, null);
  assert.equal(sent.messages.at(-2).intent.type, "communication.record-external-request");
  assert.equal(sent.messages.at(-1).metadata.recordingMode, "external_report");
});

test("natural recruiter requests refuse ambiguous threads without drafting", async () => {
  const repoRoot = tempRepo();
  seedApplication(repoRoot);
  seedCommunication(repoRoot, { id: "comm-temporal-one", subject: "Interview availability" });
  seedCommunication(repoRoot, { id: "comm-temporal-two", subject: "Application update" });

  await assert.rejects(
    executeWorkspaceIntent({
      repoRoot,
      env: {},
      intent: {
        type: "communication.draft-request",
        entity: { type: "workspace", id: WORKSPACE_THREAD_ID },
        input: {
          communicationReference: "the Temporal Labs recruiter",
          instruction: "Tuesday works.",
        },
      },
      callAIImpl: async () => {
        throw new Error("must not draft an ambiguous thread");
      },
    }),
    (error) => error.code === "COMMUNICATION_REFERENCE_AMBIGUOUS"
  );

  assert.equal(readCommunication(repoRoot, "comm-temporal-one").draft, undefined);
  assert.equal(readCommunication(repoRoot, "comm-temporal-two").draft, undefined);
});

test("one-off screening questions draft inside Ask and offer confirmed durable reuse", async () => {
  const repoRoot = tempRepo();
  seedApplication(repoRoot);
  const calls = [];

  const result = await executeWorkspaceIntent({
    repoRoot,
    env: {},
    intent: {
      type: "screening.answer",
      entity: { type: "application", id: "app-temporal" },
      input: { questionText: "Will you now or later require sponsorship?" },
    },
    answerScreeningQuestionsImpl: async (input) => {
      calls.push(input);
      return {
        applicationId: "app-temporal",
        company: "Temporal Labs",
        role: "Applied AI Engineer",
        answers: [
          {
            key: "will you now or later require sponsorship",
            question: "Will you now or later require sponsorship?",
            answer: "I do not require employment sponsorship.",
            source: "profile",
            durable: true,
            uploadReady: true,
          },
        ],
        excluded: [],
        needsUser: false,
        artifactPath: null,
        ai: { engine: { label: "Codex" }, elapsedMs: 18 },
      };
    },
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].applicationId, "app-temporal");
  assert.equal(calls[0].questionText, "Will you now or later require sponsorship?");
  const message = result.messages.at(-1);
  assert.equal(message.artifacts[0].kind, "screening_answers");
  assert.equal(message.artifacts[0].answers[0].source, "profile");
  assert.equal(message.metadata.requiresReview, true);
  assert.equal(message.metadata.persisted, false);
  assert.deepEqual(message.metadata.nextActions, [
    {
      label: "Save for future applications",
      intent: {
        type: "screening.answer-save",
        entity: { type: "candidate", id: "candidate" },
        input: {
          question: "Will you now or later require sponsorship?",
          key: "will you now or later require sponsorship",
          answer: "I do not require employment sponsorship.",
        },
      },
    },
  ]);
  assert.match(message.text, /review this answer/i);
});

test("one-off screening questions reuse saved profile disclosures without requiring AI", async () => {
  const repoRoot = tempRepo();
  candidateConfigPatch({
    repoRoot,
    env: {},
    name: "profile",
    patch: { authorization: { requires_sponsorship: false } },
  });

  const result = await executeWorkspaceIntent({
    repoRoot,
    env: {},
    intent: {
      type: "screening.answer",
      entity: { type: "workspace", id: WORKSPACE_THREAD_ID },
      input: { questionText: "Will you now or later require sponsorship?" },
    },
  });

  const message = result.messages.at(-1);
  const answer = message.artifacts[0].answers[0];
  assert.equal(answer.source, "profile");
  assert.equal(answer.durable, true);
  assert.match(answer.answer, /do not require sponsorship/i);
  assert.equal(message.metadata.ai.used, false);
  assert.equal(message.metadata.nextActions[0].intent.type, "screening.answer-save");
});

test("confirmed reusable screening answers persist through the owning candidate settings writer", async () => {
  const repoRoot = tempRepo();
  const calls = [];

  const result = await executeWorkspaceIntent({
    repoRoot,
    env: {},
    intent: {
      type: "screening.answer-save",
      entity: { type: "candidate", id: "candidate" },
      input: {
        question: "Will you now or later require sponsorship?",
        key: "will you now or later require sponsorship",
        answer: "I do not require employment sponsorship.",
      },
    },
    saveScreeningAnswerImpl: (input) => {
      calls.push(input);
      return {
        key: input.key,
        answer: input.answer,
        persisted: true,
      };
    },
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].key, "will you now or later require sponsorship");
  const message = result.messages.at(-1);
  assert.equal(message.artifacts[0].kind, "screening_answer_saved");
  assert.equal(message.metadata.persisted, true);
  assert.equal(message.metadata.nextActions, undefined);
  assert.match(message.text, /future applications/i);
});

test("Apply on site returns a manual handoff without changing status when no executor is connected", async () => {
  const repoRoot = tempRepo();
  const seeded = seedApplication(repoRoot);

  const result = await executeWorkspaceIntent({
    repoRoot,
    env: {},
    intent: {
      type: "job.apply",
      entity: { type: "application", id: "app-temporal" },
    },
    ...preparedApplyDeps(),
  });

  assert.equal(readApplication(repoRoot, "app-temporal").status, "reviewed-hold");
  assert.deepEqual(
    result.messages.map(({ role, kind }) => ({ role, kind })),
    [
      { role: "user", kind: "intent" },
      { role: "assistant", kind: "action_result" },
    ]
  );
  assert.equal(result.messages[1].artifacts[0].kind, "application_handoff");
  assert.equal(result.messages[1].artifacts[0].url, seeded.link);
  assert.equal(result.messages[1].metadata.state, "manual-handoff");
  assert.equal(result.messages[1].metadata.submissionVerified, false);
  assert.equal(
    result.messages[1].metadata.nextActions[0].intent.type,
    "application.record-external"
  );
  assert.match(result.messages[1].text, /couldn't connect to a supervised browser/i);
  assert.doesNotMatch(result.messages[1].text, /executor/i);
  assert.match(result.messages[1].text, /not marked Applied/i);
});

test("Apply on site asks for a safe application link instead of returning an unsafe handoff", async () => {
  const repoRoot = tempRepo();
  seedApplication(repoRoot, { link: "javascript:alert(1)" });

  const result = await executeWorkspaceIntent({
    repoRoot,
    env: {},
    intent: {
      type: "job.apply",
      entity: { type: "application", id: "app-temporal" },
    },
    ...preparedApplyDeps(),
  });

  assert.equal(result.messages.at(-1).artifacts[0].kind, "application_link_required");
  assert.equal(result.messages.at(-1).artifacts[0].code, "APPLICATION_URL_REQUIRED");
  assert.match(result.messages.at(-1).text, /paste the application link/i);
  assert.equal(readApplication(repoRoot, "app-temporal").status, "reviewed-hold");
});

test("Apply on site captures supported public questions before the supervised handoff", async () => {
  const repoRoot = tempRepo();
  const link = "https://boards.greenhouse.io/temporal/jobs/123";
  seedApplication(repoRoot, { link });
  const captures = [];

  const result = await executeWorkspaceIntent({
    repoRoot,
    env: {},
    intent: {
      type: "job.apply",
      entity: { type: "application", id: "app-temporal" },
    },
    ...preparedApplyDeps(),
    captureQuestionsImpl: async (input) => {
      captures.push(input);
      return {
        source: "greenhouse",
        questions: [{ id: "q1", label: "Why Temporal?" }],
        excluded: [],
        demographicSectionPresent: false,
      };
    },
  });

  assert.equal(captures.length, 1);
  assert.equal(captures[0].applicationId, "app-temporal");
  assert.equal(captures[0].url, link);
  assert.equal(readApplication(repoRoot, "app-temporal").status, "reviewed-hold");
  assert.deepEqual(result.messages.at(-1).artifacts[0].questionCapture, {
    state: "captured",
    source: "greenhouse",
    answerableCount: 1,
    excludedCount: 0,
    demographicSectionPresent: false,
  });
});

test("Apply on site runs the KEEP gate and packet build before opening the executor", async () => {
  const repoRoot = tempRepo();
  seedApplication(repoRoot);
  const steps = [];

  const result = await executeWorkspaceIntent({
    repoRoot,
    env: {},
    intent: {
      type: "job.apply",
      entity: { type: "application", id: "app-temporal" },
    },
    evaluateJobImpl: async ({ body }) => {
      steps.push("evaluate");
      return preparedApplyDeps().evaluateJobImpl({ body });
    },
    generateDocumentsImpl: async () => {
      steps.push("packet");
      return preparedApplyDeps().generateDocumentsImpl();
    },
    applyJobImpl: async () => {
      steps.push("executor");
      return {
        available: true,
        verified: false,
        state: "awaiting-submit",
        reason: "Review the form.",
        session: { provider: "orca", filledCount: 3, unresolved: [], blockers: [] },
      };
    },
  });

  assert.deepEqual(steps, ["evaluate", "packet", "executor"]);
  assert.equal(result.messages.at(-1).metadata.state, "awaiting-submit");
});

test("Apply on site stops on CUT before packet generation or browser execution", async () => {
  const repoRoot = tempRepo();
  seedApplication(repoRoot);
  let packetCalls = 0;
  let executorCalls = 0;

  const result = await executeWorkspaceIntent({
    repoRoot,
    env: {},
    intent: {
      type: "job.apply",
      entity: { type: "application", id: "app-temporal" },
    },
    evaluateJobImpl: async ({ body }) => ({
      status: 200,
      body: {
        ok: true,
        data: {
          applicationId: body.applicationId,
          gate: "cut",
          fitScore: 31,
          manual: { required: false },
        },
      },
    }),
    generateDocumentsImpl: async () => {
      packetCalls += 1;
      return preparedApplyDeps().generateDocumentsImpl();
    },
    applyJobImpl: async () => {
      executorCalls += 1;
      return { verified: true };
    },
  });

  assert.equal(packetCalls, 0);
  assert.equal(executorCalls, 0);
  assert.equal(result.messages.at(-1).metadata.state, "cut");
  assert.match(result.messages.at(-1).text, /did not open the application form/i);
  assert.equal(readApplication(repoRoot, "app-temporal").status, "reviewed-hold");
});

test("Apply on site rebuilds the packet after the live browser discovers rendered questions", async () => {
  const repoRoot = tempRepo();
  seedApplication(repoRoot);
  const steps = [];
  let executorCalls = 0;

  const result = await executeWorkspaceIntent({
    repoRoot,
    env: {},
    intent: {
      type: "job.apply",
      entity: { type: "application", id: "app-temporal" },
    },
    evaluateJobImpl: async ({ body }) => {
      steps.push("evaluate");
      return preparedApplyDeps().evaluateJobImpl({ body });
    },
    generateDocumentsImpl: async () => {
      steps.push("packet");
      return preparedApplyDeps().generateDocumentsImpl();
    },
    applyJobImpl: async ({ questionCapture }) => {
      executorCalls += 1;
      steps.push(executorCalls === 1 ? "executor-inspect" : "executor-fill");
      if (executorCalls === 1) {
        appRegisterPacketQuestionCapture({
          repoRoot,
          env: {},
          id: "app-temporal",
          path: "workspace/jobs/temporal-rendered.questions.json",
          questions: [
            { id: "q1", label: "Why Temporal?" },
            { id: "q2", label: "Describe a system you owned." },
          ],
          excluded: [],
        });
        return {
          available: true,
          verified: false,
          state: "questions-captured",
          questionCaptureUpdated: true,
          session: { provider: "orca", answerableCount: 2, excludedCount: 0 },
        };
      }
      assert.equal(questionCapture.state, "captured");
      assert.equal(questionCapture.answerableCount, 2);
      return {
        available: true,
        verified: false,
        state: "awaiting-submit",
        reason: "Review the form.",
        session: { provider: "orca", filledCount: 6, unresolved: [], blockers: [] },
      };
    },
  });

  assert.deepEqual(steps, ["evaluate", "packet", "executor-inspect", "packet", "executor-fill"]);
  assert.equal(result.messages.at(-1).metadata.state, "awaiting-submit");
  assert.equal(result.messages.at(-1).artifacts[0].questionCapture.answerableCount, 2);
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
      ...preparedApplyDeps(),
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
    ...preparedApplyDeps(),
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

test("Apply on site keeps an active supervised browser session without treating it as failure", async () => {
  const repoRoot = tempRepo();
  seedApplication(repoRoot);

  const result = await executeWorkspaceIntent({
    repoRoot,
    env: {},
    intent: {
      type: "job.apply",
      entity: { type: "application", id: "app-temporal" },
    },
    ...preparedApplyDeps(),
    applyJobImpl: async () => ({
      available: true,
      verified: false,
      state: "awaiting-submit",
      reason: "Review and submit in the supervised browser.",
      currentUrl: "https://jobs.example.test/temporal/applied-ai-engineer/apply",
      session: {
        provider: "orca",
        filledCount: 5,
        uploadedCount: 2,
        unresolved: [{ label: "Portfolio", required: true }],
        blockers: [],
        submitMode: "manual",
      },
    }),
  });

  assert.equal(readApplication(repoRoot, "app-temporal").status, "reviewed-hold");
  const last = result.messages.at(-1);
  assert.equal(last.metadata.state, "awaiting-submit");
  assert.equal(last.metadata.submissionVerified, false);
  assert.equal(last.artifacts[0].kind, "application_handoff");
  assert.equal(last.artifacts[0].session.filledCount, 5);
  assert.equal(last.metadata.nextActions[0].label, "Rescan and verify");
  assert.equal(last.metadata.nextActions[0].intent.type, "job.apply");
  assert.match(last.text, /filled 5 fields/i);
  assert.match(last.text, /attached 2 files/i);
  assert.match(last.text, /not marked Applied/i);
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

test("workspace action errors return actionable client statuses instead of server errors", async () => {
  const repoRoot = tempRepo();
  const cases = [
    ["JOB_URL_REQUIRED", 400],
    ["JOB_IDENTITY_REQUIRED", 400],
    ["JOB_REFERENCE_NOT_FOUND", 404],
    ["JOB_REFERENCE_AMBIGUOUS", 409],
    ["COMMUNICATION_REFERENCE_NOT_FOUND", 404],
    ["COMMUNICATION_REFERENCE_AMBIGUOUS", 409],
    ["JOB_CAPTURE_FAILED", 409],
    ["JOB_BODY_REQUIRES_BROWSER", 409],
    ["CONFLICT", 409],
    ["VALIDATION_FAILED", 422],
    ["NO_AI_ROUTE", 501],
    ["COMPANY_NOT_FOUND", 404],
    ["COMPANY_AMBIGUOUS", 409],
    ["COMPANY_NOT_TRACKED", 409],
    ["RESEARCH_COMP_INPUT_REQUIRED", 400],
    ["RESEARCH_RECORD_INVALID", 400],
    ["BAD_HEALTH_RATING", 400],
    ["STRATEGY_APPLY_UNSUPPORTED", 400],
    ["STRATEGY_APPLY_INVALID", 400],
    ["STRATEGY_APPLY_STALE", 409],
  ];

  for (const [code, expectedStatus] of cases) {
    const routes = mountDirect(repoRoot, async () => {
      const error = new Error(`job request failed: ${code}`);
      error.code = code;
      throw error;
    });
    const response = await callDirect(routes, "POST", "/api/workspace/intent", {
      intent: {
        type: "job.evaluate-request",
        entity: { type: "workspace", id: WORKSPACE_THREAD_ID },
        input: { jobUrl: "https://jobs.example.test/acme/role" },
      },
    });
    assert.equal(response.status, expectedStatus, code);
    assert.equal(response.body.code, code);
  }
});

test("workspace ambiguity errors expose only structured candidate-safe match labels", async () => {
  const repoRoot = tempRepo();
  const routes = mountDirect(repoRoot, async () => {
    const error = new Error("internal ambiguity detail");
    error.code = "JOB_REFERENCE_AMBIGUOUS";
    error.details = {
      matches: [
        { company: "Acme", role: "Senior AI Engineer" },
        { company: "Acme", role: "Staff Platform Engineer" },
      ],
    };
    throw error;
  });
  const response = await callDirect(routes, "POST", "/api/workspace/intent", {
    intent: {
      type: "job.evaluate-request",
      entity: { type: "workspace", id: WORKSPACE_THREAD_ID },
      input: { jobReference: "rate the Acme role" },
    },
  });

  assert.equal(response.status, 409);
  assert.deepEqual(response.body.details.matches, [
    { company: "Acme", role: "Senior AI Engineer" },
    { company: "Acme", role: "Staff Platform Engineer" },
  ]);
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

test("workspace intake route returns 400 for an invalid requested action", async () => {
  const repoRoot = tempRepo();
  const invalidAction = new Error('requestedAction must be "evaluate", "prepare", or "tailor"');
  invalidAction.code = "BAD_REQUESTED_ACTION";
  const routes = mountDirect(repoRoot, undefined, undefined, async () => {
    throw invalidAction;
  });

  const response = await callDirect(routes, "POST", "/api/workspace/intake", {
    text: "Temporal Labs is hiring an Applied AI Engineer.",
    requestedAction: "submit-without-confirmation",
  });

  assert.equal(response.status, 400);
  assert.equal(response.body.code, "BAD_REQUESTED_ACTION");
});
