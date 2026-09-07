// CareerRat compatibility transport for the pinned Career Ops provider snapshot.
// Provider modules call only the context passed by career-ops-registry.mjs. This
// file keeps their retry helpers without importing Career Ops' process-wide DNS
// monkey patch or its standalone fetch implementation.

export const BROWSER_LIKE_USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36 CareerRat/0.7";

// macOS browser User-Agent for providers whose WAF rejects the shared
// BROWSER_LIKE_USER_AGENT signature above (upstream: feishu-jobs). Ported
// from upstream's user-agent.mjs, which this shim does not otherwise vendor.
export const MACOS_BROWSER_LIKE_USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36";

const JITTER_MS = 250;
const RETRY_DEFAULTS = { retries: 2, baseDelayMs: 500, maxDelayMs: 8_000 };
const REDIRECT_REFUSAL_CAUSE_MESSAGE = "unexpected redirect";

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

export function isRetryableError(error) {
  const status = error?.status;
  if (status === 429) return true;
  if (typeof status === "number" && status >= 500) return true;
  if (isRefusedRedirectError(error)) return false;
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

