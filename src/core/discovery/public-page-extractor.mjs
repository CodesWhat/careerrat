// public-page-extractor.mjs — deterministic public careers-page metadata.

import { createHash } from "node:crypto";
import { Parser } from "htmlparser2";
import { fetchPublicHttpText } from "../net/public-http-fetch.mjs";
import { inferProvider } from "../scoring/sourced-scanner.mjs";
import { htmlToPlainText } from "../text/html-text.mjs";

const TEXT_CAP = 200_000;
const JOB_LINK_RE = /\b(careers?|jobs?|openings?|roles?|join-us|positions?)\b/i;
const LOGIN_RE = /\b(sign in|log in|login|authenticate|authentication required)\b/i;
const NO_OPEN_ROLES_RE = /\b(no open roles|no open positions|no jobs|not hiring)\b/i;

function nowIso(now) {
  if (now instanceof Date) return now.toISOString();
  if (typeof now === "string" || typeof now === "number") return new Date(now).toISOString();
  return new Date().toISOString();
}

function makeError(message, code) {
  const err = new Error(message);
  err.code = code;
  return err;
}

function parsePublicUrl(value) {
  let url;
  try {
    url = new URL(String(value || ""));
  } catch {
    throw makeError("public careers page URL is invalid", "BAD_REQUEST");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw makeError("public careers page URL must use http or https", "BAD_REQUEST");
  }
  return url;
}

function hashText(text) {
  return `sha256-${createHash("sha256")
    .update(String(text || ""))
    .digest("hex")}`;
}

function visibleText(html = "") {
  return htmlToPlainText(html, { blockSeparator: " " })
    .replace(/\u00a0/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function extractRobots(html = "") {
  let robots = "";
  const parser = new Parser(
    {
      onopentag(name, attributes) {
        if (name === "meta" && String(attributes.name || "").toLowerCase() === "robots") {
          robots = String(attributes.content || "").toLowerCase();
        }
      },
    },
    { decodeEntities: true }
  );
  parser.end(String(html || ""));
  return robots;
}

function extractLinks(html = "", baseUrl) {
  const links = [];
  const seen = new Set();
  const parser = new Parser(
    {
      onopentag(name, attributes) {
        if (name !== "a") return;
        const href = String(attributes.href || "").trim();
        if (!href || href.startsWith("#") || /^mailto:|^tel:/i.test(href)) return;
        let url;
        try {
          url = new URL(href, baseUrl);
        } catch {
          return;
        }
        if (url.protocol !== "http:" && url.protocol !== "https:") return;
        const key = url.toString();
        if (seen.has(key)) return;
        seen.add(key);
        links.push(url);
      },
    },
    { decodeEntities: true }
  );
  parser.end(String(html || ""));
  return links;
}

function provenance(source, url, observedAt, extra = {}) {
  return { source, url: url.toString(), observedAt, ...extra };
}

function baseResult({ url, html, observedAt, status, reviewRequired = false, aiEligible = false }) {
  return {
    ok: true,
    extractionStatus: status,
    reviewRequired,
    aiEligible,
    metadata: {
      url: url.toString(),
      inputHash: hashText(html),
      provenance: [provenance("public-page-fetch", url, observedAt)],
    },
  };
}

function linkRecord(url) {
  return {
    url: url.toString(),
    providerHint: inferProvider({ careers_url: url.toString() }) || "custom",
    confidence: inferProvider({ careers_url: url.toString() }) ? "high" : "low",
  };
}

export async function extractPublicCareersPage({
  url,
  fetchImpl = fetch,
  resolveHost,
  timeoutMs = 15_000,
  now = new Date(),
} = {}) {
  const parsedUrl = parsePublicUrl(url);
  const observedAt = nowIso(now);
  const fetched = await fetchPublicHttpText(parsedUrl.toString(), {
    fetchImpl,
    resolveHost,
    timeoutMs,
    maxBytes: TEXT_CAP,
  });
  if (!fetched.ok) {
    const unsafe = fetched.code === "unsafe_url" || fetched.code === "unsafe_redirect";
    return {
      ok: true,
      extractionStatus: unsafe
        ? "blocked_unsafe_url"
        : fetched.code === "response_too_large"
          ? "blocked_response_too_large"
          : "blocked_fetch_failed",
      reviewRequired: false,
      aiEligible: false,
      metadata: {
        url: parsedUrl.toString(),
        inputHash: hashText(""),
        provenance: [provenance("public-page-fetch-failed", parsedUrl, observedAt)],
        errorClass: fetched.code || "FETCH_FAILED",
      },
    };
  }

  if (fetched.status === 401 || fetched.status === 403) {
    return baseResult({
      url: parsedUrl,
      html: "",
      observedAt,
      status: "blocked_http",
    });
  }
  if (fetched.status < 200 || fetched.status >= 300) {
    return baseResult({
      url: parsedUrl,
      html: "",
      observedAt,
      status: "no_result_http",
    });
  }

  const html = fetched.rawText;
  if (!html.trim()) {
    return baseResult({
      url: parsedUrl,
      html,
      observedAt,
      status: "no_result_empty",
    });
  }

  const robots = extractRobots(html);
  if (robots.includes("noindex") || robots.includes("nofollow")) {
    return baseResult({
      url: parsedUrl,
      html,
      observedAt,
      status: "robots_disallowed",
    });
  }

  const text = visibleText(html);
  if (LOGIN_RE.test(text)) {
    return baseResult({
      url: parsedUrl,
      html,
      observedAt,
      status: "login_required",
    });
  }

  const links = extractLinks(html, parsedUrl);
  for (const link of links) {
    const atsProvider = inferProvider({ careers_url: link.toString() });
    if (!atsProvider) continue;
    return {
      ok: true,
      extractionStatus: "metadata_found",
      reviewRequired: false,
      aiEligible: false,
      metadata: {
        url: parsedUrl.toString(),
        jobBoardUrl: link.toString(),
        atsProvider,
        inputHash: hashText(html),
        confidence: "high",
        publicSignals: ["supported-ats-link"],
        provenance: [
          provenance("public-page-fetch", parsedUrl, observedAt),
          provenance("public-page-link", link, observedAt),
        ],
      },
    };
  }

  if (NO_OPEN_ROLES_RE.test(text)) {
    return baseResult({
      url: parsedUrl,
      html,
      observedAt,
      status: "no_public_jobs_signal",
    });
  }

  const jobishLinks = links.filter(
    (link) => JOB_LINK_RE.test(link.pathname) || JOB_LINK_RE.test(link.host)
  );
  if (jobishLinks.length >= 2) {
    return {
      ok: true,
      extractionStatus: "ambiguous_public_page",
      reviewRequired: true,
      aiEligible: false,
      usableText: text.slice(0, 8000),
      metadata: {
        url: parsedUrl.toString(),
        inputHash: hashText(html),
        confidence: "low",
        candidates: jobishLinks.slice(0, 5).map(linkRecord),
        publicSignals: ["multiple-public-job-links"],
        provenance: [provenance("public-page-fetch", parsedUrl, observedAt)],
      },
    };
  }

  if (!JOB_LINK_RE.test(text) && !jobishLinks.length) {
    return baseResult({
      url: parsedUrl,
      html,
      observedAt,
      status: "unsupported_public_no_result",
    });
  }

  return {
    ok: true,
    extractionStatus: "ambiguous_public_page",
    reviewRequired: true,
    aiEligible: false,
    usableText: text.slice(0, 8000),
    metadata: {
      url: parsedUrl.toString(),
      inputHash: hashText(html),
      confidence: "low",
      candidates: jobishLinks.slice(0, 5).map(linkRecord),
      publicSignals: ["unstructured-public-jobs-signal"],
      provenance: [provenance("public-page-fetch", parsedUrl, observedAt)],
    },
  };
}
