// tests/resume-extract.test.mjs
// node:test suite for the M8 resume-extract skill (.agents/skills/resume-
// extract/SKILL.md) — the backend of POST /api/onboard/resume-ai
// (src/cli/onboard-route.mjs), which is already covered end-to-end against a
// MOCKED runtime in tests/onboard-route.test.mjs. This file covers the one
// thing that can't be mocked: whether the REAL SKILL.md, read by a REAL
// model over the REAL embedded runtime (src/core/ai/skill-runtime.mjs's
// runSkillStream), actually produces schema-valid structured output from a
// real PDF. Gated `skip: !process.env.ANTHROPIC_API_KEY` — the mocked-runtime
// suites above need no network/key and always run; this one only runs when a
// live key is present (mirrors tests/skill-runtime.test.mjs's own
// "INTEGRATION (skipped without ANTHROPIC_API_KEY)" ping test).
//
// The fixture is a hand-built, spec-minimal single-page PDF (Catalog/Pages/
// Page/Font objects + one content stream + a byte-accurate xref table),
// generated programmatically here rather than checking in a binary fixture
// — buildMinimalPdf()'s own byte-offset math is verified by a plain
// deterministic unit test below, so the live test only spends a real model
// call on the one thing that's actually worth verifying live: SKILL.md
// end-to-end against a real PDF.

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { runSkillStream } from "../src/core/ai/skill-runtime.mjs";
import { runStructuredOneshot } from "../src/core/ai/structured-oneshot.mjs";
import { validate } from "../src/core/profile/schema-validator.mjs";

const REAL_ROOT = fileURLToPath(new URL("..", import.meta.url));

// ---------------------------------------------------------------------------
// buildMinimalPdf — a spec-minimal, byte-offset-accurate single-page PDF.
// Pure and deterministic: no I/O.
// ---------------------------------------------------------------------------

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

test("buildMinimalPdf: every object's xref offset points at that object's own 'N 0 obj' header", () => {
  const { bytes, objOffsets } = buildMinimalPdf(["Jane Doe", "jane.doe@example.com"]);
  for (let i = 1; i <= 5; i++) {
    const slice = bytes
      .subarray(objOffsets[i], objOffsets[i] + `${i} 0 obj`.length)
      .toString("latin1");
    assert.equal(slice, `${i} 0 obj`, `object ${i}'s xref offset must land exactly on its header`);
  }
});

test("buildMinimalPdf: the xref offset lands exactly on the literal 'xref' keyword", () => {
  const { bytes, xrefOffset } = buildMinimalPdf(["hello"]);
  assert.equal(bytes.subarray(xrefOffset, xrefOffset + 4).toString("latin1"), "xref");
});

test("buildMinimalPdf: starts with the %PDF-1.4 header and ends with %%EOF", () => {
  const { bytes } = buildMinimalPdf(["hello"]);
  assert.equal(bytes.subarray(0, 8).toString("latin1"), "%PDF-1.4");
  assert.equal(bytes.subarray(-6).toString("latin1"), "%%EOF\n");
});

test("buildMinimalPdf: escapes parens and backslashes in body text so the content stream stays well-formed", () => {
  const { bytes } = buildMinimalPdf(["(unbalanced paren"]);
  assert.match(bytes.toString("latin1"), /\\\(unbalanced paren/);
});

// ---------------------------------------------------------------------------
// INTEGRATION (skipped without ANTHROPIC_API_KEY) — the real skill, over the
// real embedded runtime, against the fixture PDF above.
// ---------------------------------------------------------------------------

test("INTEGRATION (skipped without ANTHROPIC_API_KEY): resume-extract reads a real PDF and emits schema-valid structured output", {
  skip: !process.env.ANTHROPIC_API_KEY,
}, async () => {
  // A temp repoRoot carrying only the real resume-extract/SKILL.md (copied
  // verbatim, never re-typed) — mirrors skill-runtime.test.mjs's own
  // INTEGRATION test's "ping" fixture pattern: a minimal throwaway repoRoot
  // rather than pointing the live call at this checkout's full tree.
  const repoRoot = mkdtempSync(join(tmpdir(), "rolester-resume-extract-live-"));
  const skillDir = join(repoRoot, ".agents/skills/resume-extract");
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(
    join(skillDir, "SKILL.md"),
    readFileSync(join(REAL_ROOT, ".agents/skills/resume-extract/SKILL.md"), "utf8"),
    "utf8"
  );

  const fixtureDir = mkdtempSync(join(tmpdir(), "rolester-resume-extract-fixture-"));
  const pdfPath = join(fixtureDir, "resume.pdf");
  const { bytes } = buildMinimalPdf([
    "Jane Doe",
    "jane.doe@example.test",
    "",
    "Experience",
    "Led a team of 5 engineers to ship a payments platform rewrite.",
    "",
    "Skills",
    "Python, JavaScript, SQL",
  ]);
  writeFileSync(pdfPath, bytes);

  const schema = JSON.parse(
    readFileSync(join(REAL_ROOT, "config/resume-extract.schema.json"), "utf8")
  );

  try {
    async function invokeResumeExtract({ correction }) {
      let rawText = "";
      await runSkillStream({
        skill: "resume-extract",
        input: correction
          ? `Read the file at this exact path: ${pdfPath}\n\n${correction}`
          : { path: pdfPath },
        repoRoot,
        env: { ...process.env, ROLESTER_RUNTIME_SKILLS: "resume-extract" },
        tools: ["Read"],
        onEvent: (evt) => {
          if (evt.type !== "assistant") return;
          for (const block of evt.data?.message?.content ?? []) {
            if (block?.type === "text" && typeof block.text === "string") {
              rawText += block.text;
            }
          }
        },
      });
      return rawText;
    }

    const outcome = await runStructuredOneshot({
      schema,
      maxRetries: 1,
      invoke: invokeResumeExtract,
    });
    assert.equal(
      outcome.ok,
      true,
      `expected schema-valid output; got raw: ${outcome.raw?.slice(0, 500)}`
    );

    // Belt-and-braces: re-validate independently of runStructuredOneshot's
    // own internal check, against the exact checked-in schema file.
    const { valid, errors } = validate(outcome.data, schema);
    assert.equal(valid, true, JSON.stringify(errors));

    assert.equal(outcome.data.candidate.email, "jane.doe@example.test");
    assert.ok(outcome.data.sections.experience >= 1);
    assert.ok(Array.isArray(outcome.data.claims) && outcome.data.claims.length >= 1);
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
    rmSync(fixtureDir, { recursive: true, force: true });
  }
});
