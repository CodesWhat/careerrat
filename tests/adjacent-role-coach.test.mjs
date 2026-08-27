import assert from "node:assert/strict";
import test from "node:test";

import {
  adjacentRoleCoachingTrigger,
  buildAdjacentRoleChoicePrompt,
  buildAdjacentRoleConfirmationPrompt,
  generateAdjacentRoleProposal,
  mergeAdjacentRoleTargets,
} from "../src/core/search/adjacent-role-coach.mjs";

const CONFIG = {
  profile: {
    candidate: {
      headline: "Lead bartender and service trainer",
      domain: "hospitality",
    },
    compensation: { currency: "USD", minimum_base: null, target_base: null },
  },
  targeting: {
    role_buckets: [
      {
        name: "Primary",
        priority: "primary",
        titles: ["Lead Bartender", "Beverage Manager"],
      },
    ],
    keep_signals: ["guest experience", "team development"],
    cut_signals: [],
  },
  evidence: {
    claims: [
      {
        id: "service-001",
        claim: "Ran high-volume guest service and resolved escalations.",
        evidence: "Led service recovery during busy shifts.",
        role_signals: ["guest operations", "event logistics"],
      },
      {
        id: "training-001",
        claim: "Trained and coached new staff.",
        evidence: "Owned onboarding and shift coaching.",
        role_signals: ["staff training", "team coordination"],
      },
    ],
  },
};

test("offers coaching only after a clean zero-result or clearly role-narrow search", () => {
  assert.deepEqual(
    adjacentRoleCoachingTrigger({
      status: "completed",
      summary: {
        attemptedSources: 4,
        scanned: 90,
        presented: 0,
        filtered: 90,
        errorCount: 0,
        errors: [],
      },
    }),
    { kind: "zero-result", presented: 0, scanned: 90, roleFiltered: 0 }
  );

  assert.deepEqual(
    adjacentRoleCoachingTrigger({
      status: "completed",
      summary: {
        attemptedSources: 5,
        scanned: 80,
        presented: 1,
        filtered: 79,
        reasonCounts: { title: 70, titleRelevance: 65 },
        errorCount: 0,
      },
    }),
    { kind: "over-narrow", presented: 1, scanned: 80, roleFiltered: 70 }
  );

  assert.equal(
    adjacentRoleCoachingTrigger({
      status: "completed",
      summary: {
        attemptedSources: 4,
        scanned: 80,
        presented: 0,
        filtered: 80,
        errorCount: 1,
        errors: [{ message: "Board unavailable" }],
      },
    }),
    null
  );
  assert.equal(
    adjacentRoleCoachingTrigger({
      status: "completed",
      summary: {
        attemptedSources: 4,
        scanned: 80,
        presented: 1,
        filtered: 79,
        reasonCounts: { location: 75 },
        errorCount: 0,
      },
    }),
    null
  );
});

test("uses coach.deep to propose three to five evidence-grounded directions", async () => {
  const calls = [];
  const result = await generateAdjacentRoleProposal({
    repoRoot: "/tmp/careerrat-adjacent-test",
    env: {},
    run: {
      id: "manual-search-1",
      status: "completed",
      summary: { attemptedSources: 4, scanned: 90, presented: 0, filtered: 90, errorCount: 0 },
    },
    config: CONFIG,
    call: async (input) => {
      calls.push(input);
      return {
        model: "installed:codex",
        content: [
          {
            type: "text",
            text: JSON.stringify({
              roles: [
                { title: "Event operations", evidence_refs: ["service-001"] },
                { title: "Guest operations", evidence_refs: ["service-001"] },
                { title: "Training and enablement", evidence_refs: ["training-001"] },
              ],
            }),
          },
        ],
      };
    },
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].aiOperation, "coach.deep");
  assert.equal(calls[0].model, undefined);
  assert.match(calls[0].system, /plain English/i);
  assert.doesNotMatch(calls[0].messages[0].content, /"minimum_base":0/);
  assert.doesNotMatch(calls[0].messages[0].content, /"target_base":0/);
  assert.equal(result.source, "ai");
  assert.equal(result.roles.length, 3);
  assert.deepEqual(
    result.roles.map(({ title, evidenceRefs }) => ({ title, evidenceRefs })),
    [
      { title: "Event operations", evidenceRefs: ["service-001"] },
      { title: "Guest operations", evidenceRefs: ["service-001"] },
      { title: "Training and enablement", evidenceRefs: ["training-001"] },
    ]
  );
  assert.match(result.explanation, /too narrow/i);
  assert.match(result.roles[0].why, /high-volume guest service/i);
  assert.doesNotMatch(JSON.stringify(result), /```|careerrat:|output_schema/i);
});

test("falls back to saved evidence without switching providers when AI cannot run", async () => {
  const noRoute = new Error("no AI route configured: choose a runtime");
  noRoute.code = "NO_AI_ROUTE";
  const result = await generateAdjacentRoleProposal({
    repoRoot: "/tmp/careerrat-adjacent-test",
    env: {},
    run: {
      id: "manual-search-2",
      status: "completed",
      summary: { attemptedSources: 4, scanned: 90, presented: 0, filtered: 90, errorCount: 0 },
    },
    config: CONFIG,
    call: async () => {
      throw noRoute;
    },
  });

  assert.equal(result.source, "saved-evidence");
  assert.equal(result.roles.length, 4);
  assert.deepEqual(
    result.roles.map((role) => role.title),
    ["Guest operations", "Event logistics", "Staff training", "Team coordination"]
  );
  assert.ok(result.roles.every((role) => role.evidenceRefs.length === 1));
});

test("builds a multi-select followed by a separate yes-no confirmation", async () => {
  const proposal = await generateAdjacentRoleProposal({
    repoRoot: "/tmp/careerrat-adjacent-test",
    env: {},
    run: {
      id: "manual-search-3",
      status: "completed",
      summary: { attemptedSources: 4, scanned: 90, presented: 0, filtered: 90, errorCount: 0 },
    },
    config: CONFIG,
    call: async () => {
      const error = new Error("no AI route configured");
      error.code = "NO_AI_ROUTE";
      throw error;
    },
  });

  const choice = buildAdjacentRoleChoicePrompt({
    proposal,
    threadId: "workspace-main",
    messageId: "coach-1",
  });
  assert.equal(choice.mode, "multi");
  assert.equal(choice.minSelections, 1);
  assert.equal(choice.maxSelections, 4);
  assert.equal(choice.allowText, true);
  assert.equal(choice.state, "pending");
  assert.ok(choice.options.every((option) => option.actionRef.type === "chat.reply"));

  const confirmation = buildAdjacentRoleConfirmationPrompt({
    proposal,
    selectedRoleIds: [proposal.roles[0].id, proposal.roles[2].id],
    threadId: "workspace-main",
    messageId: "coach-confirm-1",
  });
  assert.equal(confirmation.mode, "binary");
  assert.match(confirmation.question, /add .* as stretch targets and run a new search/i);
  assert.match(confirmation.question, new RegExp(proposal.roles[0].title, "i"));
  assert.match(confirmation.question, new RegExp(proposal.roles[2].title, "i"));
});

test("adds confirmed directions to one stable stretch bucket without duplicates", () => {
  const targeting = {
    role_buckets: [
      { name: "Primary", priority: "primary", titles: ["Lead Bartender"] },
      {
        name: "Career exploration",
        priority: "stretch",
        titles: ["Event operations"],
        notes: "Candidate-confirmed adjacent directions from career coaching.",
      },
    ],
  };
  const merged = mergeAdjacentRoleTargets({
    targeting,
    roles: [
      { id: "event", title: "Event operations" },
      { id: "guest", title: "Guest operations" },
    ],
  });

  assert.deepEqual(merged.added, ["Guest operations"]);
  assert.deepEqual(merged.roleBuckets[1].titles, ["Event operations", "Guest operations"]);
  assert.deepEqual(targeting.role_buckets[1].titles, ["Event operations"]);
});

test("does not re-offer role-family variants already saved in the tester's real target mix", async () => {
  const calls = [];
  const config = {
    profile: {
      candidate: { headline: "Hospitality operations leader", domain: "hospitality" },
      compensation: { currency: "USD", minimum_base: 85_000, target_base: 100_000 },
      location: {
        home: "New York City",
        remote: true,
        remote_scope: "home-country",
        hybrid: true,
        onsite: true,
      },
    },
    targeting: {
      role_buckets: [
        {
          name: "Current targets",
          priority: "primary",
          titles: [
            "Bar Manager",
            "Assistant Bar Manager",
            "Operations Manager Food & Beverage",
            "Bar Operations Lead",
            "Lead Bartender",
            "Head Bartender",
            "Assistant General Manager",
            "General Manager",
            "Event Operations Manager",
            "Event Coordinator",
            "Venue Operations Manager",
          ],
        },
      ],
      keep_signals: [],
      cut_signals: [],
    },
    evidence: {
      claims: [
        {
          id: "service-001",
          claim: "Owned guest recovery and coordinated busy service.",
          evidence: "Resolved guest escalations and kept teams aligned during high-volume shifts.",
          role_signals: ["customer operations", "guest experience management"],
        },
        {
          id: "training-001",
          claim: "Built onboarding and coached new staff.",
          evidence: "Trained new hires and improved shift readiness.",
          role_signals: ["training and enablement", "team development"],
        },
      ],
    },
  };
  const result = await generateAdjacentRoleProposal({
    repoRoot: "/tmp/careerrat-adjacent-real-shape",
    env: {},
    run: {
      id: "real-shape-zero",
      status: "completed",
      summary: { attemptedSources: 5, scanned: 120, presented: 0, errorCount: 0 },
    },
    config,
    call: async (input) => {
      calls.push(input);
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              roles: [
                { title: "Event operations", evidence_refs: ["service-001"] },
                { title: "Venue operations", evidence_refs: ["service-001"] },
                { title: "Customer operations", evidence_refs: ["service-001"] },
                { title: "Guest experience management", evidence_refs: ["service-001"] },
                { title: "Training and enablement", evidence_refs: ["training-001"] },
              ],
            }),
          },
        ],
      };
    },
  });

  assert.deepEqual(
    result.roles.map((role) => role.title),
    ["Customer operations", "Guest experience management", "Training and enablement"]
  );
  assert.doesNotMatch(result.roles.map((role) => role.title).join(" "), /event|venue/i);
  assert.match(calls[0].messages[0].content, /New York City/);
  assert.match(calls[0].messages[0].content, /85000/);
  assert.match(calls[0].messages[0].content, /100000/);
});
