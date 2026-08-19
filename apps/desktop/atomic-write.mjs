// apps/desktop/atomic-write.mjs: writes a file by staging to a temp sibling
// then renaming over the target, so a reader (or a process death mid-write)
// never observes a truncated or partially written file. Plain Node fs, no
// Electron import, so it can be unit tested with `node --test` the same way
// update-check.mjs is. Matches the atomic-write pattern already used
// elsewhere in this repo (e.g. src/core/profile/gate-writer.mjs,
// src/core/ai/runtime-selection.mjs).

import { mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

// Writes `contents` to `targetPath` atomically: stage to
// "<targetPath>.<pid>.tmp", then rename into place. rename(2) is atomic on
// the same filesystem, so a reader (or a crash mid-write) only ever sees the
// old file or the fully-written new one, never a partial one. Plain
// writeFileSync(targetPath, ...) instead truncates the target up front, so a
// death between truncation and the write completing leaves it corrupt or
// empty.
//
// If the write or the rename itself throws, the temp file is removed
// best-effort and the original error is rethrown for the caller to handle
// (this module never decides what a write failure means to its caller).
export function writeFileAtomic(targetPath, contents) {
  mkdirSync(dirname(targetPath), { recursive: true });
  const tmpPath = `${targetPath}.${process.pid}.tmp`;
  try {
    writeFileSync(tmpPath, contents);
    renameSync(tmpPath, targetPath);
  } catch (err) {
    try {
      rmSync(tmpPath, { force: true });
    } catch {
      // best-effort cleanup only, the original error is what matters
    }
    throw err;
  }
}
