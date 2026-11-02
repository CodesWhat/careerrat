#!/usr/bin/env node
// careerrat people — one workspace per person, switched by name.
//
//   node src/cli/people.mjs list [--json]
//   node src/cli/people.mjs add <name> [--authorized-by <who>] [--purpose <text>]
//   node src/cli/people.mjs remove <name> --purge --yes
//   node src/cli/people.mjs --help
//
// A person lives at <data root>/people/<name>/. Use `careerrat --for <name> <command>`
// (or CAREERRAT_PERSON=<name>) to run any command in that person's workspace.

import { fileURLToPath } from "node:url";
import {
  createPersonRoot,
  peopleBase,
  personExists,
  personRoot,
  validatePersonName,
} from "../core/paths/people.mjs";
import { recordAuthorization } from "../core/people/authorization.mjs";
import { purgePerson } from "../core/people/purge.mjs";
import { listPeople } from "../core/people/roster.mjs";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));

function printHelp() {
  console.log(`Usage: careerrat people <list|add> [options]

  list [--json]   Show everyone with a workspace and whether their setup is done
  add <name>      Create a workspace for a person (lowercase letters, numbers, hyphens)
                  and record who authorized you to run their search and what it is for:
                  --authorized-by <who>  --purpose <text>
  remove <name> --purge --yes
                  Delete that person's data root, browser profile and generated documents
                  after writing a backup to <data root>/people-backups/. Refuses without --yes.

Each person keeps their own profile, evidence, tracker and documents.
Run any command for them with: careerrat --for <name> <command>
Docs: Running CareerRat for someone else.`);
}

function fail(message) {
  console.error(`people: ${message}`);
  process.exit(1);
}

function cmdList(json) {
  const base = peopleBase({ repoRoot: ROOT });
  const people = listPeople({ repoRoot: ROOT });
  if (json) {
    console.log(JSON.stringify({ ok: true, base, people }, null, 2));
    return;
  }
  if (people.length === 0) {
    console.log("No people yet. Add one with: careerrat people add <name>");
    return;
  }
  const width = Math.max(...people.map((person) => person.name.length));
  for (const person of people) {
    console.log(`${person.name.padEnd(width)}  ${person.ready ? "ready" : "setup not finished"}`);
  }
}

function cmdAdd(name, json, { authorizedBy, purpose }) {
  try {
    validatePersonName(name);
  } catch (err) {
    fail(err.message);
  }
  const base = peopleBase({ repoRoot: ROOT });
  const existed = personExists(base, name);
  const root = existed ? personRoot(base, name) : createPersonRoot(base, name);
  // A new person always gets a note. An existing one only gets another when the
  // operator is stating who authorized it or what for.
  const record =
    !existed || authorizedBy || purpose
      ? recordAuthorization({ base, name, authorizedBy, purpose }).record
      : null;
  const next = `careerrat start --for ${name}`;
  if (json) {
    console.log(
      JSON.stringify(
        { ok: true, name, root, created: !existed, authorization: record, next },
        null,
        2
      )
    );
    return;
  }
  console.log(existed ? `${name} already has a workspace at ${root}` : `Created ${root}`);
  if (record) {
    console.log(
      `Authorization noted: by ${record.authorizedBy}, for ${record.purpose}, ${record.authorizedAt}`
    );
    if (record.authorizedBy === "not stated" || record.purpose === "not stated") {
      console.log(
        `Record it properly: careerrat people add ${name} --authorized-by "<who>" --purpose "<what for>"`
      );
    }
  }
  console.log(`Next: ${next}`);
}

function cmdRemove(name, json, { purge, yes }) {
  try {
    validatePersonName(name);
  } catch (err) {
    fail(err.message);
  }
  if (!purge) fail(`remove deletes data. Run: careerrat people remove ${name} --purge --yes`);
  if (!yes) {
    fail(
      `refusing to purge ${name} without --yes. This deletes their data root, browser profile and generated documents (a backup is written first).`
    );
  }
  const base = peopleBase({ repoRoot: ROOT });
  let result;
  try {
    result = purgePerson({ base, name });
  } catch (err) {
    fail(err.message);
  }
  if (json) {
    console.log(JSON.stringify({ ok: true, name, ...result }, null, 2));
    return;
  }
  for (const path of result.removed) console.log(`Removed ${path}`);
  if (result.documentsSkipped) {
    console.log(`Left ${result.documentsSkipped} alone (CAREERRAT_DOWNLOADS_DIR is set).`);
  }
  console.log(`Backup: ${result.backup}`);
}

function parseArgs(args) {
  const out = { json: false, purge: false, yes: false, help: false, positional: [] };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--json") out.json = true;
    else if (arg === "--purge") out.purge = true;
    else if (arg === "--yes" || arg === "-y") out.yes = true;
    else if (arg === "--help" || arg === "-h") out.help = true;
    else if (arg === "--authorized-by" || arg === "--purpose") {
      const value = args[++i];
      if (!value?.trim() || value.startsWith("--")) fail(`${arg} needs a value.`);
      out[arg === "--purpose" ? "purpose" : "authorizedBy"] = value;
    } else if (arg.startsWith("-")) fail(`unknown option "${arg}".`);
    else out.positional.push(arg);
  }
  return out;
}

const parsed = parseArgs(process.argv.slice(2));
const { json, positional } = parsed;
if (parsed.help || positional.length === 0) {
  printHelp();
  process.exit(positional.length === 0 && !parsed.help ? 1 : 0);
}
const [sub, name] = positional;
if (sub === "list") cmdList(json);
else if (sub === "add") {
  if (!name) fail("add needs a name. Try: careerrat people add <name>");
  cmdAdd(name, json, parsed);
} else if (sub === "remove") {
  if (!name) fail("remove needs a name. Try: careerrat people remove <name> --purge --yes");
  cmdRemove(name, json, parsed);
} else fail(`unknown command "${sub}". Use list, add or remove.`);
