import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import JSZip from "jszip";

import {
  exportArtifact,
  markdownToHtml,
  normalizeAtsText,
  normalizeDocumentText,
  sanitizeArtifactHtml,
} from "../src/core/documents/export.mjs";

test("markdown artifact links render executable and malformed targets as inert text", () => {
  const html = markdownToHtml(`
[JavaScript](javascript:alert)
[Mixed case](JaVaScRiPt:alert)
[Whitespace](java\tscript:alert)
[Entity](jav&#x61;script:alert)
[Percent encoded](%6aavascript:alert)
[Data](data:text/html,alert)
[Protocol relative](//evil.example/payload)
[Malformed](://broken)
  `);

  assert.doesNotMatch(html, /href=/i);
  assert.doesNotMatch(html, /<script|<img|onerror=/i);
  for (const label of [
    "JavaScript",
    "Mixed case",
    "Whitespace",
    "Entity",
    "Percent encoded",
    "Data",
    "Protocol relative",
    "Malformed",
  ]) {
    assert.match(html, new RegExp(label));
  }
});

test("markdown artifact links preserve only approved external, mail, and relative targets", () => {
  const html = markdownToHtml(`
[HTTPS](https://example.com/profile?q=1)
[HTTP](http://example.com)
[Mail](mailto:recruiter@example.com)
[Relative](./portfolio/case-study)
[Fragment](#experience)
  `);

  assert.match(
    html,
    /<a href="https:\/\/example\.com\/profile\?q=1" target="_blank" rel="noopener noreferrer">HTTPS<\/a>/
  );
  assert.match(
    html,
    /<a href="http:\/\/example\.com" target="_blank" rel="noopener noreferrer">HTTP<\/a>/
  );
  assert.match(html, /<a href="mailto:recruiter@example\.com">Mail<\/a>/);
  assert.match(html, /<a href="\.\/portfolio\/case-study">Relative<\/a>/);
  assert.match(html, /<a href="#experience">Fragment<\/a>/);
});

test("the final artifact fragment sanitizer removes any non-renderer HTML capabilities", () => {
  const html = sanitizeArtifactHtml(
    '<img src=x onerror="alert(1)"><script>alert(1)</script><p onclick="alert(1)">Text</p><a href="javascript:alert">Bad</a>'
  );

  assert.doesNotMatch(html, /<img|<script|onerror=|onclick=|javascript:/i);
  assert.match(html, /<p>Text<\/p>/);
  assert.match(html, />Bad</);
});

test("ATS text normalization strips bidi overrides and tag characters but keeps ordinary non-ASCII text", () => {
  const rtlOverride = "R\u00e9sum\u00e9\u202Eevil\u202C.pdf";
  const tagSequence = `Engineer${String.fromCodePoint(0xe0001, 0xe0065, 0xe006e)}`;

  assert.equal(normalizeAtsText(rtlOverride), "Résuméevil.pdf");
  assert.equal(normalizeAtsText(tagSequence), "Engineer");

  const ordinary = "café über 日本語";
  assert.equal(normalizeAtsText(ordinary), ordinary);
});

test("ATS text normalization strips every bidi control character and tag-character flag sequences", () => {
  const arabicLetterMark = "؜price: $9";
  const leftToRightMark = "left‎right";
  const rightToLeftMark = "right‏left";
  const rtlOverride = "Résumé‮evil.pdf";
  const leftToRightIsolate = "start⁦end";
  const englandFlag = String.fromCodePoint(
    0x1f3f4,
    0xe0067,
    0xe0062,
    0xe0065,
    0xe006e,
    0xe0067,
    0xe007f
  );

  assert.equal(normalizeAtsText(arabicLetterMark), "price: $9");
  assert.equal(normalizeAtsText(leftToRightMark), "leftright");
  assert.equal(normalizeAtsText(rightToLeftMark), "rightleft");
  assert.equal(normalizeAtsText(rtlOverride), "Résuméevil.pdf");
  assert.equal(normalizeAtsText(leftToRightIsolate), "startend");
  assert.equal(
    normalizeAtsText(`Engineer ${englandFlag}`),
    `Engineer ${String.fromCodePoint(0x1f3f4)}`
  );
});

test("document-level normalization (non-ATS PDFs) keeps flag sequences, Mongolian vowel separator, and emoji presentation selectors", () => {
  const englandFlag = String.fromCodePoint(
    0x1f3f4,
    0xe0067,
    0xe0062,
    0xe0065,
    0xe006e,
    0xe0067,
    0xe007f
  );
  const mongolianVowelSeparator = "᠐᠎᠑";
  const heartWithPresentationSelector = "❤️";
  const zeroWidthSpace = "zero​width";

  assert.equal(normalizeDocumentText(`Flag: ${englandFlag}`), `Flag: ${englandFlag}`);
  assert.equal(normalizeDocumentText(mongolianVowelSeparator), mongolianVowelSeparator);
  assert.equal(normalizeDocumentText(heartWithPresentationSelector), heartWithPresentationSelector);
  assert.equal(normalizeDocumentText(zeroWidthSpace), "zerowidth");
});

test("exportArtifact DOCX strips bidi overrides from ATS copies but keeps them in non-ATS copies", async () => {
  const markdown = "Résumé‮evil.pdf";
  const dir = mkdtempSync(join(tmpdir(), "careerrat-docx-ats-"));
  const savedPath = process.env.PATH;

  try {
    // Force detectDocxCapability to find neither pandoc nor soffice, so
    // exportArtifact deterministically falls back to the built-in OOXML
    // writer regardless of what's installed on the machine running this test.
    process.env.PATH = "";

    const ats = await exportArtifact({
      markdown,
      outBase: join(dir, "ats"),
      formats: ["docx"],
      title: "Resume",
      ats: true,
    });
    const nonAts = await exportArtifact({
      markdown,
      outBase: join(dir, "non-ats"),
      formats: ["docx"],
      title: "Resume",
      ats: false,
    });

    assert.equal(ats.docxTool, "ooxml");
    assert.equal(nonAts.docxTool, "ooxml");

    const atsXml = await (await JSZip.loadAsync(readFileSync(ats.docx)))
      .file("word/document.xml")
      .async("string");
    const nonAtsXml = await (await JSZip.loadAsync(readFileSync(nonAts.docx)))
      .file("word/document.xml")
      .async("string");

    assert.doesNotMatch(atsXml, /‮/);
    assert.match(nonAtsXml, /‮/);
  } finally {
    process.env.PATH = savedPath;
    rmSync(dir, { recursive: true, force: true });
  }
});
