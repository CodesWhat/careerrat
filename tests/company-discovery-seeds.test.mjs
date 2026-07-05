import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { BOUNDED_AI_CODES } from "../src/core/ai/bounded-ai.mjs";
import { closeAll } from "../src/core/db/connection.mjs";
import {
  appUpsert,
  candidateConfigPatch,
  candidateSetupInitialize,
  sourceConfigPut,
  sourcedUpsertBatch,
} from "../src/core/db/verbs.mjs";
import { buildCompanySeedContext } from "../src/core/discovery/company-context.mjs";
import {
  companySeedSchema,
  generateCompanySeeds,
  normalizeManualCompanySeeds,
  validateCompanySeedResponse,
} from "../src/core/discovery/company-seeds.mjs";
import { validate } from "../src/core/profile/schema-validator.mjs";

const cleanupRoots = [];
const FIXED_NOW = new Date("2026-07-04T12:00:00.000Z");
const PRIVATE_CURRENT_BASE = 145000;
const FAILURE_LEAK_SENTINELS = [
  "RAW_MODEL_REPLY_05_02",
  "PROMPT_SECRET_05_02",
  "CANDIDATE_FACT_SECRET_05_02",
  "PRIVATE_COMP_SECRET_05_02",
  "current_base",
  "current_comp_shareable",
  String(PRIVATE_CURRENT_BASE),
];

function tempRepo() {
  const repoRoot = mkdtempSync(join(tmpdir(), "rolester-company-discovery-seeds-"));
  cleanupRoots.push(repoRoot);
  return repoRoot;
}

after(() => {
  closeAll();
  for (const root of cleanupRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function assertNoCurrentCompLeak(value) {
  const serialized = JSON.stringify(value);
  assert.equal(serialized.includes("current_base"), false, "must not leak current_base key");
  assert.equal(
    serialized.includes("current_comp_shareable"),
    false,
    "must not leak current_comp_shareable key"
  );
  assert.equal(
    serialized.includes(String(PRIVATE_CURRENT_BASE)),
    false,
    "must not leak private current base value"
  );
}

function assertNoFailureLeak(value, sentinels = FAILURE_LEAK_SENTINELS) {
  const serialized = JSON.stringify(value);
  for (const sentinel of sentinels) {
    assert.equal(serialized.includes(sentinel), false, `must not leak ${sentinel}`);
  }
}

function seedCandidateContext(repoRoot) {
  candidateSetupInitialize({ repoRoot });
  candidateConfigPatch({
    repoRoot,
    name: "profile",
    patch: {
      candidate: {
        full_name: "Scott Candidate",
        email: "scott@example.test",
        domain: "identity automation and applied AI",
      },
      location: {
        home: "New York, NY",
        remote: true,
        hybrid: true,
        onsite: false,
        relocation: ["NYC metro"],
      },
      compensation: {
        currency: "USD",
        current_comp_shareable: true,
        current_base: PRIVATE_CURRENT_BASE,
        minimum_base: 200000,
        target_base: 225000,
        oe_min_base: 100000,
        oe_max_base: 130000,
      },
      authorization: { work_authorized: true, requires_sponsorship: false },
    },
  });
  candidateConfigPatch({
    repoRoot,
    name: "targeting",
    patch: {
      role_buckets: [
        {
          name: "Applied AI",
          priority: "primary",
          titles: ["Applied AI Engineer", "Forward Deployed Engineer"],
        },
        {
          name: "IAM Security",
          priority: "secondary",
          titles: ["IAM Security Engineer"],
        },
      ],
      keep_signals: ["agentic developer workflows", "customer-facing prototypes"],
      cut_signals: ["pure ML research"],
      tracked_companies: ["Candidate Target Co"],
      excluded_companies: ["Excluded Co"],
    },
  });
  sourceConfigPut({
    repoRoot,
    name: "sourced-scan",
    data: {
      tracked_companies: [{ name: "Tracked ATS Co", careers_url: "https://jobs.lever.co/tracked" }],
    },
  });
  appUpsert({
    repoRoot,
    row: {
      id: "app-in-play",
      company: "Applied Already Co",
      role: "Applied AI Engineer",
      status: "applied",
    },
  });
  sourcedUpsertBatch({
    repoRoot,
    rows: [
      {
        id: "sourced-in-play",
        company: "Sourced Already Co",
        role: "Forward Deployed Engineer",
        fitScore: 82,
      },
    ],
  });
}

function validSeed(overrides = {}) {
  return {
    name: "Acme AI",
    domain_hint: "acme.example",
    why: "Builds agentic developer workflow tools.",
    role_family_hint: "Applied AI",
    confidence: "high",
    source_hint: "candidate keep signals",
    ...overrides,
  };
}

function minimalSeedContext(overrides = {}) {
  return {
    profileDomain: "applied AI",
    roleFamilies: [{ name: "Applied AI", titles: ["Applied AI Engineer"] }],
    keepSignals: ["agent workflows"],
    cutSignals: [],
    excludedCompanies: [],
    trackedCompanies: [],
    applications: [],
    sourcedCompanies: [],
    compensationFloors: { currency: "USD", minimum_base: 200000 },
    locationPosture: { remote: true },
    dedupe: { companies: [] },
    ...overrides,
  };
}

test("companySeedSchema requires top-level companies[] and rejects trusted URL/provider/write fields", () => {
  assert.equal(companySeedSchema.type, "object");
  assert.equal(companySeedSchema.required.includes("companies"), true);
  assert.equal(companySeedSchema.properties.companies.maxItems, 12);

  assert.equal(validate({ companies: [validSeed()] }, companySeedSchema).valid, true);
  assert.equal(validate({ seeds: [validSeed()] }, companySeedSchema).valid, false);
  assert.equal(
    validate({ companies: [validSeed()], approved: true }, companySeedSchema).valid,
    false
  );

  for (const field of [
    "careers_url",
    "job_board_url",
    "api_url",
    "provider",
    "approved",
    "unexpected",
  ]) {
    const result = validate({ companies: [validSeed({ [field]: "blocked" })] }, companySeedSchema);
    assert.equal(result.valid, false, `${field} must be rejected`);
    assert.ok(
      result.errors.some((error) => error.path.includes(field)),
      `${field} should be named in schema errors`
    );
  }

  const tooMany = {
    companies: Array.from({ length: 13 }, (_, index) => validSeed({ name: `Company ${index}` })),
  };
  const capped = validateCompanySeedResponse(tooMany);
  assert.equal(capped.valid, false);
  assert.ok(capped.errors.some((error) => /maximum of 12/i.test(error.message)));
});

test("buildCompanySeedContext includes candidate and dedupe inputs while omitting private current comp", () => {
  const repoRoot = tempRepo();
  seedCandidateContext(repoRoot);

  const context = buildCompanySeedContext({ repoRoot, env: {} });

  assert.equal(context.profileDomain, "identity automation and applied AI");
  assert.deepEqual(
    context.roleFamilies.map((family) => family.name),
    ["Applied AI", "IAM Security"]
  );
  assert.deepEqual(context.locationPosture, {
    home: "New York, NY",
    remote: true,
    hybrid: true,
    onsite: false,
    relocation: ["NYC metro"],
  });
  assert.deepEqual(context.keepSignals, [
    "agentic developer workflows",
    "customer-facing prototypes",
  ]);
  assert.deepEqual(context.cutSignals, ["pure ML research"]);
  assert.deepEqual(context.excludedCompanies, ["Excluded Co"]);
  assert.deepEqual(context.trackedCompanies, ["Tracked ATS Co", "Candidate Target Co"]);
  assert.deepEqual(context.applications, ["Applied Already Co"]);
  assert.deepEqual(context.sourcedCompanies, ["Sourced Already Co"]);
  assert.deepEqual(context.compensationFloors, {
    currency: "USD",
    minimum_base: 200000,
    oe_min_base: 100000,
  });
  assert.deepEqual(context.dedupe.companies, [
    "Tracked ATS Co",
    "Candidate Target Co",
    "Applied Already Co",
    "Sourced Already Co",
    "Excluded Co",
  ]);
  assertNoCurrentCompLeak(context);
});

test("manual company seeds are normalized locally and do not invoke AI", async () => {
  const rawManualSeeds = [
    {
      name: "  Manual Co  ",
      domainHint: "manual.example",
      careers_url: "https://jobs.lever.co/manual",
      api_url: "https://api.lever.co/v0/postings/manual",
      provider: "lever",
      approved: true,
    },
  ];

  assert.deepEqual(normalizeManualCompanySeeds(rawManualSeeds), [
    {
      name: "Manual Co",
      domain_hint: "manual.example",
      why: "Manual company seed.",
      role_family_hint: "",
      confidence: "medium",
      source_hint: "manual",
    },
  ]);

  let aiInvoked = false;
  const result = await generateCompanySeeds({
    manualSeeds: rawManualSeeds,
    requestedCount: 12,
    call: async () => {
      aiInvoked = true;
      throw new Error("AI must not be invoked for manual seeds");
    },
  });

  assert.equal(aiInvoked, false);
  assert.equal(result.status, 200);
  assert.equal(result.body.ok, true);
  assert.equal(result.body.ai.used, false);
  assert.deepEqual(result.body.data.companies, normalizeManualCompanySeeds(rawManualSeeds));
  assertNoCurrentCompLeak(result.body);
});

test("no manual seeds plus no AI route returns the shared 501 manual fallback envelope", async () => {
  const err = new Error("no AI route configured: set ANTHROPIC_API_KEY");
  err.code = BOUNDED_AI_CODES.NO_AI_ROUTE;

  const result = await generateCompanySeeds({
    context: {
      profileDomain: "applied AI",
      roleFamilies: [{ name: "Applied AI", titles: ["Applied AI Engineer"] }],
      keepSignals: ["agent workflows"],
      cutSignals: [],
      excludedCompanies: [],
      trackedCompanies: [],
      applications: [],
      sourcedCompanies: [],
      compensationFloors: { currency: "USD", minimum_base: 200000 },
      locationPosture: { remote: true },
      dedupe: { companies: [] },
    },
    requestedCount: 12,
    call: async () => {
      throw err;
    },
  });

  assert.equal(result.status, 501);
  assert.equal(result.body.ok, false);
  assert.equal(result.body.code, BOUNDED_AI_CODES.NO_AI_ROUTE);
  assert.equal(result.body.manual.available, true);
  assert.equal(result.body.ai.used, false);
  assertNoCurrentCompLeak(result.body);
});

test("AI company seed generation uses native-preferred bounded AI with exact labels and private-comp-safe prompt context", async () => {
  const repoRoot = tempRepo();
  seedCandidateContext(repoRoot);
  const context = buildCompanySeedContext({ repoRoot, env: {} });
  const calls = [];

  const result = await generateCompanySeeds({
    repoRoot,
    env: {},
    context,
    requestedCount: 99,
    now: FIXED_NOW,
    call: async (options) => {
      calls.push(options);
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              companies: [
                {
                  name: "Native Seeds Co",
                  domain_hint: "native.example",
                  why: "Matches agentic workflow keep signal.",
                  role_family_hint: "Applied AI",
                  confidence: "high",
                  source_hint: "bounded-ai",
                },
              ],
            }),
          },
        ],
        model: "claude-native-test",
      };
    },
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].skill, "discover-companies");
  assert.equal(calls[0].action, "seed-generate");
  assert.equal(calls[0].outputMode, "native");
  assert.equal(calls[0].outputName, "company_seed_response");
  assert.deepEqual(calls[0].outputSchema, companySeedSchema);
  assert.match(calls[0].messages[0].content, /"maxCompanies": 12/);
  assert.match(calls[0].messages[0].content, /identity automation and applied AI/);
  assert.match(calls[0].messages[0].content, /Applied AI/);
  assert.match(calls[0].messages[0].content, /agentic developer workflows/);
  assert.match(calls[0].messages[0].content, /Excluded Co/);
  assert.match(calls[0].messages[0].content, /Tracked ATS Co/);
  assert.match(calls[0].messages[0].content, /Applied Already Co/);
  assert.match(calls[0].messages[0].content, /200000/);
  assert.match(calls[0].messages[0].content, /100000/);
  assertNoCurrentCompLeak(calls[0]);

  assert.equal(result.status, 200);
  assert.equal(result.body.ok, true);
  assert.equal(result.body.ai.label, "discover-companies:seed-generate:company-seeds");
  assert.equal(result.body.ai.skill, "discover-companies");
  assert.equal(result.body.ai.action, "seed-generate");
  assert.equal(result.body.ai.operation, "company-seeds");
  assert.equal(result.body.ai.mode, "native");
  assert.deepEqual(result.body.data.companies, [
    {
      name: "Native Seeds Co",
      domain_hint: "native.example",
      why: "Matches agentic workflow keep signal.",
      role_family_hint: "Applied AI",
      confidence: "high",
      source_hint: "bounded-ai",
    },
  ]);
  assertNoCurrentCompLeak(result.body);
});

test("malformed company seed JSON gets exactly one corrective retry before succeeding", async () => {
  const calls = [];

  const result = await generateCompanySeeds({
    context: minimalSeedContext(),
    requestedCount: 1,
    now: FIXED_NOW,
    call: async (options) => {
      calls.push(options);
      if (calls.length === 1) {
        return {
          content: [{ type: "text", text: "not json for company seeds" }],
          model: "claude-native-test",
        };
      }
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              companies: [
                validSeed({
                  name: "Retry Seeds Co",
                  domain_hint: "retry.example",
                  confidence: "medium",
                }),
              ],
            }),
          },
        ],
        model: "claude-native-test",
      };
    },
  });

  assert.equal(calls.length, 2);
  assert.equal(calls[0].messages.length, 1);
  assert.equal(calls[1].messages.length, 2);
  assert.match(calls[1].messages.at(-1).content, /invalid JSON/);
  assert.equal(result.status, 200);
  assert.equal(result.body.ok, true);
  assert.equal(result.body.ai.used, true);
  assert.equal(result.body.ai.mode, "native");
  assert.equal(result.body.ai.retried, true);
  assert.deepEqual(result.body.data.companies, [
    {
      name: "Retry Seeds Co",
      domain_hint: "retry.example",
      why: "Builds agentic developer workflow tools.",
      role_family_hint: "Applied AI",
      confidence: "medium",
      source_hint: "candidate keep signals",
    },
  ]);
});

test("schema-invalid company seed trusted fields return AI_SCHEMA_INVALID manual envelopes", async () => {
  for (const field of ["careers_url", "provider", "approved"]) {
    const calls = [];
    const result = await generateCompanySeeds({
      context: minimalSeedContext(),
      requestedCount: 1,
      call: async (options) => {
        calls.push(options);
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                companies: [
                  validSeed({
                    name: `Blocked ${field}`,
                    [field]: "trusted-field-secret-05-02",
                  }),
                ],
              }),
            },
          ],
          model: "claude-native-test",
        };
      },
    });

    assert.equal(calls.length, 2, `${field} should receive exactly one retry`);
    assert.match(calls[1].messages.at(-1).content, new RegExp(field));
    assert.equal(result.status, 422, field);
    assert.equal(result.body.ok, false, field);
    assert.equal(result.body.code, BOUNDED_AI_CODES.AI_SCHEMA_INVALID, field);
    assert.equal(result.body.manual.available, true, field);
    assert.equal(result.body.ai.used, true, field);
    assert.equal(result.body.ai.retried, true, field);
    assert.equal(result.body.data, undefined, field);
    assert.ok(
      result.body.error.details.some((error) => error.path.includes(field)),
      `${field} should be named in schema details`
    );
    assertNoFailureLeak(result.body, ["trusted-field-secret-05-02"]);
  }
});

test("exhausted malformed company seed output returns safe manual metadata without prompt or model leakage", async () => {
  const calls = [];

  const result = await generateCompanySeeds({
    context: minimalSeedContext({
      profileDomain: "CANDIDATE_FACT_SECRET_05_02",
      keepSignals: ["PROMPT_SECRET_05_02"],
      compensationFloors: {
        currency: "USD",
        minimum_base: PRIVATE_CURRENT_BASE,
        note: "PRIVATE_COMP_SECRET_05_02",
      },
    }),
    requestedCount: 1,
    call: async (options) => {
      calls.push(options);
      return {
        content: [
          {
            type: "text",
            text: `not json ${FAILURE_LEAK_SENTINELS.join(" ")}`,
          },
        ],
        model: "claude-native-test",
      };
    },
  });

  assert.equal(calls.length, 2);
  assert.match(calls[1].messages.at(-1).content, /invalid JSON/);
  assert.equal(result.status, 422);
  assert.equal(result.body.ok, false);
  assert.equal(result.body.code, BOUNDED_AI_CODES.AI_SCHEMA_INVALID);
  assert.equal(result.body.manual.available, true);
  assert.equal(result.body.ai.used, true);
  assert.equal(result.body.ai.retried, true);
  assertNoFailureLeak(result.body);
});
