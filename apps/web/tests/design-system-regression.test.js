import { readFileSync, readdirSync } from "node:fs";
import { extname, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// Static source analysis keeps these design-system guards fast and independent
// of Vite's output ordering/minification. The optional root override is used to
// prove the scanner goes red against an isolated, deliberately broken copy.
const sourceRoot = process.env.CAREERRAT_STYLE_SOURCE_ROOT
  ? resolve(process.env.CAREERRAT_STYLE_SOURCE_ROOT)
  : fileURLToPath(new URL("../src", import.meta.url));
const palettePath = resolve(sourceRoot, "chat-first/chat-first.css");
const foundationPath = resolve(sourceRoot, "chat-first/app-foundation.css");

function walkFiles(directory) {
  return readdirSync(directory, { withFileTypes: true })
    .flatMap((entry) => {
      const path = resolve(directory, entry.name);
      return entry.isDirectory() ? walkFiles(path) : [path];
    })
    .sort();
}

const sourceFiles = walkFiles(sourceRoot);
const cssFiles = sourceFiles.filter((path) => extname(path) === ".css");

function fileLabel(path) {
  return relative(sourceRoot, path).split(sep).join("/");
}

function stripCssComments(css) {
  return css.replace(/\/\*[\s\S]*?\*\//g, (comment) => comment.replace(/[^\n]/g, " "));
}

function lineAt(source, index) {
  return source.slice(0, index).split("\n").length;
}

function cssDeclarations(path) {
  const css = stripCssComments(readFileSync(path, "utf8"));
  const declarations = [];
  const declarationPattern = /(^|[;{])\s*([-\w]+)\s*:\s*([^;{}]+?)(?=;|})/gm;

  for (const match of css.matchAll(declarationPattern)) {
    const propertyOffset = match[0].indexOf(match[2]);
    declarations.push({
      file: fileLabel(path),
      line: lineAt(css, match.index + propertyOffset),
      property: match[2].toLowerCase(),
      value: match[3].trim(),
    });
  }

  return declarations;
}

const declarations = cssFiles.flatMap(cssDeclarations);

function ruleTokens(selector) {
  const css = stripCssComments(readFileSync(palettePath, "utf8"));
  const escapedSelector = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const body = css.match(new RegExp(`${escapedSelector}\\s*\\{([^}]*)\\}`))?.[1] ?? "";
  return new Map(
    [...body.matchAll(/(--[-\w]+)\s*:\s*([^;]+);/g)].map((match) => [
      match[1],
      match[2].trim(),
    ])
  );
}

const chatFirstTokens = ruleTokens(".chat-first-workspace");

function tokenMismatches(tokens, expected) {
  return Object.entries(expected).flatMap(([name, value]) =>
    tokens.get(name) === value
      ? []
      : [`chat-first.css ${name}: ${tokens.get(name) ?? "missing"}`]
  );
}

function textOccurrences(files, pattern) {
  return files.flatMap((path) => {
    const source = readFileSync(path, "utf8");
    return source.split("\n").flatMap((line, index) =>
      pattern.test(line) ? [`${fileLabel(path)}:${index + 1}: ${line.trim()}`] : []
    );
  });
}

function resolvesToAccent(name, tokens, seen = new Set()) {
  if (name === "--cf-lime" || name.startsWith("--cf-lime-")) return true;
  if (seen.has(name)) return false;

  const value = tokens.get(name);
  if (!value) return false;

  const nextSeen = new Set(seen).add(name);
  return [...value.matchAll(/var\(\s*(--[-\w]+)/g)].some((match) =>
    resolvesToAccent(match[1], tokens, nextSeen)
  );
}

const accentVariables = new Set(
  [...chatFirstTokens.keys()].filter((name) => resolvesToAccent(name, chatFirstTokens))
);
const rawAccentColors = new Set(
  [chatFirstTokens.get("--cf-lime")].filter(Boolean).map((value) => value.toLowerCase())
);

function hasAccentColor(value) {
  const variableReferences = [...value.matchAll(/var\(\s*(--[-\w]+)/g)].map(
    (match) => match[1]
  );
  const normalizedValue = value.toLowerCase();
  return (
    variableReferences.some((name) => accentVariables.has(name)) ||
    [...rawAccentColors].some((color) => normalizedValue.includes(color))
  );
}

function hasTwoPixelOrWiderBorder(value) {
  if (/\b(?:medium|thick)\b/i.test(value)) return true;

  return [...value.matchAll(/(-?\d*\.?\d+)\s*(px|rem|em|pt)\b/gi)].some((match) => {
    const amount = Number(match[1]);
    const pixelsPerUnit = { px: 1, rem: 16, em: 16, pt: 4 / 3 }[match[2].toLowerCase()];
    return amount * pixelsPerUnit >= 2;
  });
}

describe("CareerRat chat-first surfaces", () => {
  it("does not carry retired shadow or theme aliases", () => {
    const offenders = textOccurrences(cssFiles, /--(?:card-shadow|header-pill-shadow)|data-theme/i);

    expect(offenders, offenders.join("\n")).toEqual([]);
  });

  it("allows only the handoff dropdown and modal elevations", () => {
    const allowedValues = new Set([
      "none",
      "0 14px 40px rgba(20, 20, 10, 0.18)",
      "0 24px 60px rgba(20, 20, 10, 0.3)",
    ]);
    const offenders = declarations
      .filter(({ property, value }) => property.endsWith("box-shadow") && !allowedValues.has(value))
      .map(({ file, line, value }) => `${file}:${line}: box-shadow: ${value}`);

    expect(offenders, offenders.join("\n")).toEqual([]);
  });

  it("does not use gradients in CSS property values", () => {
    const offenders = declarations
      .filter(({ value }) => /\b(?:linear|radial|conic)-gradient\s*\(/i.test(value))
      .map(({ file, line, property, value }) => `${file}:${line}: ${property}: ${value}`);

    expect(offenders, offenders.join("\n")).toEqual([]);
  });

  it("does not declare backdrop filters", () => {
    const offenders = declarations
      .filter(({ property }) => property.endsWith("backdrop-filter"))
      .map(({ file, line, property, value }) => `${file}:${line}: ${property}: ${value}`);

    expect(offenders, offenders.join("\n")).toEqual([]);
  });
});

describe("CareerRat chat-first palette", () => {
  it("pins the fixed handoff palette", () => {
    const mismatches = tokenMismatches(
      chatFirstTokens,
      {
        "--cf-bg": "#edf5fb",
        "--cf-panel": "#ffffff",
        "--cf-cream": "#faf7ef",
        "--cf-ink": "#17171a",
        "--cf-lime": "#e6fa8d",
        "--cf-lavender": "#d9a6f4",
        "--cf-sky": "#8fd0f8",
        "--cf-red": "#f04c38",
      }
    );

    expect(mismatches, mismatches.join("\n")).toEqual([]);
  });
});

describe("CareerRat typography", () => {
  it("loads every Figtree weight used by the chat-first app", () => {
    const foundationCss = stripCssComments(readFileSync(foundationPath, "utf8"));
    const importedWeights = [...foundationCss.matchAll(
      /@import\s+["']@fontsource\/figtree\/(\d+)\.css["']\s*;/g
    )]
      .map((match) => match[1])
      .sort();
    const hasFigtreeFamily = declarations.some(
      ({ property, value }) => property === "font-family" && /^"Figtree"\s*,/.test(value)
    );

    expect({ importedWeights, hasFigtreeFamily }).toEqual({
      importedWeights: ["400", "500", "600", "700", "800"],
      hasFigtreeFamily: true,
    });
  });

  it("self-hosts both Geist families from the shared asset tree", () => {
    const foundationCss = stripCssComments(readFileSync(foundationPath, "utf8"));

    expect(foundationCss).toContain('../../../../assets/fonts/GeistVF.woff2');
    expect(foundationCss).toContain('../../../../assets/fonts/GeistMonoVF.woff2');
  });

  it("does not reference the retired Fraunces font anywhere in web source", () => {
    const offenders = textOccurrences(sourceFiles, /Fraunces/i);

    expect(offenders, offenders.join("\n")).toEqual([]);
  });
});

describe("CareerRat card edges", () => {
  it("does not use two-pixel-or-wider accent border rails", () => {
    const offenders = declarations
      .filter(
        ({ property, value }) =>
          ["border-left", "border-right"].includes(property) &&
          hasTwoPixelOrWiderBorder(value) &&
          hasAccentColor(value)
      )
      .map(({ file, line, property, value }) => `${file}:${line}: ${property}: ${value}`);

    expect(offenders, offenders.join("\n")).toEqual([]);
  });
});

describe("CareerRat UI copy", () => {
  it("does not ship Roland references in JavaScript or JSX modules", () => {
    // Existing component tests retain old copy in negative assertions; test
    // modules are not shipped UI and therefore are excluded from this scan.
    const runtimeModules = sourceFiles.filter(
      (path) => [".js", ".jsx"].includes(extname(path)) && !/\.test\.[cm]?[jt]sx?$/.test(path)
    );
    const offenders = textOccurrences(runtimeModules, /Roland/i);

    expect(offenders, offenders.join("\n")).toEqual([]);
  });
});
