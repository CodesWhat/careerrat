#!/usr/bin/env node

// careerrat data — the sqlite-backed data layer's CLI surface (M6).
//
// `careerrat data <verb>` is a thin argv shim over the exact same lib functions
// the HTTP route (src/cli/data-route.mjs) calls — decision 6's "one shared
// write path": there is exactly one INSERT/UPDATE call site per domain action,
// this file just parses argv into the same options object the route builds
// from a parsed JSON body.
//
// Fail-closed (decision 7): every verb below except `init` and `import` opens
// the db via the domain lib functions' own requireDb()/exportToTracker(),
// which throw a clear "no database yet" error instead of silently creating an
// empty db or falling back to reading tracker.json — this file just surfaces
// that error (or, for `status`, checks dbExists() itself to report cleanly).
//
// Usage:
//   node src/cli/data.mjs status [--json]
//   node src/cli/data.mjs init [--demo] [--json]
//   node src/cli/data.mjs import [--source <dir>] [--json]
//   node src/cli/data.mjs export [--json]
//   node src/cli/data.mjs verify [--json]
//   node src/cli/data.mjs app upsert --data <json> | --data-file <path>
//   node src/cli/data.mjs app set-status <id> <to> [--note <t>] [--follow-up-due <iso>] [--clear-interview|--no-clear-interview]
//   node src/cli/data.mjs app set-fields <id> --data <json> | --data-file <path>
//   node src/cli/data.mjs app schedule-interview <id> --at <iso> [--round <t>] [--note <t>]
//   node src/cli/data.mjs app register-artifact <id> --kind <k> --path <p> [--note <t>]
//   node src/cli/data.mjs sourced upsert-batch --data <json-array> | --data-file <path>
//   node src/cli/data.mjs sourced promote <id> [--data <json>|--data-file <path>]
//   node src/cli/data.mjs comm upsert --data <json> | --data-file <path>
//   node src/cli/data.mjs comm append-message <id> --data <json> | --data-file <path>
//   node src/cli/data.mjs comm mark-sent <id> [--at <iso>] [--summary <t>]
//   node src/cli/data.mjs calendar busy --data <json-array> | --data-file <path>
//   node src/cli/data.mjs calendar write --data <json> | --data-file <path>
//   node src/cli/data.mjs source watermark --data <json|json-array> | --data-file <path> [--at <iso>]
//   node src/cli/data.mjs relationship leads upsert --data <json-array> | --data-file <path>
//   node src/cli/data.mjs relationship lead set-status <id> <review|approved|rejected> [--at <iso>] [--follow-up-due <iso>] [--note <t>]
//   node src/cli/data.mjs linkedin-proposals record --data <json> | --data-file <path> [--write]
//   node src/cli/data.mjs linkedin-proposals latest [--status <s>]
//   node src/cli/data.mjs linkedin-proposals mark-applied --batch <id> --surface <surfaceId> --version <n> [--reason <t>]
//   node src/cli/data.mjs candidate init|get
//   node src/cli/data.mjs candidate patch <profile|targeting|honesty|form-defaults|modes|automation|application-limits> --data <json> | --data-file <path>
//   node src/cli/data.mjs candidate evidence --data <json-array> | --data-file <path>
//   node src/cli/data.mjs candidate limits upsert --data <json> | --data-file <path>
//   node src/cli/data.mjs deep-ingest state
//   node src/cli/data.mjs deep-ingest source create --target-shape <shape> [--source-kind <kind>] [--label <t>] [--text <t>] [--data <json>]
//   node src/cli/data.mjs deep-ingest source list [--status <s>] [--target-shape <shape>] [--limit <n>]
//   node src/cli/data.mjs deep-ingest source get <id>
//   node src/cli/data.mjs deep-ingest proposal put --source-id <id> --target-shape <shape> --lane <lane> --data <json>
//   node src/cli/data.mjs deep-ingest decide <proposal-id> <decision> --expected-version <n> [--reason <t>]
//   node src/cli/data.mjs deep-ingest lane <lane> <status> [--reason <t>]
//   node src/cli/data.mjs activity append --data <json> | --data-file <path>
//   node src/cli/data.mjs intake capture --text <string> [--input-kind text|url]
//   node src/cli/data.mjs intake update <id> --data <json> | --data-file <path>
//   node src/cli/data.mjs intake decide <id> confirm|dismiss [--note <t>]
//   node src/cli/data.mjs intake list [--status <s>] [--limit <n>]
//   node src/cli/data.mjs intake one <id>
//   node src/cli/data.mjs analytics-refresh [--at <iso>]
//
// Every verb accepts --json (machine-readable) and --root <dir> (repo root,
// default: this install).

import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dbExists, dbFilePath, NO_DATABASE_MESSAGE, openDb } from "../core/db/connection.mjs";
import { seedDemo } from "../core/db/demo-seed.mjs";
import { exportToTracker } from "../core/db/export-to-tracker.mjs";
import { importFromTracker } from "../core/db/import-from-tracker.mjs";
import {
  activityAppend,
  analyticsRefresh,
  appRegisterArtifact,
  appScheduleInterview,
  appSetFields,
  appSetStatus,
  appUpsert,
  calendarBusyUpsert,
  calendarWriteAppend,
  candidateApplicationLimitUpsert,
  candidateConfigGet,
  candidateConfigPatch,
  candidateEvidenceMerge,
  candidateSetupInitialize,
  commAppendMessage,
  commMarkSent,
  commUpsert,
  deepIngestConfirmProposal,
  deepIngestLaneSetState,
  deepIngestProposalDecision,
  deepIngestProposalPut,
  deepIngestSourceCreate,
  deepIngestSourceGet,
  deepIngestSourceList,
  deepIngestStateGet,
  intakeCapture,
  intakeDecide,
  intakeList,
  intakeOne,
  intakeUpdate,
  linkedinProposalBatchLatest,
  linkedinProposalBatchPreflight,
  linkedinProposalBatchPut,
  linkedinProposalDecide,
  relationshipLeadSetStatus,
  relationshipLeadUpsertBatch,
  sourcedPromote,
  sourcedUpsertBatch,
  sourceWatermarkUpsert,
} from "../core/db/verbs.mjs";
import { displayPath, userPath } from "../core/paths/workspace.mjs";
import { sanitizeCandidateConfigForAgent } from "../core/profile/config-store.mjs";
import { loadTrackerData, validateTrackerData } from "../core/tracker/tracker-data.mjs";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));

function parseArgs(argv) {
  const opts = { positional: [], json: false, root: ROOT, env: process.env };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--json") opts.json = true;
    else if (a === "--help" || a === "-h") opts.help = true;
    else if (a === "--demo") opts.demo = true;
    else if (a === "--clear-interview") opts.clearInterview = true;
    else if (a === "--no-clear-interview") opts.clearInterview = false;
    else if (a === "--write") opts.write = true;
    else if (a === "--batch") opts.batch = argv[++i];
    else if (a === "--surface") opts.surface = argv[++i];
    else if (a === "--version") {
      const rawVersion = argv[++i];
      opts.version = /^[1-9]\d*$/.test(rawVersion ?? "") ? Number(rawVersion) : Number.NaN;
    } else if (a === "--root") opts.root = argv[++i];
    else if (a === "--source") opts.source = argv[++i];
    else if (a === "--data") opts.data = argv[++i];
    else if (a === "--data-file") opts.dataFile = argv[++i];
    else if (a === "--note") opts.note = argv[++i];
    else if (a === "--follow-up-due") opts.followUpDue = argv[++i];
    else if (a === "--at") opts.at = argv[++i];
    else if (a === "--round") opts.round = argv[++i];
    else if (a === "--kind") opts.kind = argv[++i];
    else if (a === "--path") opts.path = argv[++i];
    else if (a === "--summary") opts.summary = argv[++i];
    else if (a === "--status") opts.status = argv[++i];
    else if (a === "--target-shape") opts.targetShape = argv[++i];
    else if (a === "--source-kind") opts.sourceKind = argv[++i];
    else if (a === "--label") opts.label = argv[++i];
    else if (a === "--source-id") opts.sourceId = argv[++i];
    else if (a === "--proposal-id") opts.proposalId = argv[++i];
    else if (a === "--expected-version") opts.expectedVersion = Number.parseInt(argv[++i], 10);
    else if (a === "--lane") opts.lane = argv[++i];
    else if (a === "--reason") opts.reason = argv[++i];
    else if (a === "--limit") opts.limit = Number.parseInt(argv[++i], 10);
    else if (a === "--text") opts.text = argv[++i];
    else if (a === "--input-kind") opts.inputKind = argv[++i];
    else if (a === "--source-file-path") opts.sourceFilePath = argv[++i];
    else opts.positional.push(a);
  }
  return opts;
}

const opts = parseArgs(process.argv.slice(2));
const pathCtx = { repoRoot: opts.root, env: opts.env };

if (opts.help || opts.positional.length === 0) {
  printHelp();
  process.exit(opts.help ? 0 : 1);
}

const [verb, sub, ...rest] = opts.positional;

// Read a JSON payload from --data (inline) or --data-file (path); the caller
// says which action needed it, for a clearer error.
function readPayload(label) {
  if (opts.data !== undefined) {
    try {
      return JSON.parse(opts.data);
    } catch (err) {
      fail(`--data is not valid JSON: ${err.message}`);
    }
  }
  if (opts.dataFile) {
    if (!existsSync(opts.dataFile)) fail(`--data-file not found: ${opts.dataFile}`);
    try {
      return JSON.parse(readFileSync(opts.dataFile, "utf8"));
    } catch (err) {
      fail(`--data-file is not valid JSON: ${err.message}`);
    }
  }
  fail(`${label} requires --data <json> or --data-file <path>`);
  return undefined; // unreachable; fail() exits the process
}

try {
  switch (verb) {
    case "status":
      cmdStatus();
      break;
    case "init":
      cmdInit();
      break;
    case "import":
      cmdImport();
      break;
    case "export":
      cmdExport();
      break;
    case "verify":
      cmdVerify();
      break;
    case "app":
      cmdApp(sub, rest);
      break;
    case "sourced":
      cmdSourced(sub, rest);
      break;
    case "comm":
      cmdComm(sub, rest);
      break;
    case "calendar":
      cmdCalendar(sub, rest);
      break;
    case "source":
      cmdSource(sub, rest);
      break;
    case "relationship":
      cmdRelationship(sub, rest);
      break;
    case "linkedin-proposals":
      cmdLinkedinProposals(sub, rest);
      break;
    case "candidate":
      cmdCandidate(sub, rest);
      break;
    case "deep-ingest":
      cmdDeepIngest(sub, rest);
      break;
    case "activity":
      cmdActivity(sub, rest);
      break;
    case "intake":
      cmdIntake(sub, rest);
      break;
    case "analytics-refresh":
      cmdAnalyticsRefresh();
      break;
    default:
      fail(`unknown command "${verb}". See --help.`);
  }
} catch (err) {
  fail(err?.message || String(err));
}

// ---------------------------------------------------------------------------
// Top-level verbs
// ---------------------------------------------------------------------------

function cmdStatus() {
  if (!dbExists(pathCtx)) {
    if (opts.json) {
      console.log(
        JSON.stringify({ ok: false, exists: false, error: NO_DATABASE_MESSAGE }, null, 2)
      );
    } else {
      console.log(`No database yet at ${dbDisplayPath()}.`);
      console.log(NO_DATABASE_MESSAGE);
    }
    process.exitCode = 1;
    return;
  }

  // exportToTracker() is the safe read-everything path we already have, so
  // status reads its counts off of that rather than hand-rolling a second
  // "select count(*) from every table" primitive.
  const exported = exportToTracker(pathCtx);
  if (opts.json) {
    console.log(JSON.stringify({ ok: true, exists: true, counts: exported.counts }, null, 2));
    return;
  }
  console.log(`Database: ${dbDisplayPath()}`);
  console.log(`  applications:   ${exported.counts.applications}`);
  console.log(`  sourced:        ${exported.counts.sourced}`);
  console.log(`  sources:        ${exported.counts.sources}`);
  console.log(`  communications: ${exported.counts.communications}`);
  console.log(`  activity:       ${exported.counts.activity}`);
}

function cmdInit() {
  if (opts.demo) {
    const result = seedDemo(pathCtx);
    printResult(result, `Seeded demo data → ${dbDisplayPath()}`);
    return;
  }
  // Plain init: opening the db is enough to create + migrate an empty one.
  // openDb() is the one legitimate direct caller here (decision 7 — init IS
  // the create-the-db path, unlike every other verb which fails closed).
  openDb(pathCtx);
  printResult({ ok: true }, `Initialized empty database → ${dbDisplayPath()}`);
}

function cmdImport() {
  const result = importFromTracker({ ...pathCtx, sourceDir: opts.source });
  // Immediately export back out so workspace/tracker.json reflects the db
  // right away — most importantly when --source points somewhere other than
  // this workspace's own tracker.json, where nothing would otherwise write
  // workspace/tracker.json until the next verb runs.
  const exported = exportToTracker(pathCtx);
  printResult(
    { ...result, exported },
    `Imported → ${dbDisplayPath()} (${JSON.stringify(result.counts)})`
  );
}

function cmdExport() {
  const result = exportToTracker(pathCtx);
  printResult(
    result,
    `Exported → ${displayPath(pathCtx, "workspace/tracker.json")}, ${displayPath(pathCtx, "workspace/activity.jsonl")}`
  );
}

function cmdVerify() {
  const exported = exportToTracker(pathCtx);
  const trackerPath = userPath(pathCtx, "workspace/tracker.json");
  const data = loadTrackerData(trackerPath);
  const result = validateTrackerData(data);

  if (opts.json) {
    console.log(
      JSON.stringify(
        { ok: result.errors.length === 0, exported: exported.counts, ...result },
        null,
        2
      )
    );
  } else {
    console.log(`APPS: ${data.apps.length}`);
    console.log(`SOURCED: ${data.sourced.length}`);
    for (const warning of result.warnings) console.log(`WARN ${warning}`);
    for (const error of result.errors) console.log(`ERROR ${error}`);
    console.log(
      `Tracker health: ${result.errors.length} errors, ${result.warnings.length} warnings`
    );
  }
  if (result.errors.length > 0) process.exitCode = 1;
}

// ---------------------------------------------------------------------------
// app <sub>
// ---------------------------------------------------------------------------

function cmdApp(sub, rest) {
  switch (sub) {
    case "upsert":
      return printResult(appUpsert({ ...pathCtx, row: readPayload("app upsert") }));
    case "set-status": {
      const [id, to] = rest;
      if (!id || !to) fail("app set-status requires <id> <to>");
      return printResult(
        appSetStatus({
          ...pathCtx,
          id,
          to,
          note: opts.note,
          followUpDueAt: opts.followUpDue,
          clearInterview: opts.clearInterview,
        })
      );
    }
    case "set-fields": {
      const [id] = rest;
      if (!id) fail("app set-fields requires <id>");
      return printResult(appSetFields({ ...pathCtx, id, patch: readPayload("app set-fields") }));
    }
    case "schedule-interview": {
      const [id] = rest;
      if (!id) fail("app schedule-interview requires <id>");
      if (!opts.at) fail("app schedule-interview requires --at <iso>");
      return printResult(
        appScheduleInterview({ ...pathCtx, id, at: opts.at, round: opts.round, note: opts.note })
      );
    }
    case "register-artifact": {
      const [id] = rest;
      if (!id) fail("app register-artifact requires <id>");
      if (!opts.kind || !opts.path) fail("app register-artifact requires --kind and --path");
      return printResult(
        appRegisterArtifact({ ...pathCtx, id, kind: opts.kind, path: opts.path, note: opts.note })
      );
    }
    default:
      return fail(`unknown "app" command "${sub}". See --help.`);
  }
}

// ---------------------------------------------------------------------------
// sourced <sub>
// ---------------------------------------------------------------------------

function cmdSourced(sub, rest) {
  switch (sub) {
    case "upsert-batch":
      return printResult(
        sourcedUpsertBatch({ ...pathCtx, rows: readPayload("sourced upsert-batch") })
      );
    case "promote": {
      const [id] = rest;
      if (!id) fail("sourced promote requires <id>");
      const appRow =
        opts.data !== undefined || opts.dataFile ? readPayload("sourced promote") : undefined;
      return printResult(sourcedPromote({ ...pathCtx, id, appRow }));
    }
    default:
      return fail(`unknown "sourced" command "${sub}". See --help.`);
  }
}

// ---------------------------------------------------------------------------
// comm <sub>
// ---------------------------------------------------------------------------

function cmdComm(sub, rest) {
  switch (sub) {
    case "upsert":
      return printResult(commUpsert({ ...pathCtx, row: readPayload("comm upsert") }));
    case "append-message": {
      const [id] = rest;
      if (!id) fail("comm append-message requires <id>");
      return printResult(
        commAppendMessage({ ...pathCtx, id, message: readPayload("comm append-message") })
      );
    }
    case "mark-sent": {
      const [id] = rest;
      if (!id) fail("comm mark-sent requires <id>");
      return printResult(commMarkSent({ ...pathCtx, id, at: opts.at, summary: opts.summary }));
    }
    default:
      return fail(`unknown "comm" command "${sub}". See --help.`);
  }
}

// ---------------------------------------------------------------------------
// calendar <sub>
// ---------------------------------------------------------------------------

function cmdCalendar(sub, _rest) {
  switch (sub) {
    case "busy":
      return printResult(
        calendarBusyUpsert({
          ...pathCtx,
          blocks: readPayload("calendar busy"),
          source: opts.source,
        })
      );
    case "write":
      return printResult(
        calendarWriteAppend({
          ...pathCtx,
          record: readPayload("calendar write"),
        })
      );
    default:
      return fail(`unknown "calendar" command "${sub}". See --help.`);
  }
}

// ---------------------------------------------------------------------------
// source <sub>
// ---------------------------------------------------------------------------

function cmdSource(sub, _rest) {
  switch (sub) {
    case "watermark":
      return printResult(
        sourceWatermarkUpsert({
          ...pathCtx,
          source: readPayload("source watermark"),
          at: opts.at,
        })
      );
    default:
      return fail(`unknown "source" command "${sub}". See --help.`);
  }
}

// ---------------------------------------------------------------------------
// relationship <sub>
// ---------------------------------------------------------------------------

function cmdRelationship(sub, rest) {
  switch (sub) {
    case "leads": {
      const [action] = rest;
      if (action !== "upsert") fail('relationship leads requires "upsert"');
      return printResult(
        relationshipLeadUpsertBatch({
          ...pathCtx,
          leads: readPayload("relationship leads upsert"),
        })
      );
    }
    case "lead": {
      const [action, id, status] = rest;
      if (action !== "set-status") fail('relationship lead requires "set-status"');
      if (!id || !status) fail("relationship lead set-status requires <id> <status>");
      return printResult(
        relationshipLeadSetStatus({
          ...pathCtx,
          id,
          status,
          at: opts.at,
          dueAt: opts.followUpDue,
          note: opts.note,
        })
      );
    }
    default:
      return fail(`unknown "relationship" command "${sub}". See --help.`);
  }
}

// ---------------------------------------------------------------------------
// linkedin-proposals <sub> — optimize-linkedin's DB-owned confirm-first
// review state (M... "optimize-linkedin goes native"). `record` mirrors
// activity.mjs's dry-run-by-default shape: without --write it only previews
// what would be stored, but the dry-run preview still runs
// linkedinProposalBatchPreflight first — the same shape/comp-leak validation
// linkedinProposalBatchPut runs before persisting — so a leaking payload is
// refused before anything reaches stdout, not just once someone passes
// --write. Either path's LINKEDIN_PROPOSAL_COMP_LEAK throw is handled by the
// top-level catch below, same as every other verb's errors.
// ---------------------------------------------------------------------------

function cmdLinkedinProposals(sub, _rest) {
  switch (sub) {
    case "record":
      return cmdLinkedinProposalsRecord();
    case "latest":
      return printResult({
        ok: true,
        batch: linkedinProposalBatchLatest({ ...pathCtx, status: opts.status ?? "pending" }),
      });
    case "mark-applied":
      if (!opts.batch || !opts.surface) {
        fail("linkedin-proposals mark-applied requires --batch <id> --surface <surfaceId>");
      }
      if (!Number.isSafeInteger(opts.version) || opts.version < 1) {
        fail("linkedin-proposals mark-applied requires --version <n>");
      }
      return printResult({
        ok: true,
        batch: linkedinProposalDecide({
          ...pathCtx,
          batchId: opts.batch,
          surfaceId: opts.surface,
          action: "applied",
          version: opts.version,
          reason: opts.reason,
        }),
      });
    default:
      return fail(`unknown "linkedin-proposals" command "${sub}". See --help.`);
  }
}

function cmdLinkedinProposalsRecord() {
  const payload = readPayload("linkedin-proposals record");
  if (!Array.isArray(payload?.surfaces) || payload.surfaces.length === 0) {
    fail("linkedin-proposals record requires a non-empty surfaces array");
  }

  // Preflight before EITHER path prints/persists anything — without this a
  // dry-run (no --write) would serialize a leaking payload straight to
  // stdout, since only --write used to reach the comp-leak guard.
  linkedinProposalBatchPreflight({ batch: payload });

  if (!opts.write) {
    const preview = {
      id: payload.id || "(assigned on write)",
      status: "pending",
      version: 1,
      surfaces: payload.surfaces.map((surface) => ({ ...surface, decision: null })),
    };
    if (opts.json) {
      console.log(JSON.stringify({ ok: true, dryRun: true, batch: preview }, null, 2));
    } else {
      console.log("Proposed linkedin proposal batch:");
      console.log(JSON.stringify(preview, null, 2));
      console.log("");
      console.log("Dry run - pass --write to commit.");
    }
    return;
  }

  return printResult(linkedinProposalBatchPut({ ...pathCtx, batch: payload }));
}

// ---------------------------------------------------------------------------
// candidate <sub> — SQLite-primary onboarding/profile/targeting/settings.
// These verbs intentionally do not export YAML mirrors; write-config owns
// compatibility output.
// ---------------------------------------------------------------------------

function cmdCandidate(sub, rest) {
  switch (sub) {
    case "init":
      return printResult(candidateSetupInitialize(pathCtx));
    case "get":
      return printResult(sanitizeCandidateConfigForAgent(candidateConfigGet(pathCtx)));
    case "patch": {
      const [name] = rest;
      if (!name) fail("candidate patch requires <name>");
      const patch = readPayload("candidate patch");
      if (
        name === "form-defaults" &&
        patch &&
        typeof patch === "object" &&
        !Array.isArray(patch) &&
        Object.hasOwn(patch, "voluntary_self_identification")
      ) {
        fail("voluntary self-identification is managed only in local Application defaults");
      }
      return printResult(candidateConfigPatch({ ...pathCtx, name, patch }));
    }
    case "evidence":
      return printResult(
        candidateEvidenceMerge({ ...pathCtx, claims: readPayload("candidate evidence") })
      );
    case "limits": {
      const [action] = rest;
      if (action !== "upsert") fail('candidate limits requires "upsert"');
      return printResult(
        candidateApplicationLimitUpsert({
          ...pathCtx,
          row: readPayload("candidate limits upsert"),
        })
      );
    }
    default:
      return fail(`unknown "candidate" command "${sub}". See --help.`);
  }
}

// ---------------------------------------------------------------------------
// deep-ingest <sub> - SQLite-native source/proposal/lane state.
// These verbs intentionally do not export tracker/activity files; confirmed
// candidate facts are written only through explicit confirmation.
// ---------------------------------------------------------------------------

function cmdDeepIngest(sub, rest) {
  switch (sub) {
    case "state":
      return printResult(deepIngestStateGet(pathCtx));
    case "source":
      return cmdDeepIngestSource(rest);
    case "proposal":
      return cmdDeepIngestProposal(rest);
    case "decide": {
      const [proposalId, decision] = rest;
      if (!proposalId || !decision) {
        fail("deep-ingest decide requires <proposal-id> <decision>");
      }
      return printResult(
        deepIngestProposalDecision({
          ...pathCtx,
          proposalId,
          expectedVersion: opts.expectedVersion,
          decision,
          reason: opts.reason || opts.note,
        })
      );
    }
    case "confirm": {
      const [proposalId] = rest;
      if (!proposalId) fail("deep-ingest confirm requires <proposal-id>");
      return printResult(
        deepIngestConfirmProposal({
          ...pathCtx,
          proposalId,
          expectedVersion: opts.expectedVersion,
          edits: readPayload("deep-ingest confirm"),
        })
      );
    }
    case "lane": {
      const [lane, status] = rest;
      if (!lane || !status) fail("deep-ingest lane requires <lane> <status>");
      return printResult(
        deepIngestLaneSetState({
          ...pathCtx,
          lane,
          status,
          reason: opts.reason || opts.note,
        })
      );
    }
    default:
      return fail(`unknown "deep-ingest" command "${sub}". See --help.`);
  }
}

function cmdDeepIngestSource(rest) {
  const [action, id] = rest;
  switch (action) {
    case "create": {
      const payload =
        opts.data !== undefined || opts.dataFile ? readPayload("deep-ingest source create") : {};
      return printResult(
        deepIngestSourceCreate({
          ...pathCtx,
          input: {
            ...payload,
            targetShape: payload.targetShape || opts.targetShape,
            sourceKind: payload.sourceKind || opts.sourceKind || opts.inputKind || "paste",
            label: payload.label || opts.label,
            text: payload.text || opts.text,
            artifactPath: payload.artifactPath || opts.path,
          },
        })
      );
    }
    case "list":
      return printResult({
        ok: true,
        sources: deepIngestSourceList({
          ...pathCtx,
          status: opts.status,
          targetShape: opts.targetShape,
          limit: opts.limit,
        }),
      });
    case "get": {
      if (!id) fail("deep-ingest source get requires <id>");
      return printResult(deepIngestSourceGet({ ...pathCtx, sourceId: id }));
    }
    default:
      return fail(`unknown "deep-ingest source" command "${action}". See --help.`);
  }
}

function cmdDeepIngestProposal(rest) {
  const [action] = rest;
  switch (action) {
    case "put":
      return printResult(
        deepIngestProposalPut({
          ...pathCtx,
          sourceId: opts.sourceId,
          targetShape: opts.targetShape,
          lane: opts.lane,
          proposal: readPayload("deep-ingest proposal put"),
        })
      );
    default:
      return fail(`unknown "deep-ingest proposal" command "${action}". See --help.`);
  }
}

// ---------------------------------------------------------------------------
// intake <sub> — M9 Universal Intake's queue-state verbs. Mirrors the exact
// same lib functions src/cli/intake-route.mjs calls (one-write-path); unlike
// every verb above, these do NOT bump meta.version/last_updated_at and do NOT
// re-export tracker.json/activity.jsonl afterward — see
// src/core/db/verbs/intake.mjs's own header comment for why intake_items
// sits outside the Tracker Write Contract. `decide confirm` does NOT execute
// the item's dispatch lane (that's intake-route.mjs's confirm-time job) — the
// CLI surface here is the same queue-state primitive the route builds on,
// not a shortcut around it.
// ---------------------------------------------------------------------------

function cmdIntake(sub, rest) {
  switch (sub) {
    case "capture": {
      if (!opts.text) fail("intake capture requires --text <string>");
      return printResult(
        intakeCapture({
          ...pathCtx,
          rawInput: opts.text,
          inputKind: opts.inputKind || "text",
          sourceFilePath: opts.sourceFilePath,
        })
      );
    }
    case "update": {
      const [id] = rest;
      if (!id) fail("intake update requires <id>");
      return printResult(intakeUpdate({ ...pathCtx, id, patch: readPayload("intake update") }));
    }
    case "decide": {
      const [id, decision] = rest;
      if (!id || !decision) fail("intake decide requires <id> <confirm|dismiss>");
      return printResult(intakeDecide({ ...pathCtx, id, decision, dispatchSummary: opts.note }));
    }
    case "list":
      return printResult({
        ok: true,
        items: intakeList({ ...pathCtx, status: opts.status, limit: opts.limit }),
      });
    case "one": {
      const [id] = rest;
      if (!id) fail("intake one requires <id>");
      const item = intakeOne({ ...pathCtx, id });
      if (!item) fail(`no intake item with id "${id}"`);
      return printResult({ ok: true, item });
    }
    default:
      return fail(`unknown "intake" command "${sub}". See --help.`);
  }
}

// ---------------------------------------------------------------------------
// activity <sub> / analytics-refresh
// ---------------------------------------------------------------------------

function cmdActivity(sub, _rest) {
  if (sub !== "append") fail(`unknown "activity" command "${sub}". See --help.`);
  return printResult(activityAppend({ ...pathCtx, event: readPayload("activity append") }));
}

function cmdAnalyticsRefresh() {
  return printResult(analyticsRefresh({ ...pathCtx, at: opts.at }));
}

// ---------------------------------------------------------------------------
// Output helpers
// ---------------------------------------------------------------------------

function dbDisplayPath() {
  return dbFilePath(pathCtx);
}

function printResult(result, humanLine) {
  if (opts.json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  console.log(humanLine || JSON.stringify(result));
}

function fail(msg) {
  if (opts.json) console.log(JSON.stringify({ ok: false, error: msg }, null, 2));
  else console.error(`data: ${msg}`);
  process.exit(1);
}

function printHelp() {
  console.log(`careerrat data: sqlite-backed data layer (M6)

Usage:
  node src/cli/data.mjs status [--json]
  node src/cli/data.mjs init [--demo] [--json]
  node src/cli/data.mjs import [--source <dir>] [--json]
  node src/cli/data.mjs export [--json]
  node src/cli/data.mjs verify [--json]

  node src/cli/data.mjs app upsert --data <json> | --data-file <path>
  node src/cli/data.mjs app set-status <id> <to> [--note <t>] [--follow-up-due <iso>] [--clear-interview|--no-clear-interview]
  node src/cli/data.mjs app set-fields <id> --data <json> | --data-file <path>
  node src/cli/data.mjs app schedule-interview <id> --at <iso> [--round <t>] [--note <t>]
  node src/cli/data.mjs app register-artifact <id> --kind <k> --path <p> [--note <t>]

  node src/cli/data.mjs sourced upsert-batch --data <json-array> | --data-file <path>
  node src/cli/data.mjs sourced promote <id> [--data <json>|--data-file <path>]

  node src/cli/data.mjs comm upsert --data <json> | --data-file <path>
  node src/cli/data.mjs comm append-message <id> --data <json> | --data-file <path>
  node src/cli/data.mjs comm mark-sent <id> [--at <iso>] [--summary <t>]

  node src/cli/data.mjs calendar busy --data <json-array> | --data-file <path>
  node src/cli/data.mjs calendar write --data <json> | --data-file <path>

  node src/cli/data.mjs source watermark --data <json|json-array> | --data-file <path> [--at <iso>]

  node src/cli/data.mjs relationship leads upsert --data <json-array> | --data-file <path>
  node src/cli/data.mjs relationship lead set-status <id> <review|approved|rejected> [--at <iso>] [--follow-up-due <iso>] [--note <t>]

  node src/cli/data.mjs linkedin-proposals record --data <json> | --data-file <path> [--write]
  node src/cli/data.mjs linkedin-proposals latest [--status <s>]
  node src/cli/data.mjs linkedin-proposals mark-applied --batch <id> --surface <surfaceId> --version <n> [--reason <t>]

  node src/cli/data.mjs candidate init|get
  node src/cli/data.mjs candidate patch <profile|targeting|honesty|form-defaults|modes|automation|application-limits> --data <json> | --data-file <path>
  node src/cli/data.mjs candidate evidence --data <json-array> | --data-file <path>
  node src/cli/data.mjs candidate limits upsert --data <json> | --data-file <path>

  node src/cli/data.mjs deep-ingest state
  node src/cli/data.mjs deep-ingest source create --target-shape <shape> [--source-kind <kind>] [--label <t>] [--text <t>] [--data <json>]
  node src/cli/data.mjs deep-ingest source list [--status <s>] [--target-shape <shape>] [--limit <n>]
  node src/cli/data.mjs deep-ingest source get <id>
  node src/cli/data.mjs deep-ingest proposal put --source-id <id> --target-shape <shape> --lane <lane> --data <json>
  node src/cli/data.mjs deep-ingest decide <proposal-id> <decision> --expected-version <n> [--reason <t>]
  node src/cli/data.mjs deep-ingest confirm <proposal-id> --expected-version <n> --data <json>
  node src/cli/data.mjs deep-ingest lane <lane> <status> [--reason <t>]

  node src/cli/data.mjs activity append --data <json> | --data-file <path>

  node src/cli/data.mjs intake capture --text <string> [--input-kind text|url]
  node src/cli/data.mjs intake update <id> --data <json> | --data-file <path>
  node src/cli/data.mjs intake decide <id> confirm|dismiss [--note <t>]
  node src/cli/data.mjs intake list [--status <s>] [--limit <n>]
  node src/cli/data.mjs intake one <id>

  node src/cli/data.mjs analytics-refresh [--at <iso>]

Every command accepts --json (machine-readable) and --root <dir>.

No database yet? Every read/write verb above (except init/import) fails
closed with: "${NO_DATABASE_MESSAGE}"`);
}
