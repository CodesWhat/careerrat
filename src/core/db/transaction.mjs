// transaction.mjs — the one-transaction-per-write-verb primitive (M6 decision 4).
//
// `node:sqlite`'s DatabaseSync has no built-in transaction helper, so every
// write verb hand-wraps its work with this: BEGIN IMMEDIATE (acquire the write
// lock up front, rather than deferring and risking a late SQLITE_BUSY once work
// is already underway) ... COMMIT, with ROLLBACK on any thrown error. `fn` must
// be synchronous, pure DB work — no model calls, no network, no fs-heavy work
// inside the transaction (decision 4); a verb does its filesystem export AFTER
// the transaction commits (see verbs/shared.mjs's runVerb()).
export function withTransaction(db, fn) {
  db.exec("BEGIN IMMEDIATE");
  let result;
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
  return result;
}

function rollback(db) {
  try {
    db.exec("ROLLBACK");
  } catch {
    /* the failing statement may already have aborted the transaction */
  }
}
