#!/usr/bin/env node
// Live smoke test: one stable public tenant per main provider, fetched through
// the shipped default fetch (no injected fetch, no stubs). It exists because a
// broken fetch layer once failed every public source while every unit test,
// which injects its own fetch, stayed green. Fails on zero jobs or any error.
// Network required; run by .github/workflows/live-smoke.yml, not by npm test.

import { fileURLToPath } from "node:url";
import { scanBoards, scanCompanies } from "../src/core/scoring/sourced-scanner.mjs";

const COMPANY_TENANTS = [
  {
    name: "greenhouse smoke",
    provider: "greenhouse",
    careers_url: "https://job-boards.greenhouse.io/cloudflare",
  },
  { name: "lever smoke", provider: "lever", careers_url: "https://jobs.lever.co/palantir" },
  { name: "ashby smoke", provider: "ashby", careers_url: "https://jobs.ashbyhq.com/ramp" },
];
const BOARD_SOURCES = [
  { label: "remotive smoke", source_type: "board", provider: "remotive", enabled: true },
];

export async function runSmoke({
  scanCompaniesImpl = scanCompanies,
  scanBoardsImpl = scanBoards,
} = {}) {
  const checks = [];
  for (const entry of COMPANY_TENANTS) {
    const { offers, errors } = await scanCompaniesImpl({ tracked_companies: [entry] });
    checks.push({ name: `${entry.provider}`, jobs: offers.length, errors });
  }
  for (const source of BOARD_SOURCES) {
    const { offers, errors } = await scanBoardsImpl({ searches: [source] });
    checks.push({ name: source.provider, jobs: offers.length, errors });
  }
  return checks;
}

export function failures(checks) {
  return checks.flatMap((check) => [
    ...(check.jobs === 0 ? [`${check.name}: returned zero jobs`] : []),
    ...check.errors.map((error) => `${check.name}: ${error.error ?? error}`),
  ]);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const checks = await runSmoke();
  for (const check of checks)
    console.log(`${check.name.padEnd(12)} ${check.jobs} jobs, ${check.errors.length} errors`);
  const problems = failures(checks);
  if (problems.length) {
    for (const problem of problems) console.error(`FAIL ${problem}`);
    process.exit(1);
  }
  console.log("Live smoke passed.");
}
