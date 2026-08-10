// apps/web/src/onboarding/EngineScreen.test.jsx
// vitest coverage for the W4 chat-first onboarding surface's engine gate/
// picker (design frames 3d/3f, commit c1d601e3). Same hand-rolled hook
// harness convention as AskBar.test.jsx/JobDrawer.test.jsx (default "node"
// vitest environment, no jsdom) — this file borrows JobDrawer.test.jsx's
// simpler "push effects, run on demand" harness (no dependency diffing)
// since EngineScreen's one mount effect has no cleanup to worry about.

import { beforeEach, describe, expect, it, vi } from "vitest";

const hooks = vi.hoisted(() => ({
  cursor: 0,
  effects: [],
  state: [],
  reset() {
    this.cursor = 0;
    this.effects = [];
  },
  clear() {
    this.cursor = 0;
    this.effects = [];
    this.state = [];
  },
  useState(initial) {
    const index = this.cursor++;
    if (!(index in this.state))
      this.state[index] = typeof initial === "function" ? initial() : initial;
    return [
      this.state[index],
      (next) => {
        this.state[index] = typeof next === "function" ? next(this.state[index]) : next;
      },
    ];
  },
  useEffect(effect) {
    this.effects.push(effect);
  },
}));

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    useEffect: (effect) => hooks.useEffect(effect),
    useState: (initial) => hooks.useState(initial),
  };
});

vi.mock("../components/icons.jsx", () => ({
  CheckIcon: () => null,
}));

const api = vi.hoisted(() => ({
  getInstalledAiRuntimes: vi.fn(),
  openInstalledAiRuntimeTerminal: vi.fn(),
  probeInstalledAiRuntime: vi.fn(),
  selectCustomAiRuntime: vi.fn(),
  selectInstalledAiRuntime: vi.fn(),
  testCustomAiRuntime: vi.fn(),
}));
vi.mock("../lib/api.js", () => api);

import { EngineScreen } from "./EngineScreen.jsx";

// ---------------------------------------------------------------------------
// Render + tree-walking helpers
// ---------------------------------------------------------------------------

function renderRaw(props) {
  hooks.reset();
  return EngineScreen(props);
}

function expand(node) {
  if (node == null || typeof node !== "object") return node;
  if (Array.isArray(node)) return node.map(expand);
  if (typeof node.type === "function") return expand(node.type(node.props));
  return { ...node, props: { ...node.props, children: expand(node.props?.children) } };
}

function visit(node, predicate, found = []) {
  if (node == null || typeof node === "boolean") return found;
  if (Array.isArray(node)) {
    for (const child of node) visit(child, predicate, found);
    return found;
  }
  if (typeof node !== "object") return found;
  if (predicate(node)) found.push(node);
  visit(node.props?.children, predicate, found);
  return found;
}

function textOf(node) {
  if (node == null || typeof node === "boolean") return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textOf).join("");
  return textOf(node.props?.children);
}

function hasClass(node, cls) {
  const className = node.props?.className;
  return typeof className === "string" && className.split(" ").includes(cls);
}

function byClass(tree, cls) {
  return visit(tree, (n) => hasClass(n, cls))[0];
}

function byTag(tree, tag) {
  return visit(tree, (n) => n.type === tag)[0];
}

function button(tree, label) {
  return visit(tree, (n) => n.type === "button" && textOf(n).trim() === label)[0];
}

function link(tree, label) {
  return visit(tree, (n) => n.type === "a" && textOf(n).trim() === label)[0];
}

async function runEffects() {
  for (const effect of hooks.effects) effect();
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

function render(props) {
  return expand(renderRaw(props));
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function runtimeState(runtimes, { selectedId = null, providerFallback = false } = {}) {
  return { selectedId, providerFallback, runtimes };
}

const CLAUDE_READY = {
  id: "claude",
  name: "Claude Code",
  commandShape: "claude -p",
  ready: true,
  available: true,
  status: "ready",
};
const CODEX_READY = {
  id: "codex",
  name: "Codex",
  commandShape: "codex exec -",
  ready: true,
  available: true,
  status: "ready",
};
const GEMINI_SIGNIN = {
  id: "gemini",
  name: "Gemini CLI",
  commandShape: "gemini -p",
  ready: false,
  available: true,
  status: "authentication_required",
  action: "open_terminal",
};
const COPILOT_NOT_FOUND = {
  id: "copilot",
  name: "GitHub Copilot CLI",
  commandShape: "copilot -p -",
  ready: false,
  available: false,
  status: "not_installed",
};
// Same not-found copilot row, but carrying the registry's installUrl field —
// kept as a separate fixture (rather than adding installUrl to
// COPILOT_NOT_FOUND above) so the pre-existing "NOT FOUND" exact-text
// assertions elsewhere don't have to account for the appended install link.
const COPILOT_NOT_FOUND_WITH_INSTALL = {
  ...COPILOT_NOT_FOUND,
  installUrl:
    "https://docs.github.com/en/copilot/how-tos/copilot-cli/set-up-copilot-cli/install-copilot-cli",
};
const CUSTOM_EMPTY = {
  id: "custom",
  name: "Custom command",
  commandShape: null,
  ready: false,
  available: false,
};

beforeEach(() => {
  hooks.clear();
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// mode: gate (0 ready CLIs)
// ---------------------------------------------------------------------------

describe("EngineScreen — gate mode (0 ready CLIs)", () => {
  it("renders the 3d no-CLI gate copy and status, with RE-RUN PROBE and an always-enabled Continue", async () => {
    api.getInstalledAiRuntimes.mockResolvedValue(
      runtimeState([COPILOT_NOT_FOUND, GEMINI_SIGNIN, CUSTOM_EMPTY])
    );
    let tree = render({ mode: "gate", onReady: vi.fn() });
    await runEffects();
    tree = render({ mode: "gate", onReady: vi.fn() });

    expect(textOf(byTag(tree, "h1"))).toBe("No AI engine found.");
    expect(textOf(byClass(tree, "onboarding-app__status"))).toBe("SETUP · ENGINE REQUIRED");
    const rerun = button(tree, "RE-RUN PROBE");
    expect(rerun).toBeTruthy();

    const continueBtn = button(tree, "Continue");
    expect(continueBtn.props.disabled).toBe(false);
  });

  it("shows NOT FOUND for an unavailable runtime and SIGN-IN NEEDED + actions for an available-but-unready one", async () => {
    api.getInstalledAiRuntimes.mockResolvedValue(
      runtimeState([COPILOT_NOT_FOUND, GEMINI_SIGNIN, CUSTOM_EMPTY])
    );
    let tree = render({ mode: "gate", onReady: vi.fn() });
    await runEffects();
    tree = render({ mode: "gate", onReady: vi.fn() });

    const receipts = visit(tree, (n) => hasClass(n, "onboarding-engine__receipt"));
    const receiptTexts = receipts.map(textOf);
    expect(receiptTexts).toContain("NOT FOUND");
    expect(receiptTexts).toContain("SIGN-IN NEEDED");

    expect(button(tree, "Open Terminal")).toBeTruthy();
    expect(button(tree, "Retry")).toBeTruthy();
  });

  it("renders a NOT FOUND · INSTALL GUIDE link for a not-found runtime that carries an installUrl, opening in a new tab", async () => {
    api.getInstalledAiRuntimes.mockResolvedValue(
      runtimeState([COPILOT_NOT_FOUND_WITH_INSTALL, CUSTOM_EMPTY])
    );
    let tree = render({ mode: "gate", onReady: vi.fn() });
    await runEffects();
    tree = render({ mode: "gate", onReady: vi.fn() });

    const receipt = byClass(tree, "onboarding-engine__receipt--muted");
    expect(textOf(receipt)).toBe("NOT FOUND · INSTALL GUIDE");

    const installLink = link(tree, "INSTALL GUIDE");
    expect(installLink).toBeTruthy();
    expect(installLink.props.href).toBe(COPILOT_NOT_FOUND_WITH_INSTALL.installUrl);
    expect(installLink.props.target).toBe("_blank");
    expect(installLink.props.rel).toBe("noreferrer");
  });

  it("omits the install-guide link for a not-found runtime with no installUrl", async () => {
    api.getInstalledAiRuntimes.mockResolvedValue(runtimeState([COPILOT_NOT_FOUND, CUSTOM_EMPTY]));
    let tree = render({ mode: "gate", onReady: vi.fn() });
    await runEffects();
    tree = render({ mode: "gate", onReady: vi.fn() });

    expect(textOf(byClass(tree, "onboarding-engine__receipt--muted"))).toBe("NOT FOUND");
    expect(link(tree, "INSTALL GUIDE")).toBeUndefined();
  });

  it("Retry re-probes the runtime and Open Terminal calls the terminal API, both against the clicked runtime", async () => {
    api.getInstalledAiRuntimes.mockResolvedValue(runtimeState([GEMINI_SIGNIN, CUSTOM_EMPTY]));
    api.probeInstalledAiRuntime.mockResolvedValue({ ok: true });
    api.openInstalledAiRuntimeTerminal.mockResolvedValue({
      ok: true,
      signInCommand: "gemini --help",
    });
    let tree = render({ mode: "gate", onReady: vi.fn() });
    await runEffects();
    tree = render({ mode: "gate", onReady: vi.fn() });

    await button(tree, "Retry").props.onClick();
    expect(api.probeInstalledAiRuntime).toHaveBeenCalledWith("gemini");
    // refresh() re-fetches the runtime list after a retry.
    expect(api.getInstalledAiRuntimes).toHaveBeenCalledTimes(2);

    tree = render({ mode: "gate", onReady: vi.fn() });
    await button(tree, "Open Terminal").props.onClick();
    expect(api.openInstalledAiRuntimeTerminal).toHaveBeenCalledWith("gemini");
  });

  it("a probe failure on mount renders an inline error instead of faking the empty-gate product state", async () => {
    api.getInstalledAiRuntimes.mockRejectedValue(new Error("network down"));
    let tree = render({ mode: "gate", onReady: vi.fn() });
    await expect(runEffects()).resolves.not.toThrow();
    tree = render({ mode: "gate", onReady: vi.fn() });

    // Not the legitimate-empty-probe gate copy — a fetch failure (network,
    // 401/403, 500) must not masquerade as "the rat looked and found nothing".
    expect(textOf(byTag(tree, "h1"))).not.toBe("No AI engine found.");
    const alert = byClass(tree, "inline-alert");
    expect(alert).toBeTruthy();
    expect(textOf(alert)).toBe("Couldn't reach this computer to check for AI CLIs.");
    // No fake rows rendered off the swallowed failure.
    expect(
      visit(
        tree,
        (n) =>
          hasClass(n, "onboarding-engine__choice") &&
          !hasClass(n, "onboarding-engine__choice--custom")
      )
    ).toEqual([]);
    expect(button(tree, "RE-RUN PROBE")).toBeTruthy();
  });

  it("surfaces the server's own error message from an ApiError-shaped failure (e.g. a 403)", async () => {
    const apiError = new Error("request failed with status 403");
    apiError.body = { error: "Forbidden — sign in and try again." };
    api.getInstalledAiRuntimes.mockRejectedValue(apiError);
    let tree = render({ mode: "gate", onReady: vi.fn() });
    await runEffects();
    tree = render({ mode: "gate", onReady: vi.fn() });

    expect(textOf(byClass(tree, "inline-alert"))).toBe("Forbidden — sign in and try again.");
  });

  it("a probe failure in picker mode also renders the inline error with a RE-RUN PROBE recovery action", async () => {
    api.getInstalledAiRuntimes.mockRejectedValue(new Error("network down"));
    let tree = render({ mode: "picker", onReady: vi.fn() });
    await runEffects();
    tree = render({ mode: "picker", onReady: vi.fn() });

    expect(textOf(byTag(tree, "h1"))).not.toBe("Pick your engine.");
    expect(byClass(tree, "inline-alert")).toBeTruthy();
    // Picker mode normally hides RE-RUN PROBE entirely (it's the gate-only
    // recovery affordance) — an error state must still offer a way back.
    expect(button(tree, "RE-RUN PROBE")).toBeTruthy();
  });

  it("RE-RUN PROBE recovers from a failure once the probe succeeds again", async () => {
    api.getInstalledAiRuntimes.mockRejectedValueOnce(new Error("network down"));
    let tree = render({ mode: "gate", onReady: vi.fn() });
    await runEffects();
    tree = render({ mode: "gate", onReady: vi.fn() });
    expect(byClass(tree, "inline-alert")).toBeTruthy();

    api.getInstalledAiRuntimes.mockResolvedValue(runtimeState([COPILOT_NOT_FOUND, CUSTOM_EMPTY]));
    await button(tree, "RE-RUN PROBE").props.onClick();
    tree = render({ mode: "gate", onReady: vi.fn() });

    expect(byClass(tree, "inline-alert")).toBeFalsy();
    expect(textOf(byTag(tree, "h1"))).toBe("No AI engine found.");
    expect(textOf(byClass(tree, "onboarding-engine__receipt--muted"))).toBe("NOT FOUND");
  });
});

// ---------------------------------------------------------------------------
// mode: picker (2+ ready CLIs)
// ---------------------------------------------------------------------------

describe("EngineScreen — picker mode (2+ ready CLIs)", () => {
  it("renders the 3f picker copy/status, DETECTED receipts, and selectable radios", async () => {
    api.getInstalledAiRuntimes.mockResolvedValue(
      runtimeState([CLAUDE_READY, CODEX_READY, CUSTOM_EMPTY])
    );
    let tree = render({ mode: "picker", onReady: vi.fn() });
    await runEffects();
    tree = render({ mode: "picker", onReady: vi.fn() });

    expect(textOf(byTag(tree, "h1"))).toBe("Pick your engine.");
    expect(textOf(byClass(tree, "onboarding-app__status"))).toBe("SETUP · ENGINE");
    const receipts = visit(tree, (n) => hasClass(n, "onboarding-engine__receipt--ok")).map(textOf);
    expect(receipts).toEqual(["DETECTED", "DETECTED"]);
    expect(button(tree, "RE-RUN PROBE")).toBeUndefined();
  });

  it("Continue is disabled until a runtime is picked, then enabled and persists the selection", async () => {
    api.getInstalledAiRuntimes.mockResolvedValue(
      runtimeState([CLAUDE_READY, CODEX_READY, CUSTOM_EMPTY])
    );
    api.selectInstalledAiRuntime.mockResolvedValue({ ok: true });
    const onReady = vi.fn();
    let tree = render({ mode: "picker", onReady });
    await runEffects();
    tree = render({ mode: "picker", onReady });

    let start = button(tree, "Start the interview");
    expect(start.props.disabled).toBe(true);

    const radio = visit(tree, (n) => n.props?.["aria-label"] === "Select Claude Code")[0];
    radio.props.onClick();
    tree = render({ mode: "picker", onReady });
    start = button(tree, "Start the interview");
    expect(start.props.disabled).toBe(false);

    await start.props.onClick();
    expect(api.selectInstalledAiRuntime).toHaveBeenCalledWith({ runtimeId: "claude" });
    expect(onReady).toHaveBeenCalledTimes(1);
  });

  it("does not re-persist a selection that already matches the server's selectedId", async () => {
    api.getInstalledAiRuntimes.mockResolvedValue(
      runtimeState([CLAUDE_READY, CODEX_READY, CUSTOM_EMPTY], { selectedId: "claude" })
    );
    const onReady = vi.fn();
    let tree = render({ mode: "picker", onReady });
    await runEffects();
    tree = render({ mode: "picker", onReady });

    const start = button(tree, "Start the interview");
    expect(start.props.disabled).toBe(false); // pendingId pre-seeded from selectedId
    await start.props.onClick();
    expect(api.selectInstalledAiRuntime).not.toHaveBeenCalled();
    expect(onReady).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// custom-command test flow
// ---------------------------------------------------------------------------

describe("EngineScreen — custom command test flow", () => {
  it("renders the PASSED · RESPONDED IN N.NS receipt and a Use-this-command CTA on success", async () => {
    api.getInstalledAiRuntimes.mockResolvedValue(runtimeState([CUSTOM_EMPTY]));
    api.testCustomAiRuntime.mockResolvedValue({ ok: true, elapsedMs: 1234 });
    let tree = render({ mode: "picker", onReady: vi.fn() });
    await runEffects();
    tree = render({ mode: "picker", onReady: vi.fn() });

    const commandInput = visit(tree, (n) => hasClass(n, "text-input"))[0];
    commandInput.props.onChange({ target: { value: "~/bin/my-agent --chat" } });
    tree = render({ mode: "picker", onReady: vi.fn() });

    const testBtn = button(tree, "Test");
    expect(testBtn.props.disabled).toBe(false);
    await testBtn.props.onClick();
    expect(api.testCustomAiRuntime).toHaveBeenCalledWith("~/bin/my-agent --chat");

    tree = render({ mode: "picker", onReady: vi.fn() });
    const receipt = byClass(tree, "onboarding-engine__custom-receipt--ok");
    // A literal space separates the (mocked-null) CheckIcon from the text in
    // the source JSX (`<CheckIcon /> PASSED · …`).
    expect(textOf(receipt)).toBe(" PASSED · RESPONDED IN 1.2S");
    expect(button(tree, "Use this command")).toBeTruthy();
  });

  it("renders the returned error inline on a failed test, without a Use-this-command CTA", async () => {
    api.getInstalledAiRuntimes.mockResolvedValue(runtimeState([CUSTOM_EMPTY]));
    api.testCustomAiRuntime.mockResolvedValue({ ok: false, error: "Exited with status 1." });
    let tree = render({ mode: "picker", onReady: vi.fn() });
    await runEffects();
    tree = render({ mode: "picker", onReady: vi.fn() });

    const commandInput = visit(tree, (n) => hasClass(n, "text-input"))[0];
    commandInput.props.onChange({ target: { value: "bogus-command" } });
    tree = render({ mode: "picker", onReady: vi.fn() });
    await button(tree, "Test").props.onClick();

    tree = render({ mode: "picker", onReady: vi.fn() });
    const receipt = byClass(tree, "onboarding-engine__custom-receipt--error");
    expect(textOf(receipt)).toBe("Exited with status 1.");
    expect(button(tree, "Use this command")).toBeUndefined();
  });

  it("degrades to a generic failure message when the test call itself throws", async () => {
    api.getInstalledAiRuntimes.mockResolvedValue(runtimeState([CUSTOM_EMPTY]));
    api.testCustomAiRuntime.mockRejectedValue(new Error("network error"));
    let tree = render({ mode: "picker", onReady: vi.fn() });
    await runEffects();
    tree = render({ mode: "picker", onReady: vi.fn() });

    const commandInput = visit(tree, (n) => hasClass(n, "text-input"))[0];
    commandInput.props.onChange({ target: { value: "bogus-command" } });
    tree = render({ mode: "picker", onReady: vi.fn() });
    await button(tree, "Test").props.onClick();

    tree = render({ mode: "picker", onReady: vi.fn() });
    const receipt = byClass(tree, "onboarding-engine__custom-receipt--error");
    expect(textOf(receipt)).toBe("Could not run the test.");
  });

  it("Use this command persists the custom command and re-selects it as pending", async () => {
    api.getInstalledAiRuntimes.mockResolvedValue(runtimeState([CUSTOM_EMPTY]));
    api.testCustomAiRuntime.mockResolvedValue({ ok: true, elapsedMs: 500 });
    api.selectCustomAiRuntime.mockResolvedValue({ ok: true });
    let tree = render({ mode: "picker", onReady: vi.fn() });
    await runEffects();
    tree = render({ mode: "picker", onReady: vi.fn() });

    const commandInput = visit(tree, (n) => hasClass(n, "text-input"))[0];
    commandInput.props.onChange({ target: { value: "~/bin/my-agent" } });
    tree = render({ mode: "picker", onReady: vi.fn() });
    await button(tree, "Test").props.onClick();
    tree = render({ mode: "picker", onReady: vi.fn() });

    await button(tree, "Use this command").props.onClick();
    expect(api.selectCustomAiRuntime).toHaveBeenCalledWith("~/bin/my-agent");
    // refresh() called again after selecting.
    expect(api.getInstalledAiRuntimes).toHaveBeenCalledTimes(2);
  });

  it("the Test button stays disabled with blank/whitespace-only input", async () => {
    api.getInstalledAiRuntimes.mockResolvedValue(runtimeState([CUSTOM_EMPTY]));
    let tree = render({ mode: "picker", onReady: vi.fn() });
    await runEffects();
    tree = render({ mode: "picker", onReady: vi.fn() });
    expect(button(tree, "Test").props.disabled).toBe(true);

    const commandInput = visit(tree, (n) => hasClass(n, "text-input"))[0];
    commandInput.props.onChange({ target: { value: "   " } });
    tree = render({ mode: "picker", onReady: vi.fn() });
    expect(button(tree, "Test").props.disabled).toBe(true);
  });
});
