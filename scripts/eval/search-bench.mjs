#!/usr/bin/env node
// scripts/eval/search-bench.mjs — offline job-search ranking benchmark (CR115c).
//
// Feeds labelled synthetic postings (tests/fixtures/search-bench/*.json, one
// file per candidate) through the same path scripts/scan-sourced.mjs uses:
// buildSearchSources -> buildTitleFilter/buildLocationFilter ->
// filterAndDedupeOffers (qualification, scoring, dedupe, per-company cap).
// No network, no database, no AI. The order of `kept` is the ranking.
//
// Metrics: precision@10 and ndcg@10 over the ranked kept list, good recall
// (share of good postings that survive filtering), and kept precision (share
// of the whole kept list that is good, which catches junk ranked below 10).
// Grades: 3 exact target, 2 adjacent or good, 1 stretch, 0 wrong. A "good"
// posting is grade >= 2.
//
// Usage:
//   node scripts/eval/search-bench.mjs [--json] [--update-baseline] [--fixtures <dir>]
//   --fixtures runs another fixture directory (e.g. holdout/). Its baseline.json, if any, is
//   only written with --update-baseline; holdout-onboarded/ carries one.
//   npm run bench:search -- --update-baseline   (intentional baseline change)
//   npm run bench:search -- --fixtures tests/fixtures/search-bench/holdout-onboarded --update-baseline

import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildSearchSources } from "../../src/core/profile/generate-search-sources.mjs";
import {
  buildLocationFilter,
  buildTitleFilter,
  filterAndDedupeOffers,
} from "../../src/core/scoring/sourced-scanner.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
export const FIXTURE_DIR = join(__dirname, "..", "..", "tests", "fixtures", "search-bench");
export const BASELINE_PATH = join(FIXTURE_DIR, "baseline.json");
export const HOLDOUT_ONBOARDED_DIR = join(FIXTURE_DIR, "holdout-onboarded");
export const METRICS = ["precisionAt10", "ndcgAt10", "goodRecall", "keptPrecision"];
const K = 10;
const GOOD_GRADE = 2;
const PER_COMPANY_CAP = 5;
const FIXED_NOW = Date.parse("2026-01-15T00:00:00Z");

const CUT_BUCKETS = [
  "filteredTitle",
  "filteredSeniority",
  "filteredLocation",
  "filteredAge",
  "filteredSalary",
  "filteredEligibility",
  "duplicates",
  "invalid",
  "overflow",
];

function round(value) {
  return Number(value.toFixed(4));
}

function dcg(grades) {
  return grades.slice(0, K).reduce((sum, grade, i) => sum + (2 ** grade - 1) / Math.log2(i + 2), 0);
}

export function loadFixtures(dir = FIXTURE_DIR) {
  return readdirSync(dir)
    .filter((name) => name.endsWith(".json") && name !== "baseline.json")
    .sort()
    .map((name) => JSON.parse(readFileSync(join(dir, name), "utf8")));
}

function cutReasonFor(bucket, entry) {
  return entry.qualificationReason || entry.reason || bucket;
}

export function evaluateCandidate(fixture) {
  const { targeting, profile, postings } = fixture;
  const generated = buildSearchSources(targeting, profile);
  const config = { targeting, profile };
  const filtered = filterAndDedupeOffers(
    postings.map((p) => ({
      _benchId: p.id,
      title: p.title,
      company: p.company,
      location: p.location,
      url: p.url,
      comp: p.comp,
      bodyText: p.bodyText,
    })),
    {
      titleFilter: buildTitleFilter(generated.title_filter, targeting),
      locationFilter: buildLocationFilter(generated.location_filter),
      config,
      now: FIXED_NOW,
      perCompanyCap: PER_COMPANY_CAP,
    }
  );

  const byId = new Map(postings.map((p) => [p.id, p]));
  const ranking = filtered.kept.map((offer) => byId.get(offer._benchId));
  const cutReasons = new Map();
  for (const bucket of CUT_BUCKETS) {
    for (const entry of filtered[bucket] || []) {
      if (entry._benchId) cutReasons.set(entry._benchId, cutReasonFor(bucket, entry));
    }
  }

  const goodTotal = postings.filter((p) => p.grade >= GOOD_GRADE).length;
  const top = ranking.slice(0, K);
  const goodInTop = top.filter((p) => p.grade >= GOOD_GRADE).length;
  const goodKept = ranking.filter((p) => p.grade >= GOOD_GRADE).length;
  const ideal = dcg(postings.map((p) => p.grade).sort((a, b) => b - a));
  const misses = postings
    .filter((p) => p.grade >= GOOD_GRADE && !ranking.includes(p))
    .map((p) => ({
      id: p.id,
      grade: p.grade,
      title: p.title,
      company: p.company,
      location: p.location,
      kind: p.kind,
      reason: cutReasons.get(p.id) || "unknown",
    }));

  const junkKept = ranking
    .map((p, i) => ({ p, rank: i + 1 }))
    .filter(({ p }) => p.grade === 0)
    .map(({ p, rank }) => ({
      id: p.id,
      rank,
      title: p.title,
      company: p.company,
      kind: p.kind,
    }));

  return {
    name: fixture.name,
    postings: postings.length,
    kept: ranking.length,
    goodTotal,
    metrics: {
      precisionAt10: top.length ? round(goodInTop / top.length) : 0,
      ndcgAt10: ideal ? round(dcg(top.map((p) => p.grade)) / ideal) : 0,
      keptPrecision: ranking.length ? round(goodKept / ranking.length) : 0,
      goodRecall: goodTotal ? round(goodKept / goodTotal) : 1,
    },
    top10: top.map((p) => ({
      id: p.id,
      grade: p.grade,
      title: p.title,
      company: p.company,
    })),
    misses,
    junkKept,
  };
}

export function runSearchBench({ dir = FIXTURE_DIR } = {}) {
  const candidates = loadFixtures(dir).map(evaluateCandidate);
  const mean = (metric) =>
    round(candidates.reduce((sum, c) => sum + c.metrics[metric], 0) / (candidates.length || 1));
  return {
    k: K,
    goodGrade: GOOD_GRADE,
    candidates,
    overall: Object.fromEntries(METRICS.map((metric) => [metric, mean(metric)])),
  };
}

export function baselineFrom(result) {
  return {
    overall: result.overall,
    candidates: Object.fromEntries(result.candidates.map((c) => [c.name, c.metrics])),
  };
}

function formatText(result) {
  const lines = [`Search bench (k=${result.k}, good = grade >= ${result.goodGrade})`, ""];
  const pct = (n) => `${(n * 100).toFixed(1)}%`;
  for (const c of result.candidates) {
    lines.push(
      `${c.name}: ${c.postings} postings, ${c.kept} kept`,
      `  precision@10 ${pct(c.metrics.precisionAt10)}  kept precision ${pct(c.metrics.keptPrecision)}  ndcg@10 ${pct(c.metrics.ndcgAt10)}  good recall ${pct(c.metrics.goodRecall)} (${c.goodTotal - c.misses.length}/${c.goodTotal})`
    );
    for (const m of c.misses) {
      lines.push(
        `  cut g${m.grade} [${m.id}] ${m.title} @ ${m.company} (${m.location}): ${m.reason}`
      );
    }
    for (const j of c.junkKept) {
      lines.push(`  kept g0 at rank ${j.rank} [${j.id}] ${j.title} @ ${j.company} (${j.kind})`);
    }
    lines.push("");
  }
  lines.push(
    `overall: precision@10 ${pct(result.overall.precisionAt10)}  kept precision ${pct(result.overall.keptPrecision)}  ndcg@10 ${pct(result.overall.ndcgAt10)}  good recall ${pct(result.overall.goodRecall)}`
  );
  return lines.join("\n");
}

function main() {
  const argv = process.argv.slice(2);
  const args = new Set(argv);
  const fixturesAt = argv.indexOf("--fixtures");
  let dir = FIXTURE_DIR;
  if (fixturesAt !== -1) {
    if (!argv[fixturesAt + 1]) {
      console.error("--fixtures needs a directory");
      process.exit(2);
    }
    dir = resolve(argv[fixturesAt + 1]);
  }
  const result = runSearchBench({ dir });
  if (args.has("--update-baseline")) {
    const target = join(dir, "baseline.json");
    writeFileSync(target, JSON.stringify(baselineFrom(result), null, 2) + "\n");
    console.error(`Wrote ${target}`);
  }
  console.log(args.has("--json") ? JSON.stringify(result, null, 2) : formatText(result));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
