#!/usr/bin/env node

import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { verifyLiveSearchReceiptDirectory } from "./lib/live-search-receipts.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

try {
  const result = verifyLiveSearchReceiptDirectory({ repoRoot });
  console.log(
    `PASS native AI search release evidence ${result.combinations.join(", ")} from ${result.sourceRevision}`
  );
} catch (error) {
  console.error(`Native AI search release evidence failed: ${error?.message || String(error)}`);
  process.exitCode = 1;
}
