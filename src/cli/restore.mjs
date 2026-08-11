#!/usr/bin/env node
// careerrat restore [snapshot] — recover workspace/tracker.json from a snapshot.
//
// Usage:
//   careerrat restore             list available snapshots + confirm-restore newest
//   careerrat restore <name>      restore by exact filename (e.g. tracker-2026-06-20T14-30-00-000Z.json)
//   careerrat restore <index>     restore by 1-based index from the "list" output (newest = 1)

// Node version guard — same minimum as bin/careerrat.mjs.
{
  const major = parseInt(process.versions.node.split(".")[0], 10);
  if (major < 18) {
    process.stderr.write(
      `careerrat requires Node.js >= 18 (you have ${process.versions.node}) — please upgrade.\n`
    );
    process.exit(1);
  }
}

import { copyFileSync, existsSync, renameSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { displayPath, userPath } from "../core/paths/workspace.mjs";
import { listSnapshots } from "../core/tracker/tracker-snapshot.mjs";

const root = join(fileURLToPath(new URL("../..", import.meta.url)));
const pathCtx = { repoRoot: root };

const [selector] = process.argv.slice(2);

// ---- 1. Load snapshot list ----
const snapshots = listSnapshots(pathCtx);

if (snapshots.length === 0) {
  console.log("No snapshots found in", displayPath(pathCtx, "workspace/.snapshots"));
  console.log("Snapshots are written automatically on each dashboard render (up to 20 retained).");
  process.exit(0);
}

// ---- 2. Resolve which snapshot the user wants ----
let chosen = null;

if (!selector) {
  // No arg: list all, then ask the user to confirm restoring the newest.
  printList(snapshots);
  console.log("");
  chosen = snapshots[0];
  console.log(`Will restore newest: ${chosen.name}`);
} else {
  // Try 1-based index first.
  const idx = parseInt(selector, 10);
  if (!Number.isNaN(idx) && idx >= 1 && idx <= snapshots.length) {
    chosen = snapshots[idx - 1];
  } else {
    // Try exact filename match.
    chosen = snapshots.find((s) => s.name === selector);
    if (!chosen) {
      // Try prefix match (user may omit the .json extension or trailing part).
      chosen = snapshots.find((s) => s.name.startsWith(selector));
    }
    if (!chosen) {
      console.error(`No snapshot matching "${selector}".`);
      console.error("Run `careerrat restore` with no argument to list available snapshots.");
      process.exit(1);
    }
  }
  printList(snapshots, chosen);
  console.log("");
  console.log(`Will restore: ${chosen.name}`);
}

// ---- 3. Confirm ----
const trackerPath = userPath(pathCtx, "workspace/tracker.json");
const trackerExists = existsSync(trackerPath);
const backupPath = `${trackerPath}.bak`;

console.log("");
if (trackerExists) {
  console.log(`Current tracker.json will be backed up to: ${backupPath}`);
}
const confirmed = await confirm("Proceed? [y/N] ");
if (!confirmed) {
  console.log("Restore cancelled.");
  process.exit(0);
}

// ---- 4. Back up current tracker.json, then copy snapshot over it ----
if (trackerExists) {
  try {
    renameSync(trackerPath, backupPath);
    console.log(`Backed up: ${displayPath(pathCtx, "workspace/tracker.json")} → ${backupPath}`);
  } catch (err) {
    console.error(`Failed to back up tracker.json: ${err.message}`);
    process.exit(1);
  }
}

try {
  copyFileSync(chosen.full, trackerPath);
  console.log(`Restored: ${chosen.name} → ${displayPath(pathCtx, "workspace/tracker.json")}`);
} catch (err) {
  // If the copy failed, try to restore the backup so we're not left with nothing.
  if (trackerExists) {
    try {
      renameSync(backupPath, trackerPath);
      console.error(`Copy failed; backup restored. Error: ${err.message}`);
    } catch {
      console.error(`Copy failed AND backup restore failed. Error: ${err.message}`);
      console.error(`Your backup is at: ${backupPath}`);
    }
  } else {
    console.error(`Copy failed: ${err.message}`);
  }
  process.exit(1);
}

// ---- helpers ----

function printList(list, highlight = null) {
  const snapshotDirDisplay = displayPath(pathCtx, "workspace/.snapshots");
  console.log(`Available snapshots in ${snapshotDirDisplay} (newest first):`);
  console.log("");
  for (let i = 0; i < list.length; i++) {
    const s = list[i];
    const ts = new Date(s.mtime).toISOString().replace("T", " ").slice(0, 19);
    const marker = highlight && s.name === highlight.name ? " ← selected" : "";
    console.log(`  ${String(i + 1).padStart(2)}.  ${s.name}  (${ts} UTC)${marker}`);
  }
}

function confirm(prompt) {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    rl.question(prompt, (answer) => {
      rl.close();
      resolve(answer.trim().toLowerCase() === "y");
    });
  });
}
