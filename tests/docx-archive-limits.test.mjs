import assert from "node:assert/strict";
import { test } from "node:test";
import JSZip from "jszip";
import {
  DOCX_MAX_ENTRIES,
  DOCX_MAX_ENTRY_BYTES,
  extractDocxResumeMarkdown,
  extractDocxResumeText,
} from "../src/core/onboarding/resume-docx.mjs";

const CONTENT_TYPES =
  '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
  '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
  '<Default Extension="xml" ContentType="application/xml"/>' +
  '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>';
const RELS =
  '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
  '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>';

async function buildDocx(bodyText, extra = {}) {
  const zip = new JSZip();
  zip.file("[Content_Types].xml", CONTENT_TYPES);
  zip.file("_rels/.rels", RELS);
  zip.file(
    "word/document.xml",
    '<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
      `<w:body><w:p><w:r><w:t>${bodyText}</w:t></w:r></w:p></w:body></w:document>`
  );
  for (const [name, content] of Object.entries(extra)) zip.file(name, content);
  return zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
}

// Rewrites every declared uncompressed size (local headers and central
// directory) to 1 so metadata-only checks would see a tiny archive.
function lieAboutSizes(buf) {
  const out = Buffer.from(buf);
  for (let i = 0; i + 30 < out.length; i++) {
    if (out.readUInt32LE(i) === 0x04034b50) out.writeUInt32LE(1, i + 22);
    else if (out.readUInt32LE(i) === 0x02014b50) out.writeUInt32LE(1, i + 24);
  }
  return out;
}

for (const [label, extract] of [
  ["text", extractDocxResumeText],
  ["markdown", extractDocxResumeMarkdown],
]) {
  test(`${label}: a small valid DOCX still extracts`, async () => {
    const out = await extract(await buildDocx("Hello resume world"));
    assert.match(typeof out === "string" ? out : String(out), /Hello resume world/);
  });

  test(`${label}: a high-ratio DOCX over the entry limit is rejected`, async () => {
    const bomb = await buildDocx("x", {
      "word/bomb.bin": Buffer.alloc(DOCX_MAX_ENTRY_BYTES + 1),
    });
    assert.ok(bomb.length < 100 * 1024, "fixture stays small");
    await assert.rejects(extract(bomb), /expands beyond/);
  });

  test(`${label}: a DOCX whose headers understate sizes is still bounded by real decompression`, async () => {
    const bomb = lieAboutSizes(
      await buildDocx("x", {
        "word/bomb.bin": Buffer.alloc(DOCX_MAX_ENTRY_BYTES + 1),
      })
    );
    await assert.rejects(extract(bomb));
  });

  test(`${label}: too many entries are rejected`, async () => {
    const extra = {};
    for (let i = 0; i <= DOCX_MAX_ENTRIES; i++) extra[`word/f${i}.txt`] = "a";
    await assert.rejects(extract(await buildDocx("x", extra)), /too many entries/);
  });

  test(`${label}: many entries that together expand past the total are rejected`, async () => {
    const extra = {};
    for (let i = 0; i < 5; i++) extra[`word/b${i}.bin`] = Buffer.alloc(DOCX_MAX_ENTRY_BYTES - 1024);
    await assert.rejects(extract(await buildDocx("x", extra)), /expands beyond/);
  });
}
