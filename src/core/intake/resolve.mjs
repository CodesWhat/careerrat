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
import { platformForHost } from "../providers/search-sources.mjs";
import { extractReqId, fetchProvider, inferProvider } from "../scoring/sourced-scanner.mjs";

const DEFAULT_TIMEOUT_MS = 15000;

// resolveJobUrl(url) -> {
//   bodyFetchStatus: "resolved" | "deferred",
//   url, provider, title, company, location, comp, bodyText, reason,
// }
export async function resolveJobUrl(
  rawUrl,
  { fetchImpl = fetch, timeoutMs = DEFAULT_TIMEOUT_MS } = {}
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
  if (provider) {
    const resolved = await resolveViaProviderBoard({ provider, url: rawUrl, fetchImpl });
    if (resolved) return resolved;
    // Known ATS, but this specific posting isn't on the company's current
    // board (closed, moved, or the board fetch itself failed) — fall through
    // to the plain-fetch path below for an honest signal instead of a hard
    // failure. Most ATS hosts are also SPA hosts, so this usually still ends
    // in "deferred" — which is correct, not a downgrade.
  }

  if (isSpaJobHost(parsed.hostname) || platformForHost(parsed.hostname)) {
    return {
      bodyFetchStatus: "deferred",
      url: rawUrl,
      provider,
      reason:
        "SPA-rendered or login-gated host — no session browser available to a headless intake route; " +
        "evaluate-job's own STEP 0 browser-escalation path handles this once confirmed",
    };
  }

  return resolvePlainFetch({ url: rawUrl, fetchImpl, timeoutMs, provider });
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

async function resolvePlainFetch({ url, fetchImpl, timeoutMs, provider }) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  let response;
  try {
    response = await fetchImpl(url, { signal: controller.signal, redirect: "follow" });
  } catch (error) {
    return {
      bodyFetchStatus: "deferred",
      url,
      provider,
      reason: `fetch failed: ${error.message}`,
    };
  } finally {
    clearTimeout(timeout);
  }

  const html = await response.text();
  const bodyText = htmlToTextLiveness(html);
  const classified = classifyLiveness({
    status: response.status,
    finalUrl: response.url || url,
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
