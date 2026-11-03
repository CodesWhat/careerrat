import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  buildOutcomeRates,
  classifyOutcome,
  formatOutcomeRates,
} from "../src/core/tracker/outcome-rates.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const app = (status, fitScore, extra = {}) => ({ status, fitScore, ...extra });
const talked = [{ kind: "recruiter screen", title: "Recruiter screen" }];

test("in-flight and candidate exits are not counted as outcomes", () => {
  assert.equal(classifyOutcome(app("applied", 90)), "in-flight");
  assert.equal(classifyOutcome(app("Interview", 90)), "advanced");
  assert.equal(classifyOutcome(app("rejected", 90)), "rejected");
  assert.equal(classifyOutcome(app("rejected", 90, { conversations: talked })), "advanced");
  assert.equal(classifyOutcome(app("withdrawn", 90)), "excluded");
  assert.equal(classifyOutcome(app("sourced", 90)), "excluded");
});

test("no percentage below the sample floor", () => {
  const rates = buildOutcomeRates([app("interview", 85), app("rejected", 70), app("applied", 80)]);
  assert.equal(rates.overall.pct, null);
  assert.match(rates.overall.display, /n\/a \(2 of 5 outcomes needed\)/);
  assert.equal(rates.overall.inFlight, 1);
  assert.doesNotMatch(formatOutcomeRates(rates), /\d+%/);
});

test("rate excludes in-flight and splits by score band", () => {
  const apps = [
    ...Array.from({ length: 4 }, () => app("interview", 90)),
    app("rejected", 85),
    ...Array.from({ length: 5 }, () => app("rejected", 50)),
    ...Array.from({ length: 20 }, () => app("applied", 70)),
    app("interview", 70),
    app("hold", null),
  ];
  const rates = buildOutcomeRates(apps);
  assert.equal(rates.overall.resolved, 11);
  assert.equal(rates.overall.pct, Math.round((5 / 11) * 100));
  assert.equal(rates.overall.inFlight, 20);
  const high = rates.bands.find((b) => b.id === "high");
  assert.equal(high.pct, 80);
  const stretch = rates.bands.find((b) => b.id === "stretch");
  assert.equal(stretch.pct, 0);
  const medium = rates.bands.find((b) => b.id === "medium");
  assert.equal(medium.pct, null);
  assert.equal(medium.inFlight, 20);
});

test("careerrat outcomes reads the tracker without the web app", (t) => {
  const home = mkdtempSync(join(tmpdir(), "careerrat-outcomes-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  mkdirSync(join(home, "workspace"), { recursive: true });
  writeFileSync(
    join(home, "workspace/tracker.json"),
    JSON.stringify({ applications: [app("applied", 80), app("interview", 80)] })
  );
  const result = spawnSync(
    process.execPath,
    [join(root, "bin/careerrat.mjs"), "outcomes", "--json"],
    {
      env: {
        PATH: process.env.PATH,
        HOME: home,
        CAREERRAT_HOME: home,
        CAREERRAT_NO_UPDATE_CHECK: "1",
      },
      encoding: "utf8",
    }
  );
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const out = JSON.parse(result.stdout);
  assert.equal(out.ok, true);
  assert.equal(out.overall.pct, null);
  assert.equal(out.overall.inFlight, 1);
});
