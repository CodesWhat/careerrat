// tests/ai-env.test.mjs
// node:test suite for src/core/ai/ai-env.mjs — the local BYOK credential boot
// loader the onboarding wizard's AI-key step (POST /api/settings/ai-key,
// tests/onboard-route.test.mjs) writes through. Covers: dotenv-subset parse
// cases, env-always-wins precedence, write→0600 file mode, "the key value
// never appears in a return value", and rejecting a malformed key.

import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import {
  AI_ENV_RELPATH,
  loadLocalAiEnv,
  writeLocalAiKey,
  writeManagedProxyEnv,
} from "../src/core/ai/ai-env.mjs";
import { userPath } from "../src/core/paths/workspace.mjs";

function buildTempRoot() {
  return mkdtempSync(join(tmpdir(), "careerrat-ai-env-"));
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

  it("writeLocalAiKey — uses CAREERRAT_HOME/internal/ai.env when packaged home is set", () => {
    const root = buildTempRoot();
    const repoRoot = join(root, "Resources", "careerrat");
    const careerratHome = join(root, "Application Support", "CareerRat", "data");
    const env = { CAREERRAT_HOME: careerratHome };

    const result = writeLocalAiKey({
      repoRoot,
      apiKey: "sk-ant-packaged-home",
      env,
    });

    assert.equal(result.path, join(careerratHome, "internal", "ai.env"));
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

  // -------------------------------------------------------------------------
  // writeManagedProxyEnv — managed proxy credential persistence
  // -------------------------------------------------------------------------

  it("writeManagedProxyEnv — fresh write creates exactly two lines at 0600", () => {
    const root = buildTempRoot();
    const env = {};
    const token = `rlp_${"a".repeat(64)}`;

    const result = writeManagedProxyEnv({
      repoRoot: root,
      proxyUrl: "https://proxy.example.test",
      token,
      env,
    });

    assert.equal(result.ok, true);
    assert.equal(
      readFileSync(result.path, "utf8"),
      `CAREERRAT_AI_PROXY_URL=https://proxy.example.test\nCAREERRAT_AI_PROXY_TOKEN=${token}\n`
    );
    assert.equal(statSync(result.path).mode & 0o777, 0o600);
    assert.equal(env.CAREERRAT_AI_PROXY_URL, "https://proxy.example.test");
    assert.equal(env.CAREERRAT_AI_PROXY_TOKEN, token);
    rmSync(root, { recursive: true, force: true });
  });

  it("writeManagedProxyEnv — preserves unrelated lines and an Anthropic key byte-for-byte", () => {
    const root = buildTempRoot();
    const path = envFilePath(root);
    mkdirSync(join(root, ".careerrat", "internal"), { recursive: true });
    const original =
      "# keep this comment exactly\nexport OTHER_SETTING = spaced value\nANTHROPIC_API_KEY=sk-ant-existing-placeholder\nUNPARSEABLE LINE\n";
    writeFileSync(path, original, "utf8");

    writeManagedProxyEnv({
      repoRoot: root,
      proxyUrl: "https://proxy.example.test/v1",
      token: `rlp_${"b".repeat(64)}`,
      env: {},
    });

    const written = readFileSync(path, "utf8");
    assert.ok(written.startsWith(original), "all pre-existing bytes must remain in place");
    assert.equal(
      written.match(/^ANTHROPIC_API_KEY=.*$/gm)?.join("\n"),
      "ANTHROPIC_API_KEY=sk-ant-existing-placeholder"
    );
    rmSync(root, { recursive: true, force: true });
  });

  it("writeManagedProxyEnv — never introduces an Anthropic key when one is absent", () => {
    const root = buildTempRoot();

    writeManagedProxyEnv({
      repoRoot: root,
      proxyUrl: "https://proxy.example.test",
      token: `rlp_${"c".repeat(64)}`,
      env: {},
    });

    assert.doesNotMatch(readFileSync(envFilePath(root), "utf8"), /^ANTHROPIC_API_KEY=/m);
    rmSync(root, { recursive: true, force: true });
  });

  it("writeManagedProxyEnv — replaces managed keys in place without changing line order", () => {
    const root = buildTempRoot();
    const path = envFilePath(root);
    mkdirSync(join(root, ".careerrat", "internal"), { recursive: true });
    writeFileSync(
      path,
      "BEFORE=one\nCAREERRAT_AI_PROXY_TOKEN=old-token\nMIDDLE=two\nCAREERRAT_AI_PROXY_URL=https://old.example.test\nAFTER=three\n",
      "utf8"
    );

    writeManagedProxyEnv({
      repoRoot: root,
      proxyUrl: "https://new.example.test",
      token: `rlp_${"d".repeat(64)}`,
      env: {},
    });

    assert.deepEqual(readFileSync(path, "utf8").trimEnd().split("\n"), [
      "BEFORE=one",
      `CAREERRAT_AI_PROXY_TOKEN=rlp_${"d".repeat(64)}`,
      "MIDDLE=two",
      "CAREERRAT_AI_PROXY_URL=https://new.example.test",
      "AFTER=three",
    ]);
    rmSync(root, { recursive: true, force: true });
  });

  it("writeManagedProxyEnv — migrates a legacy ROLESTER_AI_PROXY_URL/TOKEN line to the new key in place", () => {
    const root = buildTempRoot();
    const path = envFilePath(root);
    mkdirSync(join(root, ".careerrat", "internal"), { recursive: true });
    writeFileSync(
      path,
      "BEFORE=one\nROLESTER_AI_PROXY_TOKEN=old-token\nMIDDLE=two\nROLESTER_AI_PROXY_URL=https://old.example.test\nAFTER=three\n",
      "utf8"
    );

    writeManagedProxyEnv({
      repoRoot: root,
      proxyUrl: "https://new.example.test",
      token: `rlp_${"e".repeat(64)}`,
      env: {},
    });

    assert.deepEqual(readFileSync(path, "utf8").trimEnd().split("\n"), [
      "BEFORE=one",
      `CAREERRAT_AI_PROXY_TOKEN=rlp_${"e".repeat(64)}`,
      "MIDDLE=two",
      "CAREERRAT_AI_PROXY_URL=https://new.example.test",
      "AFTER=three",
    ]);
    rmSync(root, { recursive: true, force: true });
  });

  for (const [name, proxyUrl, token, error] of [
    ["non-loopback HTTP", "http://proxy.example.test", "token", /proxyUrl/],
    ["garbage URL", "not a URL", "token", /proxyUrl/],
    ["empty token", "https://proxy.example.test", "", /non-empty/],
    ["non-string token", "https://proxy.example.test", 123, /non-empty/],
  ]) {
    it(`writeManagedProxyEnv — rejects ${name}`, () => {
      const root = buildTempRoot();
      assert.throws(
        () => writeManagedProxyEnv({ repoRoot: root, proxyUrl, token, env: {} }),
        error
      );
      rmSync(root, { recursive: true, force: true });
    });
  }

  for (const proxyUrl of ["http://127.0.0.1:3000", "http://localhost:3000"]) {
    it(`writeManagedProxyEnv — accepts loopback development URL ${proxyUrl}`, () => {
      const root = buildTempRoot();
      const env = {};
      writeManagedProxyEnv({ repoRoot: root, proxyUrl, token: "fake-token", env });
      assert.equal(env.CAREERRAT_AI_PROXY_URL, proxyUrl);
      rmSync(root, { recursive: true, force: true });
    });
  }
});
