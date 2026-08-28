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
import { extractJobPageIdentity, extractStructuredJobPostings } from "./job-posting-extract.mjs";

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
    probePostingRedirect = false,
  } = {}
) {
  const cacheKey = exactResolutionKey(rawUrl, { probePostingRedirect });
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
    probePostingRedirect,
  });
  if (resolutionCache && cacheKey) resolutionCache.set(cacheKey, resolution);
  return resolution;
}

async function resolveJobUrlUncached(
  rawUrl,
  { fetchImpl, resolveHost, timeoutMs, maxBytes, signal, resolutionCache, probePostingRedirect }
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
    if (resolved?.liveness?.result === "expired") return resolved;
    if (resolved?.bodyText?.trim()) return resolved;
    providerResolution = resolved;
    // Known ATS, but this specific posting isn't on the company's current
    // board, or its list payload has no description. Fall through to the
    // posting page for full-JD recovery instead of treating an empty body as
    // resolved. SPA hosts still defer honestly to the session-browser path.
  }

  if (isSpaJobHost(parsed.hostname) || platformForHost(parsed.hostname)) {
    let postingEvidence;
    if (probePostingRedirect) {
      const redirectProbe = await resolveDefinitivePostingRedirect({
        url: rawUrl,
        fetchImpl,
        resolveHost,
        timeoutMs,
        signal,
      });
      if (redirectProbe?.liveness) {
        return mergeProviderMetadata(providerResolution, redirectProbe);
      }
      postingEvidence = redirectProbe?.postingEvidence;
    }
    return mergeProviderMetadata(providerResolution, {
      bodyFetchStatus: "deferred",
      url: rawUrl,
      provider,
      ...(postingEvidence ? { postingEvidence } : {}),
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
    requirePostingIdentity = false,
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
      probePostingRedirect: true,
      requirePostingIdentity,
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
  if (requirePostingIdentity && postingIdentityAssessment(offer, resolved) !== "specific") {
    return {
      ...offer,
      ...(existingBody ? { bodyText: existingBody } : {}),
      bodyPartial: true,
      bodyFetchStatus: "unavailable",
      bodyFetchReason: "This link does not identify one specific job posting.",
    };
  }
  const visibleTitle = requirePostingIdentity ? canonicalVisibleTitle(offer, resolved) : "";
  if (resolved?.bodyFetchStatus === "resolved" && canonicalBody.length >= minBodyChars) {
    const bodyPartial = resolved?.bodyPartial === true;
    return {
      ...offer,
      url: resolved.url || offer.url,
      company: resolved.company || offer.company,
      title: resolved.title || visibleTitle || offer.title,
      location: requirePostingIdentity
        ? String(resolved.location || "").trim()
        : preferredResolvedLocation(resolved.location, offer.location),
      comp: requirePostingIdentity
        ? String(resolved.comp || "").trim()
        : resolved.comp || offer.comp,
      postedAt: requirePostingIdentity
        ? resolved.postedAt || null
        : resolved.postedAt || offer.postedAt,
      bodyText: canonicalBody,
      bodyPartial,
      ...(bodyPartial && resolved?.reason ? { bodyFetchReason: resolved.reason } : {}),
      ...(resolved.provider ? { provider: resolved.provider } : {}),
      ...(resolved.url && resolved.url !== offer.url ? { capturedUrl: offer.url } : {}),
    };
  }

  if (requirePostingIdentity) {
    return {
      ...offer,
      url: resolved?.url || offer.url,
      company: resolved?.company || offer.company,
      title: resolved?.title || offer.title,
      location: String(resolved?.location || offer.location || "").trim(),
      comp: String(resolved?.comp || offer.comp || "").trim(),
      postedAt: resolved?.postedAt || offer.postedAt || null,
      ...(existingBody ? { bodyText: existingBody } : { bodyText: "" }),
      description: "",
      rawText: "",
      bodyPartial: true,
      bodyFetchStatus: "deferred",
      bodyFetchReason:
        resolved?.reason || "The full job description was not available from this source.",
      ...(resolved?.provider ? { provider: resolved.provider } : {}),
      ...(resolved?.url && resolved.url !== offer.url ? { capturedUrl: offer.url } : {}),
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

const CAREER_CONTEXT_SEGMENTS = new Set([
  "career",
  "careers",
  "employment",
  "job",
  "jobs",
  "openings",
  "opportunities",
  "positions",
]);

const GENERIC_HUB_SEGMENTS = new Set([
  ...CAREER_CONTEXT_SEGMENTS,
  "index",
  "index.html",
  "location",
  "locations",
  "results",
  "search",
  "search-results",
]);

const HARD_GENERIC_HUB_SEGMENTS = new Set([
  "location",
  "locations",
  "results",
  "search",
  "search-results",
]);

const ROLE_LISTING_WORDS = new Set(["jobs", "openings", "opportunities", "positions", "roles"]);

const TITLE_IDENTITY_IGNORED_WORDS = new Set([
  "and",
  "at",
  "career",
  "careers",
  "for",
  "in",
  "job",
  "jobs",
  "of",
  "position",
  "role",
  "the",
]);

const TITLE_IDENTITY_QUALIFIERS = new Set([
  "ii",
  "iii",
  "iv",
  "junior",
  "jr",
  "lead",
  "principal",
  "senior",
  "sr",
  "staff",
]);

const TITLE_IDENTITY_ALIASES = new Map([
  ["asst", "assistant"],
  ["eng", "engineer"],
  ["jr", "junior"],
  ["mgr", "manager"],
  ["sr", "senior"],
]);

function normalizedIdentityWords(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(/\s+/u)
    .filter((word) => word && !TITLE_IDENTITY_IGNORED_WORDS.has(word))
    .map((word) => TITLE_IDENTITY_ALIASES.get(word) || word);
}

function identityCarriesTitleCore(identity, title) {
  const titleCore = String(title || "").split(/\s(?:[-—|])\s|\s*\(/u, 1)[0];
  const expected = normalizedIdentityWords(titleCore).filter(
    (word) => !TITLE_IDENTITY_QUALIFIERS.has(word)
  );
  if (!expected.length) return false;
  const actual = new Set(normalizedIdentityWords(identity));
  return expected.every((word) => actual.has(word));
}

function identityCarriesTitle(identity, title) {
  const expected = normalizedIdentityWords(title);
  const actual = new Set(normalizedIdentityWords(identity));
  const qualifiers = expected.filter((word) => TITLE_IDENTITY_QUALIFIERS.has(word));
  return qualifiers.every((word) => actual.has(word)) && identityCarriesTitleCore(identity, title);
}

function hasNonemptyQuery(url, ...keys) {
  return keys.some((key) => String(url.searchParams.get(key) || "").trim());
}

function isTrustedPlatformPostingUrl(rawUrl) {
  const checked = validatePublicHttpUrl(rawUrl);
  if (!checked.ok) return false;
  try {
    const url = new URL(checked.url);
    if (extractReqId(url).id) return true;
    if (
      (url.hostname === "linkedin.com" || url.hostname.endsWith(".linkedin.com")) &&
      /^\/jobs\/view\/[^/]*\d+\/?$/iu.test(url.pathname)
    ) {
      return true;
    }
    if (platformForHost(url.hostname) === "indeed") {
      return /^\/viewjob\/?$/iu.test(url.pathname) && hasNonemptyQuery(url, "jk", "vjk");
    }
    if (
      (url.hostname === "glassdoor.com" || url.hostname.endsWith(".glassdoor.com")) &&
      hasNonemptyQuery(url, "jl", "jobListingId")
    ) {
      return true;
    }
    if (
      (url.hostname === "wellfound.com" || url.hostname === "www.wellfound.com") &&
      /^\/jobs\/\d+(?:[-/]|$)/iu.test(url.pathname)
    ) {
      return true;
    }
    if (
      url.hostname === "careers.snowflake.com" &&
      /\/(?:[a-z]{2}\/)?(?:[a-z]{2}\/)?job\/[^/]+/iu.test(url.pathname)
    ) {
      return true;
    }
    if (
      url.hostname === "www.coinbase.com" &&
      /^\/careers\/positions\/[^/]+\/?$/iu.test(url.pathname)
    ) {
      return true;
    }
    return false;
  } catch {
    return false;
  }
}

function isGenericHubUrl(rawUrl, title) {
  try {
    const url = new URL(rawUrl);
    const segments = url.pathname
      .split("/")
      .map((segment) => segment.trim().toLowerCase())
      .filter(Boolean);
    if (segments.some((segment) => HARD_GENERIC_HUB_SEGMENTS.has(segment))) return true;
    if (
      segments.some((segment) => {
        const words = segment.split(/[^a-z0-9]+/u).filter(Boolean);
        return words.length > 1 && words.some((word) => ROLE_LISTING_WORDS.has(word));
      })
    ) {
      return true;
    }
    if (segments.length === 0 || segments.every((segment) => GENERIC_HUB_SEGMENTS.has(segment))) {
      return true;
    }
    const firstHostLabel = url.hostname.replace(/^www\./iu, "").split(".")[0];
    if (
      (firstHostLabel === "careers" || firstHostLabel === "jobs") &&
      !identityCarriesTitle(url.pathname, title)
    ) {
      return true;
    }
    return false;
  } catch {
    return false;
  }
}

function hasRoleListingLanguage(value) {
  const text = String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return (
    /\bjobs\b/u.test(text) ||
    /\b(?:job|role|position) (?:listings?|results?)\b/u.test(text) ||
    /\b(?:browse|find|search|view)\b.{0,40}\b(?:jobs|openings|positions|roles)\b/u.test(text) ||
    /\b(?:available|current|open) (?:openings|positions|roles)\b/u.test(text)
  );
}

function canonicalVisibleTitle(offer, resolved) {
  const claimedTitle = resolved?.title || offer?.title;
  const headings = Array.isArray(resolved?.postingEvidence?.headings)
    ? resolved.postingEvidence.headings
    : [];
  return (
    headings.find((heading) => {
      const text = String(heading || "").trim();
      return (
        text.length > 0 &&
        text.length <= 160 &&
        !hasRoleListingLanguage(text) &&
        identityCarriesTitleCore(text, claimedTitle)
      );
    }) || ""
  );
}

function isStrongDeferredPostingUrl(rawUrl, _evidence, title) {
  if (isTrustedPlatformPostingUrl(rawUrl)) return true;
  return !isGenericHubUrl(rawUrl, title) && identityCarriesTitle(rawUrl, title);
}

function postingIdentityAssessment(offer, resolved) {
  const evidence = resolved?.postingEvidence;
  const destinationUrl = evidence?.finalUrl || resolved?.url;
  const redirected =
    Boolean(evidence?.finalUrl && offer?.url) &&
    normalizeComparableUrl(evidence.finalUrl) !== normalizeComparableUrl(offer.url);
  const title = resolved?.title || canonicalVisibleTitle(offer, resolved) || offer?.title;
  if (
    resolved?.bodyFetchStatus === "deferred" &&
    isStrongDeferredPostingUrl(resolved?.url || offer?.url, evidence, title)
  ) {
    return "specific";
  }
  if (!evidence) return resolved?.providerExactMatch === true ? "specific" : "unknown";
  if (Number(evidence.structuredPostingCount) > 1) return "generic";
  if (Array.isArray(evidence.canonicalPostingUrls) && evidence.canonicalPostingUrls.length > 1) {
    return "generic";
  }
  if (Number(evidence.structuredPostingCount) === 1) return "specific";
  if (!destinationUrl || isGenericHubUrl(destinationUrl, title)) return "generic";
  const pageIdentities = [
    evidence.pageTitle,
    ...(Array.isArray(evidence.headings) ? evidence.headings : []),
  ];
  if (pageIdentities.some((identity) => hasRoleListingLanguage(identity))) return "generic";
  const identities = [
    destinationUrl,
    ...pageIdentities,
    ...(!redirected && offer?.url ? [offer.url] : []),
  ];
  if (identities.some((identity) => identityCarriesTitle(identity, title))) return "specific";
  return "unknown";
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
    postedAt: result.postedAt || providerResolution.postedAt,
    providerExactMatch:
      result.providerExactMatch === true || providerResolution.providerExactMatch === true,
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
    if (normalizedProviderPostingUrl(job.url) === normalizedProviderPostingUrl(url)) return true;
    if (!targetReqId.id) return false;
    const jobReqId = extractReqId(job.url);
    return jobReqId.id === targetReqId.id;
  });
  if (!match) {
    if (!targetReqId.id) return null;
    return {
      bodyFetchStatus: "resolved",
      url,
      provider,
      title: null,
      company: fallbackCompanyFromUrl(url),
      location: null,
      comp: null,
      bodyText: "",
      bodyPartial: true,
      liveness: {
        result: "expired",
        code: "provider_posting_missing",
        reason: `The current ${provider} board no longer lists requisition ${targetReqId.value}.`,
      },
    };
  }

  return {
    bodyFetchStatus: "resolved",
    url: match.url || url,
    provider,
    providerExactMatch: true,
    title: match.title || null,
    company: match.company || fallbackCompanyFromUrl(url),
    location: match.location || null,
    comp: match.comp || null,
    postedAt: match.postedAt || null,
    bodyText: match.bodyText || "",
    bodyPartial: match.bodyPartial === true,
    reason:
      match.bodyPartial === true
        ? "The job description exceeded the provider capture safety limit."
        : null,
  };
}

const TRACKING_QUERY_KEYS = new Set(["ref", "referrer", "source", "sourceid", "trackingid"]);

function normalizedProviderPostingUrl(value) {
  try {
    const url = new URL(value);
    url.hash = "";
    for (const key of [...url.searchParams.keys()]) {
      if (key.toLowerCase().startsWith("utm_") || TRACKING_QUERY_KEYS.has(key.toLowerCase())) {
        url.searchParams.delete(key);
      }
    }
    url.searchParams.sort();
    if (url.pathname.length > 1) url.pathname = url.pathname.replace(/\/+$/u, "");
    return url.toString();
  } catch {
    return String(value || "").trim();
  }
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
  const finalUrl = fetched.finalUrl || url;
  const pageIdentity = extractJobPageIdentity(html);
  const structuredPostings = extractStructuredJobPostings(html);
  const structuredPosting = structuredPostings.length === 1 ? structuredPostings[0] : null;
  const structuredBody = structuredPosting?.description || "";
  const bodyText = structuredBody || htmlToTextLiveness(html);
  const cappedPreview = isCappedPreviewUrl(fetched.finalUrl || url);
  const classified = classifyLiveness({
    status: fetched.status,
    finalUrl,
    bodyText,
    applyControls: extractApplyControlsFromHtml(html),
  });

  if (classified.result === "expired" && classified.code !== "insufficient_content") {
    return {
      bodyFetchStatus: "resolved",
      url,
      provider,
      title: structuredPosting?.title || null,
      company: structuredPosting?.company || null,
      location: structuredPosting?.location || null,
      comp: structuredPosting?.comp || null,
      postedAt: structuredPosting?.postedAt || null,
      bodyText,
      bodyPartial: cappedPreview,
      ...(cappedPreview
        ? { reason: "The source exposes a capped preview instead of the complete job description." }
        : {}),
      liveness: classified,
      postingEvidence: {
        ...pageIdentity,
        finalUrl,
        structuredPostingCount: structuredPostings.length,
        canonicalPostingUrls: [],
      },
    };
  }

  const sourceReqId = extractReqId(url);
  const canonicalPostingUrls = extractCanonicalAtsUrls(html, finalUrl);
  for (const canonicalUrl of canonicalPostingUrls.length === 1 ? canonicalPostingUrls : []) {
    const canonicalProvider = inferProvider({ careers_url: canonicalUrl });
    if (!canonicalProvider) continue;
    const canonicalReqId = extractReqId(canonicalUrl);
    if (
      sourceReqId.id &&
      sourceReqId.provider === canonicalReqId.provider &&
      canonicalReqId.id !== sourceReqId.id
    ) {
      continue;
    }
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
  const applicationUrl = extractEmbeddedApplicationUrl(html, finalUrl);

  if (classified.code === "insufficient_content" || classified.code === "bot_challenge") {
    return { bodyFetchStatus: "deferred", url, provider, reason: classified.reason };
  }

  // Even an "expired"-classified fetch still returns the text we got — an
  // honest "looks expired" signal for classify to reference, not a silent
  // empty body. Only the shell-content/bot-wall cases above defer entirely
  // (there's no usable text to hand the classify step at all).
  return {
    bodyFetchStatus: "resolved",
    url: applicationUrl || finalUrl,
    ...(applicationUrl || finalUrl !== url ? { sourceUrl: url } : {}),
    provider,
    title: structuredPosting?.title || null,
    company: structuredPosting?.company || null,
    location: structuredPosting?.location || null,
    comp: structuredPosting?.comp || null,
    postedAt: structuredPosting?.postedAt || null,
    bodyText,
    bodyPartial: cappedPreview,
    ...(cappedPreview
      ? { reason: "The source exposes a capped preview instead of the complete job description." }
      : {}),
    liveness: classified,
    postingEvidence: {
      ...pageIdentity,
      finalUrl,
      structuredPostingCount: structuredPostings.length,
      canonicalPostingUrls,
    },
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

async function resolveDefinitivePostingRedirect({
  url,
  fetchImpl,
  resolveHost,
  timeoutMs,
  signal,
}) {
  const fetched = await fetchPublicHttpText(url, {
    fetchImpl,
    resolveHost,
    timeoutMs,
    maxBytes: 1,
    readErrorBody: false,
    signal,
  });
  if (!fetched.ok && fetched.code !== "response_too_large") return null;
  const finalUrl = fetched.finalUrl || url;
  const liveness = classifyLiveness({
    status: Number(fetched.status || 0),
    finalUrl,
    bodyText: "",
    applyControls: [],
  });
  const postingEvidence = { guardedRedirectProbe: true, finalUrl };
  if (!new Set(["expired_url", "http_gone"]).has(liveness.code)) {
    return { postingEvidence };
  }
  return {
    bodyFetchStatus: "resolved",
    url,
    provider: null,
    title: null,
    company: null,
    location: null,
    comp: null,
    bodyText: "",
    bodyPartial: true,
    liveness,
    postingEvidence,
  };
}

function exactResolutionKey(rawUrl, { probePostingRedirect = false } = {}) {
  try {
    const url = new URL(rawUrl);
    url.hash = "";
    return `url:${url.toString()}:posting-redirect-${probePostingRedirect ? "on" : "off"}`;
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
