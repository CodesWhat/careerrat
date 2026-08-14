import assert from "node:assert/strict";
import { test } from "node:test";

import { markdownToHtml, sanitizeArtifactHtml } from "../src/core/documents/export.mjs";

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
