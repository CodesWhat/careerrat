#!/usr/bin/env node
// careerrat people — one workspace per person, switched by name.
//
//   node src/cli/people.mjs list [--json]
//   node src/cli/people.mjs add <name>
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
import { listPeople } from "../core/people/roster.mjs";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));

function printHelp() {
  console.log(`Usage: careerrat people <list|add> [options]

  list [--json]   Show everyone with a workspace and whether their setup is done
  add <name>      Create a workspace for a person (lowercase letters, numbers, hyphens)

Each person keeps their own profile, evidence, tracker and documents.
Run any command for them with: careerrat --for <name> <command>`);
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

function cmdAdd(name, json) {
  try {
    validatePersonName(name);
  } catch (err) {
    fail(err.message);
  }
  const base = peopleBase({ repoRoot: ROOT });
  const existed = personExists(base, name);
  const root = existed ? personRoot(base, name) : createPersonRoot(base, name);
  const next = `careerrat start --for ${name}`;
  if (json) {
    console.log(JSON.stringify({ ok: true, name, root, created: !existed, next }, null, 2));
    return;
  }
  console.log(existed ? `${name} already has a workspace at ${root}` : `Created ${root}`);
  console.log(`Next: ${next}`);
}

const args = process.argv.slice(2);
const json = args.includes("--json");
const positional = args.filter((arg) => !arg.startsWith("-"));
if (args.includes("--help") || args.includes("-h") || positional.length === 0) {
  printHelp();
  process.exit(positional.length === 0 && !args.includes("--help") && !args.includes("-h") ? 1 : 0);
}
const [sub, name] = positional;
if (sub === "list") cmdList(json);
else if (sub === "add") {
  if (!name) fail("add needs a name. Try: careerrat people add <name>");
  cmdAdd(name, json);
} else fail(`unknown command "${sub}". Use list or add.`);
