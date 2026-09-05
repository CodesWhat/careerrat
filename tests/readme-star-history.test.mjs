import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

const repoRoot = new URL("../", import.meta.url);
const FORBIDDEN_HOSTS = [/warpchart\.dev/, /star-history\.com/];
const WEBSITE_EXTENSIONS = new Set([".tsx", ".ts", ".jsx", ".js", ".mdx", ".md", ".html"]);

async function walk(dirUrl) {
  let entries;
  try {
    entries = await readdir(dirUrl, { withFileTypes: true });
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }

  const files = [];
  for (const entry of entries) {
    const entryUrl = new URL(`${entry.name}${entry.isDirectory() ? "/" : ""}`, dirUrl);
    if (entry.isDirectory()) {
      files.push(...(await walk(entryUrl)));
    } else {
      files.push(entryUrl);
    }
  }
  return files;
}

function assertNoRetiredHosts(content, label) {
  for (const host of FORBIDDEN_HOSTS) {
    assert.doesNotMatch(content, host, `${label} references a retired chart host`);
  }
}

test("README.md does not reference a retired chart host", async () => {
  const readme = await readFile(new URL("README.md", repoRoot), "utf8");
  assertNoRetiredHosts(readme, "README.md");
});

test("README.md wires the committed star history SVGs into a <picture> element", async () => {
  const readme = await readFile(new URL("README.md", repoRoot), "utf8");
  const pictureMatch = readme.match(/<picture>[\s\S]*?<\/picture>/);
  assert.ok(
    pictureMatch,
    "README.md should contain a <picture> element for the star history chart"
  );

  const picture = pictureMatch[0];
  assert.match(picture, /apps\/website\/public\/star-history\.svg/);
  assert.match(picture, /apps\/website\/public\/star-history-dark\.svg/);
});

test("apps/website source and public assets do not reference a retired chart host", async () => {
  const websiteRoot = new URL("apps/website/", repoRoot);
  const dirs = ["src", "public"];

  for (const dir of dirs) {
    const files = await walk(new URL(`${dir}/`, websiteRoot));
    for (const fileUrl of files) {
      const ext = path.extname(fileUrl.pathname);
      if (!WEBSITE_EXTENSIONS.has(ext)) continue;
      const content = await readFile(fileUrl, "utf8");
      assertNoRetiredHosts(content, fileUrl.pathname);
    }
  }
});

test("apps/docs/content does not reference a retired chart host", async () => {
  const files = await walk(new URL("apps/docs/content/", repoRoot));
  assert.ok(files.length > 0, "expected apps/docs/content to contain files");

  for (const fileUrl of files) {
    const content = await readFile(fileUrl, "utf8").catch(() => null);
    if (content === null) continue;
    assertNoRetiredHosts(content, fileUrl.pathname);
  }
});

test("starchart.yml pins the reusable workflow to a full commit SHA and targets a dev branch", async () => {
  const workflow = await readFile(new URL(".github/workflows/starchart.yml", repoRoot), "utf8");

  const usesMatch = workflow.match(/uses:\s*\S+@([0-9a-f]+)/);
  assert.ok(usesMatch, "expected a `uses:` line pinned with @<sha>");
  assert.match(usesMatch[1], /^[0-9a-f]{40}$/, "the pinned ref should be a full 40-hex commit SHA");

  const branchMatch = workflow.match(/branch:\s*(\S+)/);
  assert.ok(branchMatch, "expected a `branch:` input");
  assert.match(branchMatch[1], /^dev\//, "branch input should target the active dev branch");
});
