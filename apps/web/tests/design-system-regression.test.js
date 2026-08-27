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

function ruleBody(path, selector) {
  const css = stripCssComments(readFileSync(path, "utf8"));
  const escapedSelector = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return css.match(new RegExp(`${escapedSelector}\\s*\\{([^}]*)\\}`))?.[1] ?? "";
}

function ruleCustomProperties(path, selector) {
  const body = ruleBody(path, selector);
  return new Map(
    [...body.matchAll(/(--[-\w]+)\s*:\s*([^;]+);/g)].map((match) => [
      match[1],
      match[2].trim(),
    ])
  );
}

const foundationProperties = ruleCustomProperties(foundationPath, ":root");

function customPropertyMismatches(properties, expected) {
  return Object.entries(expected).flatMap(([name, value]) =>
    properties.get(name) === value
      ? []
      : [`app-foundation.css ${name}: ${properties.get(name) ?? "missing"}`]
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

function resolvesToAccent(name, properties, seen = new Set()) {
  if (name === "--lime" || name.startsWith("--lime-")) return true;
  if (seen.has(name)) return false;

  const value = properties.get(name);
  if (!value) return false;

  const nextSeen = new Set(seen).add(name);
  return [...value.matchAll(/var\(\s*(--[-\w]+)/g)].some((match) =>
    resolvesToAccent(match[1], properties, nextSeen)
  );
}

const accentVariables = new Set(
  [...foundationProperties.keys()].filter((name) =>
    resolvesToAccent(name, foundationProperties)
  )
);
const rawAccentColors = new Set(
  [foundationProperties.get("--lime")].filter(Boolean).map((value) => value.toLowerCase())
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
      "var(--cf-selection-shadow)",
      "var(--shadow-popover)",
      "var(--shadow-modal)",
      "var(--shadow-sheet)",
      "var(--shadow-hair)",
    ]);
    const offenders = declarations
      .filter(({ property, value }) => property.endsWith("box-shadow") && !allowedValues.has(value))
      .map(({ file, line, value }) => `${file}:${line}: box-shadow: ${value}`);

    expect(offenders, offenders.join("\n")).toEqual([]);
    expect(readFileSync(foundationPath, "utf8")).toMatch(/--cf-selection-shadow:\s*none/);
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
  it("defines the authoritative handoff palette and elevations in the foundation", () => {
    const mismatches = customPropertyMismatches(
      foundationProperties,
      {
        "--ink": "#17171a",
        "--ink-soft": "#55584a",
        "--ink-warm-deep": "#3a3a35",
        "--ink-deepest": "#26261f",
        "--paper": "#fdfcf7",
        "--white": "#ffffff",
        "--canvas": "#edf5fb",
        "--cream": "#faf7ef",
        "--cream-light": "#fffdf6",
        "--cream-edge": "#f5f1e5",
        "--lime": "#e6fa8d",
        "--lime-deep": "#def780",
        "--lime-bar": "#d9ef7a",
        "--sky": "#8fd0f8",
        "--lilac": "#d9a6f4",
        "--lilac-tint": "#f3e8fb",
        "--red": "#f04c38",
        "--slate": "#7d8894",
        "--gray": "#a5a5ab",
        "--gray-dim": "#9a9a92",
        "--gray-warm": "#c9c9c0",
        "--gray-selected": "#474a4f",
        "--line-warm": "#e3e0d6",
        "--line-warm-2": "#d9d5c9",
        "--line-cool": "#c9d4dc",
        "--line-cool-2": "#d7dee4",
        "--tint-cool": "#f2f6f9",
        "--tint-cool-2": "#e8edf2",
        "--tint-cool-3": "#f0f2f5",
        "--shadow-popover": "0 14px 40px rgba(20, 20, 10, 0.18)",
        "--shadow-modal": "0 24px 60px rgba(20, 20, 10, 0.35)",
        "--shadow-sheet": "0 24px 60px rgba(20, 20, 10, 0.3)",
        "--shadow-hair": "0 1px 3px rgba(0, 0, 0, 0.25)",
        "--scrim-modal": "rgba(23, 23, 26, 0.55)",
        "--scrim-sheet": "rgba(23, 23, 26, 0.45)",
      }
    );

    expect(mismatches, mismatches.join("\n")).toEqual([]);
  });

  it("keeps every raw CSS color in the shared foundation", () => {
    const offenders = [];
    for (const declaration of declarations) {
      if (declaration.file === "chat-first/app-foundation.css" && declaration.property.startsWith("--")) {
        continue;
      }
      for (const match of declaration.value.matchAll(/#[0-9a-f]{3,8}\b|rgba?\([^)]*\)/gi)) {
        offenders.push(
          `${declaration.file}:${declaration.line}: ${declaration.property}: ${match[0]}`
        );
      }
    }

    expect(offenders, offenders.join("\n")).toEqual([]);
  });
});

describe("CareerRat selection and focus states", () => {
  const selectionRules = [
    ["chat-first/chat-first.css", ".chat-first-thread-card.is-active"],
    ["chat-first/first-run.css", '.cf-first-run__engine-choice[aria-pressed="true"]'],
    ["chat-first/first-run.css", ".cf-first-run__paul-card"],
    ["chat-first/workspace-browser.css", '.cf-browser__tab[aria-selected="true"]'],
    ["chat-first/workspace-browser.css", ".cf-browser .cf-filter--active"],
    ["chat-first/workspace-browser.css", ".cf-job-row--selected"],
    ["chat-first/profile-settings.css", '.cf-profile__tabs button[aria-current="page"]'],
    ["chat-first/profile-settings.css", '.cf-settings-dialog__runtime[data-selected="true"]'],
  ];

  it("uses one neutral dark-gray selection contract across every selectable surface", () => {
    expect(foundationProperties.get("--gray-selected")).toBe("#474a4f");
    expect(foundationProperties.get("--cf-selection-fill")).toBe("var(--gray-selected)");
    expect(foundationProperties.get("--cf-selection-fill")).not.toMatch(/ink|black/i);
    expect(foundationProperties.get("--cf-selection-foreground")).toBe("var(--paper)");
    expect(foundationProperties.get("--cf-selection-border")).toBe("0");
    expect(foundationProperties.get("--cf-selection-outline")).toBe("0");
    expect(foundationProperties.get("--cf-selection-shadow")).toBe("none");
    expect(foundationProperties.get("--cf-selection-avatar-surface")).toBe("transparent");

    for (const [file, selector] of selectionRules) {
      const body = ruleBody(resolve(sourceRoot, file), selector);
      expect(body, `${file} ${selector}`).toMatch(
        /background:\s*var\(--cf-selection-fill\)/
      );
      expect(body, `${file} ${selector}`).toMatch(
        /color:\s*var\(--cf-selection-foreground\)/
      );
      expect(body, `${file} ${selector}`).toMatch(
        /border:\s*var\(--cf-selection-border\)/
      );
      expect(body, `${file} ${selector}`).toMatch(
        /outline:\s*var\(--cf-selection-outline\)/
      );
      expect(body, `${file} ${selector}`).toMatch(
        /box-shadow:\s*var\(--cf-selection-shadow\)/
      );
      expect(body, `${file} ${selector}`).not.toMatch(/lime|lilac|sky|color-mix|#[0-9a-f]/i);
    }
  });

  it("uses the neutral selection fill for switches and native checked controls", () => {
    const switchBody = ruleBody(
      resolve(sourceRoot, "chat-first/profile-settings.css"),
      '.cf-settings__switch[aria-checked="true"]'
    );
    expect(switchBody).toMatch(/background:\s*var\(--cf-selection-fill\)/);

    for (const [file, selector] of [
      ["chat-first/first-run.css", ".cf-first-run__editor-checkbox input"],
      ["chat-first/profile-settings.css", ".cf-profile-editor__check input"],
    ]) {
      const body = ruleBody(resolve(sourceRoot, file), selector);
      expect(body, `${file} ${selector}`).toMatch(
        /accent-color:\s*var\(--cf-selection-fill\)/
      );
      expect(body, `${file} ${selector}`).not.toMatch(/var\(--ink\)|black/i);
    }
  });

  it("keeps secondary copy readable on the neutral selected surface", () => {
    for (const [file, selector] of [
      ["chat-first/first-run.css", ".cf-first-run__rail-subtitle"],
      [
        "chat-first/chat-first.css",
        ".chat-first-thread-card.is-active .chat-first-thread-card__subtitle",
      ],
      [
        "chat-first/workspace-browser.css",
        ".cf-job-row--selected :is(.cf-job-row__role, .cf-job-row__meta, .cf-job-row__stage)",
      ],
      [
        "chat-first/profile-settings.css",
        '.cf-settings-dialog__runtime[data-selected="true"] > div span',
      ],
    ]) {
      const body = ruleBody(resolve(sourceRoot, file), selector);
      expect(body, `${file} ${selector}`).toMatch(
        /color:\s*var\(--cf-selection-foreground\)/
      );
    }
  });

  it("keeps selected icon tiles transparent and free of accent surrounds", () => {
    const iconRules = [
      [
        "chat-first/chat-first.css",
        ".chat-first-thread-card.is-active .chat-first-thread-card__icon-badge",
      ],
      ["chat-first/first-run.css", ".cf-first-run__rail-avatar"],
      [
        "chat-first/first-run.css",
        '.cf-first-run__engine-choice[aria-pressed="true"] .cf-runtime-icon',
      ],
      [
        "chat-first/profile-settings.css",
        '.cf-settings-dialog__runtime[data-selected="true"] .cf-runtime-icon',
      ],
    ];

    for (const [file, selector] of iconRules) {
      const body = ruleBody(resolve(sourceRoot, file), selector);
      expect(body, `${file} ${selector}`).toMatch(
        /background:\s*var\(--cf-selection-avatar-surface\)/
      );
      expect(body, `${file} ${selector}`).not.toMatch(
        /(?:^|;)\s*(?:border|outline|box-shadow)\s*:|lime|lilac|sky|#[0-9a-f]/i
      );
    }
  });

  it("does not let auxiliary selected-state rules reintroduce a visual surround", () => {
    const allowedVisualValues = new Set([
      "var(--cf-selection-fill)",
      "var(--cf-selection-border)",
      "var(--cf-selection-outline)",
      "var(--cf-selection-shadow)",
      "var(--cf-selection-avatar-surface)",
      "transparent",
    ]);
    const stateRules = cssFiles.flatMap((path) => {
      const css = stripCssComments(readFileSync(path, "utf8"));
      return [...css.matchAll(/([^{}]+)\{([^}]*)\}/g)]
        .filter(
          (match) =>
            /is-active|--active|--selected|aria-(?:checked|selected|current|pressed)|data-selected/.test(
              match[1]
            ) &&
            !/:not\([^)]*(?:active|selected)/.test(match[1]) &&
            !/activity__mark--active|knowledge-card--active/.test(match[1])
        )
        .map((match) => ({ file: fileLabel(path), selector: match[1].trim(), body: match[2] }));
    });
    const offenders = stateRules.flatMap(({ file, selector, body }) =>
      [...body.matchAll(/(?:^|;)\s*(background|border|outline|box-shadow)\s*:\s*([^;]+)/g)]
        .filter((match) => !allowedVisualValues.has(match[2].trim()))
        .map((match) => `${file} ${selector}: ${match[1]}: ${match[2].trim()}`)
    );

    expect(stateRules.length).toBeGreaterThan(selectionRules.length);
    expect(offenders, offenders.join("\n")).toEqual([]);
  });

  it("keeps keyboard focus sky on controls and suppresses it on selected rows", () => {
    const focusRules = cssFiles.flatMap((path) => {
      const css = stripCssComments(readFileSync(path, "utf8"));
      return [...css.matchAll(/([^{}]*:focus(?:-visible|-within)?[^{}]*)\{([^}]*)\}/g)].map(
        (match) => ({ file: fileLabel(path), selector: match[1].trim(), body: match[2] })
      );
    });
    const outlined = focusRules.filter(({ body }) => /\boutline\s*:/.test(body));
    const selected = outlined.filter(({ selector }) =>
      /is-active|--selected|aria-(?:selected|current|pressed)|data-selected/.test(selector)
    );
    const ordinaryOffenders = outlined
      .filter(({ selector }) => !selected.some((rule) => rule.selector === selector))
      .filter(
        ({ body }) =>
          !/outline:\s*var\(--cf-focus-ring(?:-compact)?\)/.test(body) ||
          /selection|lime|color-mix|#(?:17171a|e6fa8d)/i.test(body)
      )
      .map(({ file, selector }) => `${file}: ${selector}`);
    const selectedOffenders = selected
      .filter(
        ({ body }) =>
          !/outline:\s*var\(--cf-selection-outline\)/.test(body) ||
          !/box-shadow:\s*var\(--cf-selection-shadow\)/.test(body) ||
          /cf-focus-ring|lime|color-mix|#[0-9a-f]/i.test(body)
      )
      .map(({ file, selector }) => `${file}: ${selector}`);

    expect(foundationProperties.get("--cf-focus-ring")).toBe("3px solid var(--sky)");
    expect(foundationProperties.get("--cf-focus-ring-compact")).toBe("2px solid var(--sky)");
    expect(outlined.length).toBeGreaterThan(0);
    expect(selected.length).toBeGreaterThan(0);
    expect(ordinaryOffenders, ordinaryOffenders.join("\n")).toEqual([]);
    expect(selectedOffenders, selectedOffenders.join("\n")).toEqual([]);
  });
});

describe("CareerRat JSX styling boundary", () => {
  it("allows inline styles to set only reviewed dynamic measurements", () => {
    const allowedProperties = new Set([
      "--cf-fit-width",
      "--cf-pipeline-width",
      "--cf-progress-width",
      "--cf-runtime-font-size",
      "--cf-runtime-scale",
      "--cf-runtime-size",
    ]);
    const jsxFiles = sourceFiles.filter(
      (path) => extname(path) === ".jsx" && !path.endsWith(".test.jsx")
    );
    const styleObjects = jsxFiles.flatMap((path) => {
      const source = readFileSync(path, "utf8");
      return [...source.matchAll(/style=\{\{([\s\S]*?)\}\}/g)].map((match) => ({
        file: fileLabel(path),
        body: match[1],
      }));
    });

    expect(styleObjects.length).toBeGreaterThan(0);
    for (const { file, body } of styleObjects) {
      const keys = [...body.matchAll(/(?:^|,)\s*(["'][^"']+["']|[$\w]+)\s*:/g)].map((match) =>
        match[1].replace(/^["']|["']$/g, "")
      );
      expect(keys.length, `${file}: ${body}`).toBeGreaterThan(0);
      expect(
        keys.filter((key) => !allowedProperties.has(key)),
        `${file}: ${body}`
      ).toEqual([]);
    }
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
    const hasFigtreeFamily =
      foundationProperties.get("--font") === '"Figtree", system-ui, sans-serif';

    expect({ importedWeights, hasFigtreeFamily }).toEqual({
      importedWeights: ["400", "500", "600", "700", "800"],
      hasFigtreeFamily: true,
    });
  });

  it("uses Figtree as the only interface family", () => {
    const offenders = declarations
      .filter(
        ({ property, value }) =>
          property === "font-family" &&
          value !== "inherit" &&
          value !== "var(--font)" &&
          !/^"Figtree"\s*,\s*system-ui\s*,\s*sans-serif$/.test(value)
      )
      .map(({ file, line, value }) => `${file}:${line}: font-family: ${value}`);

    expect(offenders, offenders.join("\n")).toEqual([]);
  });

  it("does not impose a global line height over prototype controls and dense cards", () => {
    const foundationCss = stripCssComments(readFileSync(foundationPath, "utf8"));
    const bodyRule = foundationCss.match(/body\s*\{([^}]*)\}/)?.[1] || "";

    expect(bodyRule).not.toMatch(/line-height\s*:/);
  });

  it("does not reference the retired Fraunces font anywhere in web source", () => {
    const offenders = textOccurrences(sourceFiles, /Fraunces/i);

    expect(offenders, offenders.join("\n")).toEqual([]);
  });
});

describe("CareerRat card edges", () => {
  it("keeps the full-page artifact preview on the chat-first shape system", () => {
    const foundationCss = stripCssComments(readFileSync(foundationPath, "utf8"));

    expect(foundationCss).toMatch(/\.icon-btn\s*\{[^}]*border-radius:\s*50%/s);
    expect(foundationCss).toMatch(/\.packet-viewer\s*\{[^}]*border-radius:\s*22px/s);
    expect(foundationCss).toMatch(
      /\.packet-viewer__stage\s*\{[^}]*border:\s*1\.5px solid[^}]*border-radius:\s*14px/s
    );
  });

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
