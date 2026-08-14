import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import mammoth from "mammoth";
import { plainTextFromHtml } from "../src/core/deep-ingest/source-normalize.mjs";
import { extractPublicCareersPage } from "../src/core/discovery/public-page-extractor.mjs";
import { compileSingleStarGlob } from "../src/core/fs/single-star-glob.mjs";
import { extractDocxResumeMarkdown } from "../src/core/onboarding/resume-docx.mjs";
import { trimEdgeCharacter } from "../src/core/text/slug.mjs";
import { dispatchHttpRoute } from "../src/core/tracker/route-dispatch.mjs";

const publicResolver = async () => [{ address: "93.184.216.34", family: 4 }];

test("HTML-to-text conversion drops script and style bodies with spaced closing tags", () => {
  const text = plainTextFromHtml(
    "Before<script >private script text</script >After<style >private CSS</style >Done"
  );

  assert.equal(text, "Before After Done");
});

test("public careers extraction never treats script text as a login gate", async () => {
  const result = await extractPublicCareersPage({
    url: "https://example.test/careers",
    fetchImpl: async () =>
      new Response(
        "<html><body><h1>Careers</h1><script >Please sign in</script >" +
          '<a href="/careers/engineering">Engineering roles</a>' +
          '<a href="/careers/design">Design roles</a></body></html>',
        { status: 200, headers: { "content-type": "text/html" } }
      ),
    resolveHost: publicResolver,
  });

  assert.equal(result.extractionStatus, "ambiguous_public_page");
});

test("DOCX HTML fallback decodes entities once and omits active-content bodies", async () => {
  const convertToMarkdown = mammoth.convertToMarkdown;
  const convertToHtml = mammoth.convertToHtml;
  mammoth.convertToMarkdown = undefined;
  mammoth.convertToHtml = async () => ({
    value:
      '<p><a href="https://example.test/me"><strong>Profile</strong></a></p>' +
      "<p>&amp;lt;script&amp;gt;</p><script >ignore me</script >",
  });

  try {
    const text = await extractDocxResumeMarkdown(Buffer.alloc(0));
    assert.equal(text, "Profile (https://example.test/me)\n&lt;script&gt;");
  } finally {
    mammoth.convertToMarkdown = convertToMarkdown;
    mammoth.convertToHtml = convertToHtml;
  }
});

test("single-star desktop globs escape every regular-expression metacharacter", () => {
  const pattern = compileSingleStarGlob("config/*.schema[.]\\json");

  assert.equal(pattern.test("config/example.schema[.]\\json"), true);
  assert.equal(pattern.test("config/exampleXschema[.]\\json"), false);
});

test("HTTP route dispatch invokes only callable handlers through a fixed method", () => {
  let calls = 0;
  const req = { method: "GET" };
  const res = {};

  assert.equal(
    dispatchHttpRoute(
      () => {
        calls += 1;
      },
      req,
      res
    ),
    true
  );
  assert.equal(dispatchHttpRoute(null, req, res), false);
  assert.equal(dispatchHttpRoute({ handle: "not callable" }, req, res), false);
  assert.equal(calls, 1);
});

test("slug normalization avoids the ambiguous repeated-edge alternation", () => {
  for (const path of ["src/core/ai/usage-log.mjs", "src/core/scoring/sourced-persistence.mjs"]) {
    const source = readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
    assert.doesNotMatch(source, /replace\(\/\^-\+\|-\+\$\/g/);
  }
});

test("edge-character trimming is linear and preserves interior separators", () => {
  assert.equal(trimEdgeCharacter("---career---rat---", "-"), "career---rat");
  assert.equal(trimEdgeCharacter("-----", "-"), "");
  assert.equal(trimEdgeCharacter("career-rat", "-"), "career-rat");
});
