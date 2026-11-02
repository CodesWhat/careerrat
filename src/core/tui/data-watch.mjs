import { statSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { dbFilePath } from "../db/connection.mjs";
import { userPath } from "../paths/workspace.mjs";

function signature(path) {
  try {
    const info = statSync(path);
    return `${info.ino}:${info.size}:${info.mtimeMs}`;
  } catch {
    return null;
  }
}

// Polls a cheap change marker instead of re-reading the workspace: SQLite's
// data_version moves only when another connection commits, so this probe's own
// reads (and the session's) never look like a change. Before the database
// exists, the legacy tracker.json file signature stands in for it.
export function createDataWatch({ ctx, onChange, onError = () => {}, interval = 400 }) {
  const dbPath = dbFilePath(ctx);
  const legacyPath = userPath(ctx, "workspace/tracker.json");
  let db = null;
  let dbIdentity = null;
  let marker = null;
  let lastError = "";
  let closed = false;

  function closeProbe() {
    try {
      db?.close();
    } catch {
      // Already closed or the file is gone.
    }
    db = null;
    dbIdentity = null;
  }
  function probe() {
    const identity = signature(dbPath)?.split(":")[0] ?? null;
    if (identity === null) {
      closeProbe();
      return `legacy:${signature(legacyPath)}`;
    }
    if (db && identity !== dbIdentity) closeProbe();
    if (!db) {
      db = new DatabaseSync(dbPath, { readOnly: true });
      db.exec("PRAGMA busy_timeout = 1000");
      dbIdentity = identity;
    }
    return `db:${identity}:${db.prepare("PRAGMA data_version").get().data_version}`;
  }
  function check() {
    if (closed) return;
    let next;
    try {
      next = probe();
      lastError = "";
    } catch (error) {
      closeProbe();
      if (error.message !== lastError) {
        lastError = error.message;
        onError(error);
      }
      return;
    }
    if (next === marker) return;
    marker = next;
    onChange();
  }

  try {
    marker = probe();
  } catch (error) {
    closeProbe();
    lastError = error.message;
    onError(error);
  }
  const timer = setInterval(check, interval);
  timer.unref?.();
  return {
    check,
    close() {
      closed = true;
      clearInterval(timer);
      closeProbe();
    },
  };
}
