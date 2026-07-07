// usage-log.mjs — the P0-6 substrate: a JSONL ledger of metered AI usage.
//
// Mirrors activity-log.mjs's append/read/prune shape (src/core/tracker/activity-log.mjs
// is the explicit model), but the payload is pure telemetry — a model id, token
// counts, a cost estimate — never a prompt, a JD, or a resume. That split matters:
// this is the one place both the managed-AI proxy (src/cli/ai-proxy.mjs) and the
// BYOK path of callAI() (call-ai.mjs) write a row after a request completes, and
// it has to be safe to read back for billing without ever having stored what the
// candidate asked the model.
//
//   - **Append-only JSONL** at `workspace/usage-events.jsonl`. No dedupe: every
//     completed request is a real, billable event, so (unlike activity-log's
//     content-derived id) each row gets its own random id — two identical-looking
//     requests are still two rows, on purpose.
//   - **Cost is computed here, not trusted from the caller.** Both write call
//     sites hand in a model id + raw token counts; computeCost() is the one
//     pricing table, so the proxy and the BYOK path can never drift on price.
//   - **Never fabricate a price.** An unrecognized model id gets cost_usd:null,
//     priced:false — not a guess.
//
// The pure helpers (canonicalizeUsageEvent, computeCost, resolveRate) are
// unit-testable with no fs; readUsageEvents/appendUsageEvent/pruneUsageEvents are
// the thin fs touchpoints, same split as activity-log.mjs.

import { randomUUID } from "node:crypto";
import { appendFileSync, copyFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { userPath } from "../paths/workspace.mjs";
import { atomicWriteFile } from "../profile/gate-writer.mjs";

// Repo-root default (this file lives at src/core/ai/, same depth as
// src/core/tracker/ — activity-log.mjs's own DEFAULT_ROOT derivation).
const DEFAULT_ROOT = fileURLToPath(new URL("../../..", import.meta.url));

// Gitignored runtime data, never committed — same as the activity feed.
export const USAGE_LOG_SUBPATH = "workspace/usage-events.jsonl";

export const USAGE_SOURCES = ["proxy", "byok"];

const FEATURE_BY_OPERATION_PREFIX = [
  ["onboard.resume-ai", "onboarding.resume-ingestion"],
  ["assist.suggest.", "onboarding.targeting-assist"],
  ["company-seeds", "company-discovery"],
  ["public-scanner", "company-discovery"],
  ["onboard.", "onboarding"],
];

const FEATURE_BY_SKILL = {
  assist: "onboarding.targeting-assist",
  "resume-extract": "onboarding.resume-ingestion",
  "discover-companies": "company-discovery",
  "research-boards": "source-discovery",
  "setup-searches": "source-discovery",
  "search-jobs": "job-search",
  "evaluate-job": "job-evaluation",
  "apply-job": "application-workflow",
  "tailor-application": "application-tailoring",
  "answer-question": "application-tailoring",
  "interview-prep": "interview-prep",
  "email-comms": "communications",
  "schedule-meeting": "communications",
  intake: "intake-triage",
};

export function usageLogAbsPath(root = DEFAULT_ROOT) {
  return userPath({ repoRoot: root }, USAGE_LOG_SUBPATH);
}

// ---------------------------------------------------------------------------
// Pricing — USD per million tokens (MTok). Cache reads price at 0.1x the
// model's input rate, cache writes (5-minute TTL, the default) at 1.25x —
// mirrors Anthropic's prompt-caching discount/surcharge. Overridable wholesale
// via ROLESTER_PRICING_JSON (JSON object of model -> {in, out}), merged over
// the defaults and read fresh on every call (not cached at module load) so a
// live env change — or a test setting process.env per-case — takes effect
// immediately.
// ---------------------------------------------------------------------------

const DEFAULT_PRICING = {
  "claude-sonnet-5": { in: 3, out: 15 },
  // NOTE: current Anthropic pricing (verified against the live model table, not
  // the historic Opus 3/4/4.1-era $15/$75 figure) — shipping the stale number
  // as a default would misprice every unoverridden Opus request.
  "claude-opus-4-8": { in: 5, out: 25 },
  "claude-haiku-4-5": { in: 1, out: 5 },
};

function loadPricingOverride(env) {
  const raw = String(env?.ROLESTER_PRICING_JSON || "").trim();
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null; // malformed override never crashes metering — fall back to defaults
  }
}

function pricingTable(env = process.env) {
  const override = loadPricingOverride(env);
  return override ? { ...DEFAULT_PRICING, ...override } : DEFAULT_PRICING;
}

// Longest-prefix match so a dated snapshot id ("claude-haiku-4-5-20251001")
// resolves to its family's rate ("claude-haiku-4-5"), exact match wins first.
function resolveRate(model, table) {
  const id = String(model || "");
  if (Object.hasOwn(table, id)) return table[id];
  let best = null;
  for (const key of Object.keys(table)) {
    if (id.startsWith(key) && (!best || key.length > best.length)) best = key;
  }
  return best ? table[best] : null;
}

export function computeCost(model, usage = {}, { env = process.env } = {}) {
  const rate = resolveRate(model, pricingTable(env));
  if (!rate) return { cost_usd: null, priced: false };

  const tokensIn = Number(usage.tokens_in) || 0;
  const tokensOut = Number(usage.tokens_out) || 0;
  const cacheRead = Number(usage.cache_read_tokens) || 0;
  const cacheCreation = Number(usage.cache_creation_tokens) || 0;

  const cost_usd =
    (tokensIn / 1_000_000) * rate.in +
    (tokensOut / 1_000_000) * rate.out +
    (cacheRead / 1_000_000) * (rate.in * 0.1) +
    (cacheCreation / 1_000_000) * (rate.in * 1.25);

  return { cost_usd, priced: true };
}

// ---------------------------------------------------------------------------
// Row shape
// ---------------------------------------------------------------------------

function trimOrNull(v) {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s === "" ? null : s;
}

function slugLabel(v) {
  return String(v || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function normalizeFeatureId(v) {
  const text = String(v || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9._:-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return text || null;
}

function nonNegInt(v) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.round(n) : 0;
}

export function deriveUsageFeature({ feature, skill, action, operation } = {}) {
  const explicit = normalizeFeatureId(feature);
  if (explicit) return explicit;

  const op = trimOrNull(operation);
  if (op) {
    for (const [prefix, featureId] of FEATURE_BY_OPERATION_PREFIX) {
      if (op.startsWith(prefix)) return featureId;
    }
  }

  const skillId = trimOrNull(skill);
  if (skillId && FEATURE_BY_SKILL[skillId]) return FEATURE_BY_SKILL[skillId];

  const skillSlug = slugLabel(skillId);
  if (skillSlug) return `skill.${skillSlug}`;

  const actionSlug = slugLabel(action);
  if (actionSlug) return `action.${actionSlug}`;

  return "unlabeled";
}

// Fill defaults, normalize token fields, compute cost — the single row shape
// both write call sites (call-ai.mjs BYOK path, ai-proxy.mjs metering) produce.
// Pure; `now`/`env` are injected for testability.
export function canonicalizeUsageEvent(input = {}, { now = new Date(), env = process.env } = {}) {
  const model = trimOrNull(input.model) || "unknown";
  const tokens_in = nonNegInt(input.tokens_in);
  const tokens_out = nonNegInt(input.tokens_out);
  const cache_read_tokens = nonNegInt(input.cache_read_tokens);
  const cache_creation_tokens = nonNegInt(input.cache_creation_tokens);
  const web_searches = nonNegInt(input.web_searches);
  const skill = trimOrNull(input.skill);
  const action = trimOrNull(input.action);
  const operation = trimOrNull(input.operation);
  const feature = deriveUsageFeature({ feature: input.feature, skill, action, operation });
  const { cost_usd, priced } = computeCost(
    model,
    { tokens_in, tokens_out, cache_read_tokens, cache_creation_tokens },
    { env }
  );

  return {
    id: trimOrNull(input.id) || `use_${randomUUID()}`,
    at: trimOrNull(input.at) || now.toISOString(),
    source: USAGE_SOURCES.includes(input.source) ? input.source : "byok",
    feature,
    skill,
    action,
    operation,
    model,
    // Upstream provider host (e.g. "ai-gateway.vercel.sh" / "api.anthropic.com")
    // — cost-drift visibility across providers. Optional; older rows written
    // before this field existed simply lack the key on read (readUsageEvents
    // parses each line as-is, no backfill).
    upstream: trimOrNull(input.upstream),
    tokens_in,
    tokens_out,
    cache_read_tokens,
    cache_creation_tokens,
    web_searches,
    shared_cache_hit: cache_read_tokens > 0,
    cost_usd,
    priced,
  };
}

function emptyUsageBucket(extra = {}) {
  return {
    ...extra,
    requests: 0,
    tokens_in: 0,
    tokens_out: 0,
    total_tokens: 0,
    cache_read_tokens: 0,
    cache_creation_tokens: 0,
    web_searches: 0,
    cost_usd: 0,
    unpriced_requests: 0,
  };
}

function addUsageToBucket(bucket, event) {
  bucket.requests += 1;
  bucket.tokens_in += nonNegInt(event.tokens_in);
  bucket.tokens_out += nonNegInt(event.tokens_out);
  bucket.total_tokens += nonNegInt(event.tokens_in) + nonNegInt(event.tokens_out);
  bucket.cache_read_tokens += nonNegInt(event.cache_read_tokens);
  bucket.cache_creation_tokens += nonNegInt(event.cache_creation_tokens);
  bucket.web_searches += nonNegInt(event.web_searches);
  if (event.priced && Number.isFinite(Number(event.cost_usd))) {
    bucket.cost_usd += Number(event.cost_usd);
  } else {
    bucket.unpriced_requests += 1;
  }
}

function usageSummaryEvent(raw = {}) {
  const skill = trimOrNull(raw.skill);
  const action = trimOrNull(raw.action);
  const operation = trimOrNull(raw.operation);
  return {
    ...raw,
    feature: deriveUsageFeature({ feature: raw.feature, skill, action, operation }),
    skill,
    action,
    operation,
  };
}

function sortUsageBuckets(a, b) {
  return (
    b.cost_usd - a.cost_usd ||
    b.tokens_in + b.tokens_out - (a.tokens_in + a.tokens_out) ||
    b.requests - a.requests ||
    String(a.feature || a.skill || "").localeCompare(String(b.feature || b.skill || ""))
  );
}

export function summarizeUsageEvents(events = []) {
  const totals = emptyUsageBucket();
  const byFeature = new Map();

  for (const raw of Array.isArray(events) ? events : []) {
    const event = usageSummaryEvent(raw);
    addUsageToBucket(totals, event);

    if (!byFeature.has(event.feature)) {
      byFeature.set(event.feature, {
        ...emptyUsageBucket({ feature: event.feature }),
        breakdown: new Map(),
      });
    }
    const featureBucket = byFeature.get(event.feature);
    addUsageToBucket(featureBucket, event);

    const detailKey = JSON.stringify([event.skill, event.action, event.operation]);
    if (!featureBucket.breakdown.has(detailKey)) {
      featureBucket.breakdown.set(
        detailKey,
        emptyUsageBucket({
          skill: event.skill,
          action: event.action,
          operation: event.operation,
        })
      );
    }
    addUsageToBucket(featureBucket.breakdown.get(detailKey), event);
  }

  return {
    totals,
    byFeature: Array.from(byFeature.values())
      .map((bucket) => ({
        ...bucket,
        breakdown: Array.from(bucket.breakdown.values()).sort(sortUsageBuckets),
      }))
      .sort(sortUsageBuckets),
  };
}

// ---------------------------------------------------------------------------
// fs touchpoints
// ---------------------------------------------------------------------------

// READ side: parse every line tolerantly — a half-written trailing line (crash
// mid-append) is skipped, never throws. Oldest-first (append order).
export function readUsageEvents({ root = DEFAULT_ROOT } = {}) {
  const path = usageLogAbsPath(root);
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

// Retention cap — a long-running proxy process could grow this unboundedly.
// Overridable via ROLESTER_USAGE_MAX; default generous since rows are tiny.
const DEFAULT_USAGE_MAX = Number(process.env.ROLESTER_USAGE_MAX) || 5000;

// WRITE side: append one usage row. No dedupe (see header) — every call is a
// real billable event.
export function appendUsageEvent(
  input,
  {
    root = DEFAULT_ROOT,
    now = new Date(),
    env = process.env,
    autoPrune = true,
    max = DEFAULT_USAGE_MAX,
    pruneAt = 0,
  } = {}
) {
  const event = canonicalizeUsageEvent(input, { now, env });
  const path = usageLogAbsPath(root);
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, `${JSON.stringify(event)}\n`, "utf8");

  let pruned = null;
  if (autoPrune) {
    const existing = readUsageEvents({ root });
    if (existing.length > (pruneAt || max + 500)) {
      pruned = pruneUsageEvents({ root, max });
    }
  }
  return { ok: true, event, path, relPath: USAGE_LOG_SUBPATH, pruned };
}

// Retention/rollup: keep the most recent `max` rows, rewritten atomically —
// the only path that rewrites the whole file (append is the normal path).
export function pruneUsageEvents({ root = DEFAULT_ROOT, max = DEFAULT_USAGE_MAX } = {}) {
  const path = usageLogAbsPath(root);
  if (!existsSync(path)) return { ok: true, kept: 0, dropped: 0 };
  const events = readUsageEvents({ root });
  if (events.length <= max) return { ok: true, kept: events.length, dropped: 0 };
  // One-generation recovery window before the destructive rewrite.
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
