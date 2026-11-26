import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

const DOCS = "apps/docs/content/docs";
// Redirect stub, kept out of the sitemap and the index.
const SKIPPED = new Set(["getting-started/dashboard"]);

async function docSlugs(directory, segments = []) {
  const entries = await readdir(join(DOCS, ...segments), { withFileTypes: true });
  const nested = await Promise.all(
    entries.map(async (entry) => {
      if (entry.isDirectory()) return docSlugs(directory, [...segments, entry.name]);
      if (!entry.name.endsWith(".mdx")) return [];
      const page = entry.name.slice(0, -4);
      return [(page === "index" ? segments : [...segments, page]).join("/")];
    })
  );
  return nested.flat();
}

test("llms.txt lists every indexed docs page", async () => {
  const llms = await readFile("apps/website/public/llms.txt", "utf8");
  for (const slug of await docSlugs(DOCS)) {
    if (SKIPPED.has(slug)) continue;
    const url = `https://careerrat.com/docs/${slug ? `${slug}/` : ""}`;
    assert.ok(llms.includes(`](${url})`), `llms.txt is missing ${url}`);
  }
  assert.doesNotMatch(llms, /—/);
});
