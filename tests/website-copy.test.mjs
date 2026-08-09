import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

const STALE_PUBLIC_CLI_PATTERN =
  /node bin\/rolester\.mjs|npm run (?:doctor|next|ingest|searches|companies|modes|automation|research|gate|learnings|stories|activity|analytics|evidence|strategy-review|status:map|export|install-skills|evaluate|tracker|tracker:dev)(?:\s|`|$)|(?:rolester|careerrat) [a-z:-]+ -- --|tracker:dev/;

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
  const page = await readFile("website/src/app/page.tsx", "utf8");

  assert.match(page, /Your job hunt, run by a rat\./);
  assert.match(page, /npm i -g careerrat/);
  assert.doesNotMatch(page, /rolester/i);
});

test("root layout suppresses the intentional early html class hydration delta", async () => {
  const layout = await readFile("website/src/app/layout.tsx", "utf8");

  assert.match(layout, /documentElement;?[\s\S]*?\.classList\.add\('js'\)/);
  assert.match(layout, /<html[\s\S]*suppressHydrationWarning/);
});

test("website metadata is CareerRat-branded", async () => {
  const layout = await readFile("website/src/app/layout.tsx", "utf8");

  assert.match(layout, /CareerRat — Rate\. Apply\. Track\./);
  assert.doesNotMatch(layout, /rolester/i);
});

test("website install copy uses the public careerrat CLI convention", async () => {
  const page = await readFile("website/src/app/page.tsx", "utf8");
  const publicAgents = await readFile("website/public/AGENTS.md", "utf8");
  const combined = `${page}\n${publicAgents}`;

  assert.match(page, /npm install -g careerrat/);
  assert.match(page, /careerrat start claude/);
  assert.match(page, /careerrat update/);
  assert.match(publicAgents, /careerrat start claude/);
  assert.match(publicAgents, /careerrat ingest/);
  assert.match(publicAgents, /careerrat update/);

  assert.doesNotMatch(combined, STALE_PUBLIC_CLI_PATTERN);
});

test("docs website source uses the public rolester CLI convention (pre-rebrand)", async () => {
  // docs-site is still Rolester-branded until the W5b docs rebrand lands;
  // flip these assertions to careerrat when that happens.
  const files = await listFiles("docs-site/content", ".mdx");
  const docs = await Promise.all(files.map(async (file) => readFile(file, "utf8")));
  const combined = docs.join("\n");

  assert.match(combined, /npm install -g rolester/);
  assert.match(combined, /rolester start claude/);
  assert.match(combined, /rolester tracker-dev/);
  assert.match(combined, /rolester automation status/);
  assert.match(combined, /rolester update/);

  assert.doesNotMatch(combined, STALE_PUBLIC_CLI_PATTERN);
});
