#!/usr/bin/env node
// Offline lockfile audit. Fails when package-lock.json has an entry that npm ci
// would install without an integrity check or from somewhere other than the
// npm registry: a missing integrity hash, a git/http/file source, or a
// registry URL on another host. Runs without network access so it can sit in
// the structure-guards job.
import { readFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";

const REGISTRY_HOST = "registry.npmjs.org";

export function auditLockfile(lock) {
  const problems = [];
  if (lock?.lockfileVersion !== 3) {
    problems.push(`lockfileVersion ${lock?.lockfileVersion} is not 3`);
  }
  for (const [path, entry] of Object.entries(lock?.packages ?? {})) {
    if (path === "" || entry.link || entry.inBundle || !path.includes("node_modules/")) continue;
    const name = path.replace(/^.*node_modules\//, "") || path;
    if (!entry.resolved) {
      problems.push(`${name}: no resolved URL (${path})`);
      continue;
    }
    let url;
    try {
      url = new URL(entry.resolved);
    } catch {
      problems.push(`${name}: resolved is not a URL (${entry.resolved})`);
      continue;
    }
    if (url.protocol !== "https:" || url.hostname !== REGISTRY_HOST) {
      problems.push(`${name}: resolves outside the npm registry (${entry.resolved})`);
    }
    if (!/^sha(256|384|512)-/.test(entry.integrity ?? "")) {
      problems.push(`${name}: missing or weak integrity hash (${path})`);
    }
  }
  return problems;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const file = process.argv[2] ?? fileURLToPath(new URL("../package-lock.json", import.meta.url));
  const problems = auditLockfile(JSON.parse(readFileSync(file, "utf8")));
  if (problems.length) {
    console.error(`check:lockfile: ${problems.length} problem(s) in ${file}`);
    for (const problem of problems) console.error(`  - ${problem}`);
    process.exit(1);
  }
  console.log("check:lockfile: every entry is an integrity-pinned npm registry tarball");
}
