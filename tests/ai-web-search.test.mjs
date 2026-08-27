import assert from "node:assert/strict";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

import { closeAll } from "../src/core/db/connection.mjs";
import { readDbScannerRows } from "../src/core/db/scan-context.mjs";
import {
  candidateConfigPatch,
  candidateSetupInitialize,
  sourcedUpsertBatch,
} from "../src/core/db/verbs.mjs";
import { userPath } from "../src/core/paths/workspace.mjs";
import { runAiWebSearch } from "../src/core/search/ai-web-search.mjs";
import { saveSearchPrompts } from "../src/core/search/search-prompts.mjs";

const roots = [];

function repo({ mode = "standard", prompts = 5 } = {}) {
  const repoRoot = mkdtempSync(join(tmpdir(), "careerrat-ai-web-search-"));
  roots.push(repoRoot);
  mkdirSync(join(repoRoot, "config"), { recursive: true });
  copyFileSync(
    new URL("../config/ai-web-search.schema.json", import.meta.url),
    join(repoRoot, "config/ai-web-search.schema.json")
  );
  candidateSetupInitialize({ repoRoot });
  candidateConfigPatch({ repoRoot, name: "modes", patch: { usage_mode: mode } });
  saveSearchPrompts({
    repoRoot,
    prompts: Array.from({ length: prompts }, (_, index) => ({
      id: `p${index + 1}`,
      text: `Find role ${index + 1}`,
    })),
  });
  return repoRoot;
}

function assistantJson(data) {
  return async ({ input, onEvent }) => {
    const kickoff = typeof input === "string" ? JSON.parse(input.split("\n\n", 1)[0]) : input;
    assistantJson.inputs.push(kickoff);
    const promptIds = new Set((kickoff.prompts || []).map((prompt) => prompt.id));
    const allQueries = Array.isArray(data.queries_run) ? data.queries_run : [];
    const queriesRun = allQueries.filter((query) => promptIds.has(query.prompt_id));
    const scoped = {
      ...data,
      roles: !allQueries.length || queriesRun.length ? data.roles : [],
      queries_run: queriesRun,
    };
    onEvent({
      type: "assistant",
      data: {
        message: {
          content: [{ type: "text", text: `\`\`\`json\n${JSON.stringify(scoped)}\n\`\`\`` }],
        },
      },
    });
  };
}
assistantJson.inputs = [];

function role(overrides = {}) {
  return {
    company: "Acme AI",
    title: "Applied AI Engineer",
    url: "https://jobs.lever.co/acme/req-1",
    body_text: "Build customer-facing agent workflows.",
    body_partial: false,
    fit_score: 88,
    fit_bucket: "high",
    fit_basis: "Strong role and tool match.",
    rule_flags: [],
    source_evidence: "The posting explicitly describes applied AI delivery.",
    ...overrides,
  };
}

function fullJd(label = "Canonical job description") {
  return `${label}. ${"Own production systems, collaborate across teams, and ship reliable customer-facing software. ".repeat(12)}`;
}

function canonicalResolver(overrides = {}) {
  return async (url) => ({
    bodyFetchStatus: "resolved",
    url,
    bodyText: fullJd(),
    ...overrides,
  });
}

after(() => {
  closeAll();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

test("runAiWebSearch caps saved prompts by lean, standard, and full mode", async () => {
  for (const [mode, expected] of [
    ["lean", 1],
    ["standard", 3],
    ["full", 5],
  ]) {
    assistantJson.inputs = [];
    const repoRoot = repo({ mode });
    const result = await runAiWebSearch({
      repoRoot,
      env: {},
      runSkillStream: assistantJson({ roles: [], queries_run: [] }),
    });
    assert.equal(result.searched, expected);
    assert.equal(assistantJson.inputs.length, expected);
    assert.ok(assistantJson.inputs.every((kickoff) => kickoff.prompts.length === 1));
    assert.deepEqual(
      assistantJson.inputs.map((kickoff) => kickoff.prompts[0].id).sort(),
      Array.from({ length: expected }, (_, index) => `p${index + 1}`)
    );
  }
});

test("AI web search uses the provider-neutral web research policy without changing usage breadth", async () => {
  const repoRoot = repo({ mode: "lean", prompts: 3 });
  const calls = [];
  const executionPlan = Object.freeze({
    operation: "research.web",
    runtimeId: "codex",
    resolved: Object.freeze({ model: "gpt-5.6-terra", effort: "medium" }),
  });
  const respond = assistantJson({ roles: [], queries_run: [] });
  await runAiWebSearch({
    repoRoot,
    env: {},
    executionPlan,
    runSkillStream: async (options) => {
      calls.push(options);
      return respond(options);
    },
  });

  assert.equal(calls.length, 1, "lean usage mode still controls prompt breadth only");
  assert.equal(calls[0].aiOperation, undefined);
  assert.equal(calls[0].executionPlan, executionPlan);
});

test("a successful zero-result AI search revalidates active rows against the current policy", async () => {
  const repoRoot = repo({ prompts: 1 });
  candidateConfigPatch({
    repoRoot,
    name: "profile",
    patch: { compensation: { minimum_base: 180000 } },
  });
  const artifact = "workspace/jobs/stale-ai-result.md";
  mkdirSync(userPath({ repoRoot }, "workspace/jobs"), { recursive: true });
  writeFileSync(
    userPath({ repoRoot }, artifact),
    "---\ncompany: Stale AI Co\nrole: Staff Engineer\npartial: true\n---\n\nSalary range: $120,000 - $150,000 annually.\n"
  );
  sourcedUpsertBatch({
    repoRoot,
    rows: [
      {
        id: "stale-ai-result",
        company: "Stale AI Co",
        role: "Staff Engineer",
        status: "sourced",
        source: "ai-web-search",
        channel: "board",
        link: "https://jobs.example.test/stale-ai",
        loc: "USA (Remote)",
        base: "verify",
        fitScore: 80,
        fitBucket: "med",
        fitBasis: "triage",
        gate: "review",
        sourcedAt: "2026-08-27T12:00:00.000Z",
        updatedAt: "2026-08-27T12:00:00.000Z",
        artifacts: { jd: artifact },
        scanner: { bodyPartial: true },
      },
    ],
  });

  const result = await runAiWebSearch({
    repoRoot,
    env: {},
    runSkillStream: assistantJson({ roles: [], queries_run: [] }),
  });

  assert.equal(result.new, 0);
  assert.deepEqual(result.revalidatedExisting.hiddenIds, ["stale-ai-result"]);
  assert.equal(
    readDbScannerRows({ repoRoot }).find((row) => row.id === "stale-ai-result").status,
    "cut"
  );
});

test("runAiWebSearch gives installed runtimes the same structured output schema it validates", async () => {
  const repoRoot = repo({ prompts: 1 });
  let receivedSchema;
  await runAiWebSearch({
    repoRoot,
    env: {},
    runSkillStream: async ({ outputSchema, onEvent }) => {
      receivedSchema = outputSchema;
      onEvent({
        type: "assistant",
        data: {
          message: {
            content: [{ type: "text", text: '```json\n{"roles":[],"queries_run":[]}\n```' }],
          },
        },
      });
    },
  });

  assert.deepEqual(receivedSchema.required, ["roles", "queries_run"]);
  assert.equal(receivedSchema.properties.roles.type, "array");
  assert.equal(receivedSchema.properties.roles.maxItems, 40);
});

test("runAiWebSearch gives installed web research enough time and preserves runtime failures", async () => {
  const repoRoot = repo({ prompts: 1 });
  let calls = 0;
  let receivedTimeoutMs = null;
  const result = await runAiWebSearch({
    repoRoot,
    env: {},
    runSkillStream: async ({ timeoutMs, onEvent }) => {
      calls += 1;
      receivedTimeoutMs = timeoutMs;
      const failure = {
        ok: false,
        error: "Installed AI request timed out.",
        code: "RUNTIME_TIMEOUT",
      };
      onEvent({ type: "error", data: { message: failure.error, code: failure.code } });
      onEvent({ type: "result", data: failure });
      return failure;
    },
  });

  assert.equal(calls, 1, "a runtime failure must not be retried as invalid JSON");
  assert.equal(receivedTimeoutMs, 30 * 60 * 1000);
  assert.equal(result.errors[0], "AI search took too long to finish. Try it again.");
  assert.doesNotMatch(result.errors[0], /schema|route|runtime|provider/i);
  assert.deepEqual(result.failedPromptIds, ["p1"]);
});

test("runAiWebSearch isolates a failed prompt and preserves successful siblings in saved order", async () => {
  const repoRoot = repo({ prompts: 3 });
  const callCount = new Map();
  const receivedPromptIds = [];
  let active = 0;
  let maxActive = 0;
  const result = await runAiWebSearch({
    repoRoot,
    env: {},
    runSkillStream: async ({ input, onEvent }) => {
      const kickoff = typeof input === "string" ? JSON.parse(input.split("\n\n", 1)[0]) : input;
      const promptId = kickoff.prompts[0].id;
      assert.equal(kickoff.prompts.length, 1);
      receivedPromptIds.push(promptId);
      callCount.set(promptId, (callCount.get(promptId) || 0) + 1);
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, promptId === "p1" ? 12 : 6));
      active -= 1;

      if (promptId === "p2") {
        return {
          ok: false,
          error: "Installed AI request timed out.",
          code: "RUNTIME_TIMEOUT",
        };
      }

      const index = Number(promptId.slice(1));
      onEvent({
        type: "tool_use",
        data: { id: `search-${promptId}`, name: "WebSearch", input: { query: `query ${index}` } },
      });
      onEvent({
        type: "tool_use",
        data: {
          id: `fetch-${promptId}`,
          name: "WebFetch",
          input: { url: `https://jobs.example.test/${promptId}` },
        },
      });
      onEvent({
        type: "assistant",
        data: {
          message: {
            content: [
              {
                type: "text",
                text: `\`\`\`json\n${JSON.stringify({
                  roles: [
                    role({
                      company: `Company ${index}`,
                      title: `Platform Engineer ${index}`,
                      url: `https://jobs.example.test/${promptId}`,
                    }),
                  ],
                  queries_run: [
                    { prompt_id: promptId, query: `query ${index}`, status: "completed" },
                  ],
                })}\n\`\`\``,
              },
            ],
          },
        },
      });
      return { ok: true };
    },
    resolveJobUrlImpl: canonicalResolver(),
  });

  assert.deepEqual(Object.fromEntries(callCount), { p1: 1, p2: 1, p3: 1 });
  assert.deepEqual(receivedPromptIds.slice().sort(), ["p1", "p2", "p3"]);
  assert.equal(maxActive, 2);
  assert.equal(result.found, 2);
  assert.equal(result.new, 2);
  assert.deepEqual(result.failedPromptIds, ["p2"]);
  assert.deepEqual(
    result.queryResults.map(({ promptId, status }) => ({ promptId, status })),
    [
      { promptId: "p1", status: "completed" },
      { promptId: "p2", status: "failed" },
      { promptId: "p3", status: "completed" },
    ]
  );
  assert.deepEqual(
    result.offers.map(({ company }) => company),
    ["Company 1", "Company 3"]
  );
  assert.deepEqual(
    result.sources.slice(0, 2).map(({ url }) => url),
    ["https://jobs.example.test/p1", "https://jobs.example.test/p3"]
  );
});

test("AI web-search skill gives each saved prompt a small exploration budget", () => {
  const skill = readFileSync(
    new URL("../.agents/skills/search-jobs/SKILL.md", import.meta.url),
    "utf8"
  );
  assert.match(skill, /at most 2 `WebSearch` calls per saved prompt/i);
  assert.match(skill, /at most 4 job-posting `WebFetch` calls per saved prompt/i);
});

test("runAiWebSearch reports structured prompt lifecycle and periodic health", async () => {
  const repoRoot = repo({ prompts: 1 });
  const progress = [];
  const originalSetInterval = globalThis.setInterval;
  const originalClearInterval = globalThis.clearInterval;
  const heartbeatHandle = { unref() {} };
  globalThis.setInterval = (callback, ms) => {
    assert.equal(ms, 30 * 1000);
    callback();
    return heartbeatHandle;
  };
  globalThis.clearInterval = (handle) => assert.equal(handle, heartbeatHandle);

  try {
    await runAiWebSearch({
      repoRoot,
      env: {},
      runSkillStream: assistantJson({
        roles: [],
        queries_run: [{ prompt_id: "p1", query: "platform jobs", status: "completed" }],
      }),
      onProgress: (event) => progress.push(event),
    });
  } finally {
    globalThis.setInterval = originalSetInterval;
    globalThis.clearInterval = originalClearInterval;
  }

  assert.deepEqual(
    progress
      .filter((event) => event.phase === "prompt")
      .map(({ promptId, promptIndex, promptTotal, promptStatus, heartbeat = false }) => ({
        promptId,
        promptIndex,
        promptTotal,
        promptStatus,
        heartbeat,
      })),
    [
      {
        promptId: "p1",
        promptIndex: 1,
        promptTotal: 1,
        promptStatus: "running",
        heartbeat: false,
      },
      {
        promptId: "p1",
        promptIndex: 1,
        promptTotal: 1,
        promptStatus: "running",
        heartbeat: true,
      },
      {
        promptId: "p1",
        promptIndex: 1,
        promptTotal: 1,
        promptStatus: "completed",
        heartbeat: false,
      },
    ]
  );
});

test("runAiWebSearch hydrates a bounded number of roles concurrently and preserves input receipt order", async () => {
  const repoRoot = repo({ prompts: 1 });
  const roles = Array.from({ length: 9 }, (_, index) =>
    role({
      company: `Company ${index}`,
      title: `Platform Engineer ${index}`,
      url: `https://careers.example.test/jobs/${index}`,
    })
  );
  let active = 0;
  let maxActive = 0;

  const result = await runAiWebSearch({
    repoRoot,
    env: {},
    runSkillStream: assistantJson({
      roles,
      queries_run: [{ prompt_id: "p1", query: "platform jobs" }],
    }),
    resolveJobUrlImpl: async (url) => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      const index = Number(new URL(url).pathname.split("/").pop());
      await new Promise((resolve) => setTimeout(resolve, (9 - index) * 2));
      active -= 1;
      return { bodyFetchStatus: "resolved", url, bodyText: fullJd(`Role ${index}`) };
    },
  });

  assert.equal(result.new, 9);
  assert.ok(maxActive > 1, `expected concurrent hydration, saw ${maxActive}`);
  assert.ok(maxActive <= 4, `expected at most four concurrent hydrations, saw ${maxActive}`);
  assert.deepEqual(
    result.sources.map((source) => source.url),
    roles.map((item) => item.url)
  );
});

test("runAiWebSearch refreshes durable activity through hydration and before persistence", async () => {
  const repoRoot = repo({ prompts: 1 });
  const timeline = [];

  const result = await runAiWebSearch({
    repoRoot,
    env: {},
    runSkillStream: assistantJson({
      roles: [role()],
      queries_run: [{ prompt_id: "p1", query: "applied AI jobs" }],
    }),
    resolveJobUrlImpl: async (url) => {
      timeline.push("hydrating");
      return { bodyFetchStatus: "resolved", url, bodyText: fullJd() };
    },
    onProgress: (event) => {
      if (event?.type !== "activity") return;
      timeline.push(event.message);
      if (/saving/i.test(event.message)) {
        assert.equal(
          readDbScannerRows({ repoRoot }).filter((row) => row.source === "ai-web-search").length,
          0,
          "the persistence heartbeat must land before the database write"
        );
      }
    },
  });

  assert.equal(result.new, 1);
  assert.deepEqual(timeline, [
    "Running 1 saved search prompt…",
    "Searching saved prompt 1 of 1…",
    "Finished saved prompt 1 of 1.",
    "Checking details for 1 discovered job…",
    "hydrating",
    "Checked details for 1 of 1 discovered jobs…",
    "Saving 1 qualified job…",
  ]);
});

test("runAiWebSearch hard-dedupes batch and drops stale pre-hydration cut gates", async () => {
  const repoRoot = repo();
  sourcedUpsertBatch({
    repoRoot,
    rows: [
      {
        id: "existing",
        company: "Existing Co",
        role: "AI Engineer",
        status: "sourced",
        source: "scanner",
        channel: "board",
        link: "https://example.test/existing",
        loc: "Remote",
        base: "verify",
        fitScore: 70,
        fitBucket: "med",
        fitBasis: "triage",
        gate: "review",
        sourcedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        artifacts: {},
        note: "existing",
      },
    ],
  });
  const roles = [
    role(),
    role(),
    role({
      company: "Existing Co",
      title: "AI Engineer",
      url: "https://example.test/existing",
    }),
    role({
      company: "Cut Co",
      title: "Backend Engineer",
      url: "https://example.test/cut",
      rule_flags: ["comp-below-floor"],
    }),
  ];

  const result = await runAiWebSearch({
    repoRoot,
    env: {},
    runSkillStream: assistantJson({ roles, queries_run: [{ prompt_id: "p1", query: "ai jobs" }] }),
    resolveJobUrlImpl: canonicalResolver(),
  });

  assert.deepEqual(
    {
      searched: result.searched,
      found: result.found,
      new: result.new,
      duplicates: result.duplicates,
      errors: result.errors,
      failedPromptIds: result.failedPromptIds,
      queryResults: result.queryResults,
    },
    {
      searched: 3,
      found: 4,
      new: 2,
      duplicates: 2,
      errors: [],
      failedPromptIds: ["p2", "p3"],
      queryResults: [
        {
          promptId: "p1",
          prompt: "Find role 1",
          status: "completed",
          queries: [{ query: "ai jobs", status: "completed", error: null }],
        },
        {
          promptId: "p2",
          prompt: "Find role 2",
          status: "failed",
          queries: [],
          error: "No query coverage was reported for this saved prompt.",
        },
        {
          promptId: "p3",
          prompt: "Find role 3",
          status: "failed",
          queries: [],
          error: "No query coverage was reported for this saved prompt.",
        },
      ],
    }
  );
  const added = readDbScannerRows({ repoRoot }).filter((row) => row.source === "ai-web-search");
  assert.deepEqual(added.map((row) => [row.company, row.gate]).sort(), [
    ["Acme AI", "review"],
    ["Cut Co", "review"],
  ]);
  assert.ok(added.every((row) => row.artifacts?.jd));
});

test("runAiWebSearch keeps likely-cut only when canonical scoring finds a cut flag", async () => {
  const repoRoot = repo({ prompts: 1 });
  candidateConfigPatch({
    repoRoot,
    name: "targeting",
    patch: { cut_signals: ["heavy travel"] },
  });

  const result = await runAiWebSearch({
    repoRoot,
    env: {},
    runSkillStream: assistantJson({
      roles: [role({ rule_flags: [] })],
      queries_run: [{ prompt_id: "p1", query: "ai jobs" }],
    }),
    resolveJobUrlImpl: canonicalResolver({
      bodyText: fullJd("This role requires heavy travel"),
    }),
  });

  assert.equal(result.new, 1);
  const [saved] = readDbScannerRows({ repoRoot }).filter((row) => row.source === "ai-web-search");
  assert.equal(saved.gate, "likely-cut");
  assert.match(saved.note, /cut-risk-heavy-travel/);
});

test("runAiWebSearch recovers bounded source receipts for roles deduped before persistence", async () => {
  const repoRoot = repo({ prompts: 1 });
  const duplicateUrl = "https://jobs.lever.co/acme/req-1";
  sourcedUpsertBatch({
    repoRoot,
    rows: [
      {
        id: "existing-acme-role",
        company: "Acme AI",
        role: "Applied AI Engineer",
        status: "sourced",
        source: "scanner",
        channel: "board",
        link: duplicateUrl,
        loc: "Remote, US",
        base: "verify",
        fitScore: 80,
        fitBucket: "med",
        fitBasis: "triage",
        gate: "review",
        sourcedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        artifacts: {},
        note: "existing",
      },
    ],
  });
  let resolutionCalls = 0;
  const result = await runAiWebSearch({
    repoRoot,
    env: {},
    runSkillStream: assistantJson({
      roles: [role({ url: duplicateUrl })],
      queries_run: [{ prompt_id: "p1", query: "ai jobs" }],
    }),
    resolveJobUrlImpl: async (url) => {
      resolutionCalls += 1;
      return {
        bodyFetchStatus: "resolved",
        url,
        bodyText: fullJd("PRIVATE CANONICAL BODY MUST NOT ENTER THE RECEIPT"),
      };
    },
  });

  assert.equal(result.new, 0);
  assert.equal(result.duplicates, 1);
  assert.equal(resolutionCalls, 1);
  assert.deepEqual(result.sources, [
    { url: duplicateUrl, status: "completed", host: "jobs.lever.co" },
  ]);
  assert.doesNotMatch(JSON.stringify(result.sources), /PRIVATE CANONICAL BODY/);
  assert.equal(readDbScannerRows({ repoRoot }).length, 1);
});

test("runAiWebSearch reconciles a role persisted by a parallel lane after discovery began", async () => {
  const repoRoot = repo({ prompts: 1 });
  let inserted = false;
  const result = await runAiWebSearch({
    repoRoot,
    env: {},
    runSkillStream: assistantJson({
      roles: [role()],
      queries_run: [{ prompt_id: "p1", query: "ai jobs" }],
    }),
    resolveJobUrlImpl: async (url) => {
      if (!inserted) {
        inserted = true;
        sourcedUpsertBatch({
          repoRoot,
          rows: [
            {
              id: "parallel-deterministic-role",
              company: "Acme AI",
              role: "Applied AI Engineer",
              status: "sourced",
              source: "scanner",
              channel: "board",
              link: "https://jobs.lever.co/acme/req-1",
              loc: "Remote, US",
              base: "verify",
              fitScore: 85,
              fitBucket: "high",
              fitBasis: "triage",
              gate: "review",
              sourcedAt: new Date().toISOString(),
              updatedAt: new Date().toISOString(),
              artifacts: {},
            },
          ],
        });
      }
      return canonicalResolver()(url);
    },
  });

  assert.equal(result.new, 0);
  assert.equal(result.duplicates, 1);
  assert.deepEqual(result.offers, []);
  assert.equal(readDbScannerRows({ repoRoot }).length, 1);
});

test("runAiWebSearch replaces model summaries with canonical JD captures", async () => {
  const repoRoot = repo({ prompts: 1 });
  const canonicalBody = fullJd("The canonical board body");
  const result = await runAiWebSearch({
    repoRoot,
    env: {},
    runSkillStream: assistantJson({
      roles: [role({ body_text: "A short model-written summary.", body_partial: false })],
      queries_run: [{ prompt_id: "p1", query: "ai jobs" }],
    }),
    resolveJobUrlImpl: canonicalResolver({ bodyText: canonicalBody }),
  });

  assert.equal(result.new, 1);
  assert.equal(result.partial, 0);
  assert.equal(result.unreadable, 0);
  assert.ok(
    result.sources.some(
      (source) => source.url === "https://jobs.lever.co/acme/req-1" && source.status === "completed"
    )
  );
  const [saved] = readDbScannerRows({ repoRoot }).filter((row) => row.source === "ai-web-search");
  assert.equal(saved.scanner.bodyChars, canonicalBody.trim().length);
  const capture = readFileSync(userPath({ repoRoot }, saved.artifacts.jd), "utf8");
  assert.match(capture, /The canonical board body/);
  assert.doesNotMatch(capture, /short model-written summary/);
  assert.match(capture, /partial: false/);
});

test("runAiWebSearch requalifies canonical job facts before capture", async () => {
  const repoRoot = repo({ prompts: 1 });
  candidateConfigPatch({
    repoRoot,
    name: "profile",
    patch: {
      compensation: { minimum_base: 180000 },
      location: {
        home: "Brooklyn, NY",
        remote: true,
        remote_scope: "home-country",
        hybrid: true,
        onsite: false,
        max_commute_days_per_week: 2,
        relocation: [],
      },
    },
  });
  candidateConfigPatch({
    repoRoot,
    name: "targeting",
    patch: { role_buckets: [{ name: "Primary", titles: ["Software Engineer"] }] },
  });
  const canonical = new Map([
    [
      "https://jobs.example.test/stealth",
      {
        location: "San Francisco, CA (Remote)",
        bodyText: "Location: San Francisco Bay Area, CA (in-person).",
      },
    ],
    [
      "https://jobs.example.test/david",
      {
        location: "New York, NY (Remote)",
        bodyText: "We work in the office 5 days per week in New York City.",
      },
    ],
    [
      "https://jobs.example.test/credence",
      {
        location: "Tysons Corner, VA (Remote)",
        bodyText: "Salary Range: $120,000 - $150,000 annually.",
      },
    ],
  ]);
  const result = await runAiWebSearch({
    repoRoot,
    env: {},
    runSkillStream: assistantJson({
      roles: [
        role({
          company: "Stealth Startup",
          title: "Founding Software Engineer",
          url: "https://jobs.example.test/stealth",
          location: "Remote",
        }),
        role({
          company: "David",
          title: "Software Engineer, AI & Internal Tools",
          url: "https://jobs.example.test/david",
          location: "Remote",
        }),
        role({
          company: "Credence",
          title: "AI Software Engineer",
          url: "https://jobs.example.test/credence",
          location: "Remote",
        }),
      ],
      queries_run: [{ prompt_id: "p1", query: "software engineer jobs" }],
    }),
    resolveJobUrlImpl: async (url) => ({
      bodyFetchStatus: "resolved",
      url,
      ...canonical.get(url),
    }),
  });

  assert.equal(result.new, 0);
  assert.equal(result.disqualified, 3);
  assert.deepEqual(result.reasonCounts, { location: 2, salary: 1 });
  assert.equal(readDbScannerRows({ repoRoot }).length, 0);
  assert.equal(existsSync(userPath({ repoRoot }, "workspace/jobs")), false);
});

test("runAiWebSearch persists a safety-capped canonical body as partial, never full", async () => {
  const repoRoot = repo({ prompts: 1 });
  const cappedBody = "C".repeat(65_536);
  const result = await runAiWebSearch({
    repoRoot,
    env: {},
    runSkillStream: assistantJson({
      roles: [role({ body_text: "Model preview only.", body_partial: false })],
      queries_run: [{ prompt_id: "p1", query: "ai jobs" }],
    }),
    resolveJobUrlImpl: canonicalResolver({
      bodyText: cappedBody,
      bodyPartial: true,
      reason: "The job description exceeded the provider capture safety limit.",
    }),
  });

  assert.equal(result.new, 1);
  assert.equal(result.partial, 1);
  const [saved] = readDbScannerRows({ repoRoot }).filter((row) => row.source === "ai-web-search");
  const capture = readFileSync(userPath({ repoRoot }, saved.artifacts.jd), "utf8");
  assert.match(capture, /partial: true/);
  assert.doesNotMatch(capture, /partial: false/);
});

test("runAiWebSearch preserves a fetched excerpt as partial when canonical recovery defers", async () => {
  const repoRoot = repo({ prompts: 1 });
  const excerpt =
    "The posting excerpt says this role owns a production platform and works with TypeScript.";
  const result = await runAiWebSearch({
    repoRoot,
    env: {},
    runSkillStream: assistantJson({
      roles: [role({ body_text: excerpt, body_partial: false })],
      queries_run: [{ prompt_id: "p1", query: "ai jobs" }],
    }),
    resolveJobUrlImpl: async (url) => ({
      bodyFetchStatus: "deferred",
      url,
      reason: "The board needs a browser session.",
    }),
  });

  assert.equal(result.new, 1);
  assert.equal(result.partial, 1);
  assert.equal(result.unreadable, 0);
  assert.ok(result.sources.some((source) => source.status === "deferred"));
  const [saved] = readDbScannerRows({ repoRoot }).filter((row) => row.source === "ai-web-search");
  const capture = readFileSync(userPath({ repoRoot }, saved.artifacts.jd), "utf8");
  assert.match(capture, /partial: true/);
  assert.match(capture, /posting excerpt says/);
});

test("runAiWebSearch preserves an open-web lead when canonical recovery defers", async () => {
  const repoRoot = repo({ prompts: 1 });
  candidateConfigPatch({
    repoRoot,
    name: "profile",
    patch: {
      location: {
        home: "New York, NY",
        remote: false,
        hybrid: true,
        onsite: true,
        relocation: [],
      },
    },
  });
  const result = await runAiWebSearch({
    repoRoot,
    env: {},
    runSkillStream: assistantJson({
      roles: [
        role({
          company: "Dante NYC",
          title: "Bartender",
          url: "https://culinaryagents.com/jobs/12345/bartender",
          location: "New York, NY",
          body_text: null,
          body_partial: true,
          source_evidence:
            "The search result names an active bartender opening and cites advancement within the restaurant group.",
        }),
      ],
      queries_run: [{ prompt_id: "p1", query: "ai jobs" }],
    }),
    resolveJobUrlImpl: async (url) => ({
      bodyFetchStatus: "deferred",
      url,
      reason: "The board needs a browser session.",
    }),
  });

  assert.equal(result.new, 1, JSON.stringify(result));
  assert.equal(result.partial, 1);
  assert.equal(result.unreadable, 0);
  assert.deepEqual(result.errors, [], JSON.stringify(result));
  const [saved] = readDbScannerRows({ repoRoot }).filter((row) => row.source === "ai-web-search");
  assert.equal(saved.company, "Dante NYC");
  assert.equal(saved.scanner.bodyPartial, true);
  const capture = readFileSync(userPath({ repoRoot }, saved.artifacts.jd), "utf8");
  assert.match(capture, /Unverified open-web search evidence/i);
  assert.match(capture, /advancement within the restaurant group/i);
  assert.match(capture, /partial: true/);
});

test("runAiWebSearch preserves the twelve-role NYC hospitality open-web parity batch", async () => {
  const repoRoot = repo({ prompts: 1 });
  candidateConfigPatch({
    repoRoot,
    name: "profile",
    patch: {
      location: {
        home: "New York, NY",
        remote: false,
        hybrid: true,
        onsite: true,
        relocation: [],
      },
    },
  });
  const leads = [
    ["Tender (Hard Shake Bar NYC)", "Bartender", "New York, NY"],
    ["OASES", "Lead Bartender", "New York, NY"],
    ["Olly Olly Market", "Lead Bartender — Bar Avant", "New York, NY"],
    ["Soho House & Co", "Bartender — DUMBO House", "Brooklyn, NY"],
    ["Union Square Hospitality Group", "Bartender", "New York, NY"],
    ["Dante NYC", "Bartender", "New York, NY"],
    ["Death & Co (Gin & Luck)", "Bartender", "New York, NY"],
    ["Gin & Luck / Death & Co", "NYC bar team openings", "New York, NY"],
    ["9 Orchard", "Bartender", "New York, NY"],
    ["Buenavista", "Beverage Manager / Beverage Director", "New York, NY"],
    ["Bobo", "Beverage Manager", "New York, NY"],
    ["Teabowl", "Food and Beverage Manager", "New York, NY"],
  ].map(([company, title, location], index) =>
    role({
      company,
      title,
      location,
      url: `https://jobs.example.test/nyc-hospitality-${index + 1}`,
      body_text: null,
      body_partial: true,
      source_evidence: `Open-web result ${index + 1} names this employer and role in New York.`,
    })
  );
  const result = await runAiWebSearch({
    repoRoot,
    env: {},
    runSkillStream: assistantJson({
      roles: leads,
      queries_run: [{ prompt_id: "p1", query: "NYC hospitality jobs" }],
    }),
    resolveJobUrlImpl: async (url) => ({
      bodyFetchStatus: "deferred",
      url,
      reason: "The source needs a browser session.",
    }),
  });

  assert.equal(result.found, 12);
  assert.equal(result.new, 12, JSON.stringify(result));
  assert.equal(result.partial, 12);
  assert.equal(result.unreadable, 0);
  assert.equal(
    readDbScannerRows({ repoRoot }).filter((row) => row.source === "ai-web-search").length,
    12
  );
});

test("runAiWebSearch reports the count visible at the candidate's saved fit floor", async () => {
  const repoRoot = repo({ prompts: 1 });
  candidateConfigPatch({
    repoRoot,
    name: "profile",
    patch: {
      location: {
        home: "New York, NY",
        remote: false,
        hybrid: true,
        onsite: true,
        relocation: [],
      },
    },
  });
  candidateConfigPatch({
    repoRoot,
    name: "targeting",
    patch: { fit_bands: { fit_floor: 65 } },
  });
  const result = await runAiWebSearch({
    repoRoot,
    env: {},
    runSkillStream: assistantJson({
      roles: [
        role({
          company: "Below Floor Hospitality",
          title: "Bar Manager",
          url: "https://jobs.example.test/below-floor-hospitality",
          location: "New York, NY",
          fit_score: 64,
          fit_bucket: "stretch",
        }),
      ],
      queries_run: [{ prompt_id: "p1", query: "NYC hospitality jobs" }],
    }),
    resolveJobUrlImpl: canonicalResolver(),
  });

  assert.equal(result.new, 1, JSON.stringify(result));
  assert.equal(result.presented, 0, JSON.stringify(result));
  assert.equal(result.fitFloor, 65);
});

test("runAiWebSearch rejects a soft-404 page even when the model supplied a summary", async () => {
  const repoRoot = repo({ prompts: 1 });
  const result = await runAiWebSearch({
    repoRoot,
    env: {},
    runSkillStream: assistantJson({
      roles: [
        role({
          url: "https://careers.example.test/jobs/closed-role",
          body_text: "A plausible model summary of a role that is no longer available.",
          body_partial: false,
        }),
      ],
      queries_run: [{ prompt_id: "p1", query: "ai jobs" }],
    }),
    resolveJobUrlImpl: async (url) => ({
      bodyFetchStatus: "resolved",
      url,
      bodyText: fullJd("Page not found. Oops! Error code 404"),
      liveness: { result: "expired", reason: "The posting returned a not-found page." },
    }),
  });

  assert.equal(result.new, 0);
  assert.equal(result.unreadable, 1);
  assert.deepEqual(result.errors, []);
  assert.match(result.captureFailures[0].reason, /not-found/i);
  assert.equal(
    readDbScannerRows({ repoRoot }).filter((row) => row.source === "ai-web-search").length,
    0
  );
});

test("runAiWebSearch dedupes again after canonical URL recovery", async () => {
  const repoRoot = repo({ prompts: 1 });
  const canonicalUrl = "https://job-boards.greenhouse.io/acme/jobs/123456";
  const result = await runAiWebSearch({
    repoRoot,
    env: {},
    runSkillStream: assistantJson({
      roles: [
        role({ company: "Acme", title: "Platform Engineer", url: "https://one.example/jobs/1" }),
        role({
          company: "Acme Labs",
          title: "Software Engineer",
          url: "https://two.example/jobs/2",
        }),
      ],
      queries_run: [{ prompt_id: "p1", query: "ai jobs" }],
    }),
    resolveJobUrlImpl: canonicalResolver({ url: canonicalUrl }),
  });

  assert.equal(result.found, 2);
  assert.equal(result.new, 1);
  assert.equal(result.duplicates, 1);
  const [saved] = readDbScannerRows({ repoRoot }).filter((row) => row.source === "ai-web-search");
  assert.equal(saved.link, canonicalUrl);
});

test("runAiWebSearch aborts honestly during canonical hydration without saving partial rows", async () => {
  const repoRoot = repo({ prompts: 1 });
  const controller = new AbortController();
  let hydrationStarted;
  const started = new Promise((resolve) => {
    hydrationStarted = resolve;
  });
  let releaseHydration;
  const blocked = new Promise((resolve) => {
    releaseHydration = resolve;
  });

  const running = runAiWebSearch({
    repoRoot,
    env: {},
    signal: controller.signal,
    runSkillStream: assistantJson({
      roles: [role()],
      queries_run: [{ prompt_id: "p1", query: "ai jobs" }],
    }),
    resolveJobUrlImpl: async (url) => {
      hydrationStarted();
      await blocked;
      return canonicalResolver()(url);
    },
  });

  await started;
  controller.abort();
  releaseHydration();

  await assert.rejects(running, { code: "AI_WEB_SEARCH_ABORTED" });
  assert.equal(
    readDbScannerRows({ repoRoot }).filter((row) => row.source === "ai-web-search").length,
    0
  );
});

test("runAiWebSearch aborts a blocked provider fetch promptly", async () => {
  const repoRoot = repo({ prompts: 1 });
  const controller = new AbortController();
  let fetchStarted;
  const started = new Promise((resolve) => {
    fetchStarted = resolve;
  });
  let fetchSawAbort = false;

  const running = runAiWebSearch({
    repoRoot,
    env: {},
    signal: controller.signal,
    resolveHost: async () => [{ address: "93.184.216.34", family: 4 }],
    fetchImpl: async (_url, init) => {
      fetchStarted();
      return new Promise((_, reject) => {
        init.signal.addEventListener(
          "abort",
          () => {
            fetchSawAbort = true;
            reject(init.signal.reason || new Error("aborted"));
          },
          { once: true }
        );
      });
    },
    runSkillStream: assistantJson({
      roles: [role()],
      queries_run: [{ prompt_id: "p1", query: "ai jobs" }],
    }),
  });

  await started;
  controller.abort(new Error("client disconnected"));
  const outcome = await Promise.race([
    running.then(
      () => "resolved",
      (error) => error?.code || "rejected"
    ),
    new Promise((resolve) => setTimeout(() => resolve("timed-out"), 500)),
  ]);

  assert.equal(outcome, "AI_WEB_SEARCH_ABORTED");
  assert.equal(fetchSawAbort, true);
  assert.equal(
    readDbScannerRows({ repoRoot }).filter((row) => row.source === "ai-web-search").length,
    0
  );
});

test("runAiWebSearch retries schema-invalid output once and returns the safe error envelope on exhaustion", async () => {
  const repoRoot = repo({ prompts: 1 });
  let calls = 0;
  const retrying = async ({ onEvent }) => {
    calls += 1;
    const text = calls === 1 ? "not json" : '```json\n{"roles":[],"queries_run":[]}\n```';
    onEvent({ type: "assistant", data: { message: { content: [{ type: "text", text }] } } });
  };
  const recovered = await runAiWebSearch({ repoRoot, env: {}, runSkillStream: retrying });
  assert.equal(calls, 2);
  assert.deepEqual(recovered.errors, []);

  const failed = await runAiWebSearch({
    repoRoot,
    env: {},
    runSkillStream: async ({ onEvent }) => {
      onEvent({
        type: "assistant",
        data: { message: { content: [{ type: "text", text: "still invalid" }] } },
      });
    },
  });
  assert.deepEqual(
    {
      searched: failed.searched,
      found: failed.found,
      new: failed.new,
      duplicates: failed.duplicates,
    },
    { searched: 1, found: 0, new: 0, duplicates: 0 }
  );
  assert.equal(failed.errors.length, 1);
  assert.match(failed.errors[0], /schema|usable|match/i);
  assert.deepEqual(failed.failedPromptIds, ["p1"]);
  assert.equal(failed.queryResults.length, 1);
  assert.ok(failed.queryResults.every((item) => item.status === "failed"));
  assert.ok(failed.queryResults.every((item) => item.queries[0].query === item.prompt));
});

test("runAiWebSearch scopes a schema correction retry to the prompt that produced invalid output", async () => {
  const repoRoot = repo({ prompts: 2 });
  const calls = new Map();
  const result = await runAiWebSearch({
    repoRoot,
    env: {},
    runSkillStream: async ({ input, onEvent }) => {
      const kickoff = typeof input === "string" ? JSON.parse(input.split("\n\n", 1)[0]) : input;
      const promptId = kickoff.prompts[0].id;
      const attempt = (calls.get(promptId) || 0) + 1;
      calls.set(promptId, attempt);
      if (promptId === "p1" && attempt === 1) {
        onEvent({
          type: "assistant",
          data: { message: { content: [{ type: "text", text: "not json" }] } },
        });
        return { ok: true };
      }
      onEvent({
        type: "assistant",
        data: {
          message: {
            content: [
              {
                type: "text",
                text: `\`\`\`json\n${JSON.stringify({
                  roles: [],
                  queries_run: [
                    { prompt_id: promptId, query: `query ${promptId}`, status: "completed" },
                  ],
                })}\n\`\`\``,
              },
            ],
          },
        },
      });
      return { ok: true };
    },
  });

  assert.deepEqual(Object.fromEntries(calls), { p1: 2, p2: 1 });
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.failedPromptIds, []);
  assert.deepEqual(
    result.queryResults.map(({ promptId, status }) => ({ promptId, status })),
    [
      { promptId: "p1", status: "completed" },
      { promptId: "p2", status: "completed" },
    ]
  );
});

test("runAiWebSearch reports exact failed saved prompts and successful queries", async () => {
  const repoRoot = repo({ prompts: 2 });
  const result = await runAiWebSearch({
    repoRoot,
    env: {},
    runSkillStream: assistantJson({
      roles: [],
      queries_run: [
        { prompt_id: "p1", query: "first query", status: "completed" },
        { prompt_id: "p2", query: "second query", status: "failed", error: "search timed out" },
      ],
    }),
  });

  assert.deepEqual(result.failedPromptIds, ["p2"]);
  assert.deepEqual(result.queryResults, [
    {
      promptId: "p1",
      prompt: "Find role 1",
      status: "completed",
      queries: [{ query: "first query", status: "completed", error: null }],
    },
    {
      promptId: "p2",
      prompt: "Find role 2",
      status: "failed",
      queries: [{ query: "second query", status: "failed", error: "search timed out" }],
      error: "search timed out",
    },
  ]);
});

test("runAiWebSearch throws only its documented missing-DB and missing-prompt preconditions", async () => {
  await assert.rejects(
    runAiWebSearch({ repoRoot: mkdtempSync(join(tmpdir(), "no-ai-db-")), env: {} }),
    {
      code: "NO_DATABASE",
    }
  );
  const repoRoot = repo({ prompts: 0 });
  await assert.rejects(runAiWebSearch({ repoRoot, env: {} }), { code: "NO_SAVED_PROMPTS" });
});
