// routes.mjs — reads config/paste-intake-routes.json, the SSOT the classify
// prompt is built from (see that file's own $comment for the parity contract
// with AGENTS.md's Paste Intake table, enforced by
// tests/paste-intake-parity.test.mjs). One read helper here so
// classify.mjs, dispatch.mjs, and the parity test never each parse the file
// their own way.
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROUTES_RELPATH = "config/paste-intake-routes.json";

// Repo-root-relative, not workspace-relative (userPath) — this is checked-in
// SSOT the codebase ships, not per-candidate workspace data, same as
// config/intake-classify.schema.json and every other config/*.schema.json.
export function loadPasteIntakeRoutes(repoRoot) {
  const path = join(repoRoot, ROUTES_RELPATH);
  return JSON.parse(readFileSync(path, "utf8"));
}

// The classify prompt's route digest: one entry per M9-active kind (skips
// "deferred" rows entirely — the model is never told about a lane this
// milestone can't dispatch into) plus the catch-all "other" -> needs_you
// kind, grouping every AGENTS.md row that shares a kind (e.g. "interview
// invite" and "interview notes / a transcript" both collapse to
// "interview-transcript") so the prompt lists each kind once with every
// example that maps to it, pulled straight from the SSOT rather than
// hand-duplicated.
export function buildClassifyRouteDigest(routesDoc) {
  const byKind = new Map();
  for (const route of routesDoc?.routes || []) {
    if (route.m9?.status !== "active" && route.m9?.status !== "needs_you") continue;
    const kinds = route.m9.kinds.length ? route.m9.kinds : ["other"];
    for (const kind of kinds) {
      if (!byKind.has(kind)) byKind.set(kind, { kind, examples: [], capturesInto: [] });
      const entry = byKind.get(kind);
      entry.examples.push(route.whatTheyPasted);
      entry.capturesInto.push(route.capturesInto);
    }
  }
  return Array.from(byKind.values());
}
