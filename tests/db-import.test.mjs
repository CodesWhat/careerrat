// tests/db-import.test.mjs — importFromTracker: idempotent re-import, unknown/
// extra field + extra top-level key preservation, and activity id parity with
// activity-log.mjs's own content-hash eventId (so re-importing the same
// activity.jsonl never double-inserts).
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { closeAll, openDb } from "../src/core/db/connection.mjs";
import { importFromTracker } from "../src/core/db/import-from-tracker.mjs";
import { candidateConfigGet, sourceConfigGet } from "../src/core/db/verbs.mjs";
import { userPath } from "../src/core/paths/workspace.mjs";
import { stringifyYaml } from "../src/core/profile/yaml.mjs";
import { canonicalizeEvent, eventId } from "../src/core/tracker/activity-log.mjs";

const cleanupRoots = [];

function tempRepo() {
  const repoRoot = mkdtempSync(join(tmpdir(), "rolester-db-import-"));
  cleanupRoots.push(repoRoot);
  return repoRoot;
}

after(() => {
  closeAll();
  for (const root of cleanupRoots.splice(0)) {
    try {
      rmSync(root, { recursive: true, force: true });
    } catch {
      // best-effort cleanup
    }
  }
});

// A synthetic source fixture (distinct from examples/demo-workspace — this one
// is purpose-built to carry unknown/extra fields, an extra top-level key, and
// hand-built activity events) written to its own directory, used via
// importFromTracker's `sourceDir` option.
function writeSourceFixture(sourceDir) {
  mkdirSync(sourceDir, { recursive: true });

  const applications = [
    {
      id: "app-extra-1",
      company: "Acme",
      role: "Staff Engineer",
      status: "interview",
      fitScore: 91,
      // unknown/future field the schema doesn't model today — must survive verbatim.
      customField: "keep-me",
      nested: { future: { deeply: "nested-value" }, list: [1, 2, 3] },
    },
    {
      id: "app-extra-2",
      company: "Globex",
      role: "PM",
      status: "awaiting",
      fitScore: 70,
    },
  ];
  const sourced = [{ id: "sourced-1", company: "Initech", fitScore: 55, fitBucket: "maybe" }];
  const sources = [{ id: "source-1", provider: "HiringCafe" }];
  const communications = [
    {
      id: "comm-1",
      applicationId: "app-extra-1",
      company: "Acme",
      channel: "email",
      status: "waiting",
    },
  ];
  const meta = {
    lastUpdatedAt: "2026-01-01T00:00:00.000Z",
    version: 3,
    lastSweepAt: "2026-01-01T00:00:00.000Z",
    demoAnchor: "2026-01-02",
  };
  const strategyReview = {
    note: "extra top-level key that isn't one of the modeled tables",
    flag: true,
  };

  writeFileSync(
    join(sourceDir, "tracker.json"),
    JSON.stringify(
      { meta, applications, sourced, sources, communications, strategyReview },
      null,
      2
    )
  );

  const now = new Date("2026-01-01T12:00:00.000Z");
  const events = [
    canonicalizeEvent(
      {
        type: "applied",
        title: "Acme — Staff Engineer captured",
        refs: { applicationId: "app-extra-1" },
      },
      { now }
    ),
    canonicalizeEvent(
      {
        type: "status_change",
        title: "Acme — status applied → interview",
        refs: { applicationId: "app-extra-1" },
      },
      { now }
    ),
  ];
  writeFileSync(
    join(sourceDir, "activity.jsonl"),
    `${events.map((e) => JSON.stringify(e)).join("\n")}\n`
  );
  return { applications, sourced, sources, communications, meta, strategyReview, events };
}

function dumpDb(db) {
  const table = (name) =>
    db
      .prepare(`SELECT id, data FROM ${name} ORDER BY id ASC`)
      .all()
      .map((r) => ({ id: r.id, data: JSON.parse(r.data) }));
  const metaRow = db.prepare("SELECT * FROM meta WHERE id = 1").get();
  const kvRows = db
    .prepare("SELECT key, data FROM kv ORDER BY key ASC")
    .all()
    .map((r) => ({ key: r.key, data: JSON.parse(r.data) }));
  const activity = db
    .prepare("SELECT id, at, type, actor, data FROM activity_events ORDER BY id ASC")
    .all();
  return {
    applications: table("applications"),
    sourced: table("sourced"),
    sources: table("sources"),
    communications: table("communications"),
    meta: metaRow,
    kv: kvRows,
    activity,
  };
}

test("importFromTracker preserves unknown/extra fields on application rows verbatim", () => {
  const repoRoot = tempRepo();
  const sourceDir = join(repoRoot, "fixture-source");
  const fixture = writeSourceFixture(sourceDir);

  const result = importFromTracker({ repoRoot, sourceDir });
  assert.equal(result.counts.applications, 2);

  const db = openDb({ repoRoot });
  const row = db.prepare("SELECT data FROM applications WHERE id = ?").get("app-extra-1");
  const stored = JSON.parse(row.data);
  assert.deepEqual(stored, fixture.applications[0]);
  assert.equal(stored.customField, "keep-me");
  assert.deepEqual(stored.nested, { future: { deeply: "nested-value" }, list: [1, 2, 3] });
});

test("importFromTracker preserves an extra top-level key (not one of the modeled tables) into kv", () => {
  const repoRoot = tempRepo();
  const sourceDir = join(repoRoot, "fixture-source");
  const fixture = writeSourceFixture(sourceDir);
  importFromTracker({ repoRoot, sourceDir });

  const db = openDb({ repoRoot });
  const row = db.prepare("SELECT data FROM kv WHERE key = 'strategyReview'").get();
  assert.ok(row, "strategyReview must land in the kv table");
  assert.deepEqual(JSON.parse(row.data), fixture.strategyReview);
});

test("importFromTracker's activity ids match activity-log.mjs's own content-hash eventId()", () => {
  const repoRoot = tempRepo();
  const sourceDir = join(repoRoot, "fixture-source");
  const fixture = writeSourceFixture(sourceDir);
  const result = importFromTracker({ repoRoot, sourceDir });
  assert.equal(result.counts.activity, 2);

  const db = openDb({ repoRoot });
  const rows = db.prepare("SELECT id FROM activity_events ORDER BY id ASC").all();
  const storedIds = rows.map((r) => r.id).sort();
  const expectedIds = fixture.events
    .map((e) => eventId({ at: e.at, type: e.type, title: e.title, refs: e.refs }))
    .sort();
  assert.deepEqual(storedIds, expectedIds);
});

test("re-importing the same source is idempotent: identical DB dump, no duplicate activity rows", () => {
  const repoRoot = tempRepo();
  const sourceDir = join(repoRoot, "fixture-source");
  writeSourceFixture(sourceDir);

  importFromTracker({ repoRoot, sourceDir });
  const db = openDb({ repoRoot });
  const firstDump = dumpDb(db);

  const secondResult = importFromTracker({ repoRoot, sourceDir });
  const secondDump = dumpDb(db);

  assert.deepEqual(
    secondDump,
    firstDump,
    "re-running the same import must produce an identical DB"
  );
  // Re-import counts still report what it upserted/considered — but the
  // activity_events table itself must not have grown (PK conflict = dedupe).
  assert.equal(secondResult.counts.activity <= 2, true);
  const activityCount = db.prepare("SELECT COUNT(*) AS n FROM activity_events").get().n;
  assert.equal(activityCount, 2, "no double-insert on re-import");
});

test("examples/demo-workspace imports cleanly and twice produces an identical DB", () => {
  const repoRoot = tempRepo();
  const demoDir = join(new URL("../examples/demo-workspace", import.meta.url).pathname);

  const first = importFromTracker({ repoRoot, sourceDir: demoDir });
  assert.equal(first.counts.applications, 29);
  // examples/demo-workspace/tracker.json was enriched in 2a9bf4c (stage-tiered
  // demo artifact packages): sourced grew from 2 -> 9 and communications from
  // 10 -> 29. sources (1) was untouched.
  assert.equal(first.counts.sourced, 9);
  assert.equal(first.counts.sources, 1);
  assert.equal(first.counts.communications, 29);

  const db = openDb({ repoRoot });
  const firstDump = dumpDb(db);

  importFromTracker({ repoRoot, sourceDir: demoDir });
  const secondDump = dumpDb(db);

  assert.deepEqual(
    secondDump,
    firstDump,
    "re-importing the demo workspace must be a no-op on the DB contents"
  );
});

test("importFromTracker migrates legacy candidate YAML into canonical SQLite setup tables", () => {
  const repoRoot = tempRepo();
  const sourceDir = join(repoRoot, "fixture-source");
  writeSourceFixture(sourceDir);
  mkdirSync(join(repoRoot, "candidate"), { recursive: true });
  writeFileSync(
    join(repoRoot, "candidate/profile.yml"),
    `${stringifyYaml({
      candidate: { full_name: "Legacy Candidate", email: "legacy@example.com" },
      compensation: { minimum_base: 181234, target_base: 223456 },
      location: { home: "Austin, TX", remote: true, hybrid: false, onsite: false },
      authorization: { work_authorized: true, requires_sponsorship: false },
    })}\n`
  );
  writeFileSync(
    join(repoRoot, "candidate/targeting.yml"),
    `${stringifyYaml({
      role_buckets: [{ name: "AI Platform", titles: ["AI Platform Engineer"] }],
      keep_signals: ["agentic systems"],
      cut_signals: ["onsite-only"],
      tracked_companies: ["OpenAI", "Anthropic"],
      excluded_companies: ["BadCo"],
    })}\n`
  );
  writeFileSync(
    join(repoRoot, "candidate/evidence.yml"),
    `${stringifyYaml({
      claims: [{ id: "legacy-001", claim: "Built a ranking system", evidence: "Resume" }],
    })}\n`
  );
  writeFileSync(
    join(repoRoot, "candidate/modes.yml"),
    `${stringifyYaml({
      usage_mode: "lean",
      application_mode: "selective",
      agent_voice: "exec-summary",
    })}\n`
  );
  writeFileSync(
    join(repoRoot, "candidate/application-limits.yml"),
    `companies:
  - company: OpenAI
    scope: all-roles
    cap: { max: 4, window_days: 180 }
    status: caution
    source: careers FAQ
`
  );

  const result = importFromTracker({ repoRoot, sourceDir });

  assert.equal(result.counts.candidate.profile, true);
  assert.equal(result.counts.candidate.targeting, true);
  assert.equal(result.counts.candidate.evidence, 1);
  assert.equal(result.counts.candidate.modes, true);
  assert.equal(result.counts.candidate["application-limits"], true);
  const config = candidateConfigGet({ repoRoot });
  assert.equal(config.profile.candidate.full_name, "Legacy Candidate");
  assert.equal(config.profile.compensation.minimum_base, 181234);
  assert.equal(config.targeting.role_buckets[0].titles[0], "AI Platform Engineer");
  assert.deepEqual(config.targeting.tracked_companies, ["OpenAI", "Anthropic"]);
  assert.equal(config.evidence.claims[0].id, "legacy-001");
  assert.equal(config.modes.usage_mode, "lean");
  assert.equal(config["application-limits"].companies[0].company, "OpenAI");
  assert.deepEqual(config["application-limits"].companies[0].cap, {
    max: 4,
    window_days: 180,
  });
  assert.equal(
    existsSync(userPath({ repoRoot }, "candidate/profile.yml")),
    true,
    "legacy YAML remains as import source, but DB is now canonical"
  );
});

test("importFromTracker migrates legacy source config files into SQLite idempotently", () => {
  const repoRoot = tempRepo();
  const sourceDir = join(repoRoot, "fixture-source");
  writeSourceFixture(sourceDir);
  mkdirSync(join(repoRoot, "config"), { recursive: true });
  writeFileSync(
    join(repoRoot, "config/search-sources.yml"),
    `${stringifyYaml({
      searches: [
        {
          provider: "HiringCafe",
          label: "Applied AI",
          query: "applied AI engineer",
          enabled: true,
          recency: { lastRunAt: "2026-07-03T12:00:00.000Z" },
        },
      ],
    })}\n`
  );
  writeFileSync(
    join(repoRoot, "config/sourced-scan.json"),
    JSON.stringify(
      {
        title_filter: { positive: [], negative: [] },
        location_filter: null,
        tracked_companies: [{ name: "Acme", careers_url: "https://jobs.lever.co/acme" }],
      },
      null,
      2
    )
  );

  const first = importFromTracker({ repoRoot, sourceDir });
  assert.equal(first.counts.sourceConfigs["search-sources"], true);
  assert.equal(first.counts.sourceConfigs["sourced-scan"], true);

  const searchSources = sourceConfigGet({ repoRoot, name: "search-sources" });
  const sourcedScan = sourceConfigGet({ repoRoot, name: "sourced-scan" });
  assert.equal(searchSources.stored, true);
  assert.equal(searchSources.data.searches[0].query, "applied AI engineer");
  assert.equal(sourcedScan.stored, true);
  assert.equal(sourcedScan.data.tracked_companies[0].name, "Acme");

  const second = importFromTracker({ repoRoot, sourceDir });
  assert.equal(second.counts.sourceConfigs["search-sources"], true);
  assert.equal(second.counts.sourceConfigs["sourced-scan"], true);

  const db = openDb({ repoRoot });
  const count = db.prepare("SELECT COUNT(*) AS n FROM candidate_source_configs").get().n;
  assert.equal(count, 2, "re-import must upsert source configs, not duplicate them");
});
