import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, extname, join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const webRoot = resolve(import.meta.dirname, "..");
const sourceRoot = resolve(webRoot, "src");
const sourceExtensions = new Set([".css", ".js", ".jsx"]);

function sourceFiles(directory) {
  return readdirSync(directory).flatMap((name) => {
    const path = join(directory, name);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    if (!sourceExtensions.has(extname(path)) || /\.test\.[^.]+$/.test(path)) return [];
    return [path];
  });
}

function importedPaths(path) {
  const source = readFileSync(path, "utf8");
  const specs = [
    ...source.matchAll(/\bfrom\s*["']([^"']+)["']/g),
    ...source.matchAll(/\bimport\s*["']([^"']+)["']/g),
    ...source.matchAll(/\bimport\s*\(\s*["']([^"']+)["']\s*\)/g),
  ].map((match) => match[1]);

  return specs.flatMap((spec) => {
    if (!spec.startsWith(".")) return [];
    const base = resolve(dirname(path), spec);
    const resolved = [base, `${base}.js`, `${base}.jsx`, `${base}.css`].find(
      (candidate) => existsSync(candidate) && statSync(candidate).isFile()
    );
    return resolved ? [resolved] : [];
  });
}

function reachableSources(entries) {
  const reached = new Set();
  const pending = [...entries];
  while (pending.length) {
    const path = pending.pop();
    if (reached.has(path)) continue;
    reached.add(path);
    pending.push(...importedPaths(path));
  }
  return reached;
}

describe("chat-first source graph", () => {
  it("contains no retired page UI outside the shipping workspace graph", () => {
    const reached = reachableSources([resolve(sourceRoot, "main.jsx")]);
    const unreachable = sourceFiles(sourceRoot)
      .filter((path) => !reached.has(path))
      .map((path) => relative(sourceRoot, path))
      .sort();

    expect(unreachable).toEqual([]);
  });

  it("loads the chat-first foundation without the retired global stylesheet", () => {
    const main = readFileSync(resolve(sourceRoot, "main.jsx"), "utf8");

    expect(main).toContain('import "./chat-first/app-foundation.css";');
    expect(main).not.toContain("styles/app.css");
    expect(existsSync(resolve(sourceRoot, "styles/app.css"))).toBe(false);
  });

  it("has no static-preview compatibility API in the shipping client", () => {
    const api = readFileSync(resolve(sourceRoot, "lib/api.js"), "utf8");
    const shippingSource = sourceFiles(sourceRoot)
      .map((path) => readFileSync(path, "utf8"))
      .join("\n");

    expect(api).not.toContain("staticPreviewApi");
    expect(api).not.toContain("isStaticPreviewApi");
    expect(shippingSource).not.toContain("VITE_STATIC_PREVIEW");
    expect(existsSync(resolve(sourceRoot, "preview/staticPreviewApi.js"))).toBe(false);
  });

  it("owns the live dashboard context inside the chat-first workspace", () => {
    expect(existsSync(resolve(sourceRoot, "chat-first/dashboard-context.jsx"))).toBe(true);
    expect(existsSync(resolve(sourceRoot, "app-shell"))).toBe(false);
  });

  it("refreshes through direct writes and server events without dead same-tab event buses", () => {
    const context = readFileSync(resolve(sourceRoot, "chat-first/dashboard-context.jsx"), "utf8");

    expect(context).not.toContain("dashboard-events");
    expect(context).not.toContain("intake-events");
    expect(existsSync(resolve(sourceRoot, "lib/dashboard-events.js"))).toBe(false);
    expect(existsSync(resolve(sourceRoot, "lib/intake-events.js"))).toBe(false);
  });

  it("owns its active SVG set without the retired component catalog", () => {
    expect(existsSync(resolve(sourceRoot, "components/icons.jsx"))).toBe(false);
  });

  it("ships one fixed light visual mode without the retired theme bootstrap", () => {
    const index = readFileSync(resolve(webRoot, "index.html"), "utf8");
    const css = sourceFiles(sourceRoot)
      .filter((path) => extname(path) === ".css")
      .map((path) => readFileSync(path, "utf8"))
      .join("\n");

    expect(index).not.toContain("theme-init.js");
    expect(css).not.toContain('[data-theme="dark"]');
    expect(existsSync(resolve(webRoot, "public/theme-init.js"))).toBe(false);
    expect(existsSync(resolve(sourceRoot, "styles"))).toBe(false);
  });
});
