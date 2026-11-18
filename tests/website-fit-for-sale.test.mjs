import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import test from "node:test";

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const vercel = JSON.parse(read("apps/website/vercel.json"));

test("website and docs stay pure static exports (no server functions, ISR or middleware)", () => {
  assert.match(read("apps/website/next.config.ts"), /output:\s*"export"/u);
  assert.match(read("apps/docs/next.config.ts"), /output:\s*"export"/u);
  assert.equal(vercel.outputDirectory, "out");
  assert.equal(vercel.functions, undefined, "vercel.json must not declare functions");
  assert.equal(vercel.crons, undefined, "vercel.json must not declare crons");
  for (const app of ["website", "docs"]) {
    for (const base of [`apps/${app}`, `apps/${app}/src`]) {
      for (const name of ["middleware", "proxy"]) {
        for (const ext of ["ts", "js", "mjs"]) {
          assert.equal(
            existsSync(new URL(`../${base}/${name}.${ext}`, import.meta.url)),
            false,
            `${base}/${name}.${ext} would add a server runtime`
          );
        }
      }
    }
  }
  const sources = [
    ...readdirSync(new URL("../apps/website/src/app", import.meta.url), { recursive: true }),
  ]
    .filter((file) => /\.(tsx?|mjs)$/u.test(file))
    .map((file) => [file, read(`apps/website/src/app/${file}`)]);
  for (const [file, text] of sources) {
    assert.doesNotMatch(text, /export const revalidate\b/u, `${file} sets ISR revalidation`);
    assert.doesNotMatch(text, /export const dynamic\s*=\s*"force-dynamic"/u, `${file} is dynamic`);
    assert.ok(!/(^|\/)route\.ts$/u.test(file), `${file} would be a server route handler`);
  }
});

test("every response carries the security header set (HSTS is added by Vercel itself)", () => {
  const catchAll = vercel.headers.find((rule) => rule.source === "/(.*)");
  assert.ok(
    catchAll,
    'vercel.json needs a headers rule with source "/(.*)" so /docs gets them too'
  );
  const headers = Object.fromEntries(catchAll.headers.map((h) => [h.key, h.value]));
  const csp = headers["Content-Security-Policy"] || "";
  for (const directive of [
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "object-src 'none'",
    "form-action 'self'",
  ]) {
    assert.ok(csp.includes(directive), `CSP is missing ${directive}`);
  }
  assert.equal(headers["X-Content-Type-Options"], "nosniff");
  assert.equal(headers["X-Frame-Options"], "DENY");
  assert.equal(headers["Referrer-Policy"], "no-referrer");
  assert.match(headers["Permissions-Policy"] || "", /camera=\(\)/u);
  assert.match(headers["Permissions-Policy"] || "", /microphone=\(\)/u);
  assert.match(headers["Permissions-Policy"] || "", /geolocation=\(\)/u);
  assert.equal(headers["Strict-Transport-Security"], undefined);
});

test("home page screenshots ship WebP variants that exist on disk", () => {
  const page = read("apps/website/src/app/page.tsx");
  const files = [...page.matchAll(/\/screenshots\/(tui-[a-z]+-\d+\.webp)/gu)].map((m) => m[1]);
  assert.ok(files.length >= 6, "expected 800w and 1600w WebP sources for three screenshots");
  for (const file of new Set(files)) {
    assert.ok(
      existsSync(new URL(`../apps/website/public/screenshots/${file}`, import.meta.url)),
      `${file} is referenced by page.tsx but missing`
    );
  }
});
