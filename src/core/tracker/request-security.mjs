import { randomBytes, timingSafeEqual } from "node:crypto";

const CAPABILITY_COOKIE = "rolester_local_capability";
const LOOPBACK_HOSTS = Object.freeze(["localhost", "127.0.0.1", "::1"]);
const STATE_CHANGING_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

function normalizeHostname(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/^\[|\]$/g, "");
}

function configuredHosts(env) {
  const hosts = new Set(LOOPBACK_HOSTS);
  const bindHost = normalizeHostname(env?.ROLESTER_TRACKER_HOST);
  if (bindHost) hosts.add(bindHost);
  for (const value of String(env?.ROLESTER_TRACKER_ALLOWED_HOSTS || "").split(",")) {
    const host = normalizeHostname(value);
    if (host) hosts.add(host);
  }
  return hosts;
}

export function resolveTrackerBindHost(env = process.env) {
  const requested = normalizeHostname(env?.ROLESTER_TRACKER_HOST || "127.0.0.1");
  if (!LOOPBACK_HOSTS.includes(requested)) {
    throw new Error(
      `ROLESTER_TRACKER_HOST must be loopback-only (${LOOPBACK_HOSTS.join(", ")}); received ${requested}`
    );
  }
  return requested;
}

function parseRequestHost(value) {
  const raw = String(value || "").trim();
  if (!raw || /[\s/@\\]/.test(raw)) return null;
  try {
    const parsed = new URL(`http://${raw}`);
    if (parsed.username || parsed.password || parsed.pathname !== "/") return null;
    return {
      hostname: normalizeHostname(parsed.hostname),
      port: parsed.port ? Number(parsed.port) : 80,
      origin: parsed.origin,
    };
  } catch {
    return null;
  }
}

function requestPort(server) {
  const address = server.address();
  return address && typeof address === "object" ? Number(address.port) : null;
}

function originOf(value) {
  try {
    const parsed = new URL(String(value || ""));
    return parsed.protocol === "http:" || parsed.protocol === "https:" ? parsed.origin : null;
  } catch {
    return null;
  }
}

function cookieValue(header, name) {
  for (const part of String(header || "").split(";")) {
    const [rawName, ...rawValue] = part.trim().split("=");
    if (rawName === name) return rawValue.join("=");
  }
  return null;
}

function constantTimeEqual(left, right) {
  const a = Buffer.from(String(left || ""));
  const b = Buffer.from(String(right || ""));
  return a.length === b.length && timingSafeEqual(a, b);
}

function isHtmlBootstrap(method, url) {
  if (method !== "GET") return false;
  if (url === "/" || url === "/chat" || url === "/app") return true;
  if (url === "/CLERK-ROUTER" || url.startsWith("/CLERK-ROUTER/")) return true;
  if (!url.startsWith("/app/")) return false;
  const lastSegment = url.split("/").pop() || "";
  return !lastSegment.includes(".");
}

function isProtectedBrowserSurface(url) {
  return url === "/__livereload" || url.startsWith("/api/");
}

function browserContext(req) {
  return Boolean(req.headers.origin || req.headers.referer || req.headers["sec-fetch-site"]);
}

function reject(status, error) {
  return { ok: false, status, error };
}

export function createLocalRequestSecurity({ env = process.env, randomToken } = {}) {
  const allowedHosts = configuredHosts(env);
  const capability =
    typeof randomToken === "string" && randomToken
      ? randomToken
      : randomBytes(32).toString("base64url");

  return {
    authorize(req, { server, url }) {
      const host = parseRequestHost(req.headers.host);
      const port = requestPort(server);
      if (!host || !allowedHosts.has(host.hostname) || host.port !== port) {
        return reject(421, "request Host is not allowed");
      }

      const setCookie = isHtmlBootstrap(req.method, url)
        ? `${CAPABILITY_COOKIE}=${capability}; Path=/; HttpOnly; SameSite=Strict`
        : null;
      if (!isProtectedBrowserSurface(url) || !browserContext(req)) {
        return { ok: true, setCookie };
      }

      const expectedOrigin = host.origin;
      const origin = req.headers.origin ? originOf(req.headers.origin) : null;
      const refererOrigin = req.headers.referer ? originOf(req.headers.referer) : null;
      const fetchSite = String(req.headers["sec-fetch-site"] || "").toLowerCase();

      // Browser requests must prove they came from the exact local origin. This
      // blocks CSRF and DNS-rebinding callers before any sensitive route runs.
      if (
        (req.headers.origin && origin !== expectedOrigin) ||
        (req.headers.referer && refererOrigin !== expectedOrigin) ||
        (fetchSite && fetchSite !== "same-origin" && fetchSite !== "none")
      ) {
        return reject(403, "cross-origin request rejected");
      }
      if (STATE_CHANGING_METHODS.has(req.method) && origin !== expectedOrigin) {
        return reject(403, "state-changing browser requests require the local Origin");
      }

      const suppliedCapability = cookieValue(req.headers.cookie, CAPABILITY_COOKIE);
      if (!constantTimeEqual(suppliedCapability, capability)) {
        return reject(401, "local browser capability is missing or invalid");
      }

      return { ok: true, setCookie };
    },
  };
}

export function sendLocalSecurityError(res, decision) {
  res.writeHead(decision.status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(JSON.stringify({ error: decision.error }));
}
