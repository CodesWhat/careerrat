import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { npmCommand } from "../scripts/lib/npm-invocation.mjs";
import { checkInstalledOutput, packedFilename } from "../scripts/smoke-packed-install.mjs";

test("packedFilename reads both npm 11 (array) and npm 12 (object) pack output", () => {
  assert.equal(packedFilename('[{"filename":"careerrat-1.0.0.tgz"}]'), "careerrat-1.0.0.tgz");
  assert.equal(
    packedFilename('{"careerrat":{"filename":"careerrat-1.0.0.tgz"}}'),
    "careerrat-1.0.0.tgz"
  );
  assert.throws(() => packedFilename("[{}]"), /tarball filename/);
});

test("checkInstalledOutput flags a wrong version or a missing usage banner", () => {
  const ok = {
    version: "1.0.0\n",
    expectedVersion: "1.0.0",
    help: "careerrat\n\nUsage: careerrat <command>",
  };
  assert.deepEqual(checkInstalledOutput(ok), []);
  assert.equal(checkInstalledOutput({ ...ok, version: "0.9.0" }).length, 1);
  assert.equal(checkInstalledOutput({ ...ok, help: "boom" }).length, 1);
});

test("npmCommand starts npm through a shell on Windows, since npm.cmd cannot be exec'd directly", () => {
  assert.deepEqual(npmCommand(["pack"], { env: {}, platform: "win32" }), {
    file: "npm.cmd",
    args: ["pack"],
    shell: true,
  });
});

test("npmCommand runs plain npm without a shell elsewhere", () => {
  assert.deepEqual(npmCommand(["pack"], { env: {}, platform: "linux" }), {
    file: "npm",
    args: ["pack"],
    shell: false,
  });
});

test("npmCommand prefers the Node-driven npm CLI when npm_execpath is set", () => {
  const command = npmCommand(["ci"], {
    env: { npm_execpath: "/usr/lib/npm-cli.js" },
    execPath: "/usr/bin/node",
    platform: "win32",
  });
  assert.deepEqual(command, {
    file: "/usr/bin/node",
    args: ["/usr/lib/npm-cli.js", "ci"],
    shell: false,
  });
});

test("publish.yml smokes the packed install after the install and before npm publish", async () => {
  const workflow = await readFile(
    new URL("../.github/workflows/publish.yml", import.meta.url),
    "utf8"
  );
  const installAt = workflow.indexOf("run: corepack npm ci");
  const smokeAt = workflow.indexOf("node scripts/smoke-packed-install.mjs");
  const publishAt = workflow.indexOf("corepack npm publish --provenance");
  assert.equal(workflow.includes("app:build"), false, "the web build is retired");
  assert.ok(installAt !== -1 && installAt < smokeAt, "the smoke must run after npm ci");
  assert.ok(smokeAt < publishAt, "the smoke must run before npm publish");
});

test("npmCommand on Windows without npm_execpath drives npm-cli.js next to node, never cmd.exe", () => {
  const execPath = "C:\\Program Files\\nodejs\\node.exe";
  const cli = "C:\\Program Files\\nodejs\\node_modules\\npm\\bin\\npm-cli.js";
  const command = npmCommand(["install", "C:\\Users\\a b\\Temp\\x y.tgz"], {
    env: {},
    execPath,
    platform: "win32",
    exists: (p) => p === cli,
  });
  assert.deepEqual(command, {
    file: execPath,
    args: [cli, "install", "C:\\Users\\a b\\Temp\\x y.tgz"],
    shell: false,
  });
});

test("npmCommand quotes cmd.exe arguments when it must fall back to npm.cmd", () => {
  const command = npmCommand(["install", "--prefix", "C:\\Users\\a b\\Temp dir", 'say "hi"'], {
    env: {},
    execPath: "C:\\node\\node.exe",
    platform: "win32",
    exists: () => false,
  });
  assert.equal(command.file, "npm.cmd");
  assert.equal(command.shell, true);
  assert.deepEqual(command.args, [
    "install",
    "--prefix",
    '"C:\\Users\\a b\\Temp dir"',
    '"say ""hi"""',
  ]);
});
