import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

const REQUIRED_SCHEMA_LANES = [
  "evidence",
  "story",
  "honesty",
  "writing_voice",
  "role_signal",
  "gap",
];

const SECRET_TOKENS = [
  "RAW_MODEL_SECRET_08_01",
  "SOURCE_BODY_SECRET_08_01",
  "CURRENT_BASE_SECRET_08_01",
  "PRIVATE_TOKEN_SECRET_08_01",
  "/Users/example/private/profile.md",
  "ssn 123-45-6789",
  "medical disability accommodation",
];

const SOURCE = {
  id: "src-deep-1",
  targetShape: "auto",
  kind: "paste",
  chunks: [
    {
      id: "chunk-1",
      text: [
        "Built an incident automation system that cut manual triage from 45 minutes to 8.",
        "Led migration of billing services with zero customer-visible downtime.",
        "Uses target_base, never current_base, when discussing compensation goals.",
      ].join("\n"),
      byteStart: 0,
      byteEnd: 238,
    },
  ],
};

function assertNoSecretLeak(value) {
  const serialized = JSON.stringify(value);
  for (const token of SECRET_TOKENS) {
    assert.equal(serialized.includes(token), false, `Deep ingest envelope leaked ${token}`);
  }
  for (const field of ["raw", "rawModelText", "prompt", "sourceText", "bodyText", "current_base"]) {
    assert.equal(
      new RegExp(`"${field}"\\s*:`).test(serialized),
      false,
      `Deep ingest envelope exposed ${field}`
    );
  }
}

async function importSchema() {
  const text = await readFile(
    new URL("../config/deep-ingest-proposal.schema.json", import.meta.url),
    "utf8"
  );
  return JSON.parse(text);
}

function proposalFor(lane, overrides = {}) {
  return {
    id: `${lane}-proposal-1`,
    lane,
    sourceId: SOURCE.id,
    chunkId: "chunk-1",
    status: "review_needed",
    confidence: 0.86,
    supportingQuote: "cut manual triage from 45 minutes to 8",
    span: { chunkId: "chunk-1", start: 43, end: 80 },
    payload: { title: "Incident automation", summary: "Reduced triage time with automation." },
    ...overrides,
  };
}

test("Deep ingest proposal schema pins lane-specific review rows and terminal fallback states", async () => {
  const schema = await importSchema();

  assert.equal(schema.type, "object");
  assert.deepEqual(schema.required, [
    "lane",
    "sourceId",
    "status",
    "confidence",
    "payload",
    "validation",
  ]);
  assert.deepEqual(schema.properties.lane.enum, REQUIRED_SCHEMA_LANES);
  assert.deepEqual(schema.properties.status.enum, [
    "review_needed",
    "manual_fallback",
    "gap",
    "blocked",
    "confirmed",
    "rejected",
    "deferred",
    "not_available",
  ]);
  assert.equal(schema.additionalProperties, false);
});

test("auto proposal builder classifies one source into real proposal lanes in one bounded call", async () => {
  const { proposeAutoFromSource } = await import("../src/core/deep-ingest/proposals/auto.mjs");
  const calls = [];

  const result = await proposeAutoFromSource({
    source: SOURCE,
    targetShape: "auto",
    runBoundedAI: async (options) => {
      calls.push(options);
      return {
        status: 200,
        body: {
          ok: true,
          data: {
            proposals: [proposalFor("evidence"), proposalFor("story", { id: "story-2" })],
          },
          ai: { used: true, mode: "native" },
          manual: { available: true, action: "Enter manually" },
        },
      };
    },
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].labels.operation, "deep_ingest.auto.propose");
  assert.deepEqual(
    result.proposals.map((proposal) => proposal.lane),
    ["evidence", "story"]
  );
  assert.equal(result.gaps.length, 0);
});

test("grounding and privacy validators block unsupported or private proposal text", async () => {
  const { validateDeepIngestGrounding } = await import(
    "../src/core/deep-ingest/validators/grounding.mjs"
  );
  const { validateDeepIngestPrivacy } = await import(
    "../src/core/deep-ingest/validators/privacy.mjs"
  );

  const ungrounded = validateDeepIngestGrounding({
    proposal: proposalFor("evidence", {
      supportingQuote: "drove ARR from $1M to $500M",
      span: { chunkId: "chunk-1", start: 0, end: 28 },
    }),
    chunks: SOURCE.chunks,
  });
  assert.equal(ungrounded.ok, false);
  assert.equal(ungrounded.code, "UNGROUNDED_PROPOSAL");

  const privateResult = validateDeepIngestPrivacy({
    proposal: proposalFor("honesty", {
      payload: {
        current_base: SECRET_TOKENS[2],
        note: `Contact me at person@example.com; local file ${SECRET_TOKENS[4]}`,
        accommodation: SECRET_TOKENS[6],
      },
    }),
  });
  assert.equal(privateResult.ok, false);
  assert.deepEqual(privateResult.blockedFields.sort(), [
    "contact_detail",
    "current_base",
    "local_path",
    "protected_trait",
  ]);
  assertNoSecretLeak(privateResult);
});

test("ISSUE-012: grounding accepts source-exact text across Markdown whitespace and smart quotes", async () => {
  const { validateDeepIngestGrounding } = await import(
    "../src/core/deep-ingest/validators/grounding.mjs"
  );
  const result = validateDeepIngestGrounding({
    proposal: {
      chunkId: "morgan-chunk",
      supportingQuote:
        "The 31% infrastructure-cost reduction was measured over two quarters and was shared work with FinOps; phrase as “co-led.”",
    },
    chunks: [
      {
        id: "morgan-chunk",
        text: [
          "## Evidence and honesty boundaries",
          "",
          '- The 31% infrastructure-cost reduction was measured over two quarters and was shared work with FinOps; phrase as "co-led."',
        ].join("\n"),
      },
    ],
  });

  assert.equal(result.ok, true);
});

test("ISSUE-012/014: Morgan's explicit honesty and targeting sections become reviewable proposals", async () => {
  const { proposeAutoFromSource } = await import("../src/core/deep-ingest/proposals/auto.mjs");
  const text = await readFile(
    new URL("fixtures/deep-ingest/morgan-hale-persona.md", import.meta.url),
    "utf8"
  );
  const source = {
    id: "deep_src_morgan",
    targetShape: "auto",
    kind: "paste",
    chunks: [{ id: "morgan-chunk", text }],
  };
  const result = await proposeAutoFromSource({
    source,
    targetShape: "auto",
    runBoundedAI: async () => ({
      status: 200,
      body: {
        ok: true,
        data: { proposals: [], gaps: [] },
        ai: { used: true },
        manual: { available: true },
      },
    }),
  });

  const honesty = result.proposals.filter((proposal) => proposal.lane === "honesty");
  const roleSignals = result.proposals.filter((proposal) => proposal.lane === "role_signal");
  assert.ok(
    honesty.some(
      (proposal) =>
        proposal.payload.boundaryType === "shared_ownership" &&
        /31%/.test(proposal.supportingQuote) &&
        /FinOps/.test(proposal.payload.text)
    )
  );
  for (const signalType of ["target_roles", "compensation", "keep", "cut"]) {
    assert.ok(
      roleSignals.some((proposal) => proposal.payload.signalType === signalType),
      `expected explicit ${signalType} proposal`
    );
  }
  assert.equal(
    [...honesty, ...roleSignals].every(
      (proposal) => proposal.status === "review_needed" && proposal.validation.status === "passed"
    ),
    true
  );
});
