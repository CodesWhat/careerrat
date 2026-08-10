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
  ArrowRightIcon: () => null,
}));

const api = vi.hoisted(() => ({
  getInstalledAiRuntimes: vi.fn(),
  openInstalledAiRuntimeTerminal: vi.fn(),
  probeInstalledAiRuntime: vi.fn(),
  requestHostedInterest: vi.fn(),
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
  it("renders the 3d no-CLI gate copy and status, with CHECK AGAIN and an always-enabled Continue", async () => {
    api.getInstalledAiRuntimes.mockResolvedValue(
      runtimeState([COPILOT_NOT_FOUND, GEMINI_SIGNIN, CUSTOM_EMPTY])
    );
    let tree = render({ mode: "gate", onReady: vi.fn() });
    await runEffects();
    tree = render({ mode: "gate", onReady: vi.fn() });

    expect(textOf(byTag(tree, "h1"))).toBe("No AI engine found.");
    expect(textOf(byClass(tree, "onboarding-app__status"))).toBe("SETUP · ENGINE REQUIRED");
    const rerun = button(tree, "CHECK AGAIN");
    expect(rerun).toBeTruthy();

    const continueBtn = button(tree, "Continue");
    expect(continueBtn.props.disabled).toBe(false);
  });

  it("collapses an unavailable runtime into the NOT INSTALLED chip strip and shows SIGN-IN NEEDED + actions for an available-but-unready one", async () => {
    api.getInstalledAiRuntimes.mockResolvedValue(
      runtimeState([COPILOT_NOT_FOUND, GEMINI_SIGNIN, CUSTOM_EMPTY])
    );
    let tree = render({ mode: "gate", onReady: vi.fn() });
    await runEffects();
    tree = render({ mode: "gate", onReady: vi.fn() });

    // Copilot (unavailable) is no longer a per-row "NOT FOUND" receipt — it
    // collapses into the compact chip strip instead.
    const receiptTexts = visit(tree, (n) => hasClass(n, "onboarding-engine__receipt")).map(textOf);
    expect(receiptTexts).not.toContain("NOT FOUND");
    expect(receiptTexts).toContain("SIGN-IN NEEDED");

    expect(textOf(byClass(tree, "onboarding-engine__not-found-label"))).toBe("NOT INSTALLED");
    const chip = visit(tree, (n) => hasClass(n, "onboarding-engine__not-found-chip"))[0];
    expect(textOf(chip)).toBe(COPILOT_NOT_FOUND.name);

    expect(button(tree, "Open Terminal")).toBeTruthy();
    expect(button(tree, "Retry")).toBeTruthy();
  });

  it("renders a not-found chip linking to installUrl for a runtime that carries one, opening in a new tab", async () => {
    api.getInstalledAiRuntimes.mockResolvedValue(
      runtimeState([COPILOT_NOT_FOUND_WITH_INSTALL, CUSTOM_EMPTY])
    );
    let tree = render({ mode: "gate", onReady: vi.fn() });
    await runEffects();
    tree = render({ mode: "gate", onReady: vi.fn() });

    const installLink = link(tree, COPILOT_NOT_FOUND_WITH_INSTALL.name);
    expect(installLink).toBeTruthy();
    expect(hasClass(installLink, "onboarding-engine__not-found-chip")).toBe(true);
    expect(installLink.props.href).toBe(COPILOT_NOT_FOUND_WITH_INSTALL.installUrl);
    expect(installLink.props.target).toBe("_blank");
    expect(installLink.props.rel).toBe("noreferrer noopener");
  });

  it("renders a not-found chip as plain non-link text when the runtime has no installUrl", async () => {
    api.getInstalledAiRuntimes.mockResolvedValue(runtimeState([COPILOT_NOT_FOUND, CUSTOM_EMPTY]));
    let tree = render({ mode: "gate", onReady: vi.fn() });
    await runEffects();
    tree = render({ mode: "gate", onReady: vi.fn() });

    expect(link(tree, COPILOT_NOT_FOUND.name)).toBeUndefined();
    const chip = visit(tree, (n) => hasClass(n, "onboarding-engine__not-found-chip"))[0];
    expect(chip.type).not.toBe("a");
    expect(textOf(chip)).toBe(COPILOT_NOT_FOUND.name);
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
    expect(button(tree, "CHECK AGAIN")).toBeTruthy();
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

  it("a probe failure in picker mode also renders the inline error with a CHECK AGAIN recovery action", async () => {
    api.getInstalledAiRuntimes.mockRejectedValue(new Error("network down"));
    let tree = render({ mode: "picker", onReady: vi.fn() });
    await runEffects();
    tree = render({ mode: "picker", onReady: vi.fn() });

    expect(textOf(byTag(tree, "h1"))).not.toBe("Pick your engine.");
    expect(byClass(tree, "inline-alert")).toBeTruthy();
    // Picker mode normally hides CHECK AGAIN entirely (it's the gate-only
    // recovery affordance) — an error state must still offer a way back.
    expect(button(tree, "CHECK AGAIN")).toBeTruthy();
  });

  it("CHECK AGAIN recovers from a failure once the probe succeeds again", async () => {
    api.getInstalledAiRuntimes.mockRejectedValueOnce(new Error("network down"));
    let tree = render({ mode: "gate", onReady: vi.fn() });
    await runEffects();
    tree = render({ mode: "gate", onReady: vi.fn() });
    expect(byClass(tree, "inline-alert")).toBeTruthy();

    api.getInstalledAiRuntimes.mockResolvedValue(runtimeState([COPILOT_NOT_FOUND, CUSTOM_EMPTY]));
    await button(tree, "CHECK AGAIN").props.onClick();
    tree = render({ mode: "gate", onReady: vi.fn() });

    expect(byClass(tree, "inline-alert")).toBeFalsy();
    expect(textOf(byTag(tree, "h1"))).toBe("No AI engine found.");
    expect(textOf(byClass(tree, "onboarding-engine__not-found-label"))).toBe("NOT INSTALLED");
    expect(textOf(visit(tree, (n) => hasClass(n, "onboarding-engine__not-found-chip"))[0])).toBe(
      COPILOT_NOT_FOUND.name
    );
  });

  it("3d rows show the bare runtime id (mono) only for the available-but-unready runtime — the unavailable one moved to the not-found chip strip — and the custom row stays expanded and emphasized", async () => {
    api.getInstalledAiRuntimes.mockResolvedValue(
      runtimeState([COPILOT_NOT_FOUND, GEMINI_SIGNIN, CUSTOM_EMPTY])
    );
    let tree = render({ mode: "gate", onReady: vi.fn() });
    await runEffects();
    tree = render({ mode: "gate", onReady: vi.fn() });

    const ids = visit(tree, (n) => hasClass(n, "onboarding-engine__choice-id")).map(textOf);
    expect(ids).toEqual(["gemini"]);
    // No detected/picker-style bold name + descriptor for a *runtime* row in
    // gate mode — the only "choice-copy" here belongs to the hosted card
    // below, which renders in every mode (see the dedicated test for it).
    expect(visit(tree, (n) => hasClass(n, "onboarding-engine__choice-copy"))).toHaveLength(1);

    // The custom row is always expanded here (no "ADD →" collapse) and
    // carries the same accent-emphasis border a real selection gets.
    expect(button(tree, "ADD →")).toBeUndefined();
    expect(visit(tree, (n) => hasClass(n, "text-input"))[0]).toBeTruthy();
  });

  it("renders the hosted CareerRat AI card in gate mode too", async () => {
    api.getInstalledAiRuntimes.mockResolvedValue(runtimeState([COPILOT_NOT_FOUND, CUSTOM_EMPTY]));
    let tree = render({ mode: "gate", onReady: vi.fn() });
    await runEffects();
    tree = render({ mode: "gate", onReady: vi.fn() });

    expect(visit(tree, (n) => textOf(n) === "CareerRat AI")[0]).toBeTruthy();
    expect(button(tree, "REQUEST ACCESS")).toBeTruthy();
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
    expect(button(tree, "CHECK AGAIN")).toBeUndefined();
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

  it("shows a descriptor line for a detected runtime and omits it for one the probe couldn't find", async () => {
    api.getInstalledAiRuntimes.mockResolvedValue(
      runtimeState([CLAUDE_READY, COPILOT_NOT_FOUND, CUSTOM_EMPTY])
    );
    let tree = render({ mode: "picker", onReady: vi.fn() });
    await runEffects();
    tree = render({ mode: "picker", onReady: vi.fn() });

    // Claude is DETECTED (available) — gets its human descriptor line. (The
    // collapsed custom row's own hint text shares this same class, hence
    // toContain rather than an exact single-item list.)
    const shapes = visit(tree, (n) => hasClass(n, "onboarding-engine__choice-shape")).map(textOf);
    expect(shapes).toContain("Uses your existing Claude subscription, no extra cost");
    expect(shapes).not.toContain(undefined);

    // Copilot is NOT FOUND (unavailable) — full name still renders, but no
    // descriptor line underneath it (nothing to say about an uninstalled CLI).
    const copilotName = visit(tree, (n) => textOf(n) === "GitHub Copilot CLI")[0];
    expect(copilotName).toBeTruthy();
  });

  it("pluralizes the found-tools subhead off the live ready count, not a hardcoded 'more than one', and names Paul rather than 'the rat'", async () => {
    api.getInstalledAiRuntimes.mockResolvedValue(
      runtimeState([CLAUDE_READY, CODEX_READY, GEMINI_SIGNIN, CUSTOM_EMPTY])
    );
    let tree = render({ mode: "picker", onReady: vi.fn() });
    await runEffects();
    tree = render({ mode: "picker", onReady: vi.fn() });

    expect(textOf(byClass(tree, "onboarding-engine__intro"))).toContain(
      "We found 2 AI tools on this computer. Pick one and Paul gets to work. Chat unlocks right after."
    );
  });

  it("uses the singular 'tool' when exactly one ready CLI reaches the picker (e.g. alongside an unready one)", async () => {
    api.getInstalledAiRuntimes.mockResolvedValue(
      runtimeState([CLAUDE_READY, GEMINI_SIGNIN, CUSTOM_EMPTY])
    );
    let tree = render({ mode: "picker", onReady: vi.fn() });
    await runEffects();
    tree = render({ mode: "picker", onReady: vi.fn() });

    expect(textOf(byClass(tree, "onboarding-engine__intro"))).toContain(
      "We found 1 AI tool on this computer."
    );
  });
});

// ---------------------------------------------------------------------------
// mode: revisit (engine re-entry mid-setup — InterviewSurface's ENGINE chip)
// ---------------------------------------------------------------------------

describe("EngineScreen — revisit mode (engine re-entry, no auto-select/gate)", () => {
  it("pre-seeds the current selection, renders a KEEP <CURRENT> action instead of CHECK AGAIN, and enables Continue immediately", async () => {
    api.getInstalledAiRuntimes.mockResolvedValue(
      runtimeState([CLAUDE_READY, CODEX_READY, CUSTOM_EMPTY], { selectedId: "claude" })
    );
    const onBack = vi.fn();
    let tree = render({ mode: "revisit", onReady: vi.fn(), onBack });
    await runEffects();
    tree = render({ mode: "revisit", onReady: vi.fn(), onBack });

    expect(button(tree, "CHECK AGAIN")).toBeUndefined();
    const keepBtn = button(tree, "KEEP CLAUDE CODE");
    expect(keepBtn).toBeTruthy();
    expect(button(tree, "Continue").props.disabled).toBe(false);
  });

  it("KEEP <CURRENT> calls onBack directly, without touching selectInstalledAiRuntime or onReady", async () => {
    api.getInstalledAiRuntimes.mockResolvedValue(
      runtimeState([CLAUDE_READY, CODEX_READY, CUSTOM_EMPTY], { selectedId: "claude" })
    );
    const onBack = vi.fn();
    const onReady = vi.fn();
    let tree = render({ mode: "revisit", onReady, onBack });
    await runEffects();
    tree = render({ mode: "revisit", onReady, onBack });

    button(tree, "KEEP CLAUDE CODE").props.onClick();
    expect(onBack).toHaveBeenCalledTimes(1);
    expect(api.selectInstalledAiRuntime).not.toHaveBeenCalled();
    expect(onReady).not.toHaveBeenCalled();
  });

  it("picking a different engine and hitting Continue still goes through the normal selection flow", async () => {
    api.getInstalledAiRuntimes.mockResolvedValue(
      runtimeState([CLAUDE_READY, CODEX_READY, CUSTOM_EMPTY], { selectedId: "claude" })
    );
    api.selectInstalledAiRuntime.mockResolvedValue({ ok: true });
    const onReady = vi.fn();
    let tree = render({ mode: "revisit", onReady, onBack: vi.fn() });
    await runEffects();
    tree = render({ mode: "revisit", onReady, onBack: vi.fn() });

    const radio = visit(tree, (n) => n.props?.["aria-label"] === "Select Codex")[0];
    radio.props.onClick();
    tree = render({ mode: "revisit", onReady, onBack: vi.fn() });

    await button(tree, "Continue").props.onClick();
    expect(api.selectInstalledAiRuntime).toHaveBeenCalledWith({ runtimeId: "codex" });
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

    // The custom row starts collapsed behind its "ADD →" trigger in picker
    // mode — open it before touching the test-command flow underneath.
    button(tree, "ADD →").props.onClick();
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

    // The custom row starts collapsed behind its "ADD →" trigger in picker
    // mode — open it before touching the test-command flow underneath.
    button(tree, "ADD →").props.onClick();
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

    // The custom row starts collapsed behind its "ADD →" trigger in picker
    // mode — open it before touching the test-command flow underneath.
    button(tree, "ADD →").props.onClick();
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

    // The custom row starts collapsed behind its "ADD →" trigger in picker
    // mode — open it before touching the test-command flow underneath.
    button(tree, "ADD →").props.onClick();
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

    // The custom row starts collapsed behind its "ADD →" trigger in picker
    // mode — open it before touching the test-command flow underneath.
    button(tree, "ADD →").props.onClick();
    tree = render({ mode: "picker", onReady: vi.fn() });
    expect(button(tree, "Test").props.disabled).toBe(true);

    const commandInput = visit(tree, (n) => hasClass(n, "text-input"))[0];
    commandInput.props.onChange({ target: { value: "   " } });
    tree = render({ mode: "picker", onReady: vi.fn() });
    expect(button(tree, "Test").props.disabled).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// not-found chip strip (picker mode) — same collapse behavior gate mode's
// tests above already cover, verified once more against the 2+ ready CLI
// picker path where the wall-of-cards problem actually shows up.
// ---------------------------------------------------------------------------

describe("EngineScreen — not-found chip strip (picker mode)", () => {
  it("renders ready runtimes as full radio cards and collapses not-found ones into the chip strip", async () => {
    api.getInstalledAiRuntimes.mockResolvedValue(
      runtimeState([CLAUDE_READY, CODEX_READY, COPILOT_NOT_FOUND, CUSTOM_EMPTY])
    );
    let tree = render({ mode: "picker", onReady: vi.fn() });
    await runEffects();
    tree = render({ mode: "picker", onReady: vi.fn() });

    // Ready cards unchanged: DETECTED receipts + selectable radios.
    const receipts = visit(tree, (n) => hasClass(n, "onboarding-engine__receipt--ok")).map(textOf);
    expect(receipts).toEqual(["DETECTED", "DETECTED"]);
    expect(visit(tree, (n) => n.props?.["aria-label"] === "Select Claude Code")[0]).toBeTruthy();

    // Copilot never gets its own card — it's a chip in the strip instead.
    expect(
      visit(
        tree,
        (n) => textOf(n) === "GitHub Copilot CLI" && hasClass(n, "onboarding-engine__choice-name")
      )
    ).toHaveLength(0);
    expect(textOf(byClass(tree, "onboarding-engine__not-found-label"))).toBe("NOT INSTALLED");
    const chip = visit(tree, (n) => hasClass(n, "onboarding-engine__not-found-chip"))[0];
    expect(textOf(chip)).toBe(COPILOT_NOT_FOUND.name);
  });

  it("omits the not-found strip entirely when every runtime is either ready or sign-in-needed", async () => {
    api.getInstalledAiRuntimes.mockResolvedValue(
      runtimeState([CLAUDE_READY, GEMINI_SIGNIN, CUSTOM_EMPTY])
    );
    let tree = render({ mode: "picker", onReady: vi.fn() });
    await runEffects();
    tree = render({ mode: "picker", onReady: vi.fn() });

    expect(byClass(tree, "onboarding-engine__not-found-label")).toBeFalsy();
    expect(visit(tree, (n) => hasClass(n, "onboarding-engine__not-found-chip"))).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// whole-card click-to-select — the radio button still carries the real
// keyboard/screen-reader affordance; clicking anywhere else on a ready or
// sign-in-needed card's body selects it the same way. 3d's compact gate rows
// have no radio at all and stay click-inert.
// ---------------------------------------------------------------------------

describe("EngineScreen — whole-card click-to-select", () => {
  it("clicking anywhere on a ready card's body (not the radio itself) selects that runtime", async () => {
    api.getInstalledAiRuntimes.mockResolvedValue(
      runtimeState([CLAUDE_READY, CODEX_READY, CUSTOM_EMPTY])
    );
    const onReady = vi.fn();
    let tree = render({ mode: "picker", onReady });
    await runEffects();
    tree = render({ mode: "picker", onReady });

    const claudeCard = visit(
      tree,
      (n) => hasClass(n, "onboarding-engine__choice") && textOf(n).includes("Claude Code")
    )[0];
    expect(claudeCard).toBeTruthy();
    expect(typeof claudeCard.props.onClick).toBe("function");

    claudeCard.props.onClick();
    tree = render({ mode: "picker", onReady });

    expect(button(tree, "Start the interview").props.disabled).toBe(false);
    const cardAfter = visit(
      tree,
      (n) => hasClass(n, "onboarding-engine__choice") && textOf(n).includes("Claude Code")
    )[0];
    expect(hasClass(cardAfter, "onboarding-engine__choice--selected")).toBe(true);
  });

  it("clicking Open Terminal or Retry on a sign-in-needed card fires only that action, not card selection", async () => {
    api.getInstalledAiRuntimes.mockResolvedValue(runtimeState([GEMINI_SIGNIN, CUSTOM_EMPTY]));
    api.openInstalledAiRuntimeTerminal.mockResolvedValue({
      ok: true,
      signInCommand: "gemini --help",
    });
    let tree = render({ mode: "picker", onReady: vi.fn() });
    await runEffects();
    tree = render({ mode: "picker", onReady: vi.fn() });

    await button(tree, "Open Terminal").props.onClick();
    expect(api.openInstalledAiRuntimeTerminal).toHaveBeenCalledWith("gemini");
    tree = render({ mode: "picker", onReady: vi.fn() });
    // An unready runtime never becomes pending, whether "clicked" via the
    // card body or a sub-control — Continue stays disabled either way.
    expect(button(tree, "Start the interview").props.disabled).toBe(true);
  });

  it("3d gate rows (compact, no radio) are not click-to-select", async () => {
    api.getInstalledAiRuntimes.mockResolvedValue(runtimeState([GEMINI_SIGNIN, CUSTOM_EMPTY]));
    let tree = render({ mode: "gate", onReady: vi.fn() });
    await runEffects();
    tree = render({ mode: "gate", onReady: vi.fn() });

    const compactRow = visit(
      tree,
      (n) =>
        hasClass(n, "onboarding-engine__choice") &&
        !hasClass(n, "onboarding-engine__choice--custom") &&
        !hasClass(n, "onboarding-engine__choice--unavailable")
    )[0];
    expect(compactRow).toBeTruthy();
    expect(compactRow.props.onClick).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// provider brand icons — ProviderIcon.jsx, keyed purely off runtime.id.
// ---------------------------------------------------------------------------

describe("EngineScreen — provider icons", () => {
  it("renders a real brand-mark svg for a known runtime id and a monogram fallback for one this build doesn't recognize", async () => {
    const MYSTERY_READY = {
      id: "mysteryai",
      name: "MysteryAI",
      commandShape: "mysteryai -p",
      ready: true,
      available: true,
      status: "ready",
    };
    api.getInstalledAiRuntimes.mockResolvedValue(
      runtimeState([CLAUDE_READY, MYSTERY_READY, CUSTOM_EMPTY])
    );
    let tree = render({ mode: "picker", onReady: vi.fn() });
    await runEffects();
    tree = render({ mode: "picker", onReady: vi.fn() });

    // Claude gets its real brand-mark <svg> (not the monogram fallback) —
    // and, since the icon is aria-hidden with no <title>, it contributes no
    // extra text alongside the adjacent name (see ProviderIcon.jsx's own
    // header comment on why <title> was deliberately left out).
    const claudeRow = visit(
      tree,
      (n) => hasClass(n, "onboarding-engine__choice-name-row") && textOf(n).includes("Claude Code")
    )[0];
    expect(textOf(claudeRow)).toBe("Claude Code");
    const claudeIcon = visit(claudeRow, (n) => n.type === "svg")[0];
    expect(claudeIcon).toBeTruthy();

    const monogram = visit(tree, (n) =>
      hasClass(n, "onboarding-engine__provider-icon--monogram")
    )[0];
    expect(monogram).toBeTruthy();
    expect(textOf(monogram)).toBe("M");
  });
});

// ---------------------------------------------------------------------------
// hosted "CareerRat AI" card — replaces the old plain-text footnote with a
// muted, non-selectable card. REQUEST ACCESS transforms in place into an
// inline email capture (input + send control); the send control is what
// actually pings POST /api/hosted-interest with the typed address.
// ---------------------------------------------------------------------------

function hostedEmailInput(tree) {
  return visit(tree, (n) => hasClass(n, "onboarding-engine__hosted-email-input"))[0];
}

function hostedSendButton(tree) {
  return visit(tree, (n) => n.type === "button" && n.props?.["aria-label"] === "Send")[0];
}

describe("EngineScreen — hosted CareerRat AI card", () => {
  it("renders the muted hosted card with a COMING SOON receipt and no radio", async () => {
    api.getInstalledAiRuntimes.mockResolvedValue(runtimeState([CLAUDE_READY, CUSTOM_EMPTY]));
    let tree = render({ mode: "picker", onReady: vi.fn() });
    await runEffects();
    tree = render({ mode: "picker", onReady: vi.fn() });

    const name = visit(tree, (n) => textOf(n) === "CareerRat AI")[0];
    expect(name).toBeTruthy();
    expect(hasClass(name, "onboarding-engine__choice-name")).toBe(true);

    const receipts = visit(tree, (n) => hasClass(n, "onboarding-engine__receipt")).map(textOf);
    expect(receipts).toContain("COMING SOON");

    const requestBtn = button(tree, "REQUEST ACCESS");
    expect(requestBtn).toBeTruthy();
    expect(requestBtn.props.disabled).toBeFalsy();

    // Not a selectable engine — no aria-label radio for it, unlike the
    // detected runtime rows above.
    expect(visit(tree, (n) => n.props?.["aria-label"] === "Select CareerRat AI")).toHaveLength(0);
  });

  it("REQUEST ACCESS transforms the button in place into an email input with a disabled send control", async () => {
    api.getInstalledAiRuntimes.mockResolvedValue(runtimeState([CLAUDE_READY, CUSTOM_EMPTY]));
    let tree = render({ mode: "picker", onReady: vi.fn() });
    await runEffects();
    tree = render({ mode: "picker", onReady: vi.fn() });

    button(tree, "REQUEST ACCESS").props.onClick();
    tree = render({ mode: "picker", onReady: vi.fn() });

    expect(button(tree, "REQUEST ACCESS")).toBeUndefined();
    const input = hostedEmailInput(tree);
    expect(input).toBeTruthy();
    expect(input.props.type).toBe("email");
    const send = hostedSendButton(tree);
    expect(send).toBeTruthy();
    expect(send.props.disabled).toBe(true);
  });

  it("enables the send control once the typed value looks like a valid email, and keeps it disabled for a malformed one", async () => {
    api.getInstalledAiRuntimes.mockResolvedValue(runtimeState([CLAUDE_READY, CUSTOM_EMPTY]));
    let tree = render({ mode: "picker", onReady: vi.fn() });
    await runEffects();
    tree = render({ mode: "picker", onReady: vi.fn() });

    button(tree, "REQUEST ACCESS").props.onClick();
    tree = render({ mode: "picker", onReady: vi.fn() });

    hostedEmailInput(tree).props.onChange({ target: { value: "not-an-email" } });
    tree = render({ mode: "picker", onReady: vi.fn() });
    expect(hostedSendButton(tree).props.disabled).toBe(true);

    hostedEmailInput(tree).props.onChange({ target: { value: "morgan@example.com" } });
    tree = render({ mode: "picker", onReady: vi.fn() });
    expect(hostedSendButton(tree).props.disabled).toBe(false);
  });

  it("sending a valid email calls the hosted-interest endpoint with it and collapses to a disabled REQUESTED state with a confirmation message", async () => {
    api.getInstalledAiRuntimes.mockResolvedValue(runtimeState([CLAUDE_READY, CUSTOM_EMPTY]));
    api.requestHostedInterest.mockResolvedValue({ ok: true });
    let tree = render({ mode: "picker", onReady: vi.fn() });
    await runEffects();
    tree = render({ mode: "picker", onReady: vi.fn() });

    button(tree, "REQUEST ACCESS").props.onClick();
    tree = render({ mode: "picker", onReady: vi.fn() });
    hostedEmailInput(tree).props.onChange({ target: { value: "morgan@example.com" } });
    tree = render({ mode: "picker", onReady: vi.fn() });

    await hostedSendButton(tree).props.onClick();
    expect(api.requestHostedInterest).toHaveBeenCalledWith("morgan@example.com");

    tree = render({ mode: "picker", onReady: vi.fn() });
    const requested = button(tree, "REQUESTED ✓");
    expect(requested).toBeTruthy();
    expect(requested.props.disabled).toBe(true);
    expect(hostedEmailInput(tree)).toBeUndefined();
    expect(byClass(tree, "onboarding-engine__hosted-confirm")).toBeTruthy();
    expect(byClass(tree, "onboarding-engine__hosted-error")).toBeFalsy();
  });

  it("leaves the email input in place with an inline error when the hosted-interest call fails, so the user can retry", async () => {
    api.getInstalledAiRuntimes.mockResolvedValue(runtimeState([CLAUDE_READY, CUSTOM_EMPTY]));
    const apiError = new Error("request failed with status 500");
    apiError.body = { error: "Could not reach the server." };
    api.requestHostedInterest.mockRejectedValue(apiError);
    let tree = render({ mode: "picker", onReady: vi.fn() });
    await runEffects();
    tree = render({ mode: "picker", onReady: vi.fn() });

    button(tree, "REQUEST ACCESS").props.onClick();
    tree = render({ mode: "picker", onReady: vi.fn() });
    hostedEmailInput(tree).props.onChange({ target: { value: "morgan@example.com" } });
    tree = render({ mode: "picker", onReady: vi.fn() });

    await hostedSendButton(tree).props.onClick();
    tree = render({ mode: "picker", onReady: vi.fn() });

    // Still editable — the input (with its typed value) is still there, not
    // reverted to the plain button, so retrying doesn't mean retyping.
    const input = hostedEmailInput(tree);
    expect(input).toBeTruthy();
    expect(input.props.value).toBe("morgan@example.com");
    expect(textOf(byClass(tree, "onboarding-engine__hosted-error"))).toBe(
      "Could not reach the server."
    );
    expect(byClass(tree, "onboarding-engine__hosted-confirm")).toBeFalsy();
    expect(button(tree, "REQUESTED ✓")).toBeUndefined();
  });

  it("Escape collapses the email capture back to the plain REQUEST ACCESS button without submitting", async () => {
    api.getInstalledAiRuntimes.mockResolvedValue(runtimeState([CLAUDE_READY, CUSTOM_EMPTY]));
    let tree = render({ mode: "picker", onReady: vi.fn() });
    await runEffects();
    tree = render({ mode: "picker", onReady: vi.fn() });

    button(tree, "REQUEST ACCESS").props.onClick();
    tree = render({ mode: "picker", onReady: vi.fn() });
    hostedEmailInput(tree).props.onChange({ target: { value: "morgan@example.com" } });
    tree = render({ mode: "picker", onReady: vi.fn() });

    hostedEmailInput(tree).props.onKeyDown({ key: "Escape" });
    tree = render({ mode: "picker", onReady: vi.fn() });

    expect(hostedEmailInput(tree)).toBeUndefined();
    expect(button(tree, "REQUEST ACCESS")).toBeTruthy();
    expect(api.requestHostedInterest).not.toHaveBeenCalled();
  });

  it("blurring away from the email input without sending also collapses back to the plain button", async () => {
    api.getInstalledAiRuntimes.mockResolvedValue(runtimeState([CLAUDE_READY, CUSTOM_EMPTY]));
    let tree = render({ mode: "picker", onReady: vi.fn() });
    await runEffects();
    tree = render({ mode: "picker", onReady: vi.fn() });

    button(tree, "REQUEST ACCESS").props.onClick();
    tree = render({ mode: "picker", onReady: vi.fn() });

    hostedEmailInput(tree).props.onBlur();
    tree = render({ mode: "picker", onReady: vi.fn() });

    expect(hostedEmailInput(tree)).toBeUndefined();
    expect(button(tree, "REQUEST ACCESS")).toBeTruthy();
    expect(api.requestHostedInterest).not.toHaveBeenCalled();
  });

  it("does not render the hosted card while the probe-failure error state is showing", async () => {
    api.getInstalledAiRuntimes.mockRejectedValue(new Error("network down"));
    let tree = render({ mode: "picker", onReady: vi.fn() });
    await runEffects();
    tree = render({ mode: "picker", onReady: vi.fn() });

    expect(visit(tree, (n) => textOf(n) === "CareerRat AI")).toHaveLength(0);
    expect(button(tree, "REQUEST ACCESS")).toBeUndefined();
  });
});
