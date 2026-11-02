import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { test } from "node:test";
import { withCareerratShim } from "../src/core/tui/cli-shim.mjs";

function scratch(t) {
  const dir = mkdtempSync(join(tmpdir(), "careerrat shim "));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}
function fakeRepo(dir) {
  const repoRoot = join(dir, "my repo");
  mkdirSync(join(repoRoot, "bin"), { recursive: true });
  writeFileSync(
    join(repoRoot, "bin/careerrat.mjs"),
    "console.log('THIS-CHECKOUT ' + process.argv.slice(2).join(' '));\n"
  );
  return repoRoot;
}

test("the shim runs this checkout even when an older careerrat is earlier on PATH", (t) => {
  const dir = scratch(t);
  const repoRoot = fakeRepo(dir);
  const decoy = join(dir, "old bin");
  mkdirSync(decoy);
  writeFileSync(join(decoy, "careerrat"), "#!/bin/sh\necho OLD-INSTALL\n", { mode: 0o755 });
  const env = withCareerratShim({
    repoRoot,
    env: { PATH: `${decoy}${delimiter}${process.env.PATH}`, CAREERRAT_HOME: join(dir, "home") },
  });
  const out = execFileSync("sh", ["-c", 'careerrat --version "two words"'], {
    env,
    encoding: "utf8",
  });
  assert.equal(out.trim(), "THIS-CHECKOUT --version two words");
  assert.ok(env.PATH.startsWith(join(dir, "home")));
});

test("the shim is rewritten atomically, leaves no temp files and survives repeats", (t) => {
  const dir = scratch(t);
  const repoRoot = fakeRepo(dir);
  const base = { PATH: process.env.PATH, CAREERRAT_HOME: join(dir, "home") };
  const first = withCareerratShim({ repoRoot, env: base });
  const shimDir = first.PATH.split(delimiter)[0];
  writeFileSync(join(shimDir, "careerrat"), "stale");
  withCareerratShim({ repoRoot, env: base });
  assert.match(readFileSync(join(shimDir, "careerrat"), "utf8"), /^#!\/bin\/sh\nexec '/);
  assert.deepEqual(readdirSync(shimDir), ["careerrat"]);
});

test("a path with a single quote stays one argument", (t) => {
  const dir = scratch(t);
  const repoRoot = join(dir, "it's here");
  mkdirSync(join(repoRoot, "bin"), { recursive: true });
  writeFileSync(join(repoRoot, "bin/careerrat.mjs"), "console.log('QUOTED-OK');\n");
  const env = withCareerratShim({
    repoRoot,
    env: { PATH: process.env.PATH, CAREERRAT_HOME: join(dir, "home") },
  });
  assert.equal(
    execFileSync("sh", ["-c", "careerrat"], { env, encoding: "utf8" }).trim(),
    "QUOTED-OK"
  );
});

test("the Windows shim is a .cmd that quotes both paths and forwards arguments", (t) => {
  const dir = scratch(t);
  const repoRoot = fakeRepo(dir);
  const env = withCareerratShim({
    repoRoot,
    platform: "win32",
    node: "C:\\Program Files\\nodejs\\node.exe",
    env: { Path: "C:\\Windows", CAREERRAT_HOME: join(dir, "home") },
  });
  const shimDir = env.Path.split(delimiter)[0];
  const text = readFileSync(join(shimDir, "careerrat.cmd"), "utf8");
  assert.match(
    text,
    /^@echo off\r\n"C:\\Program Files\\nodejs\\node\.exe" ".*careerrat\.mjs" %\*\r\n$/
  );
  assert.ok(env.Path.endsWith("C:\\Windows"));
  assert.equal("PATH" in env, false);
});
