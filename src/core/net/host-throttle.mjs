// net/host-throttle.mjs — per-host politeness for a scan's outbound requests (CR115k).
//
// Wraps a fetch implementation so every host gets a concurrency cap and a
// minimum gap between request starts, and a 429 or 503 is retried after the
// server's Retry-After (or exponential backoff with jitter) instead of being
// reported as a failed source. A Retry-After is host-wide: the other queued
// requests to that host wait it out too. A wait longer than `maxWaitMs` is not
// slept; the response comes back as-is so a scan never stalls on one host.
//
// Pure of the network: `fetchImpl`, `now`, `sleep` and `random` are injected.

export const HOST_THROTTLE_DEFAULTS = {
  maxConcurrent: 2,
  minSpacingMs: 100,
  maxRetries: 3,
  baseBackoffMs: 500,
  maxWaitMs: 30_000,
};

const RETRY_STATUSES = new Set([429, 503]);

export function parseRetryAfter(value, nowMs = Date.now()) {
  if (value == null || value === "") return null;
  const text = String(value).trim();
  if (/^\d+(\.\d+)?$/.test(text)) return Math.round(Number(text) * 1000);
  const date = Date.parse(text);
  return Number.isFinite(date) ? Math.max(0, date - nowMs) : null;
}

function abortableSleep(ms, signal, sleep) {
  if (!signal) return sleep(ms);
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    sleep(ms).then(
      () => {
        signal.removeEventListener("abort", onAbort);
        resolve();
      },
      (error) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      }
    );
  });
}

function hostOf(input) {
  try {
    return new URL(typeof input === "string" ? input : input.url).host.toLowerCase();
  } catch {
    return "";
  }
}

export function createHostThrottle(fetchImpl, options = {}) {
  const cfg = { ...HOST_THROTTLE_DEFAULTS, ...options };
  const now = options.now || Date.now;
  const sleep = options.sleep || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const random = options.random || Math.random;
  const hosts = new Map();

  function state(host) {
    let s = hosts.get(host);
    if (!s) {
      s = {
        active: 0,
        nextStart: 0,
        pausedUntil: 0,
        queue: [],
        timer: null,
        attempts: 0,
        rateLimited: 0,
        retried: 0,
        gaveUp: 0,
      };
      hosts.set(host, s);
    }
    return s;
  }

  function pump(s) {
    while (s.queue.length && s.active < cfg.maxConcurrent) {
      const wait = Math.max(s.nextStart, s.pausedUntil) - now();
      if (wait > 0) {
        if (!s.timer) {
          s.timer = setTimeout(() => {
            s.timer = null;
            pump(s);
          }, wait);
          s.timer.unref?.();
        }
        return;
      }
      const entry = s.queue.shift();
      if (entry.cancelled) continue;
      s.active += 1;
      s.nextStart = now() + cfg.minSpacingMs;
      entry.resolve();
    }
  }

  function acquire(s, signal) {
    if (signal?.aborted) return Promise.reject(signal.reason);
    return new Promise((resolve, reject) => {
      const entry = { resolve, cancelled: false };
      if (signal) {
        signal.addEventListener(
          "abort",
          () => {
            if (entry.started) return;
            entry.cancelled = true;
            reject(signal.reason);
          },
          { once: true }
        );
        const original = entry.resolve;
        entry.resolve = () => {
          entry.started = true;
          original();
        };
      }
      s.queue.push(entry);
      pump(s);
    });
  }

  function release(s) {
    s.active -= 1;
    pump(s);
  }

  async function throttledFetch(input, init = {}) {
    const host = hostOf(input);
    if (!host) return fetchImpl(input, init);
    const s = state(host);
    const method = String(init.method || input?.method || "GET").toUpperCase();
    for (let attempt = 0; ; attempt += 1) {
      await acquire(s, init.signal);
      let response;
      try {
        s.attempts += 1;
        response = await fetchImpl(input, init);
      } finally {
        release(s);
      }
      if (response.status === 429) s.rateLimited += 1;
      const retryable =
        RETRY_STATUSES.has(response.status) &&
        (response.status === 429 || ["GET", "HEAD"].includes(method));
      if (!retryable) return response;
      const advised = parseRetryAfter(response.headers?.get?.("retry-after"), now());
      const backoff = cfg.baseBackoffMs * 2 ** attempt * (0.5 + random() * 0.5);
      const delay = advised ?? backoff;
      if (attempt >= cfg.maxRetries || delay > cfg.maxWaitMs) {
        s.gaveUp += 1;
        if (advised != null)
          s.pausedUntil = Math.max(s.pausedUntil, now() + Math.min(delay, cfg.maxWaitMs));
        return response;
      }
      await response.body?.cancel?.().catch(() => {});
      s.retried += 1;
      s.pausedUntil = Math.max(s.pausedUntil, now() + delay);
      await abortableSleep(delay, init.signal, sleep);
    }
  }

  function stats() {
    const perHost = {};
    let attempts = 0;
    let rateLimited = 0;
    let retried = 0;
    let gaveUp = 0;
    for (const [host, s] of hosts) {
      perHost[host] = {
        attempts: s.attempts,
        rateLimited: s.rateLimited,
        retried: s.retried,
        gaveUp: s.gaveUp,
      };
      attempts += s.attempts;
      rateLimited += s.rateLimited;
      retried += s.retried;
      gaveUp += s.gaveUp;
    }
    return {
      attempts,
      rateLimited,
      retried,
      gaveUp,
      rateLimitedPct: attempts ? Number(((rateLimited / attempts) * 100).toFixed(2)) : 0,
      hosts: perHost,
    };
  }

  return { fetch: throttledFetch, stats };
}
