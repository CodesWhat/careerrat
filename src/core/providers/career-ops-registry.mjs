import { setTimeout as delay } from "node:timers/promises";

import { guardedFetch } from "../net/public-http-fetch.mjs";
import { CAREER_OPS_PROVIDER_PARITY } from "./provider-parity.mjs";

const DEFAULT_TIMEOUT_MS = 15_000;
const MAX_TIMEOUT_MS = 60_000;
const DEFAULT_USER_AGENT =
  "CareerRat/0.7 (+https://github.com/CodesWhat/careerrat; deterministic job source)";
const NULL_BODY_STATUSES = new Set([204, 205, 304]);

const implementedIds = CAREER_OPS_PROVIDER_PARITY.filter(
  (entry) => entry.status === "implemented"
).map((entry) => entry.id);

// Load every vendored provider in isolation: one broken/misauthored vendor file
// must not take down the whole registry (and therefore every module that
// imports it) for every OTHER provider. `importProvider` is injectable so tests
// can exercise the isolation behavior with a mocked failing loader without
// touching the real vendor/ tree. A failed provider is logged and recorded,
// never thrown — the registry loads with the survivors.
export async function loadCareerOpsProviders(
  ids,
  importProvider = (id) => import(`./career-ops/vendor/${id}.mjs`)
) {
  const results = await Promise.allSettled(
    ids.map(async (id) => {
      const module = await importProvider(id);
      const provider = module.default;
      if (!provider || provider.id !== id || typeof provider.fetch !== "function") {
        throw new Error(`Career Ops provider "${id}" does not satisfy { id, fetch }`);
      }
      if (provider.detect != null && typeof provider.detect !== "function") {
        throw new Error(`Career Ops provider "${id}" has an invalid detect export`);
      }
      if (provider.fetchDetail != null && typeof provider.fetchDetail !== "function") {
        throw new Error(`Career Ops provider "${id}" has an invalid fetchDetail export`);
      }
      return provider;
    })
  );

  const providers = [];
  const failures = [];
  results.forEach((result, index) => {
    const id = ids[index];
    if (result.status === "fulfilled") {
      providers.push(result.value);
    } else {
      const error =
        result.reason instanceof Error ? result.reason : new Error(String(result.reason));
      failures.push({ id, error });
      console.warn(
        `[career-ops-registry] provider "${id}" failed to load, skipping: ${error.message}`
      );
    }
  });
  return { providers, failures };
}

const { providers: loadedProviders, failures: loadFailures } =
  await loadCareerOpsProviders(implementedIds);

const PROVIDERS = new Map(loadedProviders.map((provider) => [provider.id, provider]));

// Providers that failed to load at startup — a diagnostics surface (e.g. a
// future `doctor` check) can report these instead of only the console warning
// emitted at import time.
export function careerOpsLoadFailures() {
  return loadFailures.map((f) => ({ id: f.id, message: f.error.message }));
}

function normalizeProviderId(value) {
  return String(value || "")
    .trim()
    .toLowerCase();
}

export function careerOpsProviderIds() {
  return [...PROVIDERS.keys()];
}

export function isCareerOpsProviderSupported(providerId) {
  return PROVIDERS.has(normalizeProviderId(providerId));
}

export function providerForId(providerId) {
  return PROVIDERS.get(normalizeProviderId(providerId)) || null;
}

function normalizeEntry(entry = {}) {
  const careersUrl = entry.careers_url || entry.url || entry.rssUrl || "";
  return {
    ...entry,
    ...(careersUrl ? { careers_url: careersUrl } : {}),
  };
}

export function inferCareerOpsProvider(entry = {}) {
  const normalized = normalizeEntry(entry);
  if (normalized.provider) {
    const explicit = normalizeProviderId(normalized.provider);
    return PROVIDERS.has(explicit) ? explicit : null;
  }

  for (const provider of PROVIDERS.values()) {
    if (typeof provider.detect !== "function") continue;
    try {
      if (provider.detect(normalized)) return provider.id;
    } catch {
      // Detection is advisory. A malformed URL or incomplete provider-specific
      // config must not prevent another adapter from claiming the entry.
    }
  }
  return null;
}

function keywordList(entry = {}) {
  const values = [
    ...(Array.isArray(entry.keywords) ? entry.keywords : []),
    ...(typeof entry.query === "string" ? [entry.query] : []),
    ...(Array.isArray(entry.title_filter?.positive) ? entry.title_filter.positive : []),
  ];
  return [
    ...new Set(
      values
        .filter((value) => typeof value === "string")
        .map((value) => value.trim())
        .filter(Boolean)
    ),
  ];
}

function prepareProviderEntry(providerId, entry = {}) {
  const normalized = { ...normalizeEntry(entry), provider: providerId };
  const keywords = keywordList(normalized);
  if (providerId === "arbeitsagentur" && keywords.length > 0) {
    normalized.arbeitsagentur = {
      ...normalized.arbeitsagentur,
      keywords: normalized.arbeitsagentur?.keywords || keywords,
    };
  }
  if (providerId === "vdab" && keywords.length > 0) {
    normalized.vdab = {
      ...normalized.vdab,
      keywords: normalized.vdab?.keywords || keywords,
    };
  }
  // Same convention as arbeitsagentur/vdab above: jobbankca and
  // mycareersfuture are also keyword-required national job-bank providers,
  // and their vendored fallback (resolveProfileKeywords(), from the
  // _profile-keywords.mjs shim) always returns [] locally — CareerRat keeps
  // candidate state in its workspace database, not a filesystem
  // config/profile.yml, so the real fallback path is here instead.
  if (providerId === "jobbankca" && keywords.length > 0) {
    normalized.jobbankca = {
      ...normalized.jobbankca,
      keywords: normalized.jobbankca?.keywords || keywords,
    };
  }
  if (providerId === "mycareersfuture" && keywords.length > 0) {
    normalized.mycareersfuture = {
      ...normalized.mycareersfuture,
      keywords: normalized.mycareersfuture?.keywords || keywords,
    };
  }
  return normalized;
}

function requestHeaders(headers) {
  const normalized = new Headers(headers || {});
  if (!normalized.has("user-agent")) normalized.set("user-agent", DEFAULT_USER_AGENT);
  return Object.fromEntries(normalized.entries());
}

function timeoutFor(value) {
  const requested = Number(value);
  if (!Number.isFinite(requested) || requested <= 0) return DEFAULT_TIMEOUT_MS;
  return Math.min(Math.trunc(requested), MAX_TIMEOUT_MS);
}

// Every provider request — 77 vendored adapters, each driven by a
// user-configured source URL — goes through this one function, so this is
// where the shared SSRF guard from public-http-fetch.mjs (protocol
// screening, resolved-IP screening, DNS-pinned dispatcher, and re-validated
// redirect hops) is applied rather than calling fetchImpl directly. A
// request the guard blocks throws a specific error naming the URL and the
// reason — never a silent empty result — so a provider (or its caller) sees
// exactly why a scan came back short instead of just quietly missing rows.
async function request(
  fetchImpl,
  url,
  options = {},
  consume,
  resolveHost,
  dispatcherFactory,
  parentSignal
) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutFor(options.timeoutMs));
  let close = null;
  try {
    const init = {
      signal: combineAbortSignals(controller.signal, parentSignal, options.signal),
      redirect: options.redirect || "follow",
      headers: requestHeaders(options.headers),
    };
    if (options.method) init.method = options.method;
    if (options.body != null) init.body = options.body;

    const guarded = await guardedFetch(url, init, { fetchImpl, resolveHost, dispatcherFactory });
    if (!guarded.ok) {
      // guarded.finalUrl is set (and differs from url) when the guard blocked
      // a redirect hop rather than the initial request — name the actual
      // blocked target, not just the URL the provider originally asked for,
      // so the error is specific enough to act on.
      const blockedUrl = guarded.finalUrl && guarded.finalUrl !== url ? guarded.finalUrl : url;
      const error = new Error(
        `Career Ops request blocked for ${blockedUrl}: ${guarded.reason}` +
          (blockedUrl !== url ? ` (requested ${url})` : "")
      );
      error.code = guarded.code;
      error.url = url;
      error.blockedUrl = blockedUrl;
      throw error;
    }
    close = guarded.close;
    const response = guarded.response;
    if (!response || typeof response.text !== "function") {
      throw new Error(`Career Ops provider request returned an invalid response for ${url}`);
    }
    if (!response.ok) {
      const responseText = await response.text().catch(() => "");
      const error = new Error(
        `HTTP ${response.status}${response.statusText ? ` ${response.statusText}` : ""}`
      );
      error.status = response.status;
      error.body = responseText;
      error.retryAfter = response.headers?.get?.("retry-after") || null;
      error.location = response.headers?.get?.("location") || null;
      throw error;
    }
    return await consume(response);
  } finally {
    clearTimeout(timeout);
    if (close) await close();
  }
}

// Exported so tests can drive the shared SSRF guard integration directly
// (fetchJson/fetchText/fetchResponse against an injected fetchImpl/resolveHost)
// without depending on any one vendored provider's URL-derivation logic.
export function createContext(fetchImpl, options = {}) {
  const resolveHost = options.resolveHost;
  const dispatcherFactory = options.dispatcherFactory;
  return {
    transport: "http",
    maxPages: options.maxPages,
    sinceMs: options.sinceMs,
    includeUndated: options.includeUndated,
    syntheticEntries: options.syntheticEntries,
    sleep: options.sleep || ((ms) => delay(ms, undefined, { signal: options.signal })),
    fetchJson(url, requestOptions = {}) {
      return request(
        fetchImpl,
        url,
        requestOptions,
        async (response) => {
          const text = await response.text();
          return JSON.parse(text);
        },
        resolveHost,
        dispatcherFactory,
        options.signal
      );
    },
    fetchText(url, requestOptions = {}) {
      return request(
        fetchImpl,
        url,
        requestOptions,
        (response) => response.text(),
        resolveHost,
        dispatcherFactory,
        options.signal
      );
    },
    fetchResponse(url, requestOptions = {}) {
      return request(
        fetchImpl,
        url,
        requestOptions,
        async (response) => {
          const body = NULL_BODY_STATUSES.has(response.status) ? null : await response.text();
          return new Response(body, {
            status: response.status,
            statusText: response.statusText,
            headers: response.headers,
          });
        },
        resolveHost,
        dispatcherFactory,
        options.signal
      );
    },
  };
}

function combineAbortSignals(...signals) {
  const active = signals.filter(Boolean);
  if (active.length === 0) return undefined;
  if (active.length === 1) return active[0];
  return AbortSignal.any(active);
}

function normalizedDate(value) {
  if (value == null || value === "") return null;
  const timestamp = typeof value === "number" ? value : Date.parse(String(value));
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null;
}

// A handful of vendored providers (ashby, manfred, wttj, …) surface a
// structured { min, max, currency } salary object on the Job they return,
// rather than a formatted string — the vendored Job type (vendor/_types.js)
// documents no `comp` field at all, so without this the figure never reaches
// scoring's extractCompBand or a generated document. Formatted only when at
// least one bound is a usable positive number; malformed/partial data
// degrades to no comp rather than a broken string like "USD ?-?".
function formatSalaryRange(salary) {
  if (!salary || typeof salary !== "object") return "";
  const min = Number(salary.min);
  const max = Number(salary.max);
  const hasMin = Number.isFinite(min) && min > 0;
  const hasMax = Number.isFinite(max) && max > 0;
  if (!hasMin && !hasMax) return "";
  const currency = String(salary.currency || "").trim();
  const range = hasMin && hasMax ? `${min}-${max}` : String(hasMin ? min : max);
  return currency ? `${currency} ${range}` : range;
}

function normalizeOffer(job = {}, providerId) {
  const bodyText = String(job.bodyText || job.description || "").trim();
  const bodyPartial =
    bodyText.length === 0 || job.bodyPartial === true || job.descriptionPartial === true;
  const postedAt = normalizedDate(job.postedAt);
  return {
    title: String(job.title || "").trim(),
    url: String(job.url || "").trim(),
    company: String(job.company || "").trim(),
    location: String(job.location || "").trim(),
    comp: String(job.comp || formatSalaryRange(job.salary) || "").trim(),
    bodyText,
    bodyPartial,
    ...(postedAt ? { postedAt } : {}),
    provider: providerId,
  };
}

export async function fetchCareerOpsProvider(providerId, entry, options = {}) {
  const normalizedId = normalizeProviderId(providerId);
  const provider = PROVIDERS.get(normalizedId);
  if (!provider) throw new Error(`unsupported Career Ops provider: ${normalizedId || providerId}`);
  const fetchImpl = options.fetchImpl || fetch;
  const jobs = await provider.fetch(
    prepareProviderEntry(normalizedId, entry),
    createContext(fetchImpl, options)
  );
  if (!Array.isArray(jobs)) {
    throw new Error(`Career Ops provider "${normalizedId}" returned a non-array result`);
  }
  return jobs.map((job) => normalizeOffer(job, normalizedId));
}

export async function fetchCareerOpsPostingDetail(providerId, entry, job, options = {}) {
  const normalizedId = normalizeProviderId(providerId);
  const provider = PROVIDERS.get(normalizedId);
  if (!provider) throw new Error(`unsupported Career Ops provider: ${normalizedId || providerId}`);
  if (typeof provider.fetchDetail !== "function") return normalizeOffer(job, normalizedId);
  const fetchImpl = options.fetchImpl || fetch;
  const detailed = await provider.fetchDetail(
    prepareProviderEntry(normalizedId, entry),
    job,
    createContext(fetchImpl, options)
  );
  if (!detailed || typeof detailed !== "object" || Array.isArray(detailed)) {
    throw new Error(`Career Ops provider "${normalizedId}" returned an invalid posting detail`);
  }
  return normalizeOffer(detailed, normalizedId);
}
