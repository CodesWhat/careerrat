// fixture-server.mjs — a tiny static file server over a fixture directory, used
// by tests that need a real `http://` origin (a real browser won't load
// `file://` form actions consistently, and playwright-ops.mjs's snapshot/upload
// paths are exercised against actual navigation). No dependency beyond
// node:http/node:fs — this only ever needs to serve the plain HTML fixtures
// under tests/fixtures/**, not act as a general-purpose server.

import { createReadStream, realpathSync, statSync } from "node:fs";
import { createServer } from "node:http";
// `resolve` is aliased because the listen() Promise executor below binds its own
// `resolve`. Nothing currently uses the path one inside that scope, so this is
// not a live bug, but the two names collide the moment anyone moves code in.
import { extname, join, resolve as resolvePath, sep } from "node:path";

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
  // realpath, not just resolve: the containment check below compares against
  // this, and on macOS the temp dir is reached through a symlink.
  const root = realpathSync(rootDir);

  const server = createServer((req, res) => {
    const rawPath = (req.url || "/").split("?")[0].split("#")[0];

    // decodeURIComponent throws URIError on a malformed escape ("%", "%zz").
    // Uncaught in a request handler that would take the whole server down
    // mid-test, so a bad path is a 400, not a crash.
    let requestPath;
    try {
      requestPath = decodeURIComponent(rawPath);
    } catch {
      res.writeHead(400, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("Bad request");
      return;
    }

    // A NUL makes every fs call throw, and it is the classic truncation trick.
    if (requestPath.includes("\0")) {
      res.writeHead(400, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("Bad request");
      return;
    }

    // Two things here are load-bearing and were both wrong in the first version.
    //
    // First, the request path is joined as `.${requestPath}` so a leading "/"
    // is read relative to `root` instead of as an absolute filesystem path, and
    // resolve collapses every ".." segment before the check rather than after.
    // Hand-stripping a leading "../" with a regex only removes the sequences it
    // happens to anchor on and misses "a/../../etc".
    //
    // Second, containment is `=== root || startsWith(root + sep)`, not a bare
    // `startsWith(root)`. A plain prefix test passes any sibling whose name
    // extends the root's, so a root of "/tmp/fix" would happily serve
    // "/tmp/fixtures-elsewhere/secret".
    //
    // Written inline rather than as a helper returning null on purpose. It read
    // better as a helper, but CodeQL's js/path-injection flow analysis could not
    // follow the guard across the function boundary and kept flagging every
    // downstream fs call. Same behaviour, and the suppression is earned by the
    // check rather than by an alert dismissal.
    let filePath = resolvePath(root, `.${requestPath}`);
    if (filePath !== root && !filePath.startsWith(root + sep)) {
      res.writeHead(403, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("Forbidden");
      return;
    }

    // The lexical check above is necessary but NOT sufficient, which is the one
    // thing this file got genuinely wrong rather than merely flagged. It reasons
    // about the path as text, and a symlink is not a text property. A symlink
    // sitting inside root that points outside it passes the string check, and
    // then statSync and createReadStream both follow it. That was a real,
    // demonstrated escape: a request for a linked file returned 200 with the
    // contents of a file outside the root.
    //
    // realpath resolves the link and the containment is re-checked on the
    // canonical path. Both sides have to be canonical: on macOS the temp dir is
    // itself reached through a symlink (/var -> /private/var), so comparing a
    // realpath'd file against a non-realpath'd root would reject everything.
    //
    // This also wraps the sync fs calls, which could throw straight out of the
    // handler if a file vanished between the existence check and the stat. Same
    // process-killing failure mode as the malformed escape and the read stream,
    // reached by a third route.
    try {
      if (statSync(filePath).isDirectory()) {
        filePath = join(filePath, "index.html");
      }

      const canonical = realpathSync(filePath);
      if (canonical !== root && !canonical.startsWith(root + sep)) {
        res.writeHead(403, { "Content-Type": "text/plain; charset=utf-8" });
        res.end("Forbidden");
        return;
      }
      filePath = canonical;

      if (!statSync(filePath).isFile()) {
        res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
        res.end("Not found");
        return;
      }
    } catch {
      // ENOENT for a missing file or a dangling symlink, EACCES on a directory
      // that cannot be traversed. None of them should be distinguishable from
      // "not there" by a caller.
      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("Not found");
      return;
    }

    res.writeHead(200, { "Content-Type": contentTypeFor(filePath) });

    // Same failure mode as the malformed-escape case above: an unhandled
    // 'error' on the read stream (file removed mid-test, EMFILE under parallel
    // runs) throws out of the handler and kills the whole node --test process,
    // not just the one test. Headers are already sent by this point, so there
    // is no status left to send. Destroying the socket is the honest signal,
    // and it stops the response hanging open.
    const stream = createReadStream(filePath);
    stream.on("error", () => res.destroy());
    stream.pipe(res);
  });

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      resolve({
        url: `http://127.0.0.1:${port}`,
        // closeAllConnections() before close(): close() alone only stops new
        // connections and then waits for idle keep-alive sockets to time out,
        // which fetch leaves behind. That added ~3s per test to teardown.
        close: () =>
          new Promise((res) => {
            server.closeAllConnections();
            server.close(() => res());
          }),
      });
    });
  });
}
