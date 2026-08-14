#!/usr/bin/env node
// Evergreen date-rebase CLI for the demo fixture — a thin wrapper over the shared
// core in src/core/tracker/rebase-dates.mjs. Used by build:demo to rebase a throwaway
// build copy of tracker.json in place, so the rendered demo reads as current. (The db
// demo-seed imports the same core to rebase on `data init --demo`; keeping one
// implementation means the two paths can never drift.)
//
// Usage: node scripts/rebase-demo-dates.mjs <path/to/tracker.json> [referenceToday=YYYY-MM-DD]
import { readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { rebaseTrackerData } from "../src/core/tracker/rebase-dates.mjs";

function main() {
  const [filePath, referenceToday] = process.argv.slice(2);
  if (!filePath) {
    console.error("usage: node scripts/rebase-demo-dates.mjs <tracker.json> [YYYY-MM-DD]");
    process.exit(1);
  }

  const data = JSON.parse(readFileSync(filePath, "utf8"));
  const result = rebaseTrackerData(data, referenceToday);
  if (!result) {
    console.error(
      `no usable meta.demoAnchor (got ${JSON.stringify(data?.meta?.demoAnchor)}); refusing to rebase`
    );
    process.exit(1);
  }

  if (result.deltaDays === 0) {
    console.log(`demoAnchor ${result.fromAnchor} already == today; nothing to shift.`);
    return;
  }

  writeFileSync(filePath, `${JSON.stringify(data, null, 2)}\n`);
  console.log(
    `rebased ${result.count} date values by ${result.deltaDays >= 0 ? "+" : ""}${result.deltaDays}d ` +
      `(${result.fromAnchor} → ${result.toAnchor})`
  );
}

// Run the CLI only when invoked directly.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
