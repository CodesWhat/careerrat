import { lookup as dnsLookup } from "node:dns/promises";
import { isIP } from "node:net";
import {
  DEEP_INGEST_FETCH_MAX_BYTES,
  DEEP_INGEST_FETCH_TIMEOUT_MS,
  plainTextFromHtml,
} from "./source-normalize.mjs";

const MAX_REDIRECTS = 4;

export async function fetchDeepIngestUrl(
  rawUrl,
  {
    fetchImpl = fetch,
    resolveHost = resolvePublicHost,
    timeoutMs = DEEP_INGEST_FETCH_TIMEOUT_MS,
    maxBytes = DEEP_INGEST_FETCH_MAX_BYTES,
  } = {}
) {
  const start = await validateFetchablePublicHttpUrl(rawUrl, { resolveHost });
  if (!start.ok) {
    return { ok: false, status: "not_available", reason: start.reason, url: rawUrl };
  }

  let current = start.url;
  for (let redirectCount = 0; redirectCount <= MAX_REDIRECTS; redirectCount += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    let response;
    try {
      response = await fetchImpl(current, { signal: controller.signal, redirect: "manual" });
    } catch (err) {
      clearTimeout(timeout);
      throw err;
    }
    clearTimeout(timeout);

    const redirected = redirectTarget(response, current);
    if (redirected) {
      const checked = await validateFetchablePublicHttpUrl(redirected, { resolveHost });
      if (!checked.ok) {
        return {
          ok: false,
          status: "not_available",
          url: current,
          finalUrl: redirected,
          reason: `unsafe redirect target: ${checked.reason}`,
        };
      }
      current = checked.url;
      continue;
    }

    const status = Number(response?.status || 0);
    if (status < 200 || status >= 300) {
      return {
        ok: false,
        status: status === 404 ? "not_available" : "gap",
        url: rawUrl,
        finalUrl: response?.url || current,
        reason: `HTTP ${status || "unknown"} from source`,
      };
    }

    const contentLength = Number(response?.headers?.get?.("content-length"));
    if (Number.isFinite(contentLength) && contentLength > maxBytes) {
      return {
        ok: false,
        status: "gap",
        url: current,
        finalUrl: response?.url || current,
        reason: `response too large (${contentLength} bytes)`,
        truncated: true,
      };
    }

    const rawText = await response.text();
    const byteLength = Buffer.byteLength(rawText, "utf8");
    const contentType = String(response?.headers?.get?.("content-type") || "").toLowerCase();
    const text = contentType.includes("html") ? plainTextFromHtml(rawText) : rawText.trim();
    const truncated = byteLength > maxBytes;
    return {
      ok: true,
      status: response.status,
      url: rawUrl,
      finalUrl: response?.url || current,
      contentType,
      text: truncated ? text.slice(0, maxBytes) : text,
      byteLength,
      truncated,
      reason: truncated ? `response truncated at ${maxBytes} bytes` : null,
    };
  }

  return {
    ok: false,
    status: "gap",
    url: rawUrl,
    reason: "too many redirects",
  };
}

export function validatePublicHttpUrl(rawUrl) {
  let parsed;
  try {
    parsed = new URL(String(rawUrl || "").trim());
  } catch {
    return { ok: false, reason: "invalid URL" };
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return { ok: false, reason: `unsupported URL scheme ${parsed.protocol}` };
  }

  const host = parsed.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (!host || host === "localhost" || host.endsWith(".localhost")) {
    return { ok: false, reason: "private or local host is not fetchable" };
  }

  if (isPrivateIp(host)) {
    return { ok: false, reason: "private or local network host is not fetchable" };
  }

  return { ok: true, url: parsed.toString() };
}

async function validateFetchablePublicHttpUrl(rawUrl, { resolveHost } = {}) {
  const checked = validatePublicHttpUrl(rawUrl);
  if (!checked.ok) return checked;
  if (typeof resolveHost !== "function") return checked;

  const host = new URL(checked.url).hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (isIP(host)) return checked;

  let addresses;
  try {
    addresses = await resolveHost(host);
  } catch {
    return { ok: false, reason: "host could not be resolved" };
  }

  const normalized = (Array.isArray(addresses) ? addresses : [addresses])
    .map((entry) => (typeof entry === "string" ? entry : entry?.address))
    .map((address) => String(address || "").trim())
    .filter(Boolean);
  if (!normalized.length) return { ok: false, reason: "host resolved to no addresses" };

  if (normalized.some((address) => isPrivateIp(address))) {
    return { ok: false, reason: "private or local network host is not fetchable" };
  }

  return checked;
}

function redirectTarget(response, currentUrl) {
  const status = Number(response?.status || 0);
  if (![301, 302, 303, 307, 308].includes(status)) return null;
  const location = response?.headers?.get?.("location");
  if (!location) return null;
  return new URL(location, currentUrl).toString();
}

function isPrivateIp(host) {
  const ipVersion = isIP(host);
  if (!ipVersion) return false;
  if (ipVersion === 6) {
    const mapped = host.toLowerCase().match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped) return isPrivateIp(mapped[1]);
    return (
      host === "::" ||
      host === "::1" ||
      host.startsWith("fc") ||
      host.startsWith("fd") ||
      host.startsWith("fe80")
    );
  }
  const parts = host.split(".").map((part) => Number.parseInt(part, 10));
  const [a, b] = parts;
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168)
  );
}

function resolvePublicHost(host) {
  return dnsLookup(host, { all: true, verbatim: true });
}
