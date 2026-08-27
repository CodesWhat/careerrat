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
import { isPostingEvidenceUrl, runAiWebSearch } from "../src/core/search/ai-web-search.mjs";
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
    const usefulSetTopUp =
      typeof input === "string" && input.includes("canonical result set is still underfilled");
    assistantJson.inputs.push(kickoff);
    const promptIds = new Set((kickoff.prompts || []).map((prompt) => prompt.id));
    const allQueries = Array.isArray(data.queries_run) ? data.queries_run : [];
    const queriesRun = allQueries.filter((query) => promptIds.has(query.prompt_id));
    const scoped = {
      ...data,
      roles: usefulSetTopUp ? [] : !allQueries.length || queriesRun.length ? data.roles : [],
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

function emitAssistantJson(onEvent, data) {
  onEvent({
    type: "assistant",
    data: {
      message: {
        content: [{ type: "text", text: `\`\`\`json\n${JSON.stringify(data)}\n\`\`\`` }],
      },
    },
  });
}

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
  assert.equal(calls[0].useExecutionPlanRoute, true);
});

test("runAiWebSearch rejects aggregator result pages and expired redirects before hydration", async () => {
  const repoRoot = repo({ prompts: 1 });
  const directUrl = "https://www.linkedin.com/jobs/view/assistant-general-manager-5186736008";
  const resolvedUrls = [];
  const result = await runAiWebSearch({
    repoRoot,
    env: {},
    runSkillStream: assistantJson({
      roles: [
        role({
          company: "Gracious Hospitality",
          title: "Assistant General Manager",
          url: directUrl,
        }),
        role({
          company: "Manhattan Mixology",
          title: "Head Bartender",
          url: "https://www.linkedin.com/jobs/lead-bartender-jobs?trk=expired_jd_redirect",
        }),
        role({
          company: "Compass Group",
          title: "Head Bartender",
          url: "https://www.ziprecruiter.com/Jobs/Head-Bartender/--in-New-York",
        }),
      ],
      queries_run: [{ prompt_id: "p1", query: "NYC hospitality management jobs" }],
    }),
    resolveJobUrlImpl: async (url) => {
      resolvedUrls.push(url);
      return canonicalResolver()(url);
    },
  });

  assert.equal(result.found, 3);
  assert.equal(result.invalid, 2);
  assert.equal(result.new, 1);
  assert.deepEqual(resolvedUrls, [directUrl]);
});

test("runAiWebSearch rejects generic employer career hubs before their page copy can impersonate a posting", async () => {
  const repoRoot = repo({ prompts: 1 });
  const resolvedUrls = [];
  const genericCareersUrl = "https://careers.example.test/careers/";
  const result = await runAiWebSearch({
    repoRoot,
    env: {},
    runSkillStream: assistantJson({
      roles: [
        role({
          company: "Example Hospitality",
          title: "General Manager (New City location)",
          url: genericCareersUrl,
          body_text:
            "General Manager is one option in this employer's multi-role application form.",
        }),
      ],
      queries_run: [{ prompt_id: "p1", query: "hospitality management jobs" }],
    }),
    resolveJobUrlImpl: async (url) => {
      resolvedUrls.push(url);
      return canonicalResolver({
        bodyText: fullJd(
          "Join our team. Select from General Manager, Barista, Shift Lead, and Team Member, then submit the shared application form"
        ),
      })(url);
    },
  });

  assert.equal(result.found, 1);
  assert.deepEqual(
    { invalid: result.invalid, persisted: result.new, resolvedUrls },
    { invalid: 1, persisted: 0, resolvedUrls: [] }
  );
  assert.equal(
    readDbScannerRows({ repoRoot }).filter((row) => row.source === "ai-web-search").length,
    0
  );
});

test("AI web search distinguishes posting details from known aggregator result pages", () => {
  for (const url of [
    "https://www.linkedin.com/jobs/view/assistant-general-manager-5186736008",
    "https://www.indeed.com/viewjob?jk=abc123",
    "https://www.glassdoor.com/job-listing/bar-manager-acme-JV_IC1132348_KO0,11_KE12,16.htm?jl=123",
    "https://wellfound.com/jobs/123456-platform-engineer",
    "https://www.ziprecruiter.com/c/Acme/Job/Bar-Manager/-in-New-York,NY?jid=abc123",
    "https://careers.aquarestaurantgroup.com/new-york",
    "https://careers.example.test/careers/general-manager-new-york",
    "https://careers.example.test/careers?gh_jid=123456",
  ]) {
    assert.equal(isPostingEvidenceUrl(url), true, url);
  }

  for (const url of [
    "https://www.linkedin.com/jobs/search/?keywords=bar%20manager",
    "https://www.linkedin.com/jobs/lead-bartender-jobs?trk=expired_jd_redirect",
    "https://www.ziprecruiter.com/Jobs/Head-Bartender/--in-New-York",
    "https://www.indeed.com/jobs?q=bar+manager&l=New+York",
    "https://www.indeed.com/q-head-bartender-l-new-york-ny-jobs.html",
    "https://www.glassdoor.com/Job/new-york-bar-manager-jobs-SRCH_IL.0,8_IC1132348.htm",
    "https://wellfound.com/jobs",
    "https://careers.example.test/",
    "https://careers.example.test/careers/",
    "https://example.test/careers/apply/",
    "https://example.test/careers/application/",
    "https://example.test/jobs/openings/",
    "https://example.test/jobs/open-positions/",
  ]) {
    assert.equal(isPostingEvidenceUrl(url), false, url);
  }
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

test("runAiWebSearch explains a selected-provider usage cap without exposing runtime text", async () => {
  const repoRoot = repo({ prompts: 1 });
  const result = await runAiWebSearch({
    repoRoot,
    env: {},
    runSkillStream: async () => ({
      ok: false,
      code: "RUNTIME_USAGE_LIMIT",
      error:
        "Claude Code has reached its usage limit. It resets at 4pm (America/New_York). " +
        "raw CLI schema secret",
    }),
  });

  assert.deepEqual(result.errors, [
    "The selected AI provider has reached its usage limit. It resets at 4pm (America/New_York). Try again after the reset.",
  ]);
  assert.deepEqual(result.failedPromptIds, ["p1"]);
  assert.doesNotMatch(result.errors[0], /Claude|CLI|schema|secret|RUNTIME_/i);
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
  assert.match(skill, /never emit an aggregator search\/results page/i);
  assert.match(skill, /employer-owned career|employer career/i);
  assert.match(skill, /at least two (?:different )?(?:source )?hosts/i);
  assert.match(skill, /no more than one candidate from the same third-party host/i);
  assert.match(skill, /do not stop after (?:the )?first (?:viable )?(?:lead|match)/i);
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
    Array.from({ length: 4 }, () => [
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
    ]).flat()
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
    "Searching for additional roles for saved prompt 1 of 1…",
    "Finished saved prompt 1 of 1.",
    "Searching for additional roles for saved prompt 1 of 1…",
    "Finished saved prompt 1 of 1.",
    "Searching for additional roles for saved prompt 1 of 1…",
    "Finished saved prompt 1 of 1.",
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
  assert.deepEqual(
    {
      ...result.offers[0],
      fitScore: Number.isFinite(result.offers[0].fitScore),
      qualificationUnknowns: [...result.offers[0].qualificationUnknowns].sort(),
    },
    {
      company: "Dante NYC",
      title: "Bartender",
      url: "https://culinaryagents.com/jobs/12345/bartender",
      fitScore: true,
      qualificationUnknowns: ["compensation", "postedAt"],
      unverified: true,
    }
  );
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

test("runAiWebSearch rejects a model title that resolves to a different canonical requisition", async () => {
  const repoRoot = repo({ prompts: 1 });
  candidateConfigPatch({
    repoRoot,
    name: "profile",
    patch: {
      location: {
        home: "New York, NY",
        remote: true,
        remote_scope: "home-country",
        hybrid: true,
        onsite: true,
        relocation: [],
      },
    },
  });
  candidateConfigPatch({
    repoRoot,
    name: "targeting",
    patch: {
      role_buckets: [
        {
          name: "Event and venue operations",
          titles: ["Event Operations Manager", "Event Coordinator", "Venue Operations Manager"],
        },
      ],
      fit_bands: { fit_floor: 65 },
    },
  });
  const garnerUrl = "https://job-boards.greenhouse.io/garnerhealth/jobs/5982721004";
  let calls = 0;
  const result = await runAiWebSearch({
    repoRoot,
    env: {},
    runSkillStream: async ({ input, onEvent }) => {
      calls += 1;
      emitAssistantJson(onEvent, {
        roles:
          typeof input === "string"
            ? []
            : [
                role({
                  company: "Garner Health",
                  title: "Event Operations Senior Associate",
                  url: garnerUrl,
                  location: "New York City, New York",
                }),
              ],
        queries_run: [{ prompt_id: "p1", query: `query ${calls}`, status: "completed" }],
      });
      return { ok: true };
    },
    resolveJobUrlImpl: async (url) => ({
      bodyFetchStatus: "resolved",
      url,
      provider: "greenhouse",
      company: "Garnerhealth",
      title: "Senior IT Systems Engineer",
      location: "New York City, New York",
      comp: "$189,000 - $220,000 base salary",
      bodyText: fullJd("Canonical Senior IT Systems Engineer posting"),
      liveness: { result: "active", reason: "visible apply control" },
    }),
  });

  assert.equal(calls, 6, "canonical identity rejection plus useful-set top-ups stay bounded");
  assert.equal(result.new, 0, JSON.stringify(result));
  assert.equal(result.presented, 0, JSON.stringify(result));
  assert.deepEqual(result.reasonCounts, { seniority: 1 });
  assert.equal(
    readDbScannerRows({ repoRoot }).filter((row) => row.source === "ai-web-search").length,
    0
  );
});

test("runAiWebSearch persists a legitimate provider-normalized target title", async () => {
  const repoRoot = repo({ prompts: 1 });
  candidateConfigPatch({
    repoRoot,
    name: "profile",
    patch: {
      location: {
        home: "New York, NY",
        remote: true,
        remote_scope: "home-country",
        hybrid: true,
        onsite: true,
        relocation: [],
      },
    },
  });
  candidateConfigPatch({
    repoRoot,
    name: "targeting",
    patch: {
      role_buckets: [{ name: "Hospitality", titles: ["Assistant General Manager"] }],
      fit_bands: { fit_floor: 65 },
    },
  });
  const url = "https://job-boards.greenhouse.io/hospitality/jobs/123456";
  const result = await runAiWebSearch({
    repoRoot,
    env: {},
    runSkillStream: assistantJson({
      roles: [
        role({
          company: "Hospitality Group",
          title: "Asst. General Manager",
          url,
          location: "New York, NY",
        }),
      ],
      queries_run: [{ prompt_id: "p1", query: "NYC assistant general manager" }],
    }),
    resolveJobUrlImpl: async () => ({
      bodyFetchStatus: "resolved",
      url,
      provider: "greenhouse",
      company: "Hospitality Group",
      title: "Assistant General Manager",
      location: "New York, NY",
      bodyText: fullJd("Canonical Assistant General Manager posting"),
      liveness: { result: "active", reason: "visible apply control" },
    }),
  });

  assert.equal(result.new, 1, JSON.stringify(result));
  assert.equal(result.presented, 1, JSON.stringify(result));
  const [saved] = readDbScannerRows({ repoRoot }).filter((row) => row.source === "ai-web-search");
  assert.equal(saved.company, "Hospitality Group");
  assert.equal(saved.role, "Assistant General Manager");
});

test("runAiWebSearch replaces a prompt batch erased by canonical liveness once", async () => {
  const repoRoot = repo({ prompts: 1 });
  candidateConfigPatch({
    repoRoot,
    name: "targeting",
    patch: {
      role_buckets: [{ name: "Platform", titles: ["Platform Engineer"] }],
      fit_bands: { fit_floor: 65 },
    },
  });
  const expiredUrl = "https://jobs.example.test/expired-role";
  const activeUrl = "https://jobs.example.test/active-role";
  const inputs = [];
  const plans = [];
  const executionPlan = Object.freeze({
    operation: "research.web",
    runtimeId: "claude",
    resolved: Object.freeze({ model: "claude-sonnet-4-6", effort: "medium" }),
  });
  const result = await runAiWebSearch({
    repoRoot,
    env: {},
    executionPlan,
    runSkillStream: async ({ input, onEvent, executionPlan: receivedPlan }) => {
      inputs.push(input);
      plans.push(receivedPlan);
      const recovery = typeof input === "string";
      emitAssistantJson(onEvent, {
        roles: [
          role(
            recovery
              ? { company: "Active Co", title: "Platform Engineer", url: activeUrl }
              : { company: "Expired Co", title: "Platform Engineer", url: expiredUrl }
          ),
        ],
        queries_run: [
          {
            prompt_id: "p1",
            query: recovery ? "active replacement query" : "initial query",
            status: "completed",
          },
        ],
      });
      return { ok: true };
    },
    resolveJobUrlImpl: async (url) =>
      url === expiredUrl
        ? {
            bodyFetchStatus: "resolved",
            url,
            bodyText: fullJd("This posting is no longer available"),
            liveness: {
              result: "expired",
              reason: "The posting is no longer available.",
            },
          }
        : canonicalResolver({
            bodyText: fullJd("Active direct posting"),
            liveness: { result: "active", reason: "visible apply control" },
          })(url),
  });

  assert.equal(inputs.length, 5);
  assert.equal(typeof inputs[0], "object");
  assert.ok(inputs.slice(1).every((input) => typeof input === "string"));
  assert.deepEqual(plans, Array(5).fill(executionPlan));
  assert.match(inputs[1], /replacement|recover|fresh/i);
  assert.match(inputs[1], /expired-role/);
  assert.match(inputs[1], /no longer available/i);
  assert.equal(result.new, 1, JSON.stringify(result));
  assert.equal(result.presented, 1, JSON.stringify(result));
  assert.deepEqual(
    readDbScannerRows({ repoRoot })
      .filter((row) => row.source === "ai-web-search")
      .map((row) => row.link),
    [activeUrl]
  );
});

test("runAiWebSearch never rehydrates a rejected URL repeated by recovery", async () => {
  const repoRoot = repo({ prompts: 1 });
  const expiredUrl = "https://jobs.example.test/repeated-expired-role";
  const activeUrl = "https://jobs.example.test/different-active-role";
  let calls = 0;
  const hydrationCounts = new Map();
  const result = await runAiWebSearch({
    repoRoot,
    env: {},
    runSkillStream: async ({ input, onEvent }) => {
      calls += 1;
      const recovery = typeof input === "string";
      emitAssistantJson(onEvent, {
        roles: recovery
          ? [
              role({ company: "Expired Co", url: expiredUrl }),
              role({ company: "Replacement Co", url: activeUrl }),
            ]
          : [role({ company: "Expired Co", url: expiredUrl })],
        queries_run: [{ prompt_id: "p1", query: `query ${calls}`, status: "completed" }],
      });
      return { ok: true };
    },
    resolveJobUrlImpl: async (url) => {
      hydrationCounts.set(url, (hydrationCounts.get(url) || 0) + 1);
      if (url === expiredUrl) {
        return {
          bodyFetchStatus: "resolved",
          url,
          bodyText: fullJd("This role has expired"),
          liveness: { result: "expired", reason: "This role has expired." },
        };
      }
      return canonicalResolver({ bodyText: fullJd("Active replacement") })(url);
    },
  });

  assert.equal(calls, 5);
  assert.equal(hydrationCounts.get(expiredUrl), 1);
  assert.equal(hydrationCounts.get(activeUrl), 1);
  assert.equal(result.new, 1, JSON.stringify(result));
  assert.deepEqual(
    readDbScannerRows({ repoRoot })
      .filter((row) => row.source === "ai-web-search")
      .map((row) => row.link),
    [activeUrl]
  );
});

test("runAiWebSearch sends recovery candidates through the existing hard gates", async () => {
  const repoRoot = repo({ prompts: 1 });
  candidateConfigPatch({
    repoRoot,
    name: "profile",
    patch: {
      compensation: { minimum_base: 85000 },
      location: {
        home: "New York, NY",
        remote: true,
        remote_scope: "home-country",
        hybrid: true,
        onsite: true,
        relocation: [],
      },
    },
  });
  candidateConfigPatch({
    repoRoot,
    name: "targeting",
    patch: {
      role_buckets: [{ name: "Hospitality", titles: ["Bar Manager"] }],
      fit_bands: { fit_floor: 95 },
    },
  });
  const expiredUrl = "https://jobs.example.test/initial-expired";
  const outsideUrl = "https://jobs.example.test/outside-nyc";
  const belowFloorUrl = "https://jobs.example.test/below-floor";
  const lowFitUrl = "https://jobs.example.test/low-fit";
  let calls = 0;
  const hydrated = [];
  const result = await runAiWebSearch({
    repoRoot,
    env: {},
    runSkillStream: async ({ input, onEvent }) => {
      calls += 1;
      const recovery = typeof input === "string";
      const topUp = recovery && input.includes("canonical result set is still underfilled");
      emitAssistantJson(onEvent, {
        roles: topUp
          ? []
          : recovery
            ? [
                role({
                  company: "Search Page Co",
                  title: "Bar Manager",
                  url: "https://www.indeed.com/jobs?q=bar+manager&l=New+York",
                  location: "New York, NY",
                }),
                role({
                  company: "Expired Redirect Co",
                  title: "Bar Manager",
                  url: "https://www.linkedin.com/jobs/view/123?trk=expired_jd_redirect",
                  location: "New York, NY",
                }),
                role({
                  company: "Outside Co",
                  title: "Bar Manager",
                  url: outsideUrl,
                  location: "San Francisco, CA",
                }),
                role({
                  company: "Below Floor Co",
                  title: "Bar Manager",
                  url: belowFloorUrl,
                  location: "New York, NY",
                }),
                role({
                  company: "Low Fit Co",
                  title: "Bar Manager",
                  url: lowFitUrl,
                  location: "New York, NY",
                  fit_score: 64,
                  fit_bucket: "stretch",
                }),
              ]
            : [role({ company: "Expired Co", title: "Bar Manager", url: expiredUrl })],
        queries_run: [{ prompt_id: "p1", query: `query ${calls}`, status: "completed" }],
      });
      return { ok: true };
    },
    resolveJobUrlImpl: async (url) => {
      hydrated.push(url);
      if (url === expiredUrl) {
        return {
          bodyFetchStatus: "resolved",
          url,
          bodyText: fullJd("Expired posting"),
          liveness: { result: "expired", reason: "Expired posting." },
        };
      }
      if (url === outsideUrl) {
        return {
          bodyFetchStatus: "resolved",
          url,
          location: "San Francisco, CA",
          bodyText: fullJd("This is an in-person San Francisco role"),
        };
      }
      if (url === belowFloorUrl) {
        return {
          bodyFetchStatus: "resolved",
          url,
          location: "New York, NY",
          bodyText: fullJd("Base salary: $75,000 - $85,000 per year"),
        };
      }
      return {
        bodyFetchStatus: "resolved",
        url,
        location: "New York, NY",
        bodyText: fullJd("Compensation to be confirmed"),
      };
    },
  });

  assert.equal(calls, 5);
  assert.deepEqual(hydrated.sort(), [belowFloorUrl, expiredUrl, lowFitUrl, outsideUrl].sort());
  assert.equal(result.invalid, 2);
  assert.deepEqual(result.reasonCounts, { location: 1, salary: 1 });
  assert.equal(result.new, 1, JSON.stringify(result));
  assert.equal(result.presented, 0, JSON.stringify(result));
  const [saved] = readDbScannerRows({ repoRoot }).filter((row) => row.source === "ai-web-search");
  assert.equal(saved.link, lowFitUrl);
  assert.ok(saved.fitScore < 95);
});

test("runAiWebSearch continues canonical freshness recovery until a second turn succeeds", async () => {
  const repoRoot = repo({ prompts: 1 });
  candidateConfigPatch({
    repoRoot,
    name: "targeting",
    patch: {
      role_buckets: [{ name: "Applied AI", titles: ["Applied AI Engineer"] }],
      fit_bands: { fit_floor: 65 },
    },
  });
  const executionPlan = Object.freeze({
    operation: "research.web",
    runtimeId: "claude",
    resolved: Object.freeze({ model: "claude-sonnet-4-6", effort: "medium" }),
  });
  const inputs = [];
  const plans = [];
  const hydrated = [];
  const result = await runAiWebSearch({
    repoRoot,
    env: {},
    executionPlan,
    runSkillStream: async ({ input, onEvent, executionPlan: receivedPlan }) => {
      inputs.push(input);
      plans.push(receivedPlan);
      const call = inputs.length;
      const url =
        call === 1
          ? "https://stale-board.example/jobs/expired-initial"
          : call === 2
            ? "https://stale-board.example/jobs/expired-recovery"
            : "https://employer.example/careers/active-replacement";
      emitAssistantJson(onEvent, {
        roles: [role({ company: `Company ${call}`, url })],
        queries_run: [{ prompt_id: "p1", query: `query ${call}`, status: "completed" }],
      });
      return { ok: true };
    },
    resolveJobUrlImpl: async (url) => {
      hydrated.push(url);
      if (url.includes("expired")) {
        return {
          bodyFetchStatus: "resolved",
          url,
          bodyText: fullJd("Expired posting"),
          liveness: { result: "expired", reason: `Expired ${url}` },
        };
      }
      return canonicalResolver({
        bodyText: fullJd("Active employer posting"),
        liveness: { result: "active", reason: "visible apply control" },
      })(url);
    },
  });

  assert.equal(inputs.length, 6);
  assert.ok(inputs.slice(1).every((input) => typeof input === "string"));
  assert.deepEqual(plans, Array(6).fill(executionPlan));
  assert.match(inputs[2], /expired-initial/);
  assert.match(inputs[2], /expired-recovery/);
  assert.match(inputs[2], /stale-board\.example/);
  assert.match(inputs[2], /employer-owned|employer career|direct employer/i);
  assert.deepEqual(hydrated, [
    "https://stale-board.example/jobs/expired-initial",
    "https://stale-board.example/jobs/expired-recovery",
    "https://employer.example/careers/active-replacement",
  ]);
  assert.equal(result.new, 1, JSON.stringify(result));
  assert.equal(result.presented, 1, JSON.stringify(result));
});

test("runAiWebSearch continues recovery when canonical hard gates erase the first replacement", async () => {
  const repoRoot = repo({ prompts: 1 });
  candidateConfigPatch({
    repoRoot,
    name: "profile",
    patch: {
      compensation: { minimum_base: 85000 },
      location: {
        home: "New York, NY",
        remote: true,
        remote_scope: "home-country",
        hybrid: true,
        onsite: true,
        relocation: [],
      },
    },
  });
  candidateConfigPatch({
    repoRoot,
    name: "targeting",
    patch: {
      role_buckets: [{ name: "Bar leadership", titles: ["Bar Manager"] }],
      fit_bands: { fit_floor: 65 },
    },
  });
  const inputs = [];
  const result = await runAiWebSearch({
    repoRoot,
    env: {},
    runSkillStream: async ({ input, onEvent }) => {
      inputs.push(input);
      const call = inputs.length;
      const url =
        call === 1
          ? "https://stale.example/jobs/expired"
          : call === 2
            ? "https://employer-one.example/jobs/below-floor"
            : "https://employer-two.example/jobs/qualified";
      emitAssistantJson(onEvent, {
        roles: [
          role({
            company: `Hospitality ${call}`,
            title: "Bar Manager",
            location: "New York, NY",
            url,
          }),
        ],
        queries_run: [{ prompt_id: "p1", query: `query ${call}`, status: "completed" }],
      });
      return { ok: true };
    },
    resolveJobUrlImpl: async (url) => ({
      bodyFetchStatus: "resolved",
      url,
      title: "Bar Manager",
      location: "New York, NY",
      bodyText: url.includes("expired")
        ? fullJd("Expired posting")
        : url.includes("below-floor")
          ? fullJd("Base salary: $75,000 - $95,000 per year")
          : fullJd("Base salary: $90,000 - $100,000 per year"),
      liveness: url.includes("expired")
        ? { result: "expired", reason: "Expired posting." }
        : { result: "active", reason: "visible apply control" },
    }),
  });

  assert.equal(inputs.length, 6);
  assert.match(inputs[2], /below-floor/);
  assert.match(inputs[2], /salary|compensation|hard filter/i);
  assert.equal(result.presented, 1, JSON.stringify(result));
  assert.deepEqual(result.reasonCounts, { salary: 1 });
});

test("runAiWebSearch caps canonical freshness recovery at two turns", async () => {
  const repoRoot = repo({ prompts: 1 });
  let calls = 0;
  const result = await runAiWebSearch({
    repoRoot,
    env: {},
    runSkillStream: async ({ onEvent }) => {
      calls += 1;
      const url = `https://jobs.example.test/expired-${calls}`;
      emitAssistantJson(onEvent, {
        roles: [role({ company: `Expired ${calls}`, url })],
        queries_run: [{ prompt_id: "p1", query: `query ${calls}`, status: "completed" }],
      });
      return { ok: true };
    },
    resolveJobUrlImpl: async (url) => ({
      bodyFetchStatus: "resolved",
      url,
      bodyText: fullJd("Expired posting"),
      liveness: { result: "expired", reason: "Expired posting." },
    }),
  });

  assert.equal(calls, 6);
  assert.equal(result.new, 0);
  assert.equal(result.presented, 0);
  assert.equal(result.unreadable, 6);
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.failedPromptIds, []);
});

test("runAiWebSearch retries only a canonically erased sibling and keeps dedupe global", async () => {
  const repoRoot = repo({ prompts: 2 });
  const activeUrl = "https://jobs.example.test/already-active";
  const expiredUrl = "https://jobs.example.test/sibling-expired";
  const replacementUrl = "https://jobs.example.test/sibling-replacement";
  const calls = new Map();
  const result = await runAiWebSearch({
    repoRoot,
    env: {},
    runSkillStream: async ({ input, onEvent }) => {
      const kickoff = typeof input === "string" ? JSON.parse(input.split("\n\n", 1)[0]) : input;
      const promptId = kickoff.prompts[0].id;
      const attempt = (calls.get(promptId) || 0) + 1;
      calls.set(promptId, attempt);
      const roles =
        promptId === "p1"
          ? [role({ company: "Active Sibling", url: activeUrl })]
          : attempt === 1
            ? [role({ company: "Expired Sibling", url: expiredUrl })]
            : [
                role({ company: "Duplicate Sibling", url: activeUrl }),
                role({ company: "Replacement Sibling", url: replacementUrl }),
              ];
      emitAssistantJson(onEvent, {
        roles,
        queries_run: [
          { prompt_id: promptId, query: `${promptId} query ${attempt}`, status: "completed" },
        ],
      });
      return { ok: true };
    },
    resolveJobUrlImpl: async (url) =>
      url === expiredUrl
        ? {
            bodyFetchStatus: "resolved",
            url,
            bodyText: fullJd("Expired sibling"),
            liveness: { result: "expired", reason: "Expired sibling." },
          }
        : canonicalResolver()(url),
  });

  assert.deepEqual(Object.fromEntries(calls), { p1: 3, p2: 3 });
  assert.equal(result.new, 2, JSON.stringify(result));
  assert.ok(result.duplicates >= 1, JSON.stringify(result));
  assert.deepEqual(
    readDbScannerRows({ repoRoot })
      .filter((row) => row.source === "ai-web-search")
      .map((row) => row.link)
      .sort(),
    [activeUrl, replacementUrl].sort()
  );
});

test("runAiWebSearch tops up valid one- and two-prompt runs", async () => {
  for (const promptCount of [1, 2]) {
    const repoRoot = repo({ prompts: promptCount });
    candidateConfigPatch({
      repoRoot,
      name: "profile",
      patch: {
        location: {
          home: "New York, NY",
          remote: true,
          remote_scope: "home-country",
          hybrid: true,
          onsite: true,
          relocation: [],
        },
      },
    });
    candidateConfigPatch({
      repoRoot,
      name: "targeting",
      patch: {
        role_buckets: [
          {
            name: "Hospitality operations",
            titles: ["Bar Manager", "Assistant General Manager", "General Manager"],
          },
        ],
        fit_bands: { fit_floor: 65 },
      },
    });
    const calls = new Map();
    const result = await runAiWebSearch({
      repoRoot,
      env: {},
      runSkillStream: async ({ input, onEvent }) => {
        const kickoff = typeof input === "string" ? JSON.parse(input.split("\n\n", 1)[0]) : input;
        const promptId = kickoff.prompts[0].id;
        const attempt = (calls.get(promptId) || 0) + 1;
        calls.set(promptId, attempt);
        const initialIndex = Number(promptId.slice(1));
        const roles =
          attempt === 1
            ? [
                role({
                  company: `Initial ${initialIndex}`,
                  title: initialIndex === 1 ? "Bar Manager" : "Assistant General Manager",
                  location: "New York, NY",
                  url: `https://initial-${initialIndex}.example/jobs/role`,
                }),
              ]
            : Array.from({ length: 3 - promptCount }, (_, index) =>
                role({
                  company: `Top Up ${index + 1}`,
                  title: index === 0 ? "General Manager" : "Assistant General Manager",
                  location: "New York, NY",
                  url: `https://top-up-${promptCount}-${index + 1}.example/jobs/role`,
                })
              );
        emitAssistantJson(onEvent, {
          roles,
          queries_run: [
            { prompt_id: promptId, query: `${promptId} query ${attempt}`, status: "completed" },
          ],
        });
        return { ok: true };
      },
      resolveJobUrlImpl: canonicalResolver({
        location: "New York, NY",
        liveness: { result: "active", reason: "visible apply control" },
      }),
    });

    assert.equal(
      [...calls.values()].reduce((sum, count) => sum + count, 0),
      promptCount + 1
    );
    assert.equal(result.new, 3, JSON.stringify(result));
    assert.equal(result.presented, 3, JSON.stringify(result));
  }
});

test("runAiWebSearch gives a selected single prompt multiple bounded chances to reach three roles", async () => {
  const repoRoot = repo({ prompts: 3 });
  candidateConfigPatch({
    repoRoot,
    name: "targeting",
    patch: { fit_bands: { fit_floor: 0 } },
  });
  let calls = 0;
  const result = await runAiWebSearch({
    repoRoot,
    env: {},
    promptIds: ["p1"],
    runSkillStream: async ({ input, onEvent }) => {
      calls += 1;
      const kickoff = typeof input === "string" ? JSON.parse(input.split("\n\n", 1)[0]) : input;
      const roles =
        calls === 1
          ? [
              role({
                company: "Initial Company",
                url: "https://initial.example/jobs/role",
              }),
            ]
          : calls === 3
            ? [
                role({
                  company: "Second Company",
                  url: "https://second.example/jobs/role",
                }),
                role({
                  company: "Third Company",
                  url: "https://third.example/jobs/role",
                }),
              ]
            : [];
      emitAssistantJson(onEvent, {
        roles,
        queries_run: [
          { prompt_id: kickoff.prompts[0].id, query: `query ${calls}`, status: "completed" },
        ],
      });
      return { ok: true };
    },
    resolveJobUrlImpl: canonicalResolver(),
  });

  assert.equal(calls, 3, JSON.stringify(result));
  assert.equal(result.searched, 1);
  assert.equal(result.new, 3, JSON.stringify(result));
  assert.equal(result.presented, 3, JSON.stringify(result));
});

test("runAiWebSearch exhausts the fixed useful-set cap for one selected prompt", async () => {
  const repoRoot = repo({ prompts: 3 });
  const inputs = [];
  const result = await runAiWebSearch({
    repoRoot,
    env: {},
    promptIds: ["p1"],
    runSkillStream: async ({ input, onEvent }) => {
      inputs.push(input);
      const kickoff = typeof input === "string" ? JSON.parse(input.split("\n\n", 1)[0]) : input;
      emitAssistantJson(onEvent, {
        roles: [],
        queries_run: [
          {
            prompt_id: kickoff.prompts[0].id,
            query: `query ${inputs.length}`,
            status: "completed",
          },
        ],
      });
      return { ok: true };
    },
  });

  assert.equal(inputs.length, 4);
  assert.ok(inputs.slice(1).every((input) => typeof input === "string"));
  assert.equal(result.searched, 1);
  assert.equal(result.new, 0);
  assert.equal(result.presented, 0);
});

test("runAiWebSearch counts three canonical same-title postings as a useful set", async () => {
  const repoRoot = repo({ prompts: 3 });
  candidateConfigPatch({
    repoRoot,
    name: "profile",
    patch: {
      location: {
        home: "New York, NY",
        remote: true,
        remote_scope: "home-country",
        hybrid: true,
        onsite: true,
        relocation: [],
      },
    },
  });
  candidateConfigPatch({
    repoRoot,
    name: "targeting",
    patch: {
      role_buckets: [{ name: "Bar leadership", titles: ["Bar Manager"] }],
      fit_bands: { fit_floor: 65 },
    },
  });
  let calls = 0;
  const result = await runAiWebSearch({
    repoRoot,
    env: {},
    runSkillStream: async ({ input, onEvent }) => {
      calls += 1;
      const kickoff = typeof input === "string" ? JSON.parse(input.split("\n\n", 1)[0]) : input;
      const promptId = kickoff.prompts[0].id;
      emitAssistantJson(onEvent, {
        roles: [
          role({
            company: `Bar Group ${promptId}`,
            title: "Bar Manager",
            location: "New York, NY",
            url: `https://bar-${promptId}.example/jobs/manager`,
          }),
        ],
        queries_run: [{ prompt_id: promptId, query: `${promptId} query`, status: "completed" }],
      });
      return { ok: true };
    },
    resolveJobUrlImpl: canonicalResolver({
      location: "New York, NY",
      liveness: { result: "active", reason: "visible apply control" },
    }),
  });

  assert.equal(calls, 3);
  assert.equal(result.new, 3, JSON.stringify(result));
  assert.equal(result.presented, 3, JSON.stringify(result));
});

test("runAiWebSearch scopes bucket coverage to the selected prompt subset", async () => {
  const repoRoot = repo({ prompts: 3 });
  candidateConfigPatch({
    repoRoot,
    name: "profile",
    patch: {
      location: {
        home: "New York, NY",
        remote: true,
        remote_scope: "home-country",
        hybrid: true,
        onsite: true,
        relocation: [],
      },
    },
  });
  candidateConfigPatch({
    repoRoot,
    name: "targeting",
    patch: {
      role_buckets: [
        { name: "Bar leadership", titles: ["Bar Manager"] },
        { name: "Hospitality operations", titles: ["Assistant General Manager"] },
        { name: "Event operations", titles: ["Event Operations Manager"] },
      ],
      fit_bands: { fit_floor: 65 },
    },
  });
  saveSearchPrompts({
    repoRoot,
    prompts: [
      { id: "p1", text: "Find active Bar Manager jobs in New York City" },
      { id: "p2", text: "Find active Assistant General Manager jobs in New York City" },
      { id: "p3", text: "Find active Event Operations Manager jobs in New York City" },
    ],
  });
  let calls = 0;
  const result = await runAiWebSearch({
    repoRoot,
    env: {},
    promptIds: ["p1"],
    runSkillStream: async ({ input, onEvent }) => {
      calls += 1;
      const kickoff = typeof input === "string" ? JSON.parse(input.split("\n\n", 1)[0]) : input;
      const promptId = kickoff.prompts[0].id;
      emitAssistantJson(onEvent, {
        roles: [1, 2, 3].map((index) =>
          role({
            company: `Bar Group ${index}`,
            title: "Bar Manager",
            location: "New York, NY",
            url: `https://selected-${index}.example/jobs/bar-manager`,
          })
        ),
        queries_run: [{ prompt_id: promptId, query: `${promptId} query`, status: "completed" }],
      });
      return { ok: true };
    },
    resolveJobUrlImpl: canonicalResolver({
      location: "New York, NY",
      liveness: { result: "active", reason: "visible apply control" },
    }),
  });

  assert.equal(calls, 1);
  assert.equal(result.new, 3, JSON.stringify(result));
  assert.equal(result.presented, 3, JSON.stringify(result));
});

test("runAiWebSearch tops up an underfilled three-prompt useful set once on the frozen provider", async () => {
  const repoRoot = repo({ prompts: 3 });
  candidateConfigPatch({
    repoRoot,
    name: "profile",
    patch: {
      compensation: { minimum_base: 85000 },
      location: {
        home: "New York, NY",
        remote: true,
        remote_scope: "home-country",
        hybrid: true,
        onsite: true,
        relocation: [],
      },
    },
  });
  candidateConfigPatch({
    repoRoot,
    name: "targeting",
    patch: {
      role_buckets: [
        { name: "Bar leadership", titles: ["Bar Manager", "Head Bartender"] },
        { name: "Hospitality operations", titles: ["Assistant General Manager"] },
      ],
      fit_bands: { fit_floor: 65 },
    },
  });
  saveSearchPrompts({
    repoRoot,
    prompts: [
      { id: "p1", text: "Find active Bar Manager and Head Bartender jobs in New York City" },
      { id: "p2", text: "Find active Assistant General Manager jobs in New York City" },
      { id: "p3", text: "Find active Event Operations jobs in New York City" },
    ],
  });
  const executionPlan = Object.freeze({
    operation: "research.web",
    runtimeId: "codex",
    resolved: Object.freeze({ model: "gpt-5.6-terra", effort: "medium" }),
  });
  const calls = new Map();
  const receivedPlans = [];
  const inputs = [];
  const firstUrl = "https://employer-one.example/jobs/bar-manager";
  const secondUrl = "https://employer-two.example/jobs/assistant-general-manager";
  const topUpUrl = "https://employer-three.example/jobs/head-bartender";
  const result = await runAiWebSearch({
    repoRoot,
    env: {},
    executionPlan,
    runSkillStream: async ({ input, onEvent, executionPlan: receivedPlan }) => {
      inputs.push(input);
      receivedPlans.push(receivedPlan);
      const kickoff = typeof input === "string" ? JSON.parse(input.split("\n\n", 1)[0]) : input;
      const promptId = kickoff.prompts[0].id;
      const attempt = (calls.get(promptId) || 0) + 1;
      calls.set(promptId, attempt);
      const roles =
        promptId === "p1"
          ? [
              role({
                company: attempt === 1 ? "Bar One" : "Bar Three",
                title: attempt === 1 ? "Bar Manager" : "Head Bartender",
                location: "New York, NY",
                url: attempt === 1 ? firstUrl : topUpUrl,
              }),
            ]
          : promptId === "p2"
            ? [
                role({
                  company: "Restaurant Two",
                  title: "Assistant General Manager",
                  location: "New York, NY",
                  url: secondUrl,
                }),
              ]
            : [];
      emitAssistantJson(onEvent, {
        roles,
        queries_run: [
          { prompt_id: promptId, query: `${promptId} query ${attempt}`, status: "completed" },
        ],
      });
      return { ok: true };
    },
    resolveJobUrlImpl: canonicalResolver({
      location: "New York, NY",
      liveness: { result: "active", reason: "visible apply control" },
    }),
  });

  assert.deepEqual(Object.fromEntries(calls), { p1: 2, p2: 1, p3: 1 });
  assert.deepEqual(receivedPlans, [executionPlan, executionPlan, executionPlan, executionPlan]);
  assert.equal(typeof inputs[3], "string");
  assert.match(inputs[3], /additional|top up|underfilled/i);
  assert.match(inputs[3], /employer-owned|direct ATS|direct employer/i);
  assert.match(inputs[3], /bar-manager/);
  assert.match(inputs[3], /assistant-general-manager/);
  assert.equal(result.new, 3, JSON.stringify(result));
  assert.equal(result.presented, 3, JSON.stringify(result));
  assert.deepEqual(
    readDbScannerRows({ repoRoot })
      .filter((row) => row.source === "ai-web-search")
      .map((row) => row.role)
      .sort(),
    ["Assistant General Manager", "Bar Manager", "Head Bartender"]
  );
});

test("runAiWebSearch continues useful-set recovery across saved prompts after an empty top-up", async () => {
  const repoRoot = repo({ prompts: 3 });
  candidateConfigPatch({
    repoRoot,
    name: "profile",
    patch: {
      location: {
        home: "New York, NY",
        remote: true,
        remote_scope: "home-country",
        hybrid: true,
        onsite: true,
        relocation: [],
      },
    },
  });
  candidateConfigPatch({
    repoRoot,
    name: "targeting",
    patch: {
      role_buckets: [
        { name: "Bar leadership", titles: ["Bar Manager", "Head Bartender"] },
        { name: "Hospitality operations", titles: ["Assistant General Manager"] },
      ],
      fit_bands: { fit_floor: 65 },
    },
  });
  saveSearchPrompts({
    repoRoot,
    prompts: [
      { id: "p1", text: "Find active Bar Manager and Head Bartender jobs in New York City" },
      { id: "p2", text: "Find active Assistant General Manager jobs in New York City" },
      { id: "p3", text: "Find active Event Operations jobs in New York City" },
    ],
  });
  const calls = new Map();
  const executionPlan = Object.freeze({
    operation: "research.web",
    runtimeId: "codex",
    resolved: Object.freeze({ model: "gpt-5.6-terra", effort: "medium" }),
  });
  const receivedPlans = [];
  const result = await runAiWebSearch({
    repoRoot,
    env: {},
    executionPlan,
    runSkillStream: async ({ input, onEvent, executionPlan: receivedPlan }) => {
      receivedPlans.push(receivedPlan);
      const kickoff = typeof input === "string" ? JSON.parse(input.split("\n\n", 1)[0]) : input;
      const promptId = kickoff.prompts[0].id;
      const attempt = (calls.get(promptId) || 0) + 1;
      calls.set(promptId, attempt);
      const roles =
        attempt === 1 && promptId === "p1"
          ? [
              role({
                company: "Bar One",
                title: "Bar Manager",
                location: "New York, NY",
                url: "https://bar-one.example/jobs/bar-manager",
              }),
            ]
          : attempt === 1 && promptId === "p2"
            ? [
                role({
                  company: "Restaurant Two",
                  title: "Assistant General Manager",
                  location: "New York, NY",
                  url: "https://restaurant-two.example/jobs/assistant-general-manager",
                }),
              ]
            : promptId === "p2"
              ? [
                  role({
                    company: "Restaurant Three",
                    title: "Assistant General Manager",
                    location: "New York, NY",
                    url: "https://restaurant-three.example/jobs/assistant-general-manager",
                  }),
                ]
              : [];
      emitAssistantJson(onEvent, {
        roles,
        queries_run: [
          { prompt_id: promptId, query: `${promptId} query ${attempt}`, status: "completed" },
        ],
      });
      return { ok: true };
    },
    resolveJobUrlImpl: canonicalResolver({
      location: "New York, NY",
      liveness: { result: "active", reason: "visible apply control" },
    }),
  });

  assert.deepEqual(Object.fromEntries(calls), { p1: 2, p2: 2, p3: 1 });
  assert.equal(receivedPlans.length, 5);
  assert.ok(receivedPlans.every((plan) => plan === executionPlan));
  assert.equal(result.new, 3, JSON.stringify(result));
  assert.equal(result.presented, 3, JSON.stringify(result));
});

test("runAiWebSearch retries a missing target bucket within the bounded useful-set cap", async () => {
  const repoRoot = repo({ prompts: 3 });
  candidateConfigPatch({
    repoRoot,
    name: "profile",
    patch: {
      location: {
        home: "New York, NY",
        remote: true,
        remote_scope: "home-country",
        hybrid: true,
        onsite: true,
        relocation: [],
      },
    },
  });
  candidateConfigPatch({
    repoRoot,
    name: "targeting",
    patch: {
      role_buckets: [
        { name: "Bar leadership", titles: ["Bar Manager", "Head Bartender"] },
        { name: "Hospitality operations", titles: ["Assistant General Manager"] },
      ],
      fit_bands: { fit_floor: 65 },
    },
  });
  saveSearchPrompts({
    repoRoot,
    prompts: [
      { id: "p1", text: "Find active Bar Manager and Head Bartender jobs in New York City" },
      { id: "p2", text: "Find active Assistant General Manager jobs in New York City" },
      { id: "p3", text: "Find active Event Operations jobs in New York City" },
    ],
  });
  const calls = new Map();
  const result = await runAiWebSearch({
    repoRoot,
    env: {},
    runSkillStream: async ({ input, onEvent }) => {
      const kickoff = typeof input === "string" ? JSON.parse(input.split("\n\n", 1)[0]) : input;
      const promptId = kickoff.prompts[0].id;
      const attempt = (calls.get(promptId) || 0) + 1;
      calls.set(promptId, attempt);
      const roles =
        promptId === "p1" && attempt === 1
          ? [
              role({
                company: "Bar One",
                title: "Bar Manager",
                location: "New York, NY",
                url: "https://bar-one.example/jobs/bar-manager",
              }),
              role({
                company: "Bar Two",
                title: "Head Bartender",
                location: "New York, NY",
                url: "https://bar-two.example/jobs/head-bartender",
              }),
            ]
          : promptId === "p2" && attempt === 3
            ? [
                role({
                  company: "Restaurant Three",
                  title: "Assistant General Manager",
                  location: "New York, NY",
                  url: "https://restaurant-three.example/jobs/assistant-general-manager",
                }),
              ]
            : [];
      emitAssistantJson(onEvent, {
        roles,
        queries_run: [
          { prompt_id: promptId, query: `${promptId} query ${attempt}`, status: "completed" },
        ],
      });
      return { ok: true };
    },
    resolveJobUrlImpl: canonicalResolver({
      location: "New York, NY",
      liveness: { result: "active", reason: "visible apply control" },
    }),
  });

  assert.deepEqual(Object.fromEntries(calls), { p1: 1, p2: 3, p3: 1 });
  assert.equal(result.new, 3, JSON.stringify(result));
  assert.equal(result.presented, 3, JSON.stringify(result));
});

test("runAiWebSearch caps invalid useful-set top-ups at three turns and reuses hard gates", async () => {
  const repoRoot = repo({ prompts: 3 });
  candidateConfigPatch({
    repoRoot,
    name: "profile",
    patch: {
      compensation: { minimum_base: 85000 },
      location: {
        home: "New York, NY",
        remote: true,
        remote_scope: "home-country",
        hybrid: true,
        onsite: true,
        relocation: [],
      },
    },
  });
  candidateConfigPatch({
    repoRoot,
    name: "targeting",
    patch: {
      role_buckets: [
        { name: "Bar leadership", titles: ["Bar Manager", "Head Bartender"] },
        { name: "Hospitality operations", titles: ["Assistant General Manager"] },
      ],
      fit_bands: { fit_floor: 65 },
    },
  });
  const calls = new Map();
  const firstUrl = "https://employer-one.example/jobs/bar-manager";
  const secondUrl = "https://employer-two.example/jobs/assistant-general-manager";
  const outsideUrl = "https://employer-three.example/jobs/head-bartender";
  const hydrated = [];
  const result = await runAiWebSearch({
    repoRoot,
    env: {},
    runSkillStream: async ({ input, onEvent }) => {
      const kickoff = typeof input === "string" ? JSON.parse(input.split("\n\n", 1)[0]) : input;
      const promptId = kickoff.prompts[0].id;
      const attempt = (calls.get(promptId) || 0) + 1;
      calls.set(promptId, attempt);
      const roles =
        promptId === "p1"
          ? attempt === 1
            ? [
                role({
                  company: "Bar One",
                  title: "Bar Manager",
                  location: "New York, NY",
                  url: firstUrl,
                }),
              ]
            : [
                role({
                  company: "Bar One",
                  title: "Bar Manager",
                  location: "New York, NY",
                  url: firstUrl,
                }),
                role({
                  company: "Bar Three",
                  title: "Head Bartender",
                  location: "San Francisco, CA",
                  url: outsideUrl,
                }),
              ]
          : promptId === "p2"
            ? [
                role({
                  company: "Restaurant Two",
                  title: "Assistant General Manager",
                  location: "New York, NY",
                  url: secondUrl,
                }),
              ]
            : [];
      emitAssistantJson(onEvent, {
        roles,
        queries_run: [
          { prompt_id: promptId, query: `${promptId} query ${attempt}`, status: "completed" },
        ],
      });
      return { ok: true };
    },
    resolveJobUrlImpl: async (url) => {
      hydrated.push(url);
      return canonicalResolver({
        location: url === outsideUrl ? "San Francisco, CA" : "New York, NY",
        liveness: { result: "active", reason: "visible apply control" },
      })(url);
    },
  });

  assert.deepEqual(Object.fromEntries(calls), { p1: 2, p2: 2, p3: 2 });
  assert.equal(hydrated.filter((url) => url === firstUrl).length, 1);
  assert.equal(result.new, 2, JSON.stringify(result));
  assert.equal(result.presented, 2, JSON.stringify(result));
  assert.deepEqual(result.reasonCounts, { location: 1 });
});

test("runAiWebSearch keeps an empty useful-set top-up explicitly bounded", async () => {
  const repoRoot = repo({ prompts: 3 });
  const inputs = [];
  const result = await runAiWebSearch({
    repoRoot,
    env: {},
    runSkillStream: async ({ input, onEvent }) => {
      inputs.push(input);
      const kickoff = typeof input === "string" ? JSON.parse(input.split("\n\n", 1)[0]) : input;
      const promptId = kickoff.prompts[0].id;
      emitAssistantJson(onEvent, {
        roles: [],
        queries_run: [{ prompt_id: promptId, query: `${promptId} empty`, status: "completed" }],
      });
      return { ok: true };
    },
  });

  assert.equal(inputs.length, 6);
  for (const input of inputs.slice(3)) {
    assert.equal(typeof input, "string");
    assert.match(input, /underfilled|additional/i);
  }
  assert.deepEqual(
    inputs.slice(3).map((input) => JSON.parse(input.split("\n\n", 1)[0]).prompts[0].id),
    ["p1", "p2", "p3"]
  );
  assert.equal(result.new, 0);
  assert.equal(result.presented, 0);
});

test("runAiWebSearch does not top up an already useful three-prompt result", async () => {
  const repoRoot = repo({ prompts: 3 });
  candidateConfigPatch({
    repoRoot,
    name: "targeting",
    patch: {
      role_buckets: [{ name: "Applied AI", titles: ["Applied AI Engineer"] }],
      fit_bands: { fit_floor: 0 },
    },
  });
  let calls = 0;
  const result = await runAiWebSearch({
    repoRoot,
    env: {},
    runSkillStream: async ({ input, onEvent }) => {
      calls += 1;
      const kickoff = input;
      const promptId = kickoff.prompts[0].id;
      emitAssistantJson(onEvent, {
        roles: [
          role({
            company: `Company ${promptId}`,
            title: `Applied AI Engineer ${promptId}`,
            url: `https://jobs.example.test/${promptId}`,
          }),
        ],
        queries_run: [{ prompt_id: promptId, query: `${promptId} query`, status: "completed" }],
      });
      return { ok: true };
    },
    resolveJobUrlImpl: canonicalResolver(),
  });

  assert.equal(calls, 3);
  assert.equal(result.new, 3, JSON.stringify(result));
});

test("runAiWebSearch scopes concentrated rejected hosts to the owning saved prompt", async () => {
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
      const ownHost = promptId === "p1" ? "stale-a.example" : "stale-b.example";
      const siblingHost = promptId === "p1" ? "stale-b.example" : "stale-a.example";
      const roles =
        attempt === 1
          ? [1, 2].map((index) =>
              role({
                company: `${promptId} stale ${index}`,
                url: `https://${ownHost}/jobs/${promptId}-expired-${index}`,
              })
            )
          : [
              role({
                company: `${promptId} active`,
                url: `https://${siblingHost}/jobs/${promptId}-active`,
              }),
            ];
      emitAssistantJson(onEvent, {
        roles,
        queries_run: [{ prompt_id: promptId, query: `${promptId} query ${attempt}` }],
      });
      return { ok: true };
    },
    resolveJobUrlImpl: async (url) =>
      url.includes("expired")
        ? {
            bodyFetchStatus: "resolved",
            url,
            bodyText: fullJd("Expired posting"),
            liveness: { result: "expired", reason: "Expired posting." },
          }
        : canonicalResolver()(url),
  });

  assert.deepEqual(Object.fromEntries(calls), { p1: 4, p2: 3 });
  assert.equal(result.new, 2, JSON.stringify(result));
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

  assert.deepEqual(Object.fromEntries(calls), { p1: 4, p2: 2 });
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
