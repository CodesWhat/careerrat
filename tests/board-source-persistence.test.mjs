import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

import { closeAll } from "../src/core/db/connection.mjs";
import { candidateSetupInitialize, sourceConfigGet } from "../src/core/db/verbs.mjs";
import { persistValidatedBoardSources } from "../src/core/discovery/board-source-persistence.mjs";

const roots = [];

after(() => {
  closeAll();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

test("explicit board discovery persists high-confidence sources and leaves borderline sources reviewable", () => {
  const repoRoot = mkdtempSync(join(tmpdir(), "careerrat-board-persistence-"));
  roots.push(repoRoot);
  candidateSetupInitialize({ repoRoot });
  const schema = JSON.parse(readFileSync("config/search-sources.schema.json", "utf8"));

  const result = persistValidatedBoardSources({
    repoRoot,
    schema,
    artifact: {
      kind: "source_review",
      candidates: [
        {
          label: "Strong Board",
          url: "https://strong-board.example/jobs?role=operations",
          sourceType: "url-query",
          why: "Shows current dated operations roles from named employers.",
          status: "proposed",
          confidence: "high",
        },
        {
          label: "Thin Board",
          url: "https://thin-board.example/jobs",
          sourceType: "browser",
          why: "Has relevant roles, but listing dates are inconsistent.",
          status: "proposed",
          confidence: "borderline",
        },
      ],
    },
  });

  const strong = result.artifact.candidates.find((candidate) => candidate.label === "Strong Board");
  const thin = result.artifact.candidates.find((candidate) => candidate.label === "Thin Board");
  assert.deepEqual(strong.decision, {
    action: "save",
    status: "completed",
    resultText: "Added Strong Board.",
  });
  assert.equal(thin.decision, undefined);
  assert.deepEqual(
    result.added.map((source) => source.label),
    ["Strong Board"]
  );
  assert.equal(sourceConfigGet({ repoRoot, name: "search-sources" }).data.searches.length, 1);
});
