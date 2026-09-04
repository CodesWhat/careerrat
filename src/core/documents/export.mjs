// export.mjs — render tailored artifacts (resume, cover letter, packet) to
// PDF, DOCX, or plain text. PDF via Playwright Chromium; DOCX via pandoc →
// soffice → hand-rolled OOXML, detected in that priority order; plain text
// via renderResumeText, built on the same block/run content model as DOCX.
// Preview fragments are sanitized server-side.

import { spawnSync } from "node:child_process";
import { readFileSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { deflateRawSync } from "node:zlib";
import sanitizeHtml from "sanitize-html";

const repoRoot = join(fileURLToPath(new URL("../../..", import.meta.url)));
const ARTIFACT_HTML_TAGS = [
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "p",
  "strong",
  "em",
  "code",
  "a",
  "span",
  "ul",
  "ol",
  "li",
  "hr",
  "pre",
  "table",
  "thead",
  "tbody",
  "tr",
  "th",
  "td",
  "blockquote",
  "br",
];

function safeArtifactHref(value) {
  const href = String(value || "").trim();
  const hasAsciiControl = [...href].some((char) => {
    const code = char.charCodeAt(0);
    return code <= 0x1f || code === 0x7f;
  });
  if (!href || href.startsWith("//") || hasAsciiControl) return null;

  const colon = href.indexOf(":");
  if (colon === 0) return null;
  if (colon > 0) {
    const scheme = href.slice(0, colon);
    // Reject encoded/entity/whitespace-obfuscated schemes before URL parsing;
    // browsers normalize several of these into executable protocols.
    if (/[%&\s]/.test(scheme) || !/^[a-z][a-z\d+.-]*$/i.test(scheme)) return null;
    if (!["http", "https", "mailto"].includes(scheme.toLowerCase())) return null;
    try {
      const parsed = new URL(href);
      if (!parsed.protocol) return null;
    } catch {
      return null;
    }
    return href;
  }

  if (href.includes("://")) return null;
  try {
    new URL(href, "https://careerrat.invalid/");
    return href;
  } catch {
    return null;
  }
}

function artifactAnchorTransform(_tagName, attributes) {
  const href = safeArtifactHref(attributes?.href);
  if (!href) return { tagName: "span", attribs: {} };
  if (/^https?:/i.test(href)) {
    return {
      tagName: "a",
      attribs: { href, target: "_blank", rel: "noopener noreferrer" },
    };
  }
  return { tagName: "a", attribs: { href } };
}

export function sanitizeArtifactHtml(html) {
  return sanitizeHtml(String(html || ""), {
    allowedTags: ARTIFACT_HTML_TAGS,
    allowedAttributes: { a: ["href", "target", "rel"] },
    allowedSchemes: ["http", "https", "mailto"],
    allowProtocolRelative: false,
    disallowedTagsMode: "discard",
    transformTags: { a: artifactAnchorTransform },
  });
}

// ---------------------------------------------------------------------------
// normalizeDocumentText / normalizeAtsText — scrub typographic glyphs before export
// ---------------------------------------------------------------------------

/**
 * Normalize typographic glyphs that LLM-generated markdown commonly produces
 * to their plain-text equivalents, regardless of export destination.
 *
 * Conservative: only the specific glyphs listed below are transformed.
 *
 * | Glyph        | Codepoint | Replacement          |
 * |--------------|-----------|----------------------|
 * | em dash (—)  | U+2014    | hyphen-minus (-)     |
 * | en dash (–)  | U+2013    | hyphen-minus (-)     |
 * | left dquote (“) | U+201C | straight dquote (")  |
 * | right dquote (”) | U+201D | straight dquote (") |
 * | left squote (‘) | U+2018 | straight squote (')  |
 * | right squote (’) | U+2019 | straight squote (') |
 * | NBSP         | U+00A0    | regular space        |
 * | zero-width space/non-joiner/joiner/BOM (U+200B/200C/200D/FEFF) | removed |
 *
 * @param {string} text
 * @returns {string}
 */
export function normalizeDocumentText(text) {
  return text
    .replace(/[—–]/g, "-") // em / en dash -> hyphen
    .replace(/[“”]/g, '"') // curly double quotes -> straight
    .replace(/[‘’]/g, "'") // curly single quotes -> straight
    .replace(/ /g, " ") // non-breaking space -> regular space
    .replace(/​|‌|‍|﻿/g, ""); // zero-width chars -> removed
}

/**
 * Normalize markdown for ATS submission copies: everything
 * normalizeDocumentText does, plus stripping characters used to spoof
 * displayed text or smuggle hidden content past ATS parsers and human
 * reviewers, the channels that matter in a submission copy rather than
 * ordinary typography.
 *
 * | Glyph        | Codepoint | Reason removed |
 * |--------------|-----------|-----------------|
 * | soft hyphen, word joiner, Mongolian vowel separator (U+00AD, U+2060, U+180E) | invisible formatting characters that can hide injected text |
 * | bidi controls (U+061C, U+200E, U+200F, U+202A-U+202E, U+2066-U+2069, matched via \p{Bidi_Control}) | can reorder displayed text to disguise what a parser actually reads |
 * | variation selectors (U+FE00-U+FE0F, U+E0100-U+E01EF) | can be chained onto visible characters to encode hidden data |
 * | Unicode tag characters (U+E0000-U+E007F) | invisible-text smuggling channel |
 *
 * @param {string} text
 * @returns {string}
 */
export function normalizeAtsText(text) {
  return normalizeDocumentText(text).replace(
    /\p{Bidi_Control}|[\u00AD\u2060\u180E]|[\uFE00-\uFE0F]|[\u{E0000}-\u{E007F}]|[\u{E0100}-\u{E01EF}]/gu,
    ""
  ); // bidi controls, word joiner, soft hyphen, Mongolian vowel separator, variation selectors, tag chars -> removed
}

// ---------------------------------------------------------------------------
// Pipe-table detection: shared by markdownToHtml, the DOCX block parser
// below, and validateAtsSafe (tailor.mjs), so all three agree on what counts
// as a GFM table. Outer pipes are optional (`Col A | Col B` is a table row
// just as `| Col A | Col B |` is), matching what GitHub-flavored Markdown
// actually renders.
// ---------------------------------------------------------------------------

/**
 * Count the run of consecutive backslashes in `str` ending immediately
 * before `index` (exclusive). Used to decide whether a pipe is escaped: an
 * odd-length run means the last backslash escapes the pipe (the rest pair
 * off), an even-length run (including zero) means the backslashes only
 * escape each other and the pipe is a real delimiter.
 *
 * @param {string} str
 * @param {number} index
 * @returns {number}
 */
function backslashRunLengthBefore(str, index) {
  let count = 0;
  let i = index - 1;
  while (i >= 0 && str[i] === "\\") {
    count++;
    i--;
  }
  return count;
}

/**
 * Split a pipe-table row into trimmed cell strings. Outer pipes are optional.
 * Escape-aware: a backslash-escaped pipe (`\|`) is a literal pipe inside a
 * cell, not a column separator, and the backslash is removed from the
 * output cell text. Escaping follows backslash-run parity — `\|` escapes,
 * `\\|` does not (the two backslashes escape each other), `\\\|` escapes
 * again — for both internal pipes and the optional outer trailing pipe.
 *
 * @param {string} line
 * @returns {string[]}
 */
function splitPipeRow(line) {
  const s = line.trim();
  const hasOuterLeading = s.startsWith("|");
  let inner = hasOuterLeading ? s.slice(1) : s;
  const hasOuterTrailing =
    inner.endsWith("|") && backslashRunLengthBefore(inner, inner.length - 1) % 2 === 0;
  if (hasOuterTrailing) inner = inner.slice(0, -1);

  const cells = [];
  let current = "";
  for (let i = 0; i < inner.length; i++) {
    const ch = inner[i];
    if (ch === "\\" && inner[i + 1] === "|" && backslashRunLengthBefore(inner, i + 1) % 2 === 1) {
      current += "|";
      i++;
    } else if (ch === "|") {
      cells.push(current.trim());
      current = "";
    } else {
      current += ch;
    }
  }
  cells.push(current.trim());
  return cells;
}

/**
 * Whether a row's cells form a pipe-table delimiter row (`---`, `:--`, `--:`, `:-:`).
 *
 * @param {string[]} cells
 * @returns {boolean}
 */
function isPipeTableDelimRow(cells) {
  return cells.length > 0 && cells.every((c) => /^:?-+:?$/.test(c));
}

/**
 * Whether `markdown` contains at least one GFM pipe table: a line with a `|`
 * immediately followed by a valid delimiter row. Mirrors the exact condition
 * markdownToHtml and the DOCX block parser use to start rendering a table, so
 * a table that renders is always a table validateAtsSafe can see too.
 *
 * @param {string} markdown
 * @returns {boolean}
 */
export function containsPipeTable(markdown) {
  const lines = String(markdown ?? "").split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!/\|/.test(line)) continue;
    const headerCells = splitPipeRow(line);
    const delimCells = splitPipeRow(lines[i + 1] || "");
    if (headerCells.length >= 2 && isPipeTableDelimRow(delimCells)) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// markdownToHtml
// ---------------------------------------------------------------------------

/**
 * Convert a résumé/cover-letter/packet markdown string to an HTML fragment.
 * Covers the constructs these artifacts actually use:
 *   - ATX headings (#..######)
 *   - **bold**, *italic*, _italic_
 *   - unordered lists (- / *)
 *   - ordered lists (1. 2. ...)
 *   - [text](url) links
 *   - horizontal rules (--- / *** / ___ on their own line)
 *   - inline `code`
 *   - blank-line paragraph breaks
 *   - GitHub-style pipe tables (| col | col |)
 *   - blockquotes (> text)
 *   - hard line breaks (two trailing spaces)
 *
 * HTML special chars in text content are escaped before any inline parsing.
 *
 * @param {string} markdown
 * @returns {string} HTML fragment (no <html>/<body> wrapper)
 */
export function markdownToHtml(markdown) {
  const lines = markdown.split(/\r?\n/);
  const out = [];
  const listStack = []; // stack of { type: 'ul'|'ol', indent: number }
  let inPara = false;
  let pendingBlank = false;

  const escHtml = (s) =>
    s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

  const closeOpenPara = () => {
    if (inPara) {
      out.push("</p>");
      inPara = false;
    }
  };

  const closeAllLists = () => {
    while (listStack.length > 0) {
      const top = listStack.pop();
      out.push(`</${top.type}>`);
    }
  };

  // Inline parsing: bold, italic, code, links (order matters)
  const parseInline = (raw) => {
    // Escape HTML first
    let s = escHtml(raw);
    // Inline code (backtick) — protect from further replacements
    const codeSlots = [];
    s = s.replace(/`([^`]+)`/g, (_, inner) => {
      codeSlots.push(`<code>${inner}</code>`);
      return `\x00CODE${codeSlots.length - 1}\x00`;
    });
    // Links [text](url) — text already html-escaped, url we escape separately
    s = s.replace(/\[([^\]]*)\]\(([^)]*)\)/g, (_, text, href) => {
      const safeHref = safeArtifactHref(href);
      if (!safeHref) return text;
      const escapedHref = safeHref.replace(/"/g, "&quot;");
      if (/^https?:/i.test(safeHref)) {
        return `<a href="${escapedHref}" target="_blank" rel="noopener noreferrer">${text}</a>`;
      }
      return `<a href="${escapedHref}">${text}</a>`;
    });
    // Bold **text** or __text__
    s = s.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
    s = s.replace(/__([^_]+)__/g, "<strong>$1</strong>");
    // Italic *text* or _text_  (single, not double)
    s = s.replace(/\*([^*]+)\*/g, "<em>$1</em>");
    s = s.replace(/_([^_]+)_/g, "<em>$1</em>");
    // Restore code slots
    // biome-ignore lint/suspicious/noControlCharactersInRegex: \x00 is intentionally used as a sentinel delimiter for inline-code slot placeholders — it cannot appear in normal text
    s = s.replace(/\x00CODE(\d+)\x00/g, (_, i) => codeSlots[Number(i)]);
    return s;
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // --- Fenced code block (``` or ~~~) — preserve whitespace, no inline parsing ---
    const fenceMatch = line.match(/^(\s*)(`{3,}|~{3,})(.*)$/);
    if (fenceMatch) {
      closeOpenPara();
      closeAllLists();
      const fenceChar = fenceMatch[2][0];
      const fenceLen = fenceMatch[2].length;
      const codeLines = [];
      let j = i + 1;
      for (; j < lines.length; j++) {
        const closeMatch = lines[j].match(/^(\s*)(`{3,}|~{3,})\s*$/);
        if (closeMatch && closeMatch[2][0] === fenceChar && closeMatch[2].length >= fenceLen) {
          break;
        }
        codeLines.push(lines[j]);
      }
      i = j; // skip the closing fence (loop i++ advances past it); if unclosed, j === lines.length
      out.push(`<pre><code>${codeLines.map(escHtml).join("\n")}</code></pre>`);
      pendingBlank = false;
      continue;
    }

    // --- Blank line ---
    if (line.trim() === "") {
      closeOpenPara();
      pendingBlank = true;
      continue;
    }

    // --- ATX heading ---
    const headingMatch = line.match(/^(#{1,6})\s+(.*)/);
    if (headingMatch) {
      closeOpenPara();
      closeAllLists();
      const level = headingMatch[1].length;
      out.push(`<h${level}>${parseInline(headingMatch[2].trim())}</h${level}>`);
      pendingBlank = false;
      continue;
    }

    // --- Horizontal rule (---, ***, ___ alone on a line) ---
    if (/^(\s*[-*_]){3,}\s*$/.test(line)) {
      closeOpenPara();
      closeAllLists();
      out.push("<hr>");
      pendingBlank = false;
      continue;
    }

    // --- Unordered list item ---
    const ulMatch = line.match(/^(\s*)[-*]\s+(.*)/);
    if (ulMatch) {
      closeOpenPara();
      const indent = ulMatch[1].length;
      const content = parseInline(ulMatch[2]);
      // Close deeper lists
      while (listStack.length > 0 && listStack[listStack.length - 1].indent > indent) {
        out.push(`</${listStack.pop().type}>`);
      }
      if (listStack.length === 0 || listStack[listStack.length - 1].indent < indent) {
        out.push("<ul>");
        listStack.push({ type: "ul", indent });
      }
      out.push(`<li>${content}</li>`);
      pendingBlank = false;
      continue;
    }

    // --- Ordered list item ---
    const olMatch = line.match(/^(\s*)\d+\.\s+(.*)/);
    if (olMatch) {
      closeOpenPara();
      const indent = olMatch[1].length;
      const content = parseInline(olMatch[2]);
      while (listStack.length > 0 && listStack[listStack.length - 1].indent > indent) {
        out.push(`</${listStack.pop().type}>`);
      }
      if (listStack.length === 0 || listStack[listStack.length - 1].indent < indent) {
        out.push("<ol>");
        listStack.push({ type: "ol", indent });
      }
      out.push(`<li>${content}</li>`);
      pendingBlank = false;
      continue;
    }

    // --- Pipe table ---
    // A pipe-table starts when a pipe-row is immediately followed by a delimiter row.
    if (/\|/.test(line)) {
      const nextLine = lines[i + 1] || "";
      const headerCells = splitPipeRow(line);
      const delimCells = splitPipeRow(nextLine);
      if (headerCells.length >= 2 && isPipeTableDelimRow(delimCells)) {
        closeOpenPara();
        closeAllLists();
        // Consume header + delimiter
        i += 2;
        // Collect body rows
        const bodyRows = [];
        while (i < lines.length && /\|/.test(lines[i]) && lines[i].trim() !== "") {
          bodyRows.push(splitPipeRow(lines[i]));
          i++;
        }
        i--; // the for-loop will i++ again
        // Emit table
        const thCells = headerCells.map((c) => `<th>${parseInline(c)}</th>`).join("");
        out.push(`<table><thead><tr>${thCells}</tr></thead><tbody>`);
        for (const row of bodyRows) {
          const tdCells = row.map((c) => `<td>${parseInline(c)}</td>`).join("");
          out.push(`<tr>${tdCells}</tr>`);
        }
        out.push("</tbody></table>");
        pendingBlank = false;
        continue;
      }
    }

    // --- Blockquote ---
    if (/^>\s?/.test(line)) {
      closeOpenPara();
      closeAllLists();
      // Collect consecutive blockquote lines
      const bqLines = [];
      let j = i;
      while (j < lines.length && /^>\s?/.test(lines[j])) {
        bqLines.push(lines[j].replace(/^>\s?/, ""));
        j++;
      }
      i = j - 1; // consume all; for-loop will i++
      out.push(`<blockquote>${bqLines.map(parseInline).join(" ")}</blockquote>`);
      pendingBlank = false;
      continue;
    }

    // --- Regular text line (paragraph) ---
    closeAllLists();
    // Hard line break: line ends with two or more spaces
    const hardBreak = / {2,}$/.test(line);
    const lineText = parseInline(hardBreak ? line.replace(/ +$/, "") : line);
    if (!inPara) {
      out.push("<p>");
      inPara = true;
    } else if (!pendingBlank) {
      // Soft line break within a paragraph — emit a space or hard break
      out.push(hardBreak ? "<br>" : " ");
    }
    out.push(lineText);
    pendingBlank = false;
  }

  closeOpenPara();
  closeAllLists();

  return sanitizeArtifactHtml(out.join("\n"));
}

// ---------------------------------------------------------------------------
// fontFaceCss — build @font-face block with base64 fonts (graceful fallback)
// ---------------------------------------------------------------------------

function fontFaceCss() {
  // Geist (variable) is the shipped brand face; one woff2 carries the full weight
  // axis, so a single @font-face with a weight RANGE covers light→bold.
  const variants = [
    { file: "GeistVF.woff2", family: "Geist", weight: "100 900" },
    { file: "GeistMonoVF.woff2", family: "Geist Mono", weight: "100 900" },
  ];

  const rules = [];
  for (const { file, family, weight } of variants) {
    const fontPath = join(repoRoot, "assets", "fonts", file);
    let src;
    try {
      const b64 = readFileSync(fontPath).toString("base64");
      src = `url("data:font/woff2;base64,${b64}") format("woff2")`;
    } catch {
      // Font file missing — fall back to system sans-serif for this family
      continue;
    }
    rules.push(`@font-face {
  font-family: '${family}';
  font-weight: ${weight};
  font-style: normal;
  font-display: swap;
  src: ${src};
}`);
  }

  return rules.join("\n");
}

// ---------------------------------------------------------------------------
// documentHtml
// ---------------------------------------------------------------------------

/**
 * Wrap a markdown string in a complete <!doctype html> document with:
 * - embedded Geist @font-face (base64, graceful fallback) — brand copy
 * - editorial print stylesheet (Letter page, clean typography)
 *
 * @param {string} markdown
 * @param {{ title?: string, ats?: boolean }} opts
 *   ats: render the ATS-safe submission copy — no embedded webfont, just a
 *   standard widely-installed font stack. ATS résumé parsers extract text from
 *   a common system face (Arial/Helvetica/Courier) far more reliably than from
 *   an embedded variable brand font, so submission PDFs use this; the on-screen
 *   brand copy keeps Geist.
 * @returns {string} Complete HTML document string
 */
function documentHtml(markdown, { title = "Document", ats = false } = {}) {
  const body = markdownToHtml(markdown);
  const fontFaces = ats ? "" : fontFaceCss();
  const hasGeist = fontFaces.includes("'Geist'");
  const brandFont = ats
    ? "Arial, Helvetica, 'Liberation Sans', sans-serif"
    : hasGeist
      ? "'Geist', system-ui, -apple-system, sans-serif"
      : "system-ui, -apple-system, sans-serif";
  const monoFont = ats
    ? "'Courier New', Courier, monospace"
    : fontFaces.includes("'Geist Mono'")
      ? "'Geist Mono', ui-monospace, SFMono-Regular, monospace"
      : "ui-monospace, SFMono-Regular, monospace";

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title.replace(/</g, "&lt;").replace(/>/g, "&gt;")}</title>
<style>
${fontFaces}

*, *::before, *::after { box-sizing: border-box; }

:root {
  --font: ${brandFont};
  --mono: ${monoFont};
  --size-base: 10.25pt;
  --lh: 1.5;
  --ink: #1b2733;
  --muted: #61718a;
  --accent: #2d5f8a;
  --accent-deep: #1b3f63;
  --tint: #eef3f9;
  --tint-2: #f6f9fc;
  --rule: #d7e0ec;
  --margin: 0.8in;
}

@page {
  size: Letter;
  margin: var(--margin);
}

html {
  font-size: var(--size-base);
  line-height: var(--lh);
}

body {
  font-family: var(--font);
  font-weight: 400;
  color: var(--ink);
  background: #fff;
  max-width: 7.1in;
  margin: 0 auto;
  padding: 0;
  -webkit-print-color-adjust: exact;
  print-color-adjust: exact;
  font-variant-numeric: tabular-nums;
  font-feature-settings: "ss01", "cv01";
  letter-spacing: -0.003em;
}

/* --- Masthead (title + meta line) --- */
h1 {
  font-size: 2.15rem;
  font-weight: 700;
  color: var(--accent-deep);
  letter-spacing: -0.02em;
  line-height: 1.12;
  margin: 0 0 0.5rem;
  padding-bottom: 0.44rem;
  border-bottom: 3px solid var(--accent);
}
/* The meta paragraph that immediately follows the title */
h1 + p {
  color: var(--muted);
  font-size: 0.92em;
  line-height: 1.7;
  margin: 0.1rem 0 1.1rem;
}
h1 + p strong { color: var(--ink); font-weight: 600; }

/* --- Section headers --- */
h2 {
  font-size: 1.12rem;
  font-weight: 650;
  color: var(--accent-deep);
  letter-spacing: -0.01em;
  margin: 1.5em 0 0.5em;
  padding-bottom: 0.22em;
  border-bottom: 1px solid var(--rule);
  display: flex;
  align-items: center;
}
h2::before {
  content: "";
  display: inline-block;
  width: 0.42em;
  height: 0.95em;
  margin-right: 0.5em;
  background: var(--accent);
  border-radius: 1.5px;
  flex: none;
}
h3 { font-size: 1.02rem; font-weight: 640; color: var(--accent); margin: 1.05em 0 0.25em; }
h4, h5, h6 { font-size: 0.95rem; font-weight: 600; color: var(--ink); margin: 0.8em 0 0.2em; }

p { margin: 0 0 0.55em; }

ul { margin: 0 0 0.65em 0; padding-left: 1.25em; }
ol { margin: 0 0 0.65em 0; padding-left: 1.45em; }
li { margin: 0 0 0.32em; padding-left: 0.15em; }
li::marker { color: var(--accent); }
li > ul, li > ol { margin-top: 0.28em; margin-bottom: 0.12em; }

a { color: var(--accent); text-decoration: none; }

code {
  font-family: var(--mono);
  font-size: 0.86em;
  background: var(--tint);
  color: var(--accent-deep);
  padding: 0.08em 0.34em;
  border-radius: 3px;
}

/* --- Fenced code blocks (ASCII diagrams) — preserve every space, never wrap --- */
pre {
  font-family: var(--mono);
  font-size: 8pt;
  line-height: 1.32;
  white-space: pre;
  background: var(--tint-2);
  border: 1px solid var(--rule);
  border-radius: 4px;
  padding: 0.7em 0.85em;
  margin: 0.4em 0 0.95em;
  overflow-x: auto;
  tab-size: 2;
}
pre code {
  background: none;
  border-radius: 0;
  padding: 0;
  font-size: inherit;
  color: var(--ink);
  white-space: inherit;
}

hr { border: none; border-top: 1px solid var(--rule); margin: 1.15em 0; }

strong { font-weight: 660; color: var(--ink); }
em { font-style: italic; }

/* --- Tables --- */
table {
  width: 100%;
  border-collapse: collapse;
  margin: 0.35em 0 0.95em;
  font-size: 0.9em;
  border: 1px solid var(--rule);
}
thead th {
  background: var(--accent);
  color: #fff;
  font-weight: 600;
  text-align: left;
  letter-spacing: 0.005em;
}
th, td { border: 1px solid var(--rule); padding: 0.42em 0.6em; text-align: left; vertical-align: top; }
tbody tr:nth-child(even) { background: var(--tint-2); }

/* --- Callout (blockquote) --- */
blockquote {
  margin: 0.2em 0 0.85em;
  padding: 0.5em 0.85em;
  background: var(--tint);
  border-left: 3px solid var(--accent);
  border-radius: 0 4px 4px 0;
  color: var(--accent-deep);
  font-size: 0.92em;
}
blockquote p { margin: 0; }

@media print {
  body { max-width: 100%; }
  h1, h2, h3 { page-break-after: avoid; }
  li, tr { page-break-inside: avoid; }
  table, blockquote, pre { page-break-inside: avoid; }
  thead { display: table-header-group; }
}
</style>
</head>
<body>
${body}
</body>
</html>`;
}

// ---------------------------------------------------------------------------
// renderResumeText
// ---------------------------------------------------------------------------

/**
 * Collapse a run list into link groups: consecutive runs that share the
 * same href (including a shared absence of one) merge into a single
 * group's concatenated text. parseRuns stamps the same href onto every run
 * a formatted link label recurses into (e.g. `[Read **Example**
 * docs](url)` produces three runs — plain, bold, plain — all carrying the
 * same href), so flattening run-by-run would repeat the destination once
 * per run instead of once per link.
 *
 * @param {Array<{text: string, href?: string}>} runs
 * @returns {Array<{text: string, href?: string}>}
 */
function groupRunsByLink(runs) {
  const groups = [];
  for (const run of runs || []) {
    const href = run?.href || undefined;
    const text = String(run?.text || "");
    const last = groups[groups.length - 1];
    if (last && last.href === href) last.text += text;
    else groups.push({ href, text });
  }
  return groups;
}

/**
 * Flatten a run list (parseRuns output — the same inline model renderDocx
 * builds its WML from) to plain text. A link keeps its visible label and
 * appends the URL in parens once per link, after the label's final run, so
 * the destination survives losing markdown syntax without repeating per
 * formatting run; every other run type (bold/italic/code/plain) already
 * carries only its bare text.
 *
 * @param {Array<{text: string, href?: string}>} runs
 * @returns {string}
 */
function runsToPlainText(runs) {
  return groupRunsByLink(runs)
    .map(({ href, text }) => {
      if (href && href !== text) {
        return text ? `${text} (${href})` : href;
      }
      return text;
    })
    .join("");
}

/**
 * Same as runsToPlainText, but for heading text: uppercases each link
 * group's visible label only, and never the link destination. A link
 * destination can be case-sensitive (path or query string), so the URL
 * bytes must survive uppercasing untouched.
 *
 * @param {Array<{text: string, href?: string}>} runs
 * @returns {string}
 */
function headingRunsToPlainText(runs) {
  return groupRunsByLink(runs)
    .map(({ href, text }) => {
      if (href && href !== text) {
        const upperText = text.toUpperCase();
        return upperText ? `${upperText} (${href})` : href;
      }
      // Bare autolink (href === text): preserve the URL's own case.
      if (href) return text;
      return text.toUpperCase();
    })
    .join("");
}

/**
 * Strip a leading ATX heading marker (`#` through `######` followed by
 * whitespace, with up to 3 leading spaces) from a fenced-code-block line.
 * The whitespace after the marker may be spaces or tabs, matching the ATX
 * heading spec's own whitespace rule. Fenced content is otherwise copied
 * verbatim into the plain-text output, but a fenced line that looks exactly
 * like an ATX heading would leak as live heading syntax once the fence
 * markers themselves are dropped. This keeps the plain-text renderer's
 * no-heading-syntax contract intact while leaving every other character of
 * the line untouched.
 *
 * @param {string} line
 * @returns {string}
 */
function stripFencedAtxMarker(line) {
  const m = line.match(/^( {0,3})(#{1,6})([ \t]+)(.*)$/);
  return m ? `${m[1]}${m[4]}` : line;
}

/**
 * Render a résumé/cover-letter/packet markdown string to plain text for
 * application-form paste boxes and .txt downloads: no markdown syntax
 * (headings, bold, tables, backticks, pipes), UTF-8, no smart quotes or em
 * dashes, unwrapped lines (paste boxes reflow on their own). Sections are
 * separated by a single blank line, with headings rendered in uppercase.
 * Built on parseMdBlocks/parseRuns — the same content model renderDocx uses —
 * so section order always matches the DOCX and ATS PDF output for the same
 * markdown source.
 *
 * @param {string} markdown
 * @returns {string}
 */
export function renderResumeText(markdown) {
  const blocks = parseMdBlocks(normalizeAtsText(String(markdown ?? "")));
  const lines = [];
  let previousType = null;
  // Per-level ordered-list counters, indexed by depth. Reset in full
  // whenever a list run breaks (previousType !== "li"); entering a deeper
  // level resets that level's counter to its own start number, and
  // returning to a shallower level continues that level's counter from
  // where it left off, matching how nested numbered lists actually read.
  // listTypes tracks whether the active list at each depth is "ordered" or
  // "unordered", so a same-depth switch between the two (e.g. an ordered
  // list, an intervening bullet, then another ordered list) also resets
  // the counter instead of resuming a list that already ended.
  let listCounters = [];
  let listTypes = [];
  let lastListDepth = -1;

  function pushBlank() {
    if (lines.length > 0 && lines[lines.length - 1] !== "") lines.push("");
  }

  for (const block of blocks) {
    if (block.type === "heading") {
      pushBlank();
      lines.push(headingRunsToPlainText(block.runs));
      pushBlank();
    } else if (block.type === "para") {
      if (previousType === "para" || previousType === "li" || previousType === "blockquote") {
        pushBlank();
      }
      lines.push(runsToPlainText(block.runs));
    } else if (block.type === "li") {
      if (previousType !== "li") {
        pushBlank();
        listCounters = [];
        listTypes = [];
        lastListDepth = -1;
      }
      const depth = block.depth || 0;
      const indent = "  ".repeat(depth);
      let prefix = "- ";
      if (block.ordered) {
        const isNewListAtDepth =
          depth > lastListDepth ||
          listCounters[depth] === undefined ||
          listTypes[depth] !== "ordered";
        listCounters[depth] = isNewListAtDepth ? (block.start ?? 1) : listCounters[depth] + 1;
        listTypes[depth] = "ordered";
        prefix = `${listCounters[depth]}. `;
      } else {
        listTypes[depth] = "unordered";
      }
      lastListDepth = depth;
      lines.push(`${indent}${prefix}${runsToPlainText(block.runs)}`);
    } else if (block.type === "blockquote") {
      pushBlank();
      lines.push(runsToPlainText(block.runs));
    } else if (block.type === "table") {
      pushBlank();
      lines.push(block.headers.map(runsToPlainText).join("   "));
      for (const row of block.rows) lines.push(row.map(runsToPlainText).join("   "));
    } else if (block.type === "codeblock") {
      pushBlank();
      for (const codeLine of block.lines) lines.push(stripFencedAtxMarker(codeLine));
    } else if (block.type === "hr") {
      pushBlank();
    }
    previousType = block.type;
  }

  while (lines.length > 0 && lines[0] === "") lines.shift();
  while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// renderPdf
// ---------------------------------------------------------------------------

/**
 * Render markdown (or pre-built HTML) to a Letter-size PDF via Playwright Chromium.
 * Always closes the browser, even on error.
 *
 * @param {{ markdown?: string, html?: string, outPath: string, title?: string, ats?: boolean, env?: NodeJS.ProcessEnv|Record<string,string>, fetchImpl?: typeof fetch }} opts
 *   ats: use the ATS-safe standard font stack (no embedded Geist) for submission copies.
 * @returns {Promise<string>} outPath
 * @throws when neither Electron's authenticated renderer nor Playwright Chromium is available
 */
export async function renderPdf({
  markdown,
  html,
  outPath,
  title = "Document",
  ats = false,
  env = process.env,
  fetchImpl = globalThis.fetch,
}) {
  // Normalize typographic glyphs on the markdown path so text extraction
  // isn't corrupted by smart quotes / dashes / invisible chars from LLM output.
  // ATS submission copies additionally strip bidi/hidden-text channels;
  // non-ATS copies (interview dossiers, etc.) keep legitimate non-ASCII text.
  // When the caller supplies pre-built HTML, normalization is their responsibility.
  const source =
    html ||
    documentHtml((ats ? normalizeAtsText : normalizeDocumentText)(markdown || ""), {
      title,
      ats,
    });

  const desktopRenderer = desktopPdfRendererConfig(env);
  if (desktopRenderer) {
    const response = await fetchImpl(desktopRenderer.url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-careerrat-render-token": desktopRenderer.token,
      },
      body: JSON.stringify({ html: source }),
    });
    if (!response.ok) {
      const detail = (await response.text().catch(() => "")).trim();
      const err = new Error(
        `Desktop PDF renderer failed (${response.status})${detail ? `: ${detail}` : ""}`
      );
      err.code = "DESKTOP_PDF_RENDERER_UNAVAILABLE";
      throw err;
    }
    const pdf = Buffer.from(await response.arrayBuffer());
    if (pdf.length < 8 || !pdf.subarray(0, 5).equals(Buffer.from("%PDF-"))) {
      const err = new Error("Desktop PDF renderer returned an invalid PDF response");
      err.code = "DESKTOP_PDF_RENDERER_INVALID";
      throw err;
    }
    writeFileSync(outPath, pdf);
    return outPath;
  }

  let chromium;
  try {
    ({ chromium } = await import("playwright"));
  } catch {
    throw new Error("playwright not found. Install it: npm install --save-dev playwright");
  }

  let browser;
  try {
    browser = await chromium.launch();
    const page = await browser.newPage();
    await page.setContent(source, { waitUntil: "networkidle" });
    await page.pdf({
      path: outPath,
      format: "Letter",
      printBackground: true,
      margin: { top: "0.9in", bottom: "0.9in", left: "0.9in", right: "0.9in" },
    });
  } catch (err) {
    if (/Executable doesn't exist|browserType\.launch|Failed to launch/.test(err.message)) {
      throw new Error(
        `Chromium not found. Run: npx playwright install chromium\n(Original: ${err.message})`
      );
    }
    throw err;
  } finally {
    if (browser) await browser.close();
  }

  return outPath;
}

function desktopPdfRendererConfig(env) {
  const rawUrl = String(env.CAREERRAT_DESKTOP_PDF_RENDER_URL || "").trim();
  const token = String(env.CAREERRAT_DESKTOP_PDF_RENDER_TOKEN || "").trim();
  if (!rawUrl && !token) return null;
  if (!rawUrl || !token) {
    const err = new Error("Desktop PDF renderer configuration is incomplete");
    err.code = "DESKTOP_PDF_RENDERER_UNAVAILABLE";
    throw err;
  }

  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    const err = new Error("Desktop PDF renderer URL is invalid");
    err.code = "DESKTOP_PDF_RENDERER_UNAVAILABLE";
    throw err;
  }
  if (
    url.protocol !== "http:" ||
    !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) ||
    url.pathname !== "/render"
  ) {
    const err = new Error("Desktop PDF renderer must use the loopback /render endpoint");
    err.code = "DESKTOP_PDF_RENDERER_UNAVAILABLE";
    throw err;
  }
  return { url: url.href, token };
}

// ---------------------------------------------------------------------------
// detectDocxCapability
// ---------------------------------------------------------------------------

/**
 * Probe for DOCX conversion tools in priority order: pandoc → soffice → ooxml (built-in).
 *
 * @returns {{ tool: 'pandoc'|'soffice'|'ooxml', label: string }}
 */
export function detectDocxCapability() {
  // Try pandoc
  try {
    const res = spawnSync("pandoc", ["--version"], { encoding: "utf8" });
    if (res.status === 0 && res.stdout) {
      const ver = (res.stdout.match(/pandoc\s+([\d.]+)/) || [])[1] || "";
      return { tool: "pandoc", label: `pandoc ${ver}`.trim() };
    }
  } catch {
    // not on PATH
  }

  // Try soffice (LibreOffice)
  try {
    const res = spawnSync("soffice", ["--version"], { encoding: "utf8" });
    if (res.status === 0 && res.stdout) {
      const ver = (res.stdout.match(/LibreOffice\s+([\d.]+)/) || [])[1] || "";
      return { tool: "soffice", label: `LibreOffice soffice ${ver}`.trim() };
    }
  } catch {
    // not on PATH
  }

  return { tool: "ooxml", label: "built-in OOXML writer (no pandoc/soffice detected)" };
}

// ---------------------------------------------------------------------------
// renderDocx — dispatches to detected tool
// ---------------------------------------------------------------------------

/**
 * Render markdown to DOCX using the best available tool.
 * pandoc: direct conversion; soffice: via intermediate HTML; ooxml: hand-rolled.
 *
 * @param {{ markdown: string, outPath: string, title?: string, ats?: boolean }} opts
 *   ats: strip bidi/hidden-text channels from the markdown before dispatching
 *   to any backend, for ATS submission copies.
 * @returns {Promise<{ outPath: string, tool: string, label: string }>}
 */
async function renderDocx({ markdown, outPath, title = "Document", ats = false }) {
  const cap = detectDocxCapability();
  const source = (ats ? normalizeAtsText : normalizeDocumentText)(markdown);

  if (cap.tool === "pandoc") {
    await renderDocxViaPandoc({ markdown: source, outPath, title });
  } else if (cap.tool === "soffice") {
    await renderDocxViaSoffice({ markdown: source, outPath, title });
  } else {
    await renderDocxOoxml({ markdown: source, outPath, title });
  }

  return { outPath, tool: cap.tool, label: cap.label };
}

// --- pandoc path ---

/**
 * Build a minimal reference.docx for pandoc with Helvetica font, all-black text,
 * and tight spacing — mirrors build-docx.py make_reference() logic in pure JS.
 * Uses the same buildZip/buildStylesXml helpers already in this file.
 */
function makeReferenceDoc(dst) {
  const themeXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" name="Office Theme">
  <a:themeElements>
    <a:clrScheme name="Office">
      <a:dk1><a:sysClr lastClr="000000" val="windowText"/></a:dk1>
      <a:lt1><a:sysClr lastClr="ffffff" val="window"/></a:lt1>
      <a:dk2><a:srgbClr val="44546A"/></a:dk2>
      <a:lt2><a:srgbClr val="E7E6E6"/></a:lt2>
      <a:accent1><a:srgbClr val="4472C4"/></a:accent1>
      <a:accent2><a:srgbClr val="ED7D31"/></a:accent2>
      <a:accent3><a:srgbClr val="A9D18E"/></a:accent3>
      <a:accent4><a:srgbClr val="FFC000"/></a:accent4>
      <a:accent5><a:srgbClr val="5A96B4"/></a:accent5>
      <a:accent6><a:srgbClr val="70AD47"/></a:accent6>
      <a:hlink><a:srgbClr val="0563C1"/></a:hlink>
      <a:folHlink><a:srgbClr val="954F72"/></a:folHlink>
    </a:clrScheme>
    <a:fontScheme name="Office">
      <a:majorFont><a:latin typeface="Helvetica"/><a:ea typeface=""/><a:cs typeface=""/></a:majorFont>
      <a:minorFont><a:latin typeface="Helvetica"/><a:ea typeface=""/><a:cs typeface=""/></a:minorFont>
    </a:fontScheme>
    <a:fmtScheme name="Office">
      <a:fillStyleLst>
        <a:solidFill><a:schemeClr val="phClr"/></a:solidFill>
        <a:gradFill rotWithShape="1"><a:gsLst><a:gs pos="0"><a:schemeClr val="phClr"><a:lumMod val="110000"/><a:satMod val="105000"/><a:tint val="67000"/></a:schemeClr></a:gs><a:gs pos="100000"><a:schemeClr val="phClr"><a:lumMod val="105000"/><a:satMod val="109000"/><a:tint val="81000"/></a:schemeClr></a:gs></a:gsLst><a:lin ang="5400000" scaled="0"/></a:gradFill>
        <a:gradFill rotWithShape="1"><a:gsLst><a:gs pos="0"><a:schemeClr val="phClr"><a:satMod val="103000"/><a:lumMod val="102000"/><a:tint val="94000"/></a:schemeClr></a:gs><a:gs pos="100000"><a:schemeClr val="phClr"><a:lumMod val="99000"/><a:satMod val="120000"/><a:shade val="78000"/></a:schemeClr></a:gs></a:gsLst><a:lin ang="5400000" scaled="0"/></a:gradFill>
      </a:fillStyleLst>
      <a:lnStyleLst>
        <a:ln w="6350" cap="flat" cmpd="sng" algn="ctr"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:prstDash val="solid"/><a:miter lim="800000"/></a:ln>
        <a:ln w="12700" cap="flat" cmpd="sng" algn="ctr"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:prstDash val="solid"/><a:miter lim="800000"/></a:ln>
        <a:ln w="19050" cap="flat" cmpd="sng" algn="ctr"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:prstDash val="solid"/><a:miter lim="800000"/></a:ln>
      </a:lnStyleLst>
      <a:effectStyleLst>
        <a:effectStyle><a:effectLst/></a:effectStyle>
        <a:effectStyle><a:effectLst/></a:effectStyle>
        <a:effectStyle><a:effectLst><a:outerShdw blurRad="57150" dist="19050" dir="5400000" algn="ctr" rotWithShape="0"><a:srgbClr val="000000"><a:alpha val="63000"/></a:srgbClr></a:outerShdw></a:effectLst></a:effectStyle>
      </a:effectStyleLst>
      <a:bgFillStyleLst>
        <a:solidFill><a:schemeClr val="phClr"/></a:solidFill>
        <a:solidFill><a:schemeClr val="phClr"><a:tint val="95000"/><a:satMod val="170000"/></a:schemeClr></a:solidFill>
        <a:gradFill rotWithShape="1"><a:gsLst><a:gs pos="0"><a:schemeClr val="phClr"><a:tint val="93000"/><a:satMod val="150000"/><a:shade val="98000"/><a:lumMod val="102000"/></a:schemeClr></a:gs><a:gs pos="100000"><a:schemeClr val="phClr"><a:shade val="63000"/><a:satMod val="120000"/></a:schemeClr></a:gs></a:gsLst><a:lin ang="5400000" scaled="0"/></a:gradFill>
      </a:bgFillStyleLst>
    </a:fmtScheme>
  </a:themeElements>
</a:theme>`;

  const documentXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body>
    <w:sectPr>
      <w:pgSz w:w="12240" w:h="15840"/>
      <w:pgMar w:top="720" w:right="1080" w:bottom="720" w:left="1080" w:header="432" w:footer="432" w:gutter="0"/>
    </w:sectPr>
  </w:body>
</w:document>`;

  const contentTypes = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
  <Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>
  <Override PartName="/word/theme/theme1.xml" ContentType="application/vnd.openxmlformats-officedocument.theme+xml"/>
</Types>`;

  const relsRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`;

  const docRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
  <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/theme" Target="theme/theme1.xml"/>
</Relationships>`;

  const entries = [
    { name: "[Content_Types].xml", content: contentTypes },
    { name: "_rels/.rels", content: relsRels },
    { name: "word/_rels/document.xml.rels", content: docRels },
    { name: "word/document.xml", content: documentXml },
    { name: "word/styles.xml", content: buildStylesXml() },
    { name: "word/theme/theme1.xml", content: themeXml },
  ];

  writeFileSync(dst, buildZip(entries));
}

async function renderDocxViaPandoc({ markdown, outPath, title }) {
  const tmp = join(tmpdir(), `careerrat-export-${Date.now()}.md`);
  const refDoc = join(tmpdir(), `careerrat-ref-${Date.now()}.docx`);
  writeFileSync(tmp, markdown, "utf8");
  makeReferenceDoc(refDoc);

  const res = spawnSync(
    "pandoc",
    [
      tmp,
      "-f",
      "markdown",
      "-o",
      outPath,
      "--reference-doc",
      refDoc,
      "--metadata",
      `title=${title}`,
    ],
    { encoding: "utf8" }
  );

  // clean up temp files
  try {
    import("node:fs").then(({ unlinkSync }) => {
      try {
        unlinkSync(tmp);
      } catch {
        /* ok */
      }
      try {
        unlinkSync(refDoc);
      } catch {
        /* ok */
      }
    });
  } catch {
    /* ok */
  }

  if (res.status !== 0) {
    throw new Error(`pandoc failed (exit ${res.status}): ${res.stderr || res.stdout || ""}`);
  }
}

// --- soffice path ---

async function renderDocxViaSoffice({ markdown, outPath, title }) {
  const tmp = join(tmpdir(), `careerrat-export-${Date.now()}.html`);
  const tmpDocx = tmp.replace(".html", ".docx");

  writeFileSync(tmp, documentHtml(markdown, { title }), "utf8");

  const res = spawnSync(
    "soffice",
    ["--headless", "--convert-to", "docx", "--outdir", tmpdir(), tmp],
    { encoding: "utf8" }
  );

  if (res.status !== 0) {
    throw new Error(`soffice failed (exit ${res.status}): ${res.stderr || res.stdout || ""}`);
  }

  // soffice writes <basename>.docx in the outdir — move it to outPath
  const { renameSync, unlinkSync } = await import("node:fs");
  try {
    renameSync(tmpDocx, outPath);
  } catch {
    // soffice may have named it differently — fall back to OOXML
    try {
      unlinkSync(tmp);
    } catch {
      /* ok */
    }
    await renderDocxOoxml({ markdown, outPath, title });
    return;
  }
  try {
    unlinkSync(tmp);
  } catch {
    /* ok */
  }
}

// ---------------------------------------------------------------------------
// renderDocxOoxml — hand-rolled minimal DOCX (ZIP of WordprocessingML)
// ---------------------------------------------------------------------------

/**
 * Build a minimal but valid OOXML .docx file using only node:zlib + node builtins.
 * Maps markdown block structure to WordprocessingML paragraphs and runs.
 *
 * @param {{ markdown: string, outPath: string, title?: string }} opts
 */
async function renderDocxOoxml({ markdown, outPath, title: _title = "Document" }) {
  // Parse markdown into a simple block AST
  const blocks = parseMdBlocks(markdown);

  // Build WordprocessingML body XML
  const bodyXml = blocks.map(blockToWml).join("\n");

  // WordprocessingML document
  const documentXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document
  xmlns:wpc="http://schemas.microsoft.com/office/word/2010/wordprocessingCanvas"
  xmlns:cx="http://schemas.microsoft.com/office/drawing/2014/chartex"
  xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006"
  xmlns:o="urn:schemas-microsoft-com:office:office"
  xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"
  xmlns:m="http://schemas.openxmlformats.org/officeDocument/2006/math"
  xmlns:v="urn:schemas-microsoft-com:vml"
  xmlns:wp14="http://schemas.microsoft.com/office/word/2010/wordprocessingDrawing"
  xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing"
  xmlns:w10="urn:schemas-microsoft-com:office:word"
  xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"
  xmlns:w14="http://schemas.microsoft.com/office/word/2010/wordml"
  xmlns:w15="http://schemas.microsoft.com/office/word/2012/wordml"
  xmlns:w16cex="http://schemas.microsoft.com/office/word/2018/wordml/cex"
  xmlns:w16cid="http://schemas.microsoft.com/office/word/2016/wordml/cid"
  xmlns:w16="http://schemas.microsoft.com/office/word/2018/wordml"
  xmlns:w16sdtdh="http://schemas.microsoft.com/office/word/2020/wordml/sdtdatahash"
  xmlns:w16se="http://schemas.microsoft.com/office/word/2015/wordml/symex"
  xmlns:wpg="http://schemas.microsoft.com/office/word/2010/wordprocessingGroup"
  xmlns:wpi="http://schemas.microsoft.com/office/word/2010/wordprocessingInk"
  xmlns:wne="http://schemas.microsoft.com/office/word/2006/wordml"
  xmlns:wps="http://schemas.microsoft.com/office/word/2010/wordprocessingShape"
  mc:Ignorable="w14 w15 w16se w16cid w16 w16cex w16sdtdh wp14">
  <w:body>
${bodyXml}
    <w:sectPr>
      <w:pgSz w:w="12240" w:h="15840"/>
      <w:pgMar w:top="720" w:right="1080" w:bottom="720" w:left="1080" w:header="432" w:footer="432" w:gutter="0"/>
    </w:sectPr>
  </w:body>
</w:document>`;

  // Supporting XML files
  const contentTypes = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/word/document.xml"
    ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
  <Override PartName="/word/styles.xml"
    ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>
</Types>`;

  const relsRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1"
    Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument"
    Target="word/document.xml"/>
</Relationships>`;

  const docRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1"
    Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles"
    Target="styles.xml"/>
</Relationships>`;

  const stylesXml = buildStylesXml();

  // Build ZIP
  const entries = [
    { name: "[Content_Types].xml", content: contentTypes },
    { name: "_rels/.rels", content: relsRels },
    { name: "word/_rels/document.xml.rels", content: docRels },
    { name: "word/document.xml", content: documentXml },
    { name: "word/styles.xml", content: stylesXml },
  ];

  const zipBuffer = buildZip(entries);
  writeFileSync(outPath, zipBuffer);
}

// --- Minimal WordprocessingML styles ---

function buildStylesXml() {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"
          xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <w:docDefaults>
    <w:rPrDefault>
      <w:rPr>
        <w:rFonts w:ascii="Helvetica" w:hAnsi="Helvetica"/>
        <w:color w:val="000000"/>
        <w:sz w:val="22"/>
        <w:szCs w:val="22"/>
      </w:rPr>
    </w:rPrDefault>
  </w:docDefaults>
  <w:style w:type="paragraph" w:styleId="Normal" w:default="1">
    <w:name w:val="Normal"/>
    <w:pPr><w:spacing w:after="80"/></w:pPr>
  </w:style>
  <w:style w:type="paragraph" w:styleId="Heading1">
    <w:name w:val="heading 1"/>
    <w:basedOn w:val="Normal"/>
    <w:pPr>
      <w:outlineLvl w:val="0"/>
      <w:spacing w:before="0" w:after="40"/>
    </w:pPr>
    <w:rPr><w:b/><w:color w:val="000000"/><w:sz w:val="36"/><w:szCs w:val="36"/></w:rPr>
  </w:style>
  <w:style w:type="paragraph" w:styleId="Heading2">
    <w:name w:val="heading 2"/>
    <w:basedOn w:val="Normal"/>
    <w:pPr>
      <w:outlineLvl w:val="1"/>
      <w:spacing w:before="140" w:after="40"/>
    </w:pPr>
    <w:rPr><w:b/><w:color w:val="000000"/><w:sz w:val="26"/><w:szCs w:val="26"/></w:rPr>
  </w:style>
  <w:style w:type="paragraph" w:styleId="Heading3">
    <w:name w:val="heading 3"/>
    <w:basedOn w:val="Normal"/>
    <w:pPr>
      <w:outlineLvl w:val="2"/>
      <w:spacing w:before="120" w:after="20"/>
    </w:pPr>
    <w:rPr><w:b/><w:color w:val="000000"/><w:sz w:val="24"/><w:szCs w:val="24"/></w:rPr>
  </w:style>
  <w:style w:type="paragraph" w:styleId="ListParagraph">
    <w:name w:val="List Paragraph"/>
    <w:basedOn w:val="Normal"/>
    <w:pPr>
      <w:ind w:left="720"/>
      <w:spacing w:after="60"/>
    </w:pPr>
  </w:style>
</w:styles>`;
}

// --- Markdown → block AST ---

/**
 * @typedef {{ type: 'heading', level: number, runs: Run[] }
 *           |{ type: 'para', runs: Run[] }
 *           |{ type: 'li', ordered: boolean, depth: number, start?: number, runs: Run[] }
 *           |{ type: 'hr' }
 *           |{ type: 'blockquote', runs: Run[] }
 *           |{ type: 'table', headers: Run[][], rows: Run[][][] }} Block
 * @typedef {{ text: string, bold?: boolean, italic?: boolean, code?: boolean, href?: string, break?: boolean }} Run
 */

// Sentinel inserted in place of an explicit hard break while a paragraph's
// lines are assembled into one raw string (see the paragraph-building loop
// in parseMdBlocks below). No markdown pattern parseRuns matches contains
// U+E000 (Private Use Area), so it always survives parseRuns as opaque
// plain text and can be split back out into its own break run afterward,
// unlike a literal "\n", which the code-span/link/emphasis regexes below
// don't treat specially and would otherwise leave embedded in a run's text.
const BREAK_MARKER = "";

function parseMdBlocks(markdown) {
  const lines = markdown.split(/\r?\n/);
  const blocks = [];
  // Stack of indentation widths, one per active nesting level, used to
  // derive each list item's depth. Reset whenever a non-list block breaks
  // the run of list items (blank lines alone do not break it).
  const listIndentStack = [];
  // Whether the most recently pushed block is a "para" that a following
  // plain line may still extend. CommonMark treats every run of
  // consecutive non-blank plain lines as a single paragraph — a blank
  // line, or any other block construct, ends it. Cleared everywhere a
  // block boundary is crossed so a later plain line always starts a fresh
  // paragraph instead of merging across one.
  let paragraphOpen = false;
  // The most recently pushed "li" block, while a following properly
  // indented line may still extend its text (a soft-wrapped continuation
  // like "- Led migration across\n  three regions."), or null once a
  // blank line or any other block construct ends it. Mirrors paragraphOpen
  // above, but tracks the block itself rather than a boolean since the
  // continuation branch appends directly onto it.
  let openListItem = null;

  const listItemDepth = (indent) => {
    while (listIndentStack.length > 0 && indent < listIndentStack[listIndentStack.length - 1]) {
      listIndentStack.pop();
    }
    if (listIndentStack.length === 0 || indent > listIndentStack[listIndentStack.length - 1]) {
      listIndentStack.push(indent);
    }
    return listIndentStack.length - 1;
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Fenced code block (``` or ~~~) — capture verbatim before the blank-line skip
    const fence = line.match(/^(\s*)(`{3,}|~{3,})(.*)$/);
    if (fence) {
      const fenceChar = fence[2][0];
      const fenceLen = fence[2].length;
      const codeLines = [];
      let j = i + 1;
      for (; j < lines.length; j++) {
        const cm = lines[j].match(/^(\s*)(`{3,}|~{3,})\s*$/);
        if (cm && cm[2][0] === fenceChar && cm[2].length >= fenceLen) break;
        codeLines.push(lines[j]);
      }
      i = j; // skip the closing fence
      blocks.push({ type: "codeblock", lines: codeLines });
      listIndentStack.length = 0;
      paragraphOpen = false;
      openListItem = null;
      continue;
    }

    if (line.trim() === "") {
      paragraphOpen = false;
      openListItem = null;
      continue;
    }

    // ATX heading
    const hm = line.match(/^(#{1,6})\s+(.*)/);
    if (hm) {
      blocks.push({ type: "heading", level: hm[1].length, runs: parseRuns(hm[2].trim()) });
      listIndentStack.length = 0;
      paragraphOpen = false;
      openListItem = null;
      continue;
    }

    // Horizontal rule
    if (/^(\s*[-*_]){3,}\s*$/.test(line)) {
      blocks.push({ type: "hr" });
      listIndentStack.length = 0;
      paragraphOpen = false;
      openListItem = null;
      continue;
    }

    // Unordered list. Like a paragraph, an item's raw text accumulates
    // across a following properly indented continuation line (see the
    // continuation branch below, right before the regular-paragraph
    // fallthrough) and is only handed to parseRuns once, in the
    // finalization pass, so an inline construct spanning the join
    // resolves correctly. contentIndent (the column the item's own text
    // starts at) is what a continuation line's indent gets compared
    // against.
    const ulm = line.match(/^(\s*)[-*]\s+(.*)/);
    if (ulm) {
      const depth = listItemDepth(ulm[1].length);
      const hardBreakMatch = ulm[2].match(/(?: {2,}|\\)$/);
      const li = {
        type: "li",
        ordered: false,
        depth,
        raw: hardBreakMatch ? ulm[2].slice(0, hardBreakMatch.index) : ulm[2],
        hardBreakPending: Boolean(hardBreakMatch),
        contentIndent: ulm[0].length - ulm[2].length,
      };
      blocks.push(li);
      paragraphOpen = false;
      openListItem = li;
      continue;
    }

    // Ordered list — same continuation-accumulation shape as unordered.
    const olm = line.match(/^(\s*)(\d+)\.\s+(.*)/);
    if (olm) {
      const depth = listItemDepth(olm[1].length);
      const hardBreakMatch = olm[3].match(/(?: {2,}|\\)$/);
      const li = {
        type: "li",
        ordered: true,
        depth,
        start: Number(olm[2]),
        raw: hardBreakMatch ? olm[3].slice(0, hardBreakMatch.index) : olm[3],
        hardBreakPending: Boolean(hardBreakMatch),
        contentIndent: olm[0].length - olm[3].length,
      };
      blocks.push(li);
      paragraphOpen = false;
      openListItem = li;
      continue;
    }

    // Pipe table
    if (/\|/.test(line)) {
      const nextLine = lines[i + 1] || "";
      const headerCells = splitPipeRow(line);
      const delimCells = splitPipeRow(nextLine);
      if (headerCells.length >= 2 && isPipeTableDelimRow(delimCells)) {
        i += 2; // skip header + delimiter rows
        const bodyRows = [];
        while (i < lines.length && /\|/.test(lines[i]) && lines[i].trim() !== "") {
          bodyRows.push(splitPipeRow(lines[i]).map(parseRuns));
          i++;
        }
        i--; // for-loop will i++
        blocks.push({
          type: "table",
          headers: headerCells.map(parseRuns),
          rows: bodyRows,
        });
        listIndentStack.length = 0;
        paragraphOpen = false;
        openListItem = null;
        continue;
      }
    }

    // Blockquote
    if (/^>\s?/.test(line)) {
      listIndentStack.length = 0;
      openListItem = null;
      const bqRuns = [];
      let j = i;
      while (j < lines.length && /^>\s?/.test(lines[j])) {
        if (bqRuns.length > 0) bqRuns.push({ text: " " });
        bqRuns.push(...parseRuns(lines[j].replace(/^>\s?/, "")));
        j++;
      }
      i = j - 1;
      blocks.push({ type: "blockquote", runs: bqRuns });
      paragraphOpen = false;
      continue;
    }

    // List item continuation — a soft-wrapped line like
    // "- Led migration across\n  three regions." belongs to the item
    // above it, not a detached paragraph, as long as it's indented at
    // least two spaces or matches the item's own content indent exactly.
    // Joined the same way a paragraph joins its lines: a soft break folds
    // to a single space, an explicit hard break (trailing two-or-more
    // spaces or a backslash) survives as a literal break. A blank line or
    // any other block construct already cleared openListItem above, so
    // reaching here with it still set means this line is eligible.
    if (openListItem) {
      const indentMatch = line.match(/^(\s*)/);
      const indent = indentMatch[1].length;
      if (indent >= 2 || indent === openListItem.contentIndent) {
        const hardBreakMatch = line.match(/(?: {2,}|\\)$/);
        const lineText = (hardBreakMatch ? line.slice(0, hardBreakMatch.index) : line).slice(
          indent
        );
        openListItem.raw += (openListItem.hardBreakPending ? BREAK_MARKER : " ") + lineText;
        openListItem.hardBreakPending = Boolean(hardBreakMatch);
        continue;
      }
    }

    // Regular paragraph line — CommonMark folds every run of consecutive
    // non-blank plain lines into one paragraph. When one is already open
    // (paragraphOpen, cleared at every block boundary above), extend it
    // instead of starting a new "para" block: an explicit hard break
    // (a line ending in two-or-more spaces, or a backslash) survives as a
    // literal in-paragraph line break, and every other join is a soft
    // break folded to a single space, matching markdownToHtml's own
    // soft/hard-break handling for the same markdown.
    //
    // The paragraph's raw text accumulates across every line here and is
    // only handed to parseRuns once, in the finalization pass below (after
    // the line loop). Calling parseRuns per line and joining the resulting
    // runs afterward, the prior approach, can never match an inline
    // construct (bold, italic, code, a link) whose delimiters land on
    // different source lines, since each line was parsed in isolation
    // before either delimiter's partner existed.
    const hardBreakMatch = line.match(/(?: {2,}|\\)$/);
    const lineText = hardBreakMatch ? line.slice(0, hardBreakMatch.index) : line;
    const openParagraph = paragraphOpen ? blocks[blocks.length - 1] : null;
    if (openParagraph) {
      openParagraph.raw += (openParagraph.hardBreakPending ? BREAK_MARKER : " ") + lineText;
      openParagraph.hardBreakPending = Boolean(hardBreakMatch);
    } else {
      blocks.push({
        type: "para",
        raw: lineText,
        hardBreakPending: Boolean(hardBreakMatch),
      });
    }
    paragraphOpen = true;
    openListItem = null;
    listIndentStack.length = 0;
  }

  // Finalize every paragraph and list-item block: parse its fully
  // assembled raw text (soft breaks already folded to spaces, hard breaks
  // marked with BREAK_MARKER) through parseRuns exactly once, so an inline
  // construct spanning a soft break resolves correctly. parseRuns splits
  // BREAK_MARKER back out into its own { break: true } run (see
  // pushPlainText below).
  for (const block of blocks) {
    if (block.type === "para" || block.type === "li") {
      block.runs = parseRuns(block.raw);
      delete block.raw;
      delete block.hardBreakPending;
      delete block.contentIndent;
    }
  }

  return blocks;
}

/**
 * Find a `[text](destination)` link anchored exactly at `text[start]`
 * (caller guarantees `text[start] === "["`), scanning the destination with
 * a balanced-parenthesis, backslash-escape-aware walk so a destination
 * containing `(...)` groups (or an escaped paren) is captured whole instead
 * of truncating at the first `)`.
 *
 * `nextCloseBracket` is a precomputed, index-by-index lookup of the next
 * `]` at or after a given position (or -1). Without it, finding the close
 * bracket for a `[` with no real link is an O(remaining length) scan, and
 * many literal, unpaired `[` characters before the same distant `]` (or
 * before none at all) turn that into O(n^2) across the whole call.
 *
 * @param {string} text
 * @param {number} start
 * @param {Int32Array} nextCloseBracket
 * @returns {{length: number, text: string, href: string}|null}
 */
function matchLinkAt(text, start, nextCloseBracket) {
  const closeBracket = nextCloseBracket[start + 1];
  if (closeBracket === -1 || text[closeBracket + 1] !== "(") return null;

  let depth = 0;
  let href = "";
  let matched = false;
  let j = closeBracket + 1;
  for (; j < text.length; j++) {
    const ch = text[j];
    if (ch === "\\" && j + 1 < text.length) {
      href += text[j + 1];
      j++;
      continue;
    }
    if (ch === "(") {
      depth++;
      if (depth > 1) href += ch;
      continue;
    }
    if (ch === ")") {
      depth--;
      if (depth === 0) {
        matched = true;
        j++;
        break;
      }
      href += ch;
      continue;
    }
    href += ch;
  }

  if (!matched) return null;

  return {
    length: j - start,
    text: text.slice(start + 1, closeBracket),
    href,
  };
}

/**
 * Push `text` onto `runs`, splitting out any embedded BREAK_MARKER into its
 * own `{ break: true }` run instead of leaving the sentinel character in
 * plain text. A run of consecutive markers (a hard break can never repeat
 * in practice, but this stays correct if it does) produces one break run
 * per marker with no empty text run between them.
 *
 * @param {Run[]} runs
 * @param {string} text
 */
function pushPlainText(runs, text) {
  const segments = text.split(BREAK_MARKER);
  segments.forEach((segment, index) => {
    if (segment) runs.push({ text: segment });
    if (index < segments.length - 1) runs.push({ text: "\n", break: true });
  });
}

/**
 * Find the index of a delimiter's close, starting the search at `from`, or
 * -1 if there isn't a valid one. Mirrors the content class a delimiter
 * pattern like `\*\*([^*]+)\*\*` enforces: the content between open and
 * close must be non-empty and must not itself contain `excludeChar`, so the
 * scan stops at the FIRST occurrence of `excludeChar` at or after `from`
 * and either confirms it starts `closeToken` there or fails outright — it
 * never continues scanning past it looking for a later, valid one. That
 * keeps every call bounded by the gap to the nearest `excludeChar`
 * occurrence rather than the remaining length of the whole text, which is
 * what makes the outer cursor scan in parseRuns O(n) instead of O(n^2).
 *
 * @param {string} text
 * @param {number} from
 * @param {string} closeToken
 * @param {string} excludeChar
 * @returns {number}
 */
function findDelimiterClose(text, from, closeToken, excludeChar) {
  let j = from;
  while (j < text.length && text[j] !== excludeChar) j++;
  if (j >= text.length || j === from) return -1;
  return text.startsWith(closeToken, j) ? j : -1;
}

/**
 * Parse inline markdown into runs: bold, italic, code, links, plain text.
 *
 * A single left-to-right cursor walk over `text`: at each position, try
 * each delimiter type anchored exactly there (matching the same priority
 * order — code, bold**, bold__, italic*, italic_, link — the old
 * repeated-regex-scan approach used), and fall back to plain text and
 * advance by one character when none match. This never re-slices or
 * re-scans an already-visited prefix the way repeatedly searching a
 * shrinking "remaining" suffix with regexes does, so a paragraph with many
 * inline constructs parses in O(n) instead of O(n^2).
 *
 * @param {string} text
 * @returns {Run[]}
 */
function parseRuns(text) {
  const runs = [];
  const n = text.length;

  // One backward pass giving an O(1) "next ']' at or after i" lookup for
  // every position — see matchLinkAt's doc comment for why this matters.
  const nextCloseBracket = new Int32Array(n + 1);
  nextCloseBracket[n] = -1;
  for (let k = n - 1; k >= 0; k--) {
    nextCloseBracket[k] = text[k] === "]" ? k : nextCloseBracket[k + 1];
  }

  let plainStart = 0;
  let i = 0;
  const flushPlain = (end) => {
    if (end > plainStart) pushPlainText(runs, text.slice(plainStart, end));
  };

  while (i < n) {
    const ch = text[i];

    if (ch === "`") {
      const close = findDelimiterClose(text, i + 1, "`", "`");
      if (close !== -1) {
        flushPlain(i);
        // Code spans stay opaque: no recursion, the literal text is the
        // run. A hard break can't land inside real backtick-delimited
        // source (it would have to survive as a raw newline mid-span,
        // which markdown doesn't produce), but if BREAK_MARKER ever does
        // end up here, fold it back to a literal newline rather than
        // leaking the sentinel.
        runs.push({
          text: text
            .slice(i + 1, close)
            .split(BREAK_MARKER)
            .join("\n"),
          code: true,
        });
        i = close + 1;
        plainStart = i;
        continue;
      }
    }

    if (ch === "*" && text[i + 1] === "*") {
      const close = findDelimiterClose(text, i + 2, "**", "*");
      if (close !== -1) {
        flushPlain(i);
        // The visible content can itself contain a link or the other
        // emphasis marker (e.g. **[Example](url)**) — parse recursively
        // and merge the bold flag onto every resulting run.
        for (const run of parseRuns(text.slice(i + 2, close))) runs.push({ ...run, bold: true });
        i = close + 2;
        plainStart = i;
        continue;
      }
    }
    if (ch === "_" && text[i + 1] === "_") {
      const close = findDelimiterClose(text, i + 2, "__", "_");
      if (close !== -1) {
        flushPlain(i);
        for (const run of parseRuns(text.slice(i + 2, close))) runs.push({ ...run, bold: true });
        i = close + 2;
        plainStart = i;
        continue;
      }
    }

    if (ch === "*") {
      const close = findDelimiterClose(text, i + 1, "*", "*");
      if (close !== -1) {
        flushPlain(i);
        for (const run of parseRuns(text.slice(i + 1, close))) runs.push({ ...run, italic: true });
        i = close + 1;
        plainStart = i;
        continue;
      }
    }
    if (ch === "_") {
      const close = findDelimiterClose(text, i + 1, "_", "_");
      if (close !== -1) {
        flushPlain(i);
        for (const run of parseRuns(text.slice(i + 1, close))) runs.push({ ...run, italic: true });
        i = close + 1;
        plainStart = i;
        continue;
      }
    }

    if (ch === "[") {
      const link = matchLinkAt(text, i, nextCloseBracket);
      if (link) {
        flushPlain(i);
        // The destination stays opaque, but the visible label can itself
        // contain bold/italic (e.g. [**Example**](url)) — parse it
        // recursively and stamp the href onto every resulting run so the
        // label's own formatting survives alongside the link.
        for (const run of parseRuns(link.text)) runs.push({ ...run, href: run.href || link.href });
        i += link.length;
        plainStart = i;
        continue;
      }
    }

    i++;
  }

  flushPlain(n);
  return runs;
}

// --- Runs → WML ---

function escXml(s) {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function runsToWml(runs) {
  return runs
    .map((run) => {
      let rPr = "";
      if (run.bold) rPr += "<w:b/>";
      if (run.italic) rPr += "<w:i/>";
      if (run.code) rPr += '<w:rFonts w:ascii="Courier New" w:hAnsi="Courier New"/>';
      // Links: underline + blue color
      if (run.href) rPr += '<w:u w:val="single"/><w:color w:val="1155CC"/>';
      const rPrBlock = rPr ? `<w:rPr>${rPr}</w:rPr>` : "";

      // WordprocessingML has no text-based line break: a raw newline inside
      // <w:t> is just whitespace to Word, never a forced break. A hard
      // break run (see BREAK_MARKER/pushPlainText above) must therefore
      // become an explicit <w:br/>, not a <w:t> containing "\n".
      if (run.break) return `      <w:r>${rPrBlock}<w:br/></w:r>`;

      const text = escXml(run.text || "");
      // Preserve leading/trailing spaces with xml:space
      const needsSpace = /^\s|\s$/.test(run.text || "");
      const tAttr = needsSpace ? ' xml:space="preserve"' : "";
      return `      <w:r>${rPrBlock}<w:t${tAttr}>${text}</w:t></w:r>`;
    })
    .join("\n");
}

// Helper: render a cell's runs to WML <w:r> elements, indented with 8 spaces for table nesting
function cellRunsToWml(runs) {
  return runs
    .map((run) => {
      let rPr = "";
      if (run.bold) rPr += "<w:b/>";
      if (run.italic) rPr += "<w:i/>";
      if (run.code) rPr += '<w:rFonts w:ascii="Courier New" w:hAnsi="Courier New"/>';
      if (run.href) rPr += '<w:u w:val="single"/><w:color w:val="1155CC"/>';
      const rPrBlock = rPr ? `<w:rPr>${rPr}</w:rPr>` : "";

      if (run.break) return `          <w:r>${rPrBlock}<w:br/></w:r>`;

      const text = escXml(run.text || "");
      const needsSpace = /^\s|\s$/.test(run.text || "");
      const tAttr = needsSpace ? ' xml:space="preserve"' : "";
      return `          <w:r>${rPrBlock}<w:t${tAttr}>${text}</w:t></w:r>`;
    })
    .join("\n");
}

function blockToWml(block) {
  if (block.type === "hr") {
    return `    <w:p>
      <w:pPr><w:pBdr><w:bottom w:val="single" w:sz="6" w:space="1" w:color="AAAAAA"/></w:pBdr></w:pPr>
    </w:p>`;
  }

  if (block.type === "codeblock") {
    // Each source line becomes its own tight monospace paragraph, whitespace preserved.
    return block.lines
      .map(
        (ln) =>
          `    <w:p>
      <w:pPr><w:pStyle w:val="Normal"/><w:spacing w:after="0" w:line="240" w:lineRule="auto"/></w:pPr>
      <w:r><w:rPr><w:rFonts w:ascii="Courier New" w:hAnsi="Courier New" w:cs="Courier New"/><w:sz w:val="16"/><w:szCs w:val="16"/></w:rPr><w:t xml:space="preserve">${escXml(ln)}</w:t></w:r>
    </w:p>`
      )
      .join("\n");
  }

  if (block.type === "heading") {
    const styleId = block.level <= 3 ? `Heading${block.level}` : "Heading3";
    return `    <w:p>
      <w:pPr><w:pStyle w:val="${styleId}"/></w:pPr>
${runsToWml(block.runs)}
    </w:p>`;
  }

  if (block.type === "li") {
    // Use ListParagraph style with a bullet/number character prepended
    const prefix = block.ordered ? "" : "• ";
    const allRuns = prefix ? [{ text: prefix }, ...block.runs] : block.runs;
    return `    <w:p>
      <w:pPr><w:pStyle w:val="ListParagraph"/></w:pPr>
${runsToWml(allRuns)}
    </w:p>`;
  }

  if (block.type === "blockquote") {
    // Left-indented italic paragraph
    const italicRuns = block.runs.map((r) => ({ ...r, italic: true }));
    return `    <w:p>
      <w:pPr><w:pStyle w:val="Normal"/><w:ind w:left="480"/></w:pPr>
${runsToWml(italicRuns)}
    </w:p>`;
  }

  if (block.type === "table") {
    // Emit a real WordprocessingML <w:tbl>
    const tblBorders = `<w:tblBorders>
          <w:top w:val="single" w:sz="4" w:color="AAAAAA"/>
          <w:left w:val="single" w:sz="4" w:color="AAAAAA"/>
          <w:bottom w:val="single" w:sz="4" w:color="AAAAAA"/>
          <w:right w:val="single" w:sz="4" w:color="AAAAAA"/>
          <w:insideH w:val="single" w:sz="4" w:color="AAAAAA"/>
          <w:insideV w:val="single" w:sz="4" w:color="AAAAAA"/>
        </w:tblBorders>`;

    const makeTc = (runs, bold = false) => {
      const cellRuns = bold ? runs.map((r) => ({ ...r, bold: true })) : runs;
      return `        <w:tc>
          <w:p>
${cellRunsToWml(cellRuns)}
          </w:p>
        </w:tc>`;
    };

    const headerRow = `      <w:tr>
${block.headers.map((cellRuns) => makeTc(cellRuns, true)).join("\n")}
      </w:tr>`;

    const bodyRows = block.rows
      .map(
        (rowCells) =>
          `      <w:tr>\n${rowCells.map((cellRuns) => makeTc(cellRuns, false)).join("\n")}\n      </w:tr>`
      )
      .join("\n");

    return `    <w:tbl>
      <w:tblPr>
        <w:tblW w:w="0" w:type="auto"/>
        ${tblBorders}
      </w:tblPr>
${headerRow}
${bodyRows}
    </w:tbl>`;
  }

  // Default: Normal paragraph
  return `    <w:p>
      <w:pPr><w:pStyle w:val="Normal"/></w:pPr>
${runsToWml(block.runs)}
    </w:p>`;
}

// ---------------------------------------------------------------------------
// buildZip — manual ZIP container (no external dep)
// ---------------------------------------------------------------------------

/**
 * Build a ZIP archive buffer from an array of { name: string, content: string } entries.
 * Uses deflateRaw compression via node:zlib.
 * Implements PKZIP local file header + central directory + end of central directory.
 *
 * @param {Array<{ name: string, content: string }>} entries
 * @returns {Buffer}
 */
function buildZip(entries) {
  const localHeaders = [];
  const centralDir = [];
  let offset = 0;

  for (const entry of entries) {
    const nameBytes = Buffer.from(entry.name, "utf8");
    const dataBytes = Buffer.from(entry.content, "utf8");
    const compressed = deflateRawSync(dataBytes, { level: 6 });

    const crc = crc32(dataBytes);
    const compSize = compressed.length;
    const uncompSize = dataBytes.length;
    const now = new Date();
    const dosDate = dosDateTime(now);

    // Local file header (30 bytes + name)
    const localHeader = Buffer.alloc(30 + nameBytes.length);
    localHeader.writeUInt32LE(0x04034b50, 0); // local file signature
    localHeader.writeUInt16LE(20, 4); // version needed
    localHeader.writeUInt16LE(0, 6); // general purpose bit flag
    localHeader.writeUInt16LE(8, 8); // compression method: deflate
    localHeader.writeUInt32LE(dosDate, 10); // last mod file time+date
    localHeader.writeUInt32LE(crc, 14); // crc-32
    localHeader.writeUInt32LE(compSize, 18); // compressed size
    localHeader.writeUInt32LE(uncompSize, 22); // uncompressed size
    localHeader.writeUInt16LE(nameBytes.length, 26); // filename length
    localHeader.writeUInt16LE(0, 28); // extra field length
    nameBytes.copy(localHeader, 30);

    localHeaders.push(localHeader, compressed);

    // Central directory record (46 bytes + name)
    const cd = Buffer.alloc(46 + nameBytes.length);
    cd.writeUInt32LE(0x02014b50, 0); // central dir signature
    cd.writeUInt16LE(20, 4); // version made by
    cd.writeUInt16LE(20, 6); // version needed
    cd.writeUInt16LE(0, 8); // general purpose bit flag
    cd.writeUInt16LE(8, 10); // compression method
    cd.writeUInt32LE(dosDate, 12); // last mod
    cd.writeUInt32LE(crc, 16); // crc-32
    cd.writeUInt32LE(compSize, 20); // compressed size
    cd.writeUInt32LE(uncompSize, 24); // uncompressed size
    cd.writeUInt16LE(nameBytes.length, 28); // filename length
    cd.writeUInt16LE(0, 30); // extra field length
    cd.writeUInt16LE(0, 32); // file comment length
    cd.writeUInt16LE(0, 34); // disk number start
    cd.writeUInt16LE(0, 36); // internal file attributes
    cd.writeUInt32LE(0, 38); // external file attributes
    cd.writeUInt32LE(offset, 42); // relative offset of local header
    nameBytes.copy(cd, 46);

    centralDir.push(cd);
    offset += localHeader.length + compressed.length;
  }

  // Central directory size and offset
  const cdBuf = Buffer.concat(centralDir);
  const cdSize = cdBuf.length;
  const cdOffset = offset;

  // End of central directory record (22 bytes)
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0); // end of central dir signature
  eocd.writeUInt16LE(0, 4); // disk number
  eocd.writeUInt16LE(0, 6); // disk with central dir start
  eocd.writeUInt16LE(entries.length, 8); // total entries on disk
  eocd.writeUInt16LE(entries.length, 10); // total entries
  eocd.writeUInt32LE(cdSize, 12); // size of central dir
  eocd.writeUInt32LE(cdOffset, 16); // offset of central dir
  eocd.writeUInt16LE(0, 20); // comment length

  return Buffer.concat([...localHeaders, cdBuf, eocd]);
}

// --- CRC-32 ---

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c;
  }
  return table;
})();

function crc32(buf) {
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    crc = CRC_TABLE[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

// --- DOS date/time packing ---

function dosDateTime(date) {
  const time =
    ((date.getHours() & 0x1f) << 11) |
    ((date.getMinutes() & 0x3f) << 5) |
    ((date.getSeconds() >> 1) & 0x1f);
  const day =
    ((date.getFullYear() - 1980) << 25) |
    (((date.getMonth() + 1) & 0x0f) << 21) |
    ((date.getDate() & 0x1f) << 16);
  return (day | time) >>> 0;
}

// ---------------------------------------------------------------------------
// exportArtifact — orchestrator
// ---------------------------------------------------------------------------

/**
 * Export a markdown artifact to one or more formats.
 *
 * @param {{
 *   markdown: string,
 *   outBase: string,          e.g. "/path/to/Resume" (no extension)
 *   formats: Array<'pdf'|'docx'|'text'>,
 *   title?: string,
 *   ats?: boolean             render the PDF with the ATS-safe standard font stack and
 *                             scrub bidi/hidden-text channels from both the PDF and DOCX
 * }} opts
 * @returns {Promise<{ pdf?: string, docx?: string, docxTool?: string, docxLabel?: string, text?: string }>}
 */
/**
 * Write the rendered text artifact to `${outBase}.txt`, confined to a
 * caller-trusted root and safe against an existing symlink sitting at the
 * destination.
 *
 * outBase must be a non-empty absolute path. Deriving outBase by
 * extension-stripping an extensionless source (`full.slice(0,
 * -extname(full).length)`) is a classic negative-zero bug: `extname()`
 * returns `""`, `-"".length` is `-0`, and `String.prototype.slice(0, -0)`
 * behaves like `slice(0, 0)`, producing `""` rather than the whole string.
 * An empty/relative outBase is rejected here rather than silently writing
 * `.txt` under process.cwd().
 *
 * When the caller passes `root` (the trusted packet/workspace root), both
 * `root` and the destination's parent directory are resolved with
 * realpath() and the canonical parent must sit inside the canonical root.
 * A lexical containment check alone is self-referential (the "packet
 * directory" it checks against is just dirname(outBase) again) and does
 * nothing to stop a symlinked ancestor — e.g. workspace/tailored pointing
 * outside the workspace — from redirecting the write. Without `root`, the
 * check falls back to the old lexical containment for callers that
 * haven't adopted a trusted root yet.
 *
 * The write itself goes to a freshly created, uniquely named sibling file
 * in the validated canonical parent (`wx`, which fails if it already
 * exists, so two concurrent exports can't clobber each other's temp file)
 * and is then renamed into place: rename() replaces whatever sits at the
 * destination path, including an existing symlink, without ever opening
 * or following it, so a symlink planted at the destination can't redirect
 * the write outside the confined directory.
 *
 * @param {string} outBase
 * @param {string} text
 * @param {string} [root] trusted packet/workspace root the destination must resolve inside
 * @returns {string} the destination path
 */
function writeTextArtifactConfined(outBase, text, root) {
  if (!outBase || !isAbsolute(outBase)) {
    throw new Error(
      `exportArtifact: outBase must be a non-empty absolute path, got ${JSON.stringify(outBase)}`
    );
  }

  const destPath = `${outBase}.txt`;
  const parentDir = dirname(outBase);
  let confinedParent = resolve(parentDir);

  if (root != null) {
    if (!root || !isAbsolute(root)) {
      throw new Error(
        `exportArtifact: root must be a non-empty absolute path, got ${JSON.stringify(root)}`
      );
    }
    let canonicalRoot;
    let canonicalParent;
    try {
      canonicalRoot = realpathSync(root);
    } catch {
      throw new Error(`exportArtifact: trusted root does not exist: ${root}`);
    }
    try {
      canonicalParent = realpathSync(parentDir);
    } catch {
      throw new Error(
        `exportArtifact: text export destination directory does not exist: ${parentDir}`
      );
    }
    if (
      canonicalParent !== canonicalRoot &&
      !canonicalParent.startsWith(`${canonicalRoot}${sep}`)
    ) {
      throw new Error(
        `exportArtifact: text export destination escapes the trusted root: ${destPath}`
      );
    }
    confinedParent = canonicalParent;
  } else {
    const resolvedDest = resolve(destPath);
    if (resolvedDest !== confinedParent && !resolvedDest.startsWith(`${confinedParent}${sep}`)) {
      throw new Error(
        `exportArtifact: text export destination escapes the packet directory: ${destPath}`
      );
    }
  }

  const finalDestPath = join(confinedParent, basename(destPath));
  const tmpPath = `${finalDestPath}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  writeFileSync(tmpPath, text, { encoding: "utf8", flag: "wx" });
  renameSync(tmpPath, finalDestPath);
  return finalDestPath;
}

export async function exportArtifact({
  markdown,
  outBase,
  formats,
  title = "Document",
  ats = false,
  root,
}) {
  const result = {};

  for (const fmt of formats) {
    if (fmt === "pdf") {
      const pdfPath = `${outBase}.pdf`;
      await renderPdf({ markdown, outPath: pdfPath, title, ats });
      result.pdf = pdfPath;
    } else if (fmt === "docx") {
      const docxPath = `${outBase}.docx`;
      const info = await renderDocx({ markdown, outPath: docxPath, title, ats });
      result.docx = docxPath;
      result.docxTool = info.tool;
      result.docxLabel = info.label;
    } else if (fmt === "text") {
      result.text = writeTextArtifactConfined(outBase, renderResumeText(markdown), root);
    }
  }

  return result;
}
