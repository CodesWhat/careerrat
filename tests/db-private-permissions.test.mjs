import assert from "node:assert/strict";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, test } from "node:test";

import { closeAll, dbFilePath, openDb } from "../src/core/db/connection.mjs";

const roots = [];

after(() => {
  closeAll();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

test("the private database directory and file are owner-only", {
  skip: process.platform === "win32",
}, () => {
  const repoRoot = mkdtempSync(join(tmpdir(), "careerrat-db-private-"));
  roots.push(repoRoot);
  openDb({ repoRoot, env: {} });

  const path = dbFilePath({ repoRoot, env: {} });
  assert.equal(statSync(dirname(path)).mode & 0o077, 0);
  assert.equal(statSync(path).mode & 0o077, 0);
});
