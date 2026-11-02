// CR73/CR100/CR101: running CareerRat for other people end to end. Two people plus the
// owner's default workspace, every one on a temp home. Nothing here touches the real
// ~/.careerrat or ~/Documents.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { writeLocalAiKey } from "../src/core/ai/ai-env.mjs";
import { profilePath } from "../src/core/automation/session.mjs";
import { closeAll } from "../src/core/db/connection.mjs";
import { sourcingRunGet, sourcingRunStart } from "../src/core/db/verbs/sourcing-runs.mjs";
import { appUpsert } from "../src/core/db/verbs.mjs";
import { jobDocumentPaths } from "../src/core/documents/job-folders.mjs";
import { searchHandoffPath } from "../src/core/search/terminal-search-worker.mjs";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const BIN = join(REPO_ROOT, "bin/careerrat.mjs");
const PEOPLE = ["alice", "bob"];

function sandbox(t) {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "careerrat-multi-")));
  const home = realpathSync(mkdtempSync(join(tmpdir(), "careerrat-multi-home-")));
  // os.homedir() reads HOME at call time, and the in-process document paths use it.
  const realHome = process.env.HOME;
  process.env.HOME = home;
  t.after(() => {
    process.env.HOME = realHome;
    closeAll();
    rmSync(base, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  });
  const env = {
    PATH: `${dirname(process.execPath)}:/usr/bin:/bin`,
    HOME: home,
    USER: "operator",
    CAREERRAT_HOME: base,
    CAREERRAT_NO_UPDATE_CHECK: "1",
  };
  const run = (args, extra = {}) =>
    spawnSync(process.execPath, [BIN, ...args], {
      cwd: REPO_ROOT,
      encoding: "utf8",
      env: { ...env, ...extra },
    });
  return { base, home, env, run };
}

function filesUnder(dir, skip = () => false, out = []) {
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (skip(full)) continue;
    if (entry.isDirectory()) filesUnder(full, skip, out);
    else out.push(full);
  }
  return out;
}

function leaks(files, marker) {
  return files.filter((file) => readFileSync(file).includes(marker));
}

test("two people and the default stay isolated: DB, files, search runs, browser profile, documents, TUI snapshot", (t) => {
  const { base, home, run } = sandbox(t);
  const rootOf = {
    default: base,
    alice: join(base, "people", "alice"),
    bob: join(base, "people", "bob"),
  };
  const homeEnv = (key) => ({ CAREERRAT_HOME: rootOf[key], HOME: home });
  const forArgs = (key) => (key === "default" ? [] : ["--for", key]);

  assert.equal(run(["people", "add", "alice"]).status, 0);
  // bob is created by --new on a command that isn't `start`.
  const created = run(["--for", "bob", "--new", "data", "init"]);
  assert.equal(created.status, 0, created.stderr);
  assert.equal(run(["--for", "alice", "data", "init"]).status, 0);
  assert.equal(run(["data", "init"]).status, 0);

  for (const key of ["default", ...PEOPLE]) {
    const env = homeEnv(key);
    appUpsert({
      repoRoot: REPO_ROOT,
      env,
      row: { id: `${key}-role`, company: `${key}-corp`, role: "Engineer", status: "interested" },
    });
    sourcingRunStart({
      repoRoot: REPO_ROOT,
      env,
      purpose: "manual-search",
      id: `manual-search-${key}`,
    });
    const claim = join(home, `${key}-claim.yml`);
    writeFileSync(
      claim,
      `id: ${key}-claim\nclaim: ${key} shipped a thing\nevidence: ${key} did it.\n`
    );
    const added = run([...forArgs(key), "evidence", "add", "--file", claim, "--write"]);
    assert.equal(added.status, 0, added.stderr + added.stdout);
    rmSync(claim);
    // A browser profile and a generated document, written where the code says they go.
    const profile = profilePath("linkedin", { repoRoot: REPO_ROOT, env });
    assert.ok(profile.startsWith(`${rootOf[key]}/`), `${key} browser profile ${profile}`);
    mkdirSync(profile, { recursive: true });
    writeFileSync(join(profile, "cookies.txt"), `${key}-cookie`);
    const docs = jobDocumentPaths({
      application: { id: `${key}-role`, company: `${key}-corp` },
      env: { ...env, ...(key === "default" ? {} : { CAREERRAT_PERSON: key }) },
    });
    mkdirSync(docs.path, { recursive: true });
    writeFileSync(join(docs.path, "resume.txt"), `${key}-resume`);
    const handoff = searchHandoffPath({ repoRoot: REPO_ROOT, env }, `manual-search-${key}`);
    mkdirSync(dirname(handoff), { recursive: true });
    writeFileSync(handoff, `${key}-handoff`);
  }

  for (const key of ["default", ...PEOPLE]) {
    const env = homeEnv(key);
    const others = ["default", ...PEOPLE].filter((other) => other !== key);

    // Search runs: its own run reads back, another workspace's id doesn't exist here.
    assert.equal(
      sourcingRunGet({ repoRoot: REPO_ROOT, env, id: `manual-search-${key}` }).run.id,
      `manual-search-${key}`
    );
    for (const other of others) {
      assert.throws(() =>
        sourcingRunGet({ repoRoot: REPO_ROOT, env, id: `manual-search-${other}` })
      );
      const status = run([...forArgs(key), "search", "status", "--id", `manual-search-${other}`]);
      assert.notEqual(status.status, 0, `${key} read ${other}'s search run`);
    }
    const own = run([...forArgs(key), "search", "status", "--id", `manual-search-${key}`]);
    assert.equal(own.status, 0, own.stderr);
    assert.ok(JSON.parse(own.stdout).handoffPath.startsWith(`${rootOf[key]}/`));

    // TUI snapshot: its own jobs and name only.
    const snapshot = JSON.parse(run([...forArgs(key), "tui", "--json"]).stdout);
    assert.deepEqual(
      snapshot.jobs.map((job) => job.id),
      [`${key}-role`]
    );
    assert.equal(snapshot.person, key === "default" ? null : key);
    assert.deepEqual(
      snapshot.searchRuns.map((r) => r.id),
      [`manual-search-${key}`]
    );

    // Evidence through the CLI.
    const evidence = run([...forArgs(key), "evidence", "list"]).stdout;
    assert.match(evidence, new RegExp(`${key}-claim`));
    for (const other of others) assert.doesNotMatch(evidence, new RegExp(`${other}-claim`));

    // Every file on disk for this workspace (database, profile, runs) holds only its own marker.
    const skipPeople = (path) =>
      key === "default" && (path === join(base, "people") || path === join(base, "people-backups"));
    const files = filesUnder(rootOf[key], skipPeople);
    for (const other of others) {
      assert.deepEqual(leaks(files, `${other}-role`), [], `${key} root holds ${other}-role`);
      assert.deepEqual(leaks(files, `${other}-cookie`), [], `${key} root holds ${other}-cookie`);
      assert.deepEqual(leaks(files, `${other}-claim`), [], `${key} root holds ${other}-claim`);
    }
    assert.ok(leaks(files, `${key}-role`).length > 0, `${key} DB holds its own job`);
    assert.ok(leaks(files, `${key}-cookie`).length > 0);

    // Generated documents live in the person's own folder.
    const docRoot =
      key === "default"
        ? join(home, "Documents", "careerrat")
        : join(home, "Documents", "careerrat", key);
    assert.ok(existsSync(join(docRoot, `${key}-corp`)), `${key} documents`);
  }
  assert.equal(existsSync(join(home, "Documents", "careerrat", "alice", "bob-corp")), false);
  assert.equal(existsSync(join(home, "Documents", "careerrat", "bob", "alice-corp")), false);
});

test("adding a person, by command or by --new, records an authorization note in their data", (t) => {
  const { base, run } = sandbox(t);
  const add = run([
    "people",
    "add",
    "alice",
    "--authorized-by",
    "Alice Smith",
    "--purpose",
    "job search help",
  ]);
  assert.equal(add.status, 0, add.stderr);
  const note = JSON.parse(
    readFileSync(join(base, "people", "alice", "internal", "authorization.json"), "utf8")
  );
  assert.equal(note.person, "alice");
  assert.equal(note.records.length, 1);
  assert.equal(note.records[0].authorizedBy, "Alice Smith");
  assert.equal(note.records[0].purpose, "job search help");
  assert.equal(note.records[0].recordedBy, "operator");
  assert.ok(!Number.isNaN(Date.parse(note.records[0].authorizedAt)));

  const viaNew = run(["--for", "bob", "--new", "data", "init"]);
  assert.equal(viaNew.status, 0, viaNew.stderr);
  const bobNote = JSON.parse(
    readFileSync(join(base, "people", "bob", "internal", "authorization.json"), "utf8")
  );
  assert.equal(bobNote.records[0].authorizedBy, "not stated");
  assert.match(viaNew.stderr, /Record who authorized it/);

  // Stating it later appends instead of overwriting.
  run(["people", "add", "bob", "--authorized-by", "Bob Jones", "--purpose", "resume help"]);
  const later = JSON.parse(
    readFileSync(join(base, "people", "bob", "internal", "authorization.json"), "utf8")
  );
  assert.deepEqual(
    later.records.map((r) => r.authorizedBy),
    ["not stated", "Bob Jones"]
  );
});

test("people remove --purge needs --yes, backs up first, and removes root, browser profile and documents", (t) => {
  const { base, home, run } = sandbox(t);
  for (const name of PEOPLE) {
    assert.equal(run(["people", "add", name]).status, 0);
    mkdirSync(join(base, "people", name, "board-profiles", "linkedin"), { recursive: true });
    writeFileSync(
      join(base, "people", name, "board-profiles", "linkedin", "cookies.txt"),
      `${name}-cookie`
    );
    mkdirSync(join(home, "Documents", "careerrat", name, "Acme"), { recursive: true });
    writeFileSync(
      join(home, "Documents", "careerrat", name, "Acme", "resume.txt"),
      `${name}-resume`
    );
  }

  const noPurge = run(["people", "remove", "alice"]);
  assert.notEqual(noPurge.status, 0);
  const noYes = run(["people", "remove", "alice", "--purge"]);
  assert.notEqual(noYes.status, 0);
  assert.match(noYes.stderr, /without --yes/);
  assert.ok(existsSync(join(base, "people", "alice")));
  assert.ok(existsSync(join(home, "Documents", "careerrat", "alice")));

  const missing = run(["people", "remove", "nobody", "--purge", "--yes"]);
  assert.notEqual(missing.status, 0);

  const purged = run(["people", "remove", "alice", "--purge", "--yes", "--json"]);
  assert.equal(purged.status, 0, purged.stderr);
  const result = JSON.parse(purged.stdout);
  assert.equal(existsSync(join(base, "people", "alice")), false);
  assert.equal(existsSync(join(home, "Documents", "careerrat", "alice")), false);
  assert.ok(result.backup.startsWith(join(base, "people-backups", "alice-")));
  assert.equal(
    readFileSync(
      join(result.backup, "workspace", "board-profiles", "linkedin", "cookies.txt"),
      "utf8"
    ),
    "alice-cookie"
  );
  assert.equal(
    readFileSync(join(result.backup, "documents", "Acme", "resume.txt"), "utf8"),
    "alice-resume"
  );
  assert.ok(existsSync(join(result.backup, "workspace", "internal", "authorization.json")));

  // bob is untouched, and the backup folder is not mistaken for a person.
  assert.ok(existsSync(join(base, "people", "bob", "board-profiles", "linkedin", "cookies.txt")));
  assert.ok(existsSync(join(home, "Documents", "careerrat", "bob", "Acme", "resume.txt")));
  assert.deepEqual(
    JSON.parse(run(["people", "list", "--json"]).stdout).people.map((p) => p.name),
    ["bob"]
  );
});

test("an explicit downloads directory is left alone by a purge", (t) => {
  const { base, run } = sandbox(t);
  const shared = join(base, "..", `shared-docs-${process.pid}`);
  mkdirSync(shared, { recursive: true });
  t.after(() => rmSync(shared, { recursive: true, force: true }));
  run(["people", "add", "alice"]);
  writeFileSync(join(shared, "keep.txt"), "keep");
  const purged = run(["people", "remove", "alice", "--purge", "--yes"], {
    CAREERRAT_DOWNLOADS_DIR: shared,
  });
  assert.equal(purged.status, 0, purged.stderr);
  assert.ok(existsSync(join(shared, "keep.txt")));
});

test("doctor names the AI route for a person: operator's access, operator's key, or their own key", (t) => {
  const { base, run } = sandbox(t);
  run(["people", "add", "alice"]);
  const route = (extra = {}) => {
    const out = run(["--for", "alice", "doctor", "--json"], extra);
    return JSON.parse(out.stdout);
  };

  const plain = route();
  assert.equal(plain.person, "alice");
  assert.ok(["operator-subscription", "none"].includes(plain.aiRoute.kind), plain.aiRoute.kind);
  assert.equal(plain.aiRoute.borrowed, plain.aiRoute.kind !== "own-key");

  const operatorKey = route({ ANTHROPIC_API_KEY: "sk-operator-shell-key" });
  assert.equal(operatorKey.aiRoute.kind, "operator-key");
  assert.equal(operatorKey.aiRoute.borrowed, true);
  assert.doesNotMatch(JSON.stringify(operatorKey), /sk-operator-shell-key/);

  writeLocalAiKey({
    repoRoot: REPO_ROOT,
    apiKey: "sk-alice-own-key",
    env: { CAREERRAT_HOME: join(base, "people", "alice") },
  });
  const own = route();
  assert.equal(own.aiRoute.kind, "own-key");
  assert.equal(own.aiRoute.borrowed, false);
  assert.doesNotMatch(JSON.stringify(own), /sk-alice-own-key/);

  const text = run(["--for", "alice", "doctor"]).stdout;
  assert.match(text, /Workspace for: alice/);
  assert.match(text, /AI route: alice's own AI key/);
});

test("a background search for someone without their own key warns first and still runs", (t) => {
  const { base, run } = sandbox(t);
  run(["people", "add", "alice"]);
  const warned = run(["--for", "alice", "search", "start"]);
  assert.match(warned.stderr, /Warning: alice has no AI key of their own/);

  writeLocalAiKey({
    repoRoot: REPO_ROOT,
    apiKey: "sk-alice-own-key",
    env: { CAREERRAT_HOME: join(base, "people", "alice") },
  });
  const quiet = run(["--for", "alice", "search", "start"]);
  assert.doesNotMatch(quiet.stderr, /has no AI key of their own/);

  // The owner's own workspace never gets the warning.
  const owner = run(["search", "start"]);
  assert.doesNotMatch(owner.stderr, /has no AI key of their own/);
});
