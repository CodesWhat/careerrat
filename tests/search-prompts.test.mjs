// tests/search-prompts.test.mjs
// node:test suite for buildSearchPromptContext()'s opt-in company-history +
// application-limit digest (search-prompts.mjs) — the AI web-search lane's
// only reachable source for the search-jobs STEP 3 `company-history-*` /
// `app-limit-*` triage flags (see ai-web-search.mjs, which is the one caller
// that sets includeSearchLimits: true). Uses a real ephemeral SQLite
// candidate DB (same fixture pattern as tests/ai-web-search.test.mjs) so the
// summary is exercised against the real tracker read path
// (db/scan-context.mjs's buildDbSeenSets), not a mock.

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

import { closeAll } from "../src/core/db/connection.mjs";
import { sourcedUpsertBatch } from "../src/core/db/verbs/sourced.mjs";
import {
  appUpsert,
  candidateConfigPatch,
  candidateSetupInitialize,
} from "../src/core/db/verbs.mjs";
import {
  buildSearchPromptContext,
  generateSearchPrompts,
  getSearchPrompts,
  saveSearchPrompts,
} from "../src/core/search/search-prompts.mjs";

const roots = [];

function repo() {
  const repoRoot = mkdtempSync(join(tmpdir(), "careerrat-search-prompts-"));
  roots.push(repoRoot);
  candidateSetupInitialize({ repoRoot });
  return repoRoot;
}

after(() => {
  closeAll();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

test("saved search prompts carry the candidate-input fingerprint they were generated from", () => {
  const repoRoot = repo();
  candidateConfigPatch({
    repoRoot,
    name: "targeting",
    patch: {
      role_buckets: [
        {
          name: "Engineering",
          priority: "primary",
          titles: ["Staff Software Engineer"],
        },
      ],
    },
  });

  saveSearchPrompts({
    repoRoot,
    prompts: [{ text: "Find remote Staff Software Engineer roles" }],
    defaultSource: "generated",
  });

  const fresh = getSearchPrompts({ repoRoot });
  assert.match(fresh.inputFingerprint, /^[a-f0-9]{64}$/);
  assert.equal(fresh.savedInputFingerprint, fresh.inputFingerprint);

  candidateConfigPatch({
    repoRoot,
    name: "profile",
    patch: { location: { home: "New York, NY", remote: true } },
  });

  const stale = getSearchPrompts({ repoRoot });
  assert.notEqual(stale.inputFingerprint, fresh.inputFingerprint);
  assert.equal(stale.savedInputFingerprint, fresh.savedInputFingerprint);
});

test("generateSearchPrompts uses the exact frozen research.web execution plan", async () => {
  const repoRoot = repo();
  const executionPlan = {
    policyVersion: 1,
    operation: "research.web",
    runtimeId: "codex",
    adapterVersion: 1,
    requested: { quality: "balanced", reasoning: "medium" },
    resolved: {
      quality: "balanced",
      reasoning: "medium",
      model: "gpt-5.6-terra",
      modelSource: "alias",
      effort: "medium",
      speedTier: null,
    },
    fallback: null,
  };
  const signal = new AbortController().signal;
  let received;

  const outcome = await generateSearchPrompts({
    repoRoot,
    config: {
      targeting: {
        role_buckets: [{ name: "Engineering", titles: ["Staff Software Engineer"] }],
      },
      profile: {},
    },
    executionPlan,
    signal,
    call: async (options) => {
      received = options;
      return {
        text: JSON.stringify({
          prompts: [
            { text: "Find Staff Software Engineer roles." },
            { text: "Find senior software engineering openings." },
          ],
        }),
        executionPlan: options.executionPlan,
      };
    },
  });

  assert.equal(outcome.body.ok, true);
  assert.deepEqual(received.executionPlan, executionPlan);
  assert.equal(received.useExecutionPlanRoute, true);
  assert.equal(received.signal, signal);
  assert.deepEqual(outcome.body.ai.executionPlan, executionPlan);
});

test("generateSearchPrompts defines minimum_base as an annual base-salary floor", async () => {
  const repoRoot = repo();
  let received;

  const outcome = await generateSearchPrompts({
    repoRoot,
    config: {
      targeting: {
        role_buckets: [{ name: "Operations", titles: ["Operations Manager"] }],
      },
      profile: {
        compensation: { currency: "USD", minimum_base: 85_000 },
      },
    },
    call: async (options) => {
      received = options;
      return {
        text: JSON.stringify({
          prompts: [
            { text: "Find Operations Manager roles with an $85,000 annual base salary." },
            { text: "Find operations leadership openings with an $85,000 base salary." },
          ],
        }),
      };
    },
  });

  assert.equal(outcome.body.ok, true);
  const instructions = received.messages[0].content;
  assert.match(instructions, /minimum_base is a hard annual base-salary floor/i);
  assert.match(instructions, /lower bound must meet or exceed minimum_base/i);
  assert.match(instructions, /tips, commissions, bonuses, equity, OTE, or total compensation/i);
  assert.match(instructions, /compensation is not posted, keep it unverified/i);
});

test("buildSearchPromptContext: omits application_limits/company_history by default", () => {
  const repoRoot = repo();
  candidateConfigPatch({
    repoRoot,
    name: "application-limits",
    patch: { companies: [{ company: "Blocked Co", status: "blocked" }] },
  });
  appUpsert({
    repoRoot,
    row: {
      id: "app-1",
      company: "Active Co",
      role: "Engineer",
      status: "awaiting",
    },
  });

  const context = buildSearchPromptContext({
    repoRoot,
    config: { targeting: {}, profile: {} },
  });

  assert.equal(Object.hasOwn(context, "application_limits"), false);
  assert.equal(Object.hasOwn(context, "company_history"), false);
});

test("buildSearchPromptContext (includeSearchLimits): carries only caution/blocked companies, never ok", () => {
  const repoRoot = repo();

  const context = buildSearchPromptContext({
    repoRoot,
    config: {
      targeting: {},
      profile: {},
      "application-limits": {
        companies: [
          {
            company: "Blocked Co",
            status: "blocked",
            reapply_after: "2027-01-01",
          },
          { company: "Caution Co", status: "caution" },
          { company: "Fine Co", status: "ok" },
        ],
      },
    },
    includeSearchLimits: true,
  });

  assert.deepEqual(context.application_limits, [
    { company: "Blocked Co", status: "blocked", reapply_after: "2027-01-01" },
    { company: "Caution Co", status: "caution" },
  ]);
});

test("buildSearchPromptContext (includeSearchLimits): reads application-limits from the passed config, not a fresh DB read", () => {
  const repoRoot = repo();
  // Nothing written to the DB — only the config object passed in carries the
  // blocked company, proving the summary is built from `config`, not a second
  // candidateConfigGet() call.
  const context = buildSearchPromptContext({
    repoRoot,
    config: {
      targeting: {},
      profile: {},
      "application-limits": {
        companies: [{ company: "From Config Co", status: "blocked" }],
      },
    },
    includeSearchLimits: true,
  });

  assert.deepEqual(context.application_limits, [{ company: "From Config Co", status: "blocked" }]);
});

test("buildSearchPromptContext (includeSearchLimits): flags an active application", () => {
  const repoRoot = repo();
  appUpsert({
    repoRoot,
    row: {
      id: "app-1",
      company: "Active Co",
      role: "Engineer",
      status: "awaiting",
    },
  });

  const context = buildSearchPromptContext({
    repoRoot,
    config: { targeting: {}, profile: {} },
    includeSearchLimits: true,
  });

  assert.deepEqual(context.company_history, [{ company: "Active Co", flags: ["active"] }]);
});

test("buildSearchPromptContext (includeSearchLimits): flags a rejection within 90 days, not an older one", () => {
  const repoRoot = repo();
  const recent = new Date();
  recent.setDate(recent.getDate() - 10);
  const stale = new Date();
  stale.setDate(stale.getDate() - 400);

  appUpsert({
    repoRoot,
    row: {
      id: "app-recent",
      company: "Recent Rejection Co",
      role: "Engineer",
      status: "rejected",
      appliedAt: recent.toISOString(),
    },
  });
  appUpsert({
    repoRoot,
    row: {
      id: "app-stale",
      company: "Old Rejection Co",
      role: "Engineer",
      status: "rejected",
      appliedAt: stale.toISOString(),
    },
  });

  const context = buildSearchPromptContext({
    repoRoot,
    config: { targeting: {}, profile: {} },
    includeSearchLimits: true,
  });

  assert.deepEqual(context.company_history, [
    { company: "Recent Rejection Co", flags: ["recent-rejection"] },
  ]);
});

test("buildSearchPromptContext (includeSearchLimits): flags a prior sourced cut", () => {
  const repoRoot = repo();
  sourcedUpsertBatch({
    repoRoot,
    rows: [
      {
        id: "sourced-1",
        company: "Prior Cut Co",
        role: "Engineer",
        status: "cut",
        source: "scanner",
        channel: "board",
        link: "https://example.test/prior-cut",
        loc: "Remote",
        base: "verify",
        fitScore: 40,
        fitBucket: "stretch",
        fitBasis: "triage",
        gate: "cut",
        sourcedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        artifacts: {},
      },
    ],
  });

  const context = buildSearchPromptContext({
    repoRoot,
    config: { targeting: {}, profile: {} },
    includeSearchLimits: true,
  });

  assert.deepEqual(context.company_history, [
    { company: "Prior Cut Co", flags: ["prior-sourced"] },
  ]);
});

test("buildSearchPromptContext (includeSearchLimits): omits company_history entirely when the tracker has no flaggable rows", () => {
  const repoRoot = repo();
  appUpsert({
    repoRoot,
    row: {
      id: "app-1",
      company: "Quiet Co",
      role: "Engineer",
      status: "offer",
    },
  });

  const context = buildSearchPromptContext({
    repoRoot,
    config: { targeting: {}, profile: {} },
    includeSearchLimits: true,
  });

  assert.equal(Object.hasOwn(context, "company_history"), false);
});

test("buildSearchPromptContext: carries top-level keep_signals/cut_signals from targeting", () => {
  const repoRoot = repo();

  const context = buildSearchPromptContext({
    repoRoot,
    config: {
      targeting: {
        keep_signals: ["customer-facing deploy-and-adopt", "RAG, agents, tool use"],
        cut_signals: ["core platform SWE with no AI surface"],
      },
      profile: {},
    },
  });

  assert.deepEqual(context.keep_signals, [
    "customer-facing deploy-and-adopt",
    "RAG, agents, tool use",
  ]);
  assert.deepEqual(context.cut_signals, ["core platform SWE with no AI surface"]);
});

test("buildSearchPromptContext: omits keep_signals/cut_signals when absent or empty", () => {
  const repoRoot = repo();

  const context = buildSearchPromptContext({
    repoRoot,
    config: { targeting: { keep_signals: [], cut_signals: [] }, profile: {} },
  });

  assert.equal(Object.hasOwn(context, "keep_signals"), false);
  assert.equal(Object.hasOwn(context, "cut_signals"), false);
});

test("buildSearchPromptContext carries explicit worldwide remote scope and defaults older profiles to home-country", () => {
  const repoRoot = repo();
  const worldwide = buildSearchPromptContext({
    repoRoot,
    config: {
      targeting: {},
      profile: {
        location: {
          home: "New York, NY, United States",
          remote: true,
          remote_scope: "worldwide",
          hybrid: true,
          onsite: true,
          max_commute_days_per_week: 2,
        },
      },
    },
  });
  const legacy = buildSearchPromptContext({
    repoRoot,
    config: {
      targeting: {},
      profile: { location: { home: "London, UK", remote: true } },
    },
  });

  assert.deepEqual(worldwide.location, {
    remote: true,
    remote_scope: "worldwide",
    hybrid: true,
    onsite: true,
    max_office_days_per_week: 2,
    home: "New York, NY, United States",
  });
  assert.equal(legacy.location.remote_scope, "home-country");
});

test("buildSearchPromptContext: top-level keep/cut signals don't affect per-bucket fit_signals/down_signals", () => {
  const repoRoot = repo();

  const context = buildSearchPromptContext({
    repoRoot,
    config: {
      targeting: {
        keep_signals: ["customer-facing deploy-and-adopt"],
        cut_signals: ["core platform SWE with no AI surface"],
        role_buckets: [
          {
            name: "Primary",
            titles: ["AI Platform Engineer"],
            fit_signals: ["LLM integration"],
            down_signals: ["pure research"],
          },
        ],
      },
      profile: {},
    },
  });

  assert.deepEqual(context.role_buckets, [
    {
      titles: ["AI Platform Engineer"],
      name: "Primary",
      fit_signals: ["LLM integration"],
      down_signals: ["pure research"],
    },
  ]);
  assert.deepEqual(context.keep_signals, ["customer-facing deploy-and-adopt"]);
  assert.deepEqual(context.cut_signals, ["core platform SWE with no AI surface"]);
});
