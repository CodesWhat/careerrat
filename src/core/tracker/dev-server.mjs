// Pure helpers for the tracker dev server (src/cli/tracker-dev.mjs). Kept here,
// free of node:http / node:fs side effects, so the risk-bearing bits — the asset
// path-traversal guard, MIME mapping, live-reload injection, port parsing — are
// unit-testable without booting a server.
import { extname, join, normalize } from "node:path";
import { readEnv } from "../env-compat.mjs";

// The live-reload client. Injected into served HTML at request time only — never
// written to the real workspace/tracker.html artifact, so it never leaks into the
// committed render. EventSource auto-reconnects; we also retry on error.
export const LIVERELOAD_SNIPPET = `
<script data-careerrat-livereload>
(function () {
  function connect() {
    try {
      var es = new EventSource("/__livereload");
      es.addEventListener("reload", function () { location.reload(); });
      es.onerror = function () { es.close(); setTimeout(connect, 1000); };
    } catch (e) { setTimeout(connect, 1000); }
  }
  connect();
})();
</script>
`;

// Content types for the demo logos/branding the dashboard references relatively
// (../assets/...). Anything else falls back to octet-stream.
const MIME = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".gif": "image/gif",
  ".ico": "image/x-icon",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
};

export function mimeFor(filePath) {
  return MIME[extname(filePath).toLowerCase()] || "application/octet-stream";
}

// Insert the live-reload client immediately before the closing </body> (or append
// if there is none). Case-insensitive, last occurrence — robust to attributes.
export function injectLiveReload(html, snippet = LIVERELOAD_SNIPPET) {
  const idx = html.toLowerCase().lastIndexOf("</body>");
  if (idx === -1) return html + snippet;
  return html.slice(0, idx) + snippet + html.slice(idx);
}

// Resolve a static "<prefix><rel>" request to an absolute path confined to rootDir.
// Returns { ok:true, full } or { ok:false, status } where status is the HTTP code
// to send (400 bad encoding, 403 traversal). Does NOT touch the filesystem — the
// caller stats/reads and turns a miss into 404.
export function safeAssetPath(rootDir, urlPath, prefix = "/assets/") {
  if (!urlPath.startsWith(prefix)) return { ok: false, status: 404 };
  let rel;
  try {
    rel = decodeURIComponent(urlPath.slice(prefix.length));
  } catch {
    return { ok: false, status: 400 };
  }
  rel = normalize(rel);
  if (rel.startsWith("..") || rel.startsWith("/") || rel.includes("\0")) {
    return { ok: false, status: 403 };
  }
  const full = join(rootDir, rel);
  // join+normalize collapse traversal; confirm the result stays under rootDir.
  if (full !== rootDir && !full.startsWith(`${rootDir}/`) && !full.startsWith(`${rootDir}\\`)) {
    return { ok: false, status: 403 };
  }
  return { ok: true, full };
}

// Resolve the listen port: --port flag wins, then env, then default 7777.
export function resolvePort(argv = [], env = {}, fallback = 7777) {
  const flagIdx = argv.indexOf("--port");
  if (flagIdx !== -1 && argv[flagIdx + 1] != null) {
    const p = Number(argv[flagIdx + 1]);
    if (Number.isInteger(p) && p > 0 && p < 65536) return p;
  }
  const e = Number(readEnv("CAREERRAT_DEV_PORT", { env }));
  if (Number.isInteger(e) && e > 0 && e < 65536) return e;
  return fallback;
}
