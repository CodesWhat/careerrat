#!/usr/bin/env node
// careerrat status-map — deterministically normalize a raw ATS-portal status string
// into the tracker's canonical status, and (with --current) classify the change as
// a transition. The sync-status skill calls this so portal labels map the same way
// every time instead of being eyeballed. Read-only: prints, never writes.
//
// Usage:
//   node src/cli/status-map.mjs "<raw status>"                       normalize
//   node src/cli/status-map.mjs "<raw status>" --current <status>    classify transition
//   node src/cli/status-map.mjs "<raw status>" --json
import { normalizeAtsStatus, statusTransition } from "../core/automation/status-map.mjs";

function parseArgs(argv) {
  const opts = { positional: [], current: null, json: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--current") opts.current = argv[++i];
    else if (a === "--json") opts.json = true;
    else if (a === "--help" || a === "-h") opts.help = true;
    else opts.positional.push(a);
  }
  return opts;
}

const opts = parseArgs(process.argv.slice(2));

if (opts.help || opts.positional.length === 0) {
  console.log(`careerrat status-map: normalize a raw ATS status into the tracker vocabulary

Usage:
  node src/cli/status-map.mjs "<raw status>"                    Normalize one status
  node src/cli/status-map.mjs "<raw status>" --current <status> Classify the transition
  node src/cli/status-map.mjs "<raw status>" --json             Machine-readable

With --current, "autoApplicable" is true only for a high-confidence advance - those
are the changes the sync-status skill hands to track-outcomes. Anything else
(regress, lateral, or low-confidence) is surfaced for you to confirm.`);
  process.exit(opts.help ? 0 : 1);
}

const raw = opts.positional.join(" ");

if (opts.current != null) {
  const t = statusTransition(opts.current, raw);
  if (opts.json) {
    console.log(JSON.stringify(t, null, 2));
  } else {
    console.log(`raw:        "${raw}"`);
    console.log(`current:    ${opts.current} (stage ${t.from})`);
    console.log(`normalized: ${t.canonical} (stage ${t.to}) · ${t.confidence} confidence`);
    console.log(`transition: ${t.changed ? `${t.from} → ${t.to} (${t.direction})` : "no change"}`);
    console.log(
      t.autoApplicable
        ? "→ auto-applicable: hand to track-outcomes."
        : "→ confirm with the user before any tracker write."
    );
  }
  process.exit(0);
}

const n = normalizeAtsStatus(raw);
if (opts.json) {
  console.log(JSON.stringify(n, null, 2));
} else {
  console.log(`raw:        "${raw}"`);
  console.log(
    `normalized: ${n.canonical ?? "(empty)"}${n.stage ? ` (stage ${n.stage})` : ""} · ${n.confidence} confidence`
  );
}
process.exit(0);
