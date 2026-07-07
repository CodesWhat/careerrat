import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildStats,
  classifyStage,
  renderTrackerDashboard,
} from "../src/core/tracker/dashboard.mjs";

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

// ── Rendered dashboard: stage groups, pills, sourced entries ──────────────────

test("renderTrackerDashboard groups the Active Pipeline by stage and preserves raw labels", () => {
  const html = renderTrackerDashboard({
    applications: [
      { id: "a1", company: "Aperture", role: "FDE", status: "offer", fitScore: 92 },
      { id: "a2", company: "Tyrell", role: "AAE", status: "2nd phone interview", fitScore: 84 },
      { id: "a3", company: "Cyberdyne", role: "PE", status: "rejected", fitScore: 41 },
    ],
    sourced: [{ id: "p1", company: "Black Mesa", role: "AAE", fitScore: 80, fitBasis: "triage" }],
    communications: [],
    sources: [],
  });

  assert.match(html, /class="stagefilter"/, "renders the stage filter");
  assert.match(html, /data-stage="offer"/, "offer group present");
  assert.match(html, /data-stage="sourced"/, "sourced entry folds in as a sourced group");
  assert.match(html, /2nd phone interview/, "raw status label preserved verbatim on the pill");
  assert.ok(!/class="bandfilter"/.test(html), "old band filter markup is gone");
  // The rejected app is excluded from the active pipeline groups but shown in Rejected.
  assert.match(html, /Rejected/, "rejected section present");
});

test("renderTrackerDashboard resolves company avatars through the cached logo route", () => {
  const html = renderTrackerDashboard({
    applications: [
      {
        id: "logo-cache",
        company: "Reply Co",
        domain: "reply.co",
        role: "Applied AI Engineer",
        status: "awaiting",
        fitScore: 86,
      },
    ],
    sourced: [],
    communications: [],
    sources: [],
  });

  assert.match(html, /src="\/api\/logos\/img\?domain=reply\.co&amp;name=Reply%20Co"/);
  assert.doesNotMatch(html, /img\.logo\.dev/);
});
