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
  sourceConfigPut,
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
    comp_text: null,
    base_comp_text: null,
    annual_earnings_text: null,
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

function specificResolution(url, overrides = {}) {
  return {
    bodyFetchStatus: "resolved",
    url,
    bodyText: fullJd(),
    postingEvidence: {
      pageTitle: "Specific job posting",
      headings: ["Specific job posting"],
      structuredPostingCount: 1,
      canonicalPostingUrls: [],
    },
    ...overrides,
  };
}

function canonicalResolver(overrides = {}) {
  return async (url) => specificResolution(url, overrides);
}

test("AI web search requires nullable basis-specific compensation fields", () => {
  const schema = JSON.parse(
    readFileSync(new URL("../config/ai-web-search.schema.json", import.meta.url), "utf8")
  );
  const roleSchema = schema.properties.roles.items;

  assert.ok(roleSchema.required.includes("comp_text"));
  assert.ok(roleSchema.required.includes("base_comp_text"));
  assert.ok(roleSchema.required.includes("annual_earnings_text"));
  assert.deepEqual(roleSchema.properties.base_comp_text.type, ["string", "null"]);
  assert.deepEqual(roleSchema.properties.annual_earnings_text.type, ["string", "null"]);
});

test("AI web search schema bounds explicit fetched-posting rejections", () => {
  const schema = JSON.parse(
    readFileSync(new URL("../config/ai-web-search.schema.json", import.meta.url), "utf8")
  );
  const rejectionSchema = schema.properties.rejected_postings;

  assert.equal(rejectionSchema.type, "array");
  assert.equal(rejectionSchema.maxItems, 8);
  assert.deepEqual(rejectionSchema.items.required, ["url", "reason"]);
  assert.equal(rejectionSchema.items.additionalProperties, false);
  assert.equal(rejectionSchema.items.properties.reason.maxLength, 240);
});

test("runAiWebSearch corrects a schema-valid reply that silently drops a fetched exact posting", async () => {
  const repoRoot = repo({ prompts: 1 });
  candidateConfigPatch({
    repoRoot,
    name: "targeting",
    patch: {
      role_buckets: [
        {
          name: "Engineering",
          titles: ["Applied AI Engineer", "Platform Engineer", "Reliability Engineer"],
        },
      ],
      fit_bands: { fit_floor: 0 },
    },
  });
  saveSearchPrompts({
    repoRoot,
    prompts: [
      {
        id: "p1",
        text: "Find Applied AI Engineer, Platform Engineer, and Reliability Engineer jobs",
      },
    ],
  });
  const fetchedUrl = "https://job-boards.greenhouse.io/550/jobs/5186736008";
  const roles = [
    role({ url: "https://jobs.example.test/applied-ai", title: "Applied AI Engineer" }),
    role({ url: "https://jobs.example.test/platform", title: "Platform Engineer" }),
    role({ url: "https://jobs.example.test/reliability", title: "Reliability Engineer" }),
  ];
  const inputs = [];
  const invocations = [];

  const result = await runAiWebSearch({
    repoRoot,
    env: {},
    runSkillStream: async (options) => {
      invocations.push(options);
      const { input, onEvent } = options;
      inputs.push(input);
      if (inputs.length === 1) {
        onEvent({
          type: "tool_use",
          data: { id: "fetch-550", name: "WebFetch", input: { url: fetchedUrl } },
        });
        onEvent({
          type: "tool_result",
          data: { toolUseId: "fetch-550", content: "Exact live job posting", isError: false },
        });
      }
      emitAssistantJson(onEvent, {
        roles,
        rejected_postings:
          inputs.length === 1
            ? []
            : [{ url: fetchedUrl, reason: "The role is outside the saved seniority target." }],
        queries_run: [{ prompt_id: "p1", query: "engineering jobs", status: "completed" }],
      });
      return { ok: true };
    },
    resolveJobUrlImpl: canonicalResolver(),
  });

  assert.equal(inputs.length, 2);
  assert.equal(typeof inputs[1], "string");
  assert.match(inputs[1], /successfully fetched exact posting/i);
  assert.match(inputs[1], /job-boards\.greenhouse\.io\/550\/jobs\/5186736008/);
  assert.match(inputs[1], /https:\/\/jobs\.example\.test\/applied-ai/);
  assert.match(inputs[1], /previous JSON response/i);
  assert.match(inputs[1], /do not run (?:WebSearch|web tools)/i);
  assert.deepEqual(invocations[1].tools, []);
  assert.deepEqual(result.errors, []);
  assert.equal(result.new, 3, JSON.stringify(result));
  assert.deepEqual(result.fetchedPostingDecisions, [
    {
      promptId: "p1",
      url: fetchedUrl,
      reason: "The role is outside the saved seniority target.",
    },
  ]);
});

test("runAiWebSearch fails the prompt after one correction when a fetched exact posting stays unaccounted", async () => {
  const repoRoot = repo({ prompts: 1 });
  const fetchedUrl = "https://job-boards.greenhouse.io/550/jobs/4919621008";
  let calls = 0;

  const result = await runAiWebSearch({
    repoRoot,
    env: {},
    runSkillStream: async ({ onEvent }) => {
      calls += 1;
      if (calls === 1) {
        onEvent({
          type: "tool_use",
          data: { id: "fetch-550", name: "WebFetch", input: { url: fetchedUrl } },
        });
        onEvent({
          type: "tool_result",
          data: { toolUseId: "fetch-550", content: "Exact live job posting", isError: false },
        });
      }
      emitAssistantJson(onEvent, {
        roles: [],
        rejected_postings: [],
        queries_run: [{ prompt_id: "p1", query: "hospitality jobs", status: "completed" }],
      });
      return { ok: true };
    },
  });

  assert.equal(calls, 2);
  assert.equal(result.found, 0);
  assert.equal(result.new, 0);
  assert.equal(result.errors.length, 1);
  assert.deepEqual(result.failedPromptIds, ["p1"]);
  assert.deepEqual(result.validationFailures, [
    {
      promptId: "p1",
      path: "rejected_postings",
      message:
        "successfully fetched exact posting must appear in roles[].url or " +
        `rejected_postings[].url with a short factual reason: ${fetchedUrl}`,
    },
  ]);
});

test("runAiWebSearch corrects an unaccounted fetch during freshness recovery without tools", async () => {
  const repoRoot = repo({ prompts: 1 });
  candidateConfigPatch({
    repoRoot,
    name: "targeting",
    patch: {
      role_buckets: [{ name: "Engineering", titles: ["Platform Engineer"] }],
      fit_bands: { fit_floor: 0 },
    },
  });
  saveSearchPrompts({
    repoRoot,
    prompts: [{ id: "p1", text: "Find Platform Engineer jobs" }],
  });
  const expiredUrl = "https://jobs.example.test/expired-platform";
  const omittedFetchedUrl = "https://jobs.example.test/rejected-platform";
  const freshRoles = [1, 2, 3].map((index) =>
    role({
      company: `Fresh Platform ${index}`,
      title: "Platform Engineer",
      url: `https://jobs.example.test/fresh-platform-${index}`,
    })
  );
  const invocations = [];

  const result = await runAiWebSearch({
    repoRoot,
    env: {},
    runSkillStream: async (options) => {
      invocations.push(options);
      const { onEvent } = options;
      if (invocations.length === 1) {
        emitAssistantJson(onEvent, {
          roles: [
            role({ company: "Expired Platform", title: "Platform Engineer", url: expiredUrl }),
          ],
          queries_run: [{ prompt_id: "p1", query: "platform jobs", status: "completed" }],
        });
      } else {
        if (invocations.length === 2) {
          onEvent({
            type: "tool_use",
            data: { id: "recovery-fetch", name: "WebFetch", input: { url: omittedFetchedUrl } },
          });
          onEvent({
            type: "tool_result",
            data: { toolUseId: "recovery-fetch", content: "Exact posting", isError: false },
          });
        }
        emitAssistantJson(onEvent, {
          roles: freshRoles,
          rejected_postings:
            invocations.length === 2
              ? []
              : [{ url: omittedFetchedUrl, reason: "Outside the saved location." }],
          queries_run: [{ prompt_id: "p1", query: "fresh platform jobs", status: "completed" }],
        });
      }
      return { ok: true };
    },
    resolveJobUrlImpl: async (url) =>
      specificResolution(url, {
        title: "Platform Engineer",
        liveness:
          url === expiredUrl
            ? { result: "expired", reason: "The posting is no longer active." }
            : { result: "active", reason: "visible apply control" },
      }),
  });

  assert.equal(invocations.length, 3);
  assert.deepEqual(invocations[2].tools, []);
  assert.match(invocations[2].input, /do not run WebSearch, WebFetch, or any other tools/i);
  assert.deepEqual(result.errors, []);
  assert.equal(result.new, 3, JSON.stringify(result));
});

test("runAiWebSearch corrects an unaccounted fetch during useful-set top-up without tools", async () => {
  const repoRoot = repo({ prompts: 1 });
  candidateConfigPatch({
    repoRoot,
    name: "targeting",
    patch: {
      role_buckets: [{ name: "Engineering", titles: ["Platform Engineer"] }],
      fit_bands: { fit_floor: 0 },
    },
  });
  saveSearchPrompts({
    repoRoot,
    prompts: [{ id: "p1", text: "Find Platform Engineer jobs" }],
  });
  const omittedFetchedUrl = "https://jobs.example.test/rejected-top-up";
  const topUpRoles = [2, 3].map((index) =>
    role({
      company: `Top Up Platform ${index}`,
      title: "Platform Engineer",
      url: `https://jobs.example.test/top-up-platform-${index}`,
    })
  );
  const invocations = [];

  const result = await runAiWebSearch({
    repoRoot,
    env: {},
    runSkillStream: async (options) => {
      invocations.push(options);
      const { onEvent } = options;
      if (invocations.length === 1) {
        emitAssistantJson(onEvent, {
          roles: [
            role({
              company: "Initial Platform",
              title: "Platform Engineer",
              url: "https://jobs.example.test/initial-platform",
            }),
          ],
          queries_run: [{ prompt_id: "p1", query: "platform jobs", status: "completed" }],
        });
      } else {
        if (invocations.length === 2) {
          onEvent({
            type: "tool_use",
            data: { id: "top-up-fetch", name: "WebFetch", input: { url: omittedFetchedUrl } },
          });
          onEvent({
            type: "tool_result",
            data: { toolUseId: "top-up-fetch", content: "Exact posting", isError: false },
          });
        }
        emitAssistantJson(onEvent, {
          roles: topUpRoles,
          rejected_postings:
            invocations.length === 2
              ? []
              : [{ url: omittedFetchedUrl, reason: "Below a saved hard requirement." }],
          queries_run: [{ prompt_id: "p1", query: "more platform jobs", status: "completed" }],
        });
      }
      return { ok: true };
    },
    resolveJobUrlImpl: canonicalResolver({
      title: "Platform Engineer",
      liveness: { result: "active", reason: "visible apply control" },
    }),
  });

  assert.equal(invocations.length, 3);
  assert.deepEqual(invocations[2].tools, []);
  assert.match(invocations[2].input, /do not run WebSearch, WebFetch, or any other tools/i);
  assert.deepEqual(result.errors, []);
  assert.equal(result.new, 3, JSON.stringify(result));
});

test("runAiWebSearch does not demand an output decision for a failed WebFetch", async () => {
  const repoRoot = repo({ prompts: 1 });
  let calls = 0;
  const result = await runAiWebSearch({
    repoRoot,
    env: {},
    runSkillStream: async ({ onEvent }) => {
      calls += 1;
      onEvent({
        type: "tool_use",
        data: {
          id: "failed-fetch",
          name: "WebFetch",
          input: { url: "https://jobs.example.test/unreadable-role" },
        },
      });
      onEvent({
        type: "tool_result",
        data: { toolUseId: "failed-fetch", content: "Request timed out", isError: true },
      });
      emitAssistantJson(onEvent, {
        roles: [],
        rejected_postings: [],
        queries_run: [{ prompt_id: "p1", query: "jobs", status: "failed", error: "timed out" }],
      });
      return { ok: true };
    },
  });

  assert.equal(calls, 1);
  assert.equal(result.errors.length, 0);
  assert.deepEqual(result.failedPromptIds, ["p1"]);
});

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

test("the dedicated AI search route grants its owning skill despite an empty generic allowlist", async () => {
  const repoRoot = repo({ prompts: 1 });
  let receivedEnv = null;
  const respond = assistantJson({ roles: [], queries_run: [] });

  await runAiWebSearch({
    repoRoot,
    env: { CAREERRAT_RUNTIME_SKILLS: "" },
    runSkillStream: async (options) => {
      receivedEnv = options.env;
      return respond(options);
    },
  });

  assert.equal(receivedEnv.CAREERRAT_RUNTIME_SKILLS, "search-jobs");
});

test("runAiWebSearch gives every initial prompt the strict result URL routing policy", async () => {
  const repoRoot = repo({ prompts: 1 });
  const inputs = [];
  await runAiWebSearch({
    repoRoot,
    env: {},
    runSkillStream: async ({ input, onEvent }) => {
      inputs.push(input);
      emitAssistantJson(onEvent, {
        roles: [
          role({
            company: "Direct One",
            title: "Applied AI Engineer One",
            url: "https://jobs.example.test/direct-one",
          }),
          role({
            company: "Direct Two",
            title: "Applied AI Engineer Two",
            url: "https://jobs.example.test/direct-two",
          }),
          role({
            company: "Direct Three",
            title: "Applied AI Engineer Three",
            url: "https://jobs.example.test/direct-three",
          }),
        ],
        queries_run: [{ prompt_id: "p1", query: "direct employer roles", status: "completed" }],
      });
      return { ok: true };
    },
    resolveJobUrlImpl: canonicalResolver(),
  });

  assert.equal(typeof inputs[0], "object");
  assert.deepEqual(inputs[0].result_url_policy, [
    "Prefer employer-owned career pages and direct ATS postings.",
    "Use third-party boards to discover employer-and-title pairs, and attempt to resolve a direct posting URL before returning the third-party URL.",
    "Return one exact current posting URL, never a search, category, location, career-hub, or redirect-wrapper URL.",
    "If an exact posting-specific third-party page is browser-blocked after that direct-resolution attempt, return it with body_text null and body_partial true so CareerRat can preserve it as an explicitly unverified partial lead.",
    "Reject generic pages, expired redirects, unsafe or private URLs, and postings whose canonical evidence names a different job.",
  ]);
});

test("runAiWebSearch gives each prompt compact target-title and location query hints", async () => {
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
        onsite: false,
      },
    },
  });
  candidateConfigPatch({
    repoRoot,
    name: "targeting",
    patch: {
      role_buckets: [
        {
          name: "Developer infrastructure",
          titles: ["Platform Engineer", "Site Reliability Engineer"],
        },
      ],
      fit_bands: { fit_floor: 0 },
    },
  });
  const savedPrompt =
    "Find currently active Platform Engineer and Site Reliability Engineer roles in New York or remote in the US, prioritize direct employer postings, and avoid generic career pages or expired listings";
  saveSearchPrompts({ repoRoot, prompts: [{ id: "p1", text: savedPrompt }] });
  const inputs = [];

  await runAiWebSearch({
    repoRoot,
    env: {},
    runSkillStream: async ({ input, onEvent }) => {
      inputs.push(input);
      emitAssistantJson(onEvent, {
        roles: [
          role({
            company: "Infra One",
            title: "Platform Engineer",
            url: "https://jobs.example.test/infra-one",
          }),
          role({
            company: "Infra Two",
            title: "Site Reliability Engineer",
            url: "https://jobs.example.test/infra-two",
          }),
          role({
            company: "Infra Three",
            title: "Platform Engineer",
            url: "https://jobs.example.test/infra-three",
          }),
        ],
        queries_run: [{ prompt_id: "p1", query: savedPrompt, status: "completed" }],
      });
      return { ok: true };
    },
    resolveJobUrlImpl: canonicalResolver(),
  });

  assert.equal(typeof inputs[0], "object");
  assert.deepEqual(inputs[0].search_plan.limits, {
    scope: "prompt-turn",
    web_search_calls: 4,
    web_fetch_calls: 8,
    hard_stop: true,
  });
  assert.equal(inputs[0].search_plan.query_hints.length, 2);
  assert.notEqual(inputs[0].search_plan.query_hints[0].query, savedPrompt);
  for (const { query } of inputs[0].search_plan.query_hints) {
    assert.ok(query.length <= 100, query);
    assert.match(query, /"New York, NY"/);
    assert.match(query, /\bremote\b/i);
  }
  assert.match(inputs[0].search_plan.query_hints[0].query, /"Platform Engineer"/);
  assert.doesNotMatch(
    inputs[0].search_plan.query_hints[0].query,
    /prioritize direct employer postings|generic career pages|expired listings/i
  );
  assert.equal(inputs[0].search_plan.query_hints[1].kind, "direct-employer-or-ats");
  assert.match(inputs[0].search_plan.query_hints[1].query, /"Site Reliability Engineer"/);
  assert.match(inputs[0].search_plan.query_hints[1].query, /\bcareers\b|\bsite:/i);
  assert.doesNotMatch(inputs[0].search_plan.query_hints[1].query, /claude|codex|hospitality/i);
});

test("runAiWebSearch keeps the exact event fixture hints atomic and scopes remote to the US", async () => {
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
      fit_bands: { fit_floor: 0 },
    },
  });
  saveSearchPrompts({
    repoRoot,
    prompts: [
      {
        id: "p1",
        text: "Find currently active Event Operations Manager, Event Coordinator, and Venue Operations Manager roles that are either local to New York City or remote anywhere in the United States and available to a New York resident.",
      },
    ],
  });
  const inputs = [];

  await runAiWebSearch({
    repoRoot,
    env: {},
    runSkillStream: async ({ input, onEvent }) => {
      inputs.push(input);
      emitAssistantJson(onEvent, {
        roles: [],
        queries_run: [{ prompt_id: "p1", query: "event operations", status: "completed" }],
      });
      return { ok: true };
    },
  });

  const hints = inputs[0].search_plan.query_hints;
  assert.equal(hints.length, 4);
  for (const { query } of hints) {
    assert.ok(query.length <= 100, query);
    assert.equal((query.match(/"/g) || []).length % 2, 0, query);
    assert.equal((query.match(/\(/g) || []).length, (query.match(/\)/g) || []).length, query);
    assert.match(query, /remote "United States"/);
    assert.doesNotMatch(query, /available to a New York resident/i);
  }
});

test("runAiWebSearch keeps US-remote scope separate from the following NYC hybrid clause", async () => {
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
        onsite: false,
        max_commute_days_per_week: 2,
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
          name: "Developer infrastructure",
          titles: ["Developer Infrastructure Engineer", "Developer Experience Engineer"],
        },
      ],
      fit_bands: { fit_floor: 0 },
    },
  });
  saveSearchPrompts({
    repoRoot,
    prompts: [
      {
        id: "p1",
        text: "Find currently active Developer Infrastructure and Developer Experience Engineer roles that are either US-remote or hybrid in New York City with at most two office days.",
      },
    ],
  });
  sourceConfigPut({
    repoRoot,
    name: "search-sources",
    data: {
      searches: [
        {
          provider: "hiringcafe",
          source_type: "browser",
          label: "Developer Infrastructure Engineer and Developer Experience Engineer",
          url: "https://hiring.cafe/?searchState=developer-infrastructure",
          enabled: true,
        },
      ],
    },
  });
  let plan = null;

  await runAiWebSearch({
    repoRoot,
    env: {},
    runSkillStream: async ({ input, onEvent }) => {
      plan ??=
        typeof input === "string"
          ? JSON.parse(input.split("\n\n", 1)[0]).search_plan
          : input.search_plan;
      emitAssistantJson(onEvent, {
        roles: [],
        queries_run: [{ prompt_id: "p1", query: "developer infrastructure", status: "completed" }],
      });
      return { ok: true };
    },
  });

  assert.ok(plan.query_hints.length > 0);
  for (const { query } of plan.query_hints) {
    assert.match(query, /"New York, NY"/);
    assert.match(query, /remote "United States"/i);
    assert.doesNotMatch(query, /office days/i);
  }
  const directAtsHosts = [];
  for (const title of ["Developer Infrastructure Engineer", "Developer Experience Engineer"]) {
    assert.ok(
      plan.query_hints.some(({ query }) => query.includes(`"${title}"`) && !/\bsite:/i.test(query)),
      `${title} needs one broad query: ${JSON.stringify(plan.query_hints)}`
    );
    const directQuery = plan.query_hints.find(
      ({ query }) =>
        query.includes(`"${title}"`) &&
        /site:(?:job-boards\.greenhouse\.io|jobs\.lever\.co|jobs\.ashbyhq\.com|jobs\.smartrecruiters\.com|myworkdayjobs\.com)/i.test(
          query
        ) &&
        !/\bcareers\b/i.test(query) &&
        !query.includes("site:hiring.cafe")
    );
    assert.ok(
      directQuery,
      `${title} needs one direct ATS query: ${JSON.stringify(plan.query_hints)}`
    );
    directAtsHosts.push(directQuery.query.match(/site:([^ )]+)/i)?.[1]);
  }
  assert.equal(
    new Set(directAtsHosts).size,
    directAtsHosts.length,
    `split titles should rotate ATS hosts: ${JSON.stringify(plan.query_hints)}`
  );
});

test("runAiWebSearch recognizes a plain-English remote eligibility scope", async () => {
  const repoRoot = repo({ prompts: 1 });
  candidateConfigPatch({
    repoRoot,
    name: "profile",
    patch: {
      location: {
        home: "New York, NY",
        remote: true,
        remote_scope: "home-country",
        hybrid: false,
        onsite: false,
        relocation: [],
      },
    },
  });
  candidateConfigPatch({
    repoRoot,
    name: "targeting",
    patch: {
      role_buckets: [{ name: "Platform", titles: ["Staff Platform Engineer"] }],
      fit_bands: { fit_floor: 0 },
    },
  });
  saveSearchPrompts({
    repoRoot,
    prompts: [
      {
        id: "p1",
        text: "Find Staff Platform Engineer remote roles available to candidates in the United States.",
      },
    ],
  });
  let plan = null;

  await runAiWebSearch({
    repoRoot,
    env: {},
    runSkillStream: async ({ input, onEvent }) => {
      plan ??=
        typeof input === "string"
          ? JSON.parse(input.split("\n\n", 1)[0]).search_plan
          : input.search_plan;
      emitAssistantJson(onEvent, {
        roles: [],
        queries_run: [{ prompt_id: "p1", query: "staff platform", status: "completed" }],
      });
      return { ok: true };
    },
  });

  for (const { query } of plan.query_hints) {
    assert.match(query, /remote "United States"/i);
    assert.doesNotMatch(query, /candidates/i);
  }
});

test("runAiWebSearch recognizes a comma-qualified configured title in prompt word order", async () => {
  const repoRoot = repo({ prompts: 1 });
  candidateConfigPatch({
    repoRoot,
    name: "targeting",
    patch: {
      role_buckets: [
        {
          name: "Hospitality operations",
          titles: [
            "Operations Manager, Food & Beverage",
            "Assistant General Manager",
            "General Manager",
          ],
        },
      ],
      fit_bands: { fit_floor: 0 },
    },
  });
  saveSearchPrompts({
    repoRoot,
    prompts: [
      {
        id: "p1",
        text: "Find currently active Food and Beverage Operations Manager, Assistant General Manager, and General Manager openings in New York City hospitality businesses.",
      },
    ],
  });
  const inputs = [];

  await runAiWebSearch({
    repoRoot,
    env: {},
    runSkillStream: async ({ input, onEvent }) => {
      inputs.push(input);
      emitAssistantJson(onEvent, {
        roles: [],
        queries_run: [{ prompt_id: "p1", query: "hospitality operations", status: "completed" }],
      });
      return { ok: true };
    },
  });

  assert.ok(
    inputs[0].search_plan.query_hints.some(({ query }) =>
      query.includes('"Operations Manager, Food & Beverage"')
    ),
    JSON.stringify(inputs[0].search_plan)
  );
});

test("runAiWebSearch partitions all five explicit bar titles across two bounded hints", async () => {
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
  const titles = [
    "Bar Manager",
    "Assistant Bar Manager",
    "Bar Operations Lead",
    "Lead Bartender",
    "Head Bartender",
  ];
  candidateConfigPatch({
    repoRoot,
    name: "targeting",
    patch: {
      role_buckets: [{ name: "Bar leadership", titles }],
      fit_bands: { fit_floor: 0 },
    },
  });
  saveSearchPrompts({
    repoRoot,
    prompts: [
      {
        id: "p1",
        text: "Find currently active Bar Manager, Assistant Bar Manager, Bar Operations Lead, Lead Bartender, and Head Bartender openings in New York City.",
      },
    ],
  });
  const inputs = [];

  await runAiWebSearch({
    repoRoot,
    env: {},
    runSkillStream: async ({ input, onEvent }) => {
      inputs.push(input);
      emitAssistantJson(onEvent, {
        roles: [],
        queries_run: [{ prompt_id: "p1", query: "bar leadership", status: "completed" }],
      });
      return { ok: true };
    },
  });

  const hints = inputs[0].search_plan.query_hints;
  assert.equal(hints.length, 4);
  for (const { query } of hints) {
    assert.ok(query.length <= 100, query);
    assert.equal((query.match(/"/g) || []).length % 2, 0, query);
    assert.equal((query.match(/\(/g) || []).length, (query.match(/\)/g) || []).length, query);
    assert.match(query, /"New York, NY"/);
  }
  for (const title of titles) {
    assert.equal(
      hints.filter(({ query }) => query.includes(`"${title}"`)).length,
      2,
      `${title}: ${JSON.stringify(hints)}`
    );
  }
});

test("runAiWebSearch keeps exact prompt titles authoritative over incidental bucket words", async () => {
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
  const explicitTitles = [
    "Bar Manager",
    "Assistant Bar Manager",
    "Bar Operations Lead",
    "Lead Bartender",
    "Head Bartender",
  ];
  const unrelatedTitles = [
    "Operations Manager, Food & Beverage",
    "Assistant General Manager",
    "General Manager",
  ];
  candidateConfigPatch({
    repoRoot,
    name: "targeting",
    patch: {
      role_buckets: [
        { name: "Bar leadership", titles: explicitTitles },
        { name: "Hospitality operations", titles: unrelatedTitles },
      ],
      fit_bands: { fit_floor: 0 },
    },
  });
  saveSearchPrompts({
    repoRoot,
    prompts: [
      {
        id: "nyc-bar-leadership",
        text: "Find currently active Bar Manager, Assistant Bar Manager, Bar Operations Lead, Lead Bartender, and Head Bartender openings in New York City. Search the open web broadly, including specialist hospitality boards, employer career pages, and useful aggregators.",
      },
    ],
  });
  const inputs = [];

  await runAiWebSearch({
    repoRoot,
    env: {},
    runSkillStream: async ({ input, onEvent }) => {
      inputs.push(input);
      emitAssistantJson(onEvent, {
        roles: [],
        queries_run: [
          { prompt_id: "nyc-bar-leadership", query: "bar leadership", status: "completed" },
        ],
      });
      return { ok: true };
    },
  });

  const parsedInputs = inputs.map((input) =>
    typeof input === "string" ? JSON.parse(input.split("\n\n", 1)[0]) : input
  );
  const queries = parsedInputs.flatMap(({ search_plan: plan }) =>
    plan.query_hints.map(({ query }) => query)
  );
  const topUpInstructions = inputs
    .filter((input) => typeof input === "string")
    .map((input) => input.split("\n\n").slice(1).join("\n\n"));
  for (const title of explicitTitles) {
    assert.ok(
      queries.some((query) => query.includes(`"${title}"`)),
      `${title}: ${JSON.stringify(queries)}`
    );
  }
  for (const title of unrelatedTitles) {
    assert.ok(
      queries.every((query) => !query.includes(`"${title}"`)),
      `${title}: ${JSON.stringify(queries)}`
    );
    assert.ok(
      topUpInstructions.every((instruction) => !instruction.includes(title)),
      `${title}: ${JSON.stringify(topUpInstructions)}`
    );
  }
});

test("runAiWebSearch keeps oversized multi-title hints atomic and location-scoped", async () => {
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
  const titles = [
    "Assistant Bar Manager",
    "Bar Operations Lead",
    "Lead Bartender",
    "Head Bartender",
    "Operations Manager, Food & Beverage",
    "General Manager",
  ];
  candidateConfigPatch({
    repoRoot,
    name: "targeting",
    patch: {
      role_buckets: [{ name: "Hospitality leadership", titles }],
      fit_bands: { fit_floor: 0 },
    },
  });
  saveSearchPrompts({
    repoRoot,
    prompts: [
      {
        id: "p1",
        text: `Find ${titles.join(", ")} openings in New York City.`,
      },
    ],
  });
  const inputs = [];

  await runAiWebSearch({
    repoRoot,
    env: {},
    runSkillStream: async ({ input, onEvent }) => {
      inputs.push(input);
      emitAssistantJson(onEvent, {
        roles: [],
        queries_run: [{ prompt_id: "p1", query: "hospitality leadership", status: "completed" }],
      });
      return { ok: true };
    },
  });

  const hints = inputs[0].search_plan.query_hints;
  assert.equal(hints.length, 4);
  for (const { query } of hints) {
    assert.ok(query.length <= 100, query);
    assert.equal((query.match(/"/g) || []).length % 2, 0, query);
    assert.equal((query.match(/\(/g) || []).length, (query.match(/\)/g) || []).length, query);
    assert.match(query, /"New York, NY"/);
    for (const quotedTerm of query.match(/"[^"]+"/g) || []) {
      assert.doesNotMatch(quotedTerm, /\bOR\b/, query);
    }
  }
  for (const title of titles) {
    assert.ok(
      hints.some(({ query }) => query.includes(`"${title}"`)),
      `${title}: ${JSON.stringify(hints)}`
    );
  }
});

test("runAiWebSearch drops optional clauses before clipping one whole configured title", async () => {
  const repoRoot = repo({ prompts: 1 });
  const title =
    "Principal Customer Platform Reliability and Distributed Systems Operations Engineering Manager";
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
    patch: {
      role_buckets: [{ name: "Platform leadership", titles: [title] }],
      fit_bands: { fit_floor: 0 },
    },
  });
  saveSearchPrompts({
    repoRoot,
    prompts: [{ id: "p1", text: `Find ${title} openings in New York City.` }],
  });
  const inputs = [];

  await runAiWebSearch({
    repoRoot,
    env: {},
    runSkillStream: async ({ input, onEvent }) => {
      inputs.push(input);
      emitAssistantJson(onEvent, {
        roles: [],
        queries_run: [{ prompt_id: "p1", query: "platform leadership", status: "completed" }],
      });
      return { ok: true };
    },
  });

  for (const { query } of inputs[0].search_plan.query_hints) {
    assert.ok(query.length <= 100, query);
    assert.equal((query.match(/"/g) || []).length % 2, 0, query);
    assert.equal((query.match(/\(/g) || []).length, (query.match(/\)/g) || []).length, query);
    assert.match(query, new RegExp(`^"${title}"(?: |$)`));
    assert.doesNotMatch(query, /New York, NY/);
  }
});

test("runAiWebSearch clips at a word boundary only when one title cannot fit by itself", async () => {
  const repoRoot = repo({ prompts: 1 });
  const title =
    "Principal Customer Platform Reliability and Distributed Systems Operations Engineering Management Strategy Director";
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
    patch: {
      role_buckets: [{ name: "Platform leadership", titles: [title] }],
      fit_bands: { fit_floor: 0 },
    },
  });
  saveSearchPrompts({
    repoRoot,
    prompts: [{ id: "p1", text: `Find ${title} openings in New York City.` }],
  });
  const inputs = [];

  await runAiWebSearch({
    repoRoot,
    env: {},
    runSkillStream: async ({ input, onEvent }) => {
      inputs.push(input);
      emitAssistantJson(onEvent, {
        roles: [],
        queries_run: [{ prompt_id: "p1", query: "platform leadership", status: "completed" }],
      });
      return { ok: true };
    },
  });

  for (const { query } of inputs[0].search_plan.query_hints) {
    assert.ok(query.length <= 100, query);
    const clippedTitle = query.match(/^"([^"]+)"$/)?.[1];
    assert.ok(clippedTitle, query);
    assert.notEqual(clippedTitle, title);
    assert.equal(title.startsWith(`${clippedTitle} `), true, query);
  }
});

test("runAiWebSearch partitions an unsplittable pair into one whole title per hint", async () => {
  const repoRoot = repo({ prompts: 1 });
  const titles = [
    "Principal Platform Reliability and Distributed Systems Operations Program Manager",
    "Principal Infrastructure Reliability and Distributed Systems Operations Program Manager",
  ];
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
    patch: {
      role_buckets: [{ name: "Platform leadership", titles }],
      fit_bands: { fit_floor: 0 },
    },
  });
  saveSearchPrompts({
    repoRoot,
    prompts: [{ id: "p1", text: `Find ${titles.join(" and ")} openings in New York City.` }],
  });
  const inputs = [];

  await runAiWebSearch({
    repoRoot,
    env: {},
    runSkillStream: async ({ input, onEvent }) => {
      inputs.push(input);
      emitAssistantJson(onEvent, {
        roles: [],
        queries_run: [{ prompt_id: "p1", query: "platform leadership", status: "completed" }],
      });
      return { ok: true };
    },
  });

  const hints = inputs[0].search_plan.query_hints;
  for (const { query } of hints) {
    assert.ok(query.length <= 100, query);
    assert.equal((query.match(/"/g) || []).length % 2, 0, query);
    assert.equal((query.match(/\(/g) || []).length, (query.match(/\)/g) || []).length, query);
  }
  for (const title of titles) {
    assert.equal(
      hints.filter(({ query }) => query.includes(`"${title}"`)).length,
      1,
      `${title}: ${JSON.stringify(hints)}`
    );
  }
});

test("runAiWebSearch gives every three-way split title an open-web query before source hints", async () => {
  const repoRoot = repo({ prompts: 1 });
  const titles = [
    "Developer Infrastructure Engineer",
    "Developer Experience Engineer",
    "Site Reliability Engineering Manager",
  ];
  candidateConfigPatch({
    repoRoot,
    name: "profile",
    patch: {
      location: {
        home: "New York, NY",
        remote: true,
        remote_scope: "home-country",
        hybrid: true,
        onsite: false,
        relocation: [],
      },
    },
  });
  candidateConfigPatch({
    repoRoot,
    name: "targeting",
    patch: {
      role_buckets: [{ name: "Developer infrastructure", titles }],
      fit_bands: { fit_floor: 0 },
    },
  });
  saveSearchPrompts({
    repoRoot,
    prompts: [
      {
        id: "p1",
        text: `Find ${titles.join(", ")} roles that are remote in the United States.`,
      },
    ],
  });
  sourceConfigPut({
    repoRoot,
    name: "search-sources",
    data: {
      searches: [
        {
          provider: "hiringcafe",
          source_type: "browser",
          label: titles.join(" and "),
          url: "https://hiring.cafe/?searchState=developer-infrastructure",
          enabled: true,
        },
      ],
    },
  });
  const plans = [];

  await runAiWebSearch({
    repoRoot,
    env: {},
    runSkillStream: async ({ input, onEvent }) => {
      plans.push(
        typeof input === "string"
          ? JSON.parse(input.split("\n\n", 1)[0]).search_plan
          : input.search_plan
      );
      emitAssistantJson(onEvent, {
        roles: [],
        queries_run: [{ prompt_id: "p1", query: "developer infrastructure", status: "completed" }],
      });
      return { ok: true };
    },
  });

  const [plan] = plans;
  assert.equal(plan.query_hints.length, 4);
  for (const title of titles) {
    assert.ok(
      plan.query_hints.some(
        ({ query }) => query.includes(`"${title}"`) && !/\b(?:site:|careers)\b/i.test(query)
      ),
      `${title} needs one open-web query: ${JSON.stringify(plan.query_hints)}`
    );
  }
  assert.ok(
    plans
      .slice(1)
      .some(({ query_hints: hints }) =>
        hints.some(({ query }) => query.includes("site:hiring.cafe"))
      ),
    `configured-first top-up lost its source: ${JSON.stringify(plans)}`
  );
});

test("runAiWebSearch keeps a configured core title in query hints beside longer siblings", async () => {
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
    patch: {
      role_buckets: [
        {
          name: "Bar leadership",
          titles: ["Bar Manager", "Assistant Bar Manager", "Senior Bar Manager"],
        },
      ],
      fit_bands: { fit_floor: 0 },
    },
  });
  saveSearchPrompts({
    repoRoot,
    prompts: [
      {
        id: "p1",
        text: "Find Bar Manager, Assistant Bar Manager, and Senior Bar Manager jobs in NYC",
      },
    ],
  });
  const inputs = [];

  await runAiWebSearch({
    repoRoot,
    env: {},
    runSkillStream: async ({ input, onEvent }) => {
      inputs.push(input);
      emitAssistantJson(onEvent, {
        roles: [1, 2, 3].map((index) =>
          role({
            company: `Bar Group ${index}`,
            title: "Bar Manager",
            location: "New York, NY",
            url: `https://bar-group-${index}.example/jobs/bar-manager`,
          })
        ),
        queries_run: [{ prompt_id: "p1", query: "bar manager jobs", status: "completed" }],
      });
      return { ok: true };
    },
    resolveJobUrlImpl: canonicalResolver({
      title: "Bar Manager",
      location: "New York, NY",
      liveness: { result: "active", reason: "visible apply control" },
    }),
  });

  const quotedTerms = inputs[0].search_plan.query_hints.flatMap(
    ({ query }) => query.match(/"[^"]+"/g) || []
  );
  assert.ok(quotedTerms.includes('"Bar Manager"'), JSON.stringify(inputs[0].search_plan));
});

test("runAiWebSearch does not broaden one explicitly named longer title to its generic parent", async () => {
  const repoRoot = repo({ prompts: 1 });
  candidateConfigPatch({
    repoRoot,
    name: "targeting",
    patch: {
      role_buckets: [
        {
          name: "Bar leadership",
          titles: ["Bar Manager", "Assistant Bar Manager"],
        },
      ],
      fit_bands: { fit_floor: 0 },
    },
  });
  saveSearchPrompts({
    repoRoot,
    prompts: [{ id: "p1", text: "Find Assistant Bar Manager jobs in New York City" }],
  });
  const inputs = [];

  await runAiWebSearch({
    repoRoot,
    env: {},
    runSkillStream: async ({ input, onEvent }) => {
      inputs.push(input);
      emitAssistantJson(onEvent, {
        roles: [1, 2, 3].map((index) =>
          role({
            company: `Assistant Bar Group ${index}`,
            title: "Assistant Bar Manager",
            url: `https://assistant-bar-${index}.example/jobs/assistant-bar-manager`,
          })
        ),
        queries_run: [{ prompt_id: "p1", query: "assistant bar manager", status: "completed" }],
      });
      return { ok: true };
    },
    resolveJobUrlImpl: canonicalResolver(),
  });

  const quotedTerms = inputs[0].search_plan.query_hints.flatMap(
    ({ query }) => query.match(/"[^"]+"/g) || []
  );
  assert.ok(quotedTerms.includes('"Assistant Bar Manager"'));
  assert.ok(!quotedTerms.includes('"Bar Manager"'), JSON.stringify(inputs[0].search_plan));
});

test("runAiWebSearch keeps every explicitly named overlapping title in useful-set top-ups", async () => {
  const repoRoot = repo({ prompts: 1 });
  candidateConfigPatch({
    repoRoot,
    name: "targeting",
    patch: {
      role_buckets: [
        {
          name: "Bar leadership",
          titles: ["Bar Manager", "Assistant Bar Manager"],
        },
      ],
      fit_bands: { fit_floor: 0 },
    },
  });
  saveSearchPrompts({
    repoRoot,
    prompts: [
      {
        id: "p1",
        text: "Find Bar Manager and Assistant Bar Manager jobs in New York City",
      },
    ],
  });
  const inputs = [];

  await runAiWebSearch({
    repoRoot,
    env: {},
    runSkillStream: async ({ input, onEvent }) => {
      inputs.push(input);
      const kickoff = typeof input === "string" ? JSON.parse(input.split("\n\n", 1)[0]) : input;
      const topUp = typeof input === "string";
      emitAssistantJson(onEvent, {
        roles: topUp
          ? [
              role({
                company: "Bar Manager Group",
                title: "Bar Manager",
                url: "https://bar-manager.example/jobs/bar-manager",
              }),
            ]
          : [1, 2, 3].map((index) =>
              role({
                company: `Assistant Group ${index}`,
                title: "Assistant Bar Manager",
                url: `https://assistant-group-${index}.example/jobs/assistant-bar-manager`,
              })
            ),
        queries_run: [
          {
            prompt_id: kickoff.prompts[0].id,
            query: topUp ? "bar manager top-up" : "assistant bar manager",
            status: "completed",
          },
        ],
      });
      return { ok: true };
    },
    resolveJobUrlImpl: canonicalResolver(),
  });

  assert.equal(inputs.length, 2);
  const topUpPlan = JSON.parse(inputs[1].split("\n\n", 1)[0]).search_plan;
  assert.deepEqual(topUpPlan.focus.missing_target_titles, ["Bar Manager"]);
});

test("runAiWebSearch does not add remote when a hospitality prompt does not request it", async () => {
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
      role_buckets: [{ name: "Bar leadership", titles: ["Bar Manager"] }],
      fit_bands: { fit_floor: 0 },
    },
  });
  saveSearchPrompts({
    repoRoot,
    prompts: [
      {
        id: "p1",
        text: "Find Bar Manager jobs in New York City. Exclude local roles outside New York City.",
      },
    ],
  });
  const inputs = [];

  await runAiWebSearch({
    repoRoot,
    env: {},
    runSkillStream: async ({ input, onEvent }) => {
      inputs.push(input);
      emitAssistantJson(onEvent, {
        roles: [1, 2, 3].map((index) =>
          role({
            company: `NYC Bar Group ${index}`,
            title: "Bar Manager",
            location: "New York, NY",
            url: `https://nyc-bar-${index}.example/jobs/bar-manager`,
          })
        ),
        queries_run: [{ prompt_id: "p1", query: "NYC bar manager jobs", status: "completed" }],
      });
      return { ok: true };
    },
    resolveJobUrlImpl: canonicalResolver({
      title: "Bar Manager",
      location: "New York, NY",
      liveness: { result: "active", reason: "visible apply control" },
    }),
  });

  assert.ok(
    inputs[0].search_plan.query_hints.every(({ query }) => !/\bremote\b/i.test(query)),
    JSON.stringify(inputs[0].search_plan)
  );
});

test("runAiWebSearch does not treat negated remote wording as a remote search request", async () => {
  const repoRoot = repo({ mode: "full", prompts: 5 });
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
      role_buckets: [{ name: "Platform engineering", titles: ["Platform Engineer"] }],
      fit_bands: { fit_floor: 0 },
    },
  });
  saveSearchPrompts({
    repoRoot,
    prompts: [
      { id: "exclude", text: "Find Platform Engineer jobs in NYC; exclude remote roles" },
      { id: "no", text: "Find Platform Engineer jobs in NYC; no remote roles" },
      { id: "not", text: "Find Platform Engineer jobs in NYC, not remote" },
      { id: "excluded", text: "Find Platform Engineer jobs in NYC; remote roles excluded" },
      {
        id: "relative-negation",
        text: "Find Platform Engineer jobs in NYC; exclude all jobs that are remote",
      },
    ],
  });
  const plans = new Map();

  await runAiWebSearch({
    repoRoot,
    env: {},
    runSkillStream: async ({ input, onEvent }) => {
      const kickoff = typeof input === "string" ? JSON.parse(input.split("\n\n", 1)[0]) : input;
      const promptId = kickoff.prompts[0].id;
      plans.set(promptId, kickoff.search_plan);
      emitAssistantJson(onEvent, {
        roles: [1, 2, 3].map((index) =>
          role({
            company: `${promptId} Platform ${index}`,
            title: "Platform Engineer",
            location: "New York, NY",
            url: `https://${promptId}-${index}.example/jobs/platform-engineer`,
          })
        ),
        queries_run: [{ prompt_id: promptId, query: `${promptId} platform`, status: "completed" }],
      });
      return { ok: true };
    },
    resolveJobUrlImpl: canonicalResolver(),
  });

  for (const promptId of ["exclude", "no", "not", "excluded", "relative-negation"]) {
    assert.ok(
      plans.get(promptId).query_hints.every(({ query }) => !/\bremote\b/i.test(query)),
      JSON.stringify(plans.get(promptId))
    );
  }
});

test("runAiWebSearch treats relational do-not-include remote wording as local-only", async () => {
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
      role_buckets: [{ name: "Platform engineering", titles: ["Platform Engineer"] }],
      fit_bands: { fit_floor: 0 },
    },
  });
  const prompt = "Find Platform Engineer jobs in NYC; do not include jobs that are remote";
  saveSearchPrompts({ repoRoot, prompts: [{ id: "p1", text: prompt }] });
  let plan = null;

  await runAiWebSearch({
    repoRoot,
    env: {},
    runSkillStream: async ({ input, onEvent }) => {
      const kickoff = typeof input === "string" ? JSON.parse(input.split("\n\n", 1)[0]) : input;
      plan ??= kickoff.search_plan;
      emitAssistantJson(onEvent, {
        roles: [1, 2, 3].map((index) =>
          role({
            company: `Local Platform ${index}`,
            title: "Platform Engineer",
            location: "New York, NY",
            url: `https://local-${index}.example/jobs/platform-engineer`,
          })
        ),
        queries_run: [{ prompt_id: "p1", query: prompt, status: "completed" }],
      });
      return { ok: true };
    },
    resolveJobUrlImpl: canonicalResolver(),
  });

  assert.ok(
    plan.query_hints.every(({ query }) => !/\bremote\b/i.test(query)),
    JSON.stringify(plan)
  );
});

for (const { label, prompt } of [
  {
    label: "exclude remote roles outside the US",
    prompt: "Find remote Platform Engineer roles in the US; exclude remote roles outside the US",
  },
  {
    label: "do not include remote roles outside the US",
    prompt:
      "Find remote Platform Engineer roles in the US; do not include remote roles outside the US",
  },
  {
    label: "exclude roles outside the US in one clause",
    prompt: "Find remote Platform Engineer roles in the US, exclude roles outside the US",
  },
]) {
  test(`runAiWebSearch preserves US remote intent when told to ${label}`, async () => {
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
        role_buckets: [{ name: "Platform engineering", titles: ["Platform Engineer"] }],
        fit_bands: { fit_floor: 0 },
      },
    });
    saveSearchPrompts({ repoRoot, prompts: [{ id: "p1", text: prompt }] });
    let initialSearchPlan = null;

    await runAiWebSearch({
      repoRoot,
      env: {},
      runSkillStream: async ({ input, onEvent }) => {
        const kickoff = typeof input === "string" ? JSON.parse(input.split("\n\n", 1)[0]) : input;
        initialSearchPlan ??= kickoff.search_plan;
        emitAssistantJson(onEvent, {
          roles: [1, 2, 3].map((index) =>
            role({
              company: `${label} Platform ${index}`,
              title: "Platform Engineer",
              location: "Remote, United States",
              url: `https://mixed-remote-${index}.example/jobs/platform-engineer`,
            })
          ),
          queries_run: [{ prompt_id: "p1", query: prompt, status: "completed" }],
        });
        return { ok: true };
      },
      resolveJobUrlImpl: canonicalResolver({
        title: "Platform Engineer",
        location: "Remote, United States",
        liveness: { result: "active", reason: "visible apply control" },
      }),
    });

    assert.equal(initialSearchPlan.query_hints.length, 2);
    for (const { query } of initialSearchPlan.query_hints) {
      assert.match(query, /"Platform Engineer"/);
      assert.match(query, /\bremote\b/i);
      assert.match(query, /\b(?:US|United States)\b/i);
    }
  });
}

test("runAiWebSearch retains remote when an event prompt explicitly requests it", async () => {
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
      role_buckets: [{ name: "Event operations", titles: ["Event Operations Manager"] }],
      fit_bands: { fit_floor: 0 },
    },
  });
  saveSearchPrompts({
    repoRoot,
    prompts: [
      {
        id: "p1",
        text: "Find Event Operations Manager jobs in New York City or remote in the US",
      },
    ],
  });
  const inputs = [];

  await runAiWebSearch({
    repoRoot,
    env: {},
    runSkillStream: async ({ input, onEvent }) => {
      inputs.push(input);
      emitAssistantJson(onEvent, {
        roles: [1, 2, 3].map((index) =>
          role({
            company: `Event Group ${index}`,
            title: "Event Operations Manager",
            location: "Remote, US",
            url: `https://event-group-${index}.example/jobs/event-operations-manager`,
          })
        ),
        queries_run: [{ prompt_id: "p1", query: "event operations jobs", status: "completed" }],
      });
      return { ok: true };
    },
    resolveJobUrlImpl: canonicalResolver({
      title: "Event Operations Manager",
      location: "Remote, US",
      liveness: { result: "active", reason: "visible apply control" },
    }),
  });

  assert.ok(
    inputs[0].search_plan.query_hints.some(({ query }) => /\bremote\b/i.test(query)),
    JSON.stringify(inputs[0].search_plan)
  );
});

test("runAiWebSearch does not add global remote to a hybrid engineering prompt", async () => {
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
      role_buckets: [{ name: "Platform engineering", titles: ["Platform Engineer"] }],
      fit_bands: { fit_floor: 0 },
    },
  });
  saveSearchPrompts({
    repoRoot,
    prompts: [{ id: "p1", text: "Find hybrid Platform Engineer jobs in New York City" }],
  });
  const inputs = [];

  await runAiWebSearch({
    repoRoot,
    env: {},
    runSkillStream: async ({ input, onEvent }) => {
      inputs.push(input);
      emitAssistantJson(onEvent, {
        roles: [1, 2, 3].map((index) =>
          role({
            company: `Platform Group ${index}`,
            title: "Platform Engineer",
            location: "New York, NY",
            url: `https://platform-group-${index}.example/jobs/platform-engineer`,
          })
        ),
        queries_run: [{ prompt_id: "p1", query: "hybrid platform jobs", status: "completed" }],
      });
      return { ok: true };
    },
    resolveJobUrlImpl: canonicalResolver({
      title: "Platform Engineer",
      location: "New York, NY",
      liveness: { result: "active", reason: "visible apply control" },
    }),
  });

  assert.ok(
    inputs[0].search_plan.query_hints.every(({ query }) => !/\bremote\b/i.test(query)),
    JSON.stringify(inputs[0].search_plan)
  );
});

test("runAiWebSearch gives freshness recovery a query plan informed by rejected sources", async () => {
  const repoRoot = repo({ prompts: 1 });
  candidateConfigPatch({
    repoRoot,
    name: "targeting",
    patch: {
      role_buckets: [{ name: "Bar leadership", titles: ["Bar Manager"] }],
      fit_bands: { fit_floor: 0 },
    },
  });
  saveSearchPrompts({
    repoRoot,
    prompts: [{ id: "p1", text: "Find Bar Manager jobs in New York City" }],
  });
  const rejectedHost = "stale-board.example";
  const rejectedUrl = `https://${rejectedHost}/jobs/bar-manager-expired`;
  const inputs = [];

  await runAiWebSearch({
    repoRoot,
    env: {},
    runSkillStream: async ({ input, onEvent }) => {
      inputs.push(input);
      const kickoff = typeof input === "string" ? JSON.parse(input.split("\n\n", 1)[0]) : input;
      emitAssistantJson(onEvent, {
        roles:
          inputs.length === 1
            ? [role({ company: "Stale Bar", title: "Bar Manager", url: rejectedUrl })]
            : [1, 2, 3].map((index) =>
                role({
                  company: `Fresh Bar ${index}`,
                  title: "Bar Manager",
                  url: `https://fresh-bar-${index}.example/jobs/bar-manager`,
                })
              ),
        queries_run: [
          { prompt_id: kickoff.prompts[0].id, query: `bar manager query ${inputs.length}` },
        ],
      });
      return { ok: true };
    },
    resolveJobUrlImpl: async (url) =>
      url === rejectedUrl
        ? specificResolution(url, {
            title: "Bar Manager",
            bodyText: fullJd("Expired bar manager posting"),
            liveness: { result: "expired", reason: "The posting is no longer available." },
          })
        : specificResolution(url, {
            title: "Bar Manager",
            bodyText: fullJd("Active bar manager posting"),
            liveness: { result: "active", reason: "visible apply control" },
          }),
  });

  const initialPlan = inputs[0].search_plan;
  const recoveryPlan = JSON.parse(inputs[1].split("\n\n", 1)[0]).search_plan;
  assert.notDeepEqual(recoveryPlan, initialPlan);
  assert.match(JSON.stringify(recoveryPlan), /stale-board\.example/);
  assert.match(JSON.stringify(recoveryPlan), /bar-manager-expired/);
});

test("runAiWebSearch gives useful-set top-up a query plan focused on missing titles", async () => {
  const repoRoot = repo({ prompts: 1 });
  candidateConfigPatch({
    repoRoot,
    name: "targeting",
    patch: {
      role_buckets: [{ name: "Bar leadership", titles: ["Bar Manager", "Head Bartender"] }],
      fit_bands: { fit_floor: 0 },
    },
  });
  saveSearchPrompts({
    repoRoot,
    prompts: [{ id: "p1", text: "Find Bar Manager and Head Bartender jobs in New York City" }],
  });
  const inputs = [];

  await runAiWebSearch({
    repoRoot,
    env: {},
    runSkillStream: async ({ input, onEvent }) => {
      inputs.push(input);
      const kickoff = typeof input === "string" ? JSON.parse(input.split("\n\n", 1)[0]) : input;
      emitAssistantJson(onEvent, {
        roles:
          inputs.length === 1
            ? [
                role({
                  company: "Initial Bar",
                  title: "Bar Manager",
                  url: "https://initial-bar.example/jobs/bar-manager",
                }),
              ]
            : [
                role({
                  company: "Fresh Head One",
                  title: "Head Bartender",
                  url: "https://fresh-head-one.example/jobs/head-bartender",
                }),
                role({
                  company: "Fresh Head Two",
                  title: "Head Bartender",
                  url: "https://fresh-head-two.example/jobs/head-bartender",
                }),
              ],
        queries_run: [
          { prompt_id: kickoff.prompts[0].id, query: `bar leadership query ${inputs.length}` },
        ],
      });
      return { ok: true };
    },
    resolveJobUrlImpl: canonicalResolver({
      liveness: { result: "active", reason: "visible apply control" },
    }),
  });

  const initialPlan = inputs[0].search_plan;
  const topUpPlan = JSON.parse(inputs[1].split("\n\n", 1)[0]).search_plan;
  assert.notDeepEqual(topUpPlan, initialPlan);
  assert.match(JSON.stringify(topUpPlan), /Head Bartender/);
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

test("runAiWebSearch rejects a readable custom careers location page after hydration", async () => {
  const repoRoot = repo({ prompts: 1 });
  const url = "https://careers.example.test/new-york";
  const resolveOptions = [];
  let searchCalls = 0;
  const result = await runAiWebSearch({
    repoRoot,
    env: {},
    runSkillStream: async ({ onEvent }) => {
      searchCalls += 1;
      emitAssistantJson(onEvent, {
        roles:
          searchCalls === 1
            ? [
                role({
                  company: "Example Hospitality",
                  title: "Bartender",
                  url,
                  body_text: "The search result claims one active bartender opening.",
                }),
              ]
            : [],
        queries_run: [
          {
            prompt_id: "p1",
            query: `New York hospitality jobs ${searchCalls}`,
            status: "completed",
          },
        ],
      });
      return { ok: true };
    },
    resolveJobUrlImpl: async (requestedUrl, options) => {
      resolveOptions.push(options);
      return {
        bodyFetchStatus: "resolved",
        url: requestedUrl,
        bodyText: fullJd("New York careers with Bartender, Server, and General Manager choices"),
        postingEvidence: {
          pageTitle: "New York careers",
          headings: ["New York"],
          structuredPostingCount: 0,
          canonicalPostingUrls: [],
        },
      };
    },
  });

  assert.equal(resolveOptions[0]?.requirePostingIdentity, true);
  assert.equal(result.found, 1);
  assert.equal(result.invalid, 0);
  assert.equal(result.unreadable, 1);
  assert.equal(result.new, 0);
  assert.match(result.captureFailures[0].reason, /one specific job posting/i);
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
    "https://example.test/search?job_id=anything",
    "https://example.test/search-results?job_id=anything",
    "https://careers.example.test/careers?gh_jid=123456",
    "https://example.test/jobs?jk=anything",
  ]) {
    assert.equal(isPostingEvidenceUrl(url), false, url);
  }
});

test("AI web search rejects private and link-local evidence URLs before hydration", async () => {
  for (const url of [
    "http://localhost/jobs/1",
    "http://127.0.0.1/jobs/1",
    "http://169.254.169.254/latest/meta-data",
    "http://[::1]/jobs/1",
    "http://[fc00::1]/jobs/1",
  ]) {
    assert.equal(isPostingEvidenceUrl(url), false, url);
  }

  const repoRoot = repo({ prompts: 1 });
  let hydrated = 0;
  const result = await runAiWebSearch({
    repoRoot,
    env: {},
    runSkillStream: assistantJson({
      roles: [role({ url: "http://169.254.169.254/latest/meta-data" })],
      queries_run: [{ prompt_id: "p1", query: "private target", status: "completed" }],
    }),
    resolveJobUrlImpl: async () => {
      hydrated += 1;
      return canonicalResolver()();
    },
  });

  assert.equal(hydrated, 0);
  assert.equal(result.invalid, 1);
  assert.equal(result.new, 0);
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

  let calls = 0;
  const zeroResult = assistantJson({ roles: [], queries_run: [] });
  const result = await runAiWebSearch({
    repoRoot,
    env: {},
    runSkillStream: async (options) => {
      calls += 1;
      return zeroResult(options);
    },
  });

  assert.equal(calls, 1, "a canonical zero-result response is complete, not transient");
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

for (const transient of [
  {
    label: "candidate-safe unavailable result",
    respond: async () => ({
      ok: false,
      error: "Search response was unavailable in the authorized runtime.",
    }),
  },
  {
    label: "successful runtime turn with no assistant response",
    respond: async () => ({ ok: true }),
  },
  {
    label: "candidate-safe unavailable assistant response",
    respond: async ({ onEvent }) => {
      onEvent({
        type: "assistant",
        data: {
          message: {
            content: [
              { type: "text", text: "Search response was unavailable in the authorized runtime." },
            ],
          },
        },
      });
      return { ok: true };
    },
  },
]) {
  test(`runAiWebSearch retries one transient ${transient.label} on the frozen execution plan`, async () => {
    const repoRoot = repo({ prompts: 1 });
    candidateConfigPatch({
      repoRoot,
      name: "targeting",
      patch: {
        role_buckets: [{ name: "Applied AI", titles: ["Applied AI Engineer"] }],
        fit_bands: { fit_floor: 0 },
      },
    });
    saveSearchPrompts({
      repoRoot,
      prompts: [{ id: "p1", text: "Find Applied AI Engineer jobs" }],
    });
    const executionPlan = Object.freeze({
      operation: "research.web",
      runtimeId: "codex",
      resolved: Object.freeze({ model: "gpt-5.6-terra", effort: "medium" }),
    });
    const invocations = [];
    const result = await runAiWebSearch({
      repoRoot,
      env: {},
      executionPlan,
      runSkillStream: async (options) => {
        invocations.push(options);
        if (invocations.length === 1) return transient.respond(options);
        emitAssistantJson(options.onEvent, {
          roles: [
            role(),
            role({ company: "Beta AI", url: "https://jobs.lever.co/beta/req-2" }),
            role({ company: "Gamma AI", url: "https://jobs.lever.co/gamma/req-3" }),
          ],
          queries_run: [{ prompt_id: "p1", query: "applied AI jobs", status: "completed" }],
        });
        return { ok: true };
      },
      resolveJobUrlImpl: canonicalResolver(),
    });

    assert.equal(invocations.length, 2);
    assert.deepEqual(
      invocations.map((invocation) => invocation.executionPlan),
      [executionPlan, executionPlan]
    );
    assert.deepEqual(
      invocations.map((invocation) => invocation.input),
      [invocations[0].input, invocations[0].input]
    );
    assert.deepEqual(
      invocations.map((invocation) => invocation.useExecutionPlanRoute),
      [true, true]
    );
    assert.deepEqual(result.errors, []);
    assert.equal(result.new, 3, JSON.stringify(result));
  });
}

test("runAiWebSearch stops after one retry when the authorized runtime stays transiently unavailable", async () => {
  const repoRoot = repo({ prompts: 1 });
  let calls = 0;
  const result = await runAiWebSearch({
    repoRoot,
    env: {},
    runSkillStream: async () => {
      calls += 1;
      return {
        ok: false,
        error: "Search response was unavailable in the authorized runtime.",
      };
    },
  });

  assert.equal(calls, 2);
  assert.deepEqual(result.failedPromptIds, ["p1"]);
  assert.deepEqual(result.errors, ["AI search couldn't finish. Try it again."]);
});

test("runAiWebSearch discards a response-less attempt's tool trace before its one retry", async () => {
  const repoRoot = repo({ prompts: 1 });
  candidateConfigPatch({
    repoRoot,
    name: "targeting",
    patch: {
      role_buckets: [{ name: "Applied AI", titles: ["Applied AI Engineer"] }],
      fit_bands: { fit_floor: 0 },
    },
  });
  saveSearchPrompts({
    repoRoot,
    prompts: [{ id: "p1", text: "Find Applied AI Engineer jobs" }],
  });
  const abandonedUrl = "https://jobs.example.test/abandoned-attempt";
  const acceptedUrl = "https://jobs.example.test/accepted-attempt";
  let calls = 0;
  const result = await runAiWebSearch({
    repoRoot,
    env: {},
    runSkillStream: async ({ onEvent }) => {
      calls += 1;
      assert.ok(calls <= 2, "the transient replay must not fall through to a schema correction");
      if (calls === 1) {
        onEvent({
          type: "tool_use",
          data: { id: "old-search", name: "WebSearch", input: { query: "abandoned query" } },
        });
        onEvent({
          type: "tool_result",
          data: { toolUseId: "old-search", content: "Search failed", isError: true },
        });
        onEvent({
          type: "tool_use",
          data: { id: "old-fetch", name: "WebFetch", input: { url: abandonedUrl } },
        });
        onEvent({
          type: "tool_result",
          data: { toolUseId: "old-fetch", content: "Fetched", isError: false },
        });
        return {
          ok: false,
          error: "Search response was unavailable in the authorized runtime.",
        };
      }
      onEvent({
        type: "tool_use",
        data: { id: "new-search", name: "WebSearch", input: { query: "applied AI jobs" } },
      });
      onEvent({
        type: "tool_result",
        data: { toolUseId: "new-search", content: "Search completed", isError: false },
      });
      onEvent({
        type: "tool_use",
        data: { id: "new-fetch", name: "WebFetch", input: { url: acceptedUrl } },
      });
      onEvent({
        type: "tool_result",
        data: { toolUseId: "new-fetch", content: "Fetched", isError: false },
      });
      emitAssistantJson(onEvent, {
        roles: [
          role({ url: acceptedUrl }),
          role({ company: "Beta AI", url: "https://jobs.example.test/beta" }),
          role({ company: "Gamma AI", url: "https://jobs.example.test/gamma" }),
        ],
        queries_run: [{ prompt_id: "p1", query: "applied AI jobs", status: "completed" }],
      });
      return { ok: true };
    },
    resolveJobUrlImpl: canonicalResolver(),
  });

  assert.equal(calls, 2);
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.queryResults[0].queries, [
    { query: "applied AI jobs", status: "completed", error: null },
  ]);
  assert.equal(
    result.sources.some((source) => source.url === abandonedUrl),
    false
  );
  assert.equal(
    result.sources.some((source) => source.url === acceptedUrl),
    true
  );
  assert.deepEqual(result.fetchedPostingDecisions, []);
});

test("runAiWebSearch explains a selected-provider usage cap without exposing runtime text", async () => {
  const repoRoot = repo({ prompts: 1 });
  let calls = 0;
  const result = await runAiWebSearch({
    repoRoot,
    env: {},
    runSkillStream: async () => {
      calls += 1;
      return {
        ok: false,
        code: "RUNTIME_USAGE_LIMIT",
        error:
          "Claude Code has reached its usage limit. It resets at 4pm (America/New_York). " +
          "raw CLI schema secret",
      };
    },
  });

  assert.equal(calls, 1);
  assert.deepEqual(result.errors, [
    "The selected AI provider has reached its usage limit. It resets at 4pm (America/New_York). Try again after the reset.",
  ]);
  assert.deepEqual(result.failedPromptIds, ["p1"]);
  assert.doesNotMatch(result.errors[0], /Claude|CLI|schema|secret|RUNTIME_/i);
});

for (const failure of [
  {
    label: "authentication error",
    result: { ok: false, code: "RUNTIME_AUTH_REQUIRED", error: "Sign in first." },
  },
  {
    label: "runtime cancellation",
    result: { ok: false, aborted: true, code: "RUNTIME_CANCELLED", error: "Cancelled." },
  },
]) {
  test(`runAiWebSearch does not replay a ${failure.label}`, async () => {
    const repoRoot = repo({ prompts: 1 });
    let calls = 0;
    const result = await runAiWebSearch({
      repoRoot,
      env: {},
      runSkillStream: async () => {
        calls += 1;
        return failure.result;
      },
    });

    assert.equal(calls, 1);
    assert.deepEqual(result.failedPromptIds, ["p1"]);
  });
}

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

  assert.deepEqual(Object.fromEntries(callCount), { p1: 3, p2: 1, p3: 2 });
  assert.deepEqual(receivedPromptIds.slice().sort(), ["p1", "p1", "p1", "p2", "p3", "p3"]);
  assert.equal(maxActive, 2);
  assert.equal(result.found, 5);
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
  assert.match(skill, /at most 4 `WebSearch` calls per saved prompt/i);
  assert.match(skill, /at most 8 job-posting `WebFetch` calls per saved prompt/i);
  assert.match(skill, /`search_plan`.*authoritative/i);
  assert.match(skill, /failed.*(?:search|fetch).*(?:counts|consumes).*(?:budget|limit)/i);
  assert.match(skill, /stop immediately.*(?:budget|limit).*return/i);
  assert.match(skill, /query_hints.*(?:in order|exactly)/i);
  assert.match(skill, /never emit an aggregator search\/results page/i);
  assert.match(skill, /employer-owned career|employer career/i);
  assert.match(skill, /source_hints.*(?:never|do not).*(?:another|extra).*(?:query|search)/i);
  assert.match(skill, /at least two (?:different )?(?:source )?hosts/i);
  assert.match(skill, /no more than one candidate from the same third-party host/i);
  assert.match(skill, /do not stop after (?:the )?first (?:viable )?(?:lead|match)/i);
  assert.match(skill, /every successfully fetched posting-specific URL.*accounted/i);
  assert.match(skill, /roles\[\].*rejected_postings\[\]/i);
  assert.match(skill, /never silently drop a fetched exact posting/i);
  assert.match(skill, /rejected_postings\[\].*eight-fetch turn limit/i);
  assert.match(skill, /correction.*do not run WebSearch, WebFetch, or any other tool/i);
});

test("AI web-search skill preserves only posting-specific blocked leads as unverified partials", () => {
  const skill = readFileSync(
    new URL("../.agents/skills/search-jobs/SKILL.md", import.meta.url),
    "utf8"
  );
  assert.match(skill, /posting-specific.*(?:browser-blocked|browser session)/i);
  assert.match(skill, /body_text.*null.*body_partial.*true/i);
  assert.match(skill, /explicitly unverified partial/i);
  assert.match(skill, /generic.*(?:search|category|career-hub).*(?:drop|reject)/i);
  assert.match(skill, /expired.*redirect.*(?:drop|reject)/i);
  assert.match(skill, /unsafe|private URL/i);
  assert.match(skill, /mismatched|different (?:job|requisition|posting)/i);
});

test("search-jobs prepares missing sources in the same request and keeps disabled login sources actionable", () => {
  const skill = readFileSync(
    new URL("../.agents/skills/search-jobs/SKILL.md", import.meta.url),
    "utf8"
  );
  const prose = skill.replace(/\s+/g, " ");
  assert.doesNotMatch(prose, /no enabled entries, stop and run `setup-searches` first/i);
  assert.match(prose, /run `setup-searches` as part of the same request/i);
  assert.match(prose, /disabled login-backed source.*contextual.*Yes\/No/i);
});

test("runAiWebSearch preserves posting-specific blocked third-party URLs as unverified partials", async () => {
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
  const blockedRoles = [
    role({
      company: "LinkedIn Hospitality",
      title: "Bar Manager",
      location: "New York, NY",
      url: "https://www.linkedin.com/jobs/view/bar-manager-5186736008",
      body_text: null,
      body_partial: true,
    }),
    role({
      company: "Indeed Hospitality",
      title: "Assistant General Manager",
      location: "New York, NY",
      url: "https://www.indeed.com/viewjob?jk=abc123",
      body_text: null,
      body_partial: true,
    }),
    role({
      company: "Glassdoor Hospitality",
      title: "Venue Operations Manager",
      location: "New York, NY",
      url: "https://www.glassdoor.com/job-listing/venue-operations-manager-acme-JV_IC1132348_KO0,24_KE25,29.htm?jl=123",
      body_text: null,
      body_partial: true,
    }),
  ];
  let calls = 0;
  const result = await runAiWebSearch({
    repoRoot,
    env: {},
    runSkillStream: async ({ input, onEvent }) => {
      calls += 1;
      const kickoff = typeof input === "string" ? JSON.parse(input.split("\n\n", 1)[0]) : input;
      emitAssistantJson(onEvent, {
        roles: calls === 1 ? blockedRoles : [],
        queries_run: [
          {
            prompt_id: kickoff.prompts[0].id,
            query: `posting-specific blocked roles ${calls}`,
            status: "completed",
          },
        ],
      });
      return { ok: true };
    },
    resolveJobUrlImpl: async (url) => ({
      bodyFetchStatus: "deferred",
      url,
      bodyText: "",
      bodyPartial: true,
      bodyFetchReason: "The exact posting requires a browser session.",
    }),
  });

  assert.equal(result.new, 3, JSON.stringify(result));
  assert.equal(result.partial, 3);
  assert.equal(result.unreadable, 0);
  assert.ok(result.sources.every((source) => source.status === "deferred"));
  const saved = readDbScannerRows({ repoRoot }).filter((row) => row.source === "ai-web-search");
  assert.deepEqual(
    saved.map((row) => row.link).sort(),
    blockedRoles.map((item) => item.url).sort()
  );
  assert.ok(saved.every((row) => row.scanner?.bodyPartial === true));
  assert.ok(saved.every((row) => row.scanner?.unverified === true));
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
      return specificResolution(url, { bodyText: fullJd(`Role ${index}`) });
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
      return specificResolution(url);
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
          queries: Array(4).fill({ query: "ai jobs", status: "completed", error: null }),
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
      return specificResolution(url, {
        bodyText: fullJd("PRIVATE CANONICAL BODY MUST NOT ENTER THE RECEIPT"),
      });
    },
  });

  assert.equal(result.new, 0);
  assert.equal(result.duplicates, 1);
  assert.equal(resolutionCalls, 1);
  assert.deepEqual(result.sources, [
    { url: duplicateUrl, status: "completed", host: "jobs.lever.co" },
  ]);
  assert.deepEqual(result.canonicalOverlaps, []);
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
  assert.deepEqual(result.canonicalOverlaps, []);
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

test("runAiWebSearch saves the canonical visible title instead of a model-invented seniority", async () => {
  const repoRoot = repo({ prompts: 1 });
  candidateConfigPatch({
    repoRoot,
    name: "targeting",
    patch: {
      role_buckets: [{ name: "Engineering", titles: ["Software Engineer"] }],
      fit_bands: { fit_floor: 0 },
    },
  });
  saveSearchPrompts({
    repoRoot,
    prompts: [{ id: "p1", text: "Find Software Engineer jobs" }],
  });
  const canonicalBody = fullJd("Build and operate customer-facing software systems");
  const result = await runAiWebSearch({
    repoRoot,
    env: {},
    runSkillStream: assistantJson({
      roles: [
        role({
          company: "Example",
          title: "Senior Software Engineer",
          url: "https://careers.example.test/jobs/software-engineer",
        }),
      ],
      queries_run: [{ prompt_id: "p1", query: "software engineer jobs" }],
    }),
    resolveHost: async () => [{ address: "93.184.216.34", family: 4 }],
    fetchImpl: async () =>
      new Response(
        `<!doctype html><html><head><title>Software Engineer | Example</title></head><body><h1>Software Engineer</h1><p>${canonicalBody}</p><a href="/apply">Apply now</a></body></html>`,
        { status: 200, headers: { "content-type": "text/html" } }
      ),
  });

  assert.equal(result.new, 1, JSON.stringify(result));
  assert.equal(result.offers[0].title, "Software Engineer");
  const [saved] = readDbScannerRows({ repoRoot }).filter((row) => row.source === "ai-web-search");
  assert.equal(saved.role, "Software Engineer");
  assert.notEqual(saved.role, "Senior Software Engineer");
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
    resolveJobUrlImpl: async (url) => specificResolution(url, canonical.get(url)),
  });

  assert.equal(result.new, 0);
  assert.equal(result.disqualified, 3);
  assert.deepEqual(result.reasonCounts, { location: 2, salary: 1 });
  assert.deepEqual(result.canonicalDisqualifications, [
    {
      company: "Stealth Startup",
      title: "Founding Software Engineer",
      url: "https://jobs.example.test/stealth",
      location: "San Francisco, CA (Remote)",
      reason: "onsite-not-allowed",
    },
    {
      company: "David",
      title: "Software Engineer, AI & Internal Tools",
      url: "https://jobs.example.test/david",
      location: "New York, NY (Remote)",
      reason: "office-days-exceed-preference",
    },
    {
      company: "Credence",
      title: "AI Software Engineer",
      url: "https://jobs.example.test/credence",
      location: "Tysons Corner, VA (Remote)",
      reason: "comp-below-floor",
    },
  ]);
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

test("runAiWebSearch preserves a direct posting with browser-blocked evidence as unverified", async () => {
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
  assert.equal(saved.scanner.bodyPartial, true);
  assert.equal(saved.scanner.unverified, true);
});

test("runAiWebSearch preserves a posting-specific specialist-board lead when capture defers", async () => {
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
  assert.equal(result.offers[0].url, "https://culinaryagents.com/jobs/12345/bartender");
  assert.ok(result.sources.some((source) => source.status === "deferred"));
  assert.equal(
    readDbScannerRows({ repoRoot }).filter((row) => row.source === "ai-web-search").length,
    1
  );
});

test("runAiWebSearch keeps posting-shaped deferred leads and rejects a generic openings page", async () => {
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
      url: `https://jobs.example.test/${title.toLowerCase().replace(/[^a-z0-9]+/g, "-")}-${index + 1}`,
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

  assert.equal(result.new, 11, JSON.stringify(result));
  assert.equal(result.partial, 11);
  assert.equal(result.unreadable, 1);
  assert.equal(result.sources.length, 12);
  assert.equal(result.sources.filter((source) => source.status === "deferred").length, 11);
  assert.equal(result.sources.filter((source) => source.status === "failed").length, 1);
  assert.match(result.captureFailures[0].reason, /one specific job posting/i);
  assert.equal(
    readDbScannerRows({ repoRoot }).filter((row) => row.source === "ai-web-search").length,
    11
  );
});

test("runAiWebSearch persists base pay and annual earnings in separate fields", async () => {
  const repoRoot = repo({ prompts: 1 });
  const result = await runAiWebSearch({
    repoRoot,
    env: {},
    runSkillStream: assistantJson({
      roles: [
        role({
          company: "Tipped Bar",
          title: "Lead Bartender",
          url: "https://jobs.example.test/tipped-bar",
          base_comp_text: "$11.35 per hour",
          annual_earnings_text: "$95,000 - $120,000 including tips",
          body_text:
            "Base pay: $11.35 per hour. Estimated annual earnings including tips: $95,000 - $120,000.",
        }),
      ],
      queries_run: [{ prompt_id: "p1", query: "NYC lead bartender jobs" }],
    }),
    resolveJobUrlImpl: canonicalResolver(),
  });

  assert.equal(result.new, 1, JSON.stringify(result));
  const row = readDbScannerRows({ repoRoot }).find((item) => item.company === "Tipped Bar");
  assert.equal(row.base, "$11.35 per hour");
  assert.equal(row.tc, "$95,000 - $120,000 including tips");
  assert.equal(row.compBasis, "annual-earnings");
});

test("runAiWebSearch never copies annual earnings into base pay", async () => {
  const repoRoot = repo({ prompts: 1 });
  const result = await runAiWebSearch({
    repoRoot,
    env: {},
    runSkillStream: assistantJson({
      roles: [
        role({
          company: "Tips Only Bar",
          title: "Bartender",
          url: "https://jobs.example.test/tips-only-bar",
          comp_text: null,
          annual_earnings_text: "$85,000 - $110,000 including tips",
          body_text: "Estimated annual earnings including tips: $85,000 - $110,000.",
        }),
      ],
      queries_run: [{ prompt_id: "p1", query: "NYC bartender jobs" }],
    }),
    resolveJobUrlImpl: canonicalResolver(),
  });

  assert.equal(result.new, 1, JSON.stringify(result));
  const row = readDbScannerRows({ repoRoot }).find((item) => item.company === "Tips Only Bar");
  assert.equal(row.base, "verify");
  assert.equal(row.tc, "$85,000 - $110,000 including tips");
  assert.equal(row.compBasis, "annual-earnings");
});

test("runAiWebSearch classifies legacy generic compensation before persistence", async () => {
  const repoRoot = repo({ prompts: 1 });
  const result = await runAiWebSearch({
    repoRoot,
    env: {},
    runSkillStream: assistantJson({
      roles: [
        role({
          company: "Legacy Tips Bar",
          title: "Bartender",
          url: "https://jobs.example.test/legacy-tips-bar",
          comp_text: "$90,000 - $110,000 including tips",
          body_text: "This is a tipped hospitality role.",
        }),
      ],
      queries_run: [{ prompt_id: "p1", query: "NYC bartender jobs" }],
    }),
    resolveJobUrlImpl: canonicalResolver(),
  });

  assert.equal(result.new, 1, JSON.stringify(result));
  const row = readDbScannerRows({ repoRoot }).find((item) => item.company === "Legacy Tips Bar");
  assert.equal(row.base, "verify");
  assert.equal(row.tc, "$90,000 - $110,000 including tips");
  assert.equal(row.compBasis, "annual-earnings");
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
    resolveJobUrlImpl: canonicalResolver({ location: "New York, NY" }),
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
      providerExactMatch: true,
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
      providerExactMatch: true,
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
  const recoveryKickoff = JSON.parse(inputs[1].split("\n\n", 1)[0]);
  assert.deepEqual(recoveryKickoff.search_plan, inputs[0].search_plan);
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

test("runAiWebSearch lets recovery replace a third-party URL with a canonical direct URL for the same role", async () => {
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
      role_buckets: [{ name: "Hospitality operations", titles: ["Assistant General Manager"] }],
      fit_bands: { fit_floor: 65 },
    },
  });
  saveSearchPrompts({
    repoRoot,
    prompts: [
      {
        id: "p1",
        text: "Find active Assistant General Manager jobs in New York City",
      },
    ],
  });
  const thirdPartyUrl = "https://www.linkedin.com/jobs/view/assistant-general-manager-5186736008";
  const directUrl = "https://job-boards.greenhouse.io/hospitalitygroup/jobs/998877";
  const inputs = [];
  const result = await runAiWebSearch({
    repoRoot,
    env: {},
    runSkillStream: async ({ input, onEvent }) => {
      inputs.push(input);
      const kickoff = typeof input === "string" ? JSON.parse(input.split("\n\n", 1)[0]) : input;
      const mayResolveSameRole =
        typeof input === "string" &&
        /same employer(?:-and-title| and title)|same role/i.test(input) &&
        /canonical direct|employer-owned|direct ATS/i.test(input);
      emitAssistantJson(onEvent, {
        roles:
          inputs.length === 1
            ? [
                role({
                  company: "Hospitality Group",
                  title: "Assistant General Manager",
                  location: "New York, NY",
                  url: thirdPartyUrl,
                }),
              ]
            : mayResolveSameRole
              ? [
                  role({
                    company: "Hospitality Group",
                    title: "Assistant General Manager",
                    location: "New York, NY",
                    url: directUrl,
                  }),
                ]
              : [],
        queries_run: [
          {
            prompt_id: kickoff.prompts[0].id,
            query: `assistant general manager ${inputs.length}`,
            status: "completed",
          },
        ],
      });
      return { ok: true };
    },
    resolveJobUrlImpl: async (url) =>
      url === thirdPartyUrl
        ? {
            bodyFetchStatus: "unavailable",
            url,
            bodyText: "",
            bodyFetchReason: "The third-party page could not prove one specific posting.",
          }
        : specificResolution(url, {
            company: "Hospitality Group",
            title: "Assistant General Manager",
            location: "New York, NY",
            liveness: { result: "active", reason: "visible apply control" },
          }),
  });

  assert.equal(result.new, 1, JSON.stringify(result));
  assert.equal(result.offers[0]?.url, directUrl);
});

test("runAiWebSearch lets a later canonical occurrence qualify after an earlier hard-gate rejection", async () => {
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
    patch: {
      role_buckets: [{ name: "Hospitality operations", titles: ["Bar Manager"] }],
      fit_bands: { fit_floor: 65 },
    },
  });
  const canonicalUrl = "https://job-boards.greenhouse.io/hospitality/jobs/556677";
  const outsideSourceUrl = "https://outside.example/jobs/bar-manager";
  const localSourceUrl = "https://local.example/jobs/bar-manager";
  const result = await runAiWebSearch({
    repoRoot,
    env: {},
    runSkillStream: assistantJson({
      roles: [
        role({
          company: "Hospitality Group",
          title: "Bar Manager",
          url: outsideSourceUrl,
          location: "San Francisco, CA",
        }),
        role({
          company: "Hospitality Group",
          title: "Bar Manager",
          url: localSourceUrl,
          location: "New York, NY",
        }),
      ],
      queries_run: [{ prompt_id: "p1", query: "NYC bar manager jobs", status: "completed" }],
    }),
    resolveJobUrlImpl: async (url) =>
      specificResolution(canonicalUrl, {
        company: "Hospitality Group",
        title: "Bar Manager",
        location: url === outsideSourceUrl ? "San Francisco, CA" : "New York, NY",
        bodyText: fullJd("Active bar manager posting"),
        liveness: { result: "active", reason: "visible apply control" },
      }),
  });

  assert.equal(result.new, 1, JSON.stringify(result));
  assert.equal(result.presented, 1, JSON.stringify(result));
  assert.deepEqual(result.reasonCounts, { location: 1 });
  const [saved] = readDbScannerRows({ repoRoot }).filter((row) => row.source === "ai-web-search");
  assert.equal(saved.link, canonicalUrl);
  assert.equal(saved.loc, "New York, NY");
});

test("runAiWebSearch does not let a rejected preliminary duplicate satisfy prompt coverage", async () => {
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
    patch: {
      role_buckets: [{ name: "Hospitality operations", titles: ["Bar Manager"] }],
      fit_bands: { fit_floor: 65 },
    },
  });
  const rejectedUrl = "https://stale.example/jobs/bar-manager";
  const replacementUrl = "https://active.example/jobs/bar-manager";
  const inputs = [];
  const result = await runAiWebSearch({
    repoRoot,
    env: {},
    runSkillStream: async ({ input, onEvent }) => {
      inputs.push(input);
      const freshnessRecovery =
        typeof input === "string" && input.includes("canonical checker rejected");
      emitAssistantJson(onEvent, {
        roles: freshnessRecovery
          ? [
              role({
                company: "Active Hospitality",
                title: "Bar Manager",
                url: replacementUrl,
                location: "New York, NY",
              }),
            ]
          : inputs.length === 1
            ? [
                role({
                  company: "Stale Hospitality",
                  title: "Bar Manager",
                  url: rejectedUrl,
                  location: "San Francisco, CA",
                }),
                role({
                  company: "Stale Hospitality",
                  title: "Bar Manager",
                  url: rejectedUrl,
                  location: "San Francisco, CA",
                }),
              ]
            : [],
        queries_run: [{ prompt_id: "p1", query: `bar manager query ${inputs.length}` }],
      });
      return { ok: true };
    },
    resolveJobUrlImpl: async (url) =>
      specificResolution(url, {
        company: url === rejectedUrl ? "Stale Hospitality" : "Active Hospitality",
        title: "Bar Manager",
        location: url === rejectedUrl ? "San Francisco, CA" : "New York, NY",
        bodyText: fullJd("Active bar manager posting"),
        liveness: { result: "active", reason: "visible apply control" },
      }),
  });

  assert.ok(
    inputs.some(
      (input) => typeof input === "string" && input.includes("canonical checker rejected")
    ),
    "the rejected duplicate must leave its prompt eligible for freshness recovery"
  );
  assert.equal(result.new, 1, JSON.stringify(result));
  assert.equal(result.presented, 1, JSON.stringify(result));
  assert.deepEqual(
    readDbScannerRows({ repoRoot })
      .filter((row) => row.source === "ai-web-search")
      .map((row) => row.link),
    [replacementUrl]
  );
});

test("runAiWebSearch does not count a below-fit-floor canonical result as prompt coverage", async () => {
  const repoRoot = repo({ prompts: 1 });
  candidateConfigPatch({
    repoRoot,
    name: "targeting",
    patch: {
      role_buckets: [{ name: "Platform", titles: ["Platform Engineer"] }],
      fit_bands: { fit_floor: 65 },
    },
  });
  const belowFloorUrl = "https://jobs.example.test/below-fit-floor";
  const qualifiedUrl = "https://jobs.example.test/qualified-fit";
  const inputs = [];
  const result = await runAiWebSearch({
    repoRoot,
    env: {},
    runSkillStream: async ({ input, onEvent }) => {
      inputs.push(input);
      const freshnessRecovery =
        typeof input === "string" && input.includes("canonical checker rejected");
      emitAssistantJson(onEvent, {
        roles: freshnessRecovery
          ? [
              role({
                company: "Qualified Co",
                title: "Platform Engineer",
                url: qualifiedUrl,
                fit_score: 88,
              }),
            ]
          : inputs.length === 1
            ? [
                role({
                  company: "Below Floor Co",
                  title: "Platform Engineer",
                  url: belowFloorUrl,
                  fit_score: 64,
                  fit_bucket: "stretch",
                }),
              ]
            : [],
        queries_run: [{ prompt_id: "p1", query: `platform query ${inputs.length}` }],
      });
      return { ok: true };
    },
    resolveJobUrlImpl: canonicalResolver(),
  });

  assert.ok(
    inputs.some(
      (input) => typeof input === "string" && input.includes("canonical checker rejected")
    ),
    "below-floor results must leave the prompt eligible for a qualified replacement"
  );
  assert.equal(result.new, 2, JSON.stringify(result));
  assert.ok(
    result.offers.some((offer) => offer.url === qualifiedUrl),
    JSON.stringify(result)
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
        return specificResolution(url, {
          bodyText: fullJd("Expired posting"),
          liveness: { result: "expired", reason: "Expired posting." },
        });
      }
      if (url === outsideUrl) {
        return specificResolution(url, {
          location: "San Francisco, CA",
          bodyText: fullJd("This is an in-person San Francisco role"),
        });
      }
      if (url === belowFloorUrl) {
        return specificResolution(url, {
          location: "New York, NY",
          bodyText: fullJd("Base salary: $75,000 - $84,000 per year"),
        });
      }
      return specificResolution(url, {
        location: "New York, NY",
        bodyText: fullJd("Compensation to be confirmed"),
      });
    },
  });

  assert.equal(calls, 6, "below-fit-floor recovery does not satisfy prompt coverage");
  assert.deepEqual(hydrated.sort(), [belowFloorUrl, expiredUrl, lowFitUrl, outsideUrl].sort());
  assert.equal(result.invalid, 4);
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
    resolveJobUrlImpl: async (url) =>
      specificResolution(url, {
        title: "Bar Manager",
        location: "New York, NY",
        bodyText: url.includes("expired")
          ? fullJd("Expired posting")
          : url.includes("below-floor")
            ? fullJd("Base salary: $75,000 - $80,000 per year")
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

test("runAiWebSearch tops up same-title results toward the selected configured target titles", async () => {
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
        {
          name: "Bar leadership",
          titles: ["Bar Manager", "Head Bartender", "Beverage Manager"],
        },
      ],
      fit_bands: { fit_floor: 65 },
    },
  });
  saveSearchPrompts({
    repoRoot,
    prompts: ["p1", "p2", "p3"].map((id) => ({
      id,
      text: "Find Bar Manager, Head Bartender, and Beverage Manager jobs in New York City",
    })),
  });
  let calls = 0;
  const topUpInputs = [];
  const result = await runAiWebSearch({
    repoRoot,
    env: {},
    runSkillStream: async ({ input, onEvent }) => {
      calls += 1;
      const kickoff = typeof input === "string" ? JSON.parse(input.split("\n\n", 1)[0]) : input;
      const promptId = kickoff.prompts[0].id;
      const isTopUp = typeof input === "string";
      if (isTopUp) topUpInputs.push(input);
      const title =
        topUpInputs.length === 1 && isTopUp
          ? "Head Bartender"
          : topUpInputs.length === 2 && isTopUp
            ? "Beverage Manager"
            : "Bar Manager";
      emitAssistantJson(onEvent, {
        roles: [
          role({
            company: `Bar Group ${calls}`,
            title,
            location: "New York, NY",
            url: `https://bar-${calls}.example/jobs/manager`,
          }),
        ],
        queries_run: [
          { prompt_id: promptId, query: `${promptId} query ${calls}`, status: "completed" },
        ],
      });
      return { ok: true };
    },
    resolveJobUrlImpl: canonicalResolver({
      location: "New York, NY",
      liveness: { result: "active", reason: "visible apply control" },
    }),
  });

  assert.equal(calls, 5);
  assert.equal(topUpInputs.length, 2);
  assert.match(topUpInputs[0], /Head Bartender/);
  assert.match(topUpInputs[0], /Beverage Manager/);
  assert.match(topUpInputs[1], /Beverage Manager/);
  assert.equal(result.new, 5, JSON.stringify(result));
  assert.equal(result.presented, 5, JSON.stringify(result));
});

test("runAiWebSearch does not force adjacent titles omitted by the selected prompt", async () => {
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

test("runAiWebSearch prefers a specifically named title over its overlapping parent title", async () => {
  const repoRoot = repo({ prompts: 1 });
  candidateConfigPatch({
    repoRoot,
    name: "targeting",
    patch: {
      role_buckets: [
        {
          name: "Software engineering",
          titles: ["Software Engineer", "Senior Software Engineer"],
        },
      ],
      fit_bands: { fit_floor: 0 },
    },
  });
  saveSearchPrompts({
    repoRoot,
    prompts: [{ id: "p1", text: "Find Senior Software Engineer jobs" }],
  });
  let calls = 0;
  const result = await runAiWebSearch({
    repoRoot,
    env: {},
    runSkillStream: async ({ input, onEvent }) => {
      calls += 1;
      const kickoff = typeof input === "string" ? JSON.parse(input.split("\n\n", 1)[0]) : input;
      emitAssistantJson(onEvent, {
        roles: [1, 2, 3].map((index) =>
          role({
            company: `Senior Company ${index}`,
            title: "Senior Software Engineer",
            url: `https://senior-${index}.example/jobs/software-engineer`,
          })
        ),
        queries_run: [
          { prompt_id: kickoff.prompts[0].id, query: `senior query ${calls}`, status: "completed" },
        ],
      });
      return { ok: true };
    },
    resolveJobUrlImpl: canonicalResolver(),
  });

  assert.equal(calls, 1);
  assert.equal(result.presented, 3, JSON.stringify(result));
});

test("runAiWebSearch does not count senior variants as the overlapping parent target", async () => {
  const repoRoot = repo({ prompts: 1 });
  candidateConfigPatch({
    repoRoot,
    name: "targeting",
    patch: {
      role_buckets: [
        {
          name: "Software engineering",
          titles: ["Software Engineer", "Senior Software Engineer"],
        },
      ],
      fit_bands: { fit_floor: 0 },
    },
  });
  saveSearchPrompts({
    repoRoot,
    prompts: [{ id: "p1", text: "Find Software engineering roles" }],
  });
  let calls = 0;
  const topUpInputs = [];
  const result = await runAiWebSearch({
    repoRoot,
    env: {},
    runSkillStream: async ({ input, onEvent }) => {
      calls += 1;
      const kickoff = typeof input === "string" ? JSON.parse(input.split("\n\n", 1)[0]) : input;
      const isTopUp = typeof input === "string";
      if (isTopUp) topUpInputs.push(input);
      emitAssistantJson(onEvent, {
        roles: isTopUp
          ? [
              role({
                company: "Software Company",
                title: "Software Engineer",
                url: "https://software.example/jobs/software-engineer",
              }),
            ]
          : ["Senior", "Lead Senior", "Principal Senior"].map((prefix, index) =>
              role({
                company: `Senior Company ${index + 1}`,
                title: `${prefix} Software Engineer`,
                url: `https://senior-${index + 1}.example/jobs/software-engineer`,
              })
            ),
        queries_run: [
          {
            prompt_id: kickoff.prompts[0].id,
            query: `software query ${calls}`,
            status: "completed",
          },
        ],
      });
      return { ok: true };
    },
    resolveJobUrlImpl: canonicalResolver(),
  });

  assert.equal(calls, 2);
  assert.equal(topUpInputs.length, 1);
  assert.match(topUpInputs[0], /Software Engineer/);
  assert.doesNotMatch(topUpInputs[0], /still unrepresented: Senior Software Engineer/);
  assert.equal(result.presented, 4, JSON.stringify(result));
});

test("runAiWebSearch unions a generic bucket prompt with an exact-title sibling", async () => {
  const repoRoot = repo({ prompts: 2 });
  candidateConfigPatch({
    repoRoot,
    name: "targeting",
    patch: {
      role_buckets: [
        {
          name: "Bar leadership",
          titles: ["Bar Manager", "Head Bartender", "Beverage Manager"],
        },
      ],
      fit_bands: { fit_floor: 0 },
    },
  });
  saveSearchPrompts({
    repoRoot,
    prompts: [
      { id: "p1", text: "Find Bar Manager jobs" },
      { id: "p2", text: "Find Bar leadership roles" },
    ],
  });
  let calls = 0;
  const topUpInputs = [];
  const result = await runAiWebSearch({
    repoRoot,
    env: {},
    runSkillStream: async ({ input, onEvent }) => {
      calls += 1;
      const kickoff = typeof input === "string" ? JSON.parse(input.split("\n\n", 1)[0]) : input;
      const promptId = kickoff.prompts[0].id;
      const isTopUp = typeof input === "string";
      if (isTopUp) topUpInputs.push(input);
      const roles = isTopUp
        ? [
            role({
              company: "Head Bar Group",
              title: "Head Bartender",
              url: "https://head-bar.example/jobs/head-bartender",
            }),
            role({
              company: "Beverage Group",
              title: "Beverage Manager",
              url: "https://beverage.example/jobs/beverage-manager",
            }),
          ]
        : [
            role({
              company: `${promptId} Bar Group A`,
              title: "Bar Manager",
              url: `https://${promptId}-bar-a.example/jobs/bar-manager`,
            }),
            ...(promptId === "p1"
              ? [
                  role({
                    company: `${promptId} Bar Group B`,
                    title: "Bar Manager",
                    url: `https://${promptId}-bar-b.example/jobs/bar-manager`,
                  }),
                ]
              : []),
          ];
      emitAssistantJson(onEvent, {
        roles,
        queries_run: [
          { prompt_id: promptId, query: `${promptId} query ${calls}`, status: "completed" },
        ],
      });
      return { ok: true };
    },
    resolveJobUrlImpl: canonicalResolver(),
  });

  assert.equal(calls, 3);
  assert.equal(topUpInputs.length, 1);
  assert.match(topUpInputs[0], /Head Bartender/);
  assert.match(topUpInputs[0], /Beverage Manager/);
  assert.equal(result.presented, 5, JSON.stringify(result));
});

test("runAiWebSearch includes configured engineering titles named without the generic suffix", async () => {
  const repoRoot = repo({ prompts: 2 });
  candidateConfigPatch({
    repoRoot,
    name: "targeting",
    patch: {
      role_buckets: [
        {
          name: "Platform and backend",
          titles: ["Staff Platform Engineer", "Staff Backend Engineer"],
        },
        {
          name: "Developer infrastructure",
          titles: ["Developer Infrastructure Engineer", "Developer Experience Engineer"],
        },
      ],
      fit_bands: { fit_floor: 0 },
    },
  });
  saveSearchPrompts({
    repoRoot,
    prompts: [
      {
        id: "p1",
        text: "Find Staff Platform Engineer and Staff Backend Engineer roles",
      },
      {
        id: "p2",
        text: "Find Developer Infrastructure and Developer Experience roles",
      },
    ],
  });
  const inputs = [];
  const result = await runAiWebSearch({
    repoRoot,
    env: {},
    runSkillStream: async ({ input, onEvent }) => {
      inputs.push(input);
      const kickoff = typeof input === "string" ? JSON.parse(input.split("\n\n", 1)[0]) : input;
      const promptId = kickoff.prompts[0].id;
      const isTopUp = typeof input === "string";
      const roles = isTopUp
        ? [
            role({
              company: "Developer Tools Co",
              title: "Developer Infrastructure Engineer",
              url: "https://devtools.example/jobs/developer-infrastructure",
            }),
          ]
        : promptId === "p1"
          ? [
              role({
                company: "Platform Co",
                title: "Staff Platform Engineer",
                url: "https://platform.example/jobs/staff-platform",
              }),
              role({
                company: "Backend Co",
                title: "Staff Backend Engineer",
                url: "https://backend.example/jobs/staff-backend",
              }),
            ]
          : [];
      emitAssistantJson(onEvent, {
        roles,
        queries_run: [
          { prompt_id: promptId, query: `${promptId} query ${inputs.length}`, status: "completed" },
        ],
      });
      return { ok: true };
    },
    resolveJobUrlImpl: canonicalResolver(),
  });

  assert.equal(inputs.length, 3);
  assert.equal(typeof inputs[2], "string");
  assert.equal(JSON.parse(inputs[2].split("\n\n", 1)[0]).prompts[0].id, "p2");
  const topUpInstruction = inputs[2].split("\n\n").slice(1).join("\n\n");
  assert.match(topUpInstruction, /Developer Infrastructure Engineer/);
  assert.match(topUpInstruction, /Developer Experience Engineer/);
  assert.equal(result.presented, 3, JSON.stringify(result));
});

test("runAiWebSearch lets successful siblings recover useful coverage without masking a failed prompt", async () => {
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
      {
        id: "p1",
        text: "Find Bar Manager and Assistant General Manager jobs in New York City",
      },
      { id: "p2", text: "Find Event Operations jobs in New York City" },
      { id: "p3", text: "Find Head Bartender jobs in New York City" },
    ],
  });
  const executionPlan = Object.freeze({
    operation: "research.web",
    runtimeId: "claude",
    resolved: Object.freeze({ model: "claude-sonnet-4-6", effort: "medium" }),
  });
  const calls = new Map();
  const receivedPlans = [];
  const topUpInputs = [];
  const result = await runAiWebSearch({
    repoRoot,
    env: {},
    executionPlan,
    runSkillStream: async ({ input, onEvent, executionPlan: receivedPlan }) => {
      const kickoff = typeof input === "string" ? JSON.parse(input.split("\n\n", 1)[0]) : input;
      const promptId = kickoff.prompts[0].id;
      const attempt = (calls.get(promptId) || 0) + 1;
      calls.set(promptId, attempt);
      receivedPlans.push(receivedPlan);
      if (typeof input === "string") topUpInputs.push(input);
      if (promptId === "p2") {
        return { ok: false, error: "The saved search timed out." };
      }
      const roles =
        promptId === "p1"
          ? [
              role({
                company: attempt === 1 ? "Bar One" : "Restaurant Three",
                title: attempt === 1 ? "Bar Manager" : "Assistant General Manager",
                location: "New York, NY",
                url:
                  attempt === 1
                    ? "https://bar-one.example/jobs/bar-manager"
                    : "https://restaurant-three.example/jobs/assistant-general-manager",
              }),
            ]
          : [
              role({
                company: "Bar Two",
                title: "Head Bartender",
                location: "New York, NY",
                url: "https://bar-two.example/jobs/head-bartender",
              }),
            ];
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
  assert.deepEqual(receivedPlans, Array(4).fill(executionPlan));
  assert.equal(topUpInputs.length, 1);
  assert.match(topUpInputs[0], /Assistant General Manager/);
  assert.match(topUpInputs[0], /Bar Manager/);
  assert.match(topUpInputs[0], /Head Bartender/);
  assert.match(topUpInputs[0], /Bar leadership/);
  assert.match(topUpInputs[0], /Hospitality operations/);
  assert.equal(result.new, 3, JSON.stringify(result));
  assert.equal(result.presented, 3, JSON.stringify(result));
  assert.deepEqual(result.failedPromptIds, ["p2"]);
  assert.equal(result.queryResults.find((entry) => entry.promptId === "p2")?.status, "failed");
  assert.match(result.errors.join(" "), /couldn't finish/i);
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

test("runAiWebSearch tops up a useful set made only of deferred posting leads", async () => {
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
      {
        id: "p1",
        text: "Find Bar Manager, Head Bartender, and Assistant General Manager jobs in New York City",
      },
    ],
  });
  sourceConfigPut({
    repoRoot,
    name: "search-sources",
    data: {
      searches: [
        {
          provider: "indeed",
          source_type: "url-query",
          label: "Bar and hospitality management",
          url: "https://www.indeed.com/jobs?q=bar+manager",
          enabled: true,
        },
        {
          provider: "specialist.example",
          source_type: "browser",
          label: "Bar and hospitality management",
          url: "https://specialist.example/jobs",
          enabled: true,
        },
      ],
    },
  });

  const blockedRoles = [
    ["Bar One", "Bar Manager", "blocked-bar-manager"],
    ["Bar Two", "Head Bartender", "blocked-head-bartender"],
    ["Restaurant Three", "Assistant General Manager", "blocked-assistant-manager"],
  ].map(([company, title, id]) =>
    role({
      company,
      title,
      location: "New York, NY",
      url: `https://www.indeed.com/viewjob?jk=${id}`,
      body_text: null,
      body_partial: true,
    })
  );
  const readableRoles = [
    ["Bar Four", "Bar Manager", "bar-manager"],
    ["Bar Five", "Head Bartender", "head-bartender"],
    ["Restaurant Six", "Assistant General Manager", "assistant-general-manager"],
  ].map(([company, title, slug]) =>
    role({
      company,
      title,
      location: "New York, NY",
      url: `https://${slug}.example/jobs/${slug}`,
    })
  );
  const inputs = [];
  const result = await runAiWebSearch({
    repoRoot,
    env: {},
    runSkillStream: async ({ input, onEvent }) => {
      inputs.push(input);
      const kickoff = typeof input === "string" ? JSON.parse(input.split("\n\n", 1)[0]) : input;
      const roles =
        typeof input !== "string"
          ? blockedRoles
          : inputs.length === 2
            ? [
                role({
                  company: "Blocked replacement",
                  title: "Bar Manager",
                  location: "New York, NY",
                  url: "https://www.indeed.com/viewjob?jk=blocked-replacement",
                  body_text: null,
                  body_partial: true,
                }),
              ]
            : readableRoles;
      emitAssistantJson(onEvent, {
        roles,
        queries_run: [
          {
            prompt_id: kickoff.prompts[0].id,
            query: typeof input === "string" ? "direct employer hospitality jobs" : "NYC jobs",
            status: "completed",
          },
        ],
      });
      return { ok: true };
    },
    resolveJobUrlImpl: async (url) =>
      url.includes("indeed.com")
        ? {
            bodyFetchStatus: "deferred",
            url,
            reason: "The exact posting requires a browser session.",
          }
        : specificResolution(url, {
            location: "New York, NY",
            liveness: { result: "active", reason: "visible apply control" },
          }),
  });

  assert.equal(inputs.length, 3);
  assert.equal(typeof inputs[1], "string");
  assert.match(inputs[1], /exact posting requires a browser session/i);
  assert.match(inputs[1], /"rejected_source_hosts":\["www\.indeed\.com"\]/);
  const firstTopUpPlan = JSON.parse(inputs[1].split("\n\n", 1)[0]).search_plan;
  const secondTopUpPlan = JSON.parse(inputs[2].split("\n\n", 1)[0]).search_plan;
  assert.equal(firstTopUpPlan.source_hints[0], "specialist.example");
  assert.deepEqual(firstTopUpPlan.rejected_sources.hosts, ["www.indeed.com"]);
  assert.ok(firstTopUpPlan.query_hints.some(({ kind }) => kind === "direct-employer-or-ats"));
  assert.doesNotMatch(JSON.stringify(firstTopUpPlan.query_hints), /indeed\.com/);
  assert.doesNotMatch(JSON.stringify(secondTopUpPlan.query_hints), /indeed\.com/);
  assert.equal(result.new, 6, JSON.stringify(result));
  assert.equal(result.partial, 3, JSON.stringify(result));
  assert.equal(result.presented, 3, JSON.stringify(result));
  assert.equal(
    readDbScannerRows({ repoRoot }).filter((row) => row.source === "ai-web-search").length,
    6
  );
});

test("runAiWebSearch prioritizes unused configured hosts across underfilled top-ups", async () => {
  const repoRoot = repo({ prompts: 1 });
  const targetTitles = [
    "Bar Manager",
    "Assistant Bar Manager",
    "Bar Operations Lead",
    "Lead Bartender",
    "Head Bartender",
  ];
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
      role_buckets: [{ name: "Bar leadership", titles: targetTitles }],
      fit_bands: { fit_floor: 65 },
    },
  });
  saveSearchPrompts({
    repoRoot,
    prompts: [
      {
        id: "p1",
        text: `Find active ${targetTitles.join(", ")} jobs in New York City`,
      },
    ],
  });
  const configuredHosts = [
    "bar-source-one.example",
    "bar-source-two.example",
    "bar-source-three.example",
    "bar-source-four.example",
  ];
  sourceConfigPut({
    repoRoot,
    name: "search-sources",
    data: {
      searches: [
        {
          provider: "indeed",
          source_type: "url-query",
          label: "General job aggregator",
          url: "https://www.indeed.com/jobs?q=bar+manager",
          enabled: true,
        },
        ...configuredHosts.map((host, index) => ({
          provider: host,
          source_type: "browser",
          label: `${targetTitles.join(" / ")} board ${index + 1}`,
          url: `https://${host}/jobs`,
          enabled: true,
        })),
      ],
    },
  });

  const inputs = [];
  const actualQueriesByTurn = [];
  const blockedUrl = "https://www.indeed.com/viewjob?jk=blocked-head-bartender";
  const readableUrl = "https://direct-bar.example/jobs/bar-manager";
  const result = await runAiWebSearch({
    repoRoot,
    env: {},
    runSkillStream: async ({ input, onEvent }) => {
      inputs.push(input);
      const kickoff = typeof input === "string" ? JSON.parse(input.split("\n\n", 1)[0]) : input;
      const plannedQueries = kickoff.search_plan.query_hints.map(({ query }) => query);
      const reportedQueries =
        inputs.length === 1
          ? plannedQueries.map((query) => `  ${query.toUpperCase().replace(/\s+/g, "  ")}  `)
          : [plannedQueries[0]];
      actualQueriesByTurn.push(reportedQueries);
      emitAssistantJson(onEvent, {
        roles:
          inputs.length === 1
            ? [
                role({
                  company: "Direct Bar",
                  title: "Bar Manager",
                  location: "New York, NY",
                  url: readableUrl,
                }),
                role({
                  company: "Blocked Bar",
                  title: "Head Bartender",
                  location: "New York, NY",
                  url: blockedUrl,
                  body_text: null,
                  body_partial: true,
                }),
              ]
            : [],
        queries_run: reportedQueries.map((query) => ({
          prompt_id: "p1",
          query,
          status: "completed",
        })),
      });
      return { ok: true };
    },
    resolveJobUrlImpl: async (url) =>
      url === blockedUrl
        ? {
            bodyFetchStatus: "deferred",
            url,
            reason: "The exact posting requires a browser session.",
          }
        : specificResolution(url, {
            title: "Bar Manager",
            location: "New York, NY",
            liveness: { result: "active", reason: "visible apply control" },
          }),
  });

  assert.ok(
    actualQueriesByTurn[0].some((query) =>
      query.toLowerCase().includes(`site:${configuredHosts[0]}`)
    ),
    JSON.stringify(actualQueriesByTurn[0])
  );
  assert.equal(inputs.length, 4, JSON.stringify(result));
  const topUpPlans = inputs
    .slice(1)
    .map((input) => JSON.parse(input.split("\n\n", 1)[0]).search_plan);
  const expectedTopUpHosts = configuredHosts.slice(1);
  assert.deepEqual(
    topUpPlans.map((plan) => plan.source_hints[0]),
    expectedTopUpHosts
  );
  const normalizedQuery = (query) => query.trim().replace(/\s+/g, " ").toLowerCase();
  const previouslyUsed = new Set(actualQueriesByTurn[0].map(normalizedQuery));
  for (let index = 0; index < topUpPlans.length; index += 1) {
    const plan = topUpPlans[index];
    assert.deepEqual(plan.limits, {
      scope: "prompt-turn",
      web_search_calls: 4,
      web_fetch_calls: 8,
      hard_stop: true,
    });
    assert.deepEqual(plan.focus.missing_target_titles, targetTitles.slice(1));
    assert.deepEqual(plan.rejected_sources.hosts, ["www.indeed.com"]);
    assert.doesNotMatch(JSON.stringify([plan.source_hints, plan.query_hints]), /indeed\.com/);
    assert.equal(plan.query_hints[0].kind, "configured-source-or-direct", JSON.stringify(plan));
    assert.ok(
      plan.query_hints[0].query.includes(`site:${expectedTopUpHosts[index]}`),
      JSON.stringify(plan)
    );
    assert.ok(
      plan.query_hints.every(({ query }) => query.includes('"New York, NY"')),
      JSON.stringify(plan)
    );
    for (const title of targetTitles.slice(1)) {
      assert.ok(
        plan.query_hints.some(({ query }) => query.includes(`"${title}"`)),
        JSON.stringify(plan)
      );
    }
    assert.ok(
      plan.query_hints.every(({ query }) => !previouslyUsed.has(normalizedQuery(query))),
      JSON.stringify(plan)
    );
    for (const query of actualQueriesByTurn[index + 1]) {
      previouslyUsed.add(normalizedQuery(query));
    }
  }
  assert.equal(result.presented, 1, JSON.stringify(result));
});

test("runAiWebSearch supplements incomplete query receipts with actual WebSearch traces before top-up", async () => {
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
    patch: {
      role_buckets: [{ name: "Bar leadership", titles: ["Bar Manager"] }],
      fit_bands: { fit_floor: 0 },
    },
  });
  saveSearchPrompts({
    repoRoot,
    prompts: [{ id: "p1", text: "Find active Bar Manager jobs in New York City" }],
  });
  const configuredHosts = [
    "trace-one.example",
    "trace-two.example",
    "trace-three.example",
    "trace-four.example",
  ];
  sourceConfigPut({
    repoRoot,
    name: "search-sources",
    data: {
      searches: configuredHosts.map((host, index) => ({
        provider: host,
        source_type: "browser",
        label: `Bar Manager board ${index + 1}`,
        url: `https://${host}/jobs`,
        enabled: true,
      })),
    },
  });
  const executionPlan = Object.freeze({
    operation: "research.web",
    runtimeId: "portable-runtime",
    resolved: Object.freeze({ model: "portable-model", effort: "medium" }),
  });
  const inputs = [];
  const receivedPlans = [];
  let tracedQueries = [];
  const result = await runAiWebSearch({
    repoRoot,
    env: {},
    executionPlan,
    runSkillStream: async ({ input, onEvent, executionPlan: receivedPlan }) => {
      inputs.push(input);
      receivedPlans.push(receivedPlan);
      const kickoff = typeof input === "string" ? JSON.parse(input.split("\n\n", 1)[0]) : input;
      const plannedQueries = kickoff.search_plan.query_hints.map(({ query }) => query);
      if (inputs.length === 1) {
        const configuredQuery = plannedQueries.find((query) =>
          configuredHosts.some((host) => query.includes(`site:${host}`))
        );
        assert.ok(configuredQuery, JSON.stringify(kickoff.search_plan));
        tracedQueries = [plannedQueries[0], configuredQuery];
        tracedQueries.forEach((query, index) => {
          onEvent({
            type: "tool_use",
            data: { id: `search-${index + 1}`, name: "WebSearch", input: { query } },
          });
        });
      }
      emitAssistantJson(onEvent, {
        roles:
          inputs.length === 1
            ? [
                role({
                  company: "Initial Bar",
                  title: "Bar Manager",
                  location: "New York, NY",
                  url: "https://initial-bar.example/jobs/bar-manager",
                }),
              ]
            : [1, 2].map((index) =>
                role({
                  company: `Additional Bar ${index}`,
                  title: "Bar Manager",
                  location: "New York, NY",
                  url: `https://additional-bar-${index}.example/jobs/bar-manager`,
                })
              ),
        queries_run: [
          {
            prompt_id: "p1",
            query: plannedQueries[0],
            status: "completed",
          },
        ],
      });
      return { ok: true };
    },
    resolveJobUrlImpl: canonicalResolver({
      title: "Bar Manager",
      location: "New York, NY",
      liveness: { result: "active", reason: "visible apply control" },
    }),
  });

  assert.equal(inputs.length, 2, JSON.stringify(result));
  assert.deepEqual(receivedPlans, [executionPlan, executionPlan]);
  assert.equal(tracedQueries.length, 2);
  assert.ok(tracedQueries.length <= 4);
  const tracedConfiguredQuery = tracedQueries[1];
  const unusedHost = configuredHosts.find(
    (host) => !tracedConfiguredQuery.toLowerCase().includes(`site:${host}`)
  );
  assert.ok(unusedHost, tracedConfiguredQuery);
  const topUpPlan = JSON.parse(inputs[1].split("\n\n", 1)[0]).search_plan;
  assert.deepEqual(topUpPlan.limits, {
    scope: "prompt-turn",
    web_search_calls: 4,
    web_fetch_calls: 8,
    hard_stop: true,
  });
  assert.equal(topUpPlan.source_hints[0], unusedHost);
  assert.ok(
    topUpPlan.query_hints.every(
      ({ query }) =>
        !tracedQueries.some((used) => used.trim().toLowerCase() === query.toLowerCase())
    ),
    JSON.stringify(topUpPlan)
  );
  assert.ok(
    result.queryResults[0].queries.some(({ query }) => query === tracedConfiguredQuery),
    JSON.stringify(result.queryResults)
  );
  assert.ok(
    topUpPlan.query_hints.every(
      ({ query }) =>
        query.length <= 100 && query.includes('"Bar Manager"') && query.includes('"New York, NY"')
    ),
    JSON.stringify(topUpPlan)
  );
  assert.equal(result.presented, 3, JSON.stringify(result));
});

test("runAiWebSearch promotes an unused configured host from beyond the four-host hint cap", async () => {
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
    patch: {
      role_buckets: [{ name: "Bar leadership", titles: ["Bar Manager"] }],
      fit_bands: { fit_floor: 0 },
    },
  });
  saveSearchPrompts({
    repoRoot,
    prompts: [{ id: "p1", text: "Find active Bar Manager jobs in New York City" }],
  });
  const configuredHosts = Array.from({ length: 5 }, (_, index) => `bar-board-${index + 1}.example`);
  sourceConfigPut({
    repoRoot,
    name: "search-sources",
    data: {
      searches: configuredHosts.map((host, index) => ({
        provider: host,
        source_type: "browser",
        label: `Bar Manager board ${index + 1}`,
        url: `https://${host}/jobs`,
        enabled: true,
      })),
    },
  });
  const inputs = [];
  const result = await runAiWebSearch({
    repoRoot,
    env: {},
    runSkillStream: async ({ input, onEvent }) => {
      inputs.push(input);
      const kickoff = typeof input === "string" ? JSON.parse(input.split("\n\n", 1)[0]) : input;
      const queries =
        inputs.length === 1
          ? configuredHosts.slice(0, 4).map((host) => `"Bar Manager" "New York, NY" site:${host}`)
          : [kickoff.search_plan.query_hints[0].query];
      emitAssistantJson(onEvent, {
        roles:
          inputs.length === 1
            ? [
                role({
                  company: "Initial Bar",
                  title: "Bar Manager",
                  location: "New York, NY",
                  url: "https://initial-cap-bar.example/jobs/bar-manager",
                }),
              ]
            : [1, 2].map((index) =>
                role({
                  company: `Cap Top Up ${index}`,
                  title: "Bar Manager",
                  location: "New York, NY",
                  url: `https://cap-top-up-${index}.example/jobs/bar-manager`,
                })
              ),
        queries_run: queries.map((query) => ({ prompt_id: "p1", query, status: "completed" })),
      });
      return { ok: true };
    },
    resolveJobUrlImpl: canonicalResolver({
      title: "Bar Manager",
      location: "New York, NY",
      liveness: { result: "active", reason: "visible apply control" },
    }),
  });

  assert.equal(inputs.length, 2, JSON.stringify(result));
  const initialPlan = inputs[0].search_plan;
  const topUpPlan = JSON.parse(inputs[1].split("\n\n", 1)[0]).search_plan;
  assert.equal(initialPlan.source_hints.length, 4);
  assert.deepEqual(initialPlan.source_hints, configuredHosts.slice(0, 4));
  assert.equal(topUpPlan.source_hints.length, 4);
  assert.equal(topUpPlan.source_hints[0], configuredHosts[4]);
  assert.match(topUpPlan.query_hints[0].query, new RegExp(`site:${configuredHosts[4]}`));
  assert.deepEqual(topUpPlan.limits, {
    scope: "prompt-turn",
    web_search_calls: 4,
    web_fetch_calls: 8,
    hard_stop: true,
  });
  assert.ok(topUpPlan.query_hints.length <= 4);
  assert.ok(
    topUpPlan.query_hints.every(
      ({ query }) =>
        query.length <= 100 && query.includes('"Bar Manager"') && query.includes('"New York, NY"')
    )
  );
  assert.equal(result.presented, 3, JSON.stringify(result));
});

test("runAiWebSearch skips an exhausted prompt plan and tops up another viable prompt", async () => {
  const repoRoot = repo({ prompts: 2 });
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
    patch: {
      role_buckets: [
        { name: "Bar leadership", titles: ["Bar Manager"] },
        { name: "Hospitality operations", titles: ["Assistant General Manager"] },
      ],
      fit_bands: { fit_floor: 0 },
    },
  });
  saveSearchPrompts({
    repoRoot,
    prompts: [
      { id: "p1", text: "Find active Bar Manager jobs in New York City" },
      { id: "p2", text: "Find active Assistant General Manager jobs in New York City" },
    ],
  });
  const calls = new Map();
  const plans = [];
  const result = await runAiWebSearch({
    repoRoot,
    env: {},
    runSkillStream: async ({ input, onEvent }) => {
      const kickoff = typeof input === "string" ? JSON.parse(input.split("\n\n", 1)[0]) : input;
      const promptId = kickoff.prompts[0].id;
      const attempt = (calls.get(promptId) || 0) + 1;
      calls.set(promptId, attempt);
      plans.push(kickoff.search_plan);
      const queries =
        promptId === "p1"
          ? kickoff.search_plan.query_hints.map(({ query }) => query)
          : attempt === 1
            ? ['"Assistant General Manager" "New York, NY" first pass']
            : [kickoff.search_plan.query_hints[0].query];
      emitAssistantJson(onEvent, {
        roles:
          promptId === "p2" && attempt === 1
            ? [
                role({
                  company: "Initial Restaurant",
                  title: "Assistant General Manager",
                  location: "New York, NY",
                  url: "https://initial-restaurant.example/jobs/assistant-general-manager",
                }),
              ]
            : promptId === "p2"
              ? [1, 2].map((index) =>
                  role({
                    company: `Additional Restaurant ${index}`,
                    title: "Assistant General Manager",
                    location: "New York, NY",
                    url: `https://additional-restaurant-${index}.example/jobs/assistant-general-manager`,
                  })
                )
              : [],
        queries_run: queries.map((query) => ({ prompt_id: promptId, query, status: "completed" })),
      });
      return { ok: true };
    },
    resolveJobUrlImpl: canonicalResolver({
      location: "New York, NY",
      liveness: { result: "active", reason: "visible apply control" },
    }),
  });

  assert.deepEqual(Object.fromEntries(calls), { p1: 1, p2: 2 });
  assert.ok(plans.every((plan) => plan.query_hints.length <= 4));
  assert.ok(
    plans.every(
      (plan) =>
        plan.limits.web_search_calls === 4 &&
        plan.limits.web_fetch_calls === 8 &&
        plan.limits.hard_stop === true
    )
  );
  assert.ok(
    plans
      .flatMap((plan) => plan.query_hints)
      .every(({ query }) => query.length <= 100 && query.includes('"New York, NY"'))
  );
  assert.equal(result.presented, 3, JSON.stringify(result));
});

test("runAiWebSearch builds a configured-first top-up for a long configured hostname", async () => {
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
    patch: {
      role_buckets: [{ name: "Field operations", titles: ["Field Operations Manager"] }],
      fit_bands: { fit_floor: 0 },
    },
  });
  saveSearchPrompts({
    repoRoot,
    prompts: [{ id: "p1", text: "Find active Field Operations Manager jobs in New York City" }],
  });
  const configuredHost = "specialized-field-operations-opportunities-board-careers.example";
  sourceConfigPut({
    repoRoot,
    name: "search-sources",
    data: {
      searches: [
        {
          provider: configuredHost,
          source_type: "browser",
          label: "Field Operations Manager board",
          url: `https://${configuredHost}/jobs`,
          enabled: true,
        },
      ],
    },
  });
  const executionPlan = Object.freeze({
    operation: "research.web",
    runtimeId: "portable-runtime",
    resolved: Object.freeze({ model: "portable-model", effort: "medium" }),
  });
  const inputs = [];
  const receivedPlans = [];
  const result = await runAiWebSearch({
    repoRoot,
    env: {},
    executionPlan,
    runSkillStream: async ({ input, onEvent, executionPlan: receivedPlan }) => {
      inputs.push(input);
      receivedPlans.push(receivedPlan);
      const kickoff = typeof input === "string" ? JSON.parse(input.split("\n\n", 1)[0]) : input;
      emitAssistantJson(onEvent, {
        roles:
          inputs.length === 1
            ? [
                role({
                  company: "Initial Field Team",
                  title: "Field Operations Manager",
                  location: "New York, NY",
                  url: "https://initial-field.example/jobs/field-operations-manager",
                }),
              ]
            : [1, 2].map((index) =>
                role({
                  company: `Additional Field Team ${index}`,
                  title: "Field Operations Manager",
                  location: "New York, NY",
                  url: `https://additional-field-${index}.example/jobs/field-operations-manager`,
                })
              ),
        queries_run: kickoff.search_plan.query_hints.map(({ query }) => ({
          prompt_id: "p1",
          query,
          status: "completed",
        })),
      });
      return { ok: true };
    },
    resolveJobUrlImpl: canonicalResolver({
      title: "Field Operations Manager",
      location: "New York, NY",
      liveness: { result: "active", reason: "visible apply control" },
    }),
  });

  assert.equal(inputs.length, 2, JSON.stringify(result));
  assert.deepEqual(receivedPlans, [executionPlan, executionPlan]);
  const topUpKickoff = JSON.parse(inputs[1].split("\n\n", 1)[0]);
  assert.equal(topUpKickoff.candidate.location.home, "New York, NY");
  assert.match(inputs[1], /do not loosen title, location, compensation, freshness, or fit/i);
  assert.deepEqual(topUpKickoff.search_plan.limits, {
    scope: "prompt-turn",
    web_search_calls: 4,
    web_fetch_calls: 8,
    hard_stop: true,
  });
  assert.ok(topUpKickoff.search_plan.query_hints.length <= 4);
  const configuredQuery = topUpKickoff.search_plan.query_hints[0].query;
  assert.equal(topUpKickoff.search_plan.query_hints[0].kind, "configured-source-or-direct");
  assert.match(configuredQuery, new RegExp(`site:${configuredHost}`));
  assert.match(configuredQuery, /"Field Operations Manager"/);
  assert.match(configuredQuery, /(?:"New York, NY"|\bNYC\b)/);
  assert.ok(configuredQuery.length <= 100, configuredQuery);
  assert.equal(result.presented, 3, JSON.stringify(result));
});

test("runAiWebSearch stops before invoking an empty used-query top-up plan", async () => {
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
    patch: {
      role_buckets: [{ name: "Bar leadership", titles: ["Bar Manager"] }],
      fit_bands: { fit_floor: 0 },
    },
  });
  saveSearchPrompts({
    repoRoot,
    prompts: [{ id: "p1", text: "Find active Bar Manager jobs in New York City" }],
  });

  const inputs = [];
  const roleUrl = "https://direct-bar.example/jobs/bar-manager";
  const result = await runAiWebSearch({
    repoRoot,
    env: {},
    runSkillStream: async ({ input, onEvent }) => {
      inputs.push(input);
      const kickoff = typeof input === "string" ? JSON.parse(input.split("\n\n", 1)[0]) : input;
      assert.ok(kickoff.search_plan.query_hints.length > 0, JSON.stringify(kickoff.search_plan));
      const query = kickoff.search_plan.query_hints[0].query;
      emitAssistantJson(onEvent, {
        roles:
          inputs.length === 1
            ? [
                role({
                  company: "Direct Bar",
                  title: "Bar Manager",
                  location: "New York, NY",
                  url: roleUrl,
                }),
              ]
            : [],
        queries_run: [{ prompt_id: "p1", query, status: "completed" }],
      });
      return { ok: true };
    },
    resolveJobUrlImpl: canonicalResolver({
      title: "Bar Manager",
      location: "New York, NY",
      liveness: { result: "active", reason: "visible apply control" },
    }),
  });

  assert.equal(inputs.length, 2, JSON.stringify(result));
  assert.equal(result.presented, 1, JSON.stringify(result));
});

test("runAiWebSearch replaces a canonical row that cannot form a complete presented result", async () => {
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
        {
          name: "Hospitality operations",
          titles: ["Assistant General Manager"],
        },
      ],
      fit_bands: { fit_floor: 65 },
    },
  });
  saveSearchPrompts({
    repoRoot,
    prompts: [
      {
        id: "p1",
        text: "Find active Bar Manager and Head Bartender jobs in New York City",
      },
      {
        id: "p2",
        text: "Find active Assistant General Manager jobs in New York City",
      },
      { id: "p3", text: "Find active Event Operations jobs in New York City" },
    ],
  });

  const calls = new Map();
  const barManagerUrl = "https://bar-one.example/jobs/bar-manager";
  const missingLocationUrl = "https://yacht-club.example/jobs/head-bartender";
  const operationsUrl = "https://restaurant-two.example/jobs/assistant-general-manager";
  const replacementUrl = "https://bar-three.example/jobs/head-bartender";
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
                url: barManagerUrl,
              }),
              role({
                company: "The Yacht Club",
                title: "Head Bartender",
                location: "New York, NY",
                url: missingLocationUrl,
              }),
            ]
          : promptId === "p1"
            ? [
                role({
                  company: "Bar Three",
                  title: "Head Bartender",
                  location: "New York, NY",
                  url: replacementUrl,
                }),
              ]
            : promptId === "p2"
              ? [
                  role({
                    company: "Restaurant Two",
                    title: "Assistant General Manager",
                    location: "New York, NY",
                    url: operationsUrl,
                  }),
                ]
              : [];
      emitAssistantJson(onEvent, {
        roles,
        queries_run: [
          {
            prompt_id: promptId,
            query: `${promptId} query ${attempt}`,
            status: "completed",
          },
        ],
      });
      return { ok: true };
    },
    resolveJobUrlImpl: async (url) =>
      specificResolution(url, {
        location: url === missingLocationUrl ? "" : "New York, NY",
        liveness: { result: "active", reason: "visible apply control" },
      }),
  });

  assert.deepEqual(Object.fromEntries(calls), { p1: 2, p2: 1, p3: 1 });
  assert.equal(result.new, 3, JSON.stringify(result));
  assert.equal(result.presented, 3, JSON.stringify(result));
  assert.equal(result.invalid, 1, JSON.stringify(result));
  assert.deepEqual(result.reasonCounts, { identity: 1 });
  assert.deepEqual(result.canonicalDisqualifications, [
    {
      company: "The Yacht Club",
      title: "Head Bartender",
      url: missingLocationUrl,
      location: "",
      reason: "incomplete-presentation-identity:location",
    },
  ]);
  const rows = readDbScannerRows({ repoRoot }).filter((row) => row.source === "ai-web-search");
  assert.equal(rows.length, 3);
  assert.ok(rows.every((row) => row.company && row.role && row.loc && row.link));
  assert.doesNotMatch(JSON.stringify(rows), /The Yacht Club/);
});

test("runAiWebSearch continues prioritized useful-set recovery after an empty top-up", async () => {
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
            : promptId === "p1" && attempt === 3
              ? [
                  role({
                    company: "Bar Three",
                    title: "Head Bartender",
                    location: "New York, NY",
                    url: "https://bar-three.example/jobs/head-bartender",
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

  assert.deepEqual(Object.fromEntries(calls), { p1: 3, p2: 1, p3: 1 });
  assert.equal(receivedPlans.length, 5);
  assert.ok(receivedPlans.every((plan) => plan === executionPlan));
  assert.equal(result.new, 3, JSON.stringify(result));
  assert.equal(result.presented, 3, JSON.stringify(result));
});

test("runAiWebSearch carries partial-success canonical rejection evidence into its first top-up", async () => {
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
        { name: "Bar leadership", titles: ["Bar Manager", "Head Bartender", "Lead Bartender"] },
      ],
      fit_bands: { fit_floor: 65 },
    },
  });
  saveSearchPrompts({
    repoRoot,
    prompts: [
      {
        id: "p1",
        text: "Find active Bar Manager, Head Bartender, and Lead Bartender jobs in New York City",
      },
    ],
  });

  const activeUrl = "https://active-bar.example/jobs/bar-manager";
  const staleHost = "stale-board.example";
  const staleHeadUrl = `https://${staleHost}/jobs/head-bartender`;
  const staleLeadUrl = `https://${staleHost}/jobs/lead-bartender`;
  const replacementHeadUrl = "https://direct-head.example/jobs/head-bartender";
  const replacementLeadUrl = "https://direct-lead.example/jobs/lead-bartender";
  const inputs = [];
  const result = await runAiWebSearch({
    repoRoot,
    env: {},
    runSkillStream: async ({ input, onEvent }) => {
      inputs.push(input);
      const kickoff = typeof input === "string" ? JSON.parse(input.split("\n\n", 1)[0]) : input;
      const firstTopUp =
        typeof input === "string" && input.includes("canonical result set is still underfilled");
      const informedTopUp =
        firstTopUp &&
        input.includes(staleHeadUrl) &&
        input.includes(staleLeadUrl) &&
        input.includes(`"rejected_source_hosts":["${staleHost}"]`) &&
        input.includes("no longer available") &&
        input.includes("does not identify one specific job posting");
      const roles =
        inputs.length === 1
          ? [
              role({
                company: "Active Bar",
                title: "Bar Manager",
                location: "New York, NY",
                url: activeUrl,
              }),
              role({
                company: "Stale Head",
                title: "Head Bartender",
                location: "New York, NY",
                url: staleHeadUrl,
              }),
              role({
                company: "Stale Lead",
                title: "Lead Bartender",
                location: "New York, NY",
                url: staleLeadUrl,
              }),
            ]
          : informedTopUp
            ? [
                role({
                  company: "Direct Head",
                  title: "Head Bartender",
                  location: "New York, NY",
                  url: replacementHeadUrl,
                }),
                role({
                  company: "Direct Lead",
                  title: "Lead Bartender",
                  location: "New York, NY",
                  url: replacementLeadUrl,
                }),
              ]
            : [];
      emitAssistantJson(onEvent, {
        roles,
        queries_run: [
          {
            prompt_id: kickoff.prompts[0].id,
            query: `bar leadership query ${inputs.length}`,
            status: "completed",
          },
        ],
      });
      return { ok: true };
    },
    resolveJobUrlImpl: async (url) => {
      if (url === staleHeadUrl) {
        return specificResolution(url, {
          bodyText: fullJd("No longer available"),
          liveness: {
            result: "expired",
            reason: `The canonical posting at ${url} is no longer available.`,
          },
        });
      }
      if (url === staleLeadUrl) {
        return {
          bodyFetchStatus: "unavailable",
          bodyFetchReason: "The job description could not be read from the canonical page.",
          bodyText: "",
          url,
        };
      }
      return specificResolution(url, {
        location: "New York, NY",
        title:
          url === activeUrl
            ? "Bar Manager"
            : url === replacementHeadUrl
              ? "Head Bartender"
              : "Lead Bartender",
        liveness: { result: "active", reason: "visible apply control" },
      });
    },
  });

  const firstTopUpInput = inputs.find(
    (input) =>
      typeof input === "string" && input.includes("canonical result set is still underfilled")
  );
  assert.ok(firstTopUpInput);
  assert.match(firstTopUpInput, /no longer available/i);
  assert.match(firstTopUpInput, /does not identify one specific job posting/i);
  assert.match(firstTopUpInput, /"rejected_source_hosts":\["stale-board\.example"\]/);
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

test("runAiWebSearch keeps successful saved-prompt coverage when an auxiliary top-up fails", async () => {
  const repoRoot = repo({ prompts: 1 });
  candidateConfigPatch({
    repoRoot,
    name: "targeting",
    patch: {
      role_buckets: [{ name: "Applied AI", titles: ["Applied AI Engineer"] }],
      fit_bands: { fit_floor: 0 },
    },
  });
  saveSearchPrompts({
    repoRoot,
    prompts: [{ id: "p1", text: "Find Applied AI Engineer jobs" }],
  });
  let calls = 0;
  const result = await runAiWebSearch({
    repoRoot,
    env: {},
    runSkillStream: async ({ input, onEvent }) => {
      calls += 1;
      const kickoff = typeof input === "string" ? JSON.parse(input.split("\n\n", 1)[0]) : input;
      if (calls === 1) {
        emitAssistantJson(onEvent, {
          roles: [role()],
          queries_run: [
            { prompt_id: kickoff.prompts[0].id, query: "Applied AI jobs", status: "completed" },
          ],
        });
        return { ok: true };
      }
      return { ok: false, error: "The additional search timed out." };
    },
    resolveJobUrlImpl: canonicalResolver(),
  });

  assert.equal(calls, 2);
  assert.equal(result.new, 1, JSON.stringify(result));
  assert.deepEqual(result.failedPromptIds, []);
  assert.equal(result.queryResults[0].status, "completed");
  assert.deepEqual(result.errors, []);
  assert.match(result.warnings.join(" "), /couldn't finish/i);
  assert.ok(result.queryResults[0].queries.some((query) => query.status === "completed"));
  assert.ok(result.queryResults[0].queries.some((query) => query.status === "failed"));
});

test("runAiWebSearch warns on a schema-valid auxiliary query failure without changing prompt authority", async () => {
  const repoRoot = repo({ prompts: 1 });
  candidateConfigPatch({
    repoRoot,
    name: "targeting",
    patch: {
      role_buckets: [{ name: "Applied AI", titles: ["Applied AI Engineer"] }],
      fit_bands: { fit_floor: 0 },
    },
  });
  saveSearchPrompts({
    repoRoot,
    prompts: [{ id: "p1", text: "Find Applied AI Engineer jobs" }],
  });
  let calls = 0;
  const warning = "The additional search query timed out.";
  const result = await runAiWebSearch({
    repoRoot,
    env: {},
    runSkillStream: async ({ input, onEvent }) => {
      calls += 1;
      const kickoff = typeof input === "string" ? JSON.parse(input.split("\n\n", 1)[0]) : input;
      emitAssistantJson(onEvent, {
        roles: calls === 1 ? [role()] : [],
        queries_run: [
          {
            prompt_id: kickoff.prompts[0].id,
            query: calls === 1 ? "Applied AI jobs" : "More Applied AI jobs",
            status: calls === 1 ? "completed" : "failed",
            error: calls === 1 ? null : warning,
          },
        ],
      });
      return { ok: true };
    },
    resolveJobUrlImpl: canonicalResolver(),
  });

  assert.equal(calls, 2);
  assert.equal(result.new, 1, JSON.stringify(result));
  assert.deepEqual(result.failedPromptIds, []);
  assert.equal(result.queryResults[0].status, "completed");
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.warnings, [warning]);
  assert.ok(result.queryResults[0].queries.some((query) => query.error === warning));
});

test("runAiWebSearch keeps failed freshness recovery authoritative when no row was saved", async () => {
  const repoRoot = repo({ prompts: 1 });
  let calls = 0;
  const result = await runAiWebSearch({
    repoRoot,
    env: {},
    runSkillStream: async ({ input, onEvent }) => {
      calls += 1;
      const kickoff = typeof input === "string" ? JSON.parse(input.split("\n\n", 1)[0]) : input;
      if (calls === 1) {
        emitAssistantJson(onEvent, {
          roles: [role({ url: "https://unreadable.example/jobs/role" })],
          queries_run: [
            { prompt_id: kickoff.prompts[0].id, query: "initial query", status: "completed" },
          ],
        });
        return { ok: true };
      }
      return { ok: false, error: "Freshness recovery timed out." };
    },
    resolveJobUrlImpl: async (url) => ({
      bodyFetchStatus: "resolved",
      url,
      bodyText: "This requisition is no longer available.",
      liveness: {
        result: "expired",
        reason: "This requisition is no longer available.",
      },
    }),
  });

  assert.equal(calls, 3);
  assert.equal(result.new, 0);
  assert.deepEqual(result.failedPromptIds, ["p1"]);
  assert.equal(result.queryResults[0].status, "failed");
  assert.match(result.errors.join(" "), /couldn't finish/i);
  assert.deepEqual(result.warnings, []);
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

  let failedCalls = 0;
  const failed = await runAiWebSearch({
    repoRoot,
    env: {},
    runSkillStream: async ({ onEvent }) => {
      failedCalls += 1;
      onEvent({
        type: "assistant",
        data: { message: { content: [{ type: "text", text: "still invalid" }] } },
      });
    },
  });
  assert.equal(failedCalls, 2, "schema exhaustion gets its correction only, not a prompt replay");
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
      queries: Array(4).fill({ query: "first query", status: "completed", error: null }),
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

test("runAiWebSearch prioritizes prompt-matched enabled public source hints within the fixed query budget", async () => {
  const repoRoot = repo({ prompts: 1 });
  candidateConfigPatch({
    repoRoot,
    name: "profile",
    patch: {
      location: { home: "New York, NY", remote: false, hybrid: true, onsite: true },
    },
  });
  candidateConfigPatch({
    repoRoot,
    name: "targeting",
    patch: {
      role_buckets: [{ name: "Field operations", titles: ["Field Operations Manager"] }],
      fit_bands: { fit_floor: 0 },
    },
  });
  saveSearchPrompts({
    repoRoot,
    prompts: [{ id: "p1", text: "Find Field Operations Manager jobs in New York City" }],
  });
  sourceConfigPut({
    repoRoot,
    name: "search-sources",
    data: {
      searches: [
        {
          provider: "specialist.example",
          source_type: "browser",
          label: "Field Operations Manager board",
          url: "https://specialist.example/jobs?role=field-operations",
          enabled: true,
        },
        {
          provider: "other.example",
          source_type: "browser",
          label: "Other roles",
          url: "https://other.example/jobs",
          enabled: true,
        },
        {
          provider: "disabled.example",
          source_type: "browser",
          label: "Field Operations Manager disabled",
          url: "https://disabled.example/jobs",
          enabled: false,
        },
        {
          provider: "skipped.example",
          source_type: "browser",
          label: "Field Operations Manager skipped",
          url: "https://skipped.example/jobs",
          enabled: true,
          login_skipped: true,
        },
        {
          provider: "private.example",
          source_type: "browser",
          label: "Field Operations Manager private",
          url: "http://127.0.0.1/jobs",
          enabled: true,
        },
      ],
    },
  });
  const inputs = [];

  await runAiWebSearch({
    repoRoot,
    env: {},
    runSkillStream: async ({ input, onEvent }) => {
      inputs.push(input);
      emitAssistantJson(onEvent, {
        roles: [],
        queries_run: [{ prompt_id: "p1", query: "field operations", status: "completed" }],
      });
      return { ok: true };
    },
  });

  const plan = inputs[0].search_plan;
  assert.equal(plan.query_hints.length, 2);
  assert.equal(plan.source_hints[0], "specialist.example");
  assert.ok(plan.source_hints.includes("other.example"));
  assert.doesNotMatch(
    JSON.stringify(plan),
    /disabled\.example|skipped\.example|127\.0\.0\.1|role=field-operations/
  );
  assert.match(plan.query_hints[1].query, /site:specialist\.example/);
  for (const { query } of plan.query_hints) {
    assert.ok(query.length <= 100, query);
    assert.equal((query.match(/"/g) || []).length % 2, 0, query);
    assert.equal((query.match(/\(/g) || []).length, (query.match(/\)/g) || []).length, query);
  }
});

test("runAiWebSearch uses deterministic coverage to plan unresolved sources and skip known postings", async () => {
  const repoRoot = repo({ prompts: 1 });
  candidateConfigPatch({
    repoRoot,
    name: "profile",
    patch: {
      location: { home: "New York, NY", remote: false, hybrid: true, onsite: true },
    },
  });
  candidateConfigPatch({
    repoRoot,
    name: "targeting",
    patch: {
      role_buckets: [
        {
          name: "Operations",
          titles: [
            "Field Operations Manager",
            "Venue Services Manager",
            "Customer Operations Manager",
          ],
        },
      ],
      fit_bands: { fit_floor: 0 },
    },
  });
  saveSearchPrompts({
    repoRoot,
    prompts: [
      {
        id: "p1",
        text: "Find Field Operations Manager, Venue Services Manager, and Customer Operations Manager jobs in New York City",
      },
    ],
  });
  sourceConfigPut({
    repoRoot,
    name: "search-sources",
    data: {
      searches: [
        {
          source_type: "browser",
          label: "Operations source with results",
          url: "https://covered.example/jobs",
          enabled: true,
        },
        {
          source_type: "browser",
          label: "Operations source with no deterministic matches",
          url: "https://zero.example/jobs",
          enabled: true,
        },
        {
          source_type: "browser",
          label: "Operations source that could not be read",
          url: "https://failed.example/jobs",
          enabled: true,
        },
        {
          source_type: "browser",
          label: "Operations source that needs login",
          url: "https://login.example/jobs",
          enabled: true,
        },
        {
          source_type: "browser",
          label: "Company ATS source already scanned deterministically",
          url: "https://jobs.ashbyhq.com/example-company",
          enabled: true,
        },
      ],
    },
  });
  const knownUrl = "https://covered.example/jobs/existing-field";
  const knownReqUrl = "https://job-boards.greenhouse.io/example/jobs/1234567";
  const alternateKnownReqUrl = "https://boards.greenhouse.io/example/jobs/1234567";
  const hydrationUrls = [];
  const inputs = [];

  const result = await runAiWebSearch({
    repoRoot,
    env: {},
    deterministic: {
      status: "succeeded",
      sources: [
        {
          kind: "configured",
          label: "Operations source with results",
          host: "covered.example",
          status: "success",
          found: 1,
        },
        {
          kind: "configured",
          label: "Operations source with no deterministic matches",
          host: "zero.example",
          status: "zero",
          found: 0,
        },
        {
          kind: "configured",
          label: "Operations source that could not be read",
          host: "failed.example",
          status: "failed",
          found: 0,
        },
        {
          kind: "configured",
          label: "Operations source that needs login",
          host: "login.example",
          status: "login-required",
          found: 0,
        },
        {
          kind: "company",
          label: "Company ATS source already scanned deterministically",
          host: "jobs.ashbyhq.com",
          company: "Example Company",
          status: "success",
          found: 1,
        },
        {
          kind: "company",
          label: "Company source with no deterministic matches",
          host: "zero-company.example",
          company: "Zero Company",
          status: "zero",
          found: 0,
        },
      ],
      offers: [
        {
          company: "Existing Operations Company",
          title: "Field Operations Manager",
          url: knownUrl,
        },
        {
          company: "Known Venue Company",
          title: "Venue Services Manager",
          url: knownReqUrl,
        },
      ],
    },
    runSkillStream: async ({ input, onEvent }) => {
      inputs.push(input);
      emitAssistantJson(onEvent, {
        roles: [
          role({
            company: "Existing Operations Company",
            title: "Field Operations Manager",
            url: knownUrl,
          }),
          role({
            company: "Known Venue Company",
            title: "Venue Services Manager",
            url: alternateKnownReqUrl,
          }),
          role({
            company: "Existing Operations Company",
            title: "Field Operations Manager",
            url: "https://covered.example/jobs/another-field-requisition",
          }),
          role({
            company: "Fresh Field Company",
            title: "Field Operations Manager",
            url: "https://fresh.example/jobs/field",
          }),
          role({
            company: "Fresh Venue Company",
            title: "Venue Services Manager",
            url: "https://fresh.example/jobs/venue",
          }),
          role({
            company: "Fresh Customer Company",
            title: "Customer Operations Manager",
            url: "https://fresh.example/jobs/customer",
          }),
        ],
        queries_run: [
          {
            prompt_id: "p1",
            query: "unresolved operations sources",
            status: "completed",
          },
        ],
      });
      return { ok: true };
    },
    resolveJobUrlImpl: async (url) => {
      hydrationUrls.push(url);
      return specificResolution(url, {
        title: url.endsWith("/venue")
          ? "Venue Services Manager"
          : url.endsWith("/customer")
            ? "Customer Operations Manager"
            : "Field Operations Manager",
        location: "New York, NY",
        liveness: { result: "active", reason: "visible apply control" },
      });
    },
  });

  assert.equal(inputs.length, 1);
  const plan = inputs[0].search_plan;
  assert.deepEqual(plan.source_hints, [
    "failed.example",
    "zero.example",
    "login.example",
    "jobs.ashbyhq.com",
  ]);
  assert.doesNotMatch(JSON.stringify(plan.source_hints), /covered\.example/);
  assert.deepEqual(plan.deterministic_coverage, {
    covered_companies: ["Existing Operations Company", "Known Venue Company", "Example Company"],
    known_postings: [
      {
        company: "Existing Operations Company",
        title: "Field Operations Manager",
        url: knownUrl,
      },
      {
        company: "Known Venue Company",
        title: "Venue Services Manager",
        url: knownReqUrl,
      },
    ],
    sources: [
      { host: "covered.example", status: "success", found: 1 },
      { host: "zero.example", status: "zero", found: 0 },
      { host: "failed.example", status: "failed", found: 0 },
      { host: "login.example", status: "login-required", found: 0 },
      {
        host: "jobs.ashbyhq.com",
        company: "Example Company",
        status: "success",
        found: 1,
      },
      {
        host: "zero-company.example",
        company: "Zero Company",
        status: "zero",
        found: 0,
      },
    ],
  });
  assert.equal(hydrationUrls.includes(knownUrl), false);
  assert.equal(hydrationUrls.includes(alternateKnownReqUrl), false);
  assert.equal(
    hydrationUrls.includes("https://covered.example/jobs/another-field-requisition"),
    true
  );
  assert.equal(result.new, 4, JSON.stringify(result));
  assert.ok(result.duplicates >= 1, JSON.stringify(result));
  assert.deepEqual(result.canonicalOverlaps, []);

  const runOverlapProof = (completeFetch) =>
    runAiWebSearch({
      repoRoot,
      env: {},
      deterministic: {
        status: "succeeded",
        sources: [],
        offers: [
          {
            company: "Existing Operations Company",
            title: "Field Operations Manager",
            url: knownUrl,
          },
        ],
      },
      runSkillStream: async ({ onEvent }) => {
        onEvent({
          type: "tool_use",
          data: { id: "known-fetch", name: "WebFetch", input: { url: knownUrl } },
        });
        if (completeFetch) {
          onEvent({
            type: "tool_result",
            data: { toolUseId: "known-fetch", isError: false, content: "Posting body" },
          });
        }
        emitAssistantJson(onEvent, {
          roles: [
            role({
              company: "Existing Operations Company",
              title: "Field Operations Manager",
              url: knownUrl,
            }),
          ],
          queries_run: [
            {
              prompt_id: "p1",
              query: "verify deterministic operations posting",
              status: "completed",
            },
          ],
        });
        return { ok: true };
      },
      resolveJobUrlImpl: async (url) =>
        specificResolution(url, {
          title: "Field Operations Manager",
          location: "New York, NY",
          liveness: { result: "active", reason: "visible apply control" },
        }),
    });

  const fetchedResult = await runOverlapProof(true);

  assert.deepEqual(fetchedResult.canonicalOverlaps, [
    {
      promptId: "p1",
      url: knownUrl,
    },
  ]);
  const abandonedFetchResult = await runOverlapProof(false);
  assert.deepEqual(abandonedFetchResult.canonicalOverlaps, []);
});

test("runAiWebSearch recovery excludes a rejected common ATS host and keeps one source snapshot", async () => {
  const repoRoot = repo({ prompts: 1 });
  candidateConfigPatch({
    repoRoot,
    name: "targeting",
    patch: {
      role_buckets: [{ name: "Field operations", titles: ["Field Operations Manager"] }],
      fit_bands: { fit_floor: 0 },
    },
  });
  saveSearchPrompts({
    repoRoot,
    prompts: [{ id: "p1", text: "Find Field Operations Manager jobs" }],
  });
  const firstSourceConfig = {
    searches: [
      {
        provider: "greenhouse",
        source_type: "browser",
        label: "Field Operations Manager one",
        url: "https://job-boards.greenhouse.io/550/jobs/5186736008",
        enabled: true,
      },
      {
        provider: "source-two.example",
        source_type: "browser",
        label: "Field Operations Manager two",
        url: "https://source-two.example/jobs",
        enabled: true,
      },
    ],
  };
  sourceConfigPut({ repoRoot, name: "search-sources", data: firstSourceConfig });
  const rejectedUrls = new Set([
    "https://job-boards.greenhouse.io/550/jobs/5186736008",
    "https://job-boards.greenhouse.io/550/jobs/4919621008",
  ]);
  const inputs = [];

  await runAiWebSearch({
    repoRoot,
    env: {},
    runSkillStream: async ({ input, onEvent }) => {
      inputs.push(input);
      const kickoff = typeof input === "string" ? JSON.parse(input.split("\n\n", 1)[0]) : input;
      if (inputs.length === 1) {
        sourceConfigPut({
          repoRoot,
          name: "search-sources",
          data: {
            searches: [
              ...firstSourceConfig.searches,
              {
                provider: "source-three.example",
                source_type: "browser",
                label: "Field Operations Manager three",
                url: "https://source-three.example/jobs",
                enabled: true,
              },
            ],
          },
        });
      }
      emitAssistantJson(onEvent, {
        roles:
          inputs.length === 1
            ? [
                role({
                  company: "Expired Field One",
                  title: "Field Operations Manager",
                  url: [...rejectedUrls][0],
                }),
                role({
                  company: "Expired Field Two",
                  title: "Field Operations Manager",
                  url: [...rejectedUrls][1],
                }),
              ]
            : [1, 2, 3].map((index) =>
                role({
                  company: `Fresh Field ${index}`,
                  title: "Field Operations Manager",
                  url: `https://source-two.example/jobs/fresh-${index}`,
                })
              ),
        queries_run: [
          {
            prompt_id: kickoff.prompts[0].id,
            query: `field query ${inputs.length}`,
            status: "completed",
          },
        ],
      });
      return { ok: true };
    },
    resolveJobUrlImpl: async (url) =>
      rejectedUrls.has(url)
        ? specificResolution(url, {
            title: "Field Operations Manager",
            liveness: { result: "expired", reason: "The posting is no longer active." },
          })
        : specificResolution(url, {
            title: "Field Operations Manager",
            liveness: { result: "active", reason: "visible apply control" },
          }),
  });

  const initialPlan = inputs[0].search_plan;
  const recoveryPlan = JSON.parse(inputs[1].split("\n\n", 1)[0]).search_plan;
  assert.equal(initialPlan.source_hints[0], "job-boards.greenhouse.io");
  assert.doesNotMatch(
    JSON.stringify(recoveryPlan.source_hints),
    /job-boards\.greenhouse\.io|source-three\.example/
  );
  assert.doesNotMatch(
    JSON.stringify(recoveryPlan.query_hints),
    /job-boards\.greenhouse\.io|source-three\.example/
  );
  assert.equal(recoveryPlan.source_hints[0], "source-two.example");
  assert.match(recoveryPlan.query_hints[1].query, /site:source-two\.example/);
  assert.equal(recoveryPlan.query_hints.length, 2);
  assert.ok(recoveryPlan.query_hints.every(({ query }) => query.length <= 100));
});

test("runAiWebSearch rotates split recovery hints after excluding the first viable ATS", async () => {
  const repoRoot = repo({ prompts: 1 });
  const titles = ["Developer Infrastructure Engineer", "Developer Experience Engineer"];
  candidateConfigPatch({
    repoRoot,
    name: "profile",
    patch: {
      location: {
        home: "New York, NY",
        remote: true,
        remote_scope: "home-country",
        hybrid: true,
        onsite: false,
        relocation: [],
      },
    },
  });
  candidateConfigPatch({
    repoRoot,
    name: "targeting",
    patch: {
      role_buckets: [{ name: "Developer infrastructure", titles }],
      fit_bands: { fit_floor: 0 },
    },
  });
  saveSearchPrompts({
    repoRoot,
    prompts: [
      {
        id: "p1",
        text: `Find ${titles.join(" and ")} roles that are remote in the United States.`,
      },
    ],
  });
  const rejectedUrls = new Set([
    "https://jobs.lever.co/example/developer-infrastructure",
    "https://jobs.lever.co/example/developer-experience",
  ]);
  const inputs = [];

  await runAiWebSearch({
    repoRoot,
    env: {},
    runSkillStream: async ({ input, onEvent }) => {
      inputs.push(input);
      const kickoff = typeof input === "string" ? JSON.parse(input.split("\n\n", 1)[0]) : input;
      emitAssistantJson(onEvent, {
        roles:
          inputs.length === 1
            ? titles.map((title, index) =>
                role({
                  company: `Expired Infrastructure ${index + 1}`,
                  title,
                  location: "Remote, United States",
                  url: [...rejectedUrls][index],
                })
              )
            : [
                role({
                  company: "Fresh Infrastructure One",
                  title: titles[0],
                  location: "Remote, United States",
                  url: "https://fresh-one.example/jobs/developer-infrastructure",
                }),
                role({
                  company: "Fresh Infrastructure Two",
                  title: titles[1],
                  location: "Remote, United States",
                  url: "https://fresh-two.example/jobs/developer-experience",
                }),
                role({
                  company: "Fresh Infrastructure Three",
                  title: titles[0],
                  location: "Remote, United States",
                  url: "https://fresh-three.example/jobs/developer-infrastructure",
                }),
              ],
        queries_run: [
          {
            prompt_id: kickoff.prompts[0].id,
            query: `developer infrastructure ${inputs.length}`,
            status: "completed",
          },
        ],
      });
      return { ok: true };
    },
    resolveJobUrlImpl: async (url) =>
      rejectedUrls.has(url)
        ? specificResolution(url, {
            location: "Remote, United States",
            liveness: { result: "expired", reason: "The posting is no longer active." },
          })
        : specificResolution(url, {
            location: "Remote, United States",
            liveness: { result: "active", reason: "visible apply control" },
          }),
  });

  const recoveryPlan = JSON.parse(inputs[1].split("\n\n", 1)[0]).search_plan;
  const directAtsHosts = recoveryPlan.query_hints
    .map(({ query }) => query.match(/site:([^ )]+)/i)?.[1])
    .filter(Boolean);
  assert.equal(directAtsHosts.includes("jobs.lever.co"), false);
  assert.equal(new Set(directAtsHosts).size, 2, JSON.stringify(recoveryPlan.query_hints));
  assert.ok(recoveryPlan.query_hints.every(({ query }) => query.length <= 100));
});

test("runAiWebSearch top-up prioritizes the configured source for the missing title", async () => {
  const repoRoot = repo({ prompts: 1 });
  candidateConfigPatch({
    repoRoot,
    name: "targeting",
    patch: {
      role_buckets: [
        {
          name: "Operations leadership",
          titles: ["Field Operations Manager", "Venue Services Manager"],
        },
      ],
      fit_bands: { fit_floor: 0 },
    },
  });
  saveSearchPrompts({
    repoRoot,
    prompts: [{ id: "p1", text: "Find Field Operations Manager and Venue Services Manager jobs" }],
  });
  sourceConfigPut({
    repoRoot,
    name: "search-sources",
    data: {
      searches: [
        {
          provider: "field.example",
          source_type: "browser",
          label: "Field Operations Manager board",
          url: "https://field.example/jobs",
          enabled: true,
        },
        {
          provider: "venue.example",
          source_type: "browser",
          label: "Venue Services Manager board",
          url: "https://venue.example/jobs",
          enabled: true,
        },
      ],
    },
  });
  const inputs = [];

  await runAiWebSearch({
    repoRoot,
    env: {},
    runSkillStream: async ({ input, onEvent }) => {
      inputs.push(input);
      const kickoff = typeof input === "string" ? JSON.parse(input.split("\n\n", 1)[0]) : input;
      emitAssistantJson(onEvent, {
        roles:
          inputs.length === 1
            ? [
                role({
                  company: "Initial Field",
                  title: "Field Operations Manager",
                  url: "https://field.example/jobs/initial",
                }),
              ]
            : [1, 2].map((index) =>
                role({
                  company: `Fresh Venue ${index}`,
                  title: "Venue Services Manager",
                  url: `https://venue.example/jobs/fresh-${index}`,
                })
              ),
        queries_run: [
          {
            prompt_id: kickoff.prompts[0].id,
            query: `operations query ${inputs.length}`,
            status: "completed",
          },
        ],
      });
      return { ok: true };
    },
    resolveJobUrlImpl: canonicalResolver({
      liveness: { result: "active", reason: "visible apply control" },
    }),
  });

  const topUpPlan = JSON.parse(inputs[1].split("\n\n", 1)[0]).search_plan;
  assert.equal(topUpPlan.source_hints[0], "venue.example");
  assert.match(topUpPlan.query_hints[0].query, /site:venue\.example/);
  assert.equal(topUpPlan.query_hints.length, 2);
  assert.ok(topUpPlan.query_hints.every(({ query }) => query.length <= 100));
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
