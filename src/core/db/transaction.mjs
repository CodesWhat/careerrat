// transaction.mjs — the one-transaction-per-write-verb primitive (M6 decision 4).
//
// `node:sqlite`'s DatabaseSync has no built-in transaction helper, so every
// write verb hand-wraps its work with this: BEGIN IMMEDIATE (acquire the write
// lock up front, rather than deferring and risking a late SQLITE_BUSY once work
// is already underway) ... COMMIT, with ROLLBACK on any thrown error. `fn` must
// be synchronous, pure DB work — no model calls, no network, no fs-heavy work
// inside the transaction (decision 4); a verb does its filesystem export AFTER
// the transaction commits (see verbs/shared.mjs's runVerb()).
// Transactions the connection is already inside. A nested call (a verb run
// from inside another verb's transaction, so several writes commit or roll
// back together) opens a savepoint instead of a second BEGIN.
const openDepth = new WeakMap();

export function inTransaction(db) {
  return (openDepth.get(db) || 0) > 0;
}

export function withTransaction(db, fn) {
  const depth = openDepth.get(db) || 0;
  if (depth > 0) return withSavepoint(db, depth, fn);
  db.exec("BEGIN IMMEDIATE");
  openDepth.set(db, 1);
  let result;
  try {
    try {
      result = fn();
    } catch (err) {
      rollback(db);
      throw err;
    }
    try {
      db.exec("COMMIT");
    } catch (err) {
      rollback(db);
      throw err;
    }
  } finally {
    openDepth.set(db, 0);
  }
  return result;
}

function withSavepoint(db, depth, fn) {
  const name = `cr_sp_${depth}`;
  db.exec(`SAVEPOINT ${name}`);
  openDepth.set(db, depth + 1);
  try {
    const result = fn();
    db.exec(`RELEASE ${name}`);
    return result;
  } catch (err) {
    try {
      db.exec(`ROLLBACK TO ${name}`);
      db.exec(`RELEASE ${name}`);
    } catch {
      /* the failing statement may already have aborted the transaction */
    }
    throw err;
  } finally {
    openDepth.set(db, depth);
  }
}

function rollback(db) {
  try {
    db.exec("ROLLBACK");
  } catch {
    /* the failing statement may already have aborted the transaction */
  }
}
