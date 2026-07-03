#!/usr/bin/env node
// tests/fixtures/db-concurrency-worker.mjs — a small standalone worker spawned
// by tests/db-concurrency.test.mjs as a real, separate OS process. Each of two
// (or more) instances hammers the SAME sqlite db file with `count` sequential
// appUpsert() calls against the same application id, so the shared db sees
// genuinely overlapping writers — this is what actually exercises WAL +
// busy_timeout, not just two in-process calls sharing one connection.
//
// argv: <repoRoot> <count> <workerLabel>
import { appUpsert } from "../../src/core/db/verbs.mjs";

const [repoRoot, countArg, workerLabel] = process.argv.slice(2);
const count = Number.parseInt(countArg, 10);

for (let i = 0; i < count; i++) {
  appUpsert({
    repoRoot,
    row: {
      id: "app-concurrent",
      company: "Acme",
      role: "Eng",
      status: "sourced",
      lastWriter: workerLabel,
      i,
    },
  });
}

process.exit(0);
