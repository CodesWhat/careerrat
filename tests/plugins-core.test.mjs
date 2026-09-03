// tests/plugins-core.test.mjs
// node:test suite for the bundled-plugin core (src/core/plugins/*.mjs).
//
// Plugins here are code we ship at plugins/<name>/ — never user-added, never
// remote. The core's job is the bounded contract around that: what a plugin
// may read, what it may fetch, what gets recorded, and the point-of-need
// consent gate for a plugin that declares a capability. These tests pin that
// contract plus the failure modes (bad manifest, disallowed host, timeout,
// throw, consent refused) that must never escape as an unhandled rejection.

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";

import { defaultAutomation } from "../src/core/automation/consent.mjs";
import { closeAll, openDb } from "../src/core/db/connection.mjs";
import { exportToTracker } from "../src/core/db/export-to-tracker.mjs";
import {
  buildPluginContext,
  listBundledPlugins,
  pluginAllowed,
  recordPluginRun,
  runPlugin,
  validateManifest,
  verifyBundledPlugins,
} from "../src/core/plugins/index.mjs";
import { readActivity } from "../src/core/tracker/activity-log.mjs";

after(() => {
  closeAll();
});

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));

function tempRoot() {
  return mkdtempSync(join(tmpdir(), "careerrat-plugins-"));
}

// Scaffolds plugins/<name>/manifest.json (+ entry file) under a temp root, so
// runner.mjs can load it exactly like a real bundled plugin.
function writePlugin(root, name, { manifest, entrySource, entryFile = "index.mjs" }) {
  const dir = join(root, "plugins", name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "manifest.json"), JSON.stringify(manifest, null, 2));
  writeFileSync(join(dir, entryFile), entrySource);
}

function goodManifest(overrides = {}) {
  return {
    name: "example-echo",
    version: "0.1.0",
    description: "Echoes back the reads it received.",
    capability: null,
    reads: ["role", "company"],
    fetchHosts: [],
    entry: "index.mjs",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// manifest.mjs — validateManifest
// ---------------------------------------------------------------------------

test("validateManifest accepts a well-formed manifest", () => {
  const result = validateManifest(goodManifest());
  assert.equal(result.ok, true);
  assert.deepEqual(result.errors, []);
  assert.equal(result.manifest.name, "example-echo");
  assert.equal(result.manifest.capability, null);
  assert.deepEqual(result.manifest.reads, ["role", "company"]);
});

test("validateManifest never throws and reports missing fields", () => {
  assert.doesNotThrow(() => validateManifest(undefined));
  assert.doesNotThrow(() => validateManifest(null));
  assert.doesNotThrow(() => validateManifest("not an object"));
  assert.doesNotThrow(() => validateManifest([]));

  const result = validateManifest({});
  assert.equal(result.ok, false);
  assert.equal(result.manifest, null);
  assert.ok(result.errors.length >= 5);
});

test("validateManifest rejects an unknown reads entry (closed enum)", () => {
  const result = validateManifest(goodManifest({ reads: ["role", "profile"] }));
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.includes("profile")));
});

test("validateManifest rejects a non-kebab-case name", () => {
  for (const badName of ["Example_Echo", "example echo", "EXAMPLE-ECHO", "", "-leading-dash"]) {
    const result = validateManifest(goodManifest({ name: badName }));
    assert.equal(result.ok, false, `expected "${badName}" to be rejected`);
  }
});

test("validateManifest rejects a non-semver version", () => {
  const result = validateManifest(goodManifest({ version: "v1" }));
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.includes("version")));
});

test("validateManifest rejects an entry path that escapes the plugin directory", () => {
  const result = validateManifest(goodManifest({ entry: "../../etc/passwd" }));
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.includes("entry")));
});

// ---------------------------------------------------------------------------
// ctx.mjs — buildPluginContext
// ---------------------------------------------------------------------------

test("buildPluginContext exposes only the reads the manifest declared", () => {
  const { manifest } = validateManifest(goodManifest({ reads: ["role", "jd"] }));
  const ctx = buildPluginContext({
    manifest,
    role: { title: "Staff Engineer" },
    company: { name: "Acme" },
    jd: "job description text",
    targeting: { level: "staff" },
  });

  assert.deepEqual(ctx.role, { title: "Staff Engineer" });
  assert.equal(ctx.jd, "job description text");
  assert.ok(!("company" in ctx));
  assert.ok(!("targeting" in ctx));
  assert.ok(!("profile" in ctx));
  assert.equal(typeof ctx.fetch, "function");
});

test("buildPluginContext never exposes a profile key even if the manifest lies", () => {
  const { manifest } = validateManifest(
    goodManifest({ reads: ["role", "company", "jd", "targeting"] })
  );
  const ctx = buildPluginContext({
    manifest,
    role: "r",
    company: "c",
    jd: "j",
    targeting: "t",
  });
  assert.ok(!("profile" in ctx));
  assert.ok(!("evidence" in ctx));
  assert.ok(!("honesty" in ctx));
  assert.ok(!("comp" in ctx));
});

test("buildPluginContext returns a frozen object", () => {
  const { manifest } = validateManifest(goodManifest());
  const ctx = buildPluginContext({ manifest, role: "r", company: "c" });
  assert.ok(Object.isFrozen(ctx));
  assert.throws(() => {
    ctx.role = "tampered";
  }, TypeError);
});

test("ctx.fetch rejects a host not in fetchHosts before touching the network", async () => {
  const { manifest } = validateManifest(goodManifest({ fetchHosts: ["allowed.example"] }));
  const ctx = buildPluginContext({ manifest });
  const result = await ctx.fetch("https://not-allowed.example/path");
  assert.equal(result.ok, false);
  assert.equal(result.code, "host_not_allowed");
});

test("ctx.fetch rejects an unparseable URL without throwing", async () => {
  const { manifest } = validateManifest(goodManifest({ fetchHosts: ["allowed.example"] }));
  const ctx = buildPluginContext({ manifest });
  const result = await ctx.fetch("not a url");
  assert.equal(result.ok, false);
  assert.equal(result.code, "invalid_url");
});

// ---------------------------------------------------------------------------
// consent.mjs — pluginAllowed
// ---------------------------------------------------------------------------

test("pluginAllowed allows a plugin with no declared capability", () => {
  const verdict = pluginAllowed({ manifest: { capability: null } });
  assert.equal(verdict.allowed, true);
});

test("pluginAllowed resolves a declared capability through mayRun (stub capability)", () => {
  // status_polling is an existing capability/platform pair in
  // ../automation/consent.mjs — used here purely as a stub to exercise the
  // point-of-need consent path without introducing a new capability name.
  const manifest = { capability: "status_polling" };

  const off = defaultAutomation();
  assert.equal(pluginAllowed({ manifest, cfg: off }).allowed, false);

  const on = defaultAutomation();
  on.setup_mode = "advanced";
  on.capabilities.status_polling.enabled = true;
  on.capabilities.status_polling.platforms.greenhouse = true;
  on.consent.greenhouse = true;
  assert.equal(pluginAllowed({ manifest, cfg: on }).allowed, true);
});

test("pluginAllowed refuses an unknown capability with a plain reason", () => {
  const verdict = pluginAllowed({
    manifest: { capability: "not_a_real_capability" },
    cfg: defaultAutomation(),
  });
  assert.equal(verdict.allowed, false);
  assert.ok(verdict.reason.includes("not_a_real_capability"));
});

// ---------------------------------------------------------------------------
// audit.mjs — recordPluginRun
// ---------------------------------------------------------------------------

test("recordPluginRun appends an activity row with the expected shape", () => {
  const root = tempRoot();
  try {
    const startedAt = "2026-09-01T00:00:00.000Z";
    const finishedAt = "2026-09-01T00:00:02.000Z";
    const appendResult = recordPluginRun({
      plugin: "example-echo",
      version: "0.1.0",
      roleId: "role_123",
      startedAt,
      finishedAt,
      ok: true,
      error: null,
      fetched: ["allowed.example"],
      root,
    });
    assert.equal(appendResult.ok, true);

    const events = readActivity({ root });
    assert.equal(events.length, 1);
    const event = events[0];
    assert.equal(event.type, "system");
    assert.equal(event.actor, "agent");
    assert.equal(event.skill, "plugin:example-echo");
    assert.equal(event.operation, "plugin:run");
    assert.equal(event.refs.applicationId, "role_123");
    assert.equal(event.tone, "info");
    assert.equal(event.detail.version, "0.1.0");
    assert.equal(event.detail.durationMs, 2000);
    assert.deepEqual(event.detail.fetched, ["allowed.example"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("recordPluginRun records a failed run with a warning tone and error text", () => {
  const root = tempRoot();
  try {
    recordPluginRun({
      plugin: "example-echo",
      version: "0.1.0",
      roleId: null,
      startedAt: "2026-09-01T00:00:00.000Z",
      finishedAt: "2026-09-01T00:00:01.000Z",
      ok: false,
      error: { message: "plugin exploded" },
      fetched: [],
      root,
    });
    const [event] = readActivity({ root });
    assert.equal(event.tone, "warning");
    assert.equal(event.summary, "plugin exploded");
    assert.equal(event.detail.error, "plugin exploded");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// Regression: a DB-backed workspace treats activity_events as canonical, and
// exportToTracker fully regenerates workspace/activity.jsonl from that table.
// Before the fix, recordPluginRun always wrote straight to the legacy JSONL
// via appendActivity, so a plugin run in a DB workspace would appear once
// but vanish the next time anything triggered an export (since the DB table
// never had the row to export). This pins that the row is now canonical DB
// data: it survives an explicit, independent exportToTracker call.
test("recordPluginRun writes through the canonical DB verb in a DB-backed workspace and survives export", () => {
  const root = tempRoot();
  try {
    openDb({ repoRoot: root, env: {} });

    const appendResult = recordPluginRun({
      plugin: "example-echo",
      version: "0.1.0",
      roleId: null,
      startedAt: "2026-09-01T00:00:00.000Z",
      finishedAt: "2026-09-01T00:00:01.000Z",
      ok: true,
      error: null,
      fetched: [],
      root,
      env: {},
    });
    assert.equal(appendResult.ok, true);

    // A second, independent export cycle — exactly what a legacy-only write
    // would not survive, since exportToTracker rebuilds activity.jsonl from
    // activity_events alone.
    exportToTracker({ repoRoot: root, env: {} });

    const events = readActivity({ root });
    assert.equal(events.length, 1);
    assert.equal(events[0].skill, "plugin:example-echo");
    assert.equal(events[0].operation, "plugin:run");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// runner.mjs — runPlugin
// ---------------------------------------------------------------------------

test("runPlugin runs a well-behaved plugin and records the audit row", async () => {
  const root = tempRoot();
  try {
    writePlugin(root, "ok-plugin", {
      manifest: goodManifest({ name: "ok-plugin", reads: ["role"] }),
      entrySource: `export default function run(ctx) { return { sawRole: ctx.role }; }\n`,
    });

    const outcome = await runPlugin("ok-plugin", { role: { title: "Engineer" }, root });
    assert.equal(outcome.ok, true);
    assert.deepEqual(outcome.result, { sawRole: { title: "Engineer" } });
    assert.equal(outcome.audit.ok, true);
    assert.equal(outcome.audit.event.skill, "plugin:ok-plugin");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("runPlugin reports a missing plugin without throwing", async () => {
  const root = tempRoot();
  try {
    const outcome = await runPlugin("does-not-exist", { root });
    assert.equal(outcome.ok, false);
    assert.ok(outcome.error.message.includes("does-not-exist"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("runPlugin reports an invalid manifest without throwing", async () => {
  const root = tempRoot();
  try {
    writePlugin(root, "bad-manifest", {
      manifest: { name: "bad manifest" },
      entrySource: `export default function run() { return {}; }\n`,
    });
    const outcome = await runPlugin("bad-manifest", { root });
    assert.equal(outcome.ok, false);
    assert.ok(outcome.error.message.includes("invalid plugin manifest"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("runPlugin catches a throwing plugin and never rejects", async () => {
  const root = tempRoot();
  try {
    writePlugin(root, "throwing-plugin", {
      manifest: goodManifest({ name: "throwing-plugin" }),
      entrySource: `export default function run() { throw new Error("boom"); }\n`,
    });
    const outcome = await runPlugin("throwing-plugin", { root });
    assert.equal(outcome.ok, false);
    assert.match(outcome.error.message, /boom/);
    assert.equal(outcome.audit.ok, true);
    assert.equal(outcome.audit.event.tone, "warning");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("runPlugin catches a rejecting async plugin and never rejects", async () => {
  const root = tempRoot();
  try {
    writePlugin(root, "rejecting-plugin", {
      manifest: goodManifest({ name: "rejecting-plugin" }),
      entrySource: `export default async function run() { throw new Error("async boom"); }\n`,
    });
    const outcome = await runPlugin("rejecting-plugin", { root });
    assert.equal(outcome.ok, false);
    assert.match(outcome.error.message, /async boom/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("runPlugin times out a hanging plugin instead of hanging the caller", async () => {
  const root = tempRoot();
  try {
    writePlugin(root, "hanging-plugin", {
      manifest: goodManifest({ name: "hanging-plugin" }),
      entrySource: `export default function run() { return new Promise(() => {}); }\n`,
    });
    const outcome = await runPlugin("hanging-plugin", { root, timeoutMs: 25 });
    assert.equal(outcome.ok, false);
    assert.match(outcome.error.message, /timed out/);
    assert.equal(outcome.audit.ok, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("runPlugin refuses a plugin whose capability consent is not granted", async () => {
  const root = tempRoot();
  try {
    writePlugin(root, "gated-plugin", {
      manifest: goodManifest({ name: "gated-plugin", capability: "status_polling" }),
      entrySource: `export default function run() { throw new Error("should never run"); }\n`,
    });
    const outcome = await runPlugin("gated-plugin", { root, cfg: defaultAutomation() });
    assert.equal(outcome.ok, false);
    assert.ok(outcome.error.message.toLowerCase().includes("not allowed"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("runPlugin runs a gated plugin once consent is granted", async () => {
  const root = tempRoot();
  try {
    writePlugin(root, "gated-plugin-2", {
      manifest: goodManifest({ name: "gated-plugin-2", capability: "status_polling" }),
      entrySource: `export default function run() { return { ran: true }; }\n`,
    });
    const cfg = defaultAutomation();
    cfg.setup_mode = "advanced";
    cfg.capabilities.status_polling.enabled = true;
    cfg.capabilities.status_polling.platforms.greenhouse = true;
    cfg.consent.greenhouse = true;

    const outcome = await runPlugin("gated-plugin-2", { root, cfg });
    assert.equal(outcome.ok, true);
    assert.deepEqual(outcome.result, { ran: true });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("runPlugin rejects a plugin fetch to a host outside fetchHosts", async () => {
  const root = tempRoot();
  try {
    writePlugin(root, "fetching-plugin", {
      manifest: goodManifest({ name: "fetching-plugin", fetchHosts: ["allowed.example"] }),
      entrySource: `export default async function run(ctx) { return ctx.fetch("https://evil.example/path"); }\n`,
    });
    const outcome = await runPlugin("fetching-plugin", { root });
    assert.equal(outcome.ok, true);
    assert.equal(outcome.result.ok, false);
    assert.equal(outcome.result.code, "host_not_allowed");
    assert.deepEqual(outcome.audit.event.detail.fetched, []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// runner.mjs — path traversal / symlink escape / name-mismatch regressions
// ---------------------------------------------------------------------------

test("runPlugin rejects a path-traversal plugin name without importing anything", async () => {
  const root = tempRoot();
  try {
    // A real target at root/outside/index.mjs that would prove it was
    // imported by throwing a distinctive error — must never be reached if
    // name validation rejects "../outside" before any path.join/import.
    const outsideDir = join(root, "outside");
    mkdirSync(outsideDir, { recursive: true });
    writeFileSync(
      join(outsideDir, "manifest.json"),
      JSON.stringify(goodManifest({ name: "outside" }), null, 2)
    );
    writeFileSync(
      join(outsideDir, "index.mjs"),
      `throw new Error("SENTINEL: outside plugin was imported");\n`
    );

    const outcome = await runPlugin("../outside", { root });
    assert.equal(outcome.ok, false);
    assert.equal(outcome.error.code, "invalid_plugin_name");
    assert.ok(!String(outcome.error.message).includes("SENTINEL"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("runPlugin rejects a plugin directory that is a symlink escaping the plugins root", async () => {
  const root = tempRoot();
  const outsideRoot = tempRoot();
  try {
    const realOutsideDir = join(outsideRoot, "real-plugin");
    mkdirSync(realOutsideDir, { recursive: true });
    writeFileSync(
      join(realOutsideDir, "manifest.json"),
      JSON.stringify(goodManifest({ name: "escaped-plugin" }), null, 2)
    );
    writeFileSync(
      join(realOutsideDir, "index.mjs"),
      `throw new Error("SENTINEL: escaped plugin was imported");\n`
    );

    mkdirSync(join(root, "plugins"), { recursive: true });
    symlinkSync(realOutsideDir, join(root, "plugins", "escaped-plugin"), "dir");

    const outcome = await runPlugin("escaped-plugin", { root });
    assert.equal(outcome.ok, false);
    assert.equal(outcome.error.code, "plugin_path_escape");
    assert.ok(!String(outcome.error.message).includes("SENTINEL"));
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(outsideRoot, { recursive: true, force: true });
  }
});

test("runPlugin rejects a plugin whose manifest name differs from its directory", async () => {
  const root = tempRoot();
  try {
    writePlugin(root, "dir-name", {
      manifest: goodManifest({ name: "other-name" }),
      entrySource: `export default function run() { throw new Error("should never run"); }\n`,
    });
    const outcome = await runPlugin("dir-name", { root });
    assert.equal(outcome.ok, false);
    assert.equal(outcome.error.code, "plugin_name_mismatch");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// runner.mjs — timeout coverage regressions
// ---------------------------------------------------------------------------

test("runPlugin times out an entry module with a hanging top-level await", async () => {
  const root = tempRoot();
  try {
    writePlugin(root, "hanging-import-plugin", {
      manifest: goodManifest({ name: "hanging-import-plugin" }),
      entrySource: `await new Promise(() => {});\nexport default function run() { return { ran: true }; }\n`,
    });
    const start = Date.now();
    const outcome = await runPlugin("hanging-import-plugin", { root, timeoutMs: 50 });
    assert.equal(outcome.ok, false);
    assert.match(outcome.error.message, /timed out/);
    assert.ok(Date.now() - start < 2000, "must not hang past the deadline");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("runPlugin's ctx.signal reflects the timeout, and a ctx.fetch call after abort rejects immediately", async () => {
  const root = tempRoot();
  try {
    writePlugin(root, "late-fetch-plugin", {
      manifest: goodManifest({ name: "late-fetch-plugin", fetchHosts: ["allowed.example"] }),
      entrySource: `
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
const resultPath = fileURLToPath(new URL("./result.json", import.meta.url));
export default function run(ctx) {
  return new Promise(() => {
    setTimeout(() => {
      const abortedAfterTimeout = Boolean(ctx.signal && ctx.signal.aborted);
      ctx.fetch("https://allowed.example/x").then((fetchResult) => {
        writeFileSync(resultPath, JSON.stringify({ abortedAfterTimeout, fetchResult }));
      });
    }, 100);
  });
}
`,
    });

    const outcome = await runPlugin("late-fetch-plugin", { root, timeoutMs: 40 });
    assert.equal(outcome.ok, false);
    assert.match(outcome.error.message, /timed out/);

    // The plugin schedules its own check to fire AFTER the runner's
    // deadline, so give it time to run before reading what it observed.
    await new Promise((resolve) => setTimeout(resolve, 250));

    const resultPath = join(root, "plugins", "late-fetch-plugin", "result.json");
    const written = JSON.parse(readFileSync(resultPath, "utf8"));
    assert.equal(written.abortedAfterTimeout, true);
    assert.equal(written.fetchResult.ok, false);
    assert.equal(written.fetchResult.code, "fetch_aborted");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// index.mjs — listBundledPlugins
// ---------------------------------------------------------------------------

test("listBundledPlugins finds the real example-echo plugin", () => {
  const plugins = listBundledPlugins({ root: REPO_ROOT });
  const echo = plugins.find((p) => p.name === "example-echo");
  assert.ok(echo, "expected plugins/example-echo/manifest.json to be discovered");
  assert.equal(echo.entry, "index.mjs");
  assert.equal(echo.capability, null);
});

test("listBundledPlugins skips an unreadable manifest instead of throwing", () => {
  const root = tempRoot();
  try {
    const dir = join(root, "plugins", "broken");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "manifest.json"), "{not valid json");
    assert.doesNotThrow(() => listBundledPlugins({ root }));
    assert.deepEqual(listBundledPlugins({ root }), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("listBundledPlugins returns [] when there is no plugins directory", () => {
  const root = tempRoot();
  try {
    assert.deepEqual(listBundledPlugins({ root }), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// index.mjs — verifyBundledPlugins
// ---------------------------------------------------------------------------

test("verifyBundledPlugins reports a containment error when manifest.json is a symlink escaping the plugins root", () => {
  const root = tempRoot();
  const outsideRoot = tempRoot();
  try {
    const outsideManifest = join(outsideRoot, "manifest.json");
    writeFileSync(
      outsideManifest,
      JSON.stringify(goodManifest({ name: "escaped-manifest" }), null, 2)
    );

    const dir = join(root, "plugins", "escaped-manifest");
    mkdirSync(dir, { recursive: true });
    symlinkSync(outsideManifest, join(dir, "manifest.json"));
    writeFileSync(join(dir, "index.mjs"), `export default function run() { return {}; }\n`);

    const verification = verifyBundledPlugins({ root });
    assert.equal(verification.ok, false);
    const result = verification.plugins.find((p) => p.name === "escaped-manifest");
    assert.ok(result, "expected escaped-manifest in verification results");
    assert.equal(result.ok, false);
    assert.ok(
      result.errors.some((e) => /plugin manifest resolves outside the plugins directory/.test(e)),
      `expected a manifest containment error, got: ${JSON.stringify(result.errors)}`
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(outsideRoot, { recursive: true, force: true });
  }
});

test("verifyBundledPlugins rejects a manifest whose entry resolves to a directory", () => {
  const root = tempRoot();
  try {
    writePlugin(root, "dir-entry-plugin", {
      manifest: goodManifest({ name: "dir-entry-plugin", entry: "." }),
      entrySource: `export default function run() { return {}; }\n`,
    });

    const verification = verifyBundledPlugins({ root });
    assert.equal(verification.ok, false);
    const result = verification.plugins.find((p) => p.name === "dir-entry-plugin");
    assert.ok(result, "expected dir-entry-plugin in verification results");
    assert.equal(result.ok, false);
    assert.ok(
      result.errors.some((e) => /entry is not a regular file/.test(e)),
      `expected an entry-not-a-file error, got: ${JSON.stringify(result.errors)}`
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// lint coverage — plugins/** must be reachable by both biome and knip
// ---------------------------------------------------------------------------
//
// Regression: plugins/** sat outside both tools' globs, so
// `npx biome check plugins/example-echo/index.mjs` checked zero files and
// `npx knip` never scanned it either — a bundled plugin's own code got no
// lint coverage at all. This pins that a plugins/-matching glob is present
// in each config, rather than re-running the CLIs (slow, and the exact
// output shape is the tools' to own).

test("biome.json includes a glob covering plugins/", () => {
  const biomeConfig = JSON.parse(readFileSync(join(REPO_ROOT, "biome.json"), "utf8"));
  const includes = biomeConfig?.files?.includes ?? [];
  assert.ok(
    includes.some((pattern) => typeof pattern === "string" && pattern.startsWith("plugins/")),
    `expected biome.json files.includes to cover plugins/, got: ${JSON.stringify(includes)}`
  );
});

test("knip.json covers plugins/ in the root workspace's entry or project globs", () => {
  const knipConfig = JSON.parse(readFileSync(join(REPO_ROOT, "knip.json"), "utf8"));
  const rootWorkspace = knipConfig?.workspaces?.["."] ?? {};
  const globs = [...(rootWorkspace.entry ?? []), ...(rootWorkspace.project ?? [])];
  assert.ok(
    globs.some((pattern) => typeof pattern === "string" && pattern.startsWith("plugins/")),
    `expected knip.json's "." workspace entry/project to cover plugins/, got: ${JSON.stringify(globs)}`
  );
});
