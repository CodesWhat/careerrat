import { lookup as dnsLookup } from "node:dns/promises";
import { isIP } from "node:net";
import { Agent } from "undici";

const DEFAULT_PUBLIC_FETCH_TIMEOUT_MS = 15_000;
const DEFAULT_PUBLIC_FETCH_MAX_BYTES = 1024 * 1024;
const DEFAULT_MAX_REDIRECTS = 4;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

// WHATWG fetch's "request-body-header name" list: headers that describe the
// body being sent, so they must not survive a redirect hop that drops the
// body (see https://fetch.spec.whatwg.org/#request-body-header-name).
const REQUEST_BODY_HEADER_NAMES = [
  "content-type",
  "content-length",
  "content-encoding",
  "content-language",
  "transfer-encoding",
];

// Headers a caller-supplied credential must never survive a cross-origin hop
// on, so guardedFetch's own redirect chain can't hand a caller's bearer
// token or session cookie to a host the caller never named.
const CROSS_ORIGIN_STRIP_HEADER_NAMES = ["authorization", "cookie"];

// Normalizes an init.headers value (plain object, Headers instance, or array
// of [name, value] pairs, every shape RequestInit.headers accepts) into a
// case-insensitive Map keyed by lowercase header name, each entry keeping the
// original casing for re-serialization. Doing this once up front lets the
// redirect loop below mutate one representation per hop instead of
// re-detecting the shape on every hop.
function normalizeHeadersInit(headersInit) {
  const map = new Map();
  if (!headersInit) return map;
  if (Array.isArray(headersInit)) {
    for (const pair of headersInit) {
      const [name, value] = pair;
      if (name === undefined) continue;
      map.set(String(name).toLowerCase(), { name: String(name), value: String(value) });
    }
    return map;
  }
  // Headers-like (has both entries() and forEach(), and isn't a plain array).
  if (typeof headersInit.entries === "function" && typeof headersInit.forEach === "function") {
    for (const [name, value] of headersInit.entries()) {
      map.set(String(name).toLowerCase(), { name: String(name), value: String(value) });
    }
    return map;
  }
  for (const [name, value] of Object.entries(headersInit)) {
    if (value === undefined) continue;
    map.set(name.toLowerCase(), { name, value });
  }
  return map;
}

function headersMapToObject(map) {
  const obj = {};
  for (const { name, value } of map.values()) obj[name] = value;
  return obj;
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

  const hostname = normalizedHostname(parsed.hostname);
  if (!hostname || hostname === "localhost" || hostname.endsWith(".localhost")) {
    return { ok: false, reason: "private or local host is not fetchable" };
  }
  if (isNonPublicIp(hostname)) {
    return { ok: false, reason: "private, local, or non-public network host is not fetchable" };
  }

  return { ok: true, url: parsed.toString() };
}

// Races a resolveHost() lookup against an (optional) abort signal so a
// stalled DNS lookup cannot outlive the caller's own deadline. `signal` comes
// from the caller's timeout/AbortController (fetchPublicHttpText's per-hop
// controller, or guardedFetch's init.signal). Without this, resolveHost was
// awaited plainly and a lookup that never settles (a hung resolver, a
// black-holed network) kept the whole call open forever, timeoutMs or not.
//
// Promise.race attaches a handler to BOTH promises the moment it runs, so
// neither one can produce an unhandled-rejection warning regardless of which
// one settles first or how much later the loser eventually does.
function abortSignalRejection(signal) {
  return new Promise((_, reject) => {
    if (signal.aborted) {
      reject(signal.reason);
      return;
    }
    signal.addEventListener("abort", () => reject(signal.reason), { once: true });
  });
}

async function resolveHostWithDeadline(resolveHost, hostname, signal) {
  const hostLookup = Promise.resolve().then(() => resolveHost(hostname));
  if (!signal) return hostLookup;
  return Promise.race([hostLookup, abortSignalRejection(signal)]);
}

async function resolvePublicHttpTarget(rawUrl, { resolveHost = resolvePublicHost, signal } = {}) {
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
    resolved = await resolveHostWithDeadline(resolveHost, hostname, signal);
  } catch (error) {
    // Distinguish "the deadline fired while we were waiting" from an
    // ordinary resolution failure (NXDOMAIN, network error, …) so the abort
    // reason set by the caller's own timeout is visible in the result rather
    // than being flattened into the same generic message either way.
    if (signal && error === signal.reason) {
      return {
        ok: false,
        reason: `host resolution aborted: ${String(signal.reason?.message ?? signal.reason ?? "aborted")}`,
      };
    }
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
  let target;
  {
    // The initial resolution has no hop-scoped controller yet (that is
    // created per-hop below, for the fetch itself), so give it its own,
    // bounded by the same timeoutMs, so a stalled first lookup can't hang
    // the call indefinitely.
    const initialController = new AbortController();
    const initialTimeout = setTimeout(() => initialController.abort(), timeoutMs);
    try {
      target = await resolvePublicHttpTarget(rawUrl, {
        resolveHost,
        signal: initialController.signal,
      });
    } finally {
      clearTimeout(initialTimeout);
    }
  }
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
        // The current hop's controller/timeout is still live here (its
        // `finally` hasn't run yet), so reusing controller.signal bounds this
        // redirect's DNS lookup by the same deadline as the hop that produced it.
        const next = await resolvePublicHttpTarget(redirectUrl, {
          resolveHost,
          signal: controller.signal,
        });
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

// Guarded fetch for callers that need the raw Response (status/headers/body
// stream) rather than fetchPublicHttpText's capped-text contract — e.g. the
// Career Ops provider registry, which drives arbitrary methods/bodies/headers
// per provider and consumes the body itself (JSON, text, or a rebuilt
// Response). Every connection this makes, including the redirect: "follow"
// case below, goes through the same validate-resolve-pin sequence as
// fetchPublicHttpText: protocol + literal-IP screening, DNS resolution, and
// non-public-range screening of the resolved addresses, with those addresses
// pinned into the dispatcher so the actual connection can't land anywhere the
// check didn't approve (DNS rebinding / TOCTOU).
//
// Redirect handling depends on the caller's own `init.redirect`:
//   - "follow" (or unset, matching native fetch's default): we drive the
//     chain ourselves with redirect: "manual" against the underlying
//     fetchImpl, so every hop is independently re-resolved, re-pinned, and
//     re-checked before it is ever connected to. Native auto-follow would
//     otherwise revalidate nothing.
//   - "error" / "manual": the caller has already opted into a fetch mode
//     that either throws on a redirect response or hands the raw 3xx back
//     without following it, so there is no second hop for this guard to
//     revalidate — we only add DNS pinning to the one connection made.
export async function guardedFetch(
  rawUrl,
  init = {},
  {
    fetchImpl = fetch,
    resolveHost = resolvePublicHost,
    dispatcherFactory = createPinnedDispatcher,
    maxRedirects = DEFAULT_MAX_REDIRECTS,
  } = {}
) {
  // guardedFetch has no timeoutMs of its own. The caller's own deadline is
  // whatever AbortController/signal it puts on init (see career-ops-registry's
  // request(), which drives one abort per outbound provider call). Racing DNS
  // resolution against that same signal on every hop is what keeps a stalled
  // lookup from outliving it; a caller that passes no signal gets the old
  // plain-await behavior.
  let target = await resolvePublicHttpTarget(rawUrl, { resolveHost, signal: init.signal });
  if (!target.ok) return failure("unsafe_url", target.reason, { url: rawUrl });

  const redirectMode = init.redirect || "follow";
  if (redirectMode !== "follow") {
    const dispatcher = dispatcherFactory({
      hostname: target.hostname,
      addresses: target.addresses,
    });
    try {
      const response = await fetchImpl(target.url, { ...init, dispatcher });
      return {
        ok: true,
        url: rawUrl,
        finalUrl: response?.url || target.url,
        response,
        close: () => closeDispatcher(dispatcher),
      };
    } catch (error) {
      await closeDispatcher(dispatcher);
      throw error;
    }
  }

  // Per-hop request state, mutated across hops per WHATWG fetch's redirect
  // algorithm (https://fetch.spec.whatwg.org/#http-redirect-fetch) rather
  // than replayed verbatim: a POST that hits a 303 becomes a bodyless GET on
  // the next hop, and credentials the caller supplied don't follow the chain
  // across an origin change.
  let hopMethod = String(init.method || "GET").toUpperCase();
  let hopBody = init.body;
  const hopHeaders = normalizeHeadersInit(init.headers);

  for (let redirectCount = 0; redirectCount <= maxRedirects; redirectCount += 1) {
    const currentUrl = target.url;
    const dispatcher = dispatcherFactory({
      hostname: target.hostname,
      addresses: target.addresses,
    });
    let response;
    try {
      response = await fetchImpl(currentUrl, {
        ...init,
        method: hopMethod,
        body: hopBody,
        headers: headersMapToObject(hopHeaders),
        redirect: "manual",
        dispatcher,
      });
    } catch (error) {
      await closeDispatcher(dispatcher);
      throw error;
    }

    const redirectUrl = redirectTarget(response, currentUrl);
    if (!redirectUrl) {
      return {
        ok: true,
        url: rawUrl,
        finalUrl: response?.url || currentUrl,
        response,
        close: () => closeDispatcher(dispatcher),
      };
    }

    const status = Number(response?.status || 0);
    await cancelBody(response);
    await closeDispatcher(dispatcher);
    if (redirectCount === maxRedirects) {
      return failure("too_many_redirects", "too many redirects", {
        url: rawUrl,
        finalUrl: currentUrl,
      });
    }
    const next = await resolvePublicHttpTarget(redirectUrl, { resolveHost, signal: init.signal });
    if (!next.ok) {
      return failure("unsafe_redirect", `unsafe redirect target: ${next.reason}`, {
        url: rawUrl,
        finalUrl: redirectUrl,
      });
    }

    // 303 always downgrades to a bodyless GET; so does 301/302 when the
    // method being replayed isn't already GET/HEAD. 307/308 preserve method
    // and body untouched.
    const downgradesToGet =
      status === 303 ||
      ((status === 301 || status === 302) && !["GET", "HEAD"].includes(hopMethod));
    if (downgradesToGet) {
      hopMethod = "GET";
      hopBody = undefined;
      for (const name of REQUEST_BODY_HEADER_NAMES) hopHeaders.delete(name);
    }

    // A hop that crosses origin (scheme, host, or port) loses any
    // caller-supplied credential headers, so a redirect can't hand them to a
    // host the caller never named.
    if (new URL(currentUrl).origin !== new URL(redirectUrl).origin) {
      for (const name of CROSS_ORIGIN_STRIP_HEADER_NAMES) hopHeaders.delete(name);
    }

    target = next;
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
// carries one, or null otherwise. Covers every transition/translation form
// that reaches a non-public IPv4 through an IPv6 spelling:
//   - IPv4-mapped (::ffff:0:0/96) and the deprecated IPv4-compatible (::/96)
//     forms, embedded in the low 32 bits (groups[6..7])
//   - the NAT64 well-known prefix (64:ff9b::/96), same low-32-bit embedding
//   - 6to4 (2002::/16), which embeds the IPv4 higher up, in bits 16-47
//     (groups[1..2]) — the remaining groups carry an SLA ID/interface ID and
//     are not part of the address
// Handles both the canonical hex-group form Node's URL parser produces
// (::ffff:7f00:1) and the textual dotted-decimal form (::ffff:127.0.0.1),
// since the groups come from a shared IPv6 parser rather than a single
// regex shape.
function embeddedIpv4(host) {
  const groups = ipv6ToGroups(host);
  if (!groups) return null;

  const highZero = groups.slice(0, 5).every((g) => g === 0);
  const isMapped = highZero && groups[5] === 0xffff;
  const isCompatible = highZero && groups[5] === 0;
  if (isMapped || isCompatible) return ipv4FromGroups(groups[6], groups[7]);

  const isNat64 =
    groups[0] === 0x64 &&
    groups[1] === 0xff9b &&
    groups[2] === 0 &&
    groups[3] === 0 &&
    groups[4] === 0 &&
    groups[5] === 0;
  if (isNat64) return ipv4FromGroups(groups[6], groups[7]);

  const isSixToFour = groups[0] === 0x2002;
  if (isSixToFour) return ipv4FromGroups(groups[1], groups[2]);

  return null;
}

// Reassembles two 16-bit IPv6 groups into their dotted-decimal IPv4 string.
function ipv4FromGroups(hi, lo) {
  const a = hi >> 8;
  const b = hi & 0xff;
  const c = lo >> 8;
  const d = lo & 0xff;
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
