// Doctor's search line used to say "N/N have run watermarks", which only proves
// a source ran once. It now says how many sources can run here and whether the
// last search worked, and never implies health it hasn't seen.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { closeAll } from "../src/core/db/connection.mjs";
import { sourceConfigPut, sourcingRunComplete, sourcingRunStart } from "../src/core/db/verbs.mjs";

const repo = join(import.meta.dirname, "..");
const homes = [];
after(() => {
  closeAll();
  for (const home of homes) rmSync(home, { recursive: true, force: true });
});

function doctor(home, args = []) {
  return spawnSync(process.execPath, ["src/cli/doctor.mjs", ...args], {
    cwd: repo,
    env: { ...process.env, CAREERRAT_HOME: home, CAREERRAT_NO_UPDATE_CHECK: "1" },
    encoding: "utf8",
    timeout: 60000,
  });
}

function newHome() {
  const dir = mkdtempSync(join(tmpdir(), "careerrat-doctor-search-"));
  homes.push(dir);
  return dir;
}

const SEARCHES = {
  searches: [
    {
      provider: "Feedsite",
      source_type: "rss",
      rssUrl: "https://example.com/feed.xml",
      recency: { lastRunAt: "2026-07-14T00:00:00.000Z" },
    },
    {
      provider: "Boardsite",
      source_type: "url-query",
      url: "https://example.com/jobs?q=x",
      recency: { lastRunAt: "2026-07-14T00:00:00.000Z" },
    },
    {
      provider: "Offsite",
      source_type: "url-query",
      url: "https://example.com/off",
      enabled: false,
    },
  ],
};

function legacyHome() {
  const dir = newHome();
  mkdirSync(join(dir, "config"), { recursive: true });
  const yaml = SEARCHES.searches
    .map((s) => {
      const lines = [`  - provider: ${s.provider}`, `    source_type: ${s.source_type}`];
      if (s.rssUrl) lines.push(`    rssUrl: ${s.rssUrl}`);
      if (s.url) lines.push(`    url: ${s.url}`);
      if (s.enabled === false) lines.push("    enabled: false");
      if (s.recency) lines.push("    recency:", `      lastRunAt: "${s.recency.lastRunAt}"`);
      return lines.join("\n");
    })
    .join("\n");
  writeFileSync(join(dir, "config/search-sources.yml"), `searches:\n${yaml}\n`);
  return dir;
}

test("search line separates runnable from browser-only and says health is unknown", () => {
  const out = doctor(legacyHome(), ["--guidance-only"]).stdout;
  assert.match(out, /Broad sources: 2 enabled searches/);
  assert.match(out, /1 can run from the terminal, 1 need the browser app\./);
  assert.match(out, /Whether they work is unknown until a search runs\./);
  assert.doesNotMatch(out, /watermark/);
});

test("doctor --json reports runnable and browser-only counts with no last run", () => {
  const parsed = JSON.parse(doctor(legacyHome(), ["--json", "--guidance-only"]).stdout);
  const broad = parsed.discovery.broadSources;
  assert.equal(broad.enabled, 2);
  assert.equal(broad.runnable, 1);
  assert.equal(broad.browserOnly, 1);
  assert.equal(broad.lastRun, null);
});

test("a database workspace reports the last finished search", () => {
  const home = newHome();
  const ctx = { repoRoot: repo, env: { ...process.env, CAREERRAT_HOME: home } };
  const init = spawnSync(process.execPath, ["src/cli/data.mjs", "--json", "candidate", "init"], {
    cwd: repo,
    env: ctx.env,
    encoding: "utf8",
  });
  assert.equal(init.status, 0, init.stderr);
  sourceConfigPut({ ...ctx, name: "search-sources", data: SEARCHES });
  const { run } = sourcingRunStart({ ...ctx, purpose: "manual-search", id: "run-1" });
  sourcingRunComplete({
    ...ctx,
    id: run.id,
    summary: { attemptedSources: 1, errors: [{ error: "HTTP 500" }] },
  });
  closeAll();
  const parsed = JSON.parse(doctor(home, ["--json", "--guidance-only"]).stdout);
  assert.equal(parsed.discovery.broadSources.lastRun.status, "failed");
  const out = doctor(home, ["--guidance-only"]).stdout;
  assert.match(out, /Last search: 1 of 1 sources failed\./);
  assert.doesNotMatch(out, /unknown until a search runs/);
});
