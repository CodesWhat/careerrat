import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import * as desktopRuntime from "../apps/desktop/desktop-runtime.mjs";
import { renderPdf } from "../src/core/documents/export.mjs";

function listen(server) {
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve(server.address().port));
  });
}

function close(server) {
  return new Promise((resolve) => server.close(resolve));
}

test("ISSUE-028: renderPdf uses the authenticated desktop renderer when Electron provides it", async () => {
  const root = mkdtempSync(join(tmpdir(), "rolester-desktop-pdf-client-"));
  const outPath = join(root, "resume.pdf");
  const expectedPdf = Buffer.from("%PDF-1.7\nrendered-by-electron\n", "utf8");
  let received = null;
  const server = createServer((req, res) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      received = {
        method: req.method,
        token: req.headers["x-rolester-render-token"],
        body: JSON.parse(Buffer.concat(chunks).toString("utf8")),
      };
      res.writeHead(200, {
        "content-type": "application/pdf",
        "content-length": expectedPdf.length,
      });
      res.end(expectedPdf);
    });
  });
  const port = await listen(server);

  try {
    await renderPdf({
      markdown: "# Evidence-backed résumé",
      outPath,
      env: {
        ROLESTER_DESKTOP_PDF_RENDER_URL: `http://127.0.0.1:${port}/render`,
        ROLESTER_DESKTOP_PDF_RENDER_TOKEN: "local-render-secret",
      },
    });

    assert.equal(existsSync(outPath), true);
    assert.deepEqual(readFileSync(outPath), expectedPdf);
    assert.equal(received?.method, "POST");
    assert.equal(received?.token, "local-render-secret");
    assert.match(received?.body?.html || "", /Evidence-backed résumé/);
  } finally {
    await close(server);
    rmSync(root, { recursive: true, force: true });
  }
});

test("ISSUE-028: desktop renderer is loopback-only, authenticated, and prints with Electron", async () => {
  assert.equal(typeof desktopRuntime.startDesktopPdfRenderer, "function");

  const windows = [];
  class FakeBrowserWindow {
    constructor(options) {
      this.options = options;
      this.destroyed = false;
      this.loadedUrl = null;
      this.printOptions = null;
      this.webContents = {
        on() {},
        setWindowOpenHandler() {},
        printToPDF: async (options) => {
          this.printOptions = options;
          return Buffer.from("%PDF-1.7\nprinted-by-electron\n", "utf8");
        },
      };
      windows.push(this);
    }

    async loadURL(url) {
      this.loadedUrl = url;
    }

    isDestroyed() {
      return this.destroyed;
    }

    destroy() {
      this.destroyed = true;
    }
  }

  const renderer = await desktopRuntime.startDesktopPdfRenderer({
    BrowserWindow: FakeBrowserWindow,
    token: "renderer-test-secret",
  });
  try {
    const denied = await fetch(renderer.url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ html: "<!doctype html><p>Denied</p>" }),
    });
    assert.equal(denied.status, 401);

    const response = await fetch(renderer.url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-rolester-render-token": renderer.token,
      },
      body: JSON.stringify({ html: "<!doctype html><p>Electron résumé</p>" }),
    });
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type") || "", /^application\/pdf\b/);
    assert.match(Buffer.from(await response.arrayBuffer()).toString("utf8"), /^%PDF-/);

    assert.equal(windows.length, 1);
    assert.equal(windows[0].options.show, false);
    assert.equal(windows[0].options.webPreferences.javascript, false);
    assert.match(decodeURIComponent(windows[0].loadedUrl), /Electron résumé/);
    assert.deepEqual(windows[0].printOptions, {
      pageSize: "Letter",
      preferCSSPageSize: true,
      printBackground: true,
      generateTaggedPDF: true,
    });
    assert.equal(windows[0].destroyed, true);
  } finally {
    await renderer.close();
  }
});
