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
    const mapped = host.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped) return isNonPublicIp(mapped[1]);
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
