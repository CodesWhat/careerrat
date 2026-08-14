import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import { userPath } from "../core/paths/workspace.mjs";
import { readJsonBodyCapped, sendJson } from "./skill-run-route.mjs";

// The W4 onboarding engine picker's hosted "CareerRat AI" card — not
// installable yet, so REQUEST ACCESS just logs interest rather than
// selecting an engine. Same home-dir file convention as
// runtime-selection.mjs's writeInstalledRuntimeSelection: a plain JSON file
// under the app's private data root, written atomically (tmp file + rename)
// with 0600 perms.
export const HOSTED_INTEREST_RELPATH = ".internal/hosted-interest.json";

const MAX_BODY_BYTES = 4 * 1024;

// Basic shape check, mirroring the client's own EMAIL_SHAPE_RE
// (EngineScreen.jsx) — not full RFC5322, just enough to reject an obviously
// incomplete/garbage address before it lands in the interest log.
const EMAIL_SHAPE_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function loadHostedInterest({ repoRoot, env = process.env } = {}) {
  const path = userPath({ repoRoot, env }, HOSTED_INTEREST_RELPATH);
  if (!existsSync(path)) return [];
  try {
    const value = JSON.parse(readFileSync(path, "utf8"));
    return Array.isArray(value) ? value : [];
  } catch {
    return [];
  }
}

// Appends one interest record — multiple REQUEST ACCESS presses just append
// again rather than deduping, which is fine at this record's scale (a single
// candidate's own machine, not a shared multi-tenant log).
//
// This is the single funnel point for hosted-engine interest: once
// EmailOctopus/PostHog credentials exist, forwarding each appended record to
// those plugs in right here rather than adding a second write path.
function appendHostedInterest({ repoRoot, env = process.env, record }) {
  const path = userPath({ repoRoot, env }, HOSTED_INTEREST_RELPATH);
  const records = loadHostedInterest({ repoRoot, env });
  records.push(record);
  mkdirSync(dirname(path), { recursive: true });
  const tmpPath = `${path}.${process.pid}.tmp`;
  writeFileSync(tmpPath, `${JSON.stringify(records, null, 2)}\n`, "utf8");
  chmodSync(tmpPath, 0o600);
  renameSync(tmpPath, path);
  chmodSync(path, 0o600);
  return records;
}

export function mountHostedInterestRoutes({ addRoute, repoRoot, env = process.env } = {}) {
  addRoute("POST", "/api/hosted-interest", async (req, res) => {
    let body;
    try {
      body = await readJsonBodyCapped(req, MAX_BODY_BYTES);
    } catch (error) {
      sendJson(res, error.status || 400, { ok: false, error: error.message });
      return;
    }
    const email = String(body?.email || "").trim();
    if (!EMAIL_SHAPE_RE.test(email)) {
      sendJson(res, 400, { ok: false, error: "A valid email is required." });
      return;
    }
    appendHostedInterest({
      repoRoot,
      env,
      record: { requested_at: new Date().toISOString(), source: "engine-screen", email },
    });
    sendJson(res, 200, { ok: true });
  });
}
