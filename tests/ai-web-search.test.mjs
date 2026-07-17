import assert from "node:assert/strict";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
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
import { runAiWebSearch } from "../src/core/search/ai-web-search.mjs";
import { saveSearchPrompts } from "../src/core/search/search-prompts.mjs";

const roots = [];

function repo({ mode = "standard", prompts = 5 } = {}) {
  const repoRoot = mkdtempSync(join(tmpdir(), "rolester-ai-web-search-"));
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
    assistantJson.inputs.push(input);
    onEvent({
      type: "assistant",
      data: {
        message: {
          content: [{ type: "text", text: `\`\`\`json\n${JSON.stringify(data)}\n\`\`\`` }],
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
    fit_score: 88,
    fit_bucket: "high",
    fit_basis: "Strong role and tool match.",
    rule_flags: [],
    source_evidence: "The posting explicitly describes applied AI delivery.",
    ...overrides,
  };
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
    const kickoff = assistantJson.inputs[0];
    assert.equal(kickoff.prompts.length, expected);
  }
});

test("runAiWebSearch hard-dedupes batch and DB rows and assigns review/likely-cut gates", async () => {
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
    role({ url: "https://example.test/batch-duplicate" }),
    role({
      company: "Existing Co",
      title: "AI Engineer",
      url: "https://example.test/other-existing-url",
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
  });

  assert.deepEqual(result, { searched: 3, found: 4, new: 2, duplicates: 2, errors: [] });
  const added = readDbScannerRows({ repoRoot }).filter((row) => row.source === "ai-web-search");
  assert.deepEqual(added.map((row) => [row.company, row.gate]).sort(), [
    ["Acme AI", "review"],
    ["Cut Co", "likely-cut"],
  ]);
  assert.ok(added.every((row) => row.artifacts?.jd));
});

test("runAiWebSearch retries schema-invalid output once and returns the safe error envelope on exhaustion", async () => {
  const repoRoot = repo();
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
    { searched: 3, found: 0, new: 0, duplicates: 0 }
  );
  assert.equal(failed.errors.length, 1);
  assert.match(failed.errors[0], /schema|usable|match/i);
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
