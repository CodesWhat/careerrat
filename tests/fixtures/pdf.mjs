// tests/fixtures/pdf.mjs — buildMinimalPdf(), hoisted out of
// tests/resume-extract.test.mjs (which introduced it) once a second caller
// (tests/intake-extract.test.mjs) needed the same fixture. A spec-minimal,
// byte-offset-accurate single-page PDF (Catalog/Pages/Page/Font objects + one
// content stream + a byte-accurate xref table), generated programmatically
// rather than checking in a binary fixture. Pure and deterministic — no I/O.
//
// Deliberately a plain .mjs module, not a *.test.mjs file: importing a
// *.test.mjs file from another test file would re-register (and re-run) its
// own `test(...)` calls as a side effect of the import, under Node's test
// runner. This file has none of its own — both callers own their own
// buildMinimalPdf assertions.

function escapePdfText(str) {
  return String(str).replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");
}

export function buildMinimalPdf(bodyLines) {
  const parts = [];
  let offset = 0;
  const objOffsets = {};
  function push(str) {
    parts.push(str);
    offset += str.length;
  }

  push("%PDF-1.4\n");

  objOffsets[1] = offset;
  push("1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n");

  objOffsets[2] = offset;
  push("2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n");

  objOffsets[3] = offset;
  push(
    "3 0 obj\n<< /Type /Page /Parent 2 0 R /Resources << /Font << /F1 4 0 R >> >> " +
      "/MediaBox [0 0 612 792] /Contents 5 0 R >>\nendobj\n"
  );

  objOffsets[4] = offset;
  push("4 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n");

  const contentLines = bodyLines
    .map((line, i) =>
      i === 0
        ? `72 720 Td\n(${escapePdfText(line)}) Tj\n`
        : `0 -18 Td\n(${escapePdfText(line)}) Tj\n`
    )
    .join("");
  const streamBody = `BT\n/F1 12 Tf\n${contentLines}ET\n`;
  objOffsets[5] = offset;
  push(`5 0 obj\n<< /Length ${streamBody.length} >>\nstream\n${streamBody}endstream\nendobj\n`);

  const xrefOffset = offset;
  let xref = "xref\n0 6\n0000000000 65535 f \n";
  for (let i = 1; i <= 5; i++) {
    xref += `${String(objOffsets[i]).padStart(10, "0")} 00000 n \n`;
  }
  push(xref);
  push(`trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`);

  return { bytes: Buffer.from(parts.join(""), "latin1"), objOffsets, xrefOffset };
}
