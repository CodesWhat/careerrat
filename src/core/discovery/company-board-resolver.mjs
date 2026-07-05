import { lookup as dnsLookup } from "node:dns/promises";
import { isIP } from "node:net";

import {
  companyBoardResolutionGet,
  companyBoardResolutionUpsert,
} from "../db/verbs/company-discovery.mjs";
import { inferProvider } from "../scoring/sourced-scanner.mjs";

export const COMPANY_DISCOVERY_BATCH_MAX = 12;
export const RESOLUTION_CACHE_TTL_DAYS = 14;
export const RESOLVER_FETCH_TIMEOUT_MS = 8000;
export const RESOLVER_REDIRECT_CAP = 3;
export const ZERO_JOB_REFRESH_THRESHOLD = 2;
export const RESOLUTION_FAILURE_REFRESH_THRESHOLD = 2;

export const REFRESH_REASONS = Object.freeze({
  EXPLICIT_REFRESH: "explicit-refresh",
  STALE_TTL: "stale-ttl",
  HTTP_403: "http-403",
  HTTP_404: "http-404",
  REDIRECT_PROVIDER_CHANGE: "redirect-provider-change",
  PROVIDER_CHANGE: "provider-change",
  ZERO_JOBS_THRESHOLD: "zero-jobs-threshold",
  FAILED_EXTRACTION: "failed-extraction",
  RESOLVER_FAILURE_THRESHOLD: "resolver-failure-threshold",
  MANUAL_REVIEW: "manual-review",
});

const SCAN_REFRESH_REASONS = new Set([
  REFRESH_REASONS.HTTP_403,
  REFRESH_REASONS.HTTP_404,
  REFRESH_REASONS.REDIRECT_PROVIDER_CHANGE,
  REFRESH_REASONS.PROVIDER_CHANGE,
  REFRESH_REASONS.FAILED_EXTRACTION,
]);

function makeError(message, code) {
  const err = new Error(message);
  err.code = code;
  return err;
}

function nowDate(now) {
  if (now instanceof Date) return now;
  if (typeof now === "string" || typeof now === "number") return new Date(now);
  return new Date();
}

function nowIso(now) {
  return nowDate(now).toISOString();
}

export function normalizeCompanyKey(value = "") {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function stripBrackets(host = "") {
  return String(host || "")
    .trim()
    .replace(/^\[/, "")
    .replace(/\]$/, "")
    .toLowerCase();
}

function isPrivateIpv4(host) {
  const octets = host.split(".").map((part) => Number(part));
  if (octets.length !== 4 || octets.some((part) => !Number.isInteger(part))) return false;
  const [a, b] = octets;
  if (a === 0 || a === 10 || a === 127) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  return false;
}

function isPrivateIpv6(host) {
  const normalized = stripBrackets(host);
  if (!normalized) return false;
  if (normalized === "::" || normalized === "::1" || normalized === "0:0:0:0:0:0:0:1") {
    return true;
  }
  if (normalized.startsWith("fc") || normalized.startsWith("fd")) return true;
  if (/^fe[89ab]/.test(normalized)) return true;
  const mapped = normalized.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  return mapped ? isPrivateIpv4(mapped[1]) : false;
}

export function isPrivateOrLocalHost(host = "") {
  const normalized = stripBrackets(host);
  if (!normalized) return true;
  if (normalized === "localhost" || normalized.endsWith(".localhost")) return true;
  if (isIP(normalized) === 4) return isPrivateIpv4(normalized);
  if (isIP(normalized) === 6) return isPrivateIpv6(normalized);
  return false;
}

function hostLike(value) {
  return /^(?:\[?[a-f0-9:.]+\]?|[a-z0-9.-]+)(?::\d+)?(?:[/?#].*)?$/i.test(value);
}

function parseHintUrl(value) {
  const text = String(value || "").trim();
  if (!text) return null;
  const withProtocol = /^[a-z][a-z0-9+.-]*:/i.test(text) ? text : null;
  const raw = withProtocol || (hostLike(text) ? `https://${text}` : "");
  if (!raw) return null;
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw makeError(`invalid company board URL hint: ${text}`, "UNSAFE_COMPANY_BOARD_URL");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw makeError(
      `unsupported company board URL scheme: ${url.protocol}`,
      "UNSAFE_COMPANY_BOARD_URL"
    );
  }
  return url;
}

function seedHint(seed = {}) {
  return seed.job_board_url || seed.careers_url || seed.domain_hint || "";
}

function domainFromUrl(url) {
  return stripBrackets(url.hostname);
}

function directProvider(url) {
  return inferProvider({ careers_url: url.toString() });
}

function apiUrlForProvider(provider, url) {
  const parts = url.pathname.split("/").filter(Boolean);
  const slug = parts[0] || "";
  if (!slug) return "";
  if (provider === "ashby") {
    return `https://api.ashbyhq.com/posting-api/job-board/${slug}?includeCompensation=true`;
  }
  if (provider === "greenhouse") {
    return `https://boards-api.greenhouse.io/v1/boards/${slug}/jobs`;
  }
  if (provider === "lever") return `https://api.lever.co/v0/postings/${slug}`;
  if (provider === "workable") return `https://apply.workable.com/${slug}/jobs.md`;
  if (provider === "smartrecruiters") {
    return `https://api.smartrecruiters.com/v1/companies/${slug}/postings?limit=100&offset=0&status=PUBLIC`;
  }
  return "";
}

function provenance(source, url, observedAt, extra = {}) {
  return { source, url: url.toString(), observed_at: observedAt, ...extra };
}

async function defaultLookupHost(host) {
  return dnsLookup(host, { all: true, verbatim: true });
}

function lookupAddresses(result) {
  if (!result) return [];
  const values = Array.isArray(result) ? result : [result];
  return values
    .map((item) => (typeof item === "string" ? item : item?.address))
    .filter((address) => typeof address === "string" && address.trim());
}

async function assertSafeUrl(url, { lookupHost = defaultLookupHost } = {}) {
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw makeError(
      `unsupported company board URL scheme: ${url.protocol}`,
      "UNSAFE_COMPANY_BOARD_URL"
    );
  }
  const host = url.hostname;
  if (isPrivateOrLocalHost(host)) {
    throw makeError(`unsafe local/private company board host: ${host}`, "UNSAFE_COMPANY_BOARD_URL");
  }
  if (lookupHost) {
    const addresses = lookupAddresses(await lookupHost(host));
    if (addresses.some(isPrivateOrLocalHost)) {
      throw makeError(
        `company board host resolves to local/private address: ${host}`,
        "UNSAFE_COMPANY_BOARD_URL"
      );
    }
  }
}

async function fetchWithTimeout(url, fetchImpl, timeoutMs) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetchImpl(url.toString(), {
      signal: controller.signal,
      redirect: "manual",
    });
  } finally {
    clearTimeout(timeout);
  }
}

function redirectTarget(response, currentUrl) {
  if (response.status < 300 || response.status > 399) return null;
  const location = response.headers?.get?.("location");
  return location ? new URL(location, currentUrl) : null;
}

function decodeAttribute(value = "") {
  return String(value || "")
    .replace(/&amp;/g, "&")
    .trim();
}

function extractLinks(html = "", baseUrl) {
  const links = [];
  const seen = new Set();
  const hrefPattern = /href\s*=\s*(?:"([^"]+)"|'([^']+)'|([^>\s]+))/gi;
  for (const match of String(html).matchAll(hrefPattern)) {
    const href = decodeAttribute(match[1] || match[2] || match[3] || "");
    if (!href || href.startsWith("#") || /^mailto:|^tel:/i.test(href)) continue;
    let url;
    try {
      url = new URL(href, baseUrl);
    } catch {
      continue;
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") continue;
    if (seen.has(url.toString())) continue;
    seen.add(url.toString());
    links.push(url);
  }
  return links.sort((a, b) => linkPriority(a) - linkPriority(b));
}

function linkPriority(url) {
  if (directProvider(url)) return 0;
  if (/\b(careers?|jobs?|openings?|join-us)\b/i.test(url.pathname)) return 1;
  return 10;
}

function supportedResult({ seed, url, provider, observedAt, provenance: proof }) {
  const companyName = String(seed?.name || "").trim();
  const companyKey = normalizeCompanyKey(companyName);
  const companyDomain = domainFromUrl(url);
  return {
    ok: true,
    status: "supported_ats",
    companyKey,
    companyName,
    companyDomain,
    careersUrl: url.toString(),
    jobBoardUrl: url.toString(),
    atsProvider: provider,
    apiUrl: apiUrlForProvider(provider, url),
    confidence: "high",
    provenance: proof,
    proposedAction: "approve-supported-ats",
    promotable: true,
  };
}

function unsupportedResult({ seed, url, observedAt, provenance: proof }) {
  const companyName = String(seed?.name || "").trim();
  const companyKey = normalizeCompanyKey(companyName);
  return {
    ok: true,
    status: "unsupported_public",
    companyKey,
    companyName,
    companyDomain: domainFromUrl(url),
    careersUrl: url.toString(),
    jobBoardUrl: "",
    atsProvider: null,
    apiUrl: "",
    confidence: "low",
    provenance: [...proof, provenance("public-page-cache", url, observedAt)],
    proposedAction: "cache-only",
    promotable: false,
  };
}

function cacheRecordFromResult(result, { existing = null, observedAt }) {
  return {
    company_key: result.companyKey,
    company_name: result.companyName,
    company_domain: result.companyDomain,
    careers_url: result.careersUrl,
    job_board_url: result.jobBoardUrl,
    ats_provider: result.atsProvider,
    api_url: result.apiUrl,
    confidence: result.confidence,
    provenance: result.provenance,
    first_resolved_at: existing?.first_resolved_at || observedAt,
    last_verified_at: observedAt,
    last_scan_result: existing?.last_scan_result || {
      status: result.status === "supported_ats" ? "resolved" : "unsupported-public",
    },
    failure_count: 0,
    zero_job_count: 0,
    next_refresh_reason: null,
    status: result.status,
    proposed_action: result.proposedAction,
    promotable: result.promotable,
  };
}

function resultFromCache(record) {
  if (!record) return null;
  return {
    ok: true,
    status: record.status || "unresolved",
    companyKey: record.company_key,
    companyName: record.company_name,
    companyDomain: record.company_domain || "",
    careersUrl: record.careers_url || "",
    jobBoardUrl: record.job_board_url || "",
    atsProvider: record.ats_provider || null,
    apiUrl: record.api_url || "",
    confidence: record.confidence || "low",
    provenance: Array.isArray(record.provenance)
      ? [
          { source: "cache-hit", url: record.job_board_url || record.careers_url || "" },
          ...record.provenance,
        ]
      : [{ source: "cache-hit", url: record.job_board_url || record.careers_url || "" }],
    proposedAction:
      record.proposed_action ||
      (record.status === "supported_ats" ? "approve-supported-ats" : "cache-only"),
    promotable: Boolean(record.promotable ?? record.status === "supported_ats"),
  };
}

function readCachedResolution({ repoRoot, env, companyKey, companyDomain }) {
  if (!repoRoot) return null;
  const byKey = companyBoardResolutionGet({ repoRoot, env, companyKey }).resolution;
  if (byKey || !companyDomain) return byKey;
  return companyBoardResolutionGet({ repoRoot, env, companyDomain }).resolution;
}

function writeCachedResolution({ repoRoot, env, result, existing, observedAt }) {
  if (!repoRoot) return result;
  companyBoardResolutionUpsert({
    repoRoot,
    env,
    resolution: cacheRecordFromResult(result, { existing, observedAt }),
  });
  return result;
}

function scanReason(resolution = {}) {
  const status = String(resolution.last_scan_result?.status || resolution.status || "");
  return SCAN_REFRESH_REASONS.has(status) ? status : null;
}

export function resolutionNeedsRefresh(
  resolution,
  { forceRefresh = false, now = new Date() } = {}
) {
  if (forceRefresh) return { needed: true, reason: REFRESH_REASONS.EXPLICIT_REFRESH };
  if (!resolution) return { needed: true, reason: REFRESH_REASONS.EXPLICIT_REFRESH };
  if (resolution.next_refresh_reason) {
    return { needed: true, reason: String(resolution.next_refresh_reason) };
  }
  if (Number(resolution.failure_count || 0) >= RESOLUTION_FAILURE_REFRESH_THRESHOLD) {
    return { needed: true, reason: REFRESH_REASONS.RESOLVER_FAILURE_THRESHOLD };
  }
  const scan = scanReason(resolution);
  if (scan) return { needed: true, reason: scan };
  const verified = Date.parse(resolution.last_verified_at || "");
  const ageMs = nowDate(now).getTime() - verified;
  if (!Number.isFinite(verified) || ageMs >= RESOLUTION_CACHE_TTL_DAYS * 24 * 60 * 60 * 1000) {
    return { needed: true, reason: REFRESH_REASONS.STALE_TTL };
  }
  if (Number(resolution.zero_job_count || 0) >= ZERO_JOB_REFRESH_THRESHOLD) {
    return { needed: true, reason: REFRESH_REASONS.ZERO_JOBS_THRESHOLD };
  }
  return { needed: false, reason: null };
}

async function resolveSupportedUrl({
  seed,
  url,
  observedAt,
  proof,
  lookupHost,
  fetchImpl,
  timeoutMs,
  depth,
  visited,
}) {
  await assertSafeUrl(url, { lookupHost });
  const provider = directProvider(url);
  if (provider) {
    return supportedResult({
      seed,
      url,
      provider,
      observedAt,
      provenance: [
        ...proof,
        provenance(depth === 0 ? "supported-ats-hint" : "homepage-link", url, observedAt),
      ],
    });
  }

  if (depth >= RESOLVER_REDIRECT_CAP) {
    return unsupportedResult({ seed, url, observedAt, provenance: proof });
  }

  if (visited.has(url.toString())) {
    return unsupportedResult({ seed, url, observedAt, provenance: proof });
  }
  visited.add(url.toString());

  const response = await fetchWithTimeout(url, fetchImpl, timeoutMs);
  const redirected = redirectTarget(response, url);
  if (redirected) {
    await assertSafeUrl(redirected, { lookupHost });
    return resolveSupportedUrl({
      seed,
      url: redirected,
      observedAt,
      proof: [
        ...proof,
        provenance("redirect", url, observedAt, {
          to: redirected.toString(),
          status: response.status,
        }),
      ],
      lookupHost,
      fetchImpl,
      timeoutMs,
      depth: depth + 1,
      visited,
    });
  }

  if (!response.ok) {
    throw makeError(
      `company board fetch returned HTTP ${response.status}`,
      "COMPANY_BOARD_FETCH_FAILED"
    );
  }

  const text = await response.text();
  const pageProof = [...proof, provenance("public-page-fetch", url, observedAt)];
  for (const link of extractLinks(text, url)) {
    await assertSafeUrl(link, { lookupHost });
    const provider = directProvider(link);
    if (provider) {
      return supportedResult({
        seed,
        url: link,
        provider,
        observedAt,
        provenance: [...pageProof, provenance("homepage-link", link, observedAt)],
      });
    }
  }

  for (const link of extractLinks(text, url).filter((candidate) => linkPriority(candidate) < 10)) {
    const result = await resolveSupportedUrl({
      seed,
      url: link,
      observedAt,
      proof: [...pageProof, provenance("homepage-link", link, observedAt)],
      lookupHost,
      fetchImpl,
      timeoutMs,
      depth: depth + 1,
      visited,
    });
    if (result.status === "supported_ats") return result;
  }

  return unsupportedResult({ seed, url, observedAt, provenance: pageProof });
}

export async function resolveCompanyBoard({
  repoRoot,
  env,
  seed,
  fetchImpl = fetch,
  lookupHost = defaultLookupHost,
  forceRefresh = false,
  now = new Date(),
  timeoutMs = RESOLVER_FETCH_TIMEOUT_MS,
} = {}) {
  const companyName = String(seed?.name || "").trim();
  const companyKey = normalizeCompanyKey(companyName);
  if (!companyKey) {
    throw makeError("company board resolver requires a company name", "BAD_REQUEST");
  }

  const hintUrl = parseHintUrl(seedHint(seed));
  if (!hintUrl) {
    throw makeError(
      "company seed requires a URL or domain hint for deterministic resolution",
      "UNRESOLVED_COMPANY_BOARD"
    );
  }
  const companyDomain = domainFromUrl(hintUrl);
  const existing = readCachedResolution({ repoRoot, env, companyKey, companyDomain });
  if (existing && !resolutionNeedsRefresh(existing, { forceRefresh, now }).needed) {
    return resultFromCache(existing);
  }

  const observedAt = nowIso(now);
  const result = await resolveSupportedUrl({
    seed,
    url: hintUrl,
    observedAt,
    proof: [provenance("seed-url-hint", hintUrl, observedAt)],
    lookupHost,
    fetchImpl,
    timeoutMs,
    depth: 0,
    visited: new Set(),
  });

  return writeCachedResolution({ repoRoot, env, result, existing, observedAt });
}
