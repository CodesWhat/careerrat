// verbs/posting-sightings.mjs — cross-scan memory of postings (migration 021).
import { requireDb } from "../connection.mjs";
import { withTransaction } from "../transaction.mjs";

function iso(now) {
  return (now instanceof Date ? now : new Date(now ?? Date.now())).toISOString();
}

// Map of key -> { seenCount, firstSeen, lastSeen, urlCount, lastUrl }.
export function postingSightingsLoad({ repoRoot, env, keys } = {}) {
  const db = requireDb({ repoRoot, env });
  const wanted = keys ? new Set(keys) : null;
  const out = new Map();
  for (const row of db.prepare("SELECT * FROM posting_sightings").all()) {
    if (wanted && !wanted.has(row.key)) continue;
    out.set(row.key, {
      seenCount: row.scan_count,
      firstSeen: row.first_seen_at,
      lastSeen: row.last_seen_at,
      urlCount: row.url_count,
      lastUrl: row.last_url,
    });
  }
  return out;
}

// entries: [{ key, url }]. One scan counts a key once.
export function postingSightingsRecord({ repoRoot, env, entries, now = new Date() } = {}) {
  const db = requireDb({ repoRoot, env });
  const at = iso(now);
  const seen = new Map();
  for (const entry of entries || []) {
    if (entry?.key && !seen.has(entry.key)) seen.set(entry.key, entry.url || null);
  }
  withTransaction(db, () => {
    const stmt = db.prepare(
      `INSERT INTO posting_sightings (key, first_seen_at, last_seen_at, scan_count, url_count, last_url)
       VALUES (?, ?, ?, 1, 1, ?)
       ON CONFLICT(key) DO UPDATE SET
         last_seen_at = excluded.last_seen_at,
         scan_count = scan_count + 1,
         url_count = url_count + (CASE WHEN excluded.last_url IS NOT NULL
           AND (posting_sightings.last_url IS NULL OR posting_sightings.last_url <> excluded.last_url)
           THEN 1 ELSE 0 END),
         last_url = COALESCE(excluded.last_url, posting_sightings.last_url)`
    );
    for (const [key, url] of seen) stmt.run(key, at, at, url);
  });
  return seen.size;
}
