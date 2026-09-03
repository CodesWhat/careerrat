// index.mjs — the plugin layer's public surface: discovers bundled plugins
// under plugins/<name>/ and re-exports the rest of the core (manifest
// validation, context building, consent, audit, the runner) as one import
// point for callers (a future CLI verb, the h1b-sponsor slice, tests).

import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
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
// left standing. Checks: manifest.json exists, is contained inside plugins/,
// parses, and validates; its declared name matches the directory it was
// loaded from; and its entry file is contained inside plugins/ and resolves
// to a regular file (reusing runner.mjs's own containment check rather than
// a second copy of that logic, and matching the exact preflight order
// runPlugin itself applies: directory, then manifest, then entry).
//
// Always returns { ok, root, error, plugins } rather than a bare array —
// `plugins` carries the previous per-plugin array, and `ok`/`error` name a
// directory-level failure (an unreadable root, or a `plugins` path that
// exists but isn't a directory) distinctly from "zero bundled plugins",
// which is a normal, ok:true state. Never throws: every enumeration failure
// is caught and reported through this same shape, so a caller (doctor, the
// `plugins verify` CLI) always gets a plain, JSON-serializable result
// instead of a synchronous crash.
export function verifyBundledPlugins({ root = DEFAULT_ROOT } = {}) {
  if (!existsSync(root)) {
    return { ok: false, root, error: `plugins root does not exist: ${root}`, plugins: [] };
  }

  const pluginsDir = join(root, PLUGINS_SUBDIR);
  if (!existsSync(pluginsDir)) return { ok: true, root, error: null, plugins: [] };

  let names;
  try {
    names = readdirSync(pluginsDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
  } catch (err) {
    return {
      ok: false,
      root,
      error: `could not enumerate the plugins directory: ${err.message}`,
      plugins: [],
    };
  }

  let pluginsDirReal;
  try {
    pluginsDirReal = realpathSync(pluginsDir);
  } catch (err) {
    return {
      ok: false,
      root,
      error: `could not resolve the plugins directory: ${err.message}`,
      plugins: names.map((name) => ({
        name,
        ok: false,
        errors: [`could not resolve plugins directory: ${err.message}`],
      })),
    };
  }

  const plugins = names.map((name) => {
    const pluginDir = join(pluginsDir, name);
    const dirEscape = containmentError(pluginDir, pluginsDirReal, "plugin directory");
    if (dirEscape) return { name, ok: false, errors: [dirEscape.message] };

    const manifestPath = join(pluginDir, "manifest.json");
    if (!existsSync(manifestPath)) {
      return { name, ok: false, errors: ["manifest.json not found"] };
    }
    // Applied BEFORE the manifest is ever read — a manifest.json that is
    // itself a symlink pointing outside plugins/ must never verify as valid
    // just because it happens to parse and validate.
    const manifestEscape = containmentError(manifestPath, pluginsDirReal, "plugin manifest");
    if (manifestEscape) return { name, ok: false, errors: [manifestEscape.message] };

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

    const entryPath = join(pluginDir, manifest.entry);
    if (!existsSync(entryPath)) {
      rowErrors.push(`entry file not found: ${manifest.entry}`);
    } else {
      const entryEscape = containmentError(entryPath, pluginsDirReal, "plugin entry");
      if (entryEscape) {
        rowErrors.push(entryEscape.message);
      } else {
        // A contained entry that exists but is a directory (e.g. entry: ".")
        // would otherwise verify clean and only fail later, at runPlugin's
        // dynamic import.
        try {
          if (!statSync(realpathSync(entryPath)).isFile()) {
            rowErrors.push(`entry is not a regular file: ${manifest.entry}`);
          }
        } catch (err) {
          rowErrors.push(`could not stat entry file: ${err.message}`);
        }
      }
    }

    return { name, ok: rowErrors.length === 0, errors: rowErrors };
  });

  return { ok: plugins.every((p) => p.ok), root, error: null, plugins };
}

export { buildPluginContext, pluginAllowed, recordPluginRun, runPlugin, validateManifest };
