import { readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import type { MetadataRoute } from "next";

export const dynamic = "force-static";

const ORIGIN = "https://careerrat.com";

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
  return [`${ORIGIN}/`, ...docsPages(docs)].sort().map((url) => ({ url }));
}
