#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const docsOutput = join(repoRoot, "apps", "docs", "out");
const websiteDocs = join(repoRoot, "apps", "website", "public", "docs");
const npm = process.platform === "win32" ? "npm.cmd" : "npm";

const result = spawnSync(npm, ["run", "build", "--workspace", "@careerrat/docs"], {
  cwd: repoRoot,
  stdio: "inherit",
});
if (result.error) throw result.error;
if (result.status !== 0) process.exit(result.status ?? 1);
if (!existsSync(docsOutput)) throw new Error(`Docs build produced no output at ${docsOutput}`);

rmSync(websiteDocs, { recursive: true, force: true });
mkdirSync(websiteDocs, { recursive: true });
cpSync(docsOutput, websiteDocs, { recursive: true });

// llms-full.txt: every docs page's Markdown body, in sidebar order, so agents
// can read the whole documentation set in one request.
const docsContent = join(repoRoot, "apps", "docs", "content", "docs");

function orderedEntries(directory) {
  const entries = readdirSync(directory, { withFileTypes: true });
  const metaPath = join(directory, "meta.json");
  const listed = existsSync(metaPath)
    ? (JSON.parse(readFileSync(metaPath, "utf8")).pages ?? [])
    : [];
  const names = new Set(entries.map((entry) => entry.name.replace(/\.mdx$/, "")));
  const order = [...listed.filter((name) => names.has(name)), ...[...names].sort()];
  return [...new Set(order)];
}

function collectDocs(directory, urlSegments = []) {
  return orderedEntries(directory).flatMap((name) => {
    const dirPath = join(directory, name);
    if (existsSync(dirPath) && statSync(dirPath).isDirectory()) {
      return collectDocs(dirPath, [...urlSegments, name]);
    }
    const file = `${dirPath}.mdx`;
    if (!existsSync(file)) return [];
    const source = readFileSync(file, "utf8");
    const match = source.match(/^---\n([\s\S]*?)\n---\n?/);
    const frontmatter = match?.[1] ?? "";
    const title = frontmatter.match(/^title:\s*(.+)$/m)?.[1]?.trim() ?? name;
    const description = frontmatter.match(/^description:\s*(.+)$/m)?.[1]?.trim();
    const segments = name === "index" ? urlSegments : [...urlSegments, name];
    const url = `https://careerrat.com/docs/${segments.length ? `${segments.join("/")}/` : ""}`;
    const body = source.slice(match ? match[0].length : 0).trim();
    return [
      {
        url,
        text: [`# ${title}`, `URL: ${url}`, description ? `> ${description}` : "", body]
          .filter(Boolean)
          .join("\n\n"),
      },
    ];
  });
}

const fullPages = collectDocs(docsContent).filter(
  (page) => !page.url.endsWith("/getting-started/dashboard/")
);
writeFileSync(
  join(repoRoot, "apps", "website", "public", "llms-full.txt"),
  `# CareerRat documentation\n\nSource: https://careerrat.com/docs/\n\n${fullPages.map((page) => page.text).join("\n\n---\n\n")}\n`
);
