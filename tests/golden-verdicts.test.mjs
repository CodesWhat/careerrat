import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import {
  formatReport,
  GOLDEN_DIR,
  loadGoldenSet,
  parseGateReply,
  REPLIES_DIR,
  REPLY_SCORE_TOLERANCE,
  runGolden,
} from "../scripts/eval/golden-verdicts.mjs";

const recorded = (id) => readFileSync(join(REPLIES_DIR, `${id}.txt`), "utf8");

test("golden set is well-formed and spans fields and gates", () => {
  const set = loadGoldenSet();
  assert.ok(set.length >= 24, `only ${set.length} cases`);
  assert.ok(new Set(set.map((c) => c.field)).size >= 5);
  const ids = new Set();
  for (const c of set) {
    assert.ok(!ids.has(c.id), `duplicate id ${c.id}`);
    ids.add(c.id);
    assert.equal(c.expected.gate, c.intent, `${c.id}: frozen gate differs from the stated intent`);
  }
  for (const gate of ["KEEP", "REVIEW", "CUT"]) {
    assert.ok(set.filter((c) => c.expected.gate === gate).length >= 5, `too few ${gate} cases`);
  }
});

test("recorded replies replay with no drift against the frozen verdicts", () => {
  const report = runGolden();
  assert.equal(report.drifted.length, 0, formatReport(report));
  const manifest = JSON.parse(readFileSync(join(REPLIES_DIR, "manifest.json"), "utf8"));
  assert.equal(manifest.cases, report.total);
});

test("replay makes no live AI call", () => {
  const original = globalThis.fetch;
  globalThis.fetch = () => {
    throw new Error("network used during golden replay");
  };
  try {
    assert.equal(runGolden().drifted.length, 0);
  } finally {
    globalThis.fetch = original;
  }
});

test("reply drift is reported per field", () => {
  const target = "swe-keep-clear";
  const tampered = recorded(target)
    .replace("GATE: KEEP", "GATE: REVIEW")
    .replace("ACTION: apply-now", "ACTION: manual");
  const report = runGolden({ readReply: (id) => (id === target ? tampered : recorded(id)) });
  assert.equal(report.drifted.length, 1);
  assert.equal(report.engineDriftCount, 0);
  assert.deepEqual(
    report.drifted[0].replyDrift.map((d) => d.field),
    ["gate", "action"]
  );
});

test("fit score drift is tolerated inside the band and reported outside it", () => {
  const target = "swe-keep-clear";
  const withScore = (n) => recorded(target).replace("FIT: high 90", `FIT: high ${n}`);
  const near = runGolden({
    readReply: (id) => (id === target ? withScore(90 - REPLY_SCORE_TOLERANCE) : recorded(id)),
  });
  assert.equal(near.drifted.length, 0);
  const far = runGolden({
    readReply: (id) => (id === target ? withScore(90 - REPLY_SCORE_TOLERANCE - 1) : recorded(id)),
  });
  assert.deepEqual(
    far.drifted.map((d) => d.replyDrift[0].field),
    ["fitScore"]
  );
});

test("a missing or unparseable reply counts as drift", () => {
  const report = runGolden({
    readReply: (id) =>
      id === "rn-keep-clear" ? null : id === "rn-cut-signal" ? "no block" : recorded(id),
  });
  assert.deepEqual(report.drifted.map((d) => d.id).sort(), ["rn-cut-signal", "rn-keep-clear"]);
});

test("engine drift is reported when a frozen verdict no longer matches", () => {
  const cases = loadGoldenSet().map((c, i) =>
    i === 0 ? { ...c, expected: { ...c.expected, comp: "below-floor" } } : c
  );
  const report = runGolden({ cases });
  assert.equal(report.engineDriftCount, 1);
  assert.equal(report.drifted[0].engineDrift[0].field, "comp");
});

test("parseGateReply tolerates fences, bold labels and bullets", () => {
  const parsed = parseGateReply(
    [
      "Here is the verdict:",
      "```",
      "- **GATE:** CUT - cut signal(s) found",
      "* FIT: stretch 50 - thin",
      "COMP: clear - ok",
      "**ACTION:** cut",
      "```",
    ].join("\n")
  );
  assert.deepEqual(parsed, {
    gate: "CUT",
    fitTier: "stretch",
    fitScore: 50,
    comp: "clear",
    action: "cut",
  });
});

test("fixtures never reference a real home directory or the app workspace", () => {
  const walk = (dir) =>
    readdirSync(dir).flatMap((name) => {
      const p = join(dir, name);
      return statSync(p).isDirectory() ? walk(p) : [p];
    });
  for (const file of walk(GOLDEN_DIR)) {
    const text = readFileSync(file, "utf8");
    assert.ok(!/Documents\/careerrat/.test(text), `${file} mentions the real workspace`);
    assert.ok(!/\/Users\/|\/home\//.test(text), `${file} mentions a home directory`);
  }
});
