import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  buildInstalledRuntimeInvocation,
  detectInstalledRuntimes,
  INSTALLED_RUNTIME_DEFINITIONS,
  openInstalledRuntimeTerminal,
  probeInstalledRuntime,
  runInstalledRuntime,
  runtimeSearchDirectories,
} from "../src/core/ai/installed-runtimes.mjs";
import {
  loadInstalledRuntimeSelection,
  writeInstalledRuntimeSelection,
} from "../src/core/ai/runtime-selection.mjs";

function tempRoot() {
  return mkdtempSync(join(tmpdir(), "rolester-installed-runtime-"));
}

function executable(path) {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, "#!/bin/sh\nexit 0\n", "utf8");
  chmodSync(path, 0o755);
}

test("runtime registry covers the supported installed CLI set", () => {
  assert.deepEqual(
    INSTALLED_RUNTIME_DEFINITIONS.map(({ id }) => id),
    ["claude", "codex", "gemini", "opencode", "copilot", "qwen", "antigravity", "grok"]
  );
  for (const definition of INSTALLED_RUNTIME_DEFINITIONS) {
    assert.ok(definition.name);
    assert.ok(definition.commandShape);
    assert.ok(definition.binaries.length >= 1);
    assert.ok(definition.authProbe.args.length >= 1);
  }
});

test("runtime search adds Finder-safe user and package-manager directories", () => {
  const dirs = runtimeSearchDirectories({
    env: { PATH: "/finder/bin:/usr/bin", NPM_CONFIG_PREFIX: "/custom/npm" },
    platform: "darwin",
    homeDir: "/Users/morgan",
  });

  for (const expected of [
    "/finder/bin",
    "/usr/bin",
    "/Users/morgan/.local/bin",
    "/Users/morgan/.npm-global/bin",
    "/Users/morgan/.bun/bin",
    "/custom/npm/bin",
    "/opt/homebrew/bin",
    "/usr/local/bin",
  ]) {
    assert.ok(dirs.includes(expected), `missing ${expected}`);
  }
  assert.equal(new Set(dirs).size, dirs.length);
});

test("detectInstalledRuntimes finds multiple CLIs outside the inherited PATH", () => {
  const root = tempRoot();
  const homeDir = join(root, "home");
  const brewDir = join(root, "brew", "bin");
  const claudePath = join(homeDir, ".local", "bin", "claude");
  const codexPath = join(brewDir, "codex");
  executable(claudePath);
  executable(codexPath);
  try {
    const inventory = detectInstalledRuntimes({
      env: { PATH: "", ROLESTER_RUNTIME_EXTRA_PATHS: brewDir },
      platform: "darwin",
      homeDir,
    });
    assert.equal(inventory.find(({ id }) => id === "claude").path, claudePath);
    assert.equal(inventory.find(({ id }) => id === "codex").path, codexPath);
    assert.equal(inventory.find(({ id }) => id === "gemini").available, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("auth probe exposes only bounded readiness state, never CLI account output", () => {
  const calls = [];
  const ready = probeInstalledRuntime(
    { id: "codex", path: "/safe/codex", available: true },
    {
      spawnSyncImpl(executablePath, args, options) {
        calls.push({ executablePath, args, options });
        return { status: 0, stdout: "Logged in as morgan@example.com", stderr: "" };
      },
    }
  );
  assert.deepEqual(ready, { status: "ready", ready: true, action: null });
  assert.equal(JSON.stringify(ready).includes("morgan@example.com"), false);
  assert.equal(calls[0].executablePath, "/safe/codex");
  assert.deepEqual(calls[0].args, ["login", "status"]);
  assert.equal(calls[0].options.shell, false);
  assert.ok(calls[0].options.timeout > 0);

  const signedOut = probeInstalledRuntime(
    { id: "claude", path: "/safe/claude", available: true },
    { spawnSyncImpl: () => ({ status: 1, stdout: "", stderr: "email secret" }) }
  );
  assert.deepEqual(signedOut, {
    status: "authentication_required",
    ready: false,
    action: "open_terminal",
  });
  assert.equal(JSON.stringify(signedOut).includes("secret"), false);
});

test("fixed invocation adapters pass prompts on stdin and never use a shell", () => {
  const claude = buildInstalledRuntimeInvocation({
    runtimeId: "claude",
    executablePath: "/safe/claude",
    schema: {
      $schema: "https://json-schema.org/draft/2020-12/schema",
      $id: "https://rolester.local/schema.json",
      type: "object",
      maxProperties: 2,
    },
    model: "sonnet",
    tools: ["Read"],
  });
  assert.equal(claude.command, "/safe/claude");
  assert.equal(claude.options.shell, false);
  assert.equal(claude.stdin, true);
  assert.ok(claude.args.includes("--json-schema"));
  const claudeSchema = JSON.parse(claude.args[claude.args.indexOf("--json-schema") + 1]);
  assert.equal(claudeSchema.$schema, undefined);
  assert.equal(claudeSchema.$id, undefined);
  assert.equal(claudeSchema.maxProperties, 2);
  assert.ok(
    claude.args.includes("--safe-mode"),
    "headless app calls must not inherit project hooks, MCP servers, or CLAUDE.md context"
  );
  assert.ok(claude.args.includes("--no-session-persistence"));
  assert.ok(claude.args.includes("--permission-mode"));
  assert.deepEqual(
    claude.args.slice(claude.args.indexOf("--tools"), claude.args.indexOf("--tools") + 4),
    ["--tools", "Read", "--allowedTools", "Read"]
  );
  assert.equal(claude.args.includes("PROMPT_SECRET"), false);

  const codex = buildInstalledRuntimeInvocation({
    runtimeId: "codex",
    executablePath: "/safe/codex",
    schemaPath: "/private/tmp/schema.json",
  });
  assert.equal(codex.command, "/safe/codex");
  assert.deepEqual(codex.args.slice(0, 2), ["exec", "--json"]);
  assert.ok(codex.args.includes("--sandbox"));
  assert.ok(codex.args.includes("read-only"));
  assert.ok(codex.args.includes("--ephemeral"));
  assert.ok(codex.args.includes("--output-schema"));
  assert.equal(codex.args.at(-1), "-");
  assert.equal(codex.options.shell, false);
});

test("Open Terminal runs only the allowlisted sign-in command on macOS", () => {
  const calls = [];
  const child = { unref() {} };
  const result = openInstalledRuntimeTerminal(
    { id: "claude", path: "/safe/claude" },
    {
      platform: "darwin",
      spawnImpl(command, args, options) {
        calls.push({ command, args, options });
        return child;
      },
    }
  );

  assert.equal(result.signInCommand, "claude auth login");
  assert.equal(calls[0].command, "/usr/bin/osascript");
  assert.deepEqual(calls[0].args, [
    "-e",
    'tell application "Terminal" to do script "claude auth login"',
  ]);
  assert.equal(calls[0].options.shell, false);
});

test("installed runtime selection persists under the active private Rolester home", () => {
  const root = tempRoot();
  const env = { ROLESTER_HOME: join(root, "private") };
  try {
    assert.deepEqual(loadInstalledRuntimeSelection({ repoRoot: root, env }), {
      runtimeId: null,
      providerFallback: false,
    });
    writeInstalledRuntimeSelection({
      repoRoot: root,
      env,
      runtimeId: "codex",
      providerFallback: false,
    });
    assert.deepEqual(loadInstalledRuntimeSelection({ repoRoot: root, env }), {
      runtimeId: "codex",
      providerFallback: false,
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Claude adapter buffers structured output while keeping the prompt off argv", async () => {
  const root = tempRoot();
  const executablePath = join(root, "claude");
  writeFileSync(
    executablePath,
    `#!/usr/bin/env node
let input = "";
process.stdin.on("data", (chunk) => { input += chunk; });
process.stdin.on("end", () => {
  const leaked = process.argv.some((arg) => arg.includes("PROMPT_SECRET"));
  process.stdout.write(JSON.stringify({
    type: "result",
    subtype: "success",
    result: "ignored",
    structured_output: { verdict: "keep", promptWasOnArgv: leaked, gotPrompt: input.includes("PROMPT_SECRET") },
  }));
});
`,
    "utf8"
  );
  chmodSync(executablePath, 0o755);
  try {
    const result = await runInstalledRuntime({
      runtime: { id: "claude", path: executablePath },
      prompt: "PROMPT_SECRET",
      outputSchema: { type: "object" },
      timeoutMs: 2000,
    });
    assert.deepEqual(JSON.parse(result.text), {
      verdict: "keep",
      promptWasOnArgv: false,
      gotPrompt: true,
    });
    assert.equal(result.runtimeId, "claude");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Codex adapter reads the final agent message from JSONL", async () => {
  const root = tempRoot();
  const executablePath = join(root, "codex");
  writeFileSync(
    executablePath,
    `#!/usr/bin/env node
process.stdin.resume();
process.stdin.on("end", () => {
  process.stdout.write(JSON.stringify({ type: "thread.started", thread_id: "secret-session" }) + "\\n");
  process.stdout.write(JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "{\\"verdict\\":\\"keep\\"}" } }) + "\\n");
  process.stdout.write(JSON.stringify({ type: "turn.completed", usage: { input_tokens: 3, output_tokens: 2 } }) + "\\n");
});
`,
    "utf8"
  );
  chmodSync(executablePath, 0o755);
  try {
    const result = await runInstalledRuntime({
      runtime: { id: "codex", path: executablePath },
      prompt: "classify",
      outputSchema: { type: "object" },
      timeoutMs: 2000,
    });
    assert.equal(result.text, '{"verdict":"keep"}');
    assert.deepEqual(result.usage, { input_tokens: 3, output_tokens: 2 });
    assert.equal(JSON.stringify(result).includes("secret-session"), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("installed runtime failures distinguish nonzero exit, timeout, and cancellation", async () => {
  const root = tempRoot();
  const failedPath = join(root, "failed-claude");
  const hangingPath = join(root, "hanging-claude");
  writeFileSync(
    failedPath,
    '#!/bin/sh\nread ignored\necho "sign in required" >&2\nexit 7\n',
    "utf8"
  );
  writeFileSync(hangingPath, "#!/bin/sh\nread ignored\nsleep 10\n", "utf8");
  chmodSync(failedPath, 0o755);
  chmodSync(hangingPath, 0o755);
  try {
    await assert.rejects(
      runInstalledRuntime({
        runtime: { id: "claude", path: failedPath },
        prompt: "hello",
        timeoutMs: 2000,
      }),
      (error) =>
        error.code === "RUNTIME_EXIT" &&
        error.exitStatus === 7 &&
        /sign in required/.test(error.message)
    );

    await assert.rejects(
      runInstalledRuntime({
        runtime: { id: "claude", path: hangingPath },
        prompt: "hello",
        timeoutMs: 20,
      }),
      (error) => error.code === "RUNTIME_TIMEOUT"
    );

    const controller = new AbortController();
    controller.abort();
    await assert.rejects(
      runInstalledRuntime({
        runtime: { id: "claude", path: hangingPath },
        prompt: "hello",
        timeoutMs: 2000,
        signal: controller.signal,
      }),
      (error) => error.code === "RUNTIME_CANCELLED"
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
