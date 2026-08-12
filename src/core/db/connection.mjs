// connection.mjs — opens (and migrates) the sqlite db under the data root.
//
// The db file lives at `<dataRoot>/db/careerrat.db` — resolved through the same
// path helpers the rest of the engine uses (workspace.mjs's dataPath/
// privateDataRoot) so CAREERRAT_HOME (the Electron packaged app's override)
// keeps working, and so the db always lands inside the already-gitignored
// `.careerrat/` root, never a hardcoded path (M6 decision 2).
//
// One connection per data root, cached in a module-level Map (mirroring
// storage-adapter.mjs's defaultAdapter() singleton pattern) — a process opens
// each distinct data root's db exactly once, applies its per-connection
// PRAGMAs, and runs pending migrations, all on first open.
import { existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { dataPath, privateDataRoot } from "../paths/workspace.mjs";
import { runMigrations } from "./migrations.mjs";

const DB_REL_PATH = "db/careerrat.db";

// Keyed by resolved data root (not repoRoot alone) — CAREERRAT_HOME can point
// two different repoRoots at the same data root, or the same repoRoot at two
// different data roots across tests; the cache must key on the thing that
// actually determines the db file.
const _connections = new Map();

export function dbFilePath({ repoRoot, env } = {}) {
  return dataPath({ repoRoot, env }, DB_REL_PATH);
}

export function dbExists({ repoRoot, env } = {}) {
  return existsSync(dbFilePath({ repoRoot, env }));
}

// busy_timeout + foreign_keys are per-connection (decision 3) — must be set on
// every open, not just the first. journal_mode=WAL persists in the file header
// once written, but re-issuing it is a cheap no-op, so we just always set all
// four rather than special-casing "first open of this file ever".
function applyPragmas(db) {
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");
  db.exec("PRAGMA synchronous = NORMAL");
  db.exec("PRAGMA busy_timeout = 5000");
}

export function openDb({ repoRoot, env } = {}) {
  const key = privateDataRoot({ repoRoot, env });
  const cached = _connections.get(key);
  if (cached) return cached;

  const path = dbFilePath({ repoRoot, env });
  mkdirSync(dirname(path), { recursive: true });

  const db = new DatabaseSync(path);
  applyPragmas(db);
  runMigrations(db);

  _connections.set(key, db);
  return db;
}

// Test-only teardown: close every cached connection and forget it, so a fresh
// `openDb()` call re-opens the file (and re-runs any pending migrations)
// instead of handing back a stale handle from a previous test's temp dir.
export function closeAll() {
  for (const db of _connections.values()) {
    try {
      db.close();
    } catch {
      /* already closed / file removed out from under us — fine for teardown */
    }
  }
  _connections.clear();
}

export const NO_DATABASE_MESSAGE =
  "no database yet — run 'careerrat data import' to migrate this workspace, or 'careerrat data init' to start fresh";

export class NoDatabaseError extends Error {
  constructor(message = NO_DATABASE_MESSAGE) {
    super(message);
    this.name = "NoDatabaseError";
    this.code = "NO_DATABASE";
  }
}

// Fail-closed accessor (decision 7) for every DB-consuming path that is NOT
// itself responsible for creating the db. `init`/`import`/`seedDemo` call
// openDb() directly, since create-on-first-use is exactly their job; every
// verb, every read route, and `status`/`export`/`verify` go through this
// instead — no db file means a clear, actionable error, NEVER a silent
// empty-db auto-create and NEVER a silent fallback to reading tracker.json.
export function requireDb({ repoRoot, env } = {}) {
  if (!dbExists({ repoRoot, env })) {
    throw new NoDatabaseError();
  }
  return openDb({ repoRoot, env });
}
