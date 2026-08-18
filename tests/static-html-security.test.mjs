import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

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

test("connect-src stays 'self' by default and only widens when a caller opts in", () => {
  const defaultCsp = buildContentSecurityPolicy();
  assert.match(defaultCsp, /connect-src 'self';/);
  assert.doesNotMatch(defaultCsp, /e\.codeswhat\.com/);

  const optedInCsp = buildContentSecurityPolicy({
    extraConnectSrc: ["https://e.codeswhat.com"],
  });
  assert.match(optedInCsp, /connect-src 'self' https:\/\/e\.codeswhat\.com;/);
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

  // The local-first dashboard (apps/web's demo build and the live local dev
  // server) must never gain a network egress point to an external analytics
  // host — connect-src stays 'self' there.
  const buildDemo = readFileSync(new URL("../scripts/build-demo.mjs", import.meta.url), "utf8");
  const trackerDev = readFileSync(new URL("../src/cli/tracker-dev.mjs", import.meta.url), "utf8");
  assert.doesNotMatch(buildDemo, /--allow-posthog-proxy|extraConnectSrc/);
  assert.doesNotMatch(trackerDev, /extraConnectSrc|e\.codeswhat\.com/);
});

test("Vite theme bootstrap is external and Vercel/static-demo configs enforce headers", () => {
  const appIndex = readFileSync(new URL("../apps/web/index.html", import.meta.url), "utf8");
  assert.doesNotMatch(appIndex, /<script(?![^>]*\bsrc=)[^>]*>/i);
  assert.match(appIndex, /theme-init\.js/);

  const vercel = JSON.parse(
    readFileSync(new URL("../apps/website/vercel.json", import.meta.url), "utf8")
  );
  const headers = Object.fromEntries(
    (vercel.headers?.[0]?.headers || []).map((item) => [item.key, item.value])
  );
  assert.equal(headers["X-Content-Type-Options"], "nosniff");
  assert.equal(headers["X-Frame-Options"], "DENY");
  assert.match(headers["Content-Security-Policy"] || "", /frame-ancestors 'none'/);

  const deployDemo = readFileSync(new URL("../scripts/deploy-demo.mjs", import.meta.url), "utf8");
  assert.match(deployDemo, /securityHeaders/);
  assert.match(deployDemo, /continue:\s*true/);
});
