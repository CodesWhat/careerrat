// holders.mjs — which CareerRat processes keep the database open.
//
// A restore deletes the live database file and copies another in. A process
// that already has the old file open keeps writing to the deleted one, and
// those writes are lost without a word. So every long-lived CareerRat process
// (the TUI, the `careerrat start` server, a background search worker) leaves a
// small file here while it runs, and a restore refuses while any of them is
// alive. Each file is removed on a normal exit; a crash leaves one behind, and
// it stops counting once its process is gone.
import { randomUUID } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { userPath } from "../paths/workspace.mjs";

const LABELS = {
  tui: "the CareerRat TUI",
  server: "the CareerRat server (careerrat start)",
  search: "a background job search",
};

// Beside the other internal runtime state, not in db/, so a legacy workspace
// with no database yet doesn't grow a db folder just from being opened.
export function holdersDir(ctx = {}) {
  return userPath(ctx, ".internal/holders");
}

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means it exists and belongs to someone else.
    return error.code === "EPERM";
  }
}

// Record that this process holds the database until release() is called or the
// process exits. Never throws: failing to leave a marker must not stop the app.
export function registerDbHolder(ctx = {}, kind = "tui") {
  const file = join(holdersDir(ctx), `${process.pid}-${kind}-${randomUUID().slice(0, 8)}.json`);
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    process.off("exit", release);
    rmSync(file, { force: true });
  };
  try {
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    writeFileSync(
      file,
      JSON.stringify({ pid: process.pid, kind, startedAt: new Date().toISOString() }),
      { mode: 0o600 }
    );
    process.on("exit", release);
  } catch {
    released = true;
  }
  return release;
}

// The server already records itself in the workspace's runtime owner file, so
// that file counts as its marker.
function serverHolder(ctx) {
  const file = userPath(ctx, ".internal/app-runtime.owner");
  try {
    const owner = JSON.parse(readFileSync(file, "utf8"));
    if (Number.isInteger(owner?.pid) && owner.pid > 0 && alive(owner.pid))
      return { pid: owner.pid, kind: "server", startedAt: owner.acquiredAt ?? "", file };
  } catch {
    // No server owns this workspace.
  }
  return null;
}

// Live holders other than this process, newest first. Markers of dead
// processes are cleaned up as they are found.
export function activeDbHolders(ctx = {}, { ignorePid = process.pid } = {}) {
  const dir = holdersDir(ctx);
  let names = [];
  try {
    names = readdirSync(dir);
  } catch {
    // No markers yet.
  }
  const found = [];
  const server = serverHolder(ctx);
  if (server && server.pid !== ignorePid) found.push(server);
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    const file = join(dir, name);
    let entry;
    try {
      entry = JSON.parse(readFileSync(file, "utf8"));
    } catch {
      rmSync(file, { force: true });
      continue;
    }
    if (!Number.isInteger(entry?.pid) || entry.pid < 1 || !alive(entry.pid)) {
      rmSync(file, { force: true });
      continue;
    }
    if (entry.pid !== ignorePid) found.push({ ...entry, file });
  }
  return found.sort((a, b) => String(b.startedAt).localeCompare(String(a.startedAt)));
}

export function describeDbHolders(holders) {
  return holders.map((holder) => `${LABELS[holder.kind] || holder.kind} (process ${holder.pid})`);
}

export class DatabaseInUseError extends Error {
  constructor(holders) {
    super(
      `can't restore while CareerRat is running: ${describeDbHolders(holders).join(", ")} ` +
        "has the database open and would keep writing to the old one. Quit it (or stop that " +
        "process), then run the restore again. If that process is already gone, delete " +
        `${holders.map((holder) => holder.file).join(", ")}`
    );
    this.name = "DatabaseInUseError";
    this.code = "DB_IN_USE";
    this.holders = holders;
  }
}

export function assertNoDbHolders(ctx = {}, options) {
  const holders = activeDbHolders(ctx, options);
  if (holders.length) throw new DatabaseInUseError(holders);
}
