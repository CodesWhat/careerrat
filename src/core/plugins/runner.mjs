// runner.mjs — loads and runs one bundled plugin end to end: manifest, consent,
// context, entry module, timeout, audit row. This is the only place that turns
// a plugin name into code actually executing, so every failure mode (missing
// plugin, bad manifest, consent refused, entry that throws or hangs) is caught
// here and turned into a plain { ok: false, error } instead of an unhandled
// rejection or a crash.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { recordPluginRun } from "./audit.mjs";
import { pluginAllowed } from "./consent.mjs";
import { buildPluginContext } from "./ctx.mjs";
import { validateManifest } from "./manifest.mjs";

const DEFAULT_ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const DEFAULT_TIMEOUT_MS = 20_000;

function plainError(message) {
  return { message: String(message || "plugin run failed") };
}

// Wraps `promise` so it settles no later than timeoutMs. A handler is
// attached to `promise` unconditionally (via .then), so a plugin promise
// that resolves/rejects AFTER the timeout has already fired is still
// observed here rather than becoming an unhandled rejection.
function withTimeout(promise, timeoutMs, pluginName) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`plugin "${pluginName}" timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    Promise.resolve(promise).then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      }
    );
  });
}

export async function runPlugin(name, input = {}) {
  const {
    role = null,
    company = null,
    jd = null,
    targeting = null,
    roleId = null,
    cfg = null,
    root = DEFAULT_ROOT,
    env = process.env,
    timeoutMs = DEFAULT_TIMEOUT_MS,
  } = input || {};

  const pluginName = String(name || "").trim();
  const startedAt = new Date().toISOString();

  const finish = ({ ok, result = null, error = null, version = null, fetched = [] }) => {
    const finishedAt = new Date().toISOString();
    let audit = null;
    try {
      audit = recordPluginRun({
        plugin: pluginName || "(unknown)",
        version,
        roleId,
        startedAt,
        finishedAt,
        ok,
        error,
        fetched,
        root,
        env,
      });
    } catch (auditError) {
      // The audit write is best-effort: a broken activity feed must never
      // hide (or crash on top of) the plugin's own success/failure result.
      audit = { ok: false, error: auditError?.message || String(auditError) };
    }
    return { ok, result, error, audit };
  };

  if (!pluginName) {
    return finish({ ok: false, error: plainError("a plugin name is required") });
  }

  const manifestPath = join(root, "plugins", pluginName, "manifest.json");
  if (!existsSync(manifestPath)) {
    return finish({ ok: false, error: plainError(`no plugin named "${pluginName}"`) });
  }

  let raw;
  try {
    raw = JSON.parse(readFileSync(manifestPath, "utf8"));
  } catch (err) {
    return finish({
      ok: false,
      error: plainError(`plugin manifest is not valid JSON: ${err.message}`),
    });
  }

  const { ok: manifestOk, manifest, errors } = validateManifest(raw);
  if (!manifestOk) {
    return finish({
      ok: false,
      error: plainError(`invalid plugin manifest: ${errors.join("; ")}`),
    });
  }

  const consent = pluginAllowed({ manifest, cfg, root, env });
  if (!consent.allowed) {
    return finish({
      ok: false,
      version: manifest.version,
      error: plainError(consent.reason || "plugin is not allowed to run"),
    });
  }

  const fetched = [];
  const baseCtx = buildPluginContext({ manifest, role, company, jd, targeting });
  // Wraps ctx.fetch only to record which hosts were actually hit, for the
  // audit row's `fetched` list — the allow/deny decision itself stays in
  // baseCtx.fetch, untouched.
  const ctx = Object.freeze({
    ...baseCtx,
    fetch: async (url) => {
      const result = await baseCtx.fetch(url);
      // Only a host the request actually reached counts as "hit" — a
      // disallowed or invalid URL never touched the network, so it stays out
      // of the audit row's `fetched` list.
      if (result?.ok) {
        try {
          fetched.push(new URL(String(url)).hostname.toLowerCase());
        } catch {
          // Unreachable in practice: an unparseable URL already fails ok:false.
        }
      }
      return result;
    },
  });

  const entryPath = join(root, "plugins", pluginName, manifest.entry);
  let entryModule;
  try {
    entryModule = await import(pathToFileURL(entryPath).href);
  } catch (err) {
    return finish({
      ok: false,
      version: manifest.version,
      error: plainError(`failed to load plugin entry: ${err.message}`),
    });
  }

  const run = entryModule?.default;
  if (typeof run !== "function") {
    return finish({
      ok: false,
      version: manifest.version,
      error: plainError("plugin entry has no default export function"),
    });
  }

  try {
    const result = await withTimeout(run(ctx), timeoutMs, pluginName);
    return finish({ ok: true, result, version: manifest.version, fetched });
  } catch (err) {
    return finish({
      ok: false,
      version: manifest.version,
      error: plainError(err?.message || String(err)),
      fetched,
    });
  }
}
