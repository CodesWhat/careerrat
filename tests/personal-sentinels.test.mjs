import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import { loadPersonalSentinels } from "../scripts/lib/personal-sentinels.mjs";

test("ordinary PRs and forks can run without private configuration", () => {
  assert.deepEqual(loadPersonalSentinels({ env: {}, defaultPath: "/missing/sentinels.json" }), []);
});

test("trusted releases require a nonempty private list", () => {
  for (const value of [undefined, "", "[]", '[" "]', "{}", "[42]", '"private-fixture"']) {
    assert.throws(
      () =>
        loadPersonalSentinels({
          env: {
            CAREERRAT_PERSONAL_SENTINELS_REQUIRED: "1",
            ...(value === undefined ? {} : { CAREERRAT_PERSONAL_SENTINELS: value }),
          },
          defaultPath: "/missing/sentinels.json",
        }),
      /private sentinel configuration/i
    );
  }
});

test("private JSON values are literal strings, deduplicated without changing their content", () => {
  assert.deepEqual(
    loadPersonalSentinels({
      env: { CAREERRAT_PERSONAL_SENTINELS: '["Fixture Person", "a.b[1]", "Fixture Person"]' },
    }),
    ["Fixture Person", "a.b[1]"]
  );
});

test("local file configuration works and the CI secret takes precedence", () => {
  const root = mkdtempSync(join(tmpdir(), "careerrat-sentinels-"));
  try {
    const file = join(root, "private.json");
    writeFileSync(file, '["Local Fixture"]');
    assert.deepEqual(loadPersonalSentinels({ env: {}, defaultPath: file }), ["Local Fixture"]);
    assert.deepEqual(
      loadPersonalSentinels({
        env: { CAREERRAT_PERSONAL_SENTINELS_FILE: file },
        defaultPath: "/missing/default.json",
      }),
      ["Local Fixture"]
    );
    assert.deepEqual(
      loadPersonalSentinels({
        env: { CAREERRAT_PERSONAL_SENTINELS: '["CI Fixture"]' },
        defaultPath: file,
      }),
      ["CI Fixture"]
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("configured missing files and malformed values fail without exposing private content", () => {
  for (const env of [
    { CAREERRAT_PERSONAL_SENTINELS_FILE: "/missing/private-fixture.json" },
    { CAREERRAT_PERSONAL_SENTINELS: '["private-fixture", invalid]' },
  ]) {
    assert.throws(
      () => loadPersonalSentinels({ env }),
      (error) => {
        assert.match(error.message, /private sentinel configuration/i);
        assert.equal(error.message.includes("private-fixture"), false);
        return true;
      }
    );
  }
});

test("receipt filtering uses the configured private strings for text and objects", () => {
  const output = execFileSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `
    import { containsPersonalSentinel } from ${JSON.stringify(new URL("../scripts/lib/personal-sentinels.mjs", import.meta.url).href)};
    console.log(JSON.stringify([
      containsPersonalSentinel("Saved Fixture Person"),
      containsPersonalSentinel({ company: "Fixture Person" }),
      containsPersonalSentinel({ company: "Another Fixture" }),
    ]));
  `,
    ],
    {
      encoding: "utf8",
      env: { ...process.env, CAREERRAT_PERSONAL_SENTINELS: '["Fixture Person"]' },
    }
  );
  assert.deepEqual(JSON.parse(output), [true, true, false]);
});

test("privacy scan failures do not print the private search patterns", {
  skip: process.platform === "win32",
}, () => {
  const root = mkdtempSync(join(tmpdir(), "careerrat-privacy-failure-"));
  try {
    writeFileSync(join(root, "git"), "#!/bin/sh\nexit 2\n", { mode: 0o755 });
    const privateValue = "PrivateFixtureForScanFailure";
    const result = spawnSync(
      process.execPath,
      [
        "--test",
        "--test-name-pattern",
        "tracked app files do not contain known production personal sentinels",
        "tests/release-safety.test.mjs",
      ],
      {
        cwd: fileURLToPath(new URL("../", import.meta.url)),
        encoding: "utf8",
        env: {
          ...process.env,
          NODE_TEST_CONTEXT: undefined,
          PATH: `${root}:${process.env.PATH}`,
          CAREERRAT_PERSONAL_SENTINELS: JSON.stringify([privateValue]),
        },
        timeout: 15_000,
      }
    );
    assert.equal(result.status, 1);
    assert.equal(`${result.stdout}${result.stderr}`.includes(privateValue), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("release configuration guard accepts exactly the same JSON as the private loader", {
  skip: process.platform === "win32",
}, () => {
  const workflow = parse(
    readFileSync(new URL("../.github/workflows/release.yml", import.meta.url), "utf8")
  );
  const guard = workflow.jobs["publish-release"].steps.find(
    (step) => step.name === "Require private release privacy configuration"
  );
  assert.ok(guard?.run);
  for (const raw of [
    '["PrivateFixtureForReleaseGate"]',
    ' \n["Fixture A", "Fixture B"]\t',
    "",
    "[]",
    '[" "]',
    '["\u2003"]',
    "[42]",
    '["Fixture A"] ["Fixture B"]',
    '\ufeff["Fixture A"]',
    '["PrivateFixtureForReleaseGate", invalid]',
  ]) {
    let accepted = true;
    try {
      loadPersonalSentinels({
        env: { CAREERRAT_PERSONAL_SENTINELS: raw, CAREERRAT_PERSONAL_SENTINELS_REQUIRED: "1" },
        defaultPath: "/missing/sentinels.json",
      });
    } catch {
      accepted = false;
    }
    const result = spawnSync("bash", ["-c", guard.run], {
      encoding: "utf8",
      timeout: 5_000,
      env: { PATH: process.env.PATH, PRIVATE_SENTINELS: raw },
    });
    assert.equal(
      result.status,
      accepted ? 0 : 1,
      `release guard disagrees with loader for ${JSON.stringify(raw)}`
    );
    assert.equal(
      `${result.stdout}${result.stderr}`.includes("PrivateFixtureForReleaseGate"),
      false
    );
  }
});
