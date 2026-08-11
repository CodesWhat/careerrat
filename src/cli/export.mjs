#!/usr/bin/env node
// CareerRat export CLI — render a tailored artifact or interview packet to PDF or DOCX.
//
// Usage:
//   careerrat export <input.md> [--pdf] [--docx] [--out <path-or-basename>] [--title "..."]
//   careerrat export --help
//
// Default format: --pdf (when neither --pdf nor --docx is given).
// Output location: alongside the input file (same dir + basename) unless --out is set.
// PDF uses the bundled Playwright Chromium — no setup needed.
// DOCX uses pandoc, soffice, or built-in OOXML fallback (auto-detected).
import { existsSync, readFileSync } from "node:fs";
import { basename, dirname, extname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";

import { detectDocxCapability, exportArtifact } from "../core/documents/export.mjs";

const root = join(fileURLToPath(new URL("../..", import.meta.url)));
const args = process.argv.slice(2);

if (args.includes("--help") || args.includes("-h") || args.length === 0) {
  printHelp();
  process.exit(args.length === 0 ? 1 : 0);
}

// --- Parse args ---

const positional = args.filter((a) => !a.startsWith("-"));
const inputArg = positional[0];

if (!inputArg) {
  console.error("Provide an input markdown file path. See: careerrat export --help");
  process.exit(1);
}

const wantPdf = args.includes("--pdf");
const wantDocx = args.includes("--docx");
const wantAts = args.includes("--ats");
const formats = [];
if (wantPdf) formats.push("pdf");
if (wantDocx) formats.push("docx");
if (formats.length === 0) formats.push("pdf"); // default

// --out <path-or-basename>
const outIdx = args.indexOf("--out");
const outArg = outIdx !== -1 ? args[outIdx + 1] : null;

// --title "..."
const titleIdx = args.indexOf("--title");
const titleArg = titleIdx !== -1 ? args[titleIdx + 1] : null;

// --- Resolve input path ---

let inputPath = isAbsolute(inputArg) ? inputArg : join(process.cwd(), inputArg);
if (!existsSync(inputPath)) {
  // Try repo-root-relative as a convenience
  const repoRel = join(root, inputArg);
  if (existsSync(repoRel)) {
    inputPath = repoRel;
  } else {
    console.error(`Input file not found:\n  ${inputPath}\n  ${repoRel}`);
    process.exit(1);
  }
}

const markdown = readFileSync(inputPath, "utf8");

// --- Derive output base ---

const inputDir = dirname(inputPath);
const inputBase = basename(inputPath, extname(inputPath));

let outBase;
if (outArg) {
  // If --out is an absolute path or contains a directory separator, use as-is (strip any extension)
  const rawOut = isAbsolute(outArg) ? outArg : join(process.cwd(), outArg);
  // Strip known extensions so we get a clean basename
  outBase = rawOut.replace(/\.(pdf|docx|md|txt)$/i, "");
} else {
  outBase = join(inputDir, inputBase);
}

// --- Derive title ---

const title = titleArg || inputBase.replace(/[-_]/g, " ");

// --- If docx, report which tool will be used ---

if (formats.includes("docx")) {
  const cap = detectDocxCapability();
  console.log(`DOCX tool: ${cap.label}`);
}

// --- Export ---

let result;
try {
  result = await exportArtifact({ markdown, outBase, formats, title, ats: wantAts });
} catch (err) {
  console.error(`Export failed: ${err.message}`);
  if (/Chromium not found/.test(err.message)) {
    console.error("Run: npx playwright install chromium");
  }
  process.exit(1);
}

// --- Report results ---

if (result.pdf) {
  console.log(`PDF  → ${result.pdf}`);
}
if (result.docx) {
  console.log(`DOCX → ${result.docx}  (${result.docxLabel})`);
}

// ---------------------------------------------------------------------------

function printHelp() {
  console.log(`careerrat export — render a tailored artifact or interview packet to PDF or DOCX

Usage:
  careerrat export <input.md> [--pdf] [--docx] [--out <base>] [--title "..."]

Options:
  --pdf          Render to PDF (default when no format flag given)
  --docx         Render to DOCX (pandoc → soffice → built-in OOXML fallback)
  --ats          PDF: use a standard ATS-safe font stack (Arial/Helvetica/Courier),
                 no embedded Geist — for the copy that goes through an ATS parser
  --out <base>   Output path/basename without extension (default: alongside input)
  --title "..."  Document title (default: input filename stem)
  --help         Show this message

Examples:
  careerrat export workspace/tailored/Acme-Engineer.md --pdf
  careerrat export workspace/tailored/Acme-Engineer.md --pdf --ats   # ATS submission copy
  careerrat export workspace/tailored/Acme-Engineer.md --pdf --docx
  careerrat export workspace/interview-prep/acme-engineer.md --pdf --out /tmp/packet

Exit codes: 0 success, 1 failure.
PDF: uses the bundled Playwright Chromium — no setup needed.
DOCX: auto-detects pandoc, then soffice, then uses built-in OOXML writer.`);
}
