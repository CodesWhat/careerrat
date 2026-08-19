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
import {
  extractApplyControlsFromHtml,
  htmlToText as htmlToTextLiveness,
  isSpaJobHost,
} from "../liveness/job-link-checker.mjs";
import { classifyLiveness } from "../liveness/liveness-core.mjs";
import { fetchPublicHttpText } from "../net/public-http-fetch.mjs";
import { platformForHost } from "../providers/search-sources.mjs";
import { extractReqId, fetchProvider, inferProvider } from "../scoring/sourced-scanner.mjs";

const DEFAULT_TIMEOUT_MS = 15000;
const DEFAULT_MAX_BYTES = 1024 * 1024;

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
  } = {}
) {
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
    const resolved = await resolveViaProviderBoard({ provider, url: rawUrl, fetchImpl });
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
  });
  return mergeProviderMetadata(providerResolution, plain);
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

async function resolveViaProviderBoard({ provider, url, fetchImpl }) {
  const targetReqId = extractReqId(url);
  let jobs;
  try {
    jobs = await fetchProvider(provider, { careers_url: url, name: null }, fetchImpl);
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
    reason: null,
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

async function resolvePlainFetch({ url, fetchImpl, resolveHost, timeoutMs, maxBytes, provider }) {
  const fetched = await fetchPublicHttpText(url, {
    fetchImpl,
    resolveHost,
    timeoutMs,
    maxBytes,
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
  for (const canonicalUrl of extractCanonicalAtsUrls(html, fetched.finalUrl || url)) {
    const canonicalProvider = inferProvider({ careers_url: canonicalUrl });
    if (!canonicalProvider) continue;
    const resolved = await resolveViaProviderBoard({
      provider: canonicalProvider,
      url: canonicalUrl,
      fetchImpl,
    });
    if (resolved?.bodyText?.trim()) {
      return { ...resolved, sourceUrl: url };
    }
  }
  const bodyText = htmlToTextLiveness(html);
  const classified = classifyLiveness({
    status: fetched.status,
    finalUrl: fetched.finalUrl || url,
    bodyText,
    applyControls: extractApplyControlsFromHtml(html),
  });

  if (classified.code === "insufficient_content" || classified.code === "bot_challenge") {
    return { bodyFetchStatus: "deferred", url, provider, reason: classified.reason };
  }

  // Even an "expired"-classified fetch still returns the text we got — an
  // honest "looks expired" signal for classify to reference, not a silent
  // empty body. Only the shell-content/bot-wall cases above defer entirely
  // (there's no usable text to hand the classify step at all).
  return {
    bodyFetchStatus: "resolved",
    url,
    provider,
    title: null,
    company: null,
    location: null,
    comp: null,
    bodyText,
    liveness: classified,
  };
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
