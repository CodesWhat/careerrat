import { readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import type { MetadataRoute } from "next";

export const dynamic = "force-static";

const ORIGIN = "https://careerrat.com";

// Thin redirect stub kept so old links resolve. It is marked noindex in the
// docs metadata and stays out of the sitemap.
const EXCLUDED = new Set([`${ORIGIN}/docs/getting-started/dashboard/`]);

function docsPages(directory: string, segments: string[] = []): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    if (entry.isDirectory())
      return docsPages(join(directory, entry.name), [...segments, entry.name]);
    if (!entry.name.endsWith(".mdx")) return [];
    const page = entry.name.slice(0, -4);
    const slug = (page === "index" ? segments : [...segments, page])
      .map(encodeURIComponent)
      .join("/");
    return [`${ORIGIN}/docs/${slug ? `${slug}/` : ""}`];
  });
}

export default function sitemap(): MetadataRoute.Sitemap {
  const docs = resolve(process.cwd(), "../docs/content/docs");
  return [`${ORIGIN}/`, ...docsPages(docs)]
    .filter((url) => !EXCLUDED.has(url))
    .sort()
    .map((url) => ({ url }));
}
