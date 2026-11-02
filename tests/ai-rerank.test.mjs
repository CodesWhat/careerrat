import assert from "node:assert/strict";
import { test } from "node:test";
import {
  annotateTopResults,
  NO_AI_ROUTE_MESSAGE,
  resolveAiRerankSetting,
} from "../src/core/search/ai-rerank.mjs";

const config = (aiRerank) => ({
  targeting: {
    role_buckets: [{ name: "A", titles: ["Senior Accountant"] }],
    search_preferences: aiRerank === undefined ? {} : { ai_rerank: aiRerank },
  },
});

const kept = ["A", "B", "C", "D"].map((name, i) => ({
  title: `Role ${name}`,
  company: `Co ${name}`,
  url: `https://example.com/${name}`,
  score: 90 - i,
  ratingReason: "base",
}));

const okAI = (ranking) => async () => ({ status: 200, body: { ok: true, data: { ranking } } });

test("rerank is off by default and never calls the AI", async () => {
  let called = false;
  const result = await annotateTopResults({
    kept,
    config: config(),
    runAI: async () => {
      called = true;
    },
  });
  assert.equal(called, false);
  assert.equal(result.kept, kept);
  assert.equal(result.aiRerank.status, "disabled");
});

test("setting resolves top_n with a cap", () => {
  assert.deepEqual(resolveAiRerankSetting(config({ enabled: true }).targeting), {
    enabled: true,
    topN: 20,
  });
  assert.equal(resolveAiRerankSetting(config({ enabled: true, top_n: 500 }).targeting).topN, 50);
  assert.equal(resolveAiRerankSetting(config({ enabled: "yes" }).targeting).enabled, false);
});

test("notes and a suggested order are added; order and membership are untouched", async () => {
  let prompt;
  const result = await annotateTopResults({
    kept,
    config: config({ enabled: true, top_n: 3 }),
    runAI: async (args) => {
      prompt = args;
      return okAI([
        { id: "o3", note: "Closest to the stated target." },
        { id: "o1", note: "Good match." },
      ])();
    },
  });
  assert.deepEqual(
    result.kept.map((o) => o.url),
    kept.map((o) => o.url)
  );
  assert.equal(result.kept.length, 4);
  assert.equal(result.kept[2].aiRank, 1);
  assert.equal(result.kept[2].aiNote, "Closest to the stated target.");
  assert.equal(result.kept[0].aiRank, 2);
  assert.match(result.kept[0].ratingReason, /^base; AI note: Good match\./);
  assert.equal(result.kept[1].aiNote, undefined);
  assert.equal(result.kept[3].aiNote, undefined, "beyond top_n is never sent");
  assert.deepEqual(result.aiRerank.suggestedOrder, [
    "https://example.com/C",
    "https://example.com/A",
  ]);
  assert.equal(result.aiRerank.annotated, 2);
  assert.equal(prompt.messages[0].content.includes("Role D"), false);
});

test("unknown, duplicate and empty ids from the model are ignored", async () => {
  const result = await annotateTopResults({
    kept,
    config: config({ enabled: true }),
    runAI: okAI([
      { id: "o9", note: "ghost" },
      { id: "o2", note: "first" },
      { id: "o2", note: "again" },
    ]),
  });
  assert.equal(result.aiRerank.annotated, 1);
  assert.equal(result.kept[1].aiNote, "first");
});

test("no AI route gives a clear message and untouched results", async () => {
  const result = await annotateTopResults({
    kept,
    config: config({ enabled: true }),
    runAI: async () => ({
      status: 501,
      body: { ok: false, code: "NO_AI_ROUTE", error: { message: "none" } },
    }),
  });
  assert.equal(result.kept, kept);
  assert.equal(result.aiRerank.status, "no-ai-route");
  assert.equal(result.aiRerank.message, NO_AI_ROUTE_MESSAGE);
});

test("a thrown or invalid AI answer leaves the order as scored", async () => {
  const thrown = await annotateTopResults({
    kept,
    config: config({ enabled: true }),
    runAI: async () => {
      throw new Error("boom");
    },
  });
  assert.equal(thrown.aiRerank.status, "failed");
  assert.equal(thrown.kept, kept);
  const invalid = await annotateTopResults({
    kept,
    config: config({ enabled: true }),
    runAI: async () => ({
      status: 422,
      body: { ok: false, code: "AI_SCHEMA_INVALID", error: { message: "bad" } },
    }),
  });
  assert.equal(invalid.aiRerank.status, "failed");
  assert.equal(invalid.kept, kept);
});
