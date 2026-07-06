// tests/ai-env.test.mjs
// node:test suite for src/core/ai/ai-env.mjs — the local BYOK credential boot
// loader the onboarding wizard's AI-key step (POST /api/settings/ai-key,
// tests/onboard-route.test.mjs) writes through. Covers: dotenv-subset parse
// cases, env-always-wins precedence, write→0600 file mode, "the key value
// never appears in a return value", and rejecting a malformed key.

import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { AI_ENV_RELPATH, loadLocalAiEnv, writeLocalAiKey } from "../src/core/ai/ai-env.mjs";
import { userPath } from "../src/core/paths/workspace.mjs";

function buildTempRoot() {
  return mkdtempSync(join(tmpdir(), "rolester-ai-env-"));
}

function envFilePath(root) {
  return userPath({ repoRoot: root }, AI_ENV_RELPATH);
}

describe("ai-env", () => {
  let tempRoot;

  before(() => {
    tempRoot = buildTempRoot();
  });

  after(() => {
    try {
      rmSync(tempRoot, { recursive: true, force: true });
    } catch {
      // best-effort cleanup
    }
  });

  // -------------------------------------------------------------------------
  // loadLocalAiEnv — parse cases
  // -------------------------------------------------------------------------

  it("loadLocalAiEnv — returns empty loaded[] when the file doesn't exist", () => {
    const root = buildTempRoot();
    const env = {};
    const result = loadLocalAiEnv({ repoRoot: root, env });
    assert.deepEqual(result.loaded, []);
    assert.deepEqual(env, {});
    rmSync(root, { recursive: true, force: true });
  });

  it("loadLocalAiEnv — parses KEY=value, export-prefixed, comments, and blank lines", () => {
    const root = buildTempRoot();
    const path = envFilePath(root);
    writeLocalAiKey({ repoRoot: root, apiKey: "sk-ant-placeholder", env: {} });
    // writeLocalAiKey already wrote a valid ANTHROPIC_API_KEY line — extend the
    // file by hand with the other parse shapes this test wants to cover.
    const existing = readFileSync(path, "utf8");
    const extended = `# a full-line comment\nexport SOME_OTHER_KEY=hello world\n\n${existing}`;
    writeFileSync(path, extended, "utf8");

    const env = {};
    const result = loadLocalAiEnv({ repoRoot: root, env });
    assert.ok(result.loaded.includes("SOME_OTHER_KEY"));
    assert.ok(result.loaded.includes("ANTHROPIC_API_KEY"));
    assert.equal(env.SOME_OTHER_KEY, "hello world");
    assert.equal(env.ANTHROPIC_API_KEY, "sk-ant-placeholder");
    rmSync(root, { recursive: true, force: true });
  });

  it("loadLocalAiEnv — env always wins over the stored file", () => {
    const root = buildTempRoot();
    writeLocalAiKey({ repoRoot: root, apiKey: "sk-ant-from-file", env: {} });

    const env = { ANTHROPIC_API_KEY: "sk-ant-from-shell" };
    const result = loadLocalAiEnv({ repoRoot: root, env });
    // The key was already set, so it's not reported as newly loaded, and the
    // pre-existing value is left completely untouched.
    assert.ok(!result.loaded.includes("ANTHROPIC_API_KEY"));
    assert.equal(env.ANTHROPIC_API_KEY, "sk-ant-from-shell");
    rmSync(root, { recursive: true, force: true });
  });

  it("loadLocalAiEnv — return value never contains the key VALUE, only the key NAME", () => {
    const root = buildTempRoot();
    writeLocalAiKey({ repoRoot: root, apiKey: "sk-ant-super-secret-value", env: {} });

    const env = {};
    const result = loadLocalAiEnv({ repoRoot: root, env });
    const serialized = JSON.stringify(result);
    assert.ok(!serialized.includes("sk-ant-super-secret-value"));
    assert.deepEqual(result.loaded, ["ANTHROPIC_API_KEY"]);
    rmSync(root, { recursive: true, force: true });
  });

  // -------------------------------------------------------------------------
  // writeLocalAiKey — validation + 0600 + never-returns-the-value
  // -------------------------------------------------------------------------

  it("writeLocalAiKey — writes the file at 0600 and sets env immediately", () => {
    const root = buildTempRoot();
    const env = {};
    const result = writeLocalAiKey({ repoRoot: root, apiKey: "sk-ant-abc123", env });

    assert.equal(result.ok, true);
    assert.ok(existsSync(result.path));
    const mode = statSync(result.path).mode & 0o777;
    assert.equal(mode, 0o600, `expected mode 0600, got ${mode.toString(8)}`);
    assert.equal(env.ANTHROPIC_API_KEY, "sk-ant-abc123");
    rmSync(root, { recursive: true, force: true });
  });

  it("writeLocalAiKey — uses ROLESTER_HOME/internal/ai.env when packaged home is set", () => {
    const root = buildTempRoot();
    const repoRoot = join(root, "Resources", "rolester");
    const rolesterHome = join(root, "Application Support", "Rolester", "data");
    const env = { ROLESTER_HOME: rolesterHome };

    const result = writeLocalAiKey({
      repoRoot,
      apiKey: "sk-ant-packaged-home",
      env,
    });

    assert.equal(result.path, join(rolesterHome, "internal", "ai.env"));
    assert.equal(statSync(result.path).mode & 0o777, 0o600);
    assert.equal(existsSync(join(repoRoot, ".internal", "ai.env")), false);
    assert.equal(JSON.stringify(result).includes("sk-ant-packaged-home"), false);
    rmSync(root, { recursive: true, force: true });
  });

  it("writeLocalAiKey — return value never contains the key VALUE", () => {
    const root = buildTempRoot();
    const result = writeLocalAiKey({
      repoRoot: root,
      apiKey: "sk-ant-should-never-be-returned",
      env: {},
    });
    const serialized = JSON.stringify(result);
    assert.ok(!serialized.includes("sk-ant-should-never-be-returned"));
    rmSync(root, { recursive: true, force: true });
  });

  it("writeLocalAiKey — preserves unrelated existing lines and replaces a prior ANTHROPIC_API_KEY line", () => {
    const root = buildTempRoot();
    const env = {};
    writeLocalAiKey({ repoRoot: root, apiKey: "sk-ant-first", env });
    const path = envFilePath(root);
    const beforeSecond = readFileSync(path, "utf8");
    // Hand-append an unrelated line the second write must round-trip untouched.
    writeFileSync(path, `${beforeSecond}OTHER_VAR=keep-me\n`, "utf8");

    writeLocalAiKey({ repoRoot: root, apiKey: "sk-ant-second", env });
    const after2 = readFileSync(path, "utf8");
    assert.ok(after2.includes("OTHER_VAR=keep-me"), "unrelated line must survive");
    assert.ok(after2.includes("ANTHROPIC_API_KEY=sk-ant-second"), "key line must be replaced");
    assert.ok(!after2.includes("sk-ant-first"), "the old key value must be gone, not duplicated");
    assert.equal(env.ANTHROPIC_API_KEY, "sk-ant-second");
    rmSync(root, { recursive: true, force: true });
  });

  it("writeLocalAiKey — rejects an empty key", () => {
    const root = buildTempRoot();
    assert.throws(() => writeLocalAiKey({ repoRoot: root, apiKey: "", env: {} }), /non-empty/);
    rmSync(root, { recursive: true, force: true });
  });

  it("writeLocalAiKey — rejects a key containing whitespace", () => {
    const root = buildTempRoot();
    assert.throws(
      () => writeLocalAiKey({ repoRoot: root, apiKey: "sk-ant has a space", env: {} }),
      /whitespace/
    );
    rmSync(root, { recursive: true, force: true });
  });

  it("writeLocalAiKey — rejects a key containing a newline", () => {
    const root = buildTempRoot();
    assert.throws(
      () => writeLocalAiKey({ repoRoot: root, apiKey: "sk-ant-abc\nmalicious-line=1", env: {} }),
      /whitespace/
    );
    rmSync(root, { recursive: true, force: true });
  });
});
