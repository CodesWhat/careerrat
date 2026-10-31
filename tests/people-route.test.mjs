import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { mountPeopleRoutes } from "../src/cli/people-route.mjs";
import { peopleBase, personEnv, resolvePersonSelection } from "../src/core/paths/people.mjs";
import { privateDataRoot } from "../src/core/paths/workspace.mjs";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const quote = (value) => `'${value.replaceAll("'", "'\\''")}'`;

function response(env) {
  let handler;
  let result;
  mountPeopleRoutes({
    repoRoot,
    env,
    addRoute: (_method, _path, route) => {
      handler = route;
    },
  });
  handler(
    {},
    {
      writeHead() {},
      setHeader() {},
      end(body) {
        result = JSON.parse(body);
      },
    }
  );
  return result;
}

function runCommand(command) {
  const probe = `
    const { peopleBase, resolvePersonSelection } = await import(${JSON.stringify(new URL("../src/core/paths/people.mjs", import.meta.url).href)});
    const { privateDataRoot } = await import(${JSON.stringify(new URL("../src/core/paths/workspace.mjs", import.meta.url).href)});
    const args = process.argv.slice(1);
    const env = process.env;
    const selection = resolvePersonSelection({ repoRoot: ${JSON.stringify(repoRoot)}, env, forName: args[0] === '--for' ? args[1] : null, allowMissing: true });
    console.log(JSON.stringify({ args, base: peopleBase({ repoRoot: ${JSON.stringify(repoRoot)}, env }), root: selection?.CAREERRAT_HOME || privateDataRoot({ repoRoot: ${JSON.stringify(repoRoot)}, env }) }));
  `;
  const env = { ...process.env };
  delete env.CAREERRAT_HOME;
  delete env.CAREERRAT_PERSON;
  delete env.CAREERRAT_PEOPLE_BASE;
  const result = spawnSync(
    "/bin/sh",
    [
      "-c",
      `careerrat() { ${quote(process.execPath)} --input-type=module -e ${quote(probe)} -- "$@"; }; ${command}`,
    ],
    { cwd: tmpdir(), env, encoding: "utf8" }
  );
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

for (const scenario of [
  { name: "default owner", env: {}, command: "careerrat start codex" },
  { name: "custom owner", env: { CAREERRAT_HOME: "relative owner workspace" } },
  {
    name: "owner with a custom people base",
    env: { CAREERRAT_HOME: "relative owner", CAREERRAT_PEOPLE_BASE: "relative people" },
  },
  { name: "default person", person: "alice", env: {} },
  {
    name: "custom people base",
    person: "alice",
    env: { CAREERRAT_HOME: "/unused-owner", CAREERRAT_PEOPLE_BASE: "relative people's workspace" },
  },
]) {
  test(`start command reopens the ${scenario.name} workspace in a fresh terminal`, () => {
    const env = scenario.person
      ? personEnv({ repoRoot, env: scenario.env, name: scenario.person })
      : scenario.env;
    const command = response(env).startCommand;
    assert.equal(typeof command, "string");
    if (scenario.command) assert.equal(command, scenario.command);
    const actual = runCommand(command);
    const selection = resolvePersonSelection({ repoRoot, env, allowMissing: true });
    const expectedRoot = selection?.CAREERRAT_HOME || privateDataRoot({ repoRoot, env });
    assert.equal(actual.root, resolve(repoRoot, expectedRoot));
    assert.equal(actual.base, resolve(repoRoot, peopleBase({ repoRoot, env })));
    assert.deepEqual(
      actual.args,
      scenario.person ? ["--for", "alice", "start", "codex"] : ["start", "codex"]
    );
    if (scenario.person)
      assert.ok(
        !command.includes(`CAREERRAT_HOME=${quote(env.CAREERRAT_HOME)}`),
        "the selected person's home must not become the people base"
      );
  });
}

test("start command quotes owner paths with spaces and apostrophes", (t) => {
  const base = mkdtempSync(join(tmpdir(), "careerrat-people-route-"));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const home = join(base, "owner's workspace");
  const command = response({ CAREERRAT_HOME: home }).startCommand;
  assert.equal(typeof command, "string");
  assert.equal(runCommand(command).root, home);
});
