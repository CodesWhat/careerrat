import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { prepareQuickStartSourcing } from "../src/cli/onboard-route.mjs";
import { closeAll } from "../src/core/db/connection.mjs";
import {
  candidateArtifactPut,
  candidateConfigPatch,
  candidateSetupInitialize,
  sourceConfigGet,
} from "../src/core/db/verbs.mjs";
import { userPath } from "../src/core/paths/workspace.mjs";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const roots = [];

after(() => {
  closeAll();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

test("discovery quick-start prepares only canonical DB source config", () => {
  const careerratHome = mkdtempSync(join(tmpdir(), "careerrat-discovery-db-only-"));
  roots.push(careerratHome);
  const env = { CAREERRAT_HOME: careerratHome };

  candidateSetupInitialize({ repoRoot, env });
  candidateConfigPatch({
    repoRoot,
    env,
    name: "profile",
    patch: {
      candidate: { full_name: "Ada Lovelace", email: "ada@example.com" },
      location: { home: "New York, NY", remote: true },
    },
  });
  candidateConfigPatch({
    repoRoot,
    env,
    name: "targeting",
    patch: {
      role_buckets: [{ name: "Applied AI", priority: "primary", titles: ["Applied AI Engineer"] }],
    },
  });
  candidateArtifactPut({
    repoRoot,
    env,
    id: "source-resume",
    kind: "source-resume",
    data: { path: "candidate/SOURCE_RESUME.md" },
  });

  const result = prepareQuickStartSourcing({ repoRoot, env });

  assert.equal(result.status, 200);
  assert.equal(result.body.ok, true);
  assert.equal(result.body.written, undefined);
  const sourceConfig = sourceConfigGet({ repoRoot, env, name: "search-sources" });
  assert.equal(sourceConfig.stored, true);
  assert.equal(sourceConfig.data.searches.length > 0, true);

  for (const path of [
    "candidate/profile.yml",
    "candidate/targeting.yml",
    "candidate/SOURCE_RESUME.md",
    "candidate/AGENTS.md",
    "config/search-sources.yml",
  ]) {
    assert.equal(existsSync(userPath({ repoRoot, env }, path)), false, path);
  }
});
