#!/usr/bin/env node
// scripts/eval/phase1-deterministic.mjs — SEARCH-SHAPE-EVAL.md Phase 1.
//
// Runs the deterministic scanner's scoring function (scoreSourcedOffer, which
// wraps scoreSourcedOfferFromConfig — see sourced-scanner.mjs) against the
// labeled corpus in tests/fixtures/eval/search-shape-corpus.json, scored
// against examples/demo-workspace's targeting.yml + profile.yml exactly the
// way search-jobs STEP 3 coarse triage does. Fully offline: no network, no
// database, no AI calls — pure function calls against a fixture file.
//
// Usage: node scripts/eval/phase1-deterministic.mjs [--out <path>]
//
// Writes a results JSON (default: scripts/eval/phase1-results.json) with the
// per-posting scorer output plus agreement stats against the corpus's
// agent-judged myLabel, and prints a summary table to stdout.

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseYaml } from "../../src/core/profile/yaml.mjs";
import { scoreSourcedOffer } from "../../src/core/scoring/sourced-scanner.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..", "..");

const CORPUS_PATH = join(REPO_ROOT, "tests/fixtures/eval/search-shape-corpus.json");
const TARGETING_PATH = join(REPO_ROOT, "examples/demo-workspace/candidate/targeting.yml");
const PROFILE_PATH = join(REPO_ROOT, "examples/demo-workspace/candidate/profile.yml");
const DEFAULT_OUT = join(__dirname, "phase1-results.json");

function parseArgs(argv) {
  const out = { out: DEFAULT_OUT };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--out" && argv[i + 1]) {
      out.out = argv[++i];
    }
  }
  return out;
}

function loadCorpus() {
  return JSON.parse(readFileSync(CORPUS_PATH, "utf8"));
}

function loadConfig() {
  const targeting = parseYaml(readFileSync(TARGETING_PATH, "utf8"));
  const profile = parseYaml(readFileSync(PROFILE_PATH, "utf8"));
  return { targeting, profile };
}

// Maps a labeled corpus posting into the "offer" shape scoreSourcedOffer
// expects (the same shape scanCompanies/scanBoards/ai-web-search's
// toScanOffer produce). bodyText/comp/postedAt are intentionally absent for
// almost every entry — see the corpus's _meta.provenance for why: these
// conformance fixtures model ATS list-endpoint responses, which don't carry
// full JD prose, matching the real STEP 3 triage moment (title/company/
// location only, before any body fetch).
function toOffer(posting) {
  return {
    title: posting.title || "",
    company: posting.company || "",
    location: posting.location === "Unspecified" ? "" : posting.location || "",
    comp: posting.comp || "",
    bodyText: posting.bodyText || "",
    postedAt: posting.postedAt ?? undefined,
  };
}

function summarize(rows) {
  const total = rows.length;
  let agree = 0;
  const confusion = {}; // "myLabel->scorerFit": count
  const byLabel = {
    high: { total: 0, agree: 0 },
    med: { total: 0, agree: 0 },
    stretch: { total: 0, agree: 0 },
  };

  for (const row of rows) {
    const key = `${row.myLabel}->${row.scorerFit}`;
    confusion[key] = (confusion[key] || 0) + 1;
    byLabel[row.myLabel].total++;
    if (row.myLabel === row.scorerFit) {
      agree++;
      byLabel[row.myLabel].agree++;
    }
  }

  return {
    total,
    agree,
    disagree: total - agree,
    agreementPct: Number(((agree / total) * 100).toFixed(1)),
    disagreementPct: Number((((total - agree) / total) * 100).toFixed(1)),
    confusion,
    byLabel,
  };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const corpus = loadCorpus();
  const config = loadConfig();

  const rows = corpus.postings.map((posting) => {
    const offer = toOffer(posting);
    const result = scoreSourcedOffer(offer, config);
    return {
      id: posting.id,
      provider: posting.provider,
      title: posting.title,
      company: posting.company,
      myLabel: posting.myLabel,
      scorerFit: result.fit,
      scorerScore: result.score,
      scorerGate: result.gate,
      scorerRatingReason: result.ratingReason,
      scorerRuleFlags: result.ruleFlags,
      agree: posting.myLabel === result.fit,
    };
  });

  const stats = summarize(rows);

  const output = {
    generatedAt: new Date().toISOString(),
    corpusPath: "tests/fixtures/eval/search-shape-corpus.json",
    targetingConfig: "examples/demo-workspace/candidate/targeting.yml",
    profileConfig: "examples/demo-workspace/candidate/profile.yml",
    stats,
    rows,
  };

  writeFileSync(args.out, JSON.stringify(output, null, 2) + "\n");

  console.log(`Phase 1 — deterministic scanner vs. agent-judged labels`);
  console.log(`Corpus: ${rows.length} postings`);
  console.log(
    `Agreement: ${stats.agree}/${stats.total} (${stats.agreementPct}%) — disagreement ${stats.disagreementPct}%`
  );
  console.log(`By label:`);
  for (const [label, s] of Object.entries(stats.byLabel)) {
    const pct = s.total ? ((s.agree / s.total) * 100).toFixed(1) : "n/a";
    console.log(`  ${label}: ${s.agree}/${s.total} (${pct}%)`);
  }
  console.log(`\nDisagreements:`);
  for (const row of rows.filter((r) => !r.agree)) {
    console.log(
      `  [${row.id}] "${row.title}" @ ${row.company} — mine=${row.myLabel} scorer=${row.scorerFit} (score=${row.scorerScore}, flags=${row.scorerRuleFlags.join(",") || "none"})`
    );
  }
  console.log(`\nWrote ${args.out}`);
}

main();
