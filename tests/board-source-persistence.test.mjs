import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

import { closeAll } from "../src/core/db/connection.mjs";
import {
  candidateSetupInitialize,
  sourceConfigGet,
  sourceConfigPut,
} from "../src/core/db/verbs.mjs";
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
  sourceConfigPut({
    repoRoot,
    name: "search-sources",
    data: {
      searches: [
        {
          provider: "existing.example",
          source_type: "browser",
          label: "Existing Board",
          url: "https://existing.example/jobs",
          enabled: true,
        },
      ],
    },
  });

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
        {
          label: "Strong RSS",
          url: "https://feeds.example/jobs.xml",
          sourceType: "rss",
          why: "Publishes current jobs in a machine-readable feed.",
          status: "proposed",
          confidence: "high",
        },
        {
          label: "Strong Browser Board",
          url: "https://browser-board.example/jobs",
          sourceType: "browser",
          why: "Shows current dated listings on a browser-rendered board.",
          status: "proposed",
          confidence: "high",
        },
        {
          label: "Existing Board Again",
          url: "https://existing.example/jobs/",
          sourceType: "browser",
          why: "The same saved board with a harmless trailing slash.",
          status: "proposed",
          confidence: "high",
        },
      ],
    },
  });

  const strong = result.artifact.candidates.find((candidate) => candidate.label === "Strong Board");
  const thin = result.artifact.candidates.find((candidate) => candidate.label === "Thin Board");
  const existing = result.artifact.candidates.find(
    (candidate) => candidate.label === "Existing Board Again"
  );
  assert.deepEqual(strong.decision, {
    action: "save",
    status: "completed",
    resultText: "Added Strong Board.",
  });
  assert.equal(thin.decision, undefined);
  assert.equal(existing.decision.resultText, "Existing Board Again was already added.");
  assert.deepEqual(
    result.added.map((source) => [source.label, source.source_type]),
    [
      ["Strong Board", "url-query"],
      ["Strong RSS", "rss"],
      ["Strong Browser Board", "browser"],
    ]
  );
  const stored = sourceConfigGet({ repoRoot, name: "search-sources" }).data.searches;
  assert.equal(stored.length, 4);
  assert.equal(
    stored.find((source) => source.label === "Strong RSS").rssUrl,
    "https://feeds.example/jobs.xml"
  );
});
