// tests/intake-extract.test.mjs
// node:test suite for the intake-extract skill (.agents/skills/intake-extract/
// SKILL.md) — the backend of POST /api/intake/upload's PDF/image branch
// (src/cli/intake-route.mjs), which is already covered end-to-end against a
// MOCKED runtime in tests/intake-route.test.mjs. This file mirrors
// tests/resume-extract.test.mjs's structure: a plain deterministic schema
// check (always runs, no network) plus a live-model-gated INTEGRATION test
// that runs the REAL SKILL.md, read by a REAL model over the REAL embedded
// runtime (src/core/ai/skill-runtime.mjs's runSkillStream), against a
// programmatically-built fixture PDF. Gated `skip: !process.env.ANTHROPIC_API_KEY`
// — same convention as tests/resume-extract.test.mjs / tests/intake-classify.test.mjs.
//
// The fixture PDF reuses buildMinimalPdf() from tests/fixtures/pdf.mjs — the
// same builder tests/resume-extract.test.mjs uses, hoisted out to a shared,
// non-test module once this file became its second caller (its own
// byte-offset math is covered by resume-extract.test.mjs's deterministic
// unit tests; no need to duplicate those here).

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { runSkillStream } from "../src/core/ai/skill-runtime.mjs";
import { runStructuredOneshot } from "../src/core/ai/structured-oneshot.mjs";
import { validate } from "../src/core/profile/schema-validator.mjs";
import { buildMinimalPdf } from "./fixtures/pdf.mjs";

const REAL_ROOT = fileURLToPath(new URL("..", import.meta.url));

// ---------------------------------------------------------------------------
// Plain deterministic checks — no network, always run in CI.
// ---------------------------------------------------------------------------

test("intake-extract schema requires full_text and rejects extra fields", () => {
  const schema = JSON.parse(
    readFileSync(join(REAL_ROOT, "config/intake-extract.schema.json"), "utf8")
  );

  assert.equal(validate({ full_text: "" }, schema).valid, true);
  assert.equal(validate({ full_text: "Subject: hi\n\nbody" }, schema).valid, true);

  const missing = validate({}, schema);
  assert.equal(missing.valid, false);

  const extra = validate({ full_text: "hi", candidate: {} }, schema);
  assert.equal(extra.valid, false);
});

test("buildMinimalPdf fixture (shared with tests/resume-extract.test.mjs via tests/fixtures/pdf.mjs) produces bytes starting with the PDF header", () => {
  const { bytes } = buildMinimalPdf(["Subject: Staff Engineer at Acme", "We are hiring."]);
  assert.equal(bytes.subarray(0, 5).toString("latin1"), "%PDF-");
});

// ---------------------------------------------------------------------------
// INTEGRATION (skipped without ANTHROPIC_API_KEY) — the real skill, over the
// real embedded runtime, against the fixture PDF above.
// ---------------------------------------------------------------------------

test("INTEGRATION (skipped without ANTHROPIC_API_KEY): intake-extract reads a real PDF and emits schema-valid structured output", {
  skip: !process.env.ANTHROPIC_API_KEY,
}, async () => {
  const repoRoot = mkdtempSync(join(tmpdir(), "careerrat-intake-extract-live-"));
  const skillDir = join(repoRoot, ".agents/skills/intake-extract");
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(
    join(skillDir, "SKILL.md"),
    readFileSync(join(REAL_ROOT, ".agents/skills/intake-extract/SKILL.md"), "utf8"),
    "utf8"
  );

  const fixtureDir = mkdtempSync(join(tmpdir(), "careerrat-intake-extract-fixture-"));
  const pdfPath = join(fixtureDir, "upload.pdf");
  const { bytes } = buildMinimalPdf([
    "Subject: Staff Engineer at Acme",
    "",
    "We are hiring a Staff Engineer to own our core platform reliability.",
  ]);
  writeFileSync(pdfPath, bytes);

  const schema = JSON.parse(
    readFileSync(join(REAL_ROOT, "config/intake-extract.schema.json"), "utf8")
  );

  try {
    async function invokeIntakeExtract({ correction }) {
      let rawText = "";
      await runSkillStream({
        skill: "intake-extract",
        input: correction
          ? `Read the file at this exact path: ${pdfPath}\n\n${correction}`
          : { path: pdfPath },
        repoRoot,
        env: { ...process.env, CAREERRAT_RUNTIME_SKILLS: "intake-extract" },
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
      invoke: invokeIntakeExtract,
    });
    assert.equal(
      outcome.ok,
      true,
      `expected schema-valid output; got raw: ${outcome.raw?.slice(0, 500)}`
    );

    const { valid, errors } = validate(outcome.data, schema);
    assert.equal(valid, true, JSON.stringify(errors));

    assert.match(outcome.data.full_text, /Staff Engineer/);
    assert.match(outcome.data.full_text, /Acme/);
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
    rmSync(fixtureDir, { recursive: true, force: true });
  }
});
