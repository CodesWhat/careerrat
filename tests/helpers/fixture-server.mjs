// fixture-server.mjs — a tiny static file server over a fixture directory, used
// by tests that need a real `http://` origin (a real browser won't load
// `file://` form actions consistently, and playwright-ops.mjs's snapshot/upload
// paths are exercised against actual navigation). No dependency beyond
// node:http/node:fs — this only ever needs to serve the plain HTML fixtures
// under tests/fixtures/**, not act as a general-purpose server.

import { createReadStream, existsSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { extname, join, normalize, sep } from "node:path";

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".htm": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".pdf": "application/pdf",
  ".txt": "text/plain; charset=utf-8",
};

function contentTypeFor(path) {
  return MIME_TYPES[extname(path).toLowerCase()] || "application/octet-stream";
}

// startFixtureServer(rootDir) -> { url, close }
//
// Binds to 127.0.0.1 on an ephemeral port (0) so parallel test runs never
// collide, and resolves the real assigned port before returning.
export function startFixtureServer(rootDir) {
  const server = createServer((req, res) => {
    const requestPath = decodeURIComponent((req.url || "/").split("?")[0].split("#")[0]);
    // Defends against a request path escaping rootDir via "..": normalize
    // first, then require the resolved path still starts inside rootDir.
    const relativePath = normalize(requestPath).replace(/^([.][.][/\\])+/, "");
    let filePath = join(rootDir, relativePath === sep ? "" : relativePath);
    if (!filePath.startsWith(rootDir)) {
      res.writeHead(403);
      res.end("Forbidden");
      return;
    }

    if (existsSync(filePath) && statSync(filePath).isDirectory()) {
      filePath = join(filePath, "index.html");
    }

    if (!existsSync(filePath) || !statSync(filePath).isFile()) {
      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("Not found");
      return;
    }

    res.writeHead(200, { "Content-Type": contentTypeFor(filePath) });
    createReadStream(filePath).pipe(res);
  });

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      resolve({
        url: `http://127.0.0.1:${port}`,
        close: () => new Promise((res) => server.close(() => res())),
      });
    });
  });
}
