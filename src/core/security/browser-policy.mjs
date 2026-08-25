import { createHash } from "node:crypto";

const STATIC_EDGE_CONTENT_SECURITY_POLICY =
  "frame-ancestors 'none'; base-uri 'self'; object-src 'none'; form-action 'self'";

// The shared house PostHog ingest proxy (cookieless, memory-persisted analytics
// for the public website/docs surface — see apps/website/src/lib/posthog-privacy.ts
// and apps/docs's copy of it). Only the website/docs static builds pass it as
// an extra script and connection source: the local-first dashboard (apps/web,
// tracker-dev) never opts in, so both directives stay closed there.
export const POSTHOG_INGEST_PROXY = "https://e.codeswhat.com";

function inlineScriptsFromHtml(html) {
  const scripts = [];
  const pattern = /<script\b(?![^>]*\bsrc\s*=)[^>]*>([\s\S]*?)<\/script>/gi;
  for (const match of String(html || "").matchAll(pattern)) scripts.push(match[1]);
  return scripts;
}

function scriptHash(source) {
  return `'sha256-${createHash("sha256").update(String(source)).digest("base64")}'`;
}

export function buildContentSecurityPolicy({
  inlineScripts = [],
  allowTailwindCdn = false,
  includeFrameAncestors = true,
  extraConnectSrc = [],
  extraScriptSrc = [],
} = {}) {
  const hashes = [...new Set(inlineScripts.map(scriptHash))];
  const scriptSources = [
    "'self'",
    ...hashes,
    ...(allowTailwindCdn ? ["https://cdn.tailwindcss.com"] : []),
    ...new Set(extraScriptSrc),
    "https://challenges.cloudflare.com",
  ];
  const connectSources = ["'self'", ...new Set(extraConnectSrc)];
  return [
    "default-src 'self'",
    `script-src ${scriptSources.join(" ")}`,
    "script-src-attr 'none'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: https:",
    "font-src 'self' data:",
    `connect-src ${connectSources.join(" ")}`,
    "frame-src 'self' blob: https://challenges.cloudflare.com",
    "worker-src 'self' blob:",
    "media-src 'self' blob: data:",
    "object-src 'self' blob:",
    "manifest-src 'self'",
    "base-uri 'self'",
    "form-action 'self'",
    ...(includeFrameAncestors ? ["frame-ancestors 'none'"] : []),
  ].join("; ");
}

export function securityHeaders({ csp = buildContentSecurityPolicy() } = {}) {
  return {
    "Content-Security-Policy": csp,
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    "Permissions-Policy": "camera=(), microphone=(), geolocation=(), payment=(), usb=()",
    "X-Frame-Options": "DENY",
  };
}

export function hardenStaticHtml(
  html,
  { allowTailwindCdn = false, extraConnectSrc = [], extraScriptSrc = [] } = {}
) {
  const source = String(html || "").replace(
    /<meta\s+http-equiv=["']Content-Security-Policy["'][^>]*>\s*/gi,
    ""
  );
  const csp = buildContentSecurityPolicy({
    inlineScripts: inlineScriptsFromHtml(source),
    allowTailwindCdn,
    includeFrameAncestors: false,
    extraConnectSrc,
    extraScriptSrc,
  });
  const meta = `<meta http-equiv="Content-Security-Policy" content="${csp}">`;
  if (/<head(?:\s[^>]*)?>/i.test(source)) {
    return source.replace(/<head(\s[^>]*)?>/i, (match) => `${match}${meta}`);
  }
  return `${meta}${source}`;
}
