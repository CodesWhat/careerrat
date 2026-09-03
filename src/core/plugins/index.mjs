// index.mjs — the plugin layer's public surface: discovers bundled plugins
// under plugins/<name>/ and re-exports the rest of the core (manifest
// validation, context building, consent, audit, the runner) as one import
// point for callers (a future CLI verb, the h1b-sponsor slice, tests).

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { recordPluginRun } from "./audit.mjs";
import { pluginAllowed } from "./consent.mjs";
import { buildPluginContext } from "./ctx.mjs";
import { validateManifest } from "./manifest.mjs";
import { runPlugin } from "./runner.mjs";

const DEFAULT_ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const PLUGINS_SUBDIR = "plugins";

// Reads every plugins/<name>/manifest.json, validates it, and returns the
// validated manifests (name asc). An invalid or unreadable manifest is
// skipped rather than thrown — a single broken bundled plugin should never
// take the rest of the plugin listing down with it.
export function listBundledPlugins({ root = DEFAULT_ROOT } = {}) {
  const pluginsDir = join(root, PLUGINS_SUBDIR);
  if (!existsSync(pluginsDir)) return [];

  const names = readdirSync(pluginsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();

  const manifests = [];
  for (const name of names) {
    const manifestPath = join(pluginsDir, name, "manifest.json");
    if (!existsSync(manifestPath)) continue;
    let raw;
    try {
      raw = JSON.parse(readFileSync(manifestPath, "utf8"));
    } catch {
      continue;
    }
    const { ok, manifest } = validateManifest(raw);
    if (ok) manifests.push(manifest);
  }
  return manifests;
}

export { buildPluginContext, pluginAllowed, recordPluginRun, runPlugin, validateManifest };
