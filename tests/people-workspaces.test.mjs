// CR73 slice a: one workspace per person, switched by name. Every case runs against
// a temp base directory; nothing here touches a real CAREERRAT_HOME.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { closeAll, openDb } from "../src/core/db/connection.mjs";
import { candidateConfigPatch } from "../src/core/db/verbs/candidate.mjs";
import { appUpsert } from "../src/core/db/verbs.mjs";
import { jobDocumentPaths } from "../src/core/documents/job-folders.mjs";
import {
  currentPerson,
  isValidPersonName,
  peopleBase,
  personEnv,
  personRoot,
  resolvePersonSelection,
  validatePersonName,
} from "../src/core/paths/people.mjs";
import { resolveUserPaths } from "../src/core/paths/workspace.mjs";
import { listPeople } from "../src/core/people/roster.mjs";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const BIN = join(REPO_ROOT, "bin/careerrat.mjs");

function tempBase(t) {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "careerrat-people-")));
  t.after(() => {
    closeAll();
    rmSync(base, { recursive: true, force: true });
  });
  return base;
}

function cleanEnv(extra = {}) {
  const env = { ...process.env, ...extra };
  for (const key of ["CAREERRAT_HOME", "CAREERRAT_PERSON", "CAREERRAT_PEOPLE_BASE"]) {
    if (!(key in extra)) delete env[key];
  }
  return env;
}

function cli(base, args, extra = {}) {
  return spawnSync(process.execPath, [BIN, ...args], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    env: cleanEnv({ CAREERRAT_HOME: base, ...extra }),
  });
}

test("person names: lowercase letters, numbers, hyphens, up to 40 characters", () => {
  for (const ok of ["a", "alice", "bob-2", "0abc", "a".repeat(40)]) {
    assert.equal(isValidPersonName(ok), true, ok);
  }
  for (const bad of ["", "-a", "A", "a b", "a/b", "..", "a.b", "a_b", "a".repeat(41), null, 5]) {
    assert.equal(isValidPersonName(bad), false, String(bad));
    assert.throws(() => validatePersonName(bad), /Invalid person name/);
  }
});

test("a person root is <base>/people/<name>, and the base stays the owner's workspace", (t) => {
  const base = tempBase(t);
  assert.equal(personRoot(base, "alice"), join(base, "people", "alice"));
  const env = personEnv({ repoRoot: REPO_ROOT, env: { CAREERRAT_HOME: base }, name: "alice" });
  assert.equal(env.CAREERRAT_HOME, join(base, "people", "alice"));
  assert.equal(env.CAREERRAT_PERSON, "alice");
  assert.equal(env.CAREERRAT_PEOPLE_BASE, base);
  // Applying it again from inside the selected person does not nest the root.
  const again = personEnv({ repoRoot: REPO_ROOT, env: { ...env }, name: "alice" });
  assert.deepEqual(again, env);
  const other = personEnv({ repoRoot: REPO_ROOT, env: { ...env }, name: "bob" });
  assert.equal(other.CAREERRAT_HOME, join(base, "people", "bob"));
});

test("with no person selected, paths are unchanged", (t) => {
  const base = tempBase(t);
  const env = { CAREERRAT_HOME: base };
  assert.equal(currentPerson(env), null);
  assert.equal(peopleBase({ repoRoot: REPO_ROOT, env }), base);
  assert.equal(resolveUserPaths({ repoRoot: REPO_ROOT, env }).dataRoot, base);
  const application = { id: "job-1", company: "Acme" };
  assert.equal(
    jobDocumentPaths({ application, env: {} }).active,
    join(homedir(), "Documents", "careerrat", "Acme", "job-job-1")
  );
});

test("documents go to ~/Documents/careerrat/<name> for a person unless the downloads dir is set", () => {
  const application = { id: "x", company: "Acme" };
  const person = jobDocumentPaths({ application, env: { CAREERRAT_PERSON: "alice" } });
  assert.equal(person.active, join(homedir(), "Documents", "careerrat", "alice", "Acme", "job-x"));
  const explicit = jobDocumentPaths({
    application,
    env: { CAREERRAT_PERSON: "alice", CAREERRAT_DOWNLOADS_DIR: "/tmp/docs" },
  });
  assert.equal(explicit.active, join("/tmp/docs", "Acme", "job-x"));
});

test("people add creates the root and prints the next command; list reports each person", (t) => {
  const base = tempBase(t);
  const add = cli(base, ["people", "add", "alice"]);
  assert.equal(add.status, 0, add.stderr);
  assert.ok(existsSync(join(base, "people", "alice")));
  assert.match(add.stdout, /Next: careerrat start --for alice/);

  const bad = cli(base, ["people", "add", "Not Valid"]);
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /Invalid person name/);

  cli(base, ["people", "add", "bob"]);
  const list = cli(base, ["people", "list", "--json"]);
  assert.equal(list.status, 0, list.stderr);
  const parsed = JSON.parse(list.stdout);
  assert.deepEqual(parsed.people, [
    { name: "alice", ready: false },
    { name: "bob", ready: false },
  ]);
  const text = cli(base, ["people", "list"]);
  assert.match(text.stdout, /alice\s+setup not finished/);
});

test("people list on an empty base says how to add someone", (t) => {
  const base = tempBase(t);
  const list = cli(base, ["people", "list"]);
  assert.equal(list.status, 0);
  assert.match(list.stdout, /careerrat people add <name>/);
});

test("--for sets CAREERRAT_HOME for the command and refuses a person that doesn't exist", (t) => {
  const base = tempBase(t);
  cli(base, ["people", "add", "a"]);
  const status = cli(base, ["--for", "a", "data", "init"]);
  assert.equal(status.status, 0, status.stderr);
  // The database landed under the person's root, not the base.
  assert.ok(existsSync(join(base, "people", "a", "db", "careerrat.db")));
  assert.equal(existsSync(join(base, "db", "careerrat.db")), false);
  const json = cli(base, ["--for", "a", "data", "status", "--json"]);
  assert.equal(JSON.parse(json.stdout).exists, true);
  const equalsForm = cli(base, ["--for=a", "evidence", "path", "--json"]);
  assert.equal(
    JSON.parse(equalsForm.stdout).relPath,
    join(base, "people", "a", "candidate", "evidence.yml")
  );

  const missing = cli(base, ["--for", "ghost", "data", "status", "--json"]);
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /careerrat people add ghost/);
  assert.equal(existsSync(join(base, "people", "ghost")), false);

  const invalid = cli(base, ["--for", "../x", "doctor"]);
  assert.equal(invalid.status, 1);
  assert.match(invalid.stderr, /Invalid person name/);
});

test("CAREERRAT_PERSON in the environment selects the same person as --for", (t) => {
  const base = tempBase(t);
  cli(base, ["people", "add", "a"]);
  const res = cli(base, ["evidence", "path", "--json"], { CAREERRAT_PERSON: "a" });
  assert.equal(res.status, 0, res.stderr);
  assert.equal(
    JSON.parse(res.stdout).relPath,
    join(base, "people", "a", "candidate", "evidence.yml")
  );
});

test("no --for leaves the owner's workspace in place", (t) => {
  const base = tempBase(t);
  const res = cli(base, ["evidence", "path", "--json"]);
  assert.equal(JSON.parse(res.stdout).relPath, join(base, "candidate", "evidence.yml"));
});

test("two people stay isolated across candidate config, evidence and tracker", (t) => {
  const base = tempBase(t);
  const people = {};
  for (const name of ["alice", "bob"]) {
    assert.equal(cli(base, ["people", "add", name]).status, 0);
    assert.equal(cli(base, ["--for", name, "data", "init"]).status, 0);
    people[name] = { root: join(base, "people", name) };
    people[name].env = { CAREERRAT_HOME: people[name].root };
    candidateConfigPatch({
      repoRoot: REPO_ROOT,
      env: people[name].env,
      name: "profile",
      patch: { candidate: { full_name: `${name} Person`, email: `${name}@example.com` } },
    });
    appUpsert({
      repoRoot: REPO_ROOT,
      env: people[name].env,
      row: { id: `${name}-role`, company: "Acme", role: "Engineer", status: "interested" },
    });
    const claimFile = join(base, `${name}-claim.yml`);
    writeFileSync(
      claimFile,
      `id: ${name}-claim\nclaim: ${name} shipped a thing\nevidence: ${name} did the work.\n`
    );
    const add = cli(base, ["--for", name, "evidence", "add", "--file", claimFile, "--write"]);
    assert.equal(add.status, 0, add.stderr + add.stdout);
  }

  for (const [name, other] of [
    ["alice", "bob"],
    ["bob", "alice"],
  ]) {
    const { root, env } = people[name];
    const paths = resolveUserPaths({ repoRoot: REPO_ROOT, env });
    assert.equal(paths.dataRoot, root);
    assert.ok(paths.candidateDir.startsWith(`${root}/`));

    const evidencePath = JSON.parse(
      cli(base, ["--for", name, "evidence", "path", "--json"]).stdout
    ).relPath;
    assert.equal(evidencePath, join(root, "candidate", "evidence.yml"));
    const evidence = cli(base, ["--for", name, "evidence", "list"]).stdout;
    assert.match(evidence, new RegExp(`${name}-claim`));
    assert.doesNotMatch(evidence, new RegExp(`${other}-claim`));

    const config = JSON.stringify(
      JSON.parse(cli(base, ["--for", name, "data", "candidate", "get"]).stdout)
    );
    assert.match(config, new RegExp(`${name} Person`));
    assert.doesNotMatch(config, new RegExp(`${other} Person`));

    const rows = openDb({ repoRoot: REPO_ROOT, env })
      .prepare("SELECT id FROM applications")
      .all()
      .map((row) => row.id);
    assert.deepEqual(rows, [`${name}-role`]);
  }

  // The owner's base workspace never saw either person.
  assert.equal(existsSync(join(base, "db")), false);
  assert.equal(existsSync(join(base, "candidate", "evidence.yml")), false);
});

test("listPeople marks a person ready only when their own setup is search-ready", (t) => {
  const base = tempBase(t);
  mkdirSync(join(base, "people", "empty"), { recursive: true });
  const env = { CAREERRAT_HOME: base };
  assert.deepEqual(listPeople({ repoRoot: REPO_ROOT, env }), [{ name: "empty", ready: false }]);
});

test("the app server reports who it is running for and who else exists", async (t) => {
  const base = tempBase(t);
  mkdirSync(join(base, "people", "alice"), { recursive: true });
  mkdirSync(join(base, "people", "bob"), { recursive: true });
  const { mountPeopleRoutes } = await import("../src/cli/people-route.mjs");
  const routes = new Map();
  const addRoute = (method, path, handler) => routes.set(`${method} ${path}`, handler);
  const env = personEnv({ repoRoot: REPO_ROOT, env: { CAREERRAT_HOME: base }, name: "alice" });
  mountPeopleRoutes({ addRoute, repoRoot: REPO_ROOT, env });
  let body = "";
  let status = 0;
  const res = {
    writeHead(code) {
      status = code;
    },
    setHeader() {},
    end(chunk) {
      body = chunk;
    },
  };
  routes.get("GET /api/people")({}, res);
  assert.equal(status, 200);
  assert.deepEqual(JSON.parse(body), {
    current: "alice",
    people: [
      { name: "alice", ready: false },
      { name: "bob", ready: false },
    ],
  });
});

test("--for applies before update, so update never runs against the owner's workspace", (t) => {
  const base = tempBase(t);
  const res = cli(base, ["--for", "ghost", "update", "--check"], {
    CAREERRAT_NO_UPDATE_CHECK: "1",
  });
  assert.equal(res.status, 1);
  assert.match(res.stderr, /No workspace for "ghost"/);
  assert.doesNotMatch(res.stdout, /Checking npm/);
});

test("an empty --for= is rejected like a bare --for", (t) => {
  const base = tempBase(t);
  const res = cli(base, ["--for=", "evidence", "path", "--json"]);
  assert.equal(res.status, 1);
  assert.match(res.stderr, /--for needs a person name/);
  assert.equal(res.stdout, "");
});

test("a whitespace-only CAREERRAT_PERSON is rejected, an unset one means no person", (t) => {
  const base = tempBase(t);
  const res = cli(base, ["evidence", "path", "--json"], { CAREERRAT_PERSON: "   " });
  assert.equal(res.status, 1);
  assert.match(res.stderr, /CAREERRAT_PERSON is set but blank/);
  assert.equal(resolvePersonSelection({ repoRoot: REPO_ROOT, env: {} }), null);
});

test("resolvePersonSelection requires the person to exist and is idempotent", (t) => {
  const base = tempBase(t);
  const env = { CAREERRAT_HOME: base, CAREERRAT_PERSON: "alice" };
  assert.throws(
    () => resolvePersonSelection({ repoRoot: REPO_ROOT, env }),
    /No workspace for "alice"/
  );
  mkdirSync(join(base, "people", "alice"), { recursive: true });
  const first = resolvePersonSelection({ repoRoot: REPO_ROOT, env });
  assert.equal(first.CAREERRAT_HOME, join(base, "people", "alice"));
  assert.equal(first.CAREERRAT_PEOPLE_BASE, base);
  const again = resolvePersonSelection({ repoRoot: REPO_ROOT, env: { ...env, ...first } });
  assert.deepEqual(again, first);
});

test("running tracker-dev directly applies the person selection", (t) => {
  const base = tempBase(t);
  const run = (extra) =>
    spawnSync(process.execPath, [join(REPO_ROOT, "src/cli/tracker-dev.mjs")], {
      cwd: REPO_ROOT,
      encoding: "utf8",
      timeout: 8000,
      killSignal: "SIGKILL",
      env: cleanEnv({ CAREERRAT_HOME: base, ...extra }),
    });
  const missing = run({ CAREERRAT_PERSON: "ghost" });
  assert.equal(missing.status, 1, missing.stdout + missing.stderr);
  assert.match(missing.stderr, /No workspace for "ghost"/);
  const blank = run({ CAREERRAT_PERSON: "  " });
  assert.equal(blank.status, 1);
  assert.match(blank.stderr, /CAREERRAT_PERSON is set but blank/);
});
