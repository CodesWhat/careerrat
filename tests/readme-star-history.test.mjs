import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const repoRoot = new URL("../", import.meta.url);
const CHART_PATTERN =
  /^https:\/\/api\.star-history\.com\/chart\?repos=codeswhat\/careerrat&type=date(&legend=top-left)?(&theme=dark)?$/;

function chartUrls(content) {
  return [...content.matchAll(/https:\/\/api\.star-history\.com\/chart\?[^"'\s)]+/g)].map(
    (match) => match[0]
  );
}

test("README.md embeds the Star History chart in a light/dark <picture> element", async () => {
  const readme = await readFile(new URL("README.md", repoRoot), "utf8");
  const picture = readme.match(/<picture>[\s\S]*?<\/picture>/)?.[0];
  assert.ok(picture, "README.md should contain a <picture> element for the star history chart");

  const dark = picture.match(
    /<source media="\(prefers-color-scheme: dark\)" srcset="([^"]+)"/
  )?.[1];
  const light = picture.match(
    /<source media="\(prefers-color-scheme: light\)" srcset="([^"]+)"/
  )?.[1];
  const img = picture.match(/<img [^>]*src="([^"]+)"/)?.[1];
  assert.ok(dark && light && img, "picture needs dark and light sources plus an <img> fallback");

  for (const url of [dark, light, img]) {
    assert.match(url, CHART_PATTERN);
  }
  assert.match(dark, /&theme=dark/);
  assert.doesNotMatch(light, /theme=dark/);
  assert.equal(img, light);
  assert.match(picture, /<img [^>]*alt="[^"]+"/, "the chart needs meaningful alt text");
});

test("README.md links the chart to its Star History page", async () => {
  const readme = await readFile(new URL("README.md", repoRoot), "utf8");
  assert.match(
    readme,
    /<a href="https:\/\/www\.star-history\.com\/\?repos=codeswhat%2Fcareerrat[^"]*">\s*<picture>/
  );
});

test("the website renders the same Star History chart", async () => {
  const page = await readFile(new URL("apps/website/src/app/page.tsx", repoRoot), "utf8");
  const urls = chartUrls(page);
  assert.ok(urls.length > 0, "page.tsx should reference the Star History chart endpoint");
  for (const url of urls) assert.match(url, CHART_PATTERN);
  assert.match(page, /alt="Star history chart for CodesWhat\/careerrat"/);
});

test("the retired first-party chart assets and refresh workflow are gone", async () => {
  for (const file of [
    "apps/website/public/star-history.svg",
    "apps/website/public/star-history-dark.svg",
    ".github/workflows/starchart.yml",
  ]) {
    await assert.rejects(readFile(new URL(file, repoRoot)), { code: "ENOENT" }, file);
  }
});
