import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import {
  buildContentSecurityPolicy,
  hardenStaticHtml,
  securityHeaders,
} from "../src/core/security/browser-policy.mjs";

test("static HTML hardening hashes inline scripts without script unsafe-inline/eval", () => {
  const source =
    "<!doctype html><html><head><title>x</title></head><body><script>window.x=1;</script></body></html>";
  const hardened = hardenStaticHtml(source, { allowTailwindCdn: false });
  assert.match(hardened, /http-equiv="Content-Security-Policy"/);
  assert.match(hardened, /script-src 'self' 'sha256-[A-Za-z0-9+/=]+'/);
  const csp = hardened.match(/http-equiv="Content-Security-Policy" content="([^"]+)"/)?.[1] || "";
  assert.doesNotMatch(csp.match(/script-src[^;]*/)?.[0] || "", /unsafe-inline|unsafe-eval/);
  assert.doesNotMatch(
    csp,
    /frame-ancestors/,
    "frame-ancestors is ignored in a meta policy and belongs in the HTTP header"
  );
  assert.ok(hardened.indexOf("Content-Security-Policy") < hardened.indexOf("<script>"));
});

test("the shared policy exposes the complete defense-in-depth header set", () => {
  const csp = buildContentSecurityPolicy({ inlineScripts: ["window.x=1;"] });
  assert.match(csp, /default-src 'self'/);
  assert.match(csp, /frame-ancestors 'none'/);
  assert.match(csp, /frame-src 'self' blob: https:\/\/challenges\.cloudflare\.com/);
  assert.match(csp, /object-src 'self' blob:/);
  assert.doesNotMatch(csp.match(/(?:frame|object)-src[^;]*/g)?.join(" ") || "", /data:/);
  assert.match(csp, /https:\/\/challenges\.cloudflare\.com/);
  assert.equal(securityHeaders()["X-Content-Type-Options"], "nosniff");
  assert.equal(securityHeaders()["X-Frame-Options"], "DENY");
});

test("PostHog sources stay closed by default and widen together when a caller opts in", () => {
  const defaultCsp = buildContentSecurityPolicy();
  assert.match(defaultCsp, /connect-src 'self';/);
  assert.doesNotMatch(defaultCsp, /e\.codeswhat\.com/);

  const optedInCsp = buildContentSecurityPolicy({
    extraConnectSrc: ["https://e.codeswhat.com"],
    extraScriptSrc: ["https://e.codeswhat.com"],
  });
  assert.match(optedInCsp, /connect-src 'self' https:\/\/e\.codeswhat\.com;/);
  assert.match(optedInCsp, /script-src [^;]*https:\/\/e\.codeswhat\.com/);
});

test("only the public website/docs builds opt into the PostHog ingest proxy", () => {
  const websiteBuild = JSON.parse(
    readFileSync(new URL("../apps/website/package.json", import.meta.url), "utf8")
  ).scripts.build;
  const docsBuild = JSON.parse(
    readFileSync(new URL("../apps/docs/package.json", import.meta.url), "utf8")
  ).scripts.build;
  assert.match(websiteBuild, /--allow-posthog-proxy/);
  assert.match(docsBuild, /--allow-posthog-proxy/);

  // The local-first app server must never gain a network egress point to an
  // external analytics host. connect-src stays 'self' there.
  const trackerDev = readFileSync(new URL("../src/cli/tracker-dev.mjs", import.meta.url), "utf8");
  assert.doesNotMatch(trackerDev, /extraConnectSrc|extraScriptSrc|e\.codeswhat\.com/);
});

test("the PostHog build flag permits its loader and ingest requests", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "careerrat-csp-"));
  t.after(() => rmSync(directory, { force: true, recursive: true }));
  const htmlPath = join(directory, "index.html");
  writeFileSync(htmlPath, "<!doctype html><html><head></head><body></body></html>");

  execFileSync(
    process.execPath,
    [
      fileURLToPath(new URL("../scripts/harden-static-html.mjs", import.meta.url)),
      directory,
      "--allow-posthog-proxy",
    ],
    { stdio: "pipe" }
  );

  const csp =
    readFileSync(htmlPath, "utf8").match(
      /<meta http-equiv="Content-Security-Policy" content="([^"]+)"/
    )?.[1] || "";
  assert.match(csp, /script-src [^;]*https:\/\/e\.codeswhat\.com/);
  assert.match(csp, /connect-src [^;]*https:\/\/e\.codeswhat\.com/);
});

test("Vite uses no inline theme bootstrap and Vercel enforces headers", () => {
  const appIndex = readFileSync(new URL("../apps/web/index.html", import.meta.url), "utf8");
  assert.doesNotMatch(appIndex, /<script(?![^>]*\bsrc=)[^>]*>/i);
  assert.doesNotMatch(appIndex, /theme-init\.js/);

  const vercel = JSON.parse(
    readFileSync(new URL("../apps/website/vercel.json", import.meta.url), "utf8")
  );
  const headers = Object.fromEntries(
    (vercel.headers?.[0]?.headers || []).map((item) => [item.key, item.value])
  );
  assert.equal(headers["X-Content-Type-Options"], "nosniff");
  assert.equal(headers["X-Frame-Options"], "DENY");
  assert.match(headers["Content-Security-Policy"] || "", /frame-ancestors 'none'/);
});
