import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  buildInstalledRuntimeChildEnv,
  buildInstalledRuntimeInvocation,
  CHAT_SESSION_RUNTIME_TIMEOUT_MS,
  detectInstalledRuntimes,
  fetchInstalledRuntimePublicUrl,
  INSTALLED_RUNTIME_DEFINITIONS,
  materializeIsolatedSkillCwd,
  ONE_SHOT_RUNTIME_TIMEOUT_MS,
  openInstalledRuntimeTerminal,
  parseCustomCommandString,
  probeCustomRuntimeCommand,
  probeInstalledRuntime,
  RUNTIME_STREAMING_UNSUPPORTED,
  RUNTIME_TOOL_PROFILE_UNSUPPORTED,
  runInstalledRuntime,
  runInstalledRuntimeStream,
  runtimeSearchDirectories,
  supportsInstalledRuntimeStreaming,
} from "../src/core/ai/installed-runtimes.mjs";
import {
  loadInstalledRuntimeSelection,
  writeInstalledRuntimeSelection,
} from "../src/core/ai/runtime-selection.mjs";

// A minimal fake child_process for runInstalledRuntime's spawnImpl injection
// point — an EventEmitter with stdout/stderr/stdin EventEmitters, mirroring
// the shape probeCustomRuntimeCommand's own tests fake below. `stdin.end()`
// is the spawn's actual write, so that's what schedules the fake process's
// stdout + close.
function fakeInstalledChild({ stdout = "", status = 0 } = {}) {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.stdin = new EventEmitter();
  child.stdin.end = () => {
    queueMicrotask(() => {
      if (stdout) child.stdout.emit("data", Buffer.from(stdout, "utf8"));
      child.emit("close", status, null);
    });
  };
  child.kill = () => {};
  return child;
}

// A fake child for runInstalledRuntimeStream's spawnImpl injection point:
// like fakeInstalledChild above, but emits `chunks` one at a time (each on
// its own microtask tick, via setImmediate) rather than a single stdout
// write, so tests can exercise NDJSON line-buffering across chunk
// boundaries — including a chunk that splits a JSON object mid-line.
function fakeStreamingChild({ chunks = [], status = 0, stderr = "" } = {}) {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.stdin = new EventEmitter();
  child.stdin.end = () => {
    (async () => {
      for (const chunk of chunks) {
        await new Promise((resolve) => setImmediate(resolve));
        child.stdout.emit("data", Buffer.from(chunk, "utf8"));
      }
      if (stderr) child.stderr.emit("data", Buffer.from(stderr, "utf8"));
      await new Promise((resolve) => setImmediate(resolve));
      child.emit("close", status, null);
    })();
  };
  child.kill = () => {};
  return child;
}

function ndjson(lines) {
  return lines.map((line) => `${JSON.stringify(line)}\n`).join("");
}

function tempRoot() {
  return mkdtempSync(join(tmpdir(), "careerrat-installed-runtime-"));
}

function executable(path) {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, "#!/bin/sh\nexit 0\n", "utf8");
  chmodSync(path, 0o755);
}

function verifiedClaudeVersion() {
  return { status: 0, stdout: "2.1.241 (Claude Code)", stderr: "" };
}

test("runtime registry covers the supported installed CLI set", () => {
  assert.deepEqual(
    INSTALLED_RUNTIME_DEFINITIONS.map(({ id }) => id),
    [
      "claude",
      "codex",
      "gemini",
      "opencode",
      "copilot",
      "qwen",
      "antigravity",
      "hermes",
      "amp",
      "goose",
      "droid",
    ]
  );
  for (const definition of INSTALLED_RUNTIME_DEFINITIONS) {
    assert.ok(definition.name);
    assert.ok(definition.commandShape);
    assert.ok(definition.binaries.length >= 1);
    assert.ok(definition.authProbe.args.length >= 1);
    // Onboarding's not-found rows link out to each CLI's official install
    // docs (the "NOT FOUND · INSTALL GUIDE" receipt) — every registry entry
    // must carry a real, verified https:// URL, never an invented one.
    assert.ok(definition.installUrl, `${definition.id} needs an installUrl`);
    assert.match(definition.installUrl, /^https:\/\//);
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
      env: { PATH: "", CAREERRAT_RUNTIME_EXTRA_PATHS: brewDir },
      platform: "darwin",
      homeDir,
    });
    assert.equal(inventory.find(({ id }) => id === "claude").path, claudePath);
    assert.equal(inventory.find(({ id }) => id === "codex").path, codexPath);
    assert.equal(inventory.find(({ id }) => id === "gemini").available, false);
    // installUrl flows from the registry definition through to every
    // detected runtime, available or not.
    assert.equal(
      inventory.find(({ id }) => id === "claude").installUrl,
      INSTALLED_RUNTIME_DEFINITIONS.find(({ id }) => id === "claude").installUrl
    );
    assert.equal(
      inventory.find(({ id }) => id === "gemini").installUrl,
      INSTALLED_RUNTIME_DEFINITIONS.find(({ id }) => id === "gemini").installUrl
    );
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
  assert.deepEqual(ready, {
    status: "ready",
    ready: true,
    action: null,
    toolExecutionSupported: false,
    capabilityReason: "Detected, but this CLI cannot safely run CareerRat tools yet.",
  });
  assert.equal(JSON.stringify(ready).includes("morgan@example.com"), false);
  assert.equal(calls[0].executablePath, "/safe/codex");
  assert.deepEqual(calls[0].args, ["login", "status"]);
  assert.equal(calls[0].options.shell, false);
  assert.ok(calls[0].options.timeout > 0);

  const signedOut = probeInstalledRuntime(
    { id: "claude", path: "/safe/claude", available: true },
    {
      spawnSyncImpl(_path, args) {
        return args[0] === "--version"
          ? { status: 0, stdout: "2.1.241 (Claude Code)", stderr: "" }
          : { status: 1, stdout: "", stderr: "email secret" };
      },
    }
  );
  assert.deepEqual(signedOut, {
    status: "authentication_required",
    ready: false,
    action: "open_terminal",
  });
  assert.equal(JSON.stringify(signedOut).includes("secret"), false);
});

test("Claude readiness fails closed below the verified CLI boundary version", () => {
  const calls = [];
  const unsupported = probeInstalledRuntime(
    { id: "claude", path: "/safe/claude", available: true },
    {
      spawnSyncImpl(_path, args) {
        calls.push(args);
        return { status: 0, stdout: "2.1.200 (Claude Code)", stderr: "" };
      },
    }
  );
  assert.deepEqual(unsupported, {
    status: "unsupported_capability",
    ready: false,
    action: null,
    toolExecutionSupported: false,
    capabilityReason: "Update Claude Code to 2.1.241 or newer for secure CareerRat tool runs.",
  });
  assert.deepEqual(calls, [["--version"]]);
});

test("tool-bearing Claude runs re-verify the boundary version before model spawn", async () => {
  const repoRoot = tempRepoWithOneSkill("ingest-profile");
  let spawned = false;
  try {
    await assert.rejects(
      runInstalledRuntime({
        runtime: { id: "claude", name: "Claude Code", path: "/safe/claude" },
        prompt: "onboard",
        skill: "ingest-profile",
        repoRoot,
        tools: ["Skill"],
        spawnSyncImpl: () => ({ status: 0, stdout: "2.1.200 (Claude Code)", stderr: "" }),
        spawnImpl() {
          spawned = true;
          return fakeInstalledChild({
            stdout: JSON.stringify({ type: "result", subtype: "success", result: "bad" }),
          });
        },
      }),
      { code: RUNTIME_TOOL_PROFILE_UNSUPPORTED }
    );
    assert.equal(spawned, false);
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test("fixed invocation adapters pass prompts on stdin and never use a shell", () => {
  const claude = buildInstalledRuntimeInvocation({
    runtimeId: "claude",
    executablePath: "/safe/claude",
    schema: {
      $schema: "https://json-schema.org/draft/2020-12/schema",
      $id: "https://careerrat.local/schema.json",
      type: "object",
      maxProperties: 2,
    },
    model: "sonnet",
    tools: [],
  });
  assert.equal(claude.command, "/safe/claude");
  assert.equal(claude.options.shell, false);
  assert.equal(claude.stdin, true);
  assert.ok(claude.args.includes("--json-schema"));
  const claudeSchema = JSON.parse(claude.args[claude.args.indexOf("--json-schema") + 1]);
  assert.equal(claudeSchema.$schema, undefined);
  assert.equal(claudeSchema.$id, undefined);
  assert.equal(claudeSchema.maxProperties, 2);
  assert.equal(claude.args.includes("--safe-mode"), false);
  assert.ok(claude.args.includes("--settings"));
  assert.ok(claude.args.includes("--strict-mcp-config"));
  assert.ok(claude.args.includes("--no-session-persistence"));
  assert.ok(claude.args.includes("--permission-mode"));
  assert.equal(claude.args[claude.args.indexOf("--tools") + 1], "");
  assert.equal(claude.args.includes("--allowedTools"), false);
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
  assert.ok(
    codex.args.includes("--ignore-user-config"),
    "bounded app calls must not inherit unrelated user MCP servers or hooks"
  );
  assert.ok(codex.args.includes("--output-schema"));
  assert.equal(codex.args.at(-1), "-");
  assert.equal(codex.options.shell, false);
});

test("claude exact-read invocation approves only the uploaded file and isolated skill", () => {
  const repoRoot = tempRepoWithOneSkill("resume-extract", "Read only the supplied resume.\n");
  let isolatedCwd;
  try {
    const uploadDir = join(repoRoot, "workspace", "intake", "resume-uploads");
    mkdirSync(uploadDir, { recursive: true });
    const upload = join(uploadDir, "resume.pdf");
    const sibling = join(uploadDir, "other.pdf");
    writeFileSync(upload, "resume", "utf8");
    writeFileSync(sibling, "private sibling", "utf8");
    isolatedCwd = materializeIsolatedSkillCwd({ repoRoot, skill: "resume-extract" });

    const invocation = buildInstalledRuntimeInvocation({
      runtimeId: "claude",
      executablePath: "/safe/claude",
      repoRoot,
      isolatedCwd,
      approvedReadPaths: [upload],
      tools: ["Read", "Skill"],
      skill: "resume-extract",
    });
    const settings = JSON.parse(invocation.args[invocation.args.indexOf("--settings") + 1]);
    assert.deepEqual(settings.sandbox.filesystem.denyRead, ["//**"]);
    assert.deepEqual(
      new Set(settings.sandbox.filesystem.allowRead),
      new Set([realpathSync(upload), realpathSync(isolatedCwd)])
    );
    assert.equal(settings.sandbox.filesystem.allowRead.includes(sibling), false);
    assert.equal(
      settings.sandbox.filesystem.allowRead.includes(join(repoRoot, "workspace")),
      false
    );
    assert.equal(
      settings.sandbox.filesystem.allowRead.includes(join(repoRoot, "candidate")),
      false
    );
    assert.equal(invocation.args.includes("--safe-mode"), false);
    assert.ok(invocation.args.includes("--strict-mcp-config"));
    assert.ok(invocation.args.includes("--no-chrome"));
    const allowed = invocation.args[invocation.args.indexOf("--allowedTools") + 1];
    assert.doesNotMatch(
      allowed,
      /(?:^|,)Read(?:,|$)/,
      "Read must never be approved without a path"
    );
    assert.match(allowed, /Read\(\/\//);
    assert.match(allowed, /Skill\(resume-extract\)/);
  } finally {
    if (isolatedCwd) rmSync(isolatedCwd, { recursive: true, force: true });
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test("claude exact-read invocation fails closed for missing, outside, and symlink-aliased paths", () => {
  const repoRoot = tempRepoWithOneSkill("resume-extract");
  const uploadDir = join(repoRoot, "workspace", "intake", "resume-uploads");
  const outside = join(repoRoot, "workspace", "tracker.json");
  const target = join(uploadDir, "resume.pdf");
  const alias = join(uploadDir, "alias.pdf");
  mkdirSync(uploadDir, { recursive: true });
  writeFileSync(outside, "tracker", "utf8");
  writeFileSync(target, "resume", "utf8");
  symlinkSync(target, alias);

  try {
    for (const approvedReadPaths of [[], [join(uploadDir, "missing.pdf")], [outside], [alias]]) {
      assert.throws(
        () =>
          buildInstalledRuntimeInvocation({
            runtimeId: "claude",
            executablePath: "/safe/claude",
            repoRoot,
            approvedReadPaths,
            tools: ["Read", "Skill"],
            skill: "resume-extract",
          }),
        { code: "RUNTIME_READ_BOUNDARY_INVALID" }
      );
    }
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test("claude exact-read invocation resolves uploads from CAREERRAT_HOME in packaged layout", () => {
  const repoRoot = tempRepoWithOneSkill("resume-extract");
  const privateHome = tempRoot();
  const uploadDir = join(privateHome, "workspace", "intake", "resume-uploads");
  const upload = join(uploadDir, "resume.pdf");
  mkdirSync(uploadDir, { recursive: true });
  writeFileSync(upload, "resume", "utf8");
  let isolatedCwd;
  try {
    isolatedCwd = materializeIsolatedSkillCwd({ repoRoot, skill: "resume-extract" });
    const invocation = buildInstalledRuntimeInvocation({
      runtimeId: "claude",
      executablePath: "/safe/claude",
      repoRoot,
      env: { CAREERRAT_HOME: privateHome },
      isolatedCwd,
      approvedReadPaths: [upload],
      tools: ["Read", "Skill"],
      skill: "resume-extract",
    });
    const settings = JSON.parse(invocation.args[invocation.args.indexOf("--settings") + 1]);
    assert.ok(settings.sandbox.filesystem.allowRead.includes(realpathSync(upload)));
    assert.equal(
      settings.sandbox.filesystem.allowRead.some((path) =>
        path.startsWith(join(repoRoot, "workspace"))
      ),
      false
    );
  } finally {
    if (isolatedCwd) rmSync(isolatedCwd, { recursive: true, force: true });
    rmSync(repoRoot, { recursive: true, force: true });
    rmSync(privateHome, { recursive: true, force: true });
  }
});

test("claude web invocation replaces native WebFetch with the guarded CareerRat MCP fetch tool", () => {
  const repoRoot = tempRepoWithOneSkill("research-company");
  try {
    const invocation = buildInstalledRuntimeInvocation({
      runtimeId: "claude",
      executablePath: "/safe/claude",
      repoRoot,
      tools: ["WebSearch", "WebFetch", "Skill"],
      skill: "research-company",
    });
    const visible = invocation.args[invocation.args.indexOf("--tools") + 1].split(",");
    assert.ok(visible.includes("WebSearch"));
    assert.ok(visible.includes("Skill"));
    assert.equal(visible.includes("WebFetch"), false);
    const mcp = JSON.parse(invocation.args[invocation.args.indexOf("--mcp-config") + 1]);
    assert.deepEqual(Object.keys(mcp.mcpServers), ["careerrat_public_web"]);
    const allowed = invocation.args[invocation.args.indexOf("--allowedTools") + 1];
    assert.match(allowed, /mcp__careerrat_public_web__fetch/);
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test("CareerRat public-web fetch rejects private targets before invoking the network helper", async () => {
  let called = false;
  const result = await fetchInstalledRuntimePublicUrl("http://127.0.0.1/private", {
    fetchPublicHttpTextImpl: async () => {
      called = true;
      return { ok: true };
    },
  });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /private|local|non-public/i);
  assert.equal(called, false);
});

test("CareerRat public-web fetch delegates public URLs to the DNS-pinned guarded fetch", async () => {
  const calls = [];
  const result = await fetchInstalledRuntimePublicUrl("https://example.com/jobs", {
    fetchPublicHttpTextImpl: async (url, options) => {
      calls.push({ url, options });
      return {
        ok: true,
        finalUrl: url,
        status: 200,
        contentType: "text/html",
        rawText: "Remote role",
      };
    },
  });
  assert.equal(result.isError, undefined);
  assert.deepEqual(calls, [
    {
      url: "https://example.com/jobs",
      options: { timeoutMs: 15000, maxBytes: 512 * 1024, maxRedirects: 4 },
    },
  ]);
  assert.match(result.content[0].text, /Remote role/);
});

test("tool-bearing installed runs reject Codex before spawn even for the local-read profile", async () => {
  let spawned = false;
  await assert.rejects(
    runInstalledRuntime({
      runtime: { id: "codex", name: "Codex", path: "/safe/codex" },
      prompt: "read the workspace",
      skill: "resume-extract",
      repoRoot: "/safe/workspace",
      tools: ["Read"],
      spawnImpl() {
        spawned = true;
        return fakeInstalledChild();
      },
    }),
    { code: RUNTIME_TOOL_PROFILE_UNSUPPORTED }
  );
  assert.equal(spawned, false);
});

test("newly added installed CLIs deliver the prompt on stdin with a fixed, shell-free argv", () => {
  const hermes = buildInstalledRuntimeInvocation({
    runtimeId: "hermes",
    executablePath: "/safe/hermes",
  });
  assert.equal(hermes.command, "/safe/hermes");
  assert.deepEqual(hermes.args, ["-z"]);
  assert.equal(hermes.stdin, true);
  assert.equal(hermes.options.shell, false);

  const amp = buildInstalledRuntimeInvocation({
    runtimeId: "amp",
    executablePath: "/safe/amp",
  });
  assert.equal(amp.command, "/safe/amp");
  assert.deepEqual(amp.args, ["-x"]);
  assert.equal(amp.stdin, true);
  assert.equal(amp.options.shell, false);

  const goose = buildInstalledRuntimeInvocation({
    runtimeId: "goose",
    executablePath: "/safe/goose",
  });
  assert.equal(goose.command, "/safe/goose");
  assert.deepEqual(goose.args, ["run", "-i", "-"]);
  assert.equal(goose.stdin, true);
  assert.equal(goose.options.shell, false);

  const droid = buildInstalledRuntimeInvocation({
    runtimeId: "droid",
    executablePath: "/safe/droid",
  });
  assert.equal(droid.command, "/safe/droid");
  assert.deepEqual(droid.args, ["exec"]);
  assert.equal(droid.stdin, true);
  assert.equal(droid.options.shell, false);
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

test("installed runtime selection persists under the active private CareerRat home", () => {
  const root = tempRoot();
  const env = { CAREERRAT_HOME: join(root, "private") };
  try {
    assert.deepEqual(loadInstalledRuntimeSelection({ repoRoot: root, env }), {
      runtimeId: null,
      providerFallback: false,
      customCommand: null,
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
      customCommand: null,
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
const { readFileSync } = require("node:fs");
process.stdin.resume();
process.stdin.on("end", () => {
  const schemaPath = process.argv[process.argv.indexOf("--output-schema") + 1];
  const schema = JSON.parse(readFileSync(schemaPath, "utf8"));
  process.stdout.write(JSON.stringify({ type: "thread.started", thread_id: "secret-session" }) + "\\n");
  process.stdout.write(JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: JSON.stringify({ required: schema.required, candidateRequired: schema.properties.candidate.required, candidateAdditionalProperties: schema.properties.candidate.additionalProperties }) } }) + "\\n");
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
      outputSchema: {
        type: "object",
        properties: {
          candidate: {
            type: "object",
            properties: {
              full_name: { type: ["string", "null"] },
              domain: { type: "string" },
            },
          },
        },
      },
      timeoutMs: 2000,
    });
    assert.deepEqual(JSON.parse(result.text), {
      required: ["candidate"],
      candidateRequired: ["full_name", "domain"],
      candidateAdditionalProperties: false,
    });
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

test("runInstalledRuntime surfaces a redacted Claude JSON failure from stdout on nonzero exit", async () => {
  const exposedCredential = "sk-ant-api03-should-not-escape";
  await assert.rejects(
    runInstalledRuntime({
      runtime: { id: "claude", path: "/safe/claude" },
      prompt: "hello",
      timeoutMs: 2000,
      spawnImpl: () =>
        fakeInstalledChild({
          status: 1,
          stdout: JSON.stringify({
            type: "result",
            subtype: "error_during_execution",
            is_error: true,
            result: `Not logged in. Run /login. ${exposedCredential}`,
            session_id: "private-session-id",
          }),
        }),
    }),
    (error) => {
      assert.equal(error.code, "RUNTIME_EXIT");
      assert.match(error.message, /Not logged in\. Run \/login\./);
      assert.match(error.message, /\[redacted\]/);
      assert.doesNotMatch(error.message, new RegExp(exposedCredential));
      assert.doesNotMatch(error.message, /private-session-id/);
      return true;
    }
  );
});

// P0 regression: runInstalledRuntime's `timeoutMs` has two named tiers (see
// installed-runtimes.mjs's own comment above their definitions). Bounded
// one-shot calls (evaluate-job, tailor-application, resume-extract, ...) must
// keep the exact ~120s bound they always had. A chat session opts into the
// wider tier per-call (see tests/chat-runtime.test.mjs's own pin of that
// wiring); it is never the shared default.
test("runInstalledRuntime's default timeoutMs is the byte-identical one-shot 120s bound; the chat-session tier is a separate, wider, explicitly-opted-into constant", () => {
  assert.equal(ONE_SHOT_RUNTIME_TIMEOUT_MS, 120000);
  assert.equal(CHAT_SESSION_RUNTIME_TIMEOUT_MS, 9 * 60 * 1000);
  assert.ok(CHAT_SESSION_RUNTIME_TIMEOUT_MS > ONE_SHOT_RUNTIME_TIMEOUT_MS);
});

test("parseCustomCommandString splits on whitespace and keeps quoted segments intact", () => {
  assert.deepEqual(parseCustomCommandString("my-agent --flag value"), [
    "my-agent",
    "--flag",
    "value",
  ]);
  assert.deepEqual(parseCustomCommandString('~/bin/my-agent --name "my agent"'), [
    "~/bin/my-agent",
    "--name",
    "my agent",
  ]);
  assert.deepEqual(parseCustomCommandString("agent --name 'solo quoted'"), [
    "agent",
    "--name",
    "solo quoted",
  ]);
  assert.deepEqual(parseCustomCommandString("agent \"first arg\" 'second arg'"), [
    "agent",
    "first arg",
    "second arg",
  ]);
  assert.deepEqual(parseCustomCommandString("  agent   --flag   "), ["agent", "--flag"]);
});

test("parseCustomCommandString returns an empty argv for empty or garbage-only input", () => {
  assert.deepEqual(parseCustomCommandString(""), []);
  assert.deepEqual(parseCustomCommandString("   "), []);
  assert.deepEqual(parseCustomCommandString(null), []);
  assert.deepEqual(parseCustomCommandString(undefined), []);
  assert.deepEqual(parseCustomCommandString('""'), [""]);
});

test("probeCustomRuntimeCommand reports ok:true with measured latency on a successful run", async () => {
  const root = tempRoot();
  const executablePath = join(root, "custom-agent");
  writeFileSync(
    executablePath,
    '#!/bin/sh\nread ignored\nsleep 0.05\necho "ack"\nexit 0\n',
    "utf8"
  );
  chmodSync(executablePath, 0o755);
  try {
    const result = await probeCustomRuntimeCommand({ command: executablePath });
    assert.equal(result.ok, true);
    assert.equal(typeof result.elapsedMs, "number");
    assert.ok(result.elapsedMs >= 0);
    assert.ok(result.output.includes("ack"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("probeCustomRuntimeCommand reports ok:false with stderr diagnostic on a non-zero exit", async () => {
  const root = tempRoot();
  const executablePath = join(root, "failing-agent");
  writeFileSync(executablePath, '#!/bin/sh\nread ignored\necho "boom" >&2\nexit 3\n', "utf8");
  chmodSync(executablePath, 0o755);
  try {
    const result = await probeCustomRuntimeCommand({ command: executablePath });
    assert.equal(result.ok, false);
    assert.ok(result.error.includes("boom"));
    assert.equal(typeof result.elapsedMs, "number");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("probeCustomRuntimeCommand reports ok:false without a latency reading on empty input", async () => {
  const result = await probeCustomRuntimeCommand({ command: "" });
  assert.deepEqual(result, { ok: false, error: "Enter a command to test." });
});

test("probeCustomRuntimeCommand reports ok:false when the command cannot be spawned at all", async () => {
  const result = await probeCustomRuntimeCommand({
    command: "totally-not-a-real-binary --flag",
    spawnImpl() {
      throw new Error("spawn ENOENT");
    },
  });
  assert.equal(result.ok, false);
  assert.equal(result.elapsedMs, null);
  assert.ok(result.error.includes("totally-not-a-real-binary"));
  assert.ok(result.error.includes("spawn ENOENT"));
});

test("probeCustomRuntimeCommand reports ok:false when the process emits an error event", async () => {
  const { EventEmitter } = await import("node:events");
  const result = await probeCustomRuntimeCommand({
    command: "custom-agent",
    spawnImpl() {
      const child = new EventEmitter();
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      child.stdin = new EventEmitter();
      child.stdin.end = () => {
        queueMicrotask(() => child.emit("error", new Error("spawn EACCES")));
      };
      child.kill = () => {};
      return child;
    },
  });
  assert.equal(result.ok, false);
  assert.equal(result.elapsedMs, null);
  assert.ok(result.error.includes("EACCES"));
});

test("probeCustomRuntimeCommand times out a hanging command using the caller-supplied timeoutMs", async () => {
  const root = tempRoot();
  const hangingPath = join(root, "hanging-custom-agent");
  writeFileSync(hangingPath, "#!/bin/sh\nread ignored\nsleep 10\n", "utf8");
  chmodSync(hangingPath, 0o755);
  try {
    const result = await probeCustomRuntimeCommand({ command: hangingPath, timeoutMs: 30 });
    assert.equal(result.ok, false);
    assert.equal(result.error, "Timed out after 15s.");
    assert.equal(typeof result.elapsedMs, "number");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// P0 regression — the installed "claude" runtime's Skill tool coming up
// empty under --safe-mode. CHAT_RUNTIME_TOOLS chat sessions (research-company,
// research-comp, company-health, research-boards) grant only WebSearch/
// WebFetch/Skill — no Read — so when --safe-mode blanks the Skill tool's
// registry, the skill is unreachable and the session freelances instead of
// emitting its typed careerrat:discovery result. --safe-mode's own --help
// text says it disables "skills" outright; verified empirically against the
// real installed CLI that a --safe-mode run's Skill tool lists only
// Anthropic's fixed built-ins, never a project skill. The fix: when a
// specific skill is given, spawn against an isolated cwd containing nothing
// but that skill (materializeIsolatedSkillCwd) with --setting-sources
// project instead of --safe-mode — verified empirically to expose exactly
// that one skill at --safe-mode's own ~5k-token baseline cost, not the
// ~136k a real project cwd produces.
// ---------------------------------------------------------------------------

function tempRepoWithOneSkill(skillName, body = `# ${skillName}\n`) {
  const repoRoot = mkdtempSync(join(tmpdir(), "careerrat-installed-skill-repo-"));
  const skillDir = join(repoRoot, ".agents", "skills", skillName);
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(join(skillDir, "SKILL.md"), `---\nname: ${skillName}\n---\n${body}`, "utf8");
  return repoRoot;
}

test("buildInstalledRuntimeInvocation: a claude call with a materialized skill trades --safe-mode for --setting-sources project", () => {
  const withSkill = buildInstalledRuntimeInvocation({
    runtimeId: "claude",
    executablePath: "/safe/claude",
    tools: ["WebSearch", "WebFetch", "Skill"],
    skill: "research-company",
  });
  assert.equal(withSkill.args.includes("--safe-mode"), false);
  const idx = withSkill.args.indexOf("--setting-sources");
  assert.ok(idx >= 0, "expected --setting-sources in argv");
  assert.equal(withSkill.args[idx + 1], "project");

  // No skill gets an empty project setting source and no visible tools.
  const withoutSkill = buildInstalledRuntimeInvocation({
    runtimeId: "claude",
    executablePath: "/safe/claude",
    tools: [],
  });
  assert.equal(withoutSkill.args.includes("--safe-mode"), false);
  const noSkillSettings = withoutSkill.args.indexOf("--setting-sources");
  assert.ok(noSkillSettings >= 0);
  assert.equal(withoutSkill.args[noSkillSettings + 1], "");
});

test("materializeIsolatedSkillCwd: copies exactly the named skill into an isolated .claude/skills/<skill>, nothing else from the project", () => {
  const repoRoot = tempRepoWithOneSkill("research-company", "Trigger word PROBE.\n");
  let isolated;
  try {
    isolated = materializeIsolatedSkillCwd({ repoRoot, skill: "research-company" });
    assert.ok(isolated, "expected an isolated cwd path");
    const skillMdPath = join(isolated, ".claude", "skills", "research-company", "SKILL.md");
    assert.ok(existsSync(skillMdPath));
    assert.equal(existsSync(join(isolated, "CLAUDE.md")), false);
    assert.equal(existsSync(join(isolated, ".agents")), false);
  } finally {
    if (isolated) rmSync(isolated, { recursive: true, force: true });
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test("materializeIsolatedSkillCwd: returns null (never throws) when the skill or repoRoot is missing", () => {
  const repoRoot = tempRepoWithOneSkill("research-company");
  try {
    assert.equal(materializeIsolatedSkillCwd({ repoRoot, skill: "not-a-real-skill" }), null);
    assert.equal(materializeIsolatedSkillCwd({ repoRoot: null, skill: "research-company" }), null);
    assert.equal(materializeIsolatedSkillCwd({ repoRoot, skill: null }), null);
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test("buildInstalledRuntimeChildEnv retains only process/auth paths, locale, and model selectors", () => {
  const childEnv = buildInstalledRuntimeChildEnv({
    env: {
      PATH: "/usr/bin",
      HOME: "/Users/morgan",
      USER: "morgan",
      LOGNAME: "morgan",
      TMPDIR: "/private/tmp",
      LANG: "en_US.UTF-8",
      CAREERRAT_HOME: "/Users/morgan/CareerRat",
      ANTHROPIC_MODEL: "claude-sonnet",
      CLAUDE_CONFIG_DIR: "/Users/morgan/.config/claude",
      ANTHROPIC_API_KEY: "sentinel-anthropic",
      GH_TOKEN: "sentinel-github",
      AWS_SECRET_ACCESS_KEY: "sentinel-aws",
      APPLE_ID_PASSWORD: "sentinel-apple",
    },
  });
  assert.deepEqual(childEnv, {
    PATH: "/usr/bin",
    HOME: "/Users/morgan",
    USER: "morgan",
    LOGNAME: "morgan",
    TMPDIR: "/private/tmp",
    LANG: "en_US.UTF-8",
    CAREERRAT_HOME: "/Users/morgan/CareerRat",
    ANTHROPIC_MODEL: "claude-sonnet",
    CLAUDE_CONFIG_DIR: "/Users/morgan/.config/claude",
  });
});

test("runInstalledRuntime scrubs server secrets from both version and one-shot Claude children", async () => {
  const repoRoot = tempRepoWithOneSkill("ingest-profile");
  const env = {
    PATH: "/usr/bin",
    HOME: "/Users/morgan",
    USER: "morgan",
    LOGNAME: "morgan",
    TMPDIR: "/private/tmp",
    LANG: "en_US.UTF-8",
    CAREERRAT_HOME: join(repoRoot, "private"),
    ANTHROPIC_API_KEY: "sentinel-anthropic",
    GH_TOKEN: "sentinel-github",
    AWS_SECRET_ACCESS_KEY: "sentinel-aws",
    APPLE_ID_PASSWORD: "sentinel-apple",
  };
  const seenEnvs = [];
  try {
    await runInstalledRuntime({
      runtime: { id: "claude", path: "/safe/claude" },
      prompt: "onboard",
      skill: "ingest-profile",
      repoRoot,
      tools: ["Skill"],
      env,
      timeoutMs: 2000,
      spawnSyncImpl(_command, _args, options) {
        seenEnvs.push(options.env);
        return verifiedClaudeVersion();
      },
      spawnImpl(_command, _args, options) {
        seenEnvs.push(options.env);
        return fakeInstalledChild({
          stdout: JSON.stringify({ type: "result", subtype: "success", result: "ok" }),
        });
      },
    });
    assert.equal(seenEnvs.length, 2);
    for (const childEnv of seenEnvs) {
      assert.equal(childEnv.HOME, "/Users/morgan");
      assert.equal(childEnv.USER, "morgan");
      assert.equal(childEnv.LOGNAME, "morgan");
      assert.equal(childEnv.PATH, "/usr/bin");
      assert.equal(childEnv.CAREERRAT_HOME, env.CAREERRAT_HOME);
      assert.equal(childEnv.ANTHROPIC_API_KEY, undefined);
      assert.equal(childEnv.GH_TOKEN, undefined);
      assert.equal(childEnv.AWS_SECRET_ACCESS_KEY, undefined);
      assert.equal(childEnv.APPLE_ID_PASSWORD, undefined);
    }
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test("runInstalledRuntime (claude + skill): spawns against the isolated skill cwd with --setting-sources project, and cleans it up after", async () => {
  const repoRoot = tempRepoWithOneSkill("research-company", "Trigger word PROBE.\n");
  const executablePath = join(repoRoot, "fake-claude");
  writeFileSync(
    executablePath,
    `#!/usr/bin/env node
const { readFileSync, existsSync } = require("node:fs");
const { join } = require("node:path");
process.stdin.resume();
process.stdin.on("end", () => {
  const cwd = process.cwd();
  const skillPath = join(cwd, ".claude", "skills", "research-company", "SKILL.md");
  process.stdout.write(JSON.stringify({
    type: "result",
    subtype: "success",
    result: "ignored",
    structured_output: {
      cwd,
      usedSettingSources: process.argv.includes("--setting-sources"),
      usedSafeMode: process.argv.includes("--safe-mode"),
      skillVisible: existsSync(skillPath),
      skillContent: existsSync(skillPath) ? readFileSync(skillPath, "utf8") : null,
    },
  }));
});
`,
    "utf8"
  );
  chmodSync(executablePath, 0o755);
  let capturedIsolatedCwd = null;
  try {
    const result = await runInstalledRuntime({
      runtime: { id: "claude", path: executablePath },
      prompt: "run research-company",
      skill: "research-company",
      repoRoot,
      cwd: repoRoot, // the caller's ordinary cwd — must be overridden, not used
      tools: ["WebSearch", "WebFetch", "Skill"],
      timeoutMs: 5000,
      spawnSyncImpl: verifiedClaudeVersion,
    });
    const data = JSON.parse(result.text);
    capturedIsolatedCwd = data.cwd;
    assert.notEqual(
      data.cwd,
      repoRoot,
      "must spawn against the isolated cwd, not the caller's repoRoot"
    );
    assert.equal(data.usedSettingSources, true);
    assert.equal(data.usedSafeMode, false);
    assert.equal(data.skillVisible, true);
    assert.match(data.skillContent, /PROBE/);
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
  // The isolated temp cwd is app-owned and ephemeral — cleaned up once the
  // call finishes, same contract as the codex output-schema temp dir above.
  assert.ok(capturedIsolatedCwd, "fixture didn't report a cwd");
  assert.equal(existsSync(capturedIsolatedCwd), false);
});

test("runInstalledRuntime (claude exact-read skill): isolates cwd and passes only one approved upload", async () => {
  const repoRoot = tempRepoWithOneSkill("resume-extract", "Trigger word PROBE.\n");
  const uploadDir = join(repoRoot, "workspace", "intake", "resume-uploads");
  const upload = join(uploadDir, "resume.pdf");
  mkdirSync(uploadDir, { recursive: true });
  writeFileSync(upload, "resume", "utf8");
  const executablePath = join(repoRoot, "fake-claude-read");
  writeFileSync(
    executablePath,
    `#!/usr/bin/env node
process.stdin.resume();
process.stdin.on("end", () => {
  process.stdout.write(JSON.stringify({
    type: "result",
    subtype: "success",
    result: "ignored",
    structured_output: {
      cwd: process.cwd(),
      usedSafeMode: process.argv.includes("--safe-mode"),
      usedSettingSources: process.argv.includes("--setting-sources"),
      settings: JSON.parse(process.argv[process.argv.indexOf("--settings") + 1]),
    },
  }));
});
`,
    "utf8"
  );
  chmodSync(executablePath, 0o755);
  try {
    const result = await runInstalledRuntime({
      runtime: { id: "claude", path: executablePath },
      prompt: "run resume-extract",
      skill: "resume-extract",
      repoRoot,
      cwd: repoRoot,
      tools: ["Read", "Skill"],
      approvedReadPaths: [upload],
      timeoutMs: 5000,
      spawnSyncImpl: verifiedClaudeVersion,
    });
    const data = JSON.parse(result.text);
    assert.notEqual(data.cwd, realpathSync(repoRoot));
    assert.equal(data.usedSafeMode, false);
    assert.equal(data.usedSettingSources, true);
    assert.deepEqual(
      new Set(data.settings.sandbox.filesystem.allowRead),
      new Set([realpathSync(upload), data.cwd])
    );
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test("runInstalledRuntime rejects broad Glob/Grep tools before spawning Claude", async () => {
  const repoRoot = tempRepoWithOneSkill("evaluate-job", "Trigger word PROBE.\n");
  let spawned = false;
  try {
    await assert.rejects(
      runInstalledRuntime({
        runtime: { id: "claude", path: "/safe/claude" },
        prompt: "run evaluate-job",
        skill: "evaluate-job",
        repoRoot,
        cwd: repoRoot,
        tools: ["Glob", "Grep", "Skill"],
        spawnSyncImpl: verifiedClaudeVersion,
        spawnImpl() {
          spawned = true;
          return fakeInstalledChild();
        },
      }),
      { code: "RUNTIME_READ_BOUNDARY_INVALID" }
    );
    assert.equal(spawned, false);
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test("runInstalledRuntime (claude, no skill): uses isolated inline settings at the caller cwd", async () => {
  const root = tempRoot();
  const executablePath = join(root, "fake-claude-plain");
  writeFileSync(
    executablePath,
    `#!/usr/bin/env node
process.stdin.resume();
process.stdin.on("end", () => {
  process.stdout.write(JSON.stringify({
    type: "result",
    subtype: "success",
    result: "ignored",
    structured_output: { cwd: process.cwd(), usedSafeMode: process.argv.includes("--safe-mode") },
  }));
});
`,
    "utf8"
  );
  chmodSync(executablePath, 0o755);
  try {
    const result = await runInstalledRuntime({
      runtime: { id: "claude", path: executablePath },
      prompt: "no skill given",
      cwd: root,
      timeoutMs: 5000,
    });
    const data = JSON.parse(result.text);
    // macOS resolves the tmp dir's /var symlink to /private/var inside the
    // child (process.cwd() reports the real path) — compare realpaths rather
    // than the raw strings so this isn't platform-flaky.
    assert.equal(realpathSync(data.cwd), realpathSync(root));
    assert.equal(data.usedSafeMode, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Chat-tool-profile boundary — RUNTIME_TOOL_PROFILE_UNSUPPORTED.
//
// Codex `exec` (and every other non-claude installed runtime) has no
// tool-allowlist mechanism at all: `--sandbox read-only` scopes shell writes
// and network, it does not remove the shell tool or restrict what gets read.
// CHAT_RUNTIME_TOOLS (runtime-tools.mjs) is a deliberate structural
// prompt-injection boundary — WebSearch/WebFetch/Skill, never Read — that
// only the "claude" runtime's `--tools`/`--allowedTools` flags can actually
// enforce. runInstalledRuntime must fail closed BEFORE spawning whenever a
// non-claude runtime is asked to run that restricted profile, and must never
// affect the app-safe one-shot profile those same runtimes already run for
// evaluate-job/tailor-application/resume-extract.
// ---------------------------------------------------------------------------

test("runInstalledRuntime fails closed for a non-claude runtime + the restricted chat tool profile, before any spawn (codex)", async () => {
  let spawnCalls = 0;
  await assert.rejects(
    runInstalledRuntime({
      runtime: { id: "codex", path: "/safe/codex" },
      prompt: "research this company",
      tools: ["WebSearch", "WebFetch", "Skill"],
      spawnImpl: () => {
        spawnCalls++;
        throw new Error("spawn must never be reached for an unsupported chat tool profile");
      },
    }),
    (error) => error.code === RUNTIME_TOOL_PROFILE_UNSUPPORTED && error.runtimeId === "codex"
  );
  assert.equal(spawnCalls, 0, "the spawn was invoked despite the guard");
});

test("runInstalledRuntime fails closed for another non-claude runtime + the restricted chat tool profile (opencode) — proves the guard is general, not codex-specific", async () => {
  let spawnCalls = 0;
  await assert.rejects(
    runInstalledRuntime({
      runtime: { id: "opencode", path: "/safe/opencode" },
      prompt: "research this company",
      tools: ["WebSearch", "WebFetch", "Skill"],
      spawnImpl: () => {
        spawnCalls++;
        throw new Error("spawn must never be reached for an unsupported chat tool profile");
      },
    }),
    (error) => error.code === RUNTIME_TOOL_PROFILE_UNSUPPORTED && error.runtimeId === "opencode"
  );
  assert.equal(spawnCalls, 0, "the spawn was invoked despite the guard");
});

test("runInstalledRuntime: claude + the same restricted chat tool profile is unaffected, and still builds --tools/--allowedTools", async () => {
  const spawnCalls = [];
  const repoRoot = tempRepoWithOneSkill("research-company");
  try {
    const result = await runInstalledRuntime({
      runtime: { id: "claude", path: "/safe/claude" },
      prompt: "research this company",
      skill: "research-company",
      repoRoot,
      tools: ["WebSearch", "WebFetch", "Skill"],
      timeoutMs: 2000,
      spawnSyncImpl: verifiedClaudeVersion,
      spawnImpl: (command, args, options) => {
        spawnCalls.push({ command, args, options });
        return fakeInstalledChild({
          stdout: JSON.stringify({ type: "result", subtype: "success", result: "ok" }),
        });
      },
    });
    assert.equal(spawnCalls.length, 1, "claude must still spawn for the chat tool profile");
    const args = spawnCalls[0].args;
    const toolsIdx = args.indexOf("--tools");
    assert.ok(toolsIdx >= 0, "expected --tools in argv");
    assert.equal(args[toolsIdx + 1], "WebSearch,Skill");
    const allowed = args[args.indexOf("--allowedTools") + 1];
    assert.match(allowed, /WebSearch/);
    assert.match(allowed, /Skill\(research-company\)/);
    assert.match(allowed, /mcp__careerrat_public_web__fetch/);
    assert.doesNotMatch(allowed, /WebFetch/);
    assert.equal(result.text, "ok");
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test("runInstalledRuntime: codex rejects the former app-safe profile before spawn", async () => {
  let spawned = false;
  await assert.rejects(
    runInstalledRuntime({
      runtime: { id: "codex", path: "/safe/codex" },
      prompt: "evaluate this job",
      skill: "evaluate-job",
      tools: ["Skill"],
      spawnImpl() {
        spawned = true;
        return fakeInstalledChild();
      },
    }),
    { code: RUNTIME_TOOL_PROFILE_UNSUPPORTED }
  );
  assert.equal(spawned, false);
});

// ---------------------------------------------------------------------------
// runInstalledRuntimeStream — the streaming sibling used by chat-runtime.mjs's
// runInstalledTurn so an installed "claude" chat turn surfaces real-time
// tool_use/tool_result activity instead of going dark until process exit (the
// bug: startInstalledSession never called loadSdk, so this route's chat had
// no streaming envelope at all). Fixture NDJSON in, one onMessage call per
// parsed line, hermetic — no real CLI spawned.
// ---------------------------------------------------------------------------

test("supportsInstalledRuntimeStreaming is true only for claude, the sole registry entry with streamingSupported", () => {
  assert.equal(supportsInstalledRuntimeStreaming("claude"), true);
  for (const { id } of INSTALLED_RUNTIME_DEFINITIONS) {
    if (id === "claude") continue;
    assert.equal(supportsInstalledRuntimeStreaming(id), false, `${id} must not support streaming`);
  }
  assert.equal(supportsInstalledRuntimeStreaming("not-a-real-runtime"), false);
});

test("buildInstalledRuntimeInvocation: streaming:true swaps --output-format json for stream-json --verbose on claude only", () => {
  const streaming = buildInstalledRuntimeInvocation({
    runtimeId: "claude",
    executablePath: "/safe/claude",
    streaming: true,
  });
  const formatIdx = streaming.args.indexOf("--output-format");
  assert.ok(formatIdx >= 0);
  assert.equal(streaming.args[formatIdx + 1], "stream-json");
  assert.ok(streaming.args.includes("--verbose"), "stream-json requires --verbose in print mode");

  const nonStreaming = buildInstalledRuntimeInvocation({
    runtimeId: "claude",
    executablePath: "/safe/claude",
  });
  const nonStreamingFormatIdx = nonStreaming.args.indexOf("--output-format");
  assert.equal(nonStreaming.args[nonStreamingFormatIdx + 1], "json");
  assert.equal(nonStreaming.args.includes("--verbose"), false);
});

test("runInstalledRuntimeStream rejects with RUNTIME_STREAMING_UNSUPPORTED before spawning for a runtime with no streaming mode", async () => {
  let spawnCalls = 0;
  await assert.rejects(
    runInstalledRuntimeStream({
      runtime: { id: "codex", path: "/safe/codex", name: "Codex" },
      prompt: "hello",
      spawnImpl: () => {
        spawnCalls++;
        throw new Error("spawn must never be reached for an unsupported streaming runtime");
      },
    }),
    (error) => error.code === RUNTIME_STREAMING_UNSUPPORTED && error.runtimeId === "codex"
  );
  assert.equal(spawnCalls, 0, "the spawn was invoked despite the capability gate");
});

test("runInstalledRuntimeStream re-verifies Claude's boundary version before a chat spawn", async () => {
  const repoRoot = tempRepoWithOneSkill("research-company");
  let spawned = false;
  try {
    await assert.rejects(
      runInstalledRuntimeStream({
        runtime: { id: "claude", name: "Claude Code", path: "/safe/claude" },
        prompt: "research",
        skill: "research-company",
        repoRoot,
        tools: ["WebSearch", "WebFetch", "Skill"],
        spawnSyncImpl: () => ({ status: 0, stdout: "2.1.200 (Claude Code)", stderr: "" }),
        spawnImpl() {
          spawned = true;
          return fakeStreamingChild();
        },
      }),
      { code: RUNTIME_TOOL_PROFILE_UNSUPPORTED }
    );
    assert.equal(spawned, false);
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test("runInstalledRuntimeStream: a text-only turn calls onMessage once per NDJSON line, in order, and resolves the terminal result's text/usage/model/sessionId", async () => {
  const lines = [
    { type: "system", subtype: "init", session_id: "sess-1" },
    {
      type: "assistant",
      session_id: "sess-1",
      message: { content: [{ type: "text", text: "Hello there" }] },
    },
    {
      type: "result",
      subtype: "success",
      result: "Hello there",
      usage: { input_tokens: 10, output_tokens: 5 },
      model: "claude-sonnet",
      session_id: "sess-1",
    },
  ];
  const received = [];
  const result = await runInstalledRuntimeStream({
    runtime: { id: "claude", path: "/safe/claude" },
    prompt: "hi",
    timeoutMs: 2000,
    onMessage: (message) => received.push(message),
    spawnImpl: () => fakeStreamingChild({ chunks: [ndjson(lines)] }),
  });
  assert.deepEqual(received, lines);
  assert.equal(result.text, "Hello there");
  assert.deepEqual(result.usage, { input_tokens: 10, output_tokens: 5 });
  assert.equal(result.model, "claude-sonnet");
  assert.equal(result.sessionId, "sess-1");
  assert.equal(result.runtimeId, "claude");
});

test("runInstalledRuntimeStream scrubs server secrets while retaining HOME-based CLI auth", async () => {
  const repoRoot = tempRepoWithOneSkill("ingest-profile");
  const env = {
    PATH: "/usr/bin",
    HOME: "/Users/morgan",
    TEMP: "/tmp",
    CAREERRAT_HOME: join(repoRoot, "private"),
    ANTHROPIC_API_KEY: "sentinel-anthropic",
    GITHUB_TOKEN: "sentinel-github",
    NPM_TOKEN: "sentinel-npm",
    APPLE_ID_PASSWORD: "sentinel-apple",
  };
  const seenEnvs = [];
  const terminal = {
    type: "result",
    subtype: "success",
    result: "ok",
    session_id: "sess-safe-env",
  };
  try {
    await runInstalledRuntimeStream({
      runtime: { id: "claude", path: "/safe/claude" },
      prompt: "onboard",
      skill: "ingest-profile",
      repoRoot,
      tools: ["Skill"],
      env,
      timeoutMs: 2000,
      spawnSyncImpl(_command, _args, options) {
        seenEnvs.push(options.env);
        return verifiedClaudeVersion();
      },
      spawnImpl(_command, _args, options) {
        seenEnvs.push(options.env);
        return fakeStreamingChild({ chunks: [ndjson([terminal])] });
      },
    });
    assert.equal(seenEnvs.length, 2);
    for (const childEnv of seenEnvs) {
      assert.equal(childEnv.HOME, "/Users/morgan");
      assert.equal(childEnv.PATH, "/usr/bin");
      assert.equal(childEnv.CAREERRAT_HOME, env.CAREERRAT_HOME);
      assert.equal(childEnv.ANTHROPIC_API_KEY, undefined);
      assert.equal(childEnv.GITHUB_TOKEN, undefined);
      assert.equal(childEnv.NPM_TOKEN, undefined);
      assert.equal(childEnv.APPLE_ID_PASSWORD, undefined);
    }
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test("runInstalledRuntimeStream: a turn with two tool calls (one isError result) streams every message, mappable via mapSdkMessage into the same tool_use/tool_result frames the SDK path produces", async () => {
  const lines = [
    { type: "system", subtype: "init", session_id: "sess-2" },
    {
      type: "assistant",
      session_id: "sess-2",
      message: { content: [{ type: "tool_use", id: "tu1", name: "WebSearch", input: { q: "x" } }] },
    },
    {
      type: "user",
      session_id: "sess-2",
      message: {
        content: [{ type: "tool_result", tool_use_id: "tu1", content: "result1", is_error: false }],
      },
    },
    {
      type: "assistant",
      session_id: "sess-2",
      message: {
        content: [{ type: "tool_use", id: "tu2", name: "WebFetch", input: { url: "y" } }],
      },
    },
    {
      type: "user",
      session_id: "sess-2",
      message: {
        content: [{ type: "tool_result", tool_use_id: "tu2", content: "boom", is_error: true }],
      },
    },
    {
      type: "assistant",
      session_id: "sess-2",
      message: { content: [{ type: "text", text: "Done" }] },
    },
    {
      type: "result",
      subtype: "success",
      result: "Done",
      usage: { input_tokens: 20, output_tokens: 8 },
      session_id: "sess-2",
    },
  ];
  const received = [];
  const result = await runInstalledRuntimeStream({
    runtime: { id: "claude", path: "/safe/claude" },
    prompt: "research this",
    timeoutMs: 2000,
    onMessage: (message) => received.push(message),
    spawnImpl: () => fakeStreamingChild({ chunks: [ndjson(lines)] }),
  });
  assert.equal(received.length, lines.length);

  const { mapSdkMessage } = await import("../src/core/ai/skill-runtime.mjs");
  const frames = received.flatMap((message) => mapSdkMessage(message, { env: {} }));
  const toolFrames = frames.filter((f) => f.type === "tool_use" || f.type === "tool_result");
  assert.deepEqual(
    toolFrames.map((f) => f.type),
    ["tool_use", "tool_result", "tool_use", "tool_result"]
  );
  assert.equal(toolFrames[0].data.id, "tu1");
  assert.equal(toolFrames[0].data.name, "WebSearch");
  assert.equal(toolFrames[1].data.toolUseId, "tu1");
  assert.equal(toolFrames[1].data.isError, false);
  assert.equal(toolFrames[2].data.id, "tu2");
  assert.equal(toolFrames[3].data.toolUseId, "tu2");
  assert.equal(toolFrames[3].data.isError, true);
  assert.equal(result.text, "Done");
});

test("runInstalledRuntimeStream buffers a JSON object split across two stdout chunks into exactly one onMessage call", async () => {
  const resultLine = {
    type: "result",
    subtype: "success",
    result: "reassembled",
    usage: { input_tokens: 1, output_tokens: 1 },
  };
  const whole = `${JSON.stringify({ type: "system", subtype: "init" })}\n${JSON.stringify(resultLine)}\n`;
  // Split mid-object: right after the opening of the result line's JSON.
  const splitPoint = whole.indexOf('"type":"result"') + 5;
  const chunks = [whole.slice(0, splitPoint), whole.slice(splitPoint)];
  const received = [];
  const result = await runInstalledRuntimeStream({
    runtime: { id: "claude", path: "/safe/claude" },
    prompt: "hi",
    timeoutMs: 2000,
    onMessage: (message) => received.push(message),
    spawnImpl: () => fakeStreamingChild({ chunks }),
  });
  assert.equal(received.length, 2);
  assert.deepEqual(received[1], resultLine);
  assert.equal(result.text, "reassembled");
});

test("runInstalledRuntimeStream skips a malformed line mid-stream without crashing the turn", async () => {
  const goodFirst = { type: "system", subtype: "init" };
  const goodResult = { type: "result", subtype: "success", result: "survived" };
  const chunks = [
    `${JSON.stringify(goodFirst)}\n`,
    "{not valid json at all\n",
    `${JSON.stringify(goodResult)}\n`,
  ];
  const received = [];
  const result = await runInstalledRuntimeStream({
    runtime: { id: "claude", path: "/safe/claude" },
    prompt: "hi",
    timeoutMs: 2000,
    onMessage: (message) => received.push(message),
    spawnImpl: () => fakeStreamingChild({ chunks }),
  });
  assert.deepEqual(received, [goodFirst, goodResult]);
  assert.equal(result.text, "survived");
});

test("runInstalledRuntimeStream rejects with RUNTIME_EXIT on a nonzero exit, same shape as runInstalledRuntime", async () => {
  await assert.rejects(
    runInstalledRuntimeStream({
      runtime: { id: "claude", path: "/safe/claude" },
      prompt: "hi",
      timeoutMs: 2000,
      spawnImpl: () =>
        fakeStreamingChild({
          chunks: [`${JSON.stringify({ type: "system", subtype: "init" })}\n`],
          status: 7,
          stderr: "sign in required",
        }),
    }),
    (error) =>
      error.code === "RUNTIME_EXIT" &&
      error.exitStatus === 7 &&
      /sign in required/.test(error.message)
  );
});

test("runInstalledRuntimeStream rejects with RUNTIME_RESULT_MISSING when the process exits 0 with no terminal result line", async () => {
  await assert.rejects(
    runInstalledRuntimeStream({
      runtime: { id: "claude", path: "/safe/claude" },
      prompt: "hi",
      timeoutMs: 2000,
      spawnImpl: () =>
        fakeStreamingChild({
          chunks: [`${JSON.stringify({ type: "system", subtype: "init" })}\n`],
        }),
    }),
    (error) => error.code === "RUNTIME_RESULT_MISSING"
  );
});
