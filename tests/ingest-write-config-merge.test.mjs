// `careerrat ingest --write-config` on an already-set-up workspace used to
// replace the whole search list with the freshly generated one, which dropped
// every hand-added search and reset each search's run history.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { closeAll } from "../src/core/db/connection.mjs";
import { sourceConfigGet, sourceConfigPut } from "../src/core/db/verbs.mjs";
import { mergeGeneratedSearchSources } from "../src/core/profile/generate-search-sources.mjs";

const repo = join(import.meta.dirname, "..");
const roots = [];
const env = { ...process.env, CAREERRAT_NO_UPDATE_CHECK: "1" };
delete env.CAREERRAT_HOME;
delete env.CAREERRAT_PERSON;

function cli(script, root, args) {
  const result = spawnSync(process.execPath, [script, "--root", root, ...args], {
    cwd: repo,
    env,
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  return JSON.parse(result.stdout);
}

after(() => {
  closeAll();
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

test("write-config keeps curated searches and their run history, adding only missing ones", () => {
  const root = mkdtempSync(join(tmpdir(), "careerrat-ingest-merge-"));
  roots.push(root);
  cli("src/cli/data.mjs", root, ["--json", "candidate", "init"]);
  cli("src/cli/data.mjs", root, [
    "--json",
    "candidate",
    "patch",
    "profile",
    "--data",
    JSON.stringify({ candidate: { full_name: "Merge Candidate", email: "merge@example.com" } }),
  ]);
  cli("src/cli/data.mjs", root, [
    "--json",
    "candidate",
    "patch",
    "targeting",
    "--data",
    JSON.stringify({ role_buckets: [{ name: "Ops", titles: ["Operations Lead"] }] }),
  ]);
  const first = cli("src/cli/ingest.mjs", root, ["--write-config", "--json"]);
  const stored = sourceConfigGet({ repoRoot: root, name: "search-sources" }).data;
  const curated = {
    provider: "HiringCafe",
    source_type: "url-query",
    label: "Hand picked search",
    query: "hand picked",
    enabled: true,
    recency: { lastRunAt: "2026-10-30T12:00:00.000Z" },
  };
  const ran = stored.searches.map((search, index) =>
    index === 0
      ? { ...search, recency: { ...search.recency, lastRunAt: "2026-10-31T09:00:00.000Z" } }
      : search
  );
  sourceConfigPut({
    repoRoot: root,
    name: "search-sources",
    data: { ...stored, searches: [...ran, curated] },
  });

  const second = cli("src/cli/ingest.mjs", root, ["--write-config", "--json"]);
  const after = sourceConfigGet({ repoRoot: root, name: "search-sources" }).data.searches;
  assert.equal(after.length, first.searches + 1);
  assert.ok(after.some((s) => s.label === "Hand picked search"));
  assert.equal(after[0].recency.lastRunAt, "2026-10-31T09:00:00.000Z");
  assert.equal(second.added, 0);
  assert.equal(second.keptExisting, first.searches + 1);
});

test("mergeGeneratedSearchSources takes the generated config whole when none exists", () => {
  const generated = { searches: [{ provider: "A", label: "x" }] };
  assert.equal(mergeGeneratedSearchSources(null, generated).merged, generated);
  assert.equal(mergeGeneratedSearchSources({ searches: [] }, generated).merged, generated);
});
