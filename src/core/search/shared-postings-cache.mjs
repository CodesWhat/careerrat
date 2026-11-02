// shared-postings-cache.mjs — one operator-level cache of PUBLIC job postings, so
// a board is fetched once and every person CareerRat runs for gets matched.
//
// The cache lives at <people base>/postings-cache.db, next to the people/ directory
// and outside any one person's workspace. It stores only what a job board
// publishes (company, title, location, comp text, body, posted date, URL) plus
// our own fetch bookkeeping. Scores, fit, gates, notes and anything else derived
// from a person's profile never go in; storeable offers are scrubbed on the way in.
//
// Two jobs:
//   1. Fetch reuse. A source another person's scan fetched cleanly inside the
//      freshness window is read from here instead of refetched.
//   2. Cross-matching. Postings a scan adds to the cache for the first time are run
//      through every other ready person's OWN filters and saved into THEIR workspace
//      with provenance "shared-cache". That runs through the normal scan pipeline
//      (see crossMatchNewPostings), so dedupe, caps and the canonical writer are
//      the same ones their own scans use.
//
// Settings: <base>/shared-cache.json { "enabled": true, "freshnessHours": 6 }, or
// CAREERRAT_SHARED_CACHE=off and CAREERRAT_SHARED_CACHE_HOURS. A person opts out of
// receiving cross-matches with targeting search_preferences.shared_cache.receive=false.
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { dbExists } from "../db/connection.mjs";
import { currentPerson, listPersonNames, peopleBase, personEnv } from "../paths/people.mjs";
import { listPeople } from "../people/roster.mjs";
import { loadCandidateConfig } from "../profile/config-store.mjs";
import { postingIdentityKeys } from "../scoring/sourced-identity.mjs";

export const SHARED_CACHE_DB = "postings-cache.db";
export const SHARED_CACHE_SETTINGS = "shared-cache.json";
export const SHARED_CACHE_PROVENANCE = "shared-cache";
export const DEFAULT_FRESHNESS_HOURS = 6;
const SCHEMA_VERSION = 1;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS sources (
  source_key   TEXT PRIMARY KEY,
  kind         TEXT NOT NULL,
  label        TEXT,
  fetched_at   TEXT NOT NULL,
  offer_count  INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS postings (
  posting_key   TEXT NOT NULL,
  source_key    TEXT NOT NULL,
  company       TEXT NOT NULL,
  title         TEXT NOT NULL,
  location      TEXT,
  comp_text     TEXT,
  url           TEXT,
  body          TEXT,
  posted_at     TEXT,
  offer_json    TEXT NOT NULL,
  first_seen_at TEXT NOT NULL,
  fetched_at    TEXT NOT NULL,
  last_seen_at  TEXT NOT NULL,
  closed        INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (posting_key, source_key)
);
CREATE INDEX IF NOT EXISTS postings_by_source ON postings (source_key, closed);
`;

// Fields a scan adds from one person's profile and history. None may reach the cache.
const PERSON_DERIVED_FIELDS = new Set([
  "score",
  "fit",
  "gate",
  "ratingReason",
  "ruleFlags",
  "artifacts",
  "liveness",
  "qualificationKind",
  "qualificationReason",
  "qualificationUnknowns",
  "duplicateReason",
  "possibleDuplicate",
  "aliasKeys",
  "familyOutcomes",
  "aiRerank",
  "note",
  "notes",
  "status",
]);

// Config fields that describe how one person tracks a source, not what it fetches.
const SOURCE_KEY_IGNORED = new Set([
  "lastRunAt",
  "recency",
  "enabled",
  "label",
  "name",
  "notes",
  "note",
  "priority",
  "tags",
  "addedAt",
  "added_at",
  "discoveredAt",
  "discovered_at",
]);

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .filter((key) => !SOURCE_KEY_IGNORED.has(key))
        .sort()
        .map((key) => [key, stable(value[key])])
    );
  }
  return value;
}

export function sharedSourceKey(kind, entry) {
  const digest = createHash("sha256")
    .update(JSON.stringify(stable(entry || {})))
    .digest("hex")
    .slice(0, 24);
  return `${kind}:${digest}`;
}

export function sharedPostingKey(offer) {
  const keys = postingIdentityKeys(offer);
  return keys.find((key) => key.startsWith("req:")) || keys[0] || null;
}

export function scrubOfferForCache(offer) {
  const { bodyText, ...rest } = offer;
  const scrubbed = {};
  for (const [key, value] of Object.entries(rest)) {
    if (PERSON_DERIVED_FIELDS.has(key) || value === undefined) continue;
    scrubbed[key] = value;
  }
  return { scrubbed, body: typeof bodyText === "string" ? bodyText : null };
}

export function sharedCachePath(base) {
  return join(base, SHARED_CACHE_DB);
}

export function readSharedCacheSettings({ base, env = process.env } = {}) {
  let enabled = true;
  let freshnessHours = DEFAULT_FRESHNESS_HOURS;
  const file = join(base, SHARED_CACHE_SETTINGS);
  if (existsSync(file)) {
    try {
      const parsed = JSON.parse(readFileSync(file, "utf8"));
      if (parsed?.enabled === false) enabled = false;
      const hours = Number(parsed?.freshnessHours);
      if (Number.isFinite(hours) && hours > 0) freshnessHours = hours;
    } catch {
      // A broken settings file leaves the defaults; it must not break a scan.
    }
  }
  const flag = String(env.CAREERRAT_SHARED_CACHE || "")
    .trim()
    .toLowerCase();
  if (["off", "0", "false", "no"].includes(flag)) enabled = false;
  const envHours = Number(env.CAREERRAT_SHARED_CACHE_HOURS);
  if (Number.isFinite(envHours) && envHours > 0) freshnessHours = envHours;
  return { enabled, freshnessHours, freshnessMs: freshnessHours * 3600000 };
}

export function openSharedCacheDb(base) {
  mkdirSync(base, { recursive: true, mode: 0o700 });
  const path = sharedCachePath(base);
  const created = !existsSync(path);
  const db = new DatabaseSync(path);
  db.exec("PRAGMA busy_timeout = 5000");
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA synchronous = NORMAL");
  db.exec(SCHEMA);
  db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
  if (created) {
    try {
      chmodSync(path, 0o600);
    } catch {
      // Best effort; the base directory is already private.
    }
  }
  return db;
}

// A fetch result is only cacheable when it is complete: no errors, no truncation
// warnings, no login wall. Anything else says nothing reliable about the board.
export function isCacheableResult(result) {
  return (
    Array.isArray(result?.offers) &&
    (result.errors || []).length === 0 &&
    (result.warnings || []).length === 0 &&
    !result.needsLogin
  );
}

export function createSharedCache(db) {
  const selectSource = db.prepare("SELECT fetched_at FROM sources WHERE source_key = ?");
  const selectOffers = db.prepare(
    "SELECT offer_json, body FROM postings WHERE source_key = ? AND closed = 0 ORDER BY rowid"
  );
  const selectKnown = db.prepare("SELECT 1 AS known FROM postings WHERE posting_key = ? LIMIT 1");
  const upsertPosting = db.prepare(`
    INSERT INTO postings (posting_key, source_key, company, title, location, comp_text, url, body,
      posted_at, offer_json, first_seen_at, fetched_at, last_seen_at, closed)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)
    ON CONFLICT (posting_key, source_key) DO UPDATE SET
      company = excluded.company, title = excluded.title, location = excluded.location,
      comp_text = excluded.comp_text, url = excluded.url, body = excluded.body,
      posted_at = excluded.posted_at, offer_json = excluded.offer_json,
      fetched_at = excluded.fetched_at, last_seen_at = excluded.last_seen_at, closed = 0
  `);
  const closeUnseen = db.prepare(
    "UPDATE postings SET closed = 1 WHERE source_key = ? AND last_seen_at <> ? AND closed = 0"
  );
  const upsertSource = db.prepare(`
    INSERT INTO sources (source_key, kind, label, fetched_at, offer_count) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT (source_key) DO UPDATE SET kind = excluded.kind, label = excluded.label,
      fetched_at = excluded.fetched_at, offer_count = excluded.offer_count
  `);

  return {
    db,
    // Cached offers for a source fetched inside the window, or null.
    lookup(sourceKey, { now = new Date(), freshnessMs }) {
      const row = selectSource.get(sourceKey);
      if (!row) return null;
      const age = now.getTime() - Date.parse(row.fetched_at);
      if (!Number.isFinite(age) || age < 0 || age > freshnessMs) return null;
      const offers = selectOffers.all(sourceKey).map((entry) => {
        const offer = JSON.parse(entry.offer_json);
        return entry.body === null ? offer : { ...offer, bodyText: entry.body };
      });
      return { fetchedAt: row.fetched_at, offers };
    },
    // Replace one source's postings with a complete fresh fetch. Postings that
    // dropped off the board are marked closed. Returns the offers whose posting
    // key no source had stored before (the ones other people haven't seen).
    record({ sourceKey, kind, label, offers, now = new Date() }) {
      const stamp = now.toISOString();
      const added = [];
      const addedKeys = new Set();
      db.exec("BEGIN IMMEDIATE");
      try {
        for (const offer of offers) {
          const key = sharedPostingKey(offer);
          if (!key || !offer.company || !offer.title) continue;
          const known = selectKnown.get(key);
          const { scrubbed, body } = scrubOfferForCache(offer);
          upsertPosting.run(
            key,
            sourceKey,
            String(offer.company),
            String(offer.title),
            offer.location == null ? null : String(offer.location),
            String(offer.compensation ?? offer.salary ?? offer.comp ?? ""),
            offer.url == null ? null : String(offer.url),
            body,
            offer.postedAt == null || offer.postedAt === "" ? null : String(offer.postedAt),
            JSON.stringify(scrubbed),
            stamp,
            stamp,
            stamp
          );
          if (!known && !addedKeys.has(key)) {
            addedKeys.add(key);
            added.push(offer);
          }
        }
        closeUnseen.run(sourceKey, stamp);
        upsertSource.run(
          sourceKey,
          kind,
          label ? String(label).slice(0, 160) : null,
          stamp,
          offers.length
        );
        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
      return { added };
    },
    close() {
      try {
        db.close();
      } catch {
        // Already closed.
      }
    },
  };
}

// Per-scan view of the cache: applies the freshness window, keeps the counters
// the scan summary reports, and collects the postings new to the cache.
export function createRunCache({ cache, base, settings, now = new Date(), bypassReads = false }) {
  const stats = { hits: 0, fetched: 0, stored: 0, storeErrors: 0 };
  const newPostings = [];
  return {
    base,
    settings,
    stats,
    newPostings,
    lookup(kind, entry) {
      if (bypassReads) return null;
      try {
        const hit = cache.lookup(sharedSourceKey(kind, entry), {
          now,
          freshnessMs: settings.freshnessMs,
        });
        if (!hit) return null;
        stats.hits += 1;
        return { offers: hit.offers, errors: [], warnings: [], cacheHit: true };
      } catch {
        return null;
      }
    },
    store(kind, entry, label, result) {
      stats.fetched += 1;
      if (!isCacheableResult(result)) return;
      try {
        const { added } = cache.record({
          sourceKey: sharedSourceKey(kind, entry),
          kind,
          label,
          offers: result.offers,
          now: new Date(),
        });
        stats.stored += 1;
        newPostings.push(...added);
      } catch {
        stats.storeErrors += 1; // The cache is an aid, never a gate.
      }
    },
    close: () => cache.close(),
  };
}

// The run cache for a scan, or null when sharing is off or pointless. With no
// people registered and no person selected there is nobody to share with, so a
// single-user workspace behaves exactly as it did before the cache existed.
export function openRunCache({ repoRoot, env = process.env, bypassReads = false, now } = {}) {
  try {
    const base = peopleBase({ repoRoot, env });
    const settings = readSharedCacheSettings({ base, env });
    if (!settings.enabled) return null;
    if (!currentPerson(env) && listPersonNames(base).length === 0) return null;
    return createRunCache({
      cache: createSharedCache(openSharedCacheDb(base)),
      base,
      settings,
      bypassReads,
      now,
    });
  } catch {
    return null;
  }
}

function receivesCrossMatches(personEnvValues, repoRoot) {
  try {
    const config = loadCandidateConfig({ repoRoot, env: personEnvValues });
    return config?.targeting?.search_preferences?.shared_cache?.receive !== false;
  } catch {
    return true;
  }
}

// Runs every other person's own scan pipeline over postings new to the cache.
// `runScan` is the scan entry point, called with that person's env and the
// postings tagged with the shared-cache provenance; it saves into THEIR
// workspace only. Returns what the originating scan may show: counts per
// person, never anything else about them.
export async function crossMatchNewPostings({
  repoRoot,
  env = process.env,
  postings,
  runScan,
  assertActive,
}) {
  const base = peopleBase({ repoRoot, env });
  const self = currentPerson(env);
  const alsoMatchedFor = [];
  const skipped = [];
  const tagged = postings.map((offer) => ({
    ...offer,
    source: SHARED_CACHE_PROVENANCE,
  }));
  for (const person of listPeople({ repoRoot, env })) {
    if (person.name === self) continue;
    assertActive?.();
    const values = personEnv({ repoRoot, env, name: person.name });
    const scanEnv = { ...env, ...values };
    if (!dbExists({ repoRoot, env: scanEnv })) {
      skipped.push({ person: person.name, reason: "no workspace set up" });
      continue;
    }
    if (!person.ready) {
      skipped.push({ person: person.name, reason: "setup not finished" });
      continue;
    }
    if (!receivesCrossMatches(scanEnv, repoRoot)) {
      skipped.push({ person: person.name, reason: "opted out" });
      continue;
    }
    try {
      const result = await runScan({ env: scanEnv, offers: tagged });
      alsoMatchedFor.push({
        person: person.name,
        count: Number(result?.new) || 0,
      });
    } catch (error) {
      skipped.push({
        person: person.name,
        reason: `scan failed: ${error.message}`,
      });
    }
  }
  return { base, alsoMatchedFor, skipped };
}
