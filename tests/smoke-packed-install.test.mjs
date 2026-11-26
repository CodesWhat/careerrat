import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
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

test("publish.yml smokes the packed install after the build and before npm publish", async () => {
  const workflow = await readFile(
    new URL("../.github/workflows/publish.yml", import.meta.url),
    "utf8"
  );
  const buildAt = workflow.indexOf("corepack npm run app:build");
  const smokeAt = workflow.indexOf("node scripts/smoke-packed-install.mjs");
  const publishAt = workflow.indexOf("corepack npm publish --provenance");
  assert.ok(buildAt !== -1 && buildAt < smokeAt, "the smoke must run after the web build");
  assert.ok(smokeAt < publishAt, "the smoke must run before npm publish");
});
