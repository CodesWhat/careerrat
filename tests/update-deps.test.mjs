// `careerrat update` must reconcile node_modules when a release changes the runtime
// dependency set, and must not report success when npm install or doctor fails.
// Runs the real bin/careerrat.mjs from a copied install layout with a fake `npm` on
// PATH (view/pack/install), so nothing touches the network or the real node_modules.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  RUNTIME_DEPS_INSTALL_ARGS,
  readRuntimeDeps,
  runtimeDepsChanged,
} from "../src/core/update/update-core.mjs";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));

const FAKE_NPM = `#!/usr/bin/env node
const { appendFileSync } = require("node:fs");
const { spawnSync } = require("node:child_process");
const [cmd, ...rest] = process.argv.slice(2);
if (cmd === "view") {
  console.log("9.9.9");
} else if (cmd === "pack") {
  const dest = rest[rest.indexOf("--pack-destination") + 1];
  const r = spawnSync("tar", ["czf", dest + "/careerrat-9.9.9.tgz", "-C", process.env.FAKE_NPM_PKG_ROOT, "package"]);
  process.exit(r.status ?? 1);
} else if (cmd === "install" || cmd === "rebuild") {
  appendFileSync(process.env.FAKE_NPM_LOG, JSON.stringify({ args: [cmd, ...rest], cwd: process.cwd(), ignoreScriptsEnv: process.env.npm_config_ignore_scripts }) + "\\n");
  if (cmd === "install") {
    require("node:fs").writeFileSync(process.cwd() + "/node_modules/.package-lock.json", process.env.FAKE_NPM_LOCK || "{\\"packages\\":{}}");
  }
  process.exit(Number(process.env[cmd === "install" ? "FAKE_NPM_INSTALL_EXIT" : "FAKE_NPM_REBUILD_EXIT"] || 0));
} else {
  process.exit(1);
}
`;

// Builds an install layout plus a fake "published" package root. `newDeps` is the
// runtime dependency set the published 9.9.9 package.json declares; `doctorExit` is
// what the published doctor script exits with.
function buildFixture({ newDeps, doctorExit = 0, allowScripts }) {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "careerrat-update-deps-")));
  const packageDir = join(base, "lib", "node_modules", "careerrat");
  mkdirSync(packageDir, { recursive: true });
  for (const entry of ["bin", "src", "config", "templates", "package.json", "AGENTS.md"]) {
    cpSync(join(REPO_ROOT, entry), join(packageDir, entry), { recursive: true });
  }
  // A real node_modules dir of per-entry symlinks, so the fake npm can write
  // .package-lock.json without touching the repo's own node_modules.
  const nm = join(packageDir, "node_modules");
  mkdirSync(nm);
  for (const name of readdirSync(join(REPO_ROOT, "node_modules"))) {
    if (name === ".package-lock.json") continue;
    symlinkSync(join(REPO_ROOT, "node_modules", name), join(nm, name));
  }
  const home = join(base, "home");
  mkdirSync(home, { recursive: true });

  const installed = JSON.parse(readFileSync(join(packageDir, "package.json"), "utf8"));
  const published = {
    ...installed,
    version: "9.9.9",
    dependencies: newDeps(installed.dependencies || {}),
    ...(allowScripts ? { allowScripts } : {}),
  };
  const pkgRoot = join(base, "published");
  mkdirSync(join(pkgRoot, "package", "src", "cli"), { recursive: true });
  writeFileSync(join(pkgRoot, "package", "package.json"), JSON.stringify(published));
  writeFileSync(
    join(pkgRoot, "package", "src", "cli", "doctor.mjs"),
    `process.exit(${doctorExit});\n`
  );

  const fakeBin = join(base, "fakebin");
  mkdirSync(fakeBin);
  writeFileSync(join(fakeBin, "npm"), FAKE_NPM);
  chmodSync(join(fakeBin, "npm"), 0o755);
  const log = join(base, "npm.log");
  return { base, packageDir, home, pkgRoot, fakeBin, log };
}

function runUpdate(fx, { installExit = 0, lock, extraEnv = {} } = {}) {
  const res = spawnSync(process.execPath, [join(fx.packageDir, "bin/careerrat.mjs"), "update"], {
    cwd: fx.packageDir,
    encoding: "utf8",
    env: {
      ...process.env,
      HOME: fx.home,
      PATH: `${fx.fakeBin}${delimiter}${process.env.PATH}`,
      FAKE_NPM_PKG_ROOT: fx.pkgRoot,
      FAKE_NPM_LOG: fx.log,
      FAKE_NPM_INSTALL_EXIT: String(installExit),
      ...(lock ? { FAKE_NPM_LOCK: JSON.stringify(lock) } : {}),
      ...extraEnv,
    },
  });
  const installs = existsSync(fx.log)
    ? readFileSync(fx.log, "utf8").trim().split("\n").filter(Boolean).map(JSON.parse)
    : [];
  return { res, installs };
}

test("update runs npm install --omit=dev in the install root when runtime deps change", () => {
  const fx = buildFixture({ newDeps: (d) => ({ ...d, "brand-new-dep": "^1.0.0" }) });
  try {
    const { res, installs } = runUpdate(fx);
    assert.equal(res.status, 0, res.stderr + res.stdout);
    assert.equal(installs.length, 1);
    assert.deepEqual(installs[0].args, RUNTIME_DEPS_INSTALL_ARGS);
    assert.ok(installs[0].args.includes("--ignore-scripts"));
    assert.equal(realpathSync(installs[0].cwd), fx.packageDir);
  } finally {
    rmSync(fx.base, { recursive: true, force: true });
  }
});

const lockOf = (pkgs) => ({
  packages: Object.fromEntries(
    Object.entries(pkgs).map(([name, version]) => [
      `node_modules/${name}`,
      { version, hasInstallScript: true },
    ])
  ),
});

test("update installs with --ignore-scripts (flag and env) and rebuilds only allowlisted packages", () => {
  const fx = buildFixture({
    newDeps: (d) => ({ ...d, "brand-new-dep": "^1.0.0" }),
    allowScripts: { "native-ok@1.2.3": true, "bare-ok": true, "denied-pkg": false },
  });
  try {
    const { res, installs } = runUpdate(fx, {
      lock: lockOf({ "native-ok": "1.2.3", "bare-ok": "4.0.0", "denied-pkg": "1.0.0" }),
      // a permissive environment must not re-enable scripts for the main install
      extraEnv: { npm_config_ignore_scripts: "false" },
    });
    assert.equal(res.status, 0, res.stderr + res.stdout);
    assert.equal(installs.length, 2);
    assert.equal(installs[0].args[0], "install");
    assert.ok(installs[0].args.includes("--ignore-scripts"));
    assert.equal(installs[0].ignoreScriptsEnv, "true");
    assert.deepEqual(installs[1].args, ["rebuild", "native-ok", "bare-ok"]);
  } finally {
    rmSync(fx.base, { recursive: true, force: true });
  }
});

test("update stops with the manual command when a package with an unreviewed install script appears", () => {
  const fx = buildFixture({
    newDeps: (d) => ({ ...d, "brand-new-dep": "^1.0.0" }),
    allowScripts: { "native-ok@1.2.3": true },
  });
  try {
    const { res, installs } = runUpdate(fx, {
      lock: lockOf({ "native-ok": "1.2.3", "sketchy-pkg": "2.0.0" }),
      extraEnv: {
        npm_config_ignore_scripts: "false",
        npm_config_dangerously_allow_all_scripts: "true",
      },
    });
    assert.equal(res.status, 1);
    assert.match(res.stderr, /sketchy-pkg@2\.0\.0/);
    assert.match(res.stderr, /allowScripts/);
    // Recovery covers the approved package AND the one the person still has to approve.
    assert.ok(
      res.stderr.includes(`cd "${fx.packageDir}/" && npm rebuild native-ok sketchy-pkg`),
      res.stderr
    );
    assert.match(res.stderr, /plain `careerrat update` won't redo it/);
    assert.equal(installs.filter((i) => i.args[0] === "rebuild").length, 0);
    assert.equal(installs[0].ignoreScriptsEnv, "true");
  } finally {
    rmSync(fx.base, { recursive: true, force: true });
  }
});

const bundledLock = {
  packages: {
    "node_modules/native-ok": { version: "1.2.3", hasInstallScript: true },
    "node_modules/native-ok/node_modules/evil-child": {
      version: "0.0.1",
      hasInstallScript: true,
      inBundle: true,
    },
  },
};

test("update stops with nothing rebuilt when a bundled child of an approved parent has an install script", () => {
  const fx = buildFixture({
    newDeps: (d) => ({ ...d, "brand-new-dep": "^1.0.0" }),
    allowScripts: { "native-ok@1.2.3": true },
  });
  try {
    const { res, installs } = runUpdate(fx, { lock: bundledLock });
    assert.equal(res.status, 1);
    assert.equal(installs.filter((i) => i.args[0] === "rebuild").length, 0);
    assert.match(res.stderr, /evil-child@0\.0\.1 \(bundled\)/);
    assert.match(res.stderr, /allowScripts/);
    assert.ok(
      res.stderr.includes(`cd "${fx.packageDir}/" && npm rebuild native-ok evil-child`),
      res.stderr
    );
  } finally {
    rmSync(fx.base, { recursive: true, force: true });
  }
});

test("update rebuilds exactly the approved set when bundled children are approved too", () => {
  const fx = buildFixture({
    newDeps: (d) => ({ ...d, "brand-new-dep": "^1.0.0" }),
    allowScripts: { "native-ok@1.2.3": true, "evil-child": true },
  });
  try {
    const { res, installs } = runUpdate(fx, { lock: bundledLock });
    assert.equal(res.status, 0, res.stderr + res.stdout);
    assert.deepEqual(installs[1].args, ["rebuild", "native-ok", "evil-child"]);
    assert.equal(installs.length, 2);
  } finally {
    rmSync(fx.base, { recursive: true, force: true });
  }
});

test("update skips npm install when runtime deps are unchanged", () => {
  const fx = buildFixture({ newDeps: (d) => d });
  try {
    const { res, installs } = runUpdate(fx);
    assert.equal(res.status, 0, res.stderr + res.stdout);
    assert.equal(installs.length, 0);
  } finally {
    rmSync(fx.base, { recursive: true, force: true });
  }
});

test("update returns non-zero and names the manual command when npm install fails", () => {
  const fx = buildFixture({ newDeps: (d) => ({ ...d, "brand-new-dep": "^1.0.0" }) });
  try {
    const { res } = runUpdate(fx, { installExit: 3 });
    assert.equal(res.status, 1);
    assert.match(res.stderr, /installing the new dependencies failed \(npm exited 3\)/);
    assert.ok(
      res.stderr.includes(`npm ${RUNTIME_DEPS_INSTALL_ARGS.join(" ")}`),
      `stderr should give the exact npm command: ${res.stderr}`
    );
    assert.ok(res.stderr.includes(fx.packageDir));
  } finally {
    rmSync(fx.base, { recursive: true, force: true });
  }
});

test("update returns non-zero when doctor fails after a successful extract", () => {
  const fx = buildFixture({ newDeps: (d) => d, doctorExit: 2 });
  try {
    const { res } = runUpdate(fx);
    assert.equal(res.status, 1);
    assert.match(res.stderr, /Updated, but doctor reported problems: run careerrat doctor/);
  } finally {
    rmSync(fx.base, { recursive: true, force: true });
  }
});

test("runtimeDepsChanged compares dependencies and optionalDependencies, ignores order", () => {
  const a = { dependencies: { x: "1", y: "2" }, optionalDependencies: {} };
  assert.equal(
    runtimeDepsChanged(a, { dependencies: { y: "2", x: "1" }, optionalDependencies: {} }),
    false
  );
  assert.equal(
    runtimeDepsChanged(a, { dependencies: { x: "1", y: "3" }, optionalDependencies: {} }),
    true
  );
  assert.equal(
    runtimeDepsChanged(a, { dependencies: a.dependencies, optionalDependencies: { z: "1" } }),
    true
  );
  assert.equal(runtimeDepsChanged(null, a), true);
  assert.equal(readRuntimeDeps(join(tmpdir(), "no-such-dir-careerrat")), null);
});
