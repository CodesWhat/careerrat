// ats-liveness.mjs — ask the ATS itself whether a saved posting is still open,
// instead of scraping its page. Supported: Greenhouse, Lever, Ashby, Workable,
// SmartRecruiters.
//
// The answer is definitive only when the ATS API says so: a 404/410 for the
// posting (or, for Ashby, a board listing that no longer contains it) is
// "expired"; a 200 for the posting is "active". Anything else (network error,
// timeout, 429, 5xx, an unreadable body) returns null so the caller falls back
// to the page check. A failed lookup is never a "closed" verdict.
import { fetchPublicHttpText } from "../net/public-http-fetch.mjs";

const ASHBY_TIMEOUT_MS = 30_000;
// Ashby has no per-job endpoint, so the whole board listing is read.
const ASHBY_MAX_BYTES = 8 * 1024 * 1024;

// Returns { provider, apiUrl, kind: "posting" | "board-list", jobId } or null.
export function atsLivenessTarget(rawUrl) {
  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    return null;
  }
  const host = url.hostname.toLowerCase();
  const parts = url.pathname.split("/").filter(Boolean);
  const enc = encodeURIComponent;

  if (/^(boards|job-boards)(\.eu)?\.greenhouse\.io$/.test(host)) {
    const jobIdx = parts.indexOf("jobs");
    if (parts.length >= 3 && jobIdx === 1 && /^\d+$/.test(parts[2])) {
      return {
        provider: "greenhouse",
        kind: "posting",
        apiUrl: `https://boards-api.greenhouse.io/v1/boards/${enc(parts[0])}/jobs/${parts[2]}`,
      };
    }
    return null;
  }
  if (host === "jobs.lever.co" || host === "jobs.eu.lever.co") {
    if (parts.length >= 2 && /^[0-9a-f-]{16,}$/i.test(parts[1])) {
      const api = host === "jobs.eu.lever.co" ? "api.eu.lever.co" : "api.lever.co";
      return {
        provider: "lever",
        kind: "posting",
        apiUrl: `https://${api}/v0/postings/${enc(parts[0])}/${parts[1]}`,
      };
    }
    return null;
  }
  if (host === "jobs.ashbyhq.com") {
    if (parts.length >= 2 && /^[0-9a-f-]{16,}$/i.test(parts[1])) {
      return {
        provider: "ashby",
        kind: "board-list",
        jobId: parts[1].toLowerCase(),
        apiUrl: `https://api.ashbyhq.com/posting-api/job-board/${enc(parts[0])}`,
      };
    }
    return null;
  }
  if (host === "apply.workable.com") {
    if (parts.length >= 3 && parts[1] === "j" && /^[0-9a-z]+$/i.test(parts[2])) {
      return {
        provider: "workable",
        kind: "posting",
        apiUrl: `https://apply.workable.com/api/v2/accounts/${enc(parts[0])}/jobs/${parts[2]}`,
      };
    }
    return null;
  }
  if (host === "jobs.smartrecruiters.com") {
    const id = /^(\d{6,})/.exec(parts[1] || "")?.[1];
    if (parts.length >= 2 && id) {
      return {
        provider: "smartrecruiters",
        kind: "posting",
        apiUrl: `https://api.smartrecruiters.com/v1/companies/${enc(parts[0])}/postings/${id}`,
      };
    }
    return null;
  }
  return null;
}

// Resolves to a liveness result, or null when the URL isn't a supported ATS
// posting or the ATS gave no definitive answer.
export async function checkAtsLiveness(url, { fetchImpl, resolveHost, timeoutMs = 15000 } = {}) {
  const target = atsLivenessTarget(url);
  if (!target) return null;
  const fetched = await fetchPublicHttpText(target.apiUrl, {
    fetchImpl,
    resolveHost,
    timeoutMs: target.provider === "ashby" ? Math.max(timeoutMs, ASHBY_TIMEOUT_MS) : timeoutMs,
    maxBytes: ASHBY_MAX_BYTES,
    readErrorBody: false,
    maxRedirects: 0,
  });
  if (!fetched.ok) return null;
  const via = `${target.provider} API`;
  const gone = (reason) => ({
    url,
    result: "expired",
    code: "ats_gone",
    reason,
    source: target.provider,
  });
  if (fetched.status === 404 || fetched.status === 410) {
    return gone(`${via} says the posting is gone (HTTP ${fetched.status})`);
  }
  if (fetched.status !== 200) return null;

  let body;
  try {
    body = JSON.parse(fetched.rawText);
  } catch {
    return null; // a 200 that isn't the API's JSON (interstitial, proxy page) proves nothing
  }
  if (!body || typeof body !== "object") return null;

  if (target.kind === "board-list") {
    const jobs = body.jobs;
    if (!Array.isArray(jobs)) return null;
    const open = jobs.some(
      (job) =>
        String(job?.id || "").toLowerCase() === target.jobId ||
        String(job?.jobUrl || job?.applyUrl || "")
          .toLowerCase()
          .includes(target.jobId)
    );
    return open
      ? { url, result: "active", code: "ats_open", reason: `listed on the ${via}`, source: "ashby" }
      : gone(`${via} no longer lists the posting`);
  }
  return {
    url,
    result: "active",
    code: "ats_open",
    reason: `${via} returns the posting`,
    source: target.provider,
  };
}
