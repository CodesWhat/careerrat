#!/usr/bin/env node

// scripts/eval/golden-verdicts.mjs — CR107 golden-set verdict evals.
//
// A synthetic set of candidates (several fields) and saved postings, each with
// a FROZEN expected verdict (gate / fit tier+score / comp verdict / action) in
// tests/fixtures/golden-verdicts/cases.json, and a RECORDED agent reply in
// tests/fixtures/golden-verdicts/replies/<id>.txt. Two things are checked:
//
//   engine drift  the deterministic body-read gate (evaluateGate) against the
//                 frozen verdicts. Catches code changes.
//   reply drift   the recorded agent reply, parsed from its GATE/FIT/COMP/ACTION
//                 block, against the frozen verdicts. Catches an agent or model
//                 version that answers the gate differently once its replies are
//                 re-recorded.
//
// Replay never calls a model. Fresh replies come only from the opt-in
// `--record` flag, which drives the installed agent CLI (same runtime adapter
// production uses) and overwrites replies/ plus replies/manifest.json.
//
// Usage:
//   node scripts/eval/golden-verdicts.mjs            replay, print drift, exit 1 on drift
//   node scripts/eval/golden-verdicts.mjs --json     machine-readable report
//   node scripts/eval/golden-verdicts.mjs --record [--runtime claude|codex] [--limit N]
//
// Re-freezing expected verdicts is a hand edit of cases.json, on purpose.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { evaluateGate, parseSavedJob } from "../../src/core/evaluate/gate.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..", "..");

export const GOLDEN_DIR = join(REPO_ROOT, "tests/fixtures/golden-verdicts");
export const REPLIES_DIR = join(GOLDEN_DIR, "replies");
// A model may land a few points either side on the fit score; the tier, gate,
// comp verdict and action must match exactly.
export const REPLY_SCORE_TOLERANCE = 5;
// Fixed clock so legitimacy checks never depend on the day the suite runs.
const FIXED_NOW = new Date("2026-11-02T00:00:00Z");

const FIELDS = ["gate", "fitTier", "fitScore", "comp", "action"];

export function loadGoldenSet(dir = GOLDEN_DIR) {
  const cases = JSON.parse(readFileSync(join(dir, "cases.json"), "utf8"));
  const candidates = new Map();
  return cases.map((c) => {
    if (!candidates.has(c.candidate)) {
      candidates.set(
        c.candidate,
        JSON.parse(readFileSync(join(dir, "candidates", `${c.candidate}.json`), "utf8"))
      );
    }
    return {
      ...c,
      candidateConfig: candidates.get(c.candidate),
      jobMarkdown: readFileSync(join(dir, c.job), "utf8"),
    };
  });
}

/** Run the deterministic gate for one case and normalize to the verdict shape. */
export function engineVerdict(golden) {
  const result = evaluateGate({
    job: parseSavedJob(golden.jobMarkdown),
    targeting: golden.candidateConfig.targeting,
    profile: golden.candidateConfig.profile,
    honesty: golden.candidateConfig.honesty,
    modes: undefined,
    now: FIXED_NOW,
  });
  return {
    gate: result.gate,
    fitTier: result.fit.tier,
    fitScore: result.fit.score,
    comp: result.comp.verdict,
    action: result.action,
  };
}

function lineValue(text, label) {
  const re = new RegExp(`^[\\s>*_\`-]*${label}\\s*:\\s*\\**\\s*(.+?)\\s*$`, "im");
  const m = String(text || "").match(re);
  return m ? m[1].replace(/[*_`]+/g, "").trim() : null;
}

/**
 * Parse a gate block out of an agent reply. Tolerates fences, bold and bullets
 * around the labels. A field it cannot find comes back null, which reads as drift.
 */
export function parseGateReply(text) {
  const gate = lineValue(text, "GATE");
  const fit = lineValue(text, "FIT");
  const comp = lineValue(text, "COMP");
  const action = lineValue(text, "ACTION");
  const fitMatch = fit?.match(/^([a-z-]+)\s+(\d{1,3})\b/i);
  return {
    gate: gate?.match(/^[A-Za-z]+/)?.[0]?.toUpperCase() ?? null,
    fitTier: fitMatch ? fitMatch[1].toLowerCase() : null,
    fitScore: fitMatch ? Number(fitMatch[2]) : null,
    comp: comp?.match(/^[A-Za-z-]+/)?.[0] ?? null,
    action: action?.match(/^[A-Za-z-]+/)?.[0]?.toLowerCase() ?? null,
  };
}

function diffVerdict(expected, actual, { scoreTolerance = 0 } = {}) {
  const drift = [];
  for (const field of FIELDS) {
    const want = expected[field];
    const got = actual?.[field] ?? null;
    const same =
      field === "fitScore"
        ? typeof got === "number" && Math.abs(got - want) <= scoreTolerance
        : got === want;
    if (!same) drift.push({ field, expected: want, actual: got });
  }
  return drift;
}

/**
 * Replay the golden set. `readReply(id)` returns the recorded reply text or
 * null when none is recorded (counted as reply drift).
 */
export function runGolden({
  dir = GOLDEN_DIR,
  cases = loadGoldenSet(dir),
  repliesDir = REPLIES_DIR,
  readReply = (id) => {
    try {
      return readFileSync(join(repliesDir, `${id}.txt`), "utf8");
    } catch {
      return null;
    }
  },
} = {}) {
  const results = cases.map((golden) => {
    const engineDrift = diffVerdict(golden.expected, engineVerdict(golden));
    const reply = readReply(golden.id);
    const replyDrift =
      reply == null
        ? [{ field: "reply", expected: "recorded reply", actual: null }]
        : diffVerdict(golden.expected, parseGateReply(reply), {
            scoreTolerance: REPLY_SCORE_TOLERANCE,
          });
    return { id: golden.id, field: golden.field, engineDrift, replyDrift };
  });
  const drifted = results.filter((r) => r.engineDrift.length || r.replyDrift.length);
  return {
    total: results.length,
    fields: [...new Set(results.map((r) => r.field))],
    engineDriftCount: results.filter((r) => r.engineDrift.length).length,
    replyDriftCount: results.filter((r) => r.replyDrift.length).length,
    drifted,
  };
}

export function formatReport(report) {
  const lines = [
    `golden verdicts: ${report.total} cases across ${report.fields.length} fields`,
    `engine drift: ${report.engineDriftCount}   reply drift: ${report.replyDriftCount}`,
  ];
  for (const r of report.drifted) {
    lines.push(`- ${r.id} (${r.field})`);
    for (const d of r.engineDrift)
      lines.push(`    engine ${d.field}: expected ${d.expected}, got ${d.actual}`);
    for (const d of r.replyDrift)
      lines.push(`    reply  ${d.field}: expected ${d.expected}, got ${d.actual}`);
  }
  if (!report.drifted.length) lines.push("no drift");
  return lines.join("\n");
}

export function buildRecordPrompt(golden) {
  return [
    "You are running the evaluate-job body-read gate on one saved job posting for an evaluation harness.",
    "No tools are available and none are needed: the full posting and the candidate config are below.",
    "Apply the gate rules: a cut signal in the posting, an excluded company, or a sponsorship mismatch is CUT;",
    "a base-pay band that cannot reach the candidate's floor, missing pay, an OE bucket, or a stretch fit is REVIEW;",
    "otherwise KEEP. FIT tier is high, med or stretch with a 0-100 score.",
    "Reply with only this block, one line each, nothing else:",
    "GATE: <KEEP|CUT|REVIEW> - <reason>",
    "FIT: <high|med|stretch> <score> - <why>",
    "COMP: <clear|review|below-floor|OE-bucket|estimated|estimated-below-floor> - <reason>",
    "ACTION: <apply-now|hold|manual|cut>",
    "## Candidate config",
    JSON.stringify(golden.candidateConfig, null, 2),
    "## Saved posting",
    golden.jobMarkdown,
  ].join("\n\n");
}

async function record({ runtimeId, limit }) {
  const { detectInstalledRuntimes, runInstalledRuntime } = await import(
    "../../src/core/ai/installed-runtimes.mjs"
  );
  const runtimes = detectInstalledRuntimes();
  const runtime = runtimeId
    ? runtimes.find((r) => r.id === runtimeId && r.available)
    : runtimes.find((r) => r.available);
  if (!runtime) {
    console.error(
      "STOP: no installed agent runtime is available. Recording needs a real agent; this script never fabricates replies."
    );
    process.exit(1);
  }
  const set = loadGoldenSet();
  const subset = Number.isFinite(limit) && limit > 0 ? set.slice(0, limit) : set;
  mkdirSync(REPLIES_DIR, { recursive: true });
  let version = null;
  for (const golden of subset) {
    const result = await runInstalledRuntime({
      runtime,
      prompt: buildRecordPrompt(golden),
      tools: [],
      timeoutMs: 120_000,
    });
    const text = String(result?.text || "").trim();
    writeFileSync(join(REPLIES_DIR, `${golden.id}.txt`), `${text}\n`);
    version = result?.model ?? version;
    console.log(`recorded ${golden.id}`);
  }
  writeFileSync(
    join(REPLIES_DIR, "manifest.json"),
    `${JSON.stringify(
      {
        source: "live",
        recordedAt: new Date().toISOString(),
        runtime: { id: runtime.id, model: version },
        cases: subset.length,
        partial: subset.length < set.length,
      },
      null,
      2
    )}\n`
  );
  console.log("Replies recorded. Run without --record to see drift against the frozen verdicts.");
}

function main() {
  const args = process.argv.slice(2);
  const flag = (name) => {
    const i = args.indexOf(name);
    return i >= 0 ? (args[i + 1] ?? true) : undefined;
  };
  if (args.includes("--record")) {
    return record({ runtimeId: flag("--runtime"), limit: Number(flag("--limit")) }).catch((e) => {
      console.error(e.message);
      process.exit(1);
    });
  }
  const report = runGolden();
  console.log(args.includes("--json") ? JSON.stringify(report, null, 2) : formatReport(report));
  process.exit(report.drifted.length ? 1 : 0);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
