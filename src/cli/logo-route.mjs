// logo-route.mjs — M8's onboarding-wizard Companies step: a server-side proxy
// in front of logo.dev's Brand Search + image CDN, so the wizard's
// company-name type-ahead never needs to hold a logo.dev credential
// client-side, and never re-hits the network for a query/domain it already
// resolved. Split out the same way search-route.mjs/packet-route.mjs were:
// `addRoute` is the mount point, `sendJson` is imported from
// skill-run-route.mjs rather than duplicated, `fetchImpl` is
// dependency-injected the same way mountSearchRoutes's is, defaulting to the
// real global `fetch` so tests can drive both routes against a stub network.
//
// mountLogoRoutes({addRoute, repoRoot, env, fetchImpl}) registers:
//
//   GET /api/logos/search?q=<query>    Brand Search proxy. Cached (in-memory
//                                      + workspace/logos/search-cache.json,
//                                      TTL 7d). No secret key configured →
//                                      200 {ok:false, reason:"no-token",
//                                      results:[]} (never an error status —
//                                      the wizard falls back to manual entry
//                                      + initials).
//   GET /api/logos/img?domain=<host>   Image CDN proxy. Serves
//   GET /api/logos/img?name=<company>
//                                      workspace/logos/<sanitized>.webp from
//                                      disk if already cached; otherwise
//                                      fetches img.logo.dev, caches, serves.
//                                      404 on a miss (the client's existing
//                                      <img onerror> → initials-chip fallback
//                                      fires either way, unchanged).
//
// TWO DIFFERENT LOGO.DEV CREDENTIALS — verified live against logo.dev's own
// docs during implementation (the M8 design doc had flagged this auth shape
// as unverified/assumed; it turned out to differ from the assumption, so
// this is a real, load-bearing correction, not a stylistic choice):
//   - img.logo.dev (the image CDN) takes a PUBLISHABLE key as a `?token=`
//     query param. /api/logos/img prefers an explicit
//     `candidate/automation.yml#integrations.logo_dev_token` or
//     CAREERRAT_LOGO_DEV_TOKEN override, then falls back to CareerRat's built-in
//     publishable key so image lookup works out of the box and still caches
//     locally.
//   - api.logo.dev/search (Brand Search) instead requires a SEPARATE SECRET
//     key via an `Authorization: Bearer <secret>` header — logo.dev's own
//     docs are explicit that publishable keys "only work with img.logo.dev"
//     and secret keys are "required for search, describe, and other API
//     endpoints." The existing `logo_dev_token` field is the WRONG
//     credential type for Brand Search; reusing it as designed would 401
//     against the real API. This file reads a NEW, separate field,
//     `candidate/automation.yml#integrations.logo_dev_secret_key` (plus an
//     env override, CAREERRAT_LOGO_DEV_SECRET_KEY, since no candidate write
//     path for it exists yet — adding one is Builder B/wizard territory,
//     out of this scope). Absent → the same graceful
//     `{ok:false, reason:"no-token"}` degrade the frozen contract already
//     specifies for "no token", just keyed off the secret rather than the
//     publishable credential.
//   - Brand Search's own response embeds a `logo_url` built from WHATEVER
//     key resolved the search server-side (not necessarily this
//     candidate's own publishable token) — this proxy strips it from the
//     results it returns (keeping only `name`/`domain`) so the wizard always
//     resolves the actual image through /api/logos/img instead, which is
//     guaranteed to use the candidate's own configured, cached credential.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { userPath } from "../core/paths/workspace.mjs";
import { loadCandidateDoc } from "../core/profile/config-store.mjs";
import { demoLogoFilePath } from "../core/tracker/demo-logos.mjs";
import { sendJson } from "./skill-run-route.mjs";

const SEARCH_CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // ~7 days, per the frozen contract.
const SEARCH_API_ORIGIN = "https://api.logo.dev/search";
const IMAGE_CDN_ORIGIN = "https://img.logo.dev";
const IMAGE_CACHE_EXT = "webp";
export const DEFAULT_LOGO_DEV_PUBLIC_KEY = "pk_SgppRPhNTWqQdH-WZX5BWA";

function queryParam(req, name) {
  const url = new URL(req.url, "http://127.0.0.1");
  return url.searchParams.get(name);
}

// ---------------------------------------------------------------------------
// Credential resolution — candidate/automation.yml, same nested/flat
// fallback shape settings-snapshot.mjs already uses for logo_dev_token (see
// this file's header comment for why Brand Search needs a second field).
// ---------------------------------------------------------------------------

function readAutomationDoc(pathCtx) {
  try {
    return loadCandidateDoc("automation", pathCtx) || {};
  } catch {
    return {};
  }
}

export function resolveLogoTokens(pathCtx, env = process.env) {
  const automation = readAutomationDoc(pathCtx);
  const publishableToken =
    String(env.CAREERRAT_LOGO_DEV_TOKEN || "").trim() ||
    automation?.integrations?.logo_dev_token ||
    automation?.logo_dev_token ||
    DEFAULT_LOGO_DEV_PUBLIC_KEY;
  const secretKey =
    String(env.CAREERRAT_LOGO_DEV_SECRET_KEY || "").trim() ||
    automation?.integrations?.logo_dev_secret_key ||
    automation?.logo_dev_secret_key ||
    "";
  return { publishableToken: String(publishableToken || ""), secretKey: String(secretKey || "") };
}

// ---------------------------------------------------------------------------
// Traversal-safe domain → cache-filename sanitizer. Unlike
// onboard-route.mjs's sanitizeUploadFilename (which always returns SOME
// usable name), a suspicious "domain" here returns null and the caller
// treats it exactly like a cache/upstream miss (404) — a company domain
// never legitimately needs a path separator or "..", so there's no
// legitimate input this could be rejecting.
// ---------------------------------------------------------------------------

export function sanitizeDomainForCache(domain) {
  const trimmed = String(domain || "")
    .trim()
    .toLowerCase();
  if (!trimmed) return null;
  if (trimmed.includes("/") || trimmed.includes("\\") || trimmed.includes("..")) return null;
  const cleaned = trimmed.replace(/[^a-z0-9.-]/g, "");
  if (!cleaned || cleaned.startsWith(".") || cleaned.startsWith("-")) return null;
  return cleaned;
}

export function sanitizeNameForCache(name) {
  const trimmed = String(name || "")
    .trim()
    .toLowerCase();
  if (!trimmed) return null;
  if (trimmed.includes("/") || trimmed.includes("\\") || trimmed.includes("..")) return null;
  const cleaned = trimmed
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return cleaned || null;
}

function imageLookupFromRequest(req) {
  const theme = queryParam(req, "theme") === "dark" ? "dark" : "";
  const rawDomain = queryParam(req, "domain");
  if (rawDomain?.trim()) {
    const sanitized = sanitizeDomainForCache(rawDomain);
    if (!sanitized) return { ok: false, status: 404, error: "no logo for this domain" };
    return {
      ok: true,
      cacheName: sanitized,
      upstreamPath: encodeURIComponent(sanitized),
      theme,
    };
  }

  const rawName = queryParam(req, "name");
  if (rawName?.trim()) {
    const sanitized = sanitizeNameForCache(rawName);
    if (!sanitized) return { ok: false, status: 404, error: "no logo for this company" };
    return {
      ok: true,
      cacheName: `name-${sanitized}`,
      upstreamPath: `name/${encodeURIComponent(rawName.trim())}`,
      theme,
    };
  }

  return { ok: false, status: 400, error: "?domain= or ?name= is required" };
}

// ---------------------------------------------------------------------------
// Search cache — in-memory (fast path, this process's lifetime) backed by
// workspace/logos/search-cache.json (survives a server restart). Keyed by
// the normalized (trimmed, lowercased) query string.
// ---------------------------------------------------------------------------

function loadSearchCacheFile(cachePath) {
  if (!existsSync(cachePath)) return {};
  try {
    const parsed = JSON.parse(readFileSync(cachePath, "utf8"));
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function saveSearchCacheFile(cachePath, cache) {
  mkdirSync(dirname(cachePath), { recursive: true });
  writeFileSync(cachePath, JSON.stringify(cache, null, 2));
}

// ---------------------------------------------------------------------------
// mountLogoRoutes
// ---------------------------------------------------------------------------

export function mountLogoRoutes({ addRoute, repoRoot, env = process.env, fetchImpl = fetch }) {
  const pathCtx = { repoRoot };
  const memoryCache = new Map(); // query -> { results, expiresAt }

  // -------------------------------------------------------------------------
  // GET /api/logos/search?q=<query>
  // -------------------------------------------------------------------------
  addRoute("GET", "/api/logos/search", async (req, res) => {
    const rawQuery = (queryParam(req, "q") || "").trim();
    if (!rawQuery) {
      sendJson(res, 400, { error: "?q= is required" });
      return;
    }

    const { secretKey } = resolveLogoTokens(pathCtx, env);
    if (!secretKey) {
      sendJson(res, 200, { ok: false, reason: "no-token", results: [] });
      return;
    }

    const cacheKey = rawQuery.toLowerCase();
    const now = Date.now();

    const memHit = memoryCache.get(cacheKey);
    if (memHit && memHit.expiresAt > now) {
      sendJson(res, 200, { ok: true, results: memHit.results });
      return;
    }

    const cachePath = userPath(pathCtx, "workspace/logos/search-cache.json");
    const diskCache = loadSearchCacheFile(cachePath);
    const diskHit = diskCache[cacheKey];
    if (diskHit && diskHit.expiresAt > now) {
      memoryCache.set(cacheKey, diskHit);
      sendJson(res, 200, { ok: true, results: diskHit.results });
      return;
    }

    // NEVER call logo.dev with candidate PII — `rawQuery` is the literal
    // user-typed company string, nothing else is ever mixed in.
    let upstream;
    try {
      upstream = await fetchImpl(`${SEARCH_API_ORIGIN}?q=${encodeURIComponent(rawQuery)}`, {
        headers: { Authorization: `Bearer ${secretKey}` },
      });
    } catch (err) {
      sendJson(res, 200, { ok: false, reason: "upstream-error", results: [], error: err.message });
      return;
    }

    if (!upstream.ok) {
      sendJson(res, 200, {
        ok: false,
        reason: "upstream-error",
        results: [],
        status: upstream.status,
      });
      return;
    }

    let payload;
    try {
      payload = await upstream.json();
    } catch (err) {
      sendJson(res, 200, { ok: false, reason: "upstream-error", results: [], error: err.message });
      return;
    }

    // Project down to {name, domain} only — never pass through logo.dev's
    // own `logo_url` (it embeds whichever credential resolved the search,
    // not necessarily this candidate's own token; see this file's header
    // comment). The wizard resolves the actual image via /api/logos/img.
    const items = Array.isArray(payload) ? payload : [];
    const results = items
      .map((item) => ({
        name: typeof item?.name === "string" ? item.name : null,
        domain: typeof item?.domain === "string" ? item.domain : null,
      }))
      .filter((item) => item.name || item.domain);

    const entry = { results, expiresAt: now + SEARCH_CACHE_TTL_MS };
    memoryCache.set(cacheKey, entry);
    diskCache[cacheKey] = entry;
    try {
      saveSearchCacheFile(cachePath, diskCache);
    } catch {
      // Best-effort persistence only — the in-memory cache still works for
      // this process's lifetime even if the disk write fails (e.g. a
      // read-only filesystem).
    }

    sendJson(res, 200, { ok: true, results });
  });

  // -------------------------------------------------------------------------
  // GET /api/logos/img?domain=<host>
  // GET /api/logos/img?name=<company>
  // -------------------------------------------------------------------------
  addRoute("GET", "/api/logos/img", async (req, res) => {
    // Bundled franchise logos win over logo.dev. The SPA sends ?name= alongside
    // ?domain= (see logoImageUrl), so a seeded fictional company resolves to its
    // local mark here instead of logo.dev's wrong real-company guess (e.g.
    // "Buy n Large" → Disney) or an initials fallback. Unknown names fall through
    // to the normal domain/name → logo.dev resolution untouched.
    const demoPath = demoLogoFilePath(queryParam(req, "name"));
    if (demoPath && existsSync(demoPath)) {
      try {
        const bytes = readFileSync(demoPath);
        res.writeHead(200, {
          "Content-Type": "image/png",
          "Cache-Control": "public, max-age=604800, immutable",
        });
        res.end(bytes);
        return;
      } catch {
        // Unreadable bundled asset — fall through to normal resolution.
      }
    }

    const lookup = imageLookupFromRequest(req);
    if (!lookup.ok) {
      sendJson(res, lookup.status, { error: lookup.error });
      return;
    }

    const themedCacheName = lookup.theme ? `${lookup.cacheName}-${lookup.theme}` : lookup.cacheName;
    const cachePath = userPath(pathCtx, `workspace/logos/${themedCacheName}.${IMAGE_CACHE_EXT}`);
    if (existsSync(cachePath)) {
      let bytes;
      try {
        bytes = readFileSync(cachePath);
      } catch {
        sendJson(res, 404, { error: "no logo for this domain" });
        return;
      }
      res.writeHead(200, {
        "Content-Type": `image/${IMAGE_CACHE_EXT}`,
        "Cache-Control": "public, max-age=604800, immutable",
      });
      res.end(bytes);
      return;
    }

    const { publishableToken } = resolveLogoTokens(pathCtx, env);
    const upstreamUrl =
      `${IMAGE_CDN_ORIGIN}/${lookup.upstreamPath}` +
      `?token=${encodeURIComponent(publishableToken)}&format=${IMAGE_CACHE_EXT}&fallback=404` +
      (lookup.theme ? `&theme=${encodeURIComponent(lookup.theme)}` : "");

    let upstream;
    try {
      upstream = await fetchImpl(upstreamUrl);
    } catch {
      sendJson(res, 404, { error: "no logo for this domain" });
      return;
    }

    if (!upstream.ok) {
      sendJson(res, 404, { error: "no logo for this domain" });
      return;
    }

    let bytes;
    try {
      const arrayBuffer = await upstream.arrayBuffer();
      bytes = Buffer.from(arrayBuffer);
    } catch {
      sendJson(res, 404, { error: "no logo for this domain" });
      return;
    }

    try {
      mkdirSync(dirname(cachePath), { recursive: true });
      writeFileSync(cachePath, bytes);
    } catch {
      // Best-effort caching only — still serve the bytes we already have
      // even if the write fails (e.g. a read-only filesystem).
    }

    res.writeHead(200, {
      "Content-Type": `image/${IMAGE_CACHE_EXT}`,
      "Cache-Control": "public, max-age=604800, immutable",
    });
    res.end(bytes);
  });
}
