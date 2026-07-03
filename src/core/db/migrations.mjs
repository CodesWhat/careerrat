// migrations.mjs — the migration runner (M6 decision 5).
//
// PRAGMA user_version is the gate: it records the highest migration id already
// applied to THIS db file. `_migrations` is the audit log (id/applied_at/name),
// written in the same transaction as the migration it records, so the two can
// never drift apart. Migrations apply strictly ascending, each in its own
// transaction — a failure partway through rolls back only that one migration,
// leaving user_version at the last fully-applied id.
//
// The migrations list itself must already be sequential (1, 2, 3, ...) with no
// gaps and no reordering — this is checked directly against the array's given
// order (not re-sorted first), so a caller that hands in migrations out of
// order is rejected exactly the same as one with a gap.
import { migration001 } from "./migrations/001-init.mjs";
import { migration002 } from "./migrations/002-intake.mjs";

// Add new migrations here, in ascending id order, as the schema evolves.
export const ALL_MIGRATIONS = [migration001, migration002];

function readUserVersion(db) {
  return db.prepare("PRAGMA user_version").get().user_version;
}

function assertSequential(migrations) {
  migrations.forEach((migration, index) => {
    const expected = index + 1;
    if (migration.id !== expected) {
      throw new Error(
        `runMigrations: migration list is not sequential — expected id ${expected} at position ${index}, ` +
          `got id ${migration.id} (name="${migration.name}"). Gaps and out-of-order migrations are rejected.`
      );
    }
  });
}

// Apply every migration with id > the db's current user_version, ascending,
// each in its own BEGIN IMMEDIATE ... COMMIT. Idempotent: re-running against a
// db already at the latest version applies nothing (pending = []).
export function runMigrations(db, migrations = ALL_MIGRATIONS) {
  assertSequential(migrations);

  const from = readUserVersion(db);
  const pending = migrations.filter((migration) => migration.id > from);
  const applied = [];

  for (const migration of pending) {
    db.exec("BEGIN IMMEDIATE");
    try {
      migration.up(db);
      // user_version is a plain integer under our control (migration.id), not
      // caller-supplied — safe to interpolate; PRAGMA doesn't accept bound params.
      db.exec(`PRAGMA user_version = ${migration.id}`);
      db.prepare("INSERT INTO _migrations (id, applied_at, name) VALUES (?, ?, ?)").run(
        migration.id,
        new Date().toISOString(),
        migration.name
      );
      db.exec("COMMIT");
      applied.push(migration.id);
    } catch (err) {
      try {
        db.exec("ROLLBACK");
      } catch {
        /* the failed statement may have already aborted the transaction */
      }
      throw err;
    }
  }

  return { from, to: readUserVersion(db), applied };
}
