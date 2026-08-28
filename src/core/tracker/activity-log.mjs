// activity-log.mjs — the safe read/append primitive for the dashboard Activity Pulse feed.
//
// The Command Center's marquee panel is a reverse-chronological timeline of "what
// the agent did + what happened" (.internal/ui-mocks/SPEC.md §2). It needs a real,
// persisted, current feed — not the hardcoded demo data it shipped with. This module
// is that feed's single safe writer, mirroring learnings.mjs / research-store.mjs:
//
//   - **Append-only JSONL.** One JSON event per line at `workspace/activity.jsonl` —
//     cheaply tailable; the dev-server already fs.watches `workspace/`. Append is the
//     normal path; pruneActivity rewrites atomically for retention/rollup only.
//   - **One validated contract.** Every event is canonicalized (defaults filled,
//     trimmed) then validated against `config/activity-event.schema.json` via the
//     shared dependency-free validator — the same draft-2020-12 subset the gates use.
//   - **Honesty + privacy backstops.** The feed renders on the dashboard, so it is
//     treated as OUTBOUND: an event whose prose carries placeholder residue
//     (lintArtifact) or names the private `current_base` field (findCurrentBaseToken,
//     the narrow token guard — like research-store, since legitimate events may quote
//     market comp) is refused before it can be written.
//   - **Idempotent.** Each event id is derived from its content, so backfilling the
//     same tracker state twice never double-writes (dedupe on id).
//   - **Skills-are-the-only-writers.** The CLI/dashboard only RENDER this feed; the
//     mutating skills append one event at the end of each action. (AGENTS.md →
//     capture-is-skills-not-cli.)
//
// The text operations (canonicalizeEvent, computeAppend, lint/leak checks) are pure
// and unit-testable; the fs touchpoints (read, append, prune) are thin at the bottom.

import { appendFileSync, copyFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { lintArtifact } from "../documents/placeholder-lint.mjs";
import { userPath } from "../paths/workspace.mjs";
import { findCurrentBaseToken } from "../profile/comp-guard.mjs";
import { atomicWriteFile } from "../profile/gate-writer.mjs";
import { validate } from "../profile/schema-validator.mjs";

// Repo-root default (this file lives at src/core/tracker/).
const DEFAULT_ROOT = fileURLToPath(new URL("../../..", import.meta.url));

// The feed lives at the workspace root — gitignored runtime data, never committed.
const ACTIVITY_SUBPATH = "workspace/activity.jsonl";

// The contract's closed vocabularies, exported so the renderer/tests stay in sync
// with the schema instead of re-listing the enums.
export const ACTIVITY_TYPES = [
  "sourced",
  "evaluated",
  "tailored",
  "drafted",
  "applied",
  "status_change",
  "message",
  "interview",
  "offer",
  "research",
  "negotiation",
  "failure",
  "system",
];
export const ACTIVITY_ACTORS = ["agent", "world"];
export const ACTIVITY_TONES = ["info", "success", "warning"];

// Default tone per type when the caller doesn't override (offer reads as a win,
// failure as a warning, everything else neutral).
const DEFAULT_TONE_BY_TYPE = { offer: "success", failure: "warning" };

export function activityAbsPath(root = DEFAULT_ROOT) {
  return userPath({ repoRoot: root }, ACTIVITY_SUBPATH);
}

// ---------------------------------------------------------------------------
// Schema (loaded once, lazily — the dependency-free validator does the rest).
// ---------------------------------------------------------------------------

// The schema is part of the install, not the workspace — always read it from the
// install root so a caller can point the workspace `root` at a temp/alternate dir.
let _schema = null;
function loadSchema() {
  if (_schema) return _schema;
  const path = join(DEFAULT_ROOT, "config/activity-event.schema.json");
  _schema = JSON.parse(readFileSync(path, "utf8"));
  return _schema;
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

// FNV-1a → base36. Small, dependency-free, deterministic — enough to dedupe a
// content-derived event id (not a security hash).
function hash36(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
}

// `title` is presentation prose, not a stable identifier — a copy-only rewrite
// (e.g. swapping em dashes for colons/commas in user-facing strings) must not
// change the dedupe key, or every existing backfilled event doubles on the
// next run. Normalize the separator punctuation out of it before hashing:
// lowercase, collapse dash/colon/semicolon/comma runs (plus the whitespace
// around them) to a single space. This keeps title's actual discriminating
// content (company names, counts, statuses) in the key while making it
// immune to the specific class of edit that bit here.
function normalizeTitleForId(title) {
  return String(title || "")
    .toLowerCase()
    .replace(/[‐-―\-:;,]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// A stable id from the event's identifying content, so the same logical event
// (e.g. re-derived during backfill) always collapses to one line.
export function eventId({ at, type, title, refs }) {
  const key = [
    at || "",
    type || "",
    normalizeTitleForId(title),
    refs?.applicationId || refs?.url || "",
  ].join("|");
  return `evt_${hash36(key)}`;
}

function trimOrNull(v) {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s === "" ? null : s;
}

// Drop empty objects so an all-null refs/cta doesn't clutter the line.
function compact(obj) {
  if (!obj || typeof obj !== "object") return null;
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    const t = typeof v === "string" ? trimOrNull(v) : v;
    if (t !== null && t !== undefined) out[k] = t;
  }
  return Object.keys(out).length ? out : null;
}

// Fill defaults, trim prose, normalize optional fields — the single shape the
// schema then validates. Pure; `now` is injected for testability.
export function canonicalizeEvent(input = {}, { now = new Date() } = {}) {
  const at = trimOrNull(input.at) || now.toISOString();
  const type = trimOrNull(input.type) || "system";
  const title = String(input.title ?? "").trim();
  const refs = compact(input.refs);
  const cta = compact(input.cta);
  const tags = Array.isArray(input.tags)
    ? input.tags.map((t) => String(t).trim()).filter(Boolean)
    : null;

  const event = {
    id: trimOrNull(input.id) || eventId({ at, type, title, refs }),
    at,
    type,
    actor: ACTIVITY_ACTORS.includes(input.actor) ? input.actor : "agent",
    title,
    summary: trimOrNull(input.summary),
    refs,
    tone: ACTIVITY_TONES.includes(input.tone) ? input.tone : DEFAULT_TONE_BY_TYPE[type] || "info",
    needsUser: input.needsUser === true,
    tags: tags?.length ? tags : null,
    cta,
    detail: input.detail ?? null,
    skill: trimOrNull(input.skill),
    operation: trimOrNull(input.operation),
  };

  // Drop null/empty optionals so lines stay lean and additionalProperties:false
  // never sees a stray key.
  for (const k of ["summary", "refs", "tags", "cta", "detail", "skill", "operation"]) {
    if (event[k] === null || event[k] === undefined) delete event[k];
  }
  return event;
}

// The human-facing prose that the honesty/privacy backstops scan. refs URLs and
// the like aren't prose, so we lint title/summary (+ string detail) only.
function proseProbe(event) {
  const parts = [event.title, event.summary];
  if (typeof event.detail === "string") parts.push(event.detail);
  return parts.filter(Boolean).join("\n");
}

// ---------------------------------------------------------------------------
// Plan: pure end-to-end (no fs). Canonicalize → validate → serialize one JSONL
// line, or refuse with a reason.
// ---------------------------------------------------------------------------

export function computeAppend({ event: input, now = new Date() } = {}) {
  const event = canonicalizeEvent(input, { now });

  if (!event.title) return { ok: false, error: "title is required" };

  // Schema (types, enums, required, no stray keys).
  const result = validate(event, loadSchema());
  if (!result.valid) {
    const first = result.errors[0];
    return {
      ok: false,
      error: `schema: ${first.path === "" ? "(root)" : first.path}: ${first.message}`,
      errors: result.errors,
    };
  }

  // Honesty backstop: no unresolved template residue in the prose.
  const lint = lintArtifact(proseProbe(event));
  if (!lint.clean) {
    const first = lint.findings[0];
    return { ok: false, error: `unresolved placeholder (${first.pattern}): "${first.text}"`, lint };
  }

  // Privacy backstop: the feed is outbound — never persist the private comp field.
  // Scan the whole serialized line, not just prose, to catch a stray field too.
  const line = JSON.stringify(event);
  const leak = findCurrentBaseToken(line);
  if (leak) {
    return { ok: false, error: `refusing to record a private comp input: "${leak.match}"`, leak };
  }

  return { ok: true, event, line };
}

// ---------------------------------------------------------------------------
// fs touchpoints
// ---------------------------------------------------------------------------

// READ side (dashboard / CLI): parse every line tolerantly — a half-written or
// blank trailing line (crash mid-append) is skipped, never throws. File order is
// oldest-first (append order).
export function readActivity({ root = DEFAULT_ROOT } = {}) {
  const path = activityAbsPath(root);
  if (!existsSync(path)) return [];
  const events = [];
  for (const raw of readFileSync(path, "utf8").split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    try {
      events.push(JSON.parse(line));
    } catch {
      // skip malformed/partial line
    }
  }
  return events;
}

// Newest-first, optionally capped — the render order.
export function listActivity({ root = DEFAULT_ROOT, limit = null } = {}) {
  const events = readActivity({ root }).slice().reverse();
  return limit ? events.slice(0, limit) : events;
}

// Retention cap (newest-N kept on rollup). The activity log is gitignored runtime
// data — once an event ages past the cap it is gone for good, and skill-written
// events (drafted/tailored/sourced) have no tracker.json anchor so backfill can't
// rebuild them. Default high (2000) and overridable so a normal job-search cycle
// never silently loses history; lower it via CAREERRAT_ACTIVITY_MAX if needed.
const DEFAULT_ACTIVITY_MAX = 2000;

export function activityRetentionLimit(env = process.env) {
  const configured = Number(env?.CAREERRAT_ACTIVITY_MAX);
  return Number.isFinite(configured) && configured > 0
    ? Math.floor(configured)
    : DEFAULT_ACTIVITY_MAX;
}

// WRITE side (the mutating skills): append one event. Refuses on schema / lint /
// comp-leak. Dedupes on the content-derived id so backfill is idempotent.
export function appendActivity(
  input,
  {
    root = DEFAULT_ROOT,
    now = new Date(),
    dedupe = true,
    autoPrune = true,
    max = activityRetentionLimit(),
    pruneAt = 0,
  } = {}
) {
  const plan = computeAppend({ event: input, now });
  if (!plan.ok)
    return { ok: false, error: plan.error, lint: plan.lint, leak: plan.leak, errors: plan.errors };

  const path = activityAbsPath(root);
  // One read serves both the dedupe check and the retention count below.
  const existing = (dedupe || autoPrune) && existsSync(path) ? readActivity({ root }) : [];
  if (dedupe) {
    // Compare on a key RECOMPUTED under the current eventId() — not the raw
    // stored `id` — so a line persisted under an older title wording (e.g.
    // before a copy-only rewrite of the presentation strings) still collapses
    // onto the same logical event instead of duplicating on the next
    // backfill/append.
    //
    // The recomputed comparison is skipped when the CALLER supplied an explicit
    // id (`careerrat activity append --id ...`). Deriving the id is this
    // module's way of saying "identity is a function of content"; passing one in
    // is the caller overriding exactly that, and content-matching anyway would
    // silently drop a line the caller deliberately made distinct. Dropping is
    // the worse direction to fail in: a duplicate is visible and removable, a
    // missing event looks like it never happened. Callers that don't set an id
    // (every DB verb, and deriveActivityEvents) are unaffected and still get
    // the wording-independent collapse this fix exists for.
    const callerSetId = trimOrNull(input?.id) !== null;
    const newKey = eventId(plan.event);
    const isDuplicate = existing.some(
      (e) => e.id === plan.event.id || (!callerSetId && eventId(e) === newKey)
    );
    if (isDuplicate) {
      return { ok: true, deduped: true, event: plan.event, path };
    }
  }

  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, `${plan.line}\n`, "utf8");

  // Retention: keep the feed bounded without rewriting on every append. Only once it
  // drifts past a high-water mark (max + slack) do we roll it back to `max`, so the
  // O(n) atomic rewrite amortizes to roughly once per `slack` writes.
  let pruned = null;
  if (autoPrune && existing.length + 1 > (pruneAt || max + 100)) {
    pruned = pruneActivity({ root, max });
  }
  return { ok: true, deduped: false, event: plan.event, path, relPath: ACTIVITY_SUBPATH, pruned };
}

// Retention/rollup: keep the most recent `max` events, rewritten atomically. The
// only path that rewrites the whole file (append is the normal path).
export function pruneActivity({ root = DEFAULT_ROOT, max = activityRetentionLimit() } = {}) {
  const path = activityAbsPath(root);
  if (!existsSync(path)) return { ok: true, kept: 0, dropped: 0 };
  const events = readActivity({ root });
  if (events.length <= max) return { ok: true, kept: events.length, dropped: 0 };
  // One-generation recovery window: this is the only path that destroys events, and
  // they are not git-recoverable, so snapshot the full file before the atomic rewrite.
  copyFileSync(path, `${path}.bak`);
  const kept = events.slice(events.length - max);
  atomicWriteFile(path, `${kept.map((e) => JSON.stringify(e)).join("\n")}\n`);
  return {
    ok: true,
    kept: kept.length,
    dropped: events.length - kept.length,
    backup: `${path}.bak`,
  };
}
