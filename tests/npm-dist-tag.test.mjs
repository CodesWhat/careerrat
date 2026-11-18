import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { compareSemver, npmDistTag } from "../scripts/release/npm-dist-tag.mjs";

test("a higher stable version takes latest", () => {
  assert.equal(npmDistTag("0.24.4", "0.24.3"), "latest");
  assert.equal(npmDistTag("1.0.0", "0.99.99"), "latest");
});

test("an equal version keeps latest", () => {
  assert.equal(npmDistTag("0.24.4", "0.24.4"), "latest");
});

test("a lower stable version publishes to backport, not latest", () => {
  assert.equal(npmDistTag("0.24.3", "0.24.4"), "backport");
  assert.equal(npmDistTag("0.9.0", "0.10.0"), "backport");
});

test("no current latest means latest", () => {
  assert.equal(npmDistTag("0.24.4", ""), "latest");
  assert.equal(npmDistTag("0.24.4", undefined), "latest");
});

test("prereleases keep the rc tag regardless of latest", () => {
  assert.equal(npmDistTag("0.25.0-rc.1", "0.24.4"), "rc");
  assert.equal(npmDistTag("0.1.0-rc.1", "0.24.4"), "rc");
});

test("semver precedence handles prerelease ordering", () => {
  assert.equal(compareSemver("1.0.0-rc.1", "1.0.0"), -1);
  assert.equal(compareSemver("1.0.0-rc.2", "1.0.0-rc.10"), -1);
  assert.equal(compareSemver("1.0.0-alpha", "1.0.0-alpha.1"), -1);
  assert.equal(compareSemver("1.0.0+build", "1.0.0"), 0);
});

test("invalid versions are rejected", () => {
  assert.throws(() => npmDistTag("nope", "0.1.0"));
  assert.throws(() => npmDistTag("0.2.0", "garbage"));
});

test("the CLI prints the tag", () => {
  const run = (...args) =>
    spawnSync(process.execPath, ["scripts/release/npm-dist-tag.mjs", ...args], {
      encoding: "utf8",
    });
  assert.equal(run("0.24.3", "0.24.4").stdout, "backport\n");
  assert.equal(run("0.24.5", "0.24.4").stdout, "latest\n");
  assert.notEqual(run("bad", "0.1.0").status, 0);
});
