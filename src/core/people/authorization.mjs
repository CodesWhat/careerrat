import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { userInfo } from "node:os";
import { dirname, join } from "node:path";
import { personRoot } from "../paths/people.mjs";

// CR101: when the operator adds a person, record who authorized the work, when and
// what for, in that person's own data. It lives under the person's root so it is
// purged and backed up with them.
const AUTHORIZATION_RELPATH = join("internal", "authorization.json");
const NOT_STATED = "not stated";

export function authorizationPath(base, name) {
  return join(personRoot(base, name), AUTHORIZATION_RELPATH);
}

function readAuthorization(base, name) {
  const path = authorizationPath(base, name);
  if (!existsSync(path)) return { person: name, records: [] };
  try {
    const data = JSON.parse(readFileSync(path, "utf8"));
    return { person: name, records: Array.isArray(data.records) ? data.records : [] };
  } catch {
    return { person: name, records: [] };
  }
}

function operatorName(env) {
  const fromEnv = String(env.USER || env.USERNAME || "").trim();
  if (fromEnv) return fromEnv;
  try {
    return userInfo().username;
  } catch {
    return "unknown";
  }
}

export function recordAuthorization({
  base,
  name,
  authorizedBy,
  purpose,
  env = process.env,
  now = new Date(),
}) {
  const path = authorizationPath(base, name);
  const existing = readAuthorization(base, name);
  const record = {
    authorizedBy: String(authorizedBy || "").trim() || NOT_STATED,
    purpose: String(purpose || "").trim() || NOT_STATED,
    authorizedAt: now.toISOString(),
    recordedBy: operatorName(env),
  };
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(
    path,
    `${JSON.stringify({ person: name, records: [...existing.records, record] }, null, 2)}\n`,
    { mode: 0o600 }
  );
  chmodSync(path, 0o600);
  return { path, record };
}
