import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { closeAll } from "../src/core/db/connection.mjs";
import { sourceConfigGet } from "../src/core/db/verbs.mjs";

const ROOT = new URL("..", import.meta.url).pathname;
const cleanupHomes = [];

function tempHome() {
  const home = mkdtempSync(join(tmpdir(), "careerrat-searches-cli-"));
  cleanupHomes.push(home);
  return home;
}

function runCli(script, args, home) {
  return spawnSync(process.execPath, [script, ...args], {
    cwd: ROOT,
    env: { ...process.env, CAREERRAT_HOME: home },
    encoding: "utf8",
  });
}

function runData(args, home) {
  return runCli("src/cli/data.mjs", ["--json", ...args], home);
}

function runSearches(args, home) {
  return runCli("src/cli/searches.mjs", args, home);
}

function sourceConfig(home) {
  return sourceConfigGet({
    repoRoot: ROOT,
    env: { ...process.env, CAREERRAT_HOME: home },
    name: "search-sources",
  });
}

after(() => {
  closeAll();
  for (const home of cleanupHomes.splice(0)) {
    rmSync(home, { recursive: true, force: true });
  }
});

test("careerrat searches --add-query writes DB source config without search-sources.yml", () => {
  const home = tempHome();
  assert.equal(runData(["init"], home).status, 0);

  const add = runSearches(
    ["--add-query", "Director of IT", "--label", "IT leaders", "--json"],
    home
  );
  assert.equal(add.status, 0, add.stderr || add.stdout);

  const stored = sourceConfig(home);
  assert.equal(stored.stored, true);
  assert.equal(stored.data.searches.length, 1);
  assert.equal(stored.data.searches[0].query, "Director of IT");
  assert.equal(stored.data.searches[0].label, "IT leaders");
  assert.equal(existsSync(join(home, "config/search-sources.yml")), false);
});

test("careerrat searches --add-provider writes a runnable deterministic source", () => {
  const home = tempHome();
  assert.equal(runData(["init"], home).status, 0);
  const result = runSearches(
    ["--add-provider", "remoteok", "--query", "Staff platform engineer", "--json"],
    home
  );
  assert.equal(result.status, 0, result.stderr);
  const body = JSON.parse(result.stdout);
  assert.equal(body.mode, "add-provider");
  assert.deepEqual(body.searches, [
    {
      index: 0,
      provider: "remoteok",
      label: "remoteok",
      target: "Staff platform engineer",
      source_type: "board",
      enabled: true,
      lastRunAt: null,
    },
  ]);
});

test("legacy --add-query --provider routes supported providers to a runnable board source", () => {
  const home = tempHome();
  assert.equal(runData(["init"], home).status, 0);
  const result = runSearches(
    ["--add-query", "Staff engineer", "--provider", "remoteok", "--json"],
    home
  );
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).searches[0].source_type, "board");
});

test("careerrat searches --providers exposes the complete pinned parity manifest", () => {
  const home = tempHome();
  const result = runSearches(["--providers", "--json"], home);
  assert.equal(result.status, 0, result.stderr);
  const body = JSON.parse(result.stdout);
  assert.equal(body.upstream.providerCount, 78);
  assert.equal(body.providers.filter((provider) => provider.status === "implemented").length, 77);
  assert.deepEqual(
    body.providers.find((provider) => provider.id === "local-parser"),
    {
      id: "local-parser",
      status: "unsupported",
      reason: "Executes user-configured local commands; it is not a public network source adapter.",
    }
  );
});

test("careerrat searches --from-targeting writes generated DB source config without YAML", () => {
  const home = tempHome();
  assert.equal(runData(["init"], home).status, 0);
  assert.equal(
    runData(
      [
        "candidate",
        "patch",
        "profile",
        "--data",
        JSON.stringify({
          candidate: { domain: "technology" },
          location: { home: "New York, NY", remote: true },
          compensation: { minimum_base: 100000 },
        }),
      ],
      home
    ).status,
    0
  );
  assert.equal(
    runData(
      [
        "candidate",
        "patch",
        "targeting",
        "--data",
        JSON.stringify({
          role_buckets: [{ name: "IT leadership", titles: ["Director of IT"] }],
        }),
      ],
      home
    ).status,
    0
  );

  const generated = runSearches(["--from-targeting", "--json"], home);
  assert.equal(generated.status, 0, generated.stderr || generated.stdout);

  const stored = sourceConfig(home);
  assert.equal(stored.stored, true);
  assert.ok(stored.data.searches.length > 0);
  assert.equal(existsSync(join(home, "config/search-sources.yml")), false);
});

test("careerrat searches --from-targeting rejects a generated baseline containing only boards", () => {
  const home = tempHome();
  assert.equal(runData(["init"], home).status, 0);

  const generated = runSearches(["--from-targeting", "--json"], home);

  assert.equal(generated.status, 1);
  assert.match(generated.stderr || generated.stdout, /no role titles/i);
  assert.equal(sourceConfig(home).stored, false);
});
