import { Parser } from "htmlparser2";
import { fetchPublicHttpText } from "../net/public-http-fetch.mjs";
import { checkAtsLiveness } from "./ats-liveness.mjs";
import { APPLY_PATTERNS, classifyLiveness, primaryPostingText } from "./liveness-core.mjs";

const LIVENESS_MAX_BYTES = 1024 * 1024;

const isWordCode = (code) =>
  (code >= 48 && code <= 57) ||
  (code >= 65 && code <= 90) ||
  code === 95 ||
  (code >= 97 && code <= 122);

// ASCII case-insensitive compare of a fixed-width lowercase word at index i.
function matchesAt(input, i, word) {
  if (i + word.length > input.length) return false;
  for (let k = 0; k < word.length; k += 1) {
    let code = input.charCodeAt(i + k);
    if (code >= 65 && code <= 90) code += 32;
    if (code !== word.charCodeAt(k)) return false;
  }
  return true;
}

// indexOf that records how far it scanned, so tests can bound total work.
function find(input, needle, from, probe) {
  const at = input.indexOf(needle, from);
  if (probe) probe.steps += (at === -1 ? input.length : at + 1) - from + 1;
  return at;
}

// Drops every <name ...> ... </name ...> block, like
// /<name\b[^>]*>[\s\S]*?<\/name[^>]*>/gi. The first failed attempt means every
// later one fails too (a later closer can only sit further right), so the
// scan stops there. The closer search is a forward-only fixed-width scan.
function stripBlocks(input, name, probe) {
  const open = `<${name}`;
  const close = `</${name}`;
  const parts = [];
  let textStart = 0;
  let i = find(input, "<", 0, probe);
  while (i !== -1) {
    if (matchesAt(input, i, open) && !isWordCode(input.charCodeAt(i + open.length))) {
      const gt = find(input, ">", i + open.length, probe);
      if (gt === -1) break;
      let closer = find(input, "</", gt + 1, probe);
      while (closer !== -1 && !matchesAt(input, closer, close)) {
        closer = find(input, "</", closer + 1, probe);
      }
      if (closer === -1) break;
      const end = find(input, ">", closer + close.length, probe);
      if (end === -1) break;
      parts.push(input.slice(textStart, i), " ");
      textStart = end + 1;
      i = find(input, "<", textStart, probe);
      continue;
    }
    i = find(input, "<", i + 1, probe);
  }
  if (parts.length === 0) return input;
  parts.push(input.slice(textStart));
  return parts.join("");
}

// Replaces every <[^>]+> with a space. A "<" followed by ">" or the end is
// left alone; once no ">" remains nothing further can match.
function stripTags(input, probe) {
  const parts = [];
  let textStart = 0;
  let i = find(input, "<", 0, probe);
  while (i !== -1) {
    if (i + 1 < input.length && input.charCodeAt(i + 1) !== 62) {
      const gt = find(input, ">", i + 1, probe);
      if (gt === -1) break;
      parts.push(input.slice(textStart, i), " ");
      textStart = gt + 1;
      i = find(input, "<", textStart, probe);
      continue;
    }
    i = find(input, "<", i + 1, probe);
  }
  if (parts.length === 0) return input;
  parts.push(input.slice(textStart));
  return parts.join("");
}

// Same output as the old chain of regex replaces (script blocks, then style
// blocks, then every other tag), each pass in linear time. `probe` is an
// optional { steps } counter that tests use to bound the work.
export function htmlToText(html = "", probe = null) {
  let text = stripBlocks(String(html), "script", probe);
  text = stripBlocks(text, "style", probe);
  text = stripTags(text, probe);
  return text.replace(/\s+/g, " ").trim();
}

export function extractApplyControlsFromHtml(html = "") {
  let visibleText = "";
  let ignoredDepth = 0;
  const activeControls = [];
  const controls = [];
  const parser = new Parser(
    {
      onopentag(name, attributes) {
        if (ignoredDepth > 0) {
          ignoredDepth += 1;
          return;
        }
        if (name === "script" || name === "style" || name === "template") {
          ignoredDepth = 1;
          return;
        }

        visibleText += " ";
        const role = String(attributes.role || "")
          .trim()
          .toLowerCase();
        const type = String(attributes.type || "")
          .trim()
          .toLowerCase();
        const interactive =
          name === "a" ||
          name === "button" ||
          (name === "input" && type === "submit") ||
          role === "button";
        if (!interactive) return;

        const control = {
          name,
          start: visibleText.length,
          label: [attributes["aria-label"], attributes.title, attributes.value]
            .map((value) => String(value || "").trim())
            .filter(Boolean)
            .join(" "),
          text: "",
        };
        activeControls.push(control);
        if (name === "input") {
          controls.push(control);
          activeControls.pop();
        }
      },
      ontext(text) {
        if (ignoredDepth > 0) return;
        visibleText += text;
        for (const control of activeControls) control.text += text;
      },
      onclosetag(name) {
        if (ignoredDepth > 0) {
          ignoredDepth -= 1;
          return;
        }
        visibleText += " ";
        const index = activeControls.findLastIndex((control) => control.name === name);
        if (index < 0) return;
        controls.push(...activeControls.splice(index));
      },
    },
    { decodeEntities: true }
  );
  parser.end(String(html || ""));
  controls.push(...activeControls);

  const primaryEnd = primaryPostingText(visibleText).length;
  return controls
    .filter((control) => control.start <= primaryEnd)
    .map((control) => `${control.label} ${control.text}`.replace(/\s+/g, " ").trim())
    .filter((label) => APPLY_PATTERNS.some((pattern) => pattern.test(label)));
}

// True when the check never got an answer from the site (network failure or
// timeout), as opposed to reading the page and being unsure about it.
export function isUnreachable(result) {
  return (
    result?.result === "uncertain" &&
    ["fetch_failed", "navigation_error", "timeout"].includes(result.code)
  );
}

export async function checkUrlLiveness(
  url,
  {
    fetchImpl = fetch,
    resolveHost,
    timeoutMs = 15000,
    maxBytes = LIVENESS_MAX_BYTES,
    atsNative = true,
  } = {}
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

  // Ask the ATS's own job endpoint first. It only answers when the ATS gives
  // a definitive yes/gone; any failure falls through to the page check below.
  if (atsNative) {
    try {
      const ats = await checkAtsLiveness(url, { fetchImpl, resolveHost, timeoutMs });
      if (ats) return ats;
    } catch {
      // fall back to the page check
    }
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
    if (classified.code === "thin_content" && isSpaJobHost(parsed.hostname)) {
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
