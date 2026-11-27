// CareerRat compatibility transport for the pinned Career Ops provider snapshot.
// Provider modules call only the context passed by career-ops-registry.mjs. This
// file keeps their retry helpers without importing Career Ops' process-wide DNS
// monkey patch or its standalone fetch implementation.

import { guardedFetch } from "../../../net/public-http-fetch.mjs";

export const BROWSER_LIKE_USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36 CareerRat/0.7";

// macOS browser User-Agent for providers whose WAF rejects the shared
// BROWSER_LIKE_USER_AGENT signature above (upstream: feishu-jobs). Ported
// from upstream's user-agent.mjs, which this shim does not otherwise vendor.
export const MACOS_BROWSER_LIKE_USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36";

const MAX_TIMER_MS = 2_147_483_647; // setTimeout rewrites anything above this to 1ms
const STREAM_DEFAULT_TIMEOUT_MS = 15_000;
const STREAM_USER_AGENT =
  "CareerRat/0.7 (+https://github.com/CodesWhat/careerrat; deterministic job source)";

/**
 * Ceiling for a full response body read through fetchTextStream when the caller
 * passes no `maxBytes`. Ported from upstream.
 */
export const DEFAULT_MAX_BODY_BYTES = 10 * 1024 * 1024;

const JITTER_MS = 250;
const RETRY_DEFAULTS = { retries: 2, baseDelayMs: 500, maxDelayMs: 8_000 };
const REDIRECT_REFUSAL_CAUSE_MESSAGE = "unexpected redirect";
const CF_CHALLENGE_RE = /\bchallenge\b/i;

export function sleep(ms, ctx) {
  if (typeof ctx?.sleep === "function") return ctx.sleep(ms);
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function parseRetryAfterMs(value) {
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const dateMs = Date.parse(value);
  return Number.isFinite(dateMs) ? Math.max(0, dateMs - Date.now()) : null;
}

/**
 * Whether a failure is a redirect refused by the mandatory SSRF guard —
 * `redirect:'error'` meeting a 3xx (#1440). It arrives as a bare TypeError
 * with no `.status`, indistinguishable by shape from a timeout or a DNS
 * failure, and only `err.cause.message` tells them apart.
 *
 * Exported because the verdict has two consumers, not one. isRetryableError()
 * below needs it to stop retrying; discover-ats.mjs needs it to stop telling a
 * human to re-run. Before it was shared, those two disagreed about the same
 * error object: the retry layer called it deterministic while the CLI reported
 * "board status unknown — re-run", and 48 of one user's 62 companies were
 * BambooHR answering "no such tenant" with a 302 (#3788).
 *
 * @param {any} err
 * @returns {boolean}
 */
export function isRefusedRedirectError(err) {
  return err?.status === undefined
    && err instanceof TypeError
    && err?.cause?.message === REDIRECT_REFUSAL_CAUSE_MESSAGE;
}

/**
 * Whether a failed request was a Cloudflare challenge, read from the
 * `cf-mitigated` header kept on the error as `cfMitigated` (upstream
 * fetchInContext). A challenge is not throttling, so it is never retried.
 *
 * @param {any} err
 * @returns {boolean}
 */
export function isCloudflareChallenge(err) {
  return typeof err?.cfMitigated === "string" && CF_CHALLENGE_RE.test(err.cfMitigated);
}

export function isRetryableError(error) {
  const status = error?.status;
  if (isCloudflareChallenge(error)) return false;
  if (status === 429) return true;
  if (typeof status === "number" && status >= 500) return true;
  if (isRefusedRedirectError(error)) return false;
  // An oversize body or a blocked address is deterministic: the same request
  // fails the same way next time. Neither carries a status, so without these
  // they would fall through to the network-error case below.
  if (error?.code === "response_too_large") return false;
  if (
    error?.code === "ECAREEROPS_BLOCKED_ADDRESS"
    || error?.cause?.code === "ECAREEROPS_BLOCKED_ADDRESS"
  ) {
    return false;
  }
  // A timeout that already ran its full timeoutMs would just time out again.
  if (error?.timedOut === true) return false;
  return status === undefined;
}

async function withRetry(request, ctx, policy = {}) {
  const { retries, baseDelayMs, maxDelayMs } = { ...RETRY_DEFAULTS, ...policy };
  let lastError;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      return await request();
    } catch (error) {
      lastError = error;
      if (error !== null && (typeof error === "object" || typeof error === "function")) {
        error.attempts = attempt + 1;
      }
      if (attempt === retries || !isRetryableError(error)) throw error;
      const jitterMs = Math.min(JITTER_MS, Math.max(0, maxDelayMs));
      const ceiling = Math.max(0, maxDelayMs - jitterMs);
      const backoff = Math.min(baseDelayMs * 2 ** attempt, ceiling);
      const retryAfterMs = parseRetryAfterMs(error?.retryAfter);
      const delayMs =
        retryAfterMs !== null
          ? Math.min(retryAfterMs, maxDelayMs * 4)
          : backoff + Math.random() * jitterMs;
      await sleep(delayMs, ctx);
    }
  }
  throw lastError;
}

export function fetchJsonWithRetry(ctx, url, opts = {}, policy = {}) {
  return withRetry(() => ctx.fetchJson(url, opts), ctx, policy);
}

export function fetchTextWithRetry(ctx, url, opts = {}, policy = {}) {
  return withRetry(() => ctx.fetchText(url, opts), ctx, policy);
}

export function fetchResponseWithRetry(ctx, url, opts = {}, policy = {}) {
  return withRetry(() => ctx.fetchResponse(url, opts), ctx, policy);
}

/**
 * Resolve the per-request timeout from a raw env value. Unusable values (not a
 * number, below 1ms, above setTimeout's honored range) fall back rather than
 * failing a scan: a delay outside that range is silently rewritten to 1ms,
 * which would abort every request almost immediately. Ported from upstream.
 *
 * @param {unknown} raw - Raw env value (CAREER_OPS_HTTP_TIMEOUT_MS).
 * @param {number} [fallback=10_000] - Value used when `raw` is unusable.
 * @returns {number} Milliseconds.
 */
export function resolveDefaultTimeoutMs(raw, fallback = 10_000) {
  if (raw === undefined || raw === null || String(raw).trim() === "") return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 1 || parsed > MAX_TIMER_MS) return fallback;
  return parsed;
}

function bodyTooLarge(size, maxBytes) {
  const err = new Error(
    `HTTP body exceeded maxBytes of ${maxBytes}${size != null ? ` (content-length ${size})` : ""}`
  );
  err.code = "response_too_large";
  return err;
}

/**
 * Hand a response body to `onText` piece by piece instead of buffering it.
 *
 * For a source that publishes one document far over DEFAULT_MAX_BODY_BYTES
 * (Workable's job feed). Unlike the ctx fetchers this is a standalone export,
 * as upstream's is, but it never calls fetch directly: the request goes through
 * guardedFetch, so the private-address screen, the DNS-pinned dispatcher and
 * `redirect: 'error'` (the default here) all apply. The body is decoded as
 * UTF-8 chunk by chunk and never held whole.
 *
 * `opts.timeoutMs` bounds the whole transfer, headers and body. `opts.maxBytes`
 * bounds the decoded body; over it the read stops and throws `response_too_large`.
 * `onText` returning `false` stops the read early. The body is cancelled either
 * way. A conditional request passes `If-Modified-Since` in `opts.headers` with
 * `opts.acceptNotModified: true`; a 304 then resolves with `notModified: true`.
 * `opts.fetchImpl`, `opts.resolveHost` and `opts.dispatcherFactory` are test seams
 * handed to guardedFetch.
 *
 * @param {string} url
 * @param {{ timeoutMs?: number, maxBytes?: number, headers?: Record<string, string>, redirect?: "error" | "manual" | "follow", acceptNotModified?: boolean, signal?: AbortSignal, fetchImpl?: typeof fetch, resolveHost?: Function, dispatcherFactory?: Function }} opts
 * @param {(text: string) => (boolean | void | Promise<boolean | void>)} onText
 * @returns {Promise<{ bytes: number, complete: boolean, notModified: boolean, lastModified: string | null }>}
 * @throws {Error} With `status` on a non-2xx response, `code: 'response_too_large'` over the byte cap, `code` from the address guard when the request is blocked.
 */
export async function fetchTextStream(url, opts, onText) {
  if (typeof onText !== "function") throw new TypeError("fetchTextStream needs an onText callback");
  const options = opts ?? {};
  const maxBytes =
    Number.isFinite(options.maxBytes) && options.maxBytes > 0
      ? options.maxBytes
      : DEFAULT_MAX_BODY_BYTES;
  const requested = Number(options.timeoutMs);
  const timeoutMs =
    Number.isFinite(requested) && requested > 0
      ? Math.min(Math.trunc(requested), MAX_TIMER_MS)
      : STREAM_DEFAULT_TIMEOUT_MS;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let close = null;
  try {
    const headers = new Headers(options.headers || {});
    if (!headers.has("user-agent")) headers.set("user-agent", STREAM_USER_AGENT);
    const signal = options.signal
      ? AbortSignal.any([controller.signal, options.signal])
      : controller.signal;
    const guarded = await guardedFetch(
      url,
      { signal, redirect: options.redirect || "error", headers: Object.fromEntries(headers.entries()) },
      {
        fetchImpl: options.fetchImpl,
        resolveHost: options.resolveHost,
        dispatcherFactory: options.dispatcherFactory,
      }
    );
    if (!guarded.ok) {
      const error = new Error(`Career Ops request blocked for ${url}: ${guarded.reason}`);
      error.code = guarded.code;
      error.url = url;
      throw error;
    }
    close = guarded.close;
    const res = guarded.response;
    const lastModified = res.headers?.get?.("last-modified") ?? null;
    if (res.status === 304 && options.acceptNotModified === true) {
      return { bytes: 0, complete: true, notModified: true, lastModified };
    }
    if (!res.ok) {
      const error = new Error(`HTTP ${res.status}${res.statusText ? ` ${res.statusText}` : ""}`);
      error.status = res.status;
      error.retryAfter = res.headers?.get?.("retry-after") || null;
      const cfMitigated = res.headers?.get?.("cf-mitigated");
      if (cfMitigated) error.cfMitigated = cfMitigated;
      await res.body?.cancel?.().catch(() => {});
      throw error;
    }
    const reader = res.body?.getReader?.();
    if (!reader) {
      const text = await res.text();
      const bytes = Buffer.byteLength(text, "utf8");
      if (bytes > maxBytes) throw bodyTooLarge(bytes, maxBytes);
      if (text) await onText(text);
      return { bytes, complete: true, notModified: false, lastModified };
    }
    const decoder = new TextDecoder("utf-8");
    let bytes = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        bytes += value.length;
        if (bytes > maxBytes) throw bodyTooLarge(null, maxBytes);
        if ((await onText(decoder.decode(value, { stream: true }))) === false) {
          return { bytes, complete: false, notModified: false, lastModified };
        }
      }
      const tail = decoder.decode();
      if (tail) await onText(tail);
      return { bytes, complete: true, notModified: false, lastModified };
    } finally {
      try {
        await reader.cancel();
      } catch {
        /* body already closed */
      }
    }
  } finally {
    clearTimeout(timer);
    if (close) await close();
  }
}
