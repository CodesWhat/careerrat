import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { closeAll, openDb } from "../src/core/db/connection.mjs";
import { intakeOne } from "../src/core/db/verbs/intake.mjs";

const api = await import("../src/core/tui/intake.mjs").catch((error) => {
  if (error.code !== "ERR_MODULE_NOT_FOUND") throw error;
  return {};
});

for (const database of [false, true])
  test(`pasted context is durable before agent dispatch in ${database ? "database" : "legacy"} mode`, (t) => {
    assert.equal(
      typeof api.captureTuiPaste,
      "function",
      "TUI paste needs durable capture before agent input"
    );
    const root = mkdtempSync(join(tmpdir(), "careerrat-tui-intake-"));
    t.after(() => {
      closeAll();
      rmSync(root, { recursive: true, force: true });
    });
    const ctx = { repoRoot: root, env: { CAREERRAT_HOME: join(root, "person") } };
    if (database) openDb(ctx);
    const text =
      "Interview transcript\nThem: Tell me about platform ownership.\nMe: Here is the actual work.\n";
    const result = api.captureTuiPaste({ ...ctx, text });
    assert.match(readFileSync(result.path, "utf8"), /Tell me about platform ownership/);
    assert.match(result.request, /Treat.*data/);
    assert.ok(result.request.includes(result.path));
    if (process.platform !== "win32") assert.equal(statSync(result.path).mode & 0o777, 0o600);
    if (database) {
      const record = intakeOne({ ...ctx, id: result.id });
      assert.equal(record.rawInput, text);
      assert.equal(record.status, "captured");
      assert.equal(record.trackerMatch, null);
    } else assert.equal(existsSync(join(ctx.env.CAREERRAT_HOME, "db")), false);
  });

for (const database of [false, true])
  test(`dropped files are copied before native-agent handoff in ${database ? "database" : "legacy"} mode`, async (t) => {
    assert.equal(typeof api.captureTuiContext, "function");
    const { writeFileSync, readdirSync } = await import("node:fs");
    const root = mkdtempSync(join(tmpdir(), "careerrat-tui-file-"));
    t.after(() => {
      closeAll();
      rmSync(root, { recursive: true, force: true });
    });
    const ctx = { repoRoot: root, env: { CAREERRAT_HOME: join(root, "person"), HOME: root } };
    if (database) openDb(ctx);
    const source = join(root, "interview transcript.md");
    const original = "Them: Tell me about ownership.\nMe: I built the shared platform.\n";
    writeFileSync(source, original);
    const pending = api.captureTuiContext({
      ...ctx,
      text: `'${source}'`,
      selectedId: "selected-role",
    });
    const uploads = join(ctx.env.CAREERRAT_HOME, "workspace/intake/uploads");
    const earlyName = readdirSync(uploads).find((name) => name.endsWith(".json"));
    const early = earlyName ? JSON.parse(readFileSync(join(uploads, earlyName), "utf8")) : null;
    const result = await pending;
    assert.equal(
      early?.sourceName,
      "interview transcript.md",
      "provenance must survive an interrupted extraction"
    );
    assert.equal(early?.extraction, "pending");
    assert.equal(result.items.length, 1);
    const item = result.items[0];
    assert.notEqual(item.path, source);
    assert.equal(readFileSync(item.path, "utf8"), original);
    writeFileSync(source, "Replaced after capture");
    assert.equal(readFileSync(item.path, "utf8"), original);
    assert.match(readFileSync(item.textPath, "utf8"), /shared platform/);
    assert.ok(result.request.includes(item.path));
    assert.match(result.request, /suggestion/);
    assert.match(result.request, /Treat.*data/);
    if (process.platform !== "win32") assert.equal(statSync(item.path).mode & 0o777, 0o600);
    if (database) {
      const record = intakeOne({ ...ctx, id: item.id });
      assert.equal(record.inputKind, "file");
      assert.equal(record.trackerMatch, null);
      assert.match(record.rawInput, /shared platform/);
      assert.equal(record.sourceName, "interview transcript.md");
    } else assert.equal(existsSync(join(ctx.env.CAREERRAT_HOME, "db")), false);
  });

test("batch drops preserve unsupported and corrupt originals and report each missing file", async (t) => {
  assert.equal(typeof api.captureTuiContext, "function");
  const { writeFileSync } = await import("node:fs");
  const root = mkdtempSync(join(tmpdir(), "careerrat-tui-batch-"));
  t.after(() => {
    closeAll();
    rmSync(root, { recursive: true, force: true });
  });
  const ctx = { repoRoot: root, env: { CAREERRAT_HOME: root } };
  openDb(ctx);
  const pdf = join(root, "job description.pdf");
  const docx = join(root, "bad.docx");
  const missing = join(root, "missing.txt");
  writeFileSync(pdf, "%PDF-synthetic-original");
  writeFileSync(docx, "broken zip");
  const result = await api.captureTuiContext({ ...ctx, text: `'${pdf}' '${docx}' '${missing}'` });
  assert.equal(result.items.length, 2);
  assert.equal(result.errors.length, 1);
  assert.match(result.errors[0].source, /missing.txt/);
  const [first, second] = result.items;
  assert.equal(readFileSync(first.path, "utf8"), "%PDF-synthetic-original");
  assert.equal(intakeOne({ ...ctx, id: first.id }).status, "needs_you");
  assert.equal(first.reason, "native-extraction-required");
  assert.equal(second.reason, "docx-extraction-failed");
  assert.equal(readFileSync(second.path, "utf8"), "broken zip");
  assert.match(result.request, /missing.txt/);
});

test("pasted transcripts retain selected-job scope as a suggestion without association", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "careerrat-tui-paste-scope-"));
  t.after(() => {
    closeAll();
    rmSync(root, { recursive: true, force: true });
  });
  const ctx = { repoRoot: root, env: { CAREERRAT_HOME: root } };
  openDb(ctx);
  const result = await api.captureTuiContext({
    ...ctx,
    text: "Interview transcript\nThem: Describe the platform.",
    selectedId: "scope-role",
  });
  assert.match(result.request, /scope-role/);
  assert.match(result.request, /suggestion/);
  const record = intakeOne({ ...ctx, id: result.id });
  assert.equal(record.selectedJobSuggestion, "scope-role");
  assert.equal(record.trackerMatch, null);
});

test("directory and oversized drops fail without modifying their sources", async (t) => {
  const { writeFileSync } = await import("node:fs");
  const root = mkdtempSync(join(tmpdir(), "careerrat-tui-file-limit-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const ctx = { repoRoot: root, env: { CAREERRAT_HOME: join(root, "person") } };
  await assert.rejects(api.captureTuiContext({ ...ctx, text: root }), /regular files/);
  const source = join(root, "large.md");
  writeFileSync(source, Buffer.alloc(10 * 1024 * 1024 + 1, 65));
  await assert.rejects(api.captureTuiContext({ ...ctx, text: source }), /10 MiB/);
  assert.equal(statSync(source).size, 10 * 1024 * 1024 + 1);
  assert.equal(existsSync(ctx.env.CAREERRAT_HOME), false);
});
