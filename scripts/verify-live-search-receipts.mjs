#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { verifyLiveSearchReceiptDirectory } from "./lib/live-search-receipts.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(readFileSync(resolve(repoRoot, "package.json"), "utf8"));

try {
  const result = verifyLiveSearchReceiptDirectory({ repoRoot, releaseVersion: pkg.version });
  if (result.evidenceStatus === "version-scoped-exception") {
    console.log(
      `EXCEPTION native AI search release evidence ${result.combinations.join(", ")} from ${result.sourceRevision}; waived ${result.waivedCombinations.join(", ")} (${result.reasonCode})`
    );
  } else {
    console.log(
      `PASS native AI search release evidence ${result.combinations.join(", ")} from ${result.sourceRevision}`
    );
  }
} catch (error) {
  console.error(`Native AI search release evidence failed: ${error?.message || String(error)}`);
  process.exitCode = 1;
}
