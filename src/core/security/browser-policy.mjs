import { createHash } from "node:crypto";

export const STATIC_EDGE_CONTENT_SECURITY_POLICY =
  "frame-ancestors 'none'; base-uri 'self'; object-src 'none'; form-action 'self'";

export function inlineScriptsFromHtml(html) {
  const scripts = [];
  const pattern = /<script\b(?![^>]*\bsrc\s*=)[^>]*>([\s\S]*?)<\/script>/gi;
  for (const match of String(html || "").matchAll(pattern)) scripts.push(match[1]);
  return scripts;
}

function scriptHash(source) {
  return `'sha256-${createHash("sha256").update(String(source)).digest("base64")}'`;
}

export function buildContentSecurityPolicy({ inlineScripts = [], allowTailwindCdn = false } = {}) {
  const hashes = [...new Set(inlineScripts.map(scriptHash))];
  const scriptSources = [
    "'self'",
    ...hashes,
    ...(allowTailwindCdn ? ["https://cdn.tailwindcss.com"] : []),
    "https://*.clerk.accounts.dev",
    "https://*.clerk.com",
    "https://challenges.cloudflare.com",
  ];
  return [
    "default-src 'self'",
    `script-src ${scriptSources.join(" ")}`,
    "script-src-attr 'none'",
    // Clerk's documented React integration uses runtime CSS-in-JS. Keep the
    // exception confined to styles; script execution remains hash/host based.
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: https:",
    "font-src 'self' data:",
    "connect-src 'self' https://*.clerk.accounts.dev https://*.clerk.com https://clerk-telemetry.com https://*.clerk-telemetry.com",
    "frame-src 'self' https://challenges.cloudflare.com",
    "worker-src 'self' blob:",
    "media-src 'self' blob: data:",
    "object-src 'self'",
    "manifest-src 'self'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
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

export function hardenStaticHtml(html, { allowTailwindCdn = false } = {}) {
  const source = String(html || "").replace(
    /<meta\s+http-equiv=["']Content-Security-Policy["'][^>]*>\s*/gi,
    ""
  );
  const csp = buildContentSecurityPolicy({
    inlineScripts: inlineScriptsFromHtml(source),
    allowTailwindCdn,
  });
  const meta = `<meta http-equiv="Content-Security-Policy" content="${csp}">`;
  if (/<head(?:\s[^>]*)?>/i.test(source)) {
    return source.replace(/<head(\s[^>]*)?>/i, (match) => `${match}${meta}`);
  }
  return `${meta}${source}`;
}
