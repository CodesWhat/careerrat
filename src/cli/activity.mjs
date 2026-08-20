#!/usr/bin/env node

// careerrat activity — the safe read/append helper for the dashboard Activity Pulse feed.
//
// The Command Center's marquee panel is a reverse-chronological timeline of what the
// agent did and what happened (workspace/activity.jsonl). Skills append one event at
// the end of each action via this primitive instead of hand-writing JSONL — the same
// reason they call `careerrat gate` / `careerrat learnings` instead of editing files in
// prose. The CLI/dashboard only RENDER the feed; skills are the only writers
// (AGENTS.md → capture-is-skills-not-cli).
//
// Usage:
//   node src/cli/activity.mjs list [--limit N] [--json]
//   node src/cli/activity.mjs read [--json]
//   node src/cli/activity.mjs append --type TYPE --title "..." \
//        [--summary "..."] [--actor agent|world] [--tone info|success|warning] [--needs-user] \
//        [--company "..."] [--role "..."] [--app-id ID] [--url URL] [--cta-label "..."] \
//        [--tag X]... [--at ISO] [--id ID] [--write] [--json]
//   node src/cli/activity.mjs prune [--max N] [--write]
//   node src/cli/activity.mjs --help
//
// append is a DRY RUN by default: it canonicalizes + schema-validates the event and
// checks it for placeholder residue and a private comp leak, then prints the exact
// line that would be written - and writes nothing. Pass --write to commit (append).

import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { displayPath, userPath } from "../core/paths/workspace.mjs";
import { deriveActivityEvents } from "../core/tracker/activity-backfill.mjs";
import {
  ACTIVITY_ACTORS,
  ACTIVITY_TONES,
  ACTIVITY_TYPES,
  appendActivity,
  computeAppend,
  listActivity,
  pruneActivity,
  readActivity,
} from "../core/tracker/activity-log.mjs";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));

function parseArgs(argv) {
  const opts = { positional: [], write: false, json: false, tags: [], root: ROOT };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--write") opts.write = true;
    else if (a === "--json") opts.json = true;
    else if (a === "--needs-user") opts.needsUser = true;
    else if (a === "--help" || a === "-h") opts.help = true;
    else if (a === "--type") opts.type = argv[++i];
    else if (a === "--title") opts.title = argv[++i];
    else if (a === "--summary") opts.summary = argv[++i];
    else if (a === "--actor") opts.actor = argv[++i];
    else if (a === "--tone") opts.tone = argv[++i];
    else if (a === "--company") opts.company = argv[++i];
    else if (a === "--role") opts.role = argv[++i];
    else if (a === "--app-id") opts.appId = argv[++i];
    else if (a === "--url") opts.url = argv[++i];
    else if (a === "--skill") opts.skill = argv[++i];
    else if (a === "--operation") opts.operation = argv[++i];
    else if (a === "--cta-label") opts.ctaLabel = argv[++i];
    else if (a === "--tag") opts.tags.push(argv[++i]);
    else if (a === "--at") opts.at = argv[++i];
    else if (a === "--id") opts.id = argv[++i];
    else if (a === "--limit") opts.limit = Number(argv[++i]);
    else if (a === "--max") opts.max = Number(argv[++i]);
    else if (a === "--root") opts.root = argv[++i];
    else opts.positional.push(a);
  }
  return opts;
}

const opts = parseArgs(process.argv.slice(2));

if (opts.help || opts.positional.length === 0) {
  printHelp();
  process.exit(opts.help ? 0 : 1);
}

const [verb] = opts.positional;

switch (verb) {
  case "list":
    cmdList();
    break;
  case "read":
    cmdRead();
    break;
  case "append":
    cmdAppend();
    break;
  case "prune":
    cmdPrune();
    break;
  case "backfill":
    cmdBackfill();
    break;
  default:
    fail(`unknown command "${verb}". Commands: list, read, append, backfill, prune. See --help.`);
}

// ---------------------------------------------------------------------------

function cmdList() {
  const events = listActivity({ root: opts.root, limit: opts.limit || null });
  if (opts.json) {
    console.log(JSON.stringify({ count: events.length, events }, null, 2));
    return;
  }
  if (events.length === 0) {
    console.log("No activity yet (workspace/activity.jsonl is empty).");
    return;
  }
  console.log(`Activity (${events.length}, newest first):`);
  for (const e of events) {
    const marker = e.actor === "agent" ? "✦" : "·";
    const flag = e.needsUser ? "  ⚑ needs you" : "";
    console.log(
      `  ${marker} ${String(e.at).padEnd(24)} ${String(e.type).padEnd(13)} ${e.title}${flag}`
    );
  }
}

function cmdRead() {
  const events = readActivity({ root: opts.root });
  if (opts.json) {
    console.log(JSON.stringify({ count: events.length, events }, null, 2));
    return;
  }
  for (const e of events) console.log(JSON.stringify(e));
}

function cmdAppend() {
  const event = {
    id: opts.id,
    at: opts.at,
    type: opts.type,
    actor: opts.actor,
    title: opts.title,
    summary: opts.summary,
    tone: opts.tone,
    needsUser: opts.needsUser === true,
    tags: opts.tags,
    refs: { applicationId: opts.appId, company: opts.company, role: opts.role, url: opts.url },
    cta: opts.ctaLabel || opts.url ? { label: opts.ctaLabel, url: opts.url } : null,
    skill: opts.skill,
    operation: opts.operation,
  };

  if (!opts.type) fail("append requires --type");
  if (!opts.title) fail("append requires --title");

  const plan = computeAppend({ event });
  if (!plan.ok) {
    if (opts.json)
      console.log(JSON.stringify({ ok: false, error: plan.error, errors: plan.errors }, null, 2));
    else console.error(`activity: refused, ${plan.error}`);
    process.exit(1);
  }

  if (!opts.write) {
    if (opts.json)
      console.log(JSON.stringify({ ok: true, dryRun: true, event: plan.event }, null, 2));
    else {
      console.log("Proposed append to workspace/activity.jsonl:");
      console.log(`  | ${plan.line}`);
      console.log("");
      console.log("Dry run - pass --write to commit.");
    }
    process.exit(0);
  }

  const written = appendActivity(event, { root: opts.root });
  if (!written.ok) fail(written.error);
  if (opts.json)
    console.log(
      JSON.stringify(
        { ok: true, written: !written.deduped, deduped: written.deduped, event: written.event },
        null,
        2
      )
    );
  else
    console.log(
      written.deduped
        ? `Already present (id ${written.event.id}), no write.`
        : `Written: ${written.event.type}: ${written.event.title}`
    );
  process.exit(0);
}

function cmdPrune() {
  if (!opts.write) {
    const events = readActivity({ root: opts.root });
    const max = opts.max || 500;
    const drop = Math.max(0, events.length - max);
    if (opts.json)
      console.log(
        JSON.stringify(
          { ok: true, dryRun: true, total: events.length, max, wouldDrop: drop },
          null,
          2
        )
      );
    else
      console.log(
        `${events.length} events; cap ${max} → would drop ${drop}. Dry run - pass --write to commit.`
      );
    process.exit(0);
  }
  const res = pruneActivity({ root: opts.root, max: opts.max || 500 });
  if (opts.json) console.log(JSON.stringify(res, null, 2));
  else console.log(`Pruned: kept ${res.kept}, dropped ${res.dropped}.`);
  process.exit(0);
}

function cmdBackfill() {
  const pathCtx = { repoRoot: opts.root };
  const trackerPath = userPath(pathCtx, "workspace/tracker.json");
  if (!existsSync(trackerPath))
    fail(`no tracker at ${displayPath(pathCtx, "workspace/tracker.json")}`);
  let trackerData;
  try {
    trackerData = JSON.parse(readFileSync(trackerPath, "utf8"));
  } catch (err) {
    fail(`could not parse tracker.json: ${err.message}`);
  }
  const derived = deriveActivityEvents(trackerData, { limit: opts.limit || 60 });

  if (!opts.write) {
    const preview = derived.slice(0, 8);
    if (opts.json)
      console.log(
        JSON.stringify({ ok: true, dryRun: true, derived: derived.length, preview }, null, 2)
      );
    else {
      console.log(
        `Would derive ${derived.length} event(s) from workspace/tracker.json. First ${preview.length}:`
      );
      for (const e of preview) console.log(`  · ${e.at}  ${String(e.type).padEnd(13)} ${e.title}`);
      console.log("");
      console.log("Dry run - pass --write to commit (idempotent; re-running skips existing).");
    }
    process.exit(0);
  }

  let written = 0;
  let deduped = 0;
  const refused = [];
  // Append oldest-first so the file stays chronological (append-order = time-order),
  // matching how live skill appends accrue. `derived` is newest-first, so reverse.
  for (const event of [...derived].reverse()) {
    const res = appendActivity(event, { root: opts.root });
    if (!res.ok) refused.push({ title: event.title, error: res.error });
    else if (res.deduped) deduped += 1;
    else written += 1;
  }
  if (opts.json)
    console.log(
      JSON.stringify({ ok: true, derived: derived.length, written, deduped, refused }, null, 2)
    );
  else {
    console.log(
      `Backfill: ${written} written, ${deduped} already present${refused.length ? `, ${refused.length} refused` : ""}.`
    );
    for (const r of refused) console.error(`  refused: ${r.title}: ${r.error}`);
  }
  process.exit(0);
}

// ---------------------------------------------------------------------------

function fail(msg) {
  if (opts.json) console.log(JSON.stringify({ ok: false, error: msg }, null, 2));
  else console.error(`activity: ${msg}`);
  process.exit(1);
}

function printHelp() {
  console.log(`careerrat activity: safe read/append for the dashboard Activity Pulse feed

Usage:
  node src/cli/activity.mjs list [--limit N] [--json]
  node src/cli/activity.mjs read [--json]
  node src/cli/activity.mjs append --type TYPE --title "..." [options] [--write] [--json]
  node src/cli/activity.mjs backfill [--limit N] [--write]
  node src/cli/activity.mjs prune [--max N] [--write]

Commands:
  list      Show recent events, newest first (--limit caps).
  read      Dump the raw feed (one JSON event per line, or --json as an array).
  append    Append one event. DRY RUN by default; pass --write to commit (idempotent on id).
  backfill  Derive events from workspace/tracker.json (applied dates, inbound replies,
            status outcomes). DRY RUN by default; --write is idempotent (skips existing).
  prune     Retention rollup - keep the most recent --max events (default 500).

append options:
  --type TYPE     ${ACTIVITY_TYPES.join(" | ")}
  --title TEXT    Bold headline (required).
  --summary TEXT  One-line supporting detail.
  --actor A       ${ACTIVITY_ACTORS.join(" | ")} (default agent).
  --tone T        ${ACTIVITY_TONES.join(" | ")} (default by type).
  --needs-user    Mark as needing a human action (renders a CTA, ties to Next Steps).
  --company TEXT  --role TEXT  --app-id ID  --url URL   Click-through refs.
  --cta-label T   Custom CTA label (with --url).
  --tag X         Chip; repeat for several.
  --at ISO        Event time (default now).  --id ID  Override the derived id.
  --write         Commit (default dry run).  --json  Machine-readable output.
  --root DIR      Repo root (default: the careerrat install).

Events render on the dashboard (outbound): each is schema-validated against
config/activity-event.schema.json, checked for placeholder residue, and refused if it
would leak a private comp input (current_base). Skills are the only writers.`);
}
