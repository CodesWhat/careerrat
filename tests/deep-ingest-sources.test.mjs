import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  composePacketWritingVoice,
  selectPacketRoleSignals,
  selectPacketStories,
} from "../src/core/packet/deep-ingest-sources.mjs";

function story(id, overrides = {}) {
  return {
    id,
    title: `Platform delivery ${id}`,
    situation: "A customer workflow was blocked by manual handoffs.",
    task: "Deliver a reliable workflow without weakening review controls.",
    action: "Built and rolled out an observable automation path with the customer team.",
    result: "The customer adopted the workflow for daily operations.",
    reflection: "Make the evidence boundary visible from the start.",
    competencies: ["workflow delivery"],
    roleSignals: ["customer deployment"],
    metrics: ["one production rollout"],
    openQuestions: [],
    supportingQuote: "Built and rolled out an observable automation path",
    updatedAt: "2026-07-19T12:00:00.000Z",
    ...overrides,
  };
}

describe("selectPacketStories claimability and scoring", () => {
  it("excludes stories missing a STAR field, supporting quote, or closure on open questions", () => {
    const rows = [
      story("claimable"),
      story("missing-task", { task: "" }),
      story("missing-quote", { supportingQuote: "" }),
      story("open-question", { openQuestions: ["Confirm the rollout date"] }),
    ];

    const selected = selectPacketStories({
      storyBank: rows,
      queryText: "customer deployment workflow delivery platform",
      purpose: "cover-letter",
    });

    assert.deepEqual(
      selected.map((row) => row.id),
      ["claimable"]
    );
  });

  for (const [label, matchingFields] of [
    ["role signal", { roleSignals: ["customer deployment"] }],
    ["competency", { competencies: ["workflow architecture"] }],
  ]) {
    it(`ranks a ${label} match above a merely token-matching story`, () => {
      const selected = selectPacketStories({
        storyBank: [
          story("weak", {
            title: "Platform migration",
            roleSignals: ["unrelated preference"],
            competencies: ["unrelated skill"],
          }),
          story("strong", {
            title: "Separate delivery story",
            roleSignals: ["unrelated preference"],
            competencies: ["unrelated skill"],
            ...matchingFields,
          }),
        ],
        queryText: "platform customer deployment workflow architecture",
        purpose: "answers",
      });

      assert.equal(selected[0].id, "strong");
      assert.equal(selected[1].id, "weak");
    });
  }

  it("returns no stories when every claimable item has a non-positive score", () => {
    const selected = selectPacketStories({
      storyBank: [
        story("recent-but-irrelevant", {
          title: "Orchard harvest",
          action: "Catalogued heirloom varieties.",
          result: "Published a seasonal field guide.",
          competencies: ["horticulture"],
          roleSignals: ["field research"],
        }),
      ],
      queryText: "distributed database query optimizer",
      purpose: "cover-letter",
    });

    assert.deepEqual(selected, []);
  });
});

describe("selectPacketStories purpose projections", () => {
  it("returns at most six resume hints with exactly metadata fields and no STAR prose", () => {
    const selected = selectPacketStories({
      storyBank: Array.from({ length: 8 }, (_, index) =>
        story(`resume-${index}`, {
          competencies: ["workflow delivery", `competency-${index}`],
          roleSignals: ["customer deployment", `signal-${index}`],
        })
      ),
      queryText: "workflow delivery customer deployment platform",
      purpose: "resume",
    });

    assert.ok(selected.length <= 6);
    assert.ok(JSON.stringify(selected).length <= 2000);
    for (const hint of selected) {
      assert.deepEqual(Object.keys(hint), ["id", "title", "competencies", "roleSignals"]);
      for (const starField of ["situation", "task", "action", "result", "reflection"]) {
        assert.equal(Object.hasOwn(hint, starField), false);
      }
    }
  });

  for (const purpose of ["cover-letter", "answers"]) {
    it(`${purpose} returns at most four full stories and skips an over-budget story whole`, () => {
      const largeStory = (id) =>
        story(id, {
          title: "P".repeat(120),
          situation: "S".repeat(300),
          task: "T".repeat(300),
          action: "A".repeat(500),
          result: "R".repeat(500),
          reflection: "F".repeat(300),
          competencies: Array.from(
            { length: 8 },
            (_, index) => `platform competency ${index} ${"c".repeat(55)}`
          ),
          roleSignals: Array.from(
            { length: 8 },
            (_, index) => `platform signal ${index} ${"s".repeat(60)}`
          ),
          metrics: Array.from(
            { length: 5 },
            (_, index) => `platform metric ${index} ${"m".repeat(60)}`
          ),
        });
      const small = story("small-after-large", {
        title: "Platform customer handoff",
        action: "Mapped the handoff and shipped the smallest safe automation.",
        result: "The customer used the complete workflow without manual re-entry.",
      });

      const selected = selectPacketStories({
        storyBank: [largeStory("large-a"), largeStory("large-b"), largeStory("large-c"), small],
        queryText: "platform customer deployment workflow delivery",
        purpose,
      });

      assert.ok(selected.length <= 4);
      assert.ok(JSON.stringify(selected).length <= 8000);
      assert.ok(selected.some((row) => row.id === "small-after-large"));
      assert.ok(
        ["large-b", "large-c"].some((id) => !selected.some((row) => row.id === id)),
        "at least one ranked large story should be skipped instead of partially packed"
      );
      assert.equal(
        selected.find((row) => row.id === "small-after-large").action,
        small.action,
        "a later story that fits must remain whole"
      );
    });
  }
});

describe("composePacketWritingVoice", () => {
  it("uses only the five most-recent rows, caps output at 1500 chars, and drops forbidden do-phrases", () => {
    const writingVoice = Array.from({ length: 7 }, (_, index) => ({
      id: `voice-${index + 1}`,
      summary: `ROW-${index + 1} ${"x".repeat(290)}`,
      doPhrases:
        index === 6
          ? ["Claim model training leadership", "Lead with a concrete result"]
          : ["Use active verbs"],
      avoidPhrases: ["unsupported hype"],
      updatedAt: `2026-07-${String(index + 1).padStart(2, "0")}T12:00:00.000Z`,
    }));

    const result = composePacketWritingVoice({
      writingVoice,
      forbiddenPhrases: ["model training"],
    });

    assert.equal(result.length, 1500);
    assert.match(result, /ROW-7/);
    assert.match(result, /ROW-3/);
    assert.doesNotMatch(result, /ROW-[12]/);
    assert.doesNotMatch(result, /Claim model training leadership/i);
    assert.match(result, /Lead with a concrete result/);
  });
});

describe("selectPacketRoleSignals", () => {
  it("keeps only exact-normalized-family keep/cut rows and enforces independent caps", () => {
    const matching = [
      ...Array.from({ length: 18 }, (_, index) => ({
        id: `keep-${index}`,
        roleFamily: index % 2 ? "Applied AI" : "applied-ai",
        signalType: "keep",
        text: index === 0 ? `keep-${"k".repeat(260)}` : `keep signal ${index}`,
        rationale: `r${"x".repeat(260)}`,
      })),
      ...Array.from({ length: 18 }, (_, index) => ({
        id: `cut-${index}`,
        roleFamily: "applied ai",
        signalType: "cut",
        text: `cut signal ${index}`,
        rationale: "Confirmed cut preference",
      })),
    ];
    const selected = selectPacketRoleSignals({
      family: "APPLIED_AI",
      roleSignals: [
        ...matching,
        {
          id: "near-family",
          roleFamily: "applied-ai-platform",
          signalType: "keep",
          text: "must not fuzzy match",
        },
        {
          id: "other-outcome",
          roleFamily: "applied-ai",
          signalType: "review",
          text: "must not accept another outcome",
        },
        { id: "blank", roleFamily: "applied-ai", signalType: "keep", text: "" },
      ],
    });

    assert.equal(selected.filter((row) => row.signalType === "keep").length, 16);
    assert.equal(selected.filter((row) => row.signalType === "cut").length, 16);
    assert.equal(selected.length, 32);
    assert.equal(
      selected.some((row) => row.id === "near-family"),
      false
    );
    assert.equal(
      selected.some((row) => row.id === "other-outcome"),
      false
    );
    assert.ok(selected.every((row) => ["keep", "cut"].includes(row.signalType)));
    assert.ok(selected.every((row) => row.text.length <= 240 && row.rationale.length <= 240));
  });

  it("returns no role signals when the requested family is unresolved", () => {
    assert.deepEqual(
      selectPacketRoleSignals({
        family: null,
        roleSignals: [{ id: "global", roleFamily: "", signalType: "keep", text: "global" }],
      }),
      []
    );
  });
});
