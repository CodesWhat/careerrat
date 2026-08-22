import { lookup as dnsLookup } from "node:dns/promises";
import { isIP } from "node:net";
import { Agent } from "undici";

const DEFAULT_PUBLIC_FETCH_TIMEOUT_MS = 15_000;
const DEFAULT_PUBLIC_FETCH_MAX_BYTES = 1024 * 1024;
const DEFAULT_MAX_REDIRECTS = 4;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

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

  const hostname = normalizedHostname(parsed.hostname);
  if (!hostname || hostname === "localhost" || hostname.endsWith(".localhost")) {
    return { ok: false, reason: "private or local host is not fetchable" };
  }
  if (isNonPublicIp(hostname)) {
    return { ok: false, reason: "private, local, or non-public network host is not fetchable" };
  }

  return { ok: true, url: parsed.toString() };
}

async function resolvePublicHttpTarget(rawUrl, { resolveHost = resolvePublicHost } = {}) {
  const checked = validatePublicHttpUrl(rawUrl);
  if (!checked.ok) return checked;

  const hostname = normalizedHostname(new URL(checked.url).hostname);
  if (isIP(hostname)) {
    return {
      ok: true,
      url: checked.url,
      hostname,
      addresses: [{ address: hostname, family: isIP(hostname) }],
    };
  }

  let resolved;
  try {
    resolved = await resolveHost(hostname);
  } catch {
    return { ok: false, reason: "host could not be resolved" };
  }
  const addresses = normalizeAddresses(resolved);
  if (!addresses.length) return { ok: false, reason: "host resolved to no addresses" };
  if (addresses.some(({ address }) => isNonPublicIp(address))) {
    return { ok: false, reason: "host resolved to a private, local, or non-public address" };
  }

  return { ok: true, url: checked.url, hostname, addresses };
}

export async function fetchPublicHttpText(
  rawUrl,
  {
    fetchImpl = fetch,
    resolveHost = resolvePublicHost,
    dispatcherFactory = createPinnedDispatcher,
    timeoutMs = DEFAULT_PUBLIC_FETCH_TIMEOUT_MS,
    maxBytes = DEFAULT_PUBLIC_FETCH_MAX_BYTES,
    maxRedirects = DEFAULT_MAX_REDIRECTS,
    readErrorBody = true,
  } = {}
) {
  let target = await resolvePublicHttpTarget(rawUrl, { resolveHost });
  if (!target.ok) return failure("unsafe_url", target.reason, { url: rawUrl });

  for (let redirectCount = 0; redirectCount <= maxRedirects; redirectCount += 1) {
    const currentUrl = target.url;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    const dispatcher = dispatcherFactory({
      hostname: target.hostname,
      addresses: target.addresses,
    });

    try {
      // DNS is resolved and validated above, then pinned into this hop's
      // dispatcher. Fetch therefore cannot perform a second, attacker-controlled
      // lookup between validation and connection (DNS rebinding / TOCTOU).
      const response = await fetchImpl(currentUrl, {
        signal: controller.signal,
        redirect: "manual",
        dispatcher,
      });
      const redirectUrl = redirectTarget(response, currentUrl);
      if (redirectUrl) {
        await cancelBody(response);
        if (redirectCount === maxRedirects) {
          return failure("too_many_redirects", "too many redirects", {
            url: rawUrl,
            finalUrl: currentUrl,
          });
        }
        const next = await resolvePublicHttpTarget(redirectUrl, { resolveHost });
        if (!next.ok) {
          return failure("unsafe_redirect", `unsafe redirect target: ${next.reason}`, {
            url: rawUrl,
            finalUrl: redirectUrl,
          });
        }
        target = next;
        continue;
      }

      const status = Number(response?.status || 0);
      const finalUrl = response?.url || currentUrl;
      const contentType = String(response?.headers?.get?.("content-type") || "").toLowerCase();
      if (!readErrorBody && (status < 200 || status >= 300)) {
        await cancelBody(response);
        return {
          ok: true,
          url: rawUrl,
          finalUrl,
          status,
          contentType,
          rawText: "",
          byteLength: 0,
          truncated: false,
        };
      }
      const declaredLength = Number(response?.headers?.get?.("content-length"));
      if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
        await cancelBody(response);
        return failure("response_too_large", `response too large (limit ${maxBytes} bytes)`, {
          url: rawUrl,
          finalUrl,
          status,
          contentType,
          byteLength: maxBytes,
          truncated: true,
        });
      }

      const body = await readBodyCapped(response, maxBytes);
      if (body.truncated) {
        return failure("response_too_large", `response too large (limit ${maxBytes} bytes)`, {
          url: rawUrl,
          finalUrl,
          status,
          contentType,
          byteLength: body.byteLength,
          truncated: true,
        });
      }

      return {
        ok: true,
        url: rawUrl,
        finalUrl,
        status,
        contentType,
        rawText: body.text,
        byteLength: body.byteLength,
        truncated: false,
      };
    } catch (error) {
      const timedOut = controller.signal.aborted;
      return failure(
        timedOut ? "timeout" : "fetch_failed",
        timedOut ? `fetch timed out after ${timeoutMs}ms` : `fetch failed: ${error.message}`,
        { url: rawUrl, finalUrl: currentUrl }
      );
    } finally {
      clearTimeout(timeout);
      await closeDispatcher(dispatcher);
    }
  }

  return failure("too_many_redirects", "too many redirects", { url: rawUrl });
}

async function readBodyCapped(response, maxBytes) {
  const reader = response?.body?.getReader?.();
  if (!reader) {
    const text = String(await response.text());
    const bytes = Buffer.from(text, "utf8");
    return {
      text: bytes.subarray(0, maxBytes).toString("utf8"),
      byteLength: Math.min(bytes.byteLength, maxBytes),
      truncated: bytes.byteLength > maxBytes,
    };
  }

  const chunks = [];
  let byteLength = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    const chunk = Buffer.from(value);
    const remaining = maxBytes - byteLength;
    if (chunk.byteLength > remaining) {
      if (remaining > 0) chunks.push(chunk.subarray(0, remaining));
      byteLength = maxBytes;
      await reader.cancel();
      return { text: Buffer.concat(chunks).toString("utf8"), byteLength, truncated: true };
    }
    chunks.push(chunk);
    byteLength += chunk.byteLength;
  }
  return { text: Buffer.concat(chunks).toString("utf8"), byteLength, truncated: false };
}

function redirectTarget(response, currentUrl) {
  const status = Number(response?.status || 0);
  if (!REDIRECT_STATUSES.has(status)) return null;
  const location = response?.headers?.get?.("location");
  if (!location) return null;
  try {
    return new URL(location, currentUrl).toString();
  } catch {
    return null;
  }
}

function createPinnedDispatcher({ addresses }) {
  const approved = normalizeAddresses(addresses);
  return new Agent({
    connect: {
      lookup(_hostname, options, callback) {
        if (options?.all) {
          callback(null, approved);
          return;
        }
        const requestedFamily = Number(options?.family || 0);
        const selected = approved.find(
          (entry) => !requestedFamily || entry.family === requestedFamily
        );
        if (!selected) {
          callback(new Error("no approved address for requested family"));
          return;
        }
        callback(null, selected.address, selected.family);
      },
    },
  });
}

function normalizeAddresses(values) {
  return (Array.isArray(values) ? values : [values])
    .map((entry) => {
      const address = typeof entry === "string" ? entry : entry?.address;
      const normalized = normalizedHostname(address);
      const family = Number(
        typeof entry === "string" ? isIP(normalized) : entry?.family || isIP(normalized)
      );
      return { address: normalized, family };
    })
    .filter(({ address, family }) => address && (family === 4 || family === 6));
}

function normalizedHostname(value) {
  return String(value || "")
    .replace(/^\[|\]$/g, "")
    .toLowerCase();
}

function isNonPublicIp(value) {
  const host = normalizedHostname(value);
  const version = isIP(host);
  if (!version) return false;
  if (version === 6) {
    // Node's URL parser canonicalizes bracketed IPv6 hosts to the hex-group
    // form (::ffff:127.0.0.1 -> ::ffff:7f00:1), so a textual dotted-decimal
    // match alone lets an embedded IPv4 loopback/metadata address through.
    // Decode any embedded IPv4 (mapped ::ffff:0:0/96, and the deprecated
    // IPv4-compatible ::/96) from either textual form back to its IPv4 and
    // reuse the IPv4 logic below on it.
    const embedded = embeddedIpv4(host);
    if (embedded) return isNonPublicIp(embedded);
    return (
      host === "::" ||
      host === "::1" ||
      host.startsWith("fc") ||
      host.startsWith("fd") ||
      /^fe[89ab]/.test(host) ||
      host.startsWith("2001:db8:")
    );
  }

  const [a, b, c] = host.split(".").map((part) => Number.parseInt(part, 10));
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 0 && c === 0) ||
    (a === 192 && b === 0 && c === 2) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) ||
    (a === 198 && b === 51 && c === 100) ||
    (a === 203 && b === 0 && c === 113) ||
    a >= 224
  );
}

// Returns the embedded IPv4 (dotted-decimal string) for an IPv6 address that
// carries one in its low 32 bits — IPv4-mapped (::ffff:0:0/96) or the
// deprecated IPv4-compatible form (::/96) — or null otherwise. Handles both
// the canonical hex-group form Node's URL parser produces (::ffff:7f00:1)
// and the textual dotted-decimal form (::ffff:127.0.0.1), since the groups
// come from a shared IPv6 parser rather than a single regex shape.
function embeddedIpv4(host) {
  const groups = ipv6ToGroups(host);
  if (!groups) return null;
  const highZero = groups.slice(0, 5).every((g) => g === 0);
  const isMapped = highZero && groups[5] === 0xffff;
  const isCompatible = highZero && groups[5] === 0;
  if (!isMapped && !isCompatible) return null;
  const a = groups[6] >> 8;
  const b = groups[6] & 0xff;
  const c = groups[7] >> 8;
  const d = groups[7] & 0xff;
  return `${a}.${b}.${c}.${d}`;
}

// Expands a normalized (lowercase, unbracketed) IPv6 address into its 8
// 16-bit groups, resolving "::" compression and an optional trailing
// dotted-decimal IPv4 tail. Returns null for anything that doesn't parse.
function ipv6ToGroups(host) {
  if (!host.includes(":")) return null;
  const compressAt = host.indexOf("::");
  const head = compressAt === -1 ? host : host.slice(0, compressAt);
  const tail = compressAt === -1 ? "" : host.slice(compressAt + 2);

  const headGroups = expandIpv6Parts(head ? head.split(":") : []);
  const tailGroups = expandIpv6Parts(tail ? tail.split(":") : []);
  if (!headGroups || !tailGroups) return null;

  if (compressAt === -1) {
    return headGroups.length === 8 ? headGroups : null;
  }
  const missing = 8 - headGroups.length - tailGroups.length;
  if (missing < 0) return null;
  return [...headGroups, ...new Array(missing).fill(0), ...tailGroups];
}

// Expands a run of colon-separated IPv6 parts into 16-bit groups. A part
// containing "." is a trailing embedded IPv4 tail and expands to 2 groups.
function expandIpv6Parts(parts) {
  const out = [];
  for (const part of parts) {
    if (part.includes(".")) {
      const match = part.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
      if (!match) return null;
      const bytes = match.slice(1).map(Number);
      if (bytes.some((b) => b < 0 || b > 255)) return null;
      out.push((bytes[0] << 8) | bytes[1], (bytes[2] << 8) | bytes[3]);
    } else {
      if (!/^[0-9a-f]{1,4}$/.test(part)) return null;
      out.push(Number.parseInt(part, 16));
    }
  }
  return out;
}

function failure(code, reason, extra = {}) {
  return { ok: false, code, reason, ...extra };
}

async function cancelBody(response) {
  try {
    await response?.body?.cancel?.();
  } catch {
    // Best effort; the per-hop dispatcher is closed immediately afterward.
  }
}

async function closeDispatcher(dispatcher) {
  try {
    await dispatcher?.close?.();
  } catch {
    try {
      dispatcher?.destroy?.();
    } catch {
      // Best effort cleanup after a failed or aborted request.
    }
  }
}

function resolvePublicHost(host) {
  return dnsLookup(host, { all: true, verbatim: true });
}
