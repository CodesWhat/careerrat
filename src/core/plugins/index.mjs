// index.mjs — the plugin layer's public surface: discovers bundled plugins
// under plugins/<name>/ and re-exports the rest of the core (manifest
// validation, context building, consent, audit, the runner) as one import
// point for callers (a future CLI verb, the h1b-sponsor slice, tests).

import { existsSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { recordPluginRun } from "./audit.mjs";
import { pluginAllowed } from "./consent.mjs";
import { buildPluginContext } from "./ctx.mjs";
import { validateManifest } from "./manifest.mjs";
import { containmentError, runPlugin } from "./runner.mjs";

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

// Validates every bundled plugin directory (name asc) and reports per-plugin
// pass/fail, unlike listBundledPlugins which silently drops anything invalid.
// Used by the `careerrat plugins verify` CLI and by doctor's plugin block —
// both need to name which bundled manifest is broken, not just how many are
// left standing. Checks: manifest.json exists, parses, and validates; its
// declared name matches the directory it was loaded from; and its entry file
// exists and stays contained inside plugins/ (reusing runner.mjs's own
// containment check rather than a second copy of that logic).
export function verifyBundledPlugins({ root = DEFAULT_ROOT } = {}) {
  const pluginsDir = join(root, PLUGINS_SUBDIR);
  if (!existsSync(pluginsDir)) return [];

  const names = readdirSync(pluginsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();

  let pluginsDirReal;
  try {
    pluginsDirReal = realpathSync(pluginsDir);
  } catch (err) {
    return names.map((name) => ({
      name,
      ok: false,
      errors: [`could not resolve plugins directory: ${err.message}`],
    }));
  }

  return names.map((name) => {
    const manifestPath = join(pluginsDir, name, "manifest.json");
    if (!existsSync(manifestPath)) {
      return { name, ok: false, errors: ["manifest.json not found"] };
    }

    let raw;
    try {
      raw = JSON.parse(readFileSync(manifestPath, "utf8"));
    } catch (err) {
      return { name, ok: false, errors: [`manifest.json is not valid JSON: ${err.message}`] };
    }

    const { ok, manifest, errors } = validateManifest(raw);
    if (!ok) return { name, ok: false, errors };

    const rowErrors = [];
    if (manifest.name !== name) {
      rowErrors.push(`manifest name "${manifest.name}" does not match directory "${name}"`);
    }

    const entryPath = join(pluginsDir, name, manifest.entry);
    if (!existsSync(entryPath)) {
      rowErrors.push(`entry file not found: ${manifest.entry}`);
    } else {
      const escaped = containmentError(entryPath, pluginsDirReal, "plugin entry");
      if (escaped) rowErrors.push(escaped.message);
    }

    return { name, ok: rowErrors.length === 0, errors: rowErrors };
  });
}

export { buildPluginContext, pluginAllowed, recordPluginRun, runPlugin, validateManifest };
