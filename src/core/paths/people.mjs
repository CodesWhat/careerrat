import { existsSync, mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { privateDataRoot } from "./workspace.mjs";

// One workspace per person. A person lives at <base>/people/<name>/, where <base>
// is the normal private data root. The base root itself stays the owner's own
// workspace, so a run with no person selected resolves exactly as before.
const PERSON_NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,39}$/;
const PEOPLE_DIR = "people";

export function isValidPersonName(name) {
  return typeof name === "string" && PERSON_NAME_PATTERN.test(name);
}

export function validatePersonName(name) {
  if (!isValidPersonName(name)) {
    throw new Error(
      `Invalid person name "${String(name ?? "")}". Use lowercase letters, numbers and hyphens, starting with a letter or number, up to 40 characters.`
    );
  }
  return name;
}

// The data root people live under. Once a person is selected, CAREERRAT_HOME points
// at that person's root, so the original base travels in CAREERRAT_PEOPLE_BASE and
// child processes (and a nested `careerrat` call) resolve against the same base.
export function peopleBase({ repoRoot, env = process.env } = {}) {
  const carried = String(env.CAREERRAT_PEOPLE_BASE || "").trim();
  return carried || privateDataRoot({ repoRoot, env });
}

function peopleDir(base) {
  return join(base, PEOPLE_DIR);
}

export function personRoot(base, name) {
  return join(peopleDir(base), validatePersonName(name));
}

// The selected person from the environment, or null for the owner's own workspace.
export function currentPerson(env = process.env) {
  const raw = String(env.CAREERRAT_PERSON || "").trim();
  return raw ? validatePersonName(raw) : null;
}

// The env values that select a person. Idempotent: applying it again inside a
// process that already inherited them yields the same values.
export function personEnv({ repoRoot, env = process.env, name } = {}) {
  validatePersonName(name);
  const base = peopleBase({ repoRoot, env });
  return {
    CAREERRAT_HOME: personRoot(base, name),
    CAREERRAT_PERSON: name,
    CAREERRAT_PEOPLE_BASE: base,
  };
}

export function personExists(base, name) {
  return isValidPersonName(name) && existsSync(personRoot(base, name));
}

export function createPersonRoot(base, name) {
  const root = personRoot(base, name);
  mkdirSync(root, { recursive: true, mode: 0o700 });
  return root;
}

export function listPersonNames(base) {
  const dir = peopleDir(base);
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && isValidPersonName(entry.name))
    .map((entry) => entry.name)
    .sort();
}
