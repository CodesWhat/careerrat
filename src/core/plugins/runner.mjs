// runner.mjs — loads and runs one bundled plugin end to end: manifest, consent,
// context, entry module, timeout, audit row. This is the only place that turns
// a plugin name into code actually executing, so every failure mode (missing
// plugin, bad manifest, consent refused, entry that throws or hangs) is caught
// here and turned into a plain { ok: false, error } instead of an unhandled
// rejection or a crash.

import { existsSync, readFileSync, realpathSync } from "node:fs";
import { join, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { recordPluginRun } from "./audit.mjs";
import { pluginAllowed } from "./consent.mjs";
import { buildPluginContext } from "./ctx.mjs";
import { NAME_RE, validateManifest } from "./manifest.mjs";

const DEFAULT_ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const DEFAULT_TIMEOUT_MS = 20_000;

function plainError(message) {
  return { message: String(message || "plugin run failed") };
}

// Same shape as plainError, plus a machine-checkable `code` — used for the
// path/name validations below so a caller (or a test) can branch on the
// failure kind instead of matching on message prose.
function codedError(message, code) {
  return { message: String(message || "plugin run failed"), code };
}

// Resolves `candidate` to its real (symlink-free) absolute path and confirms
// it sits at or under `rootReal` (itself already realpath'd by the caller).
// Returns null when containment holds, or a codedError otherwise — used for
// the plugin directory, its manifest.json, and its entry file, so a symlink
// planted at any of those three positions can't walk a plugin's execution
// outside plugins/.
function containmentError(candidate, rootReal, label) {
  let candidateReal;
  try {
    candidateReal = realpathSync(candidate);
  } catch (err) {
    return codedError(`could not resolve ${label} path: ${err.message}`, "plugin_path_escape");
  }
  const contained = candidateReal === rootReal || candidateReal.startsWith(rootReal + sep);
  if (!contained) {
    return codedError(`${label} resolves outside the plugins directory`, "plugin_path_escape");
  }
  return null;
}

// Wraps `promise` so it settles no later than `controller`'s own abort
// firing. A handler is attached to `promise` unconditionally (via .then), so
// a plugin promise that resolves/rejects AFTER the deadline has already
// fired is still observed here rather than becoming an unhandled rejection.
//
// Deliberately signal-driven rather than owning its own setTimeout: the
// caller starts exactly one timer, before the dynamic import, and this
// helper is used twice against that SAME controller (import + run(ctx)
// together), so the two phases share one deadline instead of each getting
// a fresh timeoutMs.
function withDeadline(promise, controller, timeoutError) {
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(timeoutError);
    if (controller.signal.aborted) {
      onAbort();
      return;
    }
    controller.signal.addEventListener("abort", onAbort, { once: true });
    Promise.resolve(promise).then(
      (value) => {
        controller.signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (err) => {
        controller.signal.removeEventListener("abort", onAbort);
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

  const finish = ({
    ok,
    result = null,
    error = null,
    version = null,
    fetched = [],
    timedOut = false,
  }) => {
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
        timedOut,
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

  // Reject anything that isn't a single, plain path segment BEFORE it is
  // ever joined onto a filesystem path — a name like "../outside" (or an
  // absolute path, or one embedding a separator) never reaches path.join,
  // let alone existsSync/import, on this branch. This is the exact grammar
  // manifest.mjs enforces on manifest.name, reused rather than duplicated so
  // the two can't drift apart.
  if (!NAME_RE.test(pluginName)) {
    return finish({
      ok: false,
      error: codedError(`"${pluginName}" is not a valid plugin name`, "invalid_plugin_name"),
    });
  }

  const pluginsRoot = join(root, "plugins");
  const pluginDir = join(pluginsRoot, pluginName);
  const manifestPath = join(pluginDir, "manifest.json");
  if (!existsSync(manifestPath)) {
    return finish({ ok: false, error: plainError(`no plugin named "${pluginName}"`) });
  }

  // Bundled plugins are reviewed code, but the directory entry itself (or its
  // manifest) could still be a symlink pointing outside plugins/ — e.g. a
  // packaging mistake or a future non-bundled plugin source. realpath every
  // load-bearing path against the plugins root's own realpath before reading
  // or importing anything through it.
  let pluginsRootReal;
  try {
    pluginsRootReal = realpathSync(pluginsRoot);
  } catch (err) {
    return finish({
      ok: false,
      error: codedError(
        `could not resolve plugins directory: ${err.message}`,
        "plugin_path_escape"
      ),
    });
  }
  const dirEscape = containmentError(pluginDir, pluginsRootReal, "plugin directory");
  if (dirEscape) return finish({ ok: false, error: dirEscape });
  const manifestEscape = containmentError(manifestPath, pluginsRootReal, "plugin manifest");
  if (manifestEscape) return finish({ ok: false, error: manifestEscape });

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

  // The manifest is the plugin's own declared identity; it must agree with
  // the directory it was loaded from, or a plugin could be run under one
  // name's consent/audit trail while actually being another plugin's code
  // (e.g. a directory rename, or two manifests aliased onto each other).
  if (manifest.name !== pluginName) {
    return finish({
      ok: false,
      error: codedError(
        `plugin manifest name "${manifest.name}" does not match directory "${pluginName}"`,
        "plugin_name_mismatch"
      ),
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

  const entryPath = join(pluginDir, manifest.entry);
  if (existsSync(entryPath)) {
    const entryEscape = containmentError(entryPath, pluginsRootReal, "plugin entry");
    if (entryEscape) return finish({ ok: false, version: manifest.version, error: entryEscape });
  }

  const fetched = [];
  // controller.signal is the one deadline for everything after this point
  // (dynamic import AND run(ctx)) — see withDeadline's doc comment for why a
  // single shared controller matters. It is also handed to the plugin itself
  // as ctx.signal, and forwarded by ctx.fetch into fetchPublicHttpText, so a
  // plugin's own outbound fetch is bound by the same deadline as the plugin
  // run overall.
  //
  // A plugin whose run(ctx) never awaits anything (a synchronous busy loop)
  // cannot be interrupted by this, or by anything else running in-process —
  // only a separate worker/thread with its own event loop could preempt
  // that. Bundled plugins ship with the repo and go through review like any
  // other source file, so this slice accepts that gap deliberately rather
  // than paying for worker isolation the threat model doesn't call for yet.
  const controller = new AbortController();
  const timeoutError = new Error(`plugin "${pluginName}" timed out after ${timeoutMs}ms`);
  const timer = setTimeout(() => controller.abort(timeoutError), timeoutMs);

  const baseCtx = buildPluginContext({
    manifest,
    role,
    company,
    jd,
    targeting,
    signal: controller.signal,
  });
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

  // The dynamic import and the plugin's run(ctx) call are one continuous
  // async operation for deadline purposes: an entry module with a hanging
  // top-level await never even finishes importing, so the timer has to be
  // live before import() is called, not started only once run(ctx) exists.
  const execution = (async () => {
    let entryModule;
    try {
      entryModule = await import(pathToFileURL(entryPath).href);
    } catch (err) {
      throw new Error(`failed to load plugin entry: ${err.message}`);
    }
    const run = entryModule?.default;
    if (typeof run !== "function") {
      throw new Error("plugin entry has no default export function");
    }
    return run(ctx);
  })();

  try {
    const result = await withDeadline(execution, controller, timeoutError);
    clearTimeout(timer);
    return finish({ ok: true, result, version: manifest.version, fetched });
  } catch (err) {
    clearTimeout(timer);
    const timedOut = err === timeoutError;
    return finish({
      ok: false,
      version: manifest.version,
      error: plainError(timedOut ? timeoutError.message : err?.message || String(err)),
      fetched,
      timedOut,
    });
  }
}
