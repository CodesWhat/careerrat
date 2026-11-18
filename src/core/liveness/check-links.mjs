import { classifyStage, isTerminalStage } from "../tracker/dashboard.mjs";

export const LINK_CHECK_CONCURRENCY = 8;
export const LINK_CHECK_PER_HOST_CONCURRENCY = 2;

function hostOf(url) {
  try {
    return new URL(url).host.toLowerCase();
  } catch {
    return "";
  }
}

/** Distinct, non-empty URLs in first-seen order. */
export function dedupeUrls(urls) {
  return [...new Set(urls.map((url) => String(url ?? "").trim()).filter(Boolean))];
}

/**
 * Links to check from a raw tracker.json object. Rows in a terminal stage
 * (rejected, withdrawn, cut, closed) are skipped unless includeClosed. Reads the
 * raw status because loadTrackerData drops it for sourced rows.
 */
export function trackerLinks(data, { includeClosed = false } = {}) {
  const rows = [...(data.applications || []), ...(data.sourced || data.prospects || [])];
  const kept = includeClosed
    ? rows
    : rows.filter((row) => !isTerminalStage(classifyStage(row.status).id));
  return dedupeUrls(kept.map((row) => row.link));
}

/**
 * Run `checker(url)` over `urls` with a global cap and a per-host cap. Results
 * keep input order, and `onResult(result, url, index)` fires in input order as
 * each prefix completes, so output stays deterministic.
 */
export async function checkLinks(
  urls,
  checker,
  { concurrency = LINK_CHECK_CONCURRENCY, perHost = LINK_CHECK_PER_HOST_CONCURRENCY, onResult } = {}
) {
  const results = new Array(urls.length);
  const done = new Array(urls.length).fill(false);
  const started = new Array(urls.length).fill(false);
  const hosts = urls.map(hostOf);
  const perHostActive = new Map();
  const globalCap = Math.max(1, concurrency);
  const hostCap = Math.max(1, perHost);
  let active = 0;
  let nextEmit = 0;
  let firstError;

  return new Promise((resolve, reject) => {
    const flush = () => {
      while (nextEmit < urls.length && done[nextEmit]) {
        onResult?.(results[nextEmit], urls[nextEmit], nextEmit);
        nextEmit += 1;
      }
    };
    const pump = () => {
      if (firstError) return;
      for (let i = 0; i < urls.length && active < globalCap; i += 1) {
        if (started[i]) continue;
        const host = hosts[i];
        if ((perHostActive.get(host) || 0) >= hostCap) continue;
        started[i] = true;
        active += 1;
        perHostActive.set(host, (perHostActive.get(host) || 0) + 1);
        Promise.resolve()
          .then(() => checker(urls[i]))
          .then((result) => {
            results[i] = result;
            done[i] = true;
          })
          .catch((error) => {
            firstError = error;
          })
          .finally(() => {
            active -= 1;
            perHostActive.set(host, perHostActive.get(host) - 1);
            if (firstError) return reject(firstError);
            try {
              flush();
            } catch (error) {
              return reject(error);
            }
            if (nextEmit === urls.length) return resolve(results);
            pump();
          });
      }
    };
    if (urls.length === 0) return resolve(results);
    pump();
  });
}
