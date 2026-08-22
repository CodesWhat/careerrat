import { setTimeout as delay } from "node:timers/promises";

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

async function request(fetchImpl, url, options = {}, consume) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutFor(options.timeoutMs));
  try {
    const init = {
      signal: controller.signal,
      redirect: options.redirect || "follow",
      headers: requestHeaders(options.headers),
    };
    if (options.method) init.method = options.method;
    if (options.body != null) init.body = options.body;

    const response = await fetchImpl(url, init);
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
  }
}

function createContext(fetchImpl, options = {}) {
  return {
    transport: "http",
    maxPages: options.maxPages,
    sinceMs: options.sinceMs,
    includeUndated: options.includeUndated,
    syntheticEntries: options.syntheticEntries,
    sleep: options.sleep || ((ms) => delay(ms)),
    fetchJson(url, requestOptions = {}) {
      return request(fetchImpl, url, requestOptions, async (response) => {
        const text = await response.text();
        return JSON.parse(text);
      });
    },
    fetchText(url, requestOptions = {}) {
      return request(fetchImpl, url, requestOptions, (response) => response.text());
    },
    fetchResponse(url, requestOptions = {}) {
      return request(fetchImpl, url, requestOptions, async (response) => {
        const body = NULL_BODY_STATUSES.has(response.status) ? null : await response.text();
        return new Response(body, {
          status: response.status,
          statusText: response.statusText,
          headers: response.headers,
        });
      });
    },
  };
}

function normalizedDate(value) {
  if (value == null || value === "") return null;
  const timestamp = typeof value === "number" ? value : Date.parse(String(value));
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null;
}

function normalizeOffer(job = {}, providerId) {
  const bodyText = String(job.bodyText || job.description || "").trim();
  const postedAt = normalizedDate(job.postedAt);
  return {
    title: String(job.title || "").trim(),
    url: String(job.url || "").trim(),
    company: String(job.company || "").trim(),
    location: String(job.location || "").trim(),
    comp: String(job.comp || "").trim(),
    bodyText,
    bodyPartial: bodyText.length === 0,
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
