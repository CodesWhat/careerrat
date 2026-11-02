import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";

const api = await import("../src/core/tui/python-runtime.mjs").catch((error) => {
  if (error.code !== "ERR_MODULE_NOT_FOUND") throw error;
  return {};
});
function fixture(t) {
  assert.equal(
    typeof api.ensureTextualPython,
    "function",
    "Textual needs a managed private runtime"
  );
  const home = mkdtempSync(join(tmpdir(), "careerrat-python-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  return {
    repoRoot: join(import.meta.dirname, ".."),
    env: { ...process.env, CAREERRAT_HOME: home },
    home,
  };
}

test("Textual setup installs hash-locked wheels privately and reuses the completed environment", async (t) => {
  const ctx = fixture(t);
  const calls = [];
  const run = async (command, args) => {
    calls.push({ command, args });
    if (args.includes("venv")) {
      const bin = join(args.at(-1), process.platform === "win32" ? "Scripts" : "bin");
      mkdirSync(bin, { recursive: true });
      writeFileSync(join(bin, process.platform === "win32" ? "python.exe" : "python"), "fixture");
    }
  };
  const python = await api.ensureTextualPython({ ...ctx, run });
  assert.ok(python.startsWith(join(ctx.home, "internal/tui")));
  const install = calls.find((call) => call.args.includes("install"));
  assert.ok(install.args.includes("--require-hashes"));
  assert.ok(install.args.includes("--only-binary=:all:"));
  assert.equal(install.command, python);
  assert.ok(existsSync(join(dirname(dirname(python)), ".ready.json")));
  const before = calls.length;
  assert.equal(await api.ensureTextualPython({ ...ctx, run }), python);
  assert.equal(calls.length, before, "cached launch must not contact pip");
  assert.equal(existsSync(join(ctx.home, "db")), false);
  assert.equal(existsSync(join(ctx.home, "workspace")), false);
  const lock = readFileSync(join(ctx.repoRoot, "src/core/tui/requirements.txt"), "utf8");
  assert.match(lock, /textual==8\.2\.8/);
  assert.match(lock, /--hash=sha256:/);
});

test("failed Textual installation leaves no ready marker and can retry", async (t) => {
  const ctx = fixture(t);
  let directory;
  const run = async (_command, args) => {
    if (args.includes("venv")) {
      directory = args.at(-1);
      mkdirSync(directory, { recursive: true });
    }
    if (args.includes("install")) throw new Error("Offline install failed");
  };
  await assert.rejects(api.ensureTextualPython({ ...ctx, run }), /Offline install failed/);
  assert.equal(existsSync(directory), false);
  const python = await api.ensureTextualPython({ ...ctx, run: async () => {} });
  assert.ok(python.startsWith(ctx.home));
});

test("Textual setup does not run two installers for the same environment", async (t) => {
  const ctx = fixture(t);
  let release;
  let entered;
  const ready = new Promise((resolve) => {
    entered = resolve;
  });
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const first = api.ensureTextualPython({
    ...ctx,
    run: async (_command, args) => {
      if (args.includes("venv")) {
        entered();
        await gate;
      }
    },
  });
  await ready;
  try {
    await assert.rejects(
      api.ensureTextualPython({ ...ctx, run: async () => {} }),
      /already running/
    );
  } finally {
    release();
    await first;
  }
});

test("Textual setup recovers a lock whose installer process no longer exists", async (t) => {
  const ctx = fixture(t);
  const base = join(ctx.home, "internal/tui");
  mkdirSync(base, { recursive: true });
  writeFileSync(join(base, "setup.lock"), "2147483647");
  await api.ensureTextualPython({ ...ctx, run: async () => {} });
  assert.equal(existsSync(join(base, "setup.lock")), false);
});

test("every interpreter we run is isolated, and Windows asks the py launcher for Python 3", async (t) => {
  const ctx = fixture(t);
  const calls = [];
  const run = async (command, args) => {
    calls.push({ command, args });
    if (args.includes("venv")) {
      const bin = join(args.at(-1), "Scripts");
      mkdirSync(bin, { recursive: true });
      writeFileSync(join(bin, "python.exe"), "fixture");
    }
  };
  const env = { ...ctx.env };
  delete env.CAREERRAT_TUI_PYTHON;
  await api.ensureTextualPython({ ...ctx, env, platform: "win32", run });
  assert.ok(calls.length >= 4);
  for (const call of calls)
    assert.ok(call.args.includes("-I"), `${call.args.join(" ")} is not isolated`);
  assert.equal(calls[0].command, "py");
  assert.deepEqual(calls[0].args.slice(0, 2), ["-3", "-I"]);
  const venv = calls.find((call) => call.args.includes("venv"));
  assert.deepEqual(venv.args.slice(0, 3), ["-3", "-I", "-m"]);
  // An explicit interpreter is used as given, with no launcher flag.
  const other = fixture(t);
  const pinned = [];
  await api.ensureTextualPython({
    ...other,
    env: { ...other.env, CAREERRAT_TUI_PYTHON: "/opt/python3.12" },
    platform: "linux",
    run: async (command, args) => {
      pinned.push({ command, args });
      if (args.includes("venv")) {
        const bin = join(args.at(-1), "bin");
        mkdirSync(bin, { recursive: true });
        writeFileSync(join(bin, "python"), "fixture");
      }
    },
  });
  assert.equal(pinned[0].command, "/opt/python3.12");
  assert.deepEqual(pinned[0].args.slice(0, 2), ["-I", "-c"]);
});

test("setup prunes old private environments but leaves recent and unrelated folders", async (t) => {
  const ctx = fixture(t);
  const base = join(ctx.home, "internal/tui");
  const old = join(base, "python-0123456789abcdef");
  const recent = join(base, "python-fedcba9876543210");
  const unrelated = join(base, "notes");
  for (const dir of [old, recent, unrelated]) mkdirSync(dir, { recursive: true });
  const longAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  utimesSync(old, longAgo, longAgo);
  const run = async (_command, args) => {
    if (args.includes("venv")) {
      mkdirSync(join(args.at(-1), "bin"), { recursive: true });
      writeFileSync(join(args.at(-1), "bin/python"), "fixture");
    }
  };
  const python = await api.ensureTextualPython({ ...ctx, run });
  assert.equal(existsSync(old), false);
  assert.equal(existsSync(recent), true);
  assert.equal(existsSync(unrelated), true);
  assert.ok(existsSync(python));
  assert.equal(api.textualLogPath(ctx), join(base, "tui.log"));
  // The cached launch prunes too.
  mkdirSync(old, { recursive: true });
  utimesSync(old, longAgo, longAgo);
  await api.ensureTextualPython({ ...ctx, run });
  assert.equal(existsSync(old), false);
});
