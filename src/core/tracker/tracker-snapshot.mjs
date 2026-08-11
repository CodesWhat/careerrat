// tracker-snapshot.mjs — rolling JSON-layer durability for workspace/tracker.json.
//
// tracker.json is the agent's source of truth, mutated directly by file-tool edits.
// There is no code write-path to make the mutation atomic. This module adds a cheap
// recovery layer: on every render (dashboard re-render is the trigger) we copy the
// current tracker.json into workspace/.snapshots/tracker-<fs-safe-ISO>.json, skipping
// the copy when content is identical to the newest existing snapshot (so repeated
// renders never pile duplicates), then rotate to the newest `max`.
//
// All errors are swallowed — a snapshot failure must never break a render.

import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  unlinkSync,
} from "node:fs";
import { join } from "node:path";
import { readEnv } from "../env-compat.mjs";
import { userPath } from "../paths/workspace.mjs";

export const SNAPSHOT_SUBDIR = "workspace/.snapshots";

// Resolve the absolute path for a relative workspace subpath.
function absPath(pathCtx, relPath) {
  return userPath(pathCtx, relPath);
}

// Return the absolute snapshots directory for the given pathCtx.
function snapshotDir(pathCtx) {
  return absPath(pathCtx, SNAPSHOT_SUBDIR);
}

// Convert an ISO timestamp into a filesystem-safe name by replacing ":" and "."
// with "-". Example: 2026-06-20T14:30:00.000Z → 2026-06-20T14-30-00-000Z
function isoToFsSafe(iso) {
  return iso.replace(/[:.]/g, "-");
}

// ---------------------------------------------------------------------------
// listSnapshots — newest-first [{name, full, mtime}]
// ---------------------------------------------------------------------------

export function listSnapshots(pathCtx) {
  const dir = snapshotDir(pathCtx);
  if (!existsSync(dir)) return [];
  let entries;
  try {
    entries = readdirSync(dir).filter((n) => n.startsWith("tracker-") && n.endsWith(".json"));
  } catch {
    return [];
  }
  const items = [];
  for (const name of entries) {
    const full = join(dir, name);
    try {
      const st = statSync(full);
      items.push({ name, full, mtime: st.mtimeMs });
    } catch {
      // skip unreadable entry
    }
  }
  // Newest first (by mtime, then lexical for ties).
  items.sort((a, b) => b.mtime - a.mtime || b.name.localeCompare(a.name));
  return items;
}

// ---------------------------------------------------------------------------
// snapshotTracker — safe, never throws
// ---------------------------------------------------------------------------

export function snapshotTracker(
  pathCtx,
  { max = Number(readEnv("CAREERRAT_TRACKER_SNAPSHOTS")) || 20, now = new Date() } = {}
) {
  try {
    const trackerPath = absPath(pathCtx, "workspace/tracker.json");
    if (!existsSync(trackerPath)) {
      return { ok: true, skipped: true, reason: "tracker.json not found" };
    }

    const currentContent = readFileSync(trackerPath, "utf8");

    // Skip if content matches the newest existing snapshot.
    const existing = listSnapshots(pathCtx);
    if (existing.length > 0) {
      try {
        const newestContent = readFileSync(existing[0].full, "utf8");
        if (newestContent === currentContent) {
          return { ok: true, skipped: true, reason: "unchanged" };
        }
      } catch {
        // If we can't read the newest snapshot, proceed to write a new one.
      }
    }

    // Ensure .snapshots directory exists.
    const dir = snapshotDir(pathCtx);
    mkdirSync(dir, { recursive: true });

    // Write the new snapshot.
    const stamp = isoToFsSafe(now.toISOString());
    const snapshotName = `tracker-${stamp}.json`;
    const snapshotPath = join(dir, snapshotName);
    copyFileSync(trackerPath, snapshotPath);

    // Rotate: keep only the newest `max` snapshots.
    // Re-list after write so the new file is included in the rotation.
    const allAfterWrite = listSnapshots(pathCtx);
    const toDelete = allAfterWrite.slice(max);
    for (const old of toDelete) {
      try {
        unlinkSync(old.full);
      } catch {
        // best-effort; don't fail the snapshot on a rotation error
      }
    }

    return { ok: true, wrote: snapshotPath };
  } catch (err) {
    return { ok: false, error: err?.message ?? String(err) };
  }
}
