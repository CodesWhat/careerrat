import { execFileSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import type { MetadataRoute } from "next";

export const dynamic = "force-static";

const ORIGIN = "https://careerrat.com";

// Thin redirect stub kept so old links resolve. It is marked noindex in the
// docs metadata and stays out of the sitemap.
const EXCLUDED = new Set([`${ORIGIN}/docs/getting-started/dashboard/`]);

function git(args: string[], cwd: string): string | undefined {
  try {
    return execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return undefined;
  }
}

// Last commit date per page, from git. A shallow clone would stamp every page
// with the tip commit's date, so dates are left off there instead.
function lastModifiedByUrl(docs: string, files: [string, string][]): Map<string, Date> {
  const dates = new Map<string, Date>();
  if (git(["rev-parse", "--is-shallow-repository"], docs) !== "false") return dates;
  for (const [url, file] of files) {
    const iso = git(["log", "-1", "--format=%cI", "--", file], docs);
    if (iso) dates.set(url, new Date(iso));
  }
  return dates;
}

function docsFiles(directory: string, segments: string[] = []): [string, string][] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    if (entry.isDirectory())
      return docsFiles(join(directory, entry.name), [...segments, entry.name]);
    if (!entry.name.endsWith(".mdx")) return [];
    const page = entry.name.slice(0, -4);
    const slug = (page === "index" ? segments : [...segments, page])
      .map(encodeURIComponent)
      .join("/");
    return [[`${ORIGIN}/docs/${slug ? `${slug}/` : ""}`, join(directory, entry.name)]];
  });
}

export default function sitemap(): MetadataRoute.Sitemap {
  const docs = resolve(process.cwd(), "../docs/content/docs");
  const files = docsFiles(docs).filter(([url]) => !EXCLUDED.has(url));
  const modified = lastModifiedByUrl(docs, files);
  return [[`${ORIGIN}/`, undefined] as const, ...files]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([url]) => ({ url, lastModified: modified.get(url) }));
}
