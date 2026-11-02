import assert from "node:assert/strict";
import { test } from "node:test";
import JSZip from "jszip";

const api = await import("../src/core/intake/file-text.mjs").catch((error) => {
  if (error.code !== "ERR_MODULE_NOT_FOUND") throw error;
  return {};
});
const extract = (ext, bytes) => {
  assert.equal(typeof api.extractLocalIntakeText, "function");
  return api.extractLocalIntakeText({
    ext,
    bytes: Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes),
  });
};
test("shared local intake extraction preserves text and decodes recruiter email bodies", async () => {
  assert.equal(
    (await extract(".md", "Transcript\r\nInterviewer: Describe ownership.")).text,
    "Transcript\nInterviewer: Describe ownership."
  );
  const result = await extract(
    ".eml",
    "From: Recruiting <recruiter@example.test>\r\nSubject: Next round\r\nContent-Transfer-Encoding: base64\r\n\r\n" +
      Buffer.from("Please share availability.").toString("base64")
  );
  assert.equal(result.ok, true);
  assert.match(result.text, /Subject: Next round/);
  assert.match(result.text, /Please share availability/);
});
test("shared extractor reads a real DOCX and reports corrupt or unsupported originals", async () => {
  const zip = new JSZip();
  zip.file(
    "[Content_Types].xml",
    '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>'
  );
  zip.file(
    "_rels/.rels",
    '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>'
  );
  zip.file(
    "word/document.xml",
    '<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Built a shared platform.</w:t></w:r></w:p></w:body></w:document>'
  );
  const result = await extract(".docx", await zip.generateAsync({ type: "nodebuffer" }));
  assert.equal(result.ok, true);
  assert.match(result.text, /Built a shared platform/);
  assert.equal((await extract(".docx", "not a document")).reason, "docx-extraction-failed");
  assert.equal((await extract(".pdf", "%PDF-synthetic")).reason, "unsupported-type");
});
