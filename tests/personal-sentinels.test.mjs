import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
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
