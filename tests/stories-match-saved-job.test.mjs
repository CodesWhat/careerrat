// interview-prep told the agent to match stories against `<job>.md.json`
// sidecars that nothing in the product writes. A saved job (.md) now works.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { deriveJobSignals } from "../src/core/interview/story-bank.mjs";

const repo = join(import.meta.dirname, "..");
const homes = [];
after(() => {
  for (const home of homes) rmSync(home, { recursive: true, force: true });
});

const STORIES = [
  {
    id: "a",
    title: "Rollout",
    role_signals: ["incident response", "kubernetes"],
    competencies: [],
  },
  { id: "b", title: "Hiring", role_signals: ["recruiting"], competencies: [] },
];

test("deriveJobSignals keeps only the bank signals the JD mentions", () => {
  assert.deepEqual(
    deriveJobSignals({
      stories: STORIES,
      text: "You will lead Incident Response for our platform.",
    }),
    ["incident response"]
  );
  assert.deepEqual(deriveJobSignals({ stories: STORIES, text: "" }), []);
});

test("stories match accepts a saved job .md under workspace/", () => {
  const home = mkdtempSync(join(tmpdir(), "careerrat-stories-"));
  homes.push(home);
  mkdirSync(join(home, "candidate"), { recursive: true });
  mkdirSync(join(home, "workspace/jobs"), { recursive: true });
  writeFileSync(
    join(home, "candidate/stories.yml"),
    `stories:\n  - id: a\n    title: Rollout\n    role_signals:\n      - incident response\n    competencies: []\n  - id: b\n    title: Hiring\n    role_signals:\n      - recruiting\n    competencies: []\n`
  );
  writeFileSync(
    join(home, "workspace/jobs/role.md"),
    "---\ncompany: Example\nrole: Lead\n---\n\n# Job Description\n\nOwn incident response.\n"
  );
  const result = spawnSync(
    process.execPath,
    ["src/cli/stories.mjs", "match", "workspace/jobs/role.md", "--json"],
    {
      cwd: repo,
      env: { ...process.env, CAREERRAT_HOME: home, CAREERRAT_NO_UPDATE_CHECK: "1" },
      encoding: "utf8",
    }
  );
  assert.equal(result.status, 0, result.stderr + result.stdout);
  const out = JSON.parse(result.stdout);
  assert.deepEqual(
    out.matched.map((m) => m.id ?? m.story?.id),
    ["a"]
  );
});
