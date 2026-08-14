import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

const LEGACY_BRAND = ["role", "ster"].join("");
const STALE_PUBLIC_CLI_PATTERN = new RegExp(
  `node bin\\/careerrat\\.mjs|npm run (?:doctor|next|ingest|searches|companies|modes|automation|research|gate|learnings|stories|activity|analytics|evidence|strategy-review|status:map|export|install-skills|evaluate|tracker|tracker:dev)(?:\\s|\u0060|$)|(?:${LEGACY_BRAND}|careerrat) [a-z:-]+ -- --|tracker:dev`
);

async function listFiles(dir, suffix) {
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await listFiles(path, suffix)));
    else if (entry.isFile() && path.endsWith(suffix)) out.push(path);
  }
  return out;
}

test("website hero leads with the CareerRat pitch", async () => {
  const page = await readFile("apps/website/src/app/page.tsx", "utf8");
  const styles = await readFile("apps/website/src/app/globals.css", "utf8");

  assert.match(page, /Your job hunt, run by a rat\./);
  assert.match(page, /npm i -g careerrat/);
  assert.doesNotMatch(page, new RegExp(LEGACY_BRAND, "i"));
  assert.doesNotMatch(
    styles,
    /\.hero-visual\s*\{[^}]*order:\s*-1/s,
    "mobile visitors should see the product value proposition before the preview"
  );
});

test("root layout suppresses the intentional early html class hydration delta", async () => {
  const layout = await readFile("apps/website/src/app/layout.tsx", "utf8");

  assert.match(layout, /documentElement;?[\s\S]*?\.classList\.add\('js'\)/);
  assert.match(layout, /<html[\s\S]*suppressHydrationWarning/);
  assert.match(layout, /process\.env\.VERCEL === "1"/);
  assert.match(layout, /enableVercelAnalytics \? <Analytics \/> : null/);
});

test("website metadata is CareerRat-branded", async () => {
  const layout = await readFile("apps/website/src/app/layout.tsx", "utf8");

  assert.match(layout, /CareerRat: Rate\. Apply\. Track\./);
  assert.doesNotMatch(layout, new RegExp(LEGACY_BRAND, "i"));
  // Product copy carries no em dashes, and page/OG/Twitter titles and
  // descriptions are product copy: they are the first thing anyone sees in a
  // shared link preview. Scoped to the metadata strings so an em dash in a
  // code comment (which no user reads) does not fail the suite.
  const metadataCopy = [
    ...layout.matchAll(/^\s*(?:title|description):\s*"([^"]*)"/gm),
    ...layout.matchAll(/^\s*"(CareerRat is [^"]*)"/gm),
  ].map((match) => match[1]);
  // Three titles (page, OG, Twitter) plus the shared siteDescription.
  assert.equal(metadataCopy.length, 4);
  for (const copy of metadataCopy) {
    assert.doesNotMatch(copy, /—/);
  }
});

test("deployed sites bundle fonts without Google build-time fetches", async () => {
  const websiteLayout = await readFile("apps/website/src/app/layout.tsx", "utf8");
  const docsLayout = await readFile("apps/docs/src/app/layout.tsx", "utf8");
  const combined = `${websiteLayout}\n${docsLayout}`;

  assert.doesNotMatch(combined, /next\/font\/google|fonts\.(?:googleapis|gstatic)\.com/);
  assert.match(websiteLayout, /next\/font\/local/);
  assert.match(docsLayout, /next\/font\/local/);
});

test("website install copy uses the public careerrat CLI convention", async () => {
  const page = await readFile("apps/website/src/app/page.tsx", "utf8");
  const publicAgents = await readFile("apps/website/public/AGENTS.md", "utf8");
  const installDocs = await readFile("apps/docs/content/docs/getting-started/install.mdx", "utf8");
  const packageJson = JSON.parse(await readFile("package.json", "utf8"));
  const combined = `${page}\n${publicAgents}`;

  assert.match(page, /npm install -g careerrat/);
  assert.match(page, /careerrat start claude/);
  assert.match(page, /careerrat update/);
  assert.match(publicAgents, /careerrat start claude/);
  assert.match(publicAgents, /careerrat ingest/);
  assert.match(publicAgents, /careerrat update/);
  assert.equal(packageJson.engines.node, ">=24");
  assert.match(page, /Node\.js 24 or newer/);
  assert.match(installDocs, /Node\.js >= 24/);
  assert.doesNotMatch(
    page,
    /Node\.js 18|zero runtime deps|any CLI (?:already )?on your PATH|anything else on your PATH|whatever AI CLI|nothing leaves it|nothing phoned home|all of it stays on your machine|No wizard/i
  );

  assert.doesNotMatch(combined, STALE_PUBLIC_CLI_PATTERN);
});

test("docs website source uses the public careerrat CLI convention", async () => {
  const files = await listFiles("apps/docs/content", ".mdx");
  const docs = await Promise.all(files.map(async (file) => readFile(file, "utf8")));
  const combined = docs.join("\n");

  assert.match(combined, /npm install -g careerrat/);
  assert.match(combined, /careerrat start claude/);
  assert.match(combined, /careerrat tracker-dev/);
  assert.match(combined, /careerrat automation status/);
  assert.match(combined, /careerrat update/);
  assert.match(combined, /site:dev/);
  assert.match(combined, /site:build/);
  assert.match(combined, /docs:dev/);
  assert.match(combined, /docs:build/);
  assert.doesNotMatch(combined, /\bweb:(?:dev|build)\b/);

  // Internal contracts use the current product name too.
  assert.match(combined, /~\/Downloads\/careerrat\//);

  assert.doesNotMatch(combined, STALE_PUBLIC_CLI_PATTERN);
});

test("public docs describe local storage and AI-provider boundaries accurately", async () => {
  const paths = [
    "apps/docs/content/docs/index.mdx",
    "apps/docs/content/docs/getting-started/what-is-careerrat.mdx",
    "apps/docs/content/docs/advanced/privacy.mdx",
  ];
  const combined = (await Promise.all(paths.map((path) => readFile(path, "utf8")))).join("\n");

  assert.doesNotMatch(combined, /your data never leaves your machine/i);
  assert.doesNotMatch(combined, /evidence, comp floor, and\s+excluded companies never leave/i);
  assert.match(combined, /provider(?:'s)? privacy and retention terms/i);
  assert.match(combined, /SQLite/i);
});

test("docs website is CareerRat-branded (product name and repo links)", async () => {
  const layout = await readFile("apps/docs/src/app/layout.tsx", "utf8");
  const indexPage = await readFile("apps/docs/content/docs/index.mdx", "utf8");

  assert.match(layout, /CareerRat Docs/);
  assert.match(layout, /github\.com\/CodesWhat\/careerrat/);
  assert.match(indexPage, /CareerRat is a local, skill-driven job-search workspace/);

  assert.doesNotMatch(layout, new RegExp(`\\b${LEGACY_BRAND}\\b`, "i"));
});
