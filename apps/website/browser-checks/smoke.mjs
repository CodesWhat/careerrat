// Real-browser smoke over the built static site: apps/website/out, which already
// carries the docs export under /docs/ exactly as production serves it. Run it
// after `npm run build --workspace apps/website` with `npm run test:website-browser`.
//
// Every built page is loaded in Chromium, WebKit and Firefox at a desktop and a
// phone width. A page fails on any console error, uncaught page error, failed
// same-origin request, or broken same-origin link or in-page anchor. The home
// page also has its nav and CTAs clicked, ending on the install docs page.
import assert from "node:assert/strict";
import { createReadStream } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { createServer } from "node:http";
import { dirname, extname, join, normalize, relative, resolve, sep } from "node:path";
import { after, before, describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import { chromium, firefox, webkit } from "playwright";

const OUT = resolve(
  process.env.WEBSITE_OUT ?? join(dirname(fileURLToPath(import.meta.url)), "..", "out")
);
const INSTALL_PATH = "/docs/getting-started/install/";
const BROWSERS = { chromium, webkit, firefox };
const VIEWPORTS = {
  desktop: { width: 1280, height: 800 },
  phone: { width: 390, height: 844 },
};
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".xml": "application/xml",
};

async function isFile(path) {
  return stat(path).then(
    (s) => s.isFile(),
    () => false
  );
}

async function isDir(path) {
  return stat(path).then(
    (s) => s.isDirectory(),
    () => false
  );
}

// Same rules as the production host: trailing-slash directories, /x -> x.html.
async function resolveRequest(pathname) {
  const clean = normalize(decodeURIComponent(pathname));
  const target = join(OUT, clean);
  if (target !== OUT && !target.startsWith(OUT + sep)) return { status: 403 };
  if (await isDir(target)) {
    if (!pathname.endsWith("/")) return { status: 308, location: `${pathname}/` };
    const index = join(target, "index.html");
    return (await isFile(index)) ? { status: 200, file: index } : { status: 404 };
  }
  if (await isFile(target)) return { status: 200, file: target };
  if (await isFile(`${target}.html`)) return { status: 200, file: `${target}.html` };
  return { status: 404 };
}

function startServer() {
  const server = createServer(async (req, res) => {
    const { pathname } = new URL(req.url, "http://localhost");
    const found = await resolveRequest(pathname);
    if (found.status === 308) {
      res.writeHead(308, { location: found.location }).end();
    } else if (found.status === 200) {
      res.writeHead(200, { "content-type": MIME[extname(found.file)] ?? "application/octet-stream" });
      createReadStream(found.file).pipe(res);
    } else {
      const page = join(OUT, "404.html");
      res.writeHead(found.status, { "content-type": MIME[".html"] });
      if (await isFile(page)) createReadStream(page).pipe(res);
      else res.end("not found");
    }
  });
  return new Promise((ok) => server.listen(0, "127.0.0.1", () => ok(server)));
}

async function listPages(dir = OUT) {
  const pages = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) pages.push(...(await listPages(path)));
    else if (entry.name.endsWith(".html")) pages.push(path);
  }
  return pages;
}

function pageUrl(file) {
  const rel = relative(OUT, file).split(sep).join("/");
  if (rel === "404.html" || rel.startsWith("_not-found")) return null;
  if (rel === "index.html") return "/";
  if (rel.endsWith("/index.html")) return `/${rel.slice(0, -"index.html".length)}`;
  return `/${rel.slice(0, -".html".length)}`;
}

let server;
let origin;
let paths;
const launched = new Map();

before(async () => {
  assert.ok(await isFile(join(OUT, "index.html")), `no built site at ${OUT}; build apps/website first`);
  paths = (await listPages()).map(pageUrl).filter(Boolean).sort();
  assert.ok(paths.includes("/"), "built site has no home page");
  assert.ok(
    paths.includes(INSTALL_PATH),
    `built site has no ${INSTALL_PATH}; docs export missing from out/docs`
  );
  server = await startServer();
  origin = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await Promise.all([...launched.values()].map((b) => b.close()));
  await new Promise((ok) => server.close(ok));
});

async function browserFor(name) {
  if (!launched.has(name)) launched.set(name, await BROWSERS[name].launch());
  return launched.get(name);
}

// Opens a context whose external hosts (analytics, fonts CDNs) answer 204 so the
// check never depends on the network, and records everything that goes wrong.
async function openPage(browserName, viewport) {
  const browser = await browserFor(browserName);
  const context = await browser.newContext({ viewport });
  await context.route(
    (url) => url.origin !== origin,
    (route) => route.fulfill({ status: 204, body: "" })
  );
  const page = await context.newPage();
  const problems = [];
  page.on("console", (msg) => {
    if (msg.type() === "error") problems.push(`console error: ${msg.text()}`);
  });
  page.on("pageerror", (err) => {
    // WebKit reports a same-origin fetch cancelled by navigation (a Next route
    // prefetch still in flight when a link is clicked) as an uncaught error.
    if (/due to access control checks/.test(err.message)) return;
    problems.push(`page error: ${err.message}`);
  });
  page.on("requestfailed", (req) => {
    // Navigating away cancels in-flight prefetches; that is not a broken request.
    const reason = req.failure()?.errorText ?? "";
    if (/abort|cancel/i.test(reason)) return;
    if (req.url().startsWith(origin)) problems.push(`request failed (${reason}): ${req.url()}`);
  });
  page.on("response", (res) => {
    // The 308 trailing-slash redirect is routine; anything else >= 400 is a bug.
    if (res.url().startsWith(origin) && res.status() >= 400) {
      problems.push(`HTTP ${res.status()}: ${res.url()}`);
    }
  });
  return { context, page, problems };
}

async function checkLinks(page, pathname) {
  const { links, missingAnchors } = await page.evaluate(() => {
    const here = location.href.split("#")[0];
    const hrefs = new Set();
    const missing = [];
    for (const a of document.querySelectorAll("a[href]")) {
      const url = new URL(a.href, location.href);
      if (url.protocol !== "http:" && url.protocol !== "https:") continue;
      if (url.origin !== location.origin) continue;
      if (url.href.split("#")[0] === here && url.hash.length > 1) {
        if (!document.getElementById(decodeURIComponent(url.hash.slice(1)))) missing.push(url.hash);
      }
      hrefs.add(url.pathname);
    }
    return { links: [...hrefs], missingAnchors: missing };
  });
  const broken = [];
  for (const link of links) {
    const found = await resolveRequest(link);
    if (found.status === 308) {
      const again = await resolveRequest(found.location);
      if (again.status !== 200) broken.push(link);
    } else if (found.status !== 200) {
      broken.push(link);
    }
  }
  assert.deepEqual(broken, [], `${pathname}: broken internal links`);
  assert.deepEqual(missingAnchors, [], `${pathname}: in-page anchors with no target`);
}

for (const browserName of Object.keys(BROWSERS)) {
  for (const [viewName, viewport] of Object.entries(VIEWPORTS)) {
    describe(`${browserName} @ ${viewName}`, () => {
      test("every built page loads clean with working links", async () => {
        const { context, page, problems } = await openPage(browserName, viewport);
        try {
          for (const pathname of paths) {
            problems.length = 0;
            const response = await page.goto(origin + pathname, { waitUntil: "load" });
            assert.equal(response?.status(), 200, `${pathname}: status`);
            assert.ok((await page.title()).trim(), `${pathname}: empty <title>`);
            assert.ok(
              (await page.locator("h1").count()) >= 1,
              `${pathname}: no <h1> rendered`
            );
            await page.waitForTimeout(250); // let hydration and late console errors land
            const overflow = await page.evaluate(
              () => document.documentElement.scrollWidth - window.innerWidth
            );
            assert.ok(overflow <= 1, `${pathname}: ${overflow}px horizontal overflow at ${viewName}`);
            await checkLinks(page, pathname);
            assert.deepEqual(problems, [], `${pathname}: browser problems`);
          }
        } finally {
          await context.close();
        }
      });

      test("home nav and CTAs lead to the install docs", async () => {
        const { context, page, problems } = await openPage(browserName, viewport);
        try {
          await page.goto(`${origin}/`, { waitUntil: "load" });
          const nav = page.getByRole("navigation", { name: "Main navigation" });
          await nav.waitFor();

          // Header CTA jumps to the in-page get section.
          await nav.getByRole("link", { name: /Get CareerRat/ }).click();
          await page.waitForURL(/#get$/);
          assert.ok(await page.locator("#get").isVisible(), "#get section not visible");

          // Hero CTA resolves to the install docs page.
          await page.goto(`${origin}/`, { waitUntil: "load" });
          const hero = page.getByRole("link", { name: /Install with npm/ }).first();
          assert.equal(await hero.getAttribute("href"), "/docs/getting-started/install");
          await Promise.all([page.waitForURL(/\/docs\/getting-started\/install\/?$/), hero.click()]);
          assert.ok((await page.locator("h1").first().innerText()).trim(), "install page has no heading");
          assert.ok(
            await page.getByText("npm i -g careerrat").first().isVisible(),
            "install page does not show the npm install command"
          );

          // Nav "Docs" link reaches the docs home.
          await page.goto(`${origin}/`, { waitUntil: "load" });
          await Promise.all([
            page.waitForURL(/\/docs\/?$/),
            page.getByRole("navigation", { name: "Main navigation" }).getByRole("link", { name: "Docs" }).click(),
          ]);
          assert.ok(await page.locator("h1").first().isVisible(), "docs home has no heading");
          assert.deepEqual(problems, [], "browser problems during navigation");
        } finally {
          await context.close();
        }
      });
    });
  }
}
