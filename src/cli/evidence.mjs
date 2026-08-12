#!/usr/bin/env node

// careerrat evidence — the safe read/validate/add helper for the evidence truth bank.
//
// candidate/evidence.yml is the source of truth every outbound artifact draws from
// (résumés, cover letters, interview packets, STAR+R stories). This is the guarded
// write path for ORIGINATING evidence — e.g. ingest-profile scanning a projects
// folder and proposing claims — so new facts land with the same firewall the rest of
// Rolester uses: placeholder lint, a private-`current_base` refusal, schema validity,
// and a stringify→parse round-trip check before the file is rewritten.
//
// Usage:
//   node src/cli/evidence.mjs list [--json]
//   node src/cli/evidence.mjs path [--json]
//   node src/cli/evidence.mjs check [--json]
//   node src/cli/evidence.mjs add --file FILE [--write] [--json]
//   node src/cli/evidence.mjs --help
//
// `add` is a DRY RUN by default: it validates the claim (firewall) and prints what
// would be written, changing nothing. Pass --write to commit (append, or upsert by id).

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { displayPath } from "../core/paths/workspace.mjs";
import {
  computeEvidenceWrite,
  EVIDENCE_REL_PATH,
  loadEvidence,
  validateClaims,
  writeEvidence,
} from "../core/profile/evidence-writer.mjs";
import { formatErrors, validate } from "../core/profile/schema-validator.mjs";
import { parseYaml } from "../core/profile/yaml.mjs";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));

function parseArgs(argv) {
  const opts = { positional: [], write: false, json: false, root: ROOT };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--write") opts.write = true;
    else if (a === "--json") opts.json = true;
    else if (a === "--help" || a === "-h") opts.help = true;
    else if (a === "--file") opts.file = argv[++i];
    else if (a === "--root") opts.root = argv[++i];
    else opts.positional.push(a);
  }
  return opts;
}

const opts = parseArgs(process.argv.slice(2));
const evidenceDisplay = () => displayPath({ repoRoot: opts.root }, EVIDENCE_REL_PATH);

if (opts.help || opts.positional.length === 0) {
  printHelp();
  process.exit(opts.help ? 0 : 1);
}

const [verb] = opts.positional;

function loadSchema() {
  const p = join(opts.root, "config/evidence.schema.json");
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, "utf8"));
  } catch {
    return null;
  }
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
  case "add":
    cmdAdd();
    break;
  default:
    fail(`unknown command "${verb}". Commands: list, path, check, add. See --help.`);
}

// ---------------------------------------------------------------------------

function cmdList() {
  const { exists, claims } = loadEvidence({ root: opts.root });
  if (opts.json) {
    console.log(
      JSON.stringify(
        { exists, count: claims.length, claims: claims.map((c) => ({ id: c.id, claim: c.claim })) },
        null,
        2
      )
    );
    return;
  }
  if (!exists) {
    console.log(`No evidence bank yet (${evidenceDisplay()}).`);
    return;
  }
  if (claims.length === 0) {
    console.log(`Evidence bank is empty (${evidenceDisplay()}).`);
    return;
  }
  console.log(`Evidence bank (${claims.length} claim${claims.length === 1 ? "" : "s"}):`);
  for (const c of claims) {
    console.log(`  ${String(c.id).padEnd(24)} ${c.claim ?? ""}`);
  }
}

function cmdPath() {
  const { exists, claims } = loadEvidence({ root: opts.root });
  const result = { relPath: evidenceDisplay(), exists, count: claims.length };
  if (opts.json) console.log(JSON.stringify(result, null, 2));
  else
    console.log(
      `${evidenceDisplay()}${exists ? ` (${claims.length} claim${claims.length === 1 ? "" : "s"})` : " (not created yet)"}`
    );
}

function cmdCheck() {
  const { exists, claims, data } = loadEvidence({ root: opts.root });
  if (!exists) {
    if (opts.json)
      console.log(
        JSON.stringify({ ok: true, exists: false, note: "no evidence bank yet" }, null, 2)
      );
    else console.error(`No evidence bank yet (${evidenceDisplay()}). Nothing to check.`);
    process.exit(0);
  }
  const schema = loadSchema();
  const schemaErrors = [];
  if (schema) {
    const res = validate(data, schema);
    if (!res.valid) schemaErrors.push(...res.errors);
  }
  const v = validateClaims(claims);
  const ok = v.ok && schemaErrors.length === 0;

  if (opts.json) {
    console.log(
      JSON.stringify({ ok, count: claims.length, errors: v.errors, schemaErrors }, null, 2)
    );
    process.exit(ok ? 0 : 1);
  }
  if (schemaErrors.length > 0) {
    console.error(`Schema errors in ${evidenceDisplay()}:`);
    console.error(formatErrors(schemaErrors));
  }
  if (!v.ok) {
    console.error(`Evidence firewall: ${v.errors.length} issue(s):`);
    for (const e of v.errors) console.error(`  - ${e.message}`);
  }
  if (ok)
    console.log(`Evidence bank OK — ${claims.length} claim${claims.length === 1 ? "" : "s"}.`);
  process.exit(ok ? 0 : 1);
}

function cmdAdd() {
  if (!opts.file) fail("add requires --file FILE (a YAML claim fragment).");
  const p = existsSync(opts.file) ? opts.file : join(opts.root, opts.file);
  if (!existsSync(p)) fail(`--file not found: ${opts.file}`);

  let parsed;
  try {
    parsed = parseYaml(readFileSync(p, "utf8"));
  } catch (err) {
    fail(`could not parse claim file: ${err.message}`);
  }
  // Accept a bare claim mapping or { claims: [ one ] }.
  const newClaim = parsed && Array.isArray(parsed.claims) ? parsed.claims[0] : parsed;
  if (!newClaim || typeof newClaim !== "object") fail("claim file has no claim mapping.");

  const { claims: currentClaims } = loadEvidence({ root: opts.root });
  const plan = computeEvidenceWrite({ newClaim, currentClaims });
  if (!plan.ok) {
    if (opts.json)
      console.log(JSON.stringify({ ok: false, error: plan.error, errors: plan.errors }, null, 2));
    else console.error(`evidence: refused — ${plan.error}`);
    process.exit(1);
  }

  if (!opts.write) {
    if (opts.json) {
      console.log(
        JSON.stringify(
          {
            ok: true,
            dryRun: true,
            id: plan.claim.id,
            replaced: plan.replaced,
            count: plan.nextClaims.length,
          },
          null,
          2
        )
      );
    } else {
      console.log(
        `Proposed ${plan.replaced ? "update" : "add"}: claim "${plan.claim.id}" — ${plan.claim.claim}`
      );
      console.log(
        `  bank would hold ${plan.nextClaims.length} claim${plan.nextClaims.length === 1 ? "" : "s"} (${evidenceDisplay()}).`
      );
      console.log("");
      console.log("Dry run - pass --write to commit.");
    }
    process.exit(0);
  }

  const written = writeEvidence({ claims: plan.nextClaims, root: opts.root, schema: loadSchema() });
  if (!written.ok) {
    if (opts.json) console.log(JSON.stringify({ ok: false, error: written.error }, null, 2));
    else console.error(`evidence: refused — ${written.error}`);
    process.exit(1);
  }
  if (opts.json)
    console.log(
      JSON.stringify(
        {
          ok: true,
          written: true,
          id: plan.claim.id,
          replaced: plan.replaced,
          count: written.count,
          relPath: written.relPath,
        },
        null,
        2
      )
    );
  else
    console.log(
      `Written to ${written.relPath}: claim "${plan.claim.id}" ${plan.replaced ? "updated" : "added"} (${written.count} total).`
    );
  process.exit(0);
}

// ---------------------------------------------------------------------------

function fail(msg) {
  if (opts.json) console.log(JSON.stringify({ ok: false, error: msg }, null, 2));
  else console.error(`evidence: ${msg}`);
  process.exit(1);
}

function printHelp() {
  console.log(`careerrat evidence — safe read/validate/add for the evidence truth bank

Usage:
  node src/cli/evidence.mjs list [--json]
  node src/cli/evidence.mjs path [--json]
  node src/cli/evidence.mjs check [--json]
  node src/cli/evidence.mjs add --file FILE [--write] [--json]

Commands:
  list    List claims (id · claim text).
  path    Print the bank path + claim count.
  check   Validate the bank (schema + id/claim/evidence required + lint + comp). Exit 1 on any issue.
  add     Add/replace one claim. DRY RUN by default; pass --write to commit (append, or upsert by id).

candidate/evidence.yml is the truth bank every outbound artifact draws from. add
refuses a claim missing id/claim/evidence, carrying placeholder residue, or holding
the private current_base field; a committed write must also pass the schema and a
round-trip integrity check before the file is rewritten. Writes are atomic.

Options:
  --file FILE   YAML claim fragment for add (a claim mapping, or { claims: [ one ] }).
  --write       Commit the add (default: dry run).
  --json        Machine-readable output.
  --root DIR    Repo root (default: the careerrat install).`);
}
