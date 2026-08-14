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
const tokensPath = resolve(sourceRoot, "styles/tokens.css");

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
  const css = stripCssComments(readFileSync(tokensPath, "utf8"));
  const escapedSelector = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const body = css.match(new RegExp(`${escapedSelector}\\s*\\{([^}]*)\\}`))?.[1] ?? "";
  return new Map(
    [...body.matchAll(/(--[-\w]+)\s*:\s*([^;]+);/g)].map((match) => [
      match[1],
      match[2].trim(),
    ])
  );
}

const lightTokens = ruleTokens(":root");
const darkTokens = ruleTokens('[data-theme="dark"]');

function tokenMismatches(tokens, expected, theme) {
  return Object.entries(expected).flatMap(([name, value]) =>
    tokens.get(name) === value ? [] : [`tokens.css (${theme}) ${name}: ${tokens.get(name) ?? "missing"}`]
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
  if (name === "--accent" || name.startsWith("--accent-")) return true;
  if (seen.has(name)) return false;

  const value = tokens.get(name);
  if (!value) return false;

  const nextSeen = new Set(seen).add(name);
  return [...value.matchAll(/var\(\s*(--[-\w]+)/g)].some((match) =>
    resolvesToAccent(match[1], tokens, nextSeen)
  );
}

const accentVariables = new Set(
  [lightTokens, darkTokens].flatMap((tokens) =>
    [...tokens.keys()].filter((name) => resolvesToAccent(name, tokens))
  )
);
const rawAccentColors = new Set(
  [lightTokens.get("--accent"), darkTokens.get("--accent")]
    .filter(Boolean)
    .map((value) => value.toLowerCase())
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

describe("CareerRat flat design", () => {
  it("keeps every shadow token disabled in light and dark themes", () => {
    const expected = { "--card-shadow": "none", "--header-pill-shadow": "none" };
    const mismatches = [
      ...tokenMismatches(lightTokens, expected, "light"),
      ...tokenMismatches(darkTokens, expected, "dark"),
    ];

    expect(mismatches, mismatches.join("\n")).toEqual([]);
  });

  it("allows only none or disabled shadow-token references in box-shadow declarations", () => {
    const allowedValues = new Set([
      "none",
      "var(--card-shadow)",
      "var(--header-pill-shadow)",
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

describe("CareerRat palette tokens", () => {
  it("pins the canonical light palette", () => {
    const mismatches = tokenMismatches(
      lightTokens,
      {
        "--canvas": "#ececea",
        "--surface": "#fbfbf9",
        "--card": "#ffffff",
        "--ink": "#17171a",
        "--accent": "#2545d3",
      },
      "light"
    );

    expect(mismatches, mismatches.join("\n")).toEqual([]);
  });

  it("keeps the complete light legacy palette as value-only aliases", () => {
    const mismatches = tokenMismatches(
      lightTokens,
      {
        "--paper-bg": "var(--canvas)",
        "--paper-band": "var(--surface)",
        "--paper-surface": "var(--card)",
        "--paper-edge": "var(--border-soft)",
        "--paper-edge-strong": "var(--border)",
        "--zebra-odd": "var(--paper-band)",
        "--zebra-even": "var(--paper-surface)",
        "--cool-ink": "var(--ink)",
        "--cool-ink-mid": "var(--ink-soft)",
        "--cool-ink-soft": "var(--ink-faint)",
        "--coral": "var(--accent)",
        "--coral-dark": "var(--accent-dark)",
        "--teal": "var(--success)",
        "--teal-light": "var(--success-bg)",
        "--mustard": "var(--warning)",
        "--mustard-light": "var(--warning-bg)",
        "--sky": "var(--accent)",
      },
      "light"
    );

    expect(mismatches, mismatches.join("\n")).toEqual([]);
  });

  it("keeps dark-theme legacy aliases routed through canonical tokens", () => {
    const mismatches = tokenMismatches(
      darkTokens,
      {
        "--paper-bg": "var(--canvas)",
        "--paper-band": "var(--surface)",
        "--paper-surface": "var(--card)",
        "--paper-edge": "var(--border-soft)",
        "--paper-edge-strong": "var(--border)",
        "--cool-ink": "var(--ink)",
        "--cool-ink-mid": "var(--ink-soft)",
        "--cool-ink-soft": "var(--ink-faint)",
        "--coral": "var(--accent)",
        "--coral-dark": "var(--accent-dark)",
        "--teal": "var(--success)",
        "--teal-light": "var(--success-bg)",
        "--mustard": "var(--warning)",
        "--mustard-light": "var(--warning-bg)",
        "--sky": "var(--accent)",
      },
      "dark"
    );

    expect(mismatches, mismatches.join("\n")).toEqual([]);
  });
});

describe("CareerRat typography", () => {
  it("loads the Archivo display weights used by the app", () => {
    const tokensCss = stripCssComments(readFileSync(tokensPath, "utf8"));
    const importedWeights = [...tokensCss.matchAll(
      /@import\s+["']@fontsource\/archivo\/(\d+)\.css["']\s*;/g
    )]
      .map((match) => match[1])
      .sort();
    const hasArchivoDisplayFamily = declarations.some(
      ({ property, value }) => property === "font-family" && /^"Archivo"\s*,/.test(value)
    );

    expect({ importedWeights, hasArchivoDisplayFamily }).toEqual({
      importedWeights: ["700", "800"],
      hasArchivoDisplayFamily: true,
    });
  });

  it("keeps Geist Mono as the label font token", () => {
    expect(lightTokens.get("--label-font")).toBe('"Geist Mono", ui-monospace, monospace');
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

    // The sanctioned .automation-mode__choice--selected rule is a 1.5px
    // full border, so it is intentionally outside this edge-rail check.
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
