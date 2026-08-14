// storage-adapter.mjs — the local↔hosted storage seam (Productization Phase 0, P0-1).
//
// Every mutating skill today reads/writes tracker.json, activity.jsonl, and workspace
// files directly via fs + the path-resolution helpers in paths/workspace.mjs. That's
// fine for a single-user local install, but the embedded API server / hosted runtime
// roadmapped next needs a swap point: same six calls, backed by Postgres/object storage
// instead of the filesystem, without touching every call-site.
//
// createLocalFsAdapter(pathCtx) is that seam's first (and today, only) implementation.
// It does NOT reimplement storage logic — it delegates to the existing canonical
// primitives (writeTrackerJson, activity-log's read/append, gate-writer's
// atomicWriteFile) so behavior stays byte-identical to direct calls. The adapter's
// value is purely the uniform JSON-in/JSON-out interface a future hosted adapter can
// mirror; keep it minimal, don't grow it into a second source of truth.
//
// readFile/writeFile are scoped to the resolved workspace root (not the whole repo) and
// reject any relPath that escapes it — same shape as safeAssetPath in tracker/dev-server.mjs,
// since this is the one place in the seam that takes a caller-supplied path string rather
// than a fixed "workspace/tracker.json"-style constant.

import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, join, normalize, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveUserPaths, userPath } from "../paths/workspace.mjs";
import { atomicWriteFile } from "../profile/gate-writer.mjs";
import {
  appendActivity as appendActivityLog,
  readActivity as readActivityLog,
} from "../tracker/activity-log.mjs";
import { writeTrackerJson } from "../tracker/tracker-writer.mjs";

const DEFAULT_ROOT = fileURLToPath(new URL("../../..", import.meta.url));

// Confine `relPath` to `root`: reject anything absolute or that climbs out via ".."
// before joining, then re-confirm containment after (belt + suspenders against
// platform-specific join/normalize quirks) — the same two-step safeAssetPath uses.
function resolveScoped(root, relPath) {
  const rel = normalize(String(relPath ?? ""));
  if (!rel || rel === "." || rel.startsWith("..") || isAbsolute(rel) || rel.includes("\0")) {
    return null;
  }
  const full = join(root, rel);
  if (full !== root && !full.startsWith(`${root}${sep}`)) return null;
  return full;
}

export function createLocalFsAdapter(pathCtx = {}) {
  return {
    // Raw parsed tracker.json — callers that want the derived view-model use
    // tracker-data.mjs's loadTrackerData() instead; this is the storage primitive.
    readTracker() {
      const trackerPath = userPath(pathCtx, "workspace/tracker.json");
      let raw;
      try {
        raw = readFileSync(trackerPath, "utf8");
      } catch (err) {
        throw new Error(
          `readTracker: no tracker.json at ${trackerPath} (${err.code || err.message})`
        );
      }
      try {
        return JSON.parse(raw);
      } catch (err) {
        throw new Error(
          `readTracker: tracker.json at ${trackerPath} is not valid JSON: ${err.message}`
        );
      }
    },

    // Same stamping semantics as a direct writeTrackerJson call — options pass through
    // untouched ({ stamp, at }) so a caller opting out of the freshness bump still can.
    writeTracker(data, options) {
      const trackerPath = userPath(pathCtx, "workspace/tracker.json");
      return writeTrackerJson(trackerPath, data, options);
    },

    // The adapter owns root scoping — pathCtx.repoRoot always wins over anything a
    // caller passes in `options.root`, so an adapter instance can't be redirected
    // outside the workspace it was constructed for.
    readActivity(options = {}) {
      return readActivityLog({ ...options, root: pathCtx.repoRoot });
    },
    appendActivity(event, options = {}) {
      return appendActivityLog(event, { ...options, root: pathCtx.repoRoot });
    },

    // Workspace-scoped file IO for artifacts that aren't tracker.json/activity.jsonl
    // (e.g. rendered dashboards, saved JD bodies). null means "missing", not an error —
    // callers routinely probe for a file before deciding whether to generate it.
    readFile(relPath) {
      const root = resolveUserPaths(pathCtx).workspaceDir;
      const full = resolveScoped(root, relPath);
      if (!full) throw new Error(`readFile: path escapes the workspace root: "${relPath}"`);
      return existsSync(full) ? readFileSync(full, "utf8") : null;
    },
    writeFile(relPath, content) {
      const root = resolveUserPaths(pathCtx).workspaceDir;
      const full = resolveScoped(root, relPath);
      if (!full) throw new Error(`writeFile: path escapes the workspace root: "${relPath}"`);
      mkdirSync(dirname(full), { recursive: true });
      atomicWriteFile(full, content);
    },
  };
}

// Lazy singleton per repoRoot — the server/CLI process shares one adapter instance
// instead of each call-site constructing its own. Keyed by repoRoot (not a single
// global) so tests and multi-workspace tooling can hold more than one live at once.
const _adapters = new Map();

export function defaultAdapter(repoRoot = DEFAULT_ROOT) {
  if (!_adapters.has(repoRoot)) {
    _adapters.set(repoRoot, createLocalFsAdapter({ repoRoot }));
  }
  return _adapters.get(repoRoot);
}
