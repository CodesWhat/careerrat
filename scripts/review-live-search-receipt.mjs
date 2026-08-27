#!/usr/bin/env node

import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import { reviewLiveSearchReceipt } from "./lib/live-search-receipts.mjs";

const [receiptArg, reviewerArg, ...rowIdentities] = process.argv.slice(2);
if (!receiptArg || !reviewerArg || rowIdentities.length === 0) {
  console.error(
    "Usage: node scripts/review-live-search-receipt.mjs <receipt.json> <reviewer> <every-row-identity...>"
  );
  process.exit(2);
}

try {
  const receiptPath = resolve(receiptArg);
  const receipt = JSON.parse(readFileSync(receiptPath, "utf8"));
  const reviewed = reviewLiveSearchReceipt({
    receipt,
    reviewer: reviewerArg,
    verifiedAt: new Date().toISOString(),
    rowIdentities,
  });
  writeFileSync(receiptPath, `${JSON.stringify(reviewed, null, 2)}\n`, "utf8");
  console.log(`Recorded manual liveness for ${reviewed.runtimeId}/${reviewed.fixtureId}.`);
} catch (error) {
  console.error(`Live-search receipt review failed: ${error?.message || String(error)}`);
  process.exitCode = 1;
}
