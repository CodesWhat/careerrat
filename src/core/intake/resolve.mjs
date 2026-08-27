// resolve.mjs — deterministic (zero-AI) URL resolution for M9 Universal
// Intake. Reuses the exact per-ATS board fetchers + req-id/provider inference
// sourced-scanner.mjs already ships (no second implementation) and the same
// host/liveness classification job-link-checker.mjs/liveness-core.mjs already
// ship for the sourced-sweep liveness pass. A known-ATS posting URL resolves
// to a full JD body with zero model calls; an SPA-shell or login-gated host
// degrades to an honest "deferred" flag rather than a fake success or a
// silent empty body — the classify step (classify.mjs) receives that flag as
// context either way, never guesses past it.
//
// `fetchImpl` is always injected (defaults to the global fetch) so every path
// here is testable against a fake network, same convention
// sourced-scanner.mjs's own provider-fetch tests already use.

import { hostnameToPortal } from "../apply/form-fill.mjs";
import {
  extractApplyControlsFromHtml,
  htmlToText as htmlToTextLiveness,
  isSpaJobHost,
} from "../liveness/job-link-checker.mjs";
import { classifyLiveness } from "../liveness/liveness-core.mjs";
import { fetchPublicHttpText, validatePublicHttpUrl } from "../net/public-http-fetch.mjs";
import { platformForHost } from "../providers/search-sources.mjs";
import { extractReqId, fetchProvider, inferProvider } from "../scoring/sourced-scanner.mjs";
import { extractStructuredJobDescription } from "./job-posting-extract.mjs";

const DEFAULT_TIMEOUT_MS = 15000;
const DEFAULT_MAX_BYTES = 1024 * 1024;
const MIN_USABLE_BODY_CHARS = 40;
const CAPPED_PREVIEW_HOSTS = new Set(["remotevibecodingjobs.com", "www.remotevibecodingjobs.com"]);

// resolveJobUrl(url) -> {
//   bodyFetchStatus: "resolved" | "deferred",
//   url, provider, title, company, location, comp, bodyText, reason,
// }
export async function resolveJobUrl(
  rawUrl,
  {
    fetchImpl = fetch,
    resolveHost,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    maxBytes = DEFAULT_MAX_BYTES,
    signal,
    resolutionCache,
  } = {}
) {
  const cacheKey = exactResolutionKey(rawUrl);
  if (resolutionCache && cacheKey && resolutionCache.has(cacheKey)) {
    return resolutionCache.get(cacheKey);
  }
  const resolution = resolveJobUrlUncached(rawUrl, {
    fetchImpl,
    resolveHost,
    timeoutMs,
    maxBytes,
    signal,
    resolutionCache,
  });
  if (resolutionCache && cacheKey) resolutionCache.set(cacheKey, resolution);
  return resolution;
}

async function resolveJobUrlUncached(
  rawUrl,
  { fetchImpl, resolveHost, timeoutMs, maxBytes, signal, resolutionCache }
) {
  signal?.throwIfAborted();
  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return { bodyFetchStatus: "deferred", url: rawUrl, provider: null, reason: "invalid URL" };
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return {
      bodyFetchStatus: "deferred",
      url: rawUrl,
      provider: null,
      reason: `unsupported protocol ${parsed.protocol}`,
    };
  }

  const provider = inferProvider({ careers_url: rawUrl });
  let providerResolution = null;
  if (provider) {
    const resolved = await resolveViaProviderBoard({
      provider,
      url: rawUrl,
      fetchImpl,
      resolveHost,
      signal,
      resolutionCache,
    });
    if (resolved?.bodyText?.trim()) return resolved;
    providerResolution = resolved;
    // Known ATS, but this specific posting isn't on the company's current
    // board, or its list payload has no description. Fall through to the
    // posting page for full-JD recovery instead of treating an empty body as
    // resolved. SPA hosts still defer honestly to the session-browser path.
  }

  if (isSpaJobHost(parsed.hostname) || platformForHost(parsed.hostname)) {
    return mergeProviderMetadata(providerResolution, {
      bodyFetchStatus: "deferred",
      url: rawUrl,
      provider,
      reason:
        "SPA-rendered or login-gated host: no session browser available to a headless intake route; " +
        "evaluate-job's own STEP 0 browser-escalation path handles this once confirmed",
    });
  }

  const plain = await resolvePlainFetch({
    url: rawUrl,
    fetchImpl,
    resolveHost,
    timeoutMs,
    maxBytes,
    provider,
    signal,
    resolutionCache,
  });
  return mergeProviderMetadata(providerResolution, plain);
}

export async function hydrateJobOffer(
  offer,
  {
    fetchImpl = fetch,
    resolveHost,
    resolveJobUrlImpl = resolveJobUrl,
    force = false,
    rejectExpired = false,
    minBodyChars = MIN_USABLE_BODY_CHARS,
    signal,
    resolutionCache,
  } = {}
) {
  const existingBody = String(offer?.bodyText || offer?.description || offer?.rawText || "").trim();
  if (
    !offer?.url ||
    (!force && offer?.bodyPartial !== true && existingBody.length >= minBodyChars)
  ) {
    return offer;
  }

  let resolved;
  try {
    resolved = await resolveJobUrlImpl(offer.url, {
      fetchImpl,
      resolveHost,
      signal,
      resolutionCache,
    });
  } catch (error) {
    resolved = {
      bodyFetchStatus: "deferred",
      url: offer.url,
      reason: error?.message || "The job description could not be read.",
    };
  }
  const canonicalBody = String(resolved?.bodyText || "").trim();
  if (rejectExpired && resolved?.liveness?.result === "expired") {
    return {
      ...offer,
      ...(existingBody ? { bodyText: existingBody } : {}),
      bodyPartial: true,
      bodyFetchStatus: "unavailable",
      bodyFetchReason: resolved.liveness.reason || "The job posting is no longer available.",
    };
  }
  if (resolved?.bodyFetchStatus === "resolved" && canonicalBody.length >= minBodyChars) {
    const bodyPartial = resolved?.bodyPartial === true;
    return {
      ...offer,
      url: resolved.url || offer.url,
      location: preferredResolvedLocation(resolved.location, offer.location),
      comp: resolved.comp || offer.comp,
      bodyText: canonicalBody,
      bodyPartial,
      ...(bodyPartial && resolved?.reason ? { bodyFetchReason: resolved.reason } : {}),
      ...(resolved.provider ? { provider: resolved.provider } : {}),
      ...(resolved.url && resolved.url !== offer.url ? { capturedUrl: offer.url } : {}),
    };
  }

  return {
    ...offer,
    ...(existingBody ? { bodyText: existingBody } : {}),
    bodyPartial: true,
    bodyFetchStatus: "deferred",
    bodyFetchReason:
      resolved?.reason || "The full job description was not available from this source.",
  };
}

function preferredResolvedLocation(resolvedLocation, existingLocation) {
  const resolved = String(resolvedLocation || "").trim();
  const existing = String(existingLocation || "").trim();
  if (!resolved) return existingLocation;
  if (existing && /^\d[\d\s#./-]*$/u.test(resolved)) return existingLocation;
  return resolvedLocation;
}

function mergeProviderMetadata(providerResolution, result) {
  if (!providerResolution) return result;
  return {
    ...result,
    url: result.url || providerResolution.url,
    provider: result.provider || providerResolution.provider,
    title: result.title || providerResolution.title,
    company: result.company || providerResolution.company,
    location: result.location || providerResolution.location,
    comp: result.comp || providerResolution.comp,
  };
}

function isCappedPreviewUrl(value) {
  try {
    return CAPPED_PREVIEW_HOSTS.has(new URL(value).hostname.toLowerCase());
  } catch {
    return false;
  }
}

async function resolveViaProviderBoard({
  provider,
  url,
  fetchImpl,
  resolveHost,
  signal,
  resolutionCache,
}) {
  const targetReqId = extractReqId(url);
  let jobs;
  try {
    const cacheKey = providerBoardResolutionKey(provider, url);
    if (resolutionCache && cacheKey && resolutionCache.has(cacheKey)) {
      jobs = await resolutionCache.get(cacheKey);
    } else {
      const boardFetch = fetchProvider(
        provider,
        { careers_url: url, name: null },
        {
          fetchImpl,
          resolveHost,
          signal,
        }
      );
      if (resolutionCache && cacheKey) resolutionCache.set(cacheKey, boardFetch);
      jobs = await boardFetch;
    }
  } catch {
    return null;
  }
  const match = (jobs || []).find((job) => {
    if (!job.url) return false;
    if (job.url === url) return true;
    if (!targetReqId.id) return false;
    const jobReqId = extractReqId(job.url);
    return jobReqId.id === targetReqId.id;
  });
  if (!match) return null;

  return {
    bodyFetchStatus: "resolved",
    url: match.url || url,
    provider,
    title: match.title || null,
    company: match.company || fallbackCompanyFromUrl(url),
    location: match.location || null,
    comp: match.comp || null,
    bodyText: match.bodyText || "",
    bodyPartial: match.bodyPartial === true,
    reason:
      match.bodyPartial === true
        ? "The job description exceeded the provider capture safety limit."
        : null,
  };
}

function fallbackCompanyFromUrl(url) {
  try {
    const slug = new URL(url).pathname.split("/").filter(Boolean)[0] || "";
    const titleized = slug
      .split(/[-_]+/)
      .filter(Boolean)
      .map((part) => part[0].toUpperCase() + part.slice(1))
      .join(" ");
    return titleized || null;
  } catch {
    return null;
  }
}

async function resolvePlainFetch({
  url,
  fetchImpl,
  resolveHost,
  timeoutMs,
  maxBytes,
  provider,
  signal,
  resolutionCache,
}) {
  const fetched = await fetchPublicHttpText(url, {
    fetchImpl,
    resolveHost,
    timeoutMs,
    maxBytes,
    signal,
  });
  if (!fetched.ok) {
    const unsafe = fetched.code === "unsafe_url" || fetched.code === "unsafe_redirect";
    return {
      bodyFetchStatus: "deferred",
      url,
      provider,
      reason: unsafe ? `unsafe URL: ${fetched.reason}` : fetched.reason,
    };
  }

  const html = fetched.rawText;
  const bodyText = extractStructuredJobDescription(html) || htmlToTextLiveness(html);
  const cappedPreview = isCappedPreviewUrl(fetched.finalUrl || url);
  const classified = classifyLiveness({
    status: fetched.status,
    finalUrl: fetched.finalUrl || url,
    bodyText,
    applyControls: extractApplyControlsFromHtml(html),
  });

  if (classified.result === "expired" && classified.code !== "insufficient_content") {
    return {
      bodyFetchStatus: "resolved",
      url,
      provider,
      title: null,
      company: null,
      location: null,
      comp: null,
      bodyText,
      bodyPartial: cappedPreview,
      ...(cappedPreview
        ? { reason: "The source exposes a capped preview instead of the complete job description." }
        : {}),
      liveness: classified,
    };
  }

  const sourceReqId = extractReqId(url).id;
  for (const canonicalUrl of extractCanonicalAtsUrls(html, fetched.finalUrl || url)) {
    const canonicalProvider = inferProvider({ careers_url: canonicalUrl });
    if (!canonicalProvider) continue;
    if (sourceReqId && extractReqId(canonicalUrl).id !== sourceReqId) continue;
    const resolved = await resolveViaProviderBoard({
      provider: canonicalProvider,
      url: canonicalUrl,
      fetchImpl,
      resolveHost,
      signal,
      resolutionCache,
    });
    if (resolved?.bodyText?.trim()) {
      return { ...resolved, sourceUrl: url };
    }
  }
  const applicationUrl = extractEmbeddedApplicationUrl(html, fetched.finalUrl || url);

  if (classified.code === "insufficient_content" || classified.code === "bot_challenge") {
    return { bodyFetchStatus: "deferred", url, provider, reason: classified.reason };
  }

  // Even an "expired"-classified fetch still returns the text we got — an
  // honest "looks expired" signal for classify to reference, not a silent
  // empty body. Only the shell-content/bot-wall cases above defer entirely
  // (there's no usable text to hand the classify step at all).
  return {
    bodyFetchStatus: "resolved",
    url: applicationUrl || url,
    ...(applicationUrl ? { sourceUrl: url } : {}),
    provider,
    title: null,
    company: null,
    location: null,
    comp: null,
    bodyText,
    bodyPartial: cappedPreview,
    ...(cappedPreview
      ? { reason: "The source exposes a capped preview instead of the complete job description." }
      : {}),
    liveness: classified,
  };
}

function extractEmbeddedApplicationUrl(html, baseUrl) {
  const normalized = String(html || "")
    .replace(/&quot;/gi, '"')
    .replace(/&amp;/gi, "&")
    .replace(/\\u002f/gi, "/")
    .replace(/\\u0026/gi, "&")
    .replace(/\\\//g, "/")
    .replace(/\\"/g, '"');
  const current = normalizeComparableUrl(baseUrl);
  const destinations = new Map();
  for (const match of normalized.matchAll(
    /["'](?:applyUrl|applicationUrl)["']\s*:\s*["']([^"']+)["']/gi
  )) {
    try {
      const candidate = new URL(match[1], baseUrl);
      if (
        (candidate.protocol !== "http:" && candidate.protocol !== "https:") ||
        candidate.username ||
        candidate.password
      ) {
        continue;
      }
      const comparable = normalizeComparableUrl(candidate);
      if (!comparable || comparable === current) continue;
      destinations.set(comparable, candidate);
    } catch {
      // Ignore malformed page-owned values.
    }
  }
  if (destinations.size !== 1) return null;

  const candidate = [...destinations.values()][0];
  const validated = validatePublicHttpUrl(candidate);
  if (!validated.ok) return null;
  const source = new URL(baseUrl);
  const sameOrigin = candidate.origin === source.origin;
  const knownApplicationHost =
    Boolean(hostnameToPortal(candidate.href)) || platformForHost(candidate.hostname) === "linkedin";
  if (!sameOrigin && (candidate.protocol !== "https:" || !knownApplicationHost)) return null;
  return validated.url;
}

function exactResolutionKey(rawUrl) {
  try {
    const url = new URL(rawUrl);
    url.hash = "";
    return `url:${url.toString()}`;
  } catch {
    return "";
  }
}

function providerBoardResolutionKey(provider, rawUrl) {
  try {
    const url = new URL(rawUrl);
    const firstPathPart = url.pathname.split("/").filter(Boolean)[0] || "";
    const boardIdentity =
      provider === "recruitee" ? url.hostname : `${url.origin}/${firstPathPart}`;
    return `provider-board:${provider}:${boardIdentity.toLowerCase()}`;
  } catch {
    return "";
  }
}

function extractCanonicalAtsUrls(html, baseUrl) {
  const normalized = String(html || "")
    .replace(/\\u002f/gi, "/")
    .replace(/\\\//g, "/")
    .replace(/&quot;/gi, '"')
    .replace(/&amp;/gi, "&");
  const values = [];
  for (const match of normalized.matchAll(/\bhref\s*=\s*["']([^"']+)["']/gi)) {
    values.push(match[1]);
  }
  for (const match of normalized.matchAll(/https?:\/\/[^\s"'<>]+/gi)) {
    values.push(match[0]);
  }

  const current = normalizeComparableUrl(baseUrl);
  const seen = new Set();
  const urls = [];
  for (const value of values) {
    let parsed;
    try {
      parsed = new URL(value, baseUrl);
    } catch {
      continue;
    }
    const candidate = parsed.toString();
    const comparable = normalizeComparableUrl(candidate);
    if (!comparable || comparable === current || seen.has(comparable)) continue;
    if (!inferProvider({ careers_url: candidate })) continue;
    seen.add(comparable);
    urls.push(candidate);
  }
  return urls;
}

function normalizeComparableUrl(value) {
  try {
    const url = new URL(value);
    url.hash = "";
    return url.toString().replace(/\/$/, "");
  } catch {
    return "";
  }
}
