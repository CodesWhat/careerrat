// apps/web/src/onboarding/InterviewSurface.test.jsx
// vitest coverage for the W4 chat-first onboarding interview surface (design
// frames 3a/3b/3c/3e, commit c1d601e3). Same house convention as
// JobDrawer.test.jsx: default "node" vitest environment, no jsdom — a
// hand-rolled hook harness (useState/useEffect/useRef/useCallback) replaces
// React's own, the component is invoked as a plain function, and the
// returned element tree is walked directly.
//
// FilePane.jsx and OnboardingBar.jsx are mocked to capture-only stand-ins
// (they have their own dedicated test files) so this file can drive
// InterviewSurface's own state machine — docking, SSE event handling,
// résumé-drop wiring, and dual-drive pill posting — directly through their
// captured props/callbacks without needing jsdom to render real DOM.
//
// IMPORTANT ordering note for anyone extending this file: this harness's
// useRef (like JobDrawer.test.jsx's) returns a brand-new {current} object on
// every call rather than a cursor-indexed persistent one. That's safe here
// only because prevDoneRef/resumedRef are read back within closures captured
// from the SAME render() pass that created them — tests that need a ref's
// mutation to survive must reuse one render's captured callbacks rather than
// calling render() again in between (see the "receipt diff" test below for
// the pattern).

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
    useCallback: (fn) => fn,
    useEffect: (effect) => hooks.useEffect(effect),
    useRef: (initial) => ({ current: initial }),
    useState: (initial) => hooks.useState(initial),
  };
});

vi.mock("../components/Toast.jsx", () => ({ InlineAlert: "inline-alert" }));

const captured = vi.hoisted(() => ({ filePane: null, onboardingBar: null }));
vi.mock("./FilePane.jsx", () => ({
  FilePane: (props) => {
    captured.filePane = props;
    return null;
  },
}));
vi.mock("./OnboardingBar.jsx", () => ({
  OnboardingBar: (props) => {
    captured.onboardingBar = props;
    return null;
  },
}));

const sse = vi.hoisted(() => ({ calls: [] }));
vi.mock("../lib/sse.js", () => ({
  useEventSource: (url, opts) => {
    sse.calls.push({ url, opts });
  },
}));

const api = vi.hoisted(() => ({
  extractResumeAi: vi.fn(),
  extractResumeDocx: vi.fn(),
  findChatBySkill: vi.fn(),
  getOnboardState: vi.fn(),
  getSourcingRun: vi.fn(),
  parseResumeText: vi.fn(),
  saveCandidateFile: vi.fn(),
  saveEvidenceSeed: vi.fn(),
  sendChatMessage: vi.fn(),
  startChat: vi.fn(),
  startFirstSearchRun: vi.fn(),
}));
vi.mock("../lib/api.js", () => api);

import { InterviewSurface } from "./InterviewSurface.jsx";

// ---------------------------------------------------------------------------
// Render + tree-walking helpers
// ---------------------------------------------------------------------------

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
  return visit(tree, (n) => hasClass(n, cls));
}

function byTag(tree, tag) {
  return visit(tree, (n) => n.type === tag)[0];
}

function render(props) {
  hooks.reset();
  captured.filePane = null;
  captured.onboardingBar = null;
  return expand(InterviewSurface(props));
}

async function runEffects() {
  for (const effect of hooks.effects) effect();
  await flush();
}

async function flush() {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function progressItems(doneKeys) {
  return ["engine", "resume", "roles", "companies", "evidence", "guardrails", "quickFacts"].map(
    (key) => ({ key, done: doneKeys.includes(key) })
  );
}

function stateFixture({
  doneKeys = [],
  complete = false,
  data = {},
  sourceResumePresent = false,
} = {}) {
  return {
    setupProgress: {
      items: progressItems(doneKeys),
      completedCount: doneKeys.length,
      complete,
    },
    sourceResumePresent,
    data,
  };
}

const NOT_COMPLETE_STATE = stateFixture({});
const RUNTIME = { id: "claude", name: "Claude Code" };

beforeEach(() => {
  hooks.clear();
  vi.clearAllMocks();
  sse.calls = [];
  api.findChatBySkill.mockRejectedValue(new Error("no session"));
  api.getOnboardState.mockResolvedValue(NOT_COMPLETE_STATE);
});

// ---------------------------------------------------------------------------
// Never touches /api/intake
// ---------------------------------------------------------------------------

describe("InterviewSurface — never touches /api/intake", () => {
  it("the api.js surface this component imports has no createIntake/uploadIntakeFile wrapper", () => {
    expect(api.createIntake).toBeUndefined();
    expect(api.uploadIntakeFile).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Centered -> docked on first user-initiated event
// ---------------------------------------------------------------------------

describe("InterviewSurface — centered until first user-initiated event", () => {
  it("stays centered on mount (no chat session) and docks after the user sends a message", async () => {
    api.startChat.mockResolvedValue({ chatId: "chat-1", state: "running" });
    render({ runtime: RUNTIME });
    await runEffects();

    let tree = render({ runtime: RUNTIME });
    expect(textOf(byTag(tree, "h1"))).toBe("Set up your rat.");
    expect(captured.onboardingBar.mode).toBe("centered");
    expect(captured.filePane).toBeNull();

    await captured.onboardingBar.onSend("I'm hunting applied AI roles");
    await flush();

    tree = render({ runtime: RUNTIME });
    expect(api.startChat).toHaveBeenCalledWith("ingest-profile", {
      input: "I'm hunting applied AI roles",
    });
    expect(captured.onboardingBar.mode).toBe("docked");
    expect(captured.filePane).toBeTruthy();
    const userTurn = byClass(tree, "onboarding-transcript__turn--user")[0];
    expect(textOf(userTurn)).toBe("I'm hunting applied AI roles");
  });

  it("docks after a résumé drop even with no typed message (never posts to /api/intake)", async () => {
    api.startChat.mockResolvedValue({ chatId: "chat-2", state: "running" });
    api.extractResumeAi.mockResolvedValue({
      profileSeed: { candidate: { full_name: "Jamie Rivera" } },
      evidenceSeed: {
        claims: [{ claim: "Shipped an agent pipeline", evidence: "Led the build." }],
      },
    });
    api.saveCandidateFile.mockResolvedValue({ ok: true });
    api.saveEvidenceSeed.mockResolvedValue({ ok: true });
    api.sendChatMessage.mockResolvedValue({ ok: true });

    render({ runtime: RUNTIME });
    await runEffects();
    render({ runtime: RUNTIME });
    expect(captured.onboardingBar.mode).toBe("centered");

    const file = { name: "resume.pdf" };
    await captured.onboardingBar.onDropResume(file);
    await flush();

    expect(api.startChat).toHaveBeenCalledWith("ingest-profile", {
      input: "I just dropped my résumé (resume.pdf).",
    });
    expect(api.extractResumeAi).toHaveBeenCalledWith(file);
    expect(api.saveCandidateFile).toHaveBeenCalledWith("profile", {
      candidate: { full_name: "Jamie Rivera" },
    });
    expect(api.saveEvidenceSeed).toHaveBeenCalledWith([
      { claim: "Shipped an agent pipeline", evidence: "Led the build." },
    ]);
    expect(api.sendChatMessage).toHaveBeenCalledWith(
      "chat-2",
      '[SYSTEM] The résumé "resume.pdf" was uploaded and parsed (1 claims extracted). Continue the interview using it.'
    );

    render({ runtime: RUNTIME });
    expect(captured.onboardingBar.mode).toBe("docked");
  });

  it("routes a .docx drop through extractResumeDocx and a .txt drop through parseResumeText — never resume-ai for either", async () => {
    api.startChat.mockResolvedValue({ chatId: "chat-3", state: "running" });
    api.extractResumeDocx.mockResolvedValue({
      profileSeed: { candidate: {} },
      evidenceSeed: { claims: [] },
    });
    render({ runtime: RUNTIME });
    await runEffects();
    render({ runtime: RUNTIME });
    await captured.onboardingBar.onDropResume({ name: "resume.docx" });
    await flush();
    expect(api.extractResumeDocx).toHaveBeenCalled();
    expect(api.extractResumeAi).not.toHaveBeenCalled();
    expect(api.parseResumeText).not.toHaveBeenCalled();

    vi.clearAllMocks();
    api.findChatBySkill.mockRejectedValue(new Error("no session"));
    api.getOnboardState.mockResolvedValue(NOT_COMPLETE_STATE);
    api.startChat.mockResolvedValue({ chatId: "chat-4", state: "running" });
    api.parseResumeText.mockResolvedValue({
      profileSeed: { candidate: {} },
      evidenceSeed: { claims: [] },
    });
    hooks.clear();
    render({ runtime: RUNTIME });
    await runEffects();
    render({ runtime: RUNTIME });
    await captured.onboardingBar.onDropResume({ name: "resume.txt", text: async () => "raw text" });
    await flush();
    expect(api.parseResumeText).toHaveBeenCalledWith("raw text", { save: true });
    expect(api.extractResumeAi).not.toHaveBeenCalled();
    expect(api.extractResumeDocx).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// 409-reconnect
// ---------------------------------------------------------------------------

describe("InterviewSurface — 409-reconnect", () => {
  it("a 409 from startChat reuses the chatId in the error body without replaying the message", async () => {
    const conflict = Object.assign(new Error("conflict"), {
      status: 409,
      body: { chatId: "existing-chat-1" },
    });
    api.startChat.mockRejectedValue(conflict);
    render({ runtime: RUNTIME });
    await runEffects();
    render({ runtime: RUNTIME });

    await captured.onboardingBar.onSend("hello again");
    await flush();

    expect(api.sendChatMessage).not.toHaveBeenCalled();
    render({ runtime: RUNTIME });
    expect(captured.onboardingBar.mode).toBe("docked");
    expect(captured.filePane).toBeTruthy();
  });

  it("resumability: reopening the page reconnects to an existing session and docks immediately", async () => {
    api.findChatBySkill.mockResolvedValue({ chatId: "resumed-1", state: "running" });
    render({ runtime: RUNTIME });
    await runEffects();
    render({ runtime: RUNTIME });
    expect(captured.onboardingBar.mode).toBe("docked");
    expect(captured.filePane).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// SSE events
// ---------------------------------------------------------------------------

describe("InterviewSurface — SSE events", () => {
  it("an assistant event appends an assistant transcript turn", async () => {
    api.findChatBySkill.mockResolvedValue({ chatId: "resumed-1", state: "running" });
    render({ runtime: RUNTIME });
    await runEffects();
    render({ runtime: RUNTIME });

    const onEvent = sse.calls.at(-1).opts.onEvent;
    onEvent(
      "assistant",
      JSON.stringify({
        message: { content: [{ type: "text", text: "Tell me about your last role." }] },
      })
    );

    const tree = render({ runtime: RUNTIME });
    const assistantText = byClass(tree, "onboarding-transcript__text")[0];
    expect(textOf(assistantText)).toBe("Tell me about your last role.");
  });

  it("an error event renders an inline error", async () => {
    api.findChatBySkill.mockResolvedValue({ chatId: "resumed-1", state: "running" });
    render({ runtime: RUNTIME });
    await runEffects();
    render({ runtime: RUNTIME });

    const onEvent = sse.calls.at(-1).opts.onEvent;
    onEvent("error", JSON.stringify({ message: "The interview hit a snag." }));

    const tree = render({ runtime: RUNTIME });
    const alert = byTag(tree, "inline-alert");
    expect(alert.props.message).toBe("The interview hit a snag.");
  });

  it("receipt lines diff setupProgress across idle events, reporting only newly-flipped items each time", async () => {
    api.findChatBySkill.mockResolvedValue({ chatId: "resumed-1", state: "running" });
    const afterFirst = stateFixture({
      doneKeys: ["engine", "resume"],
      data: { evidence: { claims: [{ id: "a" }, { id: "b" }, { id: "c" }] } },
      sourceResumePresent: true,
    });
    const afterSecond = stateFixture({
      doneKeys: ["engine", "resume", "roles"],
      data: { evidence: { claims: [{ id: "a" }, { id: "b" }, { id: "c" }] } },
      sourceResumePresent: true,
    });
    // Call order: #1 mount reloadState, #2 first idle's checkProgressDelta,
    // #3 second idle's checkProgressDelta.
    api.getOnboardState
      .mockResolvedValueOnce(NOT_COMPLETE_STATE)
      .mockResolvedValueOnce(afterFirst)
      .mockResolvedValueOnce(afterSecond);

    render({ runtime: RUNTIME });
    await runEffects();
    // This single render's closures are reused for both idle events below so
    // the prevDoneRef mutation from the first event is visible to the
    // second — see this file's header note on the harness's useRef.
    render({ runtime: RUNTIME });
    const onEvent = sse.calls.at(-1).opts.onEvent;

    onEvent("chat_state", JSON.stringify({ state: "idle" }));
    await flush();
    onEvent("chat_state", JSON.stringify({ state: "idle" }));
    await flush();

    const tree = render({ runtime: RUNTIME });
    const receipts = byClass(tree, "onboarding-transcript__receipt").map(textOf);
    expect(receipts).toEqual([
      "ENGINE ✓ · TARGETING.YML UPDATED · RESUME ✓ · EVIDENCE DRAFTED · 3 CLAIMS",
      "ROLES ✓ · TARGETING.YML UPDATED",
    ]);
  });
});

// ---------------------------------------------------------------------------
// Dual drive — a file-pane edit surfaces a system pill
// ---------------------------------------------------------------------------

describe("InterviewSurface — dual drive", () => {
  it("a file-pane onFieldSaved call posts a transcript pill and a [SYSTEM] chat message", async () => {
    api.findChatBySkill.mockResolvedValue({ chatId: "resumed-1", state: "running" });
    api.sendChatMessage.mockResolvedValue({ ok: true });
    render({ runtime: RUNTIME });
    await runEffects();
    render({ runtime: RUNTIME });

    await captured.filePane.onFieldSaved({ key: "guardrails", summary: "2 dealbreakers" });

    expect(api.sendChatMessage).toHaveBeenCalledWith(
      "resumed-1",
      "[SYSTEM] The user manually edited Guardrails (2 dealbreakers). Acknowledge this and build on it."
    );

    const tree = render({ runtime: RUNTIME });
    const pill = byClass(tree, "onboarding-transcript__pill")[0];
    expect(textOf(pill)).toBe("YOU EDITED · GUARDRAILS · 2 DEALBREAKERS");
  });
});

// ---------------------------------------------------------------------------
// Completion (3e)
// ---------------------------------------------------------------------------

describe("InterviewSurface — completion screen (3e)", () => {
  it("renders 'Setup complete · 7 of 7', expands the disclosure, and kicks off the first sweep once", async () => {
    vi.useFakeTimers();
    try {
      const completeState = stateFixture({
        doneKeys: [
          "engine",
          "resume",
          "roles",
          "companies",
          "evidence",
          "guardrails",
          "quickFacts",
        ],
        complete: true,
      });
      api.getOnboardState.mockResolvedValue(completeState);
      api.startFirstSearchRun.mockResolvedValue({ status: "running" });

      render({ runtime: RUNTIME });
      await runEffects();
      let tree = render({ runtime: RUNTIME });
      await runEffects(); // CompletionScreen's own mount effects (kickoff + poll gate)
      await flush();
      tree = render({ runtime: RUNTIME });

      expect(textOf(byClass(tree, "onboarding-app__status")[0])).toBe("SETUP · 7 OF 7 · DONE");
      expect(textOf(byTag(tree, "h1"))).toBe("Your rat is set.");
      expect(api.startFirstSearchRun).toHaveBeenCalledTimes(1);

      expect(byClass(tree, "onboarding-done__disclosure")).toHaveLength(0);
      const seeWhatItKnows = visit(
        tree,
        (n) => n.type === "button" && textOf(n) === "SEE WHAT IT KNOWS"
      )[0];
      seeWhatItKnows.props.onClick();
      tree = render({ runtime: RUNTIME });
      expect(byClass(tree, "onboarding-done__disclosure")).toHaveLength(1);
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });
});
