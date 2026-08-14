import assert from "node:assert/strict";
import { test } from "node:test";
import { buildStats, classifyStage } from "../src/core/tracker/dashboard.mjs";

// ── classifyStage: canonical keyword mapping ──────────────────────────────────

test("classifyStage maps canonical statuses to the right rung", () => {
  const cases = [
    ["applied", "applied"],
    ["submitted", "applied"],
    ["awaiting", "applied"],
    ["pending", "applied"],
    ["recruiter screen", "screen"],
    ["screening", "screen"],
    ["hiring manager call", "screen"],
    ["interview", "interview"],
    ["panel", "interview"],
    ["technical assessment", "interview"],
    ["onsite", "final"],
    ["final round", "final"],
    ["offer", "offer"],
    ["accepted", "accepted"],
    ["signed", "accepted"],
    ["rejected", "rejected"],
    ["declined", "rejected"],
    ["closed", "rejected"],
    ["withdrawn", "withdrawn"],
  ];
  for (const [status, expected] of cases) {
    assert.equal(classifyStage(status).id, expected, `${status} → ${expected}`);
  }
});

test("classifyStage is case-insensitive and trims", () => {
  assert.equal(classifyStage("  INTERVIEW  ").id, "interview");
  assert.equal(classifyStage("Offer").id, "offer");
});

test("classifyStage lands a verbose label on the right rung (interview, not screen)", () => {
  // 'phone' appears in screen-ish vocab but 'interview' must win.
  assert.equal(classifyStage("2nd phone interview").id, "interview");
  assert.equal(classifyStage("final onsite loop").id, "final");
});

test("classifyStage returns each rung with order + colorVar for display", () => {
  const s = classifyStage("offer");
  assert.equal(s.label, "Offer");
  assert.equal(typeof s.order, "number");
  assert.match(s.colorVar, /^--/);
});

test("classifyStage defaults unknown non-empty status to applied", () => {
  assert.equal(classifyStage("some-bespoke-status").id, "applied");
});

test("classifyStage treats empty/nullish status as applied (caller passes sourced entries without status)", () => {
  assert.equal(classifyStage("").id, "applied");
  assert.equal(classifyStage(null).id, "applied");
  assert.equal(classifyStage(undefined).id, "applied");
});

// ── classifyStage: custom stages (mint / override) ────────────────────────────

test("classifyStage honours a custom stage that mints a new rung", () => {
  const custom = [
    {
      id: "take-home",
      label: "Take-home",
      order: 2.5,
      color: "--purple",
      patterns: ["take-home", "take home", "homework"],
    },
  ];
  const s = classifyStage("take-home assignment", custom);
  assert.equal(s.id, "take-home");
  assert.equal(s.label, "Take-home");
  assert.equal(s.order, 2.5);
  assert.equal(s.colorVar, "--purple");
});

test("classifyStage lets a custom stage override a canonical id", () => {
  const custom = [{ id: "offer", label: "Verbal offer", order: 5, color: "--cyan" }];
  const s = classifyStage("offer", custom);
  assert.equal(s.id, "offer");
  assert.equal(s.label, "Verbal offer");
  assert.equal(s.colorVar, "--cyan");
});

test("custom stages are checked before canonical keyword rules", () => {
  // 'screen' would canonically be `screen`; a custom pattern claims it first.
  const custom = [{ id: "phone-screen", label: "Phone screen", order: 1.5, patterns: ["screen"] }];
  assert.equal(classifyStage("recruiter screen", custom).id, "phone-screen");
});

// ── Coarse classifyApp (via buildStats) stays consistent with the ladder ──────

test("buildStats counts a verbose advanced label as advanced (generalised classifyApp)", () => {
  const data = {
    applications: [
      { id: "a1", status: "2nd phone interview" }, // interview → advanced
      { id: "a2", status: "recruiter screen" }, // screen → advanced
      { id: "a3", status: "applied" }, // applied → awaiting
      { id: "a4", status: "offer" }, // offer → advanced
      { id: "a5", status: "rejected" }, // terminal → rejected
    ],
    sourced: [],
    communications: [],
    sources: [],
  };
  const stats = buildStats(data);
  assert.equal(stats.advanced, 3, "interview + screen + offer are all 'heard back'");
  assert.equal(stats.awaiting, 1, "only the plain 'applied' is still awaiting");
  assert.equal(stats.rejected, 1);
});

test("buildStats does not count reviewed holds as applied or active", () => {
  const stats = buildStats({
    applications: [
      { id: "hold-1", status: "reviewed-hold" },
      { id: "hold-2", status: "reviewed-hold" },
      { id: "applied-1", status: "applied" },
    ],
    sourced: [],
  });

  assert.equal(stats.applied, 1);
  assert.equal(stats.awaiting, 1);
  assert.equal(stats.inPlay, 1);
});
