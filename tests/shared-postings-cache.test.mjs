// Shared public-posting cache: one fetch per board, every person matched.
// Every test runs in a temp data root; nothing touches ~/.careerrat or ~/Documents.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { runSourcedScan } from "../scripts/scan-sourced.mjs";
import { closeAll, openDb } from "../src/core/db/connection.mjs";
import {
  candidateArtifactPut,
  candidateConfigPatch,
  candidateSetupInitialize,
  sourceConfigPut,
} from "../src/core/db/verbs.mjs";
import { personEnv, personRoot } from "../src/core/paths/people.mjs";
import { openRunCache, sharedCachePath } from "../src/core/search/shared-postings-cache.mjs";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const HOST = async () => [{ address: "93.184.216.34", family: 4 }];

function tempBase(t) {
  const base = mkdtempSync(join(tmpdir(), "careerrat-shared-cache-"));
  t.after(() => {
    closeAll();
    rmSync(base, { recursive: true, force: true });
  });
  return base;
}

function envFor(base, name) {
  return personEnv({ repoRoot: REPO_ROOT, env: { CAREERRAT_HOME: base }, name });
}

// A search-ready person with their own targeting and the same tracked board.
function addPerson(base, name, { titles, marker, searchPreferences } = {}) {
  mkdirSync(personRoot(base, name), { recursive: true });
  const env = envFor(base, name);
  candidateSetupInitialize({ repoRoot: REPO_ROOT, env });
  candidateArtifactPut({
    repoRoot: REPO_ROOT,
    env,
    id: "source-resume",
    kind: "source-resume",
    data: { format: "text", text: `${marker} resume text.` },
  });
  candidateConfigPatch({
    repoRoot: REPO_ROOT,
    env,
    name: "targeting",
    patch: {
      role_buckets: [{ name: "Target", titles }],
      ...(searchPreferences ? { search_preferences: searchPreferences } : {}),
    },
  });
  candidateConfigPatch({
    repoRoot: REPO_ROOT,
    env,
    name: "profile",
    patch: {
      candidate: { full_name: `${marker} Person`, email: `${marker}@example.com` },
      location: { home: "New York, NY", remote: true },
    },
  });
  sourceConfigPut({
    repoRoot: REPO_ROOT,
    env,
    name: "sourced-scan",
    data: {
      title_filter: {},
      location_filter: null,
      tracked_companies: [{ name: "Acme", careers_url: "https://jobs.lever.co/acme" }],
    },
  });
  return env;
}

function leverStub(counter) {
  return async (url) => {
    assert.match(String(url), /api\.lever\.co/);
    counter.calls += 1;
    return new Response(
      JSON.stringify([
        {
          text: "Staff Platform Engineer",
          hostedUrl: "https://jobs.lever.co/acme/platform-1",
          categories: { location: "Remote - US" },
          descriptionPlain: "Own platform infrastructure, identity, and automation systems.",
        },
        {
          text: "Senior Product Designer",
          hostedUrl: "https://jobs.lever.co/acme/design-1",
          categories: { location: "Remote - US" },
          descriptionPlain: "Design product surfaces, prototypes, and design systems.",
        },
      ]),
      { status: 200 }
    );
  };
}

function scan(env, counter, extra = {}) {
  return runSourcedScan({
    repoRoot: REPO_ROOT,
    env,
    fetchImpl: leverStub(counter),
    resolveHost: HOST,
    hostThrottle: false,
    ...extra,
  });
}

function sourcedRows(env) {
  return openDb({ repoRoot: REPO_ROOT, env })
    .prepare(
      "SELECT json_extract(data, '$.role') AS role, json_extract(data, '$.source') AS source FROM sourced ORDER BY role"
    )
    .all()
    .map((row) => ({ ...row }));
}

function twoPeople(base) {
  return {
    alice: addPerson(base, "alice", { titles: ["Platform Engineer"], marker: "alice" }),
    bob: addPerson(base, "bob", { titles: ["Product Designer"], marker: "bob" }),
  };
}

test("one fetch serves both people, each matched by their own targeting", async (t) => {
  const base = tempBase(t);
  const { alice, bob } = twoPeople(base);
  const counter = { calls: 0 };
  const summary = await scan(alice, counter);

  assert.equal(counter.calls, 1);
  assert.deepEqual(
    sourcedRows(alice).map((row) => row.role),
    ["Staff Platform Engineer"]
  );
  assert.equal(sourcedRows(alice)[0].source, "lever-api");
  assert.deepEqual(sourcedRows(bob), [{ role: "Senior Product Designer", source: "shared-cache" }]);
  assert.deepEqual(summary.sharedCache.alsoMatchedFor, [{ person: "bob", count: 1 }]);
  assert.equal(summary.sharedCache.newPostings, 2);
  assert.equal(summary.sharedCache.sourcesFetched, 1);
  assert.equal(summary.sharedCache.sourcesReused, 0);
});

test("a cross-match never duplicates what the person already has", async (t) => {
  const base = tempBase(t);
  const { alice, bob } = twoPeople(base);
  const counter = { calls: 0 };
  await scan(alice, counter);
  await scan(bob, counter, { recheckDead: true });
  assert.deepEqual(
    sourcedRows(bob).map((row) => row.role),
    ["Senior Product Designer"]
  );
});

test("a second person's scan inside the freshness window reuses the cached source", async (t) => {
  const base = tempBase(t);
  const { alice, bob } = twoPeople(base);
  const counter = { calls: 0 };
  await scan(alice, counter);
  const summary = await scan(bob, counter);
  assert.equal(counter.calls, 1);
  assert.equal(summary.sharedCache.sourcesReused, 1);
  assert.equal(summary.sharedCache.sourcesFetched, 0);
  assert.equal(summary.sourceCoverage[0].cached, true);
  assert.equal(summary.sharedCache.newPostings, 0);
  assert.deepEqual(summary.sharedCache.alsoMatchedFor, []);
});

test("a stale cache entry is refetched, and the window is configurable", async (t) => {
  const base = tempBase(t);
  const { alice, bob } = twoPeople(base);
  const counter = { calls: 0 };
  await scan(alice, counter);

  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(sharedCachePath(base));
  db.prepare("UPDATE sources SET fetched_at = ?").run(
    new Date(Date.now() - 7 * 3600000).toISOString()
  );
  db.close();
  await scan(bob, counter);
  assert.equal(counter.calls, 2, "7h old is outside the default 6h window");

  const db2 = new DatabaseSync(sharedCachePath(base));
  db2
    .prepare("UPDATE sources SET fetched_at = ?")
    .run(new Date(Date.now() - 7 * 3600000).toISOString());
  db2.close();
  writeFileSync(join(base, "shared-cache.json"), JSON.stringify({ freshnessHours: 12 }));
  await scan(alice, counter);
  assert.equal(counter.calls, 2, "7h old is inside a 12h window");
});

test("a posting that leaves the board is marked closed and no longer served", async (t) => {
  const base = tempBase(t);
  const { alice, bob } = twoPeople(base);
  const counter = { calls: 0 };
  await scan(alice, counter);
  const only = async () => {
    counter.calls += 1;
    return new Response(
      JSON.stringify([
        {
          text: "Staff Platform Engineer",
          hostedUrl: "https://jobs.lever.co/acme/platform-1",
          categories: { location: "Remote - US" },
          descriptionPlain: "Own platform infrastructure, identity, and automation systems.",
        },
      ]),
      { status: 200 }
    );
  };
  await runSourcedScan({
    repoRoot: REPO_ROOT,
    env: alice,
    fetchImpl: only,
    resolveHost: HOST,
    hostThrottle: false,
    recheckDead: true,
  });
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(sharedCachePath(base));
  const rows = db.prepare("SELECT title, closed FROM postings ORDER BY title").all();
  db.close();
  assert.deepEqual(
    rows.map((row) => ({ ...row })),
    [
      { title: "Senior Product Designer", closed: 1 },
      { title: "Staff Platform Engineer", closed: 0 },
    ]
  );
  void bob;
});

test("a person can opt out of cross-matches, and the global switch disables the cache", async (t) => {
  const base = tempBase(t);
  const alice = addPerson(base, "alice", { titles: ["Platform Engineer"], marker: "alice" });
  const bob = addPerson(base, "bob", {
    titles: ["Product Designer"],
    marker: "bob",
    searchPreferences: { shared_cache: { receive: false } },
  });
  const counter = { calls: 0 };
  const summary = await scan(alice, counter);
  assert.deepEqual(sourcedRows(bob), []);
  assert.deepEqual(summary.sharedCache.alsoMatchedFor, []);
  assert.deepEqual(summary.sharedCache.skipped, [{ person: "bob", reason: "opted out" }]);

  const off = tempBase(t);
  const a2 = addPerson(off, "alice", { titles: ["Platform Engineer"], marker: "alice" });
  const b2 = addPerson(off, "bob", { titles: ["Product Designer"], marker: "bob" });
  const counter2 = { calls: 0 };
  writeFileSync(join(off, "shared-cache.json"), JSON.stringify({ enabled: false }));
  const first = await scan(a2, counter2);
  await scan(b2, counter2);
  assert.equal(counter2.calls, 2);
  assert.equal(first.sharedCache, undefined);
  assert.equal(existsSync(sharedCachePath(off)), false);
  assert.deepEqual(
    sourcedRows(b2).map((row) => row.role),
    ["Senior Product Designer"]
  );
  assert.ok(sourcedRows(b2).every((row) => row.source === "lever-api"));
});

test("the cache holds public posting data only", async (t) => {
  const base = tempBase(t);
  const { alice } = twoPeople(base);
  await scan(alice, { calls: 0 });
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(sharedCachePath(base));
  const tables = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
    .all()
    .map((row) => row.name);
  assert.deepEqual(tables, ["postings", "sources"]);
  const dump = JSON.stringify([
    db.prepare("SELECT * FROM postings").all(),
    db.prepare("SELECT * FROM sources").all(),
  ]);
  db.close();
  for (const forbidden of ["alice", "bob", "resume text", "@example.com", "New York"]) {
    assert.equal(dump.toLowerCase().includes(forbidden.toLowerCase()), false, forbidden);
  }
  for (const key of ["score", "fit", "gate", "ruleFlags", "ratingReason", "artifacts"]) {
    assert.equal(dump.includes(`\\"${key}\\"`), false, key);
  }
});

test("a person without a database, or without finished setup, is skipped with a note", async (t) => {
  const base = tempBase(t);
  const alice = addPerson(base, "alice", { titles: ["Platform Engineer"], marker: "alice" });
  mkdirSync(personRoot(base, "carol"), { recursive: true });
  const dan = envFor(base, "dan");
  mkdirSync(personRoot(base, "dan"), { recursive: true });
  candidateSetupInitialize({ repoRoot: REPO_ROOT, env: dan });
  const summary = await scan(alice, { calls: 0 });
  assert.deepEqual(summary.sharedCache.skipped, [
    { person: "carol", reason: "no workspace set up" },
    { person: "dan", reason: "setup not finished" },
  ]);
  assert.equal(existsSync(join(personRoot(base, "carol"), "db")), false);
  assert.deepEqual(sourcedRows(dan), []);
});

test("without any people the cache stays out of the way", async (t) => {
  const base = tempBase(t);
  const env = { CAREERRAT_HOME: base };
  candidateSetupInitialize({ repoRoot: REPO_ROOT, env });
  sourceConfigPut({
    repoRoot: REPO_ROOT,
    env,
    name: "sourced-scan",
    data: {
      title_filter: {},
      location_filter: null,
      tracked_companies: [{ name: "Acme", careers_url: "https://jobs.lever.co/acme" }],
    },
  });
  const counter = { calls: 0 };
  const summary = await scan(env, counter);
  assert.equal(summary.sharedCache, undefined);
  assert.equal(existsSync(sharedCachePath(base)), false);
});

// Cache rows written before the shared posting-identity normalizer keep their old
// url: keys until the cache migrates them. Seeds one by storing through the real
// cache, then rewriting the key and schema version the way an older build left it.
async function migrationFixture(t) {
  const base = tempBase(t);
  mkdirSync(personRoot(base, "alice"), { recursive: true });
  const env = { CAREERRAT_HOME: base };
  const { DatabaseSync } = await import("node:sqlite");
  const result = (offers) => ({ offers, errors: [], warnings: [] });
  const offer = (url, extra = {}) => ({
    company: "Acme",
    title: "Staff Engineer",
    url,
    bodyText: "body",
    ...extra,
  });
  const open = () => {
    const run = openRunCache({ repoRoot: REPO_ROOT, env });
    assert.ok(run);
    return run;
  };
  const raw = (fn) => {
    const db = new DatabaseSync(sharedCachePath(base));
    try {
      return fn(db);
    } finally {
      db.close();
    }
  };
  const store = (offers) => {
    const run = open();
    run.store("lever", { slug: "acme" }, "Acme", result(offers));
    const added = run.newPostings.length;
    run.close();
    return added;
  };
  return { open, raw, store, offer };
}

const OLD_KEY = "url:https://careers.example.com/jobs/view?z=2&id=1&utm_source=feed";
const NEW_KEY = "url:https://careers.example.com/jobs/view?id=1&z=2";

test("an old-format url key migrates, and a re-scan neither re-adds nor closes it", async (t) => {
  const { raw, store, offer } = await migrationFixture(t);
  store([offer("https://careers.example.com/jobs/view?id=1&z=2")]);
  raw((db) => {
    db.prepare(
      "UPDATE postings SET posting_key = ?, first_seen_at = '2026-01-01T00:00:00.000Z'"
    ).run(OLD_KEY);
    db.exec("PRAGMA user_version = 1");
  });

  const added = store([offer("https://careers.example.com/jobs/view?z=2&id=1&utm_source=feed")]);
  assert.equal(added, 0);
  const rows = raw((db) => db.prepare("SELECT * FROM postings").all());
  assert.equal(rows.length, 1);
  assert.equal(rows[0].posting_key, NEW_KEY);
  assert.equal(rows[0].closed, 0);
  assert.equal(rows[0].first_seen_at, "2026-01-01T00:00:00.000Z");
});

test("old rows that collide after normalization merge into one", async (t) => {
  const { open, raw, store, offer } = await migrationFixture(t);
  store([offer("https://careers.example.com/jobs/view?id=1&z=2")]);
  raw((db) => {
    const row = db.prepare("SELECT * FROM postings").get();
    db.prepare(
      "UPDATE postings SET posting_key = ?, first_seen_at = ?, closed = 1, body = ?, offer_json = ?, fetched_at = ?"
    ).run(
      "url:https://careers.example.com/jobs/view?id=1&z=2&utm_source=feed",
      "2026-01-01T00:00:00.000Z",
      "older body",
      row.offer_json,
      "2026-01-02T00:00:00.000Z"
    );
    db.prepare(
      `INSERT INTO postings (posting_key, source_key, company, title, location, comp_text, url, body,
        posted_at, offer_json, first_seen_at, fetched_at, last_seen_at, closed)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`
    ).run(
      "url:https://careers.example.com/jobs/view?z=2&id=1",
      row.source_key,
      row.company,
      row.title,
      row.location,
      row.comp_text,
      row.url,
      "newer body",
      row.posted_at,
      row.offer_json,
      "2026-02-01T00:00:00.000Z",
      "2026-02-01T00:00:00.000Z",
      "2026-02-01T00:00:00.000Z"
    );
    db.exec("PRAGMA user_version = 1");
  });

  open().close();
  const rows = raw((db) => db.prepare("SELECT * FROM postings").all());
  assert.equal(rows.length, 1);
  assert.equal(rows[0].posting_key, NEW_KEY);
  assert.equal(rows[0].first_seen_at, "2026-01-01T00:00:00.000Z");
  assert.equal(rows[0].closed, 0);
  assert.equal(rows[0].body, "newer body");
});

test("a PeopleSoft row keyed with PostingSeq=1 is the same row once a scan returns PostingSeq=2", async (t) => {
  const { raw, store, offer } = await migrationFixture(t);
  const url = (seq) =>
    `https://hr.example.edu/psc/hrprd/EMPLOYEE/HRMS/c/HRS_HRAM_FL.HRS_CG_SEARCH_FL.GBL?Page=HRS_APP_JBPST_FL&JobOpeningId=JR1&PostingSeq=${seq}&SiteId=1`;
  store([offer(url(2))]);
  raw((db) => {
    db.prepare("UPDATE postings SET posting_key = ?, url = ?").run(`url:${url(1)}`, url(1));
    db.exec("PRAGMA user_version = 2");
  });

  const added = store([offer(url(2))]);
  assert.equal(added, 0);
  assert.equal(raw((db) => db.prepare("SELECT * FROM postings").all()).length, 1);
});

test("the migration runs once and leaves non-url keys alone", async (t) => {
  const { open, raw, store, offer } = await migrationFixture(t);
  store([offer("https://careers.example.com/jobs/view?id=1", { reqId: "REQ-9" })]);
  assert.equal(
    raw((db) => db.prepare("PRAGMA user_version").get().user_version),
    3
  );
  const keyBefore = raw((db) => db.prepare("SELECT posting_key FROM postings").get().posting_key);
  assert.match(keyBefore, /^req:/);

  // A url: row planted after the version bump is not touched by a later open.
  raw((db) => {
    db.prepare(
      `INSERT INTO postings (posting_key, source_key, company, title, offer_json, first_seen_at, fetched_at, last_seen_at)
       VALUES (?, 'x', 'A', 'T', '{}', 'a', 'a', 'a')`
    ).run(OLD_KEY);
  });
  open().close();
  const keys = raw((db) =>
    db
      .prepare("SELECT posting_key FROM postings ORDER BY posting_key")
      .all()
      .map((row) => row.posting_key)
  );
  assert.deepEqual(keys, [OLD_KEY, keyBefore].sort());
});

test("migration keys from the stored URL, so an unparseable URL's case cannot split a row", async (t) => {
  const { raw, store, offer } = await migrationFixture(t);
  store([offer("/jobs/ABC")]);
  raw((db) => {
    db.prepare("UPDATE postings SET posting_key = 'url:/jobs/abc'").run();
    db.exec("PRAGMA user_version = 1");
  });

  const added = store([offer("/jobs/ABC")]);
  assert.equal(added, 0);
  const rows = raw((db) => db.prepare("SELECT * FROM postings").all());
  assert.equal(rows.length, 1);
  assert.equal(rows[0].posting_key, "url:/jobs/abc");
  assert.equal(rows[0].closed, 0);
});
