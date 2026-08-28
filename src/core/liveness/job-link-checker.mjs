import { fetchPublicHttpText } from "../net/public-http-fetch.mjs";
import { APPLY_PATTERNS, classifyLiveness, primaryPostingText } from "./liveness-core.mjs";

const LIVENESS_MAX_BYTES = 1024 * 1024;

export function htmlToText(html = "") {
  return String(html)
    .replace(/<script\b[^>]*>[\s\S]*?<\/script[^>]*>/gi, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style[^>]*>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function extractApplyControlsFromHtml(html = "") {
  const text = primaryPostingText(htmlToText(html));
  return APPLY_PATTERNS.some((pattern) => pattern.test(text)) ? ["Apply"] : [];
}

export async function checkUrlLiveness(
  url,
  { fetchImpl = fetch, resolveHost, timeoutMs = 15000, maxBytes = LIVENESS_MAX_BYTES } = {}
) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return { result: "uncertain", code: "invalid_url", reason: "invalid URL", url };
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return {
      result: "uncertain",
      code: "unsupported_protocol",
      reason: `unsupported protocol ${parsed.protocol}`,
      url,
    };
  }

  try {
    const fetched = await fetchPublicHttpText(url, {
      fetchImpl,
      resolveHost,
      timeoutMs,
      maxBytes,
    });
    if (!fetched.ok) {
      const unsafe = fetched.code === "unsafe_url" || fetched.code === "unsafe_redirect";
      return {
        result: "uncertain",
        code: unsafe ? "unsafe_url" : fetched.code,
        reason: fetched.reason,
        url,
      };
    }
    const html = fetched.rawText;
    const classified = classifyLiveness({
      status: fetched.status,
      finalUrl: fetched.finalUrl || url,
      bodyText: htmlToText(html),
      applyControls: extractApplyControlsFromHtml(html),
    });
    if (classified.code === "insufficient_content" && isSpaJobHost(parsed.hostname)) {
      return {
        url,
        result: "uncertain",
        code: "spa_shell",
        reason: "short SPA shell - use browser/API liveness before deleting",
        ...spaEscalation(parsed),
      };
    }
    return {
      url,
      ...classified,
    };
  } catch (error) {
    return { result: "uncertain", code: "navigation_error", reason: error.message, url };
  }
}

const LEVER_HOSTS = new Set(["jobs.lever.co", "jobs.eu.lever.co"]);

/**
 * Returns escalation hint fields to merge into a spa_shell return.
 * Lever hosts → escalationHint:'lever-json' + escalationUrl pointing at the
 * api.lever.co JSON endpoint.  All other SPA hosts → escalationHint:'browser-evaluate'.
 */
function spaEscalation(parsedUrl) {
  if (LEVER_HOSTS.has(parsedUrl.hostname)) {
    // First non-empty path segment is the company slug (e.g. /acme/job-id → "acme").
    const company = parsedUrl.pathname.split("/").filter(Boolean)[0] ?? null;
    const escalationUrl = company ? `https://api.lever.co/v0/postings/${company}?mode=json` : null;
    return { escalationHint: "lever-json", escalationUrl };
  }
  return { escalationHint: "browser-evaluate" };
}

// Exported for reuse by src/core/intake/resolve.mjs (M9's deterministic
// intake URL resolver checks the same known-SPA host set before deciding
// whether a plain server-side fetch can possibly work).
export function isSpaJobHost(hostname) {
  return (
    LEVER_HOSTS.has(hostname) ||
    [
      "jobs.ashbyhq.com",
      "jobs.apple.com",
      "careers.snowflake.com",
      "www.coinbase.com",
      // Wellfound: plain HTTP fetch returns 403 Forbidden — must use browser/Playwright.
      "wellfound.com",
      "www.wellfound.com",
    ].includes(hostname)
  );
}
