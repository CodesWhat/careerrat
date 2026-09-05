#!/usr/bin/env node
// scripts/delta-sourced.mjs — diffs two sourced-scan snapshot JSON files and
// reports which offers are new/carried/removed, flagging offers already seen
// in the tracker/DB as repo duplicates.
//
// CLI flag parsing and output formatting remain behind the import.meta.url
// entry guard, so buildRepoSeenIds (the piece a test needs in isolation) can
// be imported without also running the CLI against the test process' own
// argv (mirrors scan-sourced.mjs's/capture-search-sources.mjs's convention).
import { mkdirSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

import { dbExists } from "../src/core/db/connection.mjs";
import { buildDbSeenSets } from "../src/core/db/scan-context.mjs";
import { userPath } from "../src/core/paths/workspace.mjs";
import {
  buildOfferIdentitySet,
  diffSnapshotOffers,
  latestSnapshotPair,
  loadSnapshot,
  normalizeUrl,
  renderDeltaMarkdown,
  summarizeDelta,
} from "../src/core/scoring/sourced-delta.mjs";
import { buildSeenSets } from "../src/core/tracker/tracker-data.mjs";

// buildSeenSets's tracker.json/workspace-jobs projection only reads each
// row's link/co/role, so a persisted identity alias (added onto a canonical
// row's aliasKeys[] when a same-batch or later duplicate's OTHER
// representation was folded onto it, see sourced-identity.mjs) never reaches
// repoSeen through it, even though the alias is present in the exported row
// (CR-29 round 4). When SQLite exists, layer in buildDbSeenSets' alias-aware
// seenPostingKeys (built via identityKeysWithAliases, not the raw fields) so
// those persisted aliases participate in the repo-new check too; the legacy
// tracker.json/jobs-frontmatter builder stays the base (and the only source)
// when there is no DB.
export function buildRepoSeenIds({ repoRoot = ROOT } = {}) {
  const { seenUrls, seenReqIds } = buildSeenSets(repoRoot);
  const ids = new Set();
  for (const id of [
    ...seenReqIds,
    ...buildOfferIdentitySet([...seenUrls].map((url) => ({ url }))),
  ]) {
    if (!id) continue;
    // Preserve path and query casing for URL identities (CR-29 round 6):
    // offerIdentityKeys' own "url:" keys are only normalizeUrl-normalized
    // (strips tracking params/hash/trailing slash, see normalizeUrl below),
    // never lowercased — lowercasing them here made a case-sensitive path
    // (e.g. "/Jobs/Foo") never match an identical mixed-case snapshot URL,
    // reporting an already-persisted posting as repo-new. Requisition
    // identities (bare, unprefixed here) still lowercase; exact case never
    // carries meaning for them.
    ids.add(String(id).startsWith("url:") ? String(id) : String(id).toLowerCase());
  }
  if (dbExists({ repoRoot })) {
    const { seenPostingKeys } = buildDbSeenSets({ repoRoot });
    for (const key of seenPostingKeys) {
      if (key.startsWith("req:")) {
        ids.add(key.slice(4).toLowerCase());
        continue;
      }
      // seenPostingKeys' own "url:" keys are normalized through
      // sourced-identity.mjs's normalizePostingUrl (lowercases hostname,
      // strips hash, strips a trailing pathname slash) — NOT the same
      // normalization diffSnapshotOffers' own offerIdentityKeys applies via
      // sourced-delta's normalizeUrl (also strips utm_/trk/ref/gh_src/source
      // tracking params, and the trailing slash of the WHOLE string).
      // Without re-normalizing here, a persisted URL-only alias (e.g. a
      // HiringCafe republish this run's canonical dedupe folded onto a
      // Workday row instead of persisting as its own row) would carry a
      // tracking param diffSnapshotOffers' own key for that same offer
      // never does, so the two `url:` keys would never match and the row
      // would be reported as repo-new (CR-29 round 5).
      //
      // Do NOT lowercase the result (CR-29 round 6, unlike the req: branch
      // above): normalizeUrl only strips tracking params/hash/trailing
      // slash, it never touches casing, so offerIdentityKeys' own `url:`
      // keys for the CURRENT snapshot keep whatever path/query casing the
      // posting URL actually has. Lowercasing only THIS side made a
      // case-sensitive path (e.g. "/Jobs/Foo") never match an identical
      // mixed-case snapshot URL, reporting an already-persisted posting as
      // repo-new.
      if (key.startsWith("url:")) {
        const normalized = normalizeUrl(key.slice(4));
        if (normalized) ids.add(`url:${normalized}`);
      }
    }
  }
  return ids;
}

export function runCli(argv = process.argv.slice(2)) {
  const pathCtx = { repoRoot: ROOT };
  const source = valueAfter(argv, "--source") || "";
  let currentPath = valueAfter(argv, "--current");
  let previousPath = valueAfter(argv, "--previous");
  const format = valueAfter(argv, "--format") || "md";
  const write = argv.includes("--write");
  const repoNewOnly = argv.includes("--repo-new-only");
  const baselineOk = argv.includes("--baseline-ok") || argv.includes("--baseline");
  const outPath = valueAfter(argv, "--out");

  if (argv.includes("--help")) {
    console.log(`Usage:
  npm run delta:sourced -- --source hiringcafe
  npm run delta:sourced -- --current scan-results/current.json --previous scan-results/previous.json
  npm run delta:sourced -- --source linkedin --repo-new-only --write

Options:
  --source NAME       Pick the latest two scan-results/*.json files whose names include NAME.
  --current FILE      Current snapshot JSON. Overrides --source current selection.
  --previous FILE     Previous snapshot JSON. Overrides --source previous selection.
  --format md|json    Output format. Default: md.
  --repo-new-only     Only print offers that are new since previous and not already seen in tracker/jobs.
  --baseline-ok       With one matching snapshot, compare against an empty baseline.
  --write             Write markdown to intake/delta-<source>-<date>.md, or --out path.
  --out FILE          Explicit output file for --write.
`);
    process.exit(0);
  }

  if (!currentPath || !previousPath) {
    const pair = latestSnapshotPair({
      dir: userPath(pathCtx, "workspace/scan-results"),
      source,
      baselineOk,
    });
    currentPath ||= pair.current;
    previousPath ||= pair.previous;
  }

  const current = loadSnapshot(currentPath);
  const previous = previousPath
    ? loadSnapshot(previousPath)
    : { path: null, label: "empty baseline", generatedAt: null, offers: [], raw: {} };
  const seenIds = buildRepoSeenIds({ repoRoot: ROOT });
  let delta = diffSnapshotOffers({ current: current.offers, previous: previous.offers, seenIds });
  if (repoNewOnly) {
    delta = { ...delta, newOffers: delta.newOffers.filter((offer) => !offer.repoDuplicate) };
  }
  const summary = summarizeDelta(delta);

  if (format === "json") {
    console.log(
      JSON.stringify(
        { current: currentPath, previous: previousPath, summary, offers: delta.newOffers },
        null,
        2
      )
    );
  } else {
    const markdown = renderDeltaMarkdown({ currentPath, previousPath, delta, summary });
    if (write) {
      const intakeDir = userPath(pathCtx, "workspace/intake");
      mkdirSync(intakeDir, { recursive: true });
      const label = source || basename(currentPath).replace(/\.json$/, "");
      const out =
        outPath || join(intakeDir, `delta-${label}-${new Date().toISOString().slice(0, 10)}.md`);
      writeFileSync(out, markdown);
      console.error(`Wrote ${out}`);
    }
    console.log(markdown);
  }
}

function valueAfter(argv, flag) {
  const index = argv.indexOf(flag);
  return index === -1 ? null : argv[index + 1];
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runCli();
}
