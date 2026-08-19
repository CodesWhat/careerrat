#!/usr/bin/env node

// careerrat stories — the safe read/validate/add helper for the STAR+R story bank.
//
// The story bank (candidate/stories.yml) is the behavioural-narrative layer over
// evidence.yml: candidate-owned STAR+R stories that interview-prep assembles into
// packets and reuses across interview loops (see AGENTS.md → Story Bank). Skills
// call this instead of hand-editing the YAML, for the same reason they call
// `careerrat gate` / `careerrat learnings`: one validator, one write path, one firewall.
//
// Every story must trace to candidate/evidence.yml — `add` and `check` refuse a
// story that cites no evidence, cites a claim id that doesn't exist, is missing a
// STAR+R field, carries placeholder residue, or leaks a private comp input.
//
// Usage:
//   node src/cli/stories.mjs list [--json]
//   node src/cli/stories.mjs path [--json]
//   node src/cli/stories.mjs check [--json]
//   node src/cli/stories.mjs gaps [--competencies "a,b,c"] [--json]
//   node src/cli/stories.mjs match <jd-file.md.json> | --signals "a,b,c" [--competencies "..."] [--limit N] [--json]
//   node src/cli/stories.mjs add --file FILE [--write] [--json]
//   node src/cli/stories.mjs sync-enrichment [--write] [--json]
//   node src/cli/stories.mjs --help
//
// `add` is a DRY RUN by default: it validates the story (firewall) and prints what
// would be written, changing nothing. Pass --write to commit (atomic upsert by id).

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { dbExists } from "../core/db/connection.mjs";
import { kvGet, kvUpsert } from "../core/db/verbs.mjs";
import {
  COMMON_COMPETENCIES,
  computeStoryEnrichment,
  computeStoryWrite,
  coverageGaps,
  loadStories,
  matchStories,
  STORIES_REL_PATH,
  summarizeStories,
  validateStories,
  writeStories,
} from "../core/interview/story-bank.mjs";
import { displayPath, userPath } from "../core/paths/workspace.mjs";
import { loadCandidateDoc } from "../core/profile/config-store.mjs";
import { formatErrors, validate } from "../core/profile/schema-validator.mjs";
import { parseYaml } from "../core/profile/yaml.mjs";
import { writeTrackerJson } from "../core/tracker/tracker-writer.mjs";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));

function parseArgs(argv) {
  const opts = { positional: [], write: false, json: false, root: ROOT };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--write") opts.write = true;
    else if (a === "--json") opts.json = true;
    else if (a === "--help" || a === "-h") opts.help = true;
    else if (a === "--file") opts.file = argv[++i];
    else if (a === "--signals") opts.signals = argv[++i];
    else if (a === "--competencies") opts.competencies = argv[++i];
    else if (a === "--limit") opts.limit = parseInt(argv[++i], 10);
    else if (a === "--root") opts.root = argv[++i];
    else opts.positional.push(a);
  }
  return opts;
}

const opts = parseArgs(process.argv.slice(2));
const pathCtx = { repoRoot: opts.root };
const storiesDisplay = () => displayPath(pathCtx, STORIES_REL_PATH);

if (opts.help || opts.positional.length === 0) {
  printHelp();
  process.exit(opts.help ? 0 : 1);
}

const [verb, ...rest] = opts.positional;

// Load evidence.yml claims (the trace target). Absent → empty, with a note.
function loadEvidence() {
  const path = userPath(pathCtx, "candidate/evidence.yml");
  try {
    const data = loadCandidateDoc("evidence", pathCtx);
    if (!data) return { claims: [], path, exists: false };
    return { claims: Array.isArray(data.claims) ? data.claims : [], path, exists: true };
  } catch (err) {
    return { claims: [], path, exists: true, error: err.message };
  }
}

function splitList(s) {
  return String(s || "")
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);
}

switch (verb) {
  case "list":
    cmdList();
    break;
  case "path":
    cmdPath();
    break;
  case "check":
    cmdCheck();
    break;
  case "gaps":
    cmdGaps();
    break;
  case "match":
    cmdMatch(rest);
    break;
  case "add":
    cmdAdd();
    break;
  case "sync-enrichment":
    cmdSyncEnrichment();
    break;
  default:
    fail(
      `unknown command "${verb}". Commands: list, path, check, gaps, match, add, sync-enrichment. See --help.`
    );
}

// ---------------------------------------------------------------------------

function cmdList() {
  const { exists, stories } = loadStories({ root: opts.root });
  const items = summarizeStories(stories);
  if (opts.json) {
    console.log(JSON.stringify({ exists, count: items.length, stories: items }, null, 2));
    return;
  }
  if (!exists) {
    console.log(
      `No story bank yet (${storiesDisplay()}). Draft stories from candidate/evidence.yml via interview-prep.`
    );
    return;
  }
  if (items.length === 0) {
    console.log(`Story bank is empty (${storiesDisplay()}).`);
    return;
  }
  console.log(`Story bank (${items.length}):`);
  for (const s of items) {
    const tags = s.competencies.length ? `  [${s.competencies.join(", ")}]` : "";
    console.log(`  ${String(s.id).padEnd(24)} ${s.title}${tags}`);
    console.log(`  ${" ".repeat(24)} evidence: ${s.evidence_ids.join(", ") || "(none!)"}`);
  }
}

function cmdPath() {
  const { exists, stories } = loadStories({ root: opts.root });
  const result = { relPath: storiesDisplay(), exists, count: stories.length };
  if (opts.json) console.log(JSON.stringify(result, null, 2));
  else
    console.log(
      `${storiesDisplay()}${exists ? ` (${stories.length} stor${stories.length === 1 ? "y" : "ies"})` : " (not created yet)"}`
    );
}

function cmdCheck() {
  const { exists, stories, data } = loadStories({ root: opts.root });
  if (!exists) {
    if (opts.json)
      console.log(JSON.stringify({ ok: true, exists: false, note: "no story bank yet" }, null, 2));
    else console.error(`No story bank yet (${storiesDisplay()}). Nothing to check.`);
    process.exit(0);
  }

  // Structural schema validation (best-effort; the firewall below is authoritative).
  const schemaErrors = [];
  const schemaPath = join(opts.root, "config/stories.schema.json");
  if (existsSync(schemaPath)) {
    try {
      const schema = JSON.parse(readFileSync(schemaPath, "utf8"));
      const res = validate(data, schema);
      if (!res.valid) schemaErrors.push(...res.errors);
    } catch {
      /* ignore schema read errors — firewall still runs */
    }
  }

  const ev = loadEvidence();
  const v = validateStories(stories, ev.claims);
  const ok = v.ok && schemaErrors.length === 0;

  if (opts.json) {
    console.log(
      JSON.stringify(
        { ok, count: stories.length, evidenceLoaded: ev.exists, errors: v.errors, schemaErrors },
        null,
        2
      )
    );
    process.exit(ok ? 0 : 1);
  }

  if (!ev.exists)
    console.error("note: candidate/evidence.yml not found, evidence-id existence not verified.");
  if (schemaErrors.length > 0) {
    console.error(`Schema errors in ${storiesDisplay()}:`);
    console.error(formatErrors(schemaErrors));
  }
  if (!v.ok) {
    console.error(`Story bank firewall: ${v.errors.length} issue(s):`);
    for (const e of v.errors) console.error(`  - ${e.message}`);
  }
  if (ok)
    console.log(
      `Story bank OK: ${stories.length} stor${stories.length === 1 ? "y" : "ies"}, all tracing to evidence.yml.`
    );
  process.exit(ok ? 0 : 1);
}

function cmdGaps() {
  const { stories } = loadStories({ root: opts.root });
  const competencies = opts.competencies ? splitList(opts.competencies) : COMMON_COMPETENCIES;
  const gaps = coverageGaps({ stories, competencies });
  if (opts.json) {
    console.log(
      JSON.stringify(
        { competencies, covered: competencies.filter((c) => !gaps.includes(c)), gaps },
        null,
        2
      )
    );
    return;
  }
  if (gaps.length === 0) {
    console.log(`All ${competencies.length} competencies have at least one story. No gaps.`);
    return;
  }
  console.log(`Uncovered competencies (${gaps.length}/${competencies.length}), no story yet:`);
  for (const g of gaps) console.log(`  - ${g}`);
  console.log("");
  console.log(
    "Draft a story for each from candidate/evidence.yml via interview-prep, then `careerrat stories add`."
  );
}

function cmdMatch(rest) {
  const { stories } = loadStories({ root: opts.root });
  let jobSignals = [];
  const jdArg = rest.join(" ").trim();
  if (opts.signals) {
    jobSignals = splitList(opts.signals);
  } else if (jdArg) {
    const path = existsSync(jdArg) ? jdArg : join(opts.root, jdArg);
    if (!existsSync(path)) fail(`JD file not found: ${jdArg}`);
    try {
      const job = JSON.parse(readFileSync(path, "utf8"));
      jobSignals = Array.isArray(job.signals) ? job.signals : [];
    } catch (err) {
      fail(`could not read JD signals from ${jdArg}: ${err.message}`);
    }
  } else {
    fail('match needs a <jd-file.md.json> or --signals "a,b,c".');
  }
  const competencies = opts.competencies ? splitList(opts.competencies) : [];
  const limit = Number.isInteger(opts.limit) ? opts.limit : 6;
  const matched = matchStories({ stories, jobSignals, competencies, limit });

  if (opts.json) {
    console.log(
      JSON.stringify(
        {
          jobSignals,
          competencies,
          matched: matched.map((m) => ({
            id: m.story.id,
            title: m.story.title,
            score: m.score,
            matchedSignals: m.matchedSignals,
            matchedComps: m.matchedComps,
          })),
        },
        null,
        2
      )
    );
    return;
  }
  if (matched.length === 0) {
    console.log(
      "No stories matched these signals. `careerrat stories gaps` shows what's uncovered."
    );
    return;
  }
  console.log(`Matched stories (${matched.length}):`);
  for (const m of matched) {
    console.log(`  [${m.score}] ${m.story.id}: ${m.story.title}`);
    if (m.matchedSignals.length) console.log(`        signals: ${m.matchedSignals.join(", ")}`);
    if (m.matchedComps.length) console.log(`        competencies: ${m.matchedComps.join(", ")}`);
  }
}

function cmdAdd() {
  if (!opts.file) fail("add requires --file FILE (a YAML story fragment).");
  const p = existsSync(opts.file) ? opts.file : join(opts.root, opts.file);
  if (!existsSync(p)) fail(`--file not found: ${opts.file}`);

  let parsed;
  try {
    parsed = parseYaml(readFileSync(p, "utf8"));
  } catch (err) {
    fail(`could not parse story file: ${err.message}`);
  }
  // Accept either a bare story mapping or { stories: [ ... ] } with one story.
  const newStory = parsed && Array.isArray(parsed.stories) ? parsed.stories[0] : parsed;
  if (!newStory || typeof newStory !== "object") fail("story file has no story mapping.");

  const ev = loadEvidence();
  const { stories: currentStories } = loadStories({ root: opts.root });
  const plan = computeStoryWrite({ newStory, currentStories, evidence: ev.claims });

  if (!plan.ok) {
    if (opts.json)
      console.log(JSON.stringify({ ok: false, error: plan.error, errors: plan.errors }, null, 2));
    else console.error(`stories: refused, ${plan.error}`);
    process.exit(1);
  }

  if (!opts.write) {
    if (opts.json) {
      console.log(
        JSON.stringify(
          {
            ok: true,
            dryRun: true,
            id: plan.story.id,
            replaced: plan.replaced,
            count: plan.nextStories.length,
          },
          null,
          2
        )
      );
    } else {
      console.log(
        `Proposed ${plan.replaced ? "update" : "add"}: story "${plan.story.id}": ${plan.story.title}`
      );
      console.log(`  evidence: ${(plan.story.evidence_ids || []).join(", ")}`);
      console.log(
        `  bank would hold ${plan.nextStories.length} stor${plan.nextStories.length === 1 ? "y" : "ies"} (${storiesDisplay()}).`
      );
      console.log("");
      console.log("Dry run - pass --write to commit.");
    }
    process.exit(0);
  }

  const written = writeStories({ stories: plan.nextStories, root: opts.root });
  // Mirror open_questions into tracker.storyEnrichment so the dashboard raises a
  // self-clearing "give me more context" action for any story banked thin.
  const sync = runEnrichmentSync({ write: true });
  if (opts.json)
    console.log(
      JSON.stringify(
        {
          ok: true,
          written: true,
          id: plan.story.id,
          replaced: plan.replaced,
          count: written.count,
          relPath: written.relPath,
          enrichment: sync,
        },
        null,
        2
      )
    );
  else {
    console.log(
      `Written to ${written.relPath}: story "${plan.story.id}" ${plan.replaced ? "updated" : "added"} (${written.count} total).`
    );
    if (sync.ok && sync.written)
      console.log(
        `  ↳ tracker.storyEnrichment synced: ${sync.count} stor${sync.count === 1 ? "y" : "ies"} need context (dashboard will prompt).`
      );
    else if (!sync.ok)
      console.error(`  ↳ note: could not sync tracker.storyEnrichment: ${sync.error}`);
  }
  process.exit(0);
}

// Recompute tracker.storyEnrichment from the bank's open_questions and persist it
// (when --write). Source of truth is candidate/stories.yml#open_questions; this is
// the derived mirror the browser-side dashboard reads. Idempotent: re-running with
// no story change writes nothing. Self-clearing: when a story's open_questions
// empties, its entry drops (and the key is removed once none remain).
function runEnrichmentSync({ write }) {
  const { stories } = loadStories({ root: opts.root });
  const entries = computeStoryEnrichment(stories);

  if (dbExists(pathCtx)) {
    let current;
    try {
      current = kvGet({ ...pathCtx, key: "storyEnrichment" });
    } catch (err) {
      return { ok: false, error: `read sqlite:kv.storyEnrichment: ${err.message}` };
    }
    const prevJson = JSON.stringify(Array.isArray(current) ? current : []);
    const nextJson = JSON.stringify(entries);
    const changed = prevJson !== nextJson;
    if (changed && write) {
      try {
        kvUpsert({ ...pathCtx, key: "storyEnrichment", value: entries });
      } catch (err) {
        return { ok: false, error: `write sqlite:kv.storyEnrichment: ${err.message}` };
      }
    }
    return {
      ok: true,
      applicable: true,
      trackerExists: true,
      changed,
      written: changed && write,
      count: entries.length,
      entries,
    };
  }

  const trackerPath = userPath(pathCtx, "workspace/tracker.json");
  if (!existsSync(trackerPath))
    return { ok: true, applicable: false, trackerExists: false, count: entries.length };

  let raw;
  let data;
  try {
    raw = readFileSync(trackerPath, "utf8");
    data = JSON.parse(raw);
  } catch (err) {
    return { ok: false, error: `read/parse ${trackerPath}: ${err.message}` };
  }
  if (!data || typeof data !== "object" || Array.isArray(data))
    return { ok: false, error: `${trackerPath} is not a JSON object` };

  const prevJson = JSON.stringify(Array.isArray(data.storyEnrichment) ? data.storyEnrichment : []);
  const nextJson = JSON.stringify(entries);
  const changed = prevJson !== nextJson;

  if (changed && write) {
    if (entries.length) data.storyEnrichment = entries;
    else delete data.storyEnrichment;
    try {
      writeTrackerJson(trackerPath, data);
    } catch (err) {
      return { ok: false, error: `write ${trackerPath}: ${err.message}` };
    }
  }
  return {
    ok: true,
    applicable: true,
    trackerExists: true,
    changed,
    written: changed && write,
    count: entries.length,
    entries,
  };
}

function cmdSyncEnrichment() {
  const sync = runEnrichmentSync({ write: opts.write });
  if (opts.json) {
    console.log(JSON.stringify(sync, null, 2));
    process.exit(sync.ok ? 0 : 1);
  }
  if (!sync.ok) {
    console.error(`stories: enrichment sync failed: ${sync.error}`);
    process.exit(1);
  }
  if (!sync.applicable) {
    console.log(
      `No workspace/tracker.json yet, nothing to mirror into (${sync.count} stor${sync.count === 1 ? "y" : "ies"} would need context).`
    );
    process.exit(0);
  }
  if (!opts.write) {
    console.log(
      `${sync.count} stor${sync.count === 1 ? "y" : "ies"} need context. tracker.storyEnrichment ${sync.changed ? "is STALE - pass --write to update" : "is already in sync"}.`
    );
    for (const e of sync.entries)
      console.log(`  - ${e.storyId}: ${e.missing.length} open question(s)`);
    process.exit(0);
  }
  if (sync.written)
    console.log(
      `tracker.storyEnrichment updated: ${sync.count} stor${sync.count === 1 ? "y" : "ies"} need context.`
    );
  else console.log(`tracker.storyEnrichment already in sync (${sync.count}).`);
  process.exit(0);
}

// ---------------------------------------------------------------------------

function fail(msg) {
  if (opts.json) console.log(JSON.stringify({ ok: false, error: msg }, null, 2));
  else console.error(`stories: ${msg}`);
  process.exit(1);
}

function printHelp() {
  console.log(`careerrat stories: safe read/validate/add for the STAR+R story bank

Usage:
  node src/cli/stories.mjs list [--json]
  node src/cli/stories.mjs path [--json]
  node src/cli/stories.mjs check [--json]
  node src/cli/stories.mjs gaps [--competencies "a,b,c"] [--json]
  node src/cli/stories.mjs match <jd-file.md.json> | --signals "a,b,c" [--competencies "..."] [--limit N] [--json]
  node src/cli/stories.mjs add --file FILE [--write] [--json]
  node src/cli/stories.mjs sync-enrichment [--write] [--json]

Commands:
  list             List stories (id · title · competencies · evidence refs).
  path             Print the bank path + story count.
  check            Validate every story against evidence.yml (trace + STAR+R + lint + comp). Exit 1 on any issue.
  gaps             Show behavioural competencies no story covers yet.
  match            Rank stories for a JD's signals (from a JD .md.json or --signals).
  add              Add/replace one story. DRY RUN by default; pass --write to commit (atomic upsert by id).
  sync-enrichment  Mirror story open_questions into tracker.storyEnrichment (the dashboard's
                   "give me more context" action). DRY RUN by default; --write to persist.
                   Runs automatically after every \`add --write\`.

The story bank (${STORIES_REL_PATH}) is candidate-owned and gitignored. Every story
must trace to candidate/evidence.yml. Add/check refuse a story that cites no
evidence, an unknown claim id, a missing STAR+R field, placeholder residue, or a
private comp leak. Writes are atomic.

Options:
  --file FILE        YAML story fragment for add (a story mapping, or { stories: [ one ] }).
  --signals CSV      Comma-separated JD signals for match.
  --competencies CSV Override the competency set for gaps/match.
  --limit N          Max stories from match (default 6).
  --write            Commit the add (default: dry run).
  --json             Machine-readable output.
  --root DIR         Repo root (default: the careerrat install).`);
}
