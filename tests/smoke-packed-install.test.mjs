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

test("npmCommand on Windows without npm_execpath throws instead of guessing an npm", () => {
  assert.throws(
    () => npmCommand(["pack"], { env: {}, platform: "win32", execPath: "C:\\node\\node.exe" }),
    /npm_execpath.*npm run/s
  );
});

test("npmCommand runs plain npm without a shell elsewhere", () => {
  assert.deepEqual(npmCommand(["pack"], { env: {}, platform: "linux" }), {
    file: "npm",
    args: ["pack"],
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
  });
});

test("publish.yml smokes the packed install after the install and before npm publish", async () => {
  const workflow = await readFile(
    new URL("../.github/workflows/publish.yml", import.meta.url),
    "utf8"
  );
  const installAt = workflow.indexOf("run: corepack npm ci");
  const smokeAt = workflow.indexOf("corepack npm run smoke:packed-install");
  const publishAt = workflow.indexOf("corepack npm publish --provenance");
  assert.equal(workflow.includes("app:build"), false, "the web build is retired");
  assert.ok(installAt !== -1 && installAt < smokeAt, "the smoke must run after npm ci");
  assert.ok(smokeAt < publishAt, "the smoke must run before npm publish");
});

test("npmCommand prefers npm_execpath over any npm beside node.exe on Windows", () => {
  const command = npmCommand(["install", "C:\\Users\\a b\\x y.tgz"], {
    env: { npm_execpath: "C:\\corepack\\npm-cli.js" },
    execPath: "C:\\Program Files\\nodejs\\node.exe",
    platform: "win32",
  });
  assert.deepEqual(command, {
    file: "C:\\Program Files\\nodejs\\node.exe",
    args: ["C:\\corepack\\npm-cli.js", "install", "C:\\Users\\a b\\x y.tgz"],
  });
});

test("every workflow runs the packed smoke through npm so npm_execpath is set", async () => {
  for (const name of ["ci-verify.yml", "publish.yml"]) {
    const workflow = await readFile(
      new URL(`../.github/workflows/${name}`, import.meta.url),
      "utf8"
    );
    assert.doesNotMatch(workflow, /node scripts\/smoke-packed-install\.mjs/, name);
    assert.match(workflow, /npm run smoke:packed-install/, name);
  }
});
