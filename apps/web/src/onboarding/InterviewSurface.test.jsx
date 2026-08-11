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

// Same real-Link-as-plain-<a>-stand-in convention as LibraryPage.test.jsx —
// the raw href="/settings" escape hatch bug this file guards against would
// have been invisible under a Link mock that ignored `to`, so this keeps
// `to` flowing through to a real rendered attribute.
vi.mock("react-router-dom", () => ({
  Link: ({ children, to, ...props }) => (
    <a href={to} {...props}>
      {children}
    </a>
  ),
}));

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
// Mocked to a bare host-tag string (same technique FilePane.test.jsx uses for
// ChipInput/TextArea/TextField) so `expand()` leaves it as a leaf carrying
// its exact props — {block, automationStatus, onConfirm} — rather than
// recursing into ConfirmPill's own dialog/rendering logic, which has its own
// dedicated test file.
vi.mock("./ConfirmPill.jsx", () => ({
  ConfirmPill: "mock-confirm-pill",
  ConfirmDialog: "mock-confirm-dialog",
}));

const sse = vi.hoisted(() => ({ calls: [] }));
vi.mock("../lib/sse.js", () => ({
  useEventSource: (url, opts) => {
    sse.calls.push({ url, opts });
  },
}));

const api = vi.hoisted(() => ({
  createCompanyProposals: vi.fn(),
  decideCompanyProposal: vi.fn(),
  extractResumeAi: vi.fn(),
  extractResumeDocx: vi.fn(),
  findChatBySkill: vi.fn(),
  getAutomationSettings: vi.fn(),
  getCompanyProposals: vi.fn(),
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

// Lane A / R1, R4 — AutomationControls.jsx is only imported here for its
// pure buildAutomationModePatch helper (see InterviewSurface.jsx's own
// import). Mocked to just that function so this file never pulls in the
// Toggle-based JSX components AutomationControls.jsx also exports.
vi.mock("../settings/AutomationControls.jsx", () => ({
  buildAutomationModePatch: (_status, mode) =>
    mode === "advanced" ? { setup_mode: "advanced" } : { setup_mode: "basic" },
}));

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

const ALL_SETUP_KEYS = [
  "engine",
  "resume",
  "roles",
  "companies",
  "evidence",
  "guardrails",
  "quickFacts",
  "authorization",
  "consent",
];

function progressItems(doneKeys) {
  return ALL_SETUP_KEYS.map((key) => ({ key, done: doneKeys.includes(key) }));
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
      total: ALL_SETUP_KEYS.length,
      complete,
    },
    sourceResumePresent,
    data,
  };
}

const NOT_COMPLETE_STATE = stateFixture({});
const RUNTIME = { id: "claude", name: "Claude Code" };

// Builds a ``` careerrat:confirm fence exactly like skill-runtime.mjs's
// CONFIRM_BLOCK_GUIDANCE documents to the model.
function confirmFence(block) {
  return `\`\`\`careerrat:confirm\n${JSON.stringify(block)}\n\`\`\``;
}

function assistantEvent(text) {
  return JSON.stringify({ message: { content: [{ type: "text", text }] } });
}

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
    expect(textOf(byTag(tree, "h1"))).toBe("This is Paul.");
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

  it("the upload chip opens the file picker without starting a chat", async () => {
    api.startChat.mockResolvedValue({ chatId: "chat-chip", state: "running" });
    let tree = render({ runtime: RUNTIME });
    await runEffects();
    tree = render({ runtime: RUNTIME });

    const chips = byClass(tree, "onboarding-suggestions__chip");
    expect(chips).toHaveLength(2);
    // Both chips must be real buttons, not the inert spans this shipped as.
    for (const chip of chips) expect(chip.type).toBe("button");

    const click = vi.fn();
    captured.onboardingBar.fileInputRef.current = { click };
    chips[0].props.onClick();
    await flush();

    expect(click).toHaveBeenCalled();
    expect(api.startChat).not.toHaveBeenCalled();
    expect(captured.onboardingBar.mode).toBe("centered");
  });

  it("the no-résumé chip sends its own label immediately and docks", async () => {
    api.startChat.mockResolvedValue({ chatId: "chat-chip-2", state: "running" });
    let tree = render({ runtime: RUNTIME });
    await runEffects();
    tree = render({ runtime: RUNTIME });

    const chips = byClass(tree, "onboarding-suggestions__chip");
    const label = textOf(chips[1]);
    chips[1].props.onClick();
    await flush();

    tree = render({ runtime: RUNTIME });
    expect(api.startChat).toHaveBeenCalledWith("ingest-profile", { input: label });
    expect(captured.onboardingBar.mode).toBe("docked");
    const userTurn = byClass(tree, "onboarding-transcript__turn--user")[0];
    expect(textOf(userTurn)).toBe(label);
  });

  it("a résumé dropped anywhere on the hero uploads, not just one dropped on the bar", async () => {
    api.startChat.mockResolvedValue({ chatId: "chat-hero-drop", state: "running" });
    api.parseResumeText.mockResolvedValue({
      profileSeed: { candidate: {} },
      evidenceSeed: { claims: [] },
    });
    let tree = render({ runtime: RUNTIME });
    await runEffects();
    tree = render({ runtime: RUNTIME });

    const hero = byClass(tree, "onboarding-hero")[0];
    expect(hero.props.onDrop).toBeTruthy();

    hero.props.onDragOver({ preventDefault: vi.fn() });
    tree = render({ runtime: RUNTIME });
    expect(byClass(tree, "onboarding-hero--drag-over")).toHaveLength(1);

    const file = { name: "resume.txt", text: async () => "raw text" };
    await byClass(tree, "onboarding-hero")[0].props.onDrop({
      preventDefault: vi.fn(),
      dataTransfer: { files: [file] },
    });
    await flush();

    expect(api.parseResumeText).toHaveBeenCalledWith("raw text", { save: true });
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

  it("a résumé drop seeds an empty targeting.yml with role_buckets, keep_signals, and tracked_companies", async () => {
    api.startChat.mockResolvedValue({ chatId: "chat-target-1", state: "running" });
    api.extractResumeAi.mockResolvedValue({
      profileSeed: { candidate: {} },
      evidenceSeed: { claims: [] },
      targetingSeed: {
        role_buckets: [{ name: "Primary", priority: "primary", titles: ["Engineer"] }],
        keep_signals: ["Remote"],
        tracked_companies: ["Anthropic"],
      },
    });
    api.saveCandidateFile.mockResolvedValue({ ok: true });

    render({ runtime: RUNTIME });
    await runEffects();
    render({ runtime: RUNTIME });
    await captured.onboardingBar.onDropResume({ name: "resume.pdf" });
    await flush();

    expect(api.saveCandidateFile).toHaveBeenCalledWith("targeting", {
      tracked_companies: ["Anthropic"],
      role_buckets: [{ name: "Primary", priority: "primary", titles: ["Engineer"] }],
      keep_signals: ["Remote"],
    });
  });

  it("a résumé drop never overwrites existing role_buckets/keep_signals, but still unions tracked_companies (never a replace)", async () => {
    api.startChat.mockResolvedValue({ chatId: "chat-target-2", state: "running" });
    api.extractResumeAi.mockResolvedValue({
      profileSeed: { candidate: {} },
      evidenceSeed: { claims: [] },
      targetingSeed: {
        role_buckets: [{ name: "Primary", priority: "primary", titles: ["Designer"] }],
        keep_signals: ["Hybrid"],
        tracked_companies: ["Anthropic"],
      },
    });
    api.saveCandidateFile.mockResolvedValue({ ok: true });
    api.getOnboardState.mockResolvedValue(
      stateFixture({
        data: {
          targeting: {
            role_buckets: [{ name: "Primary", priority: "primary", titles: ["Engineer"] }],
            keep_signals: ["Remote"],
            tracked_companies: ["Stripe"],
          },
        },
      })
    );

    render({ runtime: RUNTIME });
    await runEffects();
    render({ runtime: RUNTIME });
    await captured.onboardingBar.onDropResume({ name: "resume.pdf" });
    await flush();

    expect(api.saveCandidateFile).toHaveBeenCalledWith("targeting", {
      tracked_companies: ["Stripe", "Anthropic"],
    });
  });

  it("a résumé drop with no targetingSeed data never calls saveCandidateFile for targeting", async () => {
    api.startChat.mockResolvedValue({ chatId: "chat-target-3", state: "running" });
    api.extractResumeAi.mockResolvedValue({
      profileSeed: { candidate: {} },
      evidenceSeed: { claims: [] },
    });
    api.saveCandidateFile.mockResolvedValue({ ok: true });

    render({ runtime: RUNTIME });
    await runEffects();
    render({ runtime: RUNTIME });
    await captured.onboardingBar.onDropResume({ name: "resume.pdf" });
    await flush();

    expect(api.saveCandidateFile).not.toHaveBeenCalledWith("targeting", expect.anything());
  });
});

// ---------------------------------------------------------------------------
// Escape hatch — a router Link, never a raw same-app <a href>
// ---------------------------------------------------------------------------

describe("InterviewSurface — escape hatch", () => {
  it("renders the checklist escape hatch as a router Link to /settings, not a raw anchor", async () => {
    render({ runtime: RUNTIME });
    await runEffects();
    const tree = render({ runtime: RUNTIME });

    const hatch = byClass(tree, "onboarding-hero__escape-hatch")[0];
    expect(hatch).toBeTruthy();
    // The mocked react-router-dom Link renders as a plain <a href={to}> —
    // this asserts `to` (the Link prop) reached the DOM, not a hardcoded
    // href baked into a raw anchor that would resolve outside the
    // BrowserRouter basename.
    expect(hatch.props.href).toBe("/settings");
    expect(textOf(hatch)).toBe("PREFER FORMS? OPEN THE CHECKLIST →");
  });
});

// ---------------------------------------------------------------------------
// Engine re-entry chip — confirm dialog gates the actual navigation
// ---------------------------------------------------------------------------

describe("InterviewSurface — engine re-entry chip (dialog-gated)", () => {
  it("clicking the ENGINE chip opens the confirm dialog without calling onRequestEngineScreen", async () => {
    api.findChatBySkill.mockResolvedValue({ chatId: "resumed-1", state: "running" });
    const onRequestEngineScreen = vi.fn();
    render({ runtime: RUNTIME, onRequestEngineScreen });
    await runEffects();
    let tree = render({ runtime: RUNTIME, onRequestEngineScreen });

    expect(visit(tree, (n) => n.type === "mock-confirm-dialog")).toHaveLength(0);
    const chip = visit(
      tree,
      (n) => n.type === "button" && textOf(n) === `ENGINE · ${RUNTIME.name.toUpperCase()}`
    )[0];
    expect(chip).toBeTruthy();
    chip.props.onClick();
    tree = render({ runtime: RUNTIME, onRequestEngineScreen });

    expect(visit(tree, (n) => n.type === "mock-confirm-dialog")).toHaveLength(1);
    expect(onRequestEngineScreen).not.toHaveBeenCalled();
  });

  it("Cancel closes the dialog and leaves the interview untouched (no callback fired)", async () => {
    api.findChatBySkill.mockResolvedValue({ chatId: "resumed-1", state: "running" });
    const onRequestEngineScreen = vi.fn();
    render({ runtime: RUNTIME, onRequestEngineScreen });
    await runEffects();
    let tree = render({ runtime: RUNTIME, onRequestEngineScreen });
    const chip = visit(
      tree,
      (n) => n.type === "button" && textOf(n) === `ENGINE · ${RUNTIME.name.toUpperCase()}`
    )[0];
    chip.props.onClick();
    tree = render({ runtime: RUNTIME, onRequestEngineScreen });

    const dialog = visit(tree, (n) => n.type === "mock-confirm-dialog")[0];
    dialog.props.onCancel();
    tree = render({ runtime: RUNTIME, onRequestEngineScreen });

    expect(visit(tree, (n) => n.type === "mock-confirm-dialog")).toHaveLength(0);
    expect(onRequestEngineScreen).not.toHaveBeenCalled();
    expect(captured.filePane).toBeTruthy(); // still docked, still in the interview
  });

  it("Confirm calls onRequestEngineScreen and closes the dialog", async () => {
    api.findChatBySkill.mockResolvedValue({ chatId: "resumed-1", state: "running" });
    const onRequestEngineScreen = vi.fn();
    render({ runtime: RUNTIME, onRequestEngineScreen });
    await runEffects();
    let tree = render({ runtime: RUNTIME, onRequestEngineScreen });
    const chip = visit(
      tree,
      (n) => n.type === "button" && textOf(n) === `ENGINE · ${RUNTIME.name.toUpperCase()}`
    )[0];
    chip.props.onClick();
    tree = render({ runtime: RUNTIME, onRequestEngineScreen });

    const dialog = visit(tree, (n) => n.type === "mock-confirm-dialog")[0];
    await dialog.props.onConfirm();
    tree = render({ runtime: RUNTIME, onRequestEngineScreen });

    expect(onRequestEngineScreen).toHaveBeenCalledTimes(1);
    expect(visit(tree, (n) => n.type === "mock-confirm-dialog")).toHaveLength(0);
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
      "ENGINE ✓ · RESUME ✓ · EVIDENCE DRAFTED · 3 CLAIMS",
      "ROLES ✓ · TARGETING.YML UPDATED",
    ]);
  });

  it("names the real file each item writes, never a hardcoded targeting.yml, and engine writes none", async () => {
    api.findChatBySkill.mockResolvedValue({ chatId: "resumed-2", state: "running" });
    const afterIdle = stateFixture({
      doneKeys: ["engine", "evidence", "quickFacts", "authorization", "consent"],
      data: { evidence: { claims: [{ id: "a" }] } },
    });
    api.getOnboardState.mockResolvedValueOnce(NOT_COMPLETE_STATE).mockResolvedValueOnce(afterIdle);

    render({ runtime: RUNTIME });
    await runEffects();
    render({ runtime: RUNTIME });
    const onEvent = sse.calls.at(-1).opts.onEvent;

    onEvent("chat_state", JSON.stringify({ state: "idle" }));
    await flush();

    const tree = render({ runtime: RUNTIME });
    const receipts = byClass(tree, "onboarding-transcript__receipt").map(textOf);
    expect(receipts).toEqual([
      "ENGINE ✓ · EVIDENCE ✓ · EVIDENCE.YML UPDATED · QUICK FACTS ✓ · PROFILE.YML UPDATED · " +
        "WORK AUTHORIZATION ✓ · PROFILE.YML UPDATED · AUTOMATION CONSENT ✓ · AUTOMATION.YML UPDATED",
    ]);
  });

  it("a résumé receipt reflects a declined résumé instead of claiming evidence was drafted", async () => {
    api.findChatBySkill.mockResolvedValue({ chatId: "resumed-3", state: "running" });
    const afterIdle = stateFixture({
      doneKeys: ["resume"],
      sourceResumePresent: false,
      data: {
        // Leftover template/demo claims — must never leak into the receipt
        // when the user said they had no résumé.
        evidence: { claims: [{ id: "a" }] },
        "form-defaults": {
          declined_fields: { resume: { declined_at: "2026-08-10T12:00:00Z" } },
        },
      },
    });
    api.getOnboardState.mockResolvedValueOnce(NOT_COMPLETE_STATE).mockResolvedValueOnce(afterIdle);

    render({ runtime: RUNTIME });
    await runEffects();
    render({ runtime: RUNTIME });
    const onEvent = sse.calls.at(-1).opts.onEvent;

    onEvent("chat_state", JSON.stringify({ state: "idle" }));
    await flush();

    const tree = render({ runtime: RUNTIME });
    const receipts = byClass(tree, "onboarding-transcript__receipt").map(textOf);
    expect(receipts).toEqual(["RESUME ✓ · BUILT FROM YOUR ANSWERS"]);
  });

  it("a setup item already done at mount produces no receipt for it on the session's first idle event", async () => {
    api.findChatBySkill.mockResolvedValue({ chatId: "resumed-4", state: "running" });
    const alreadyDoneAtMount = stateFixture({ doneKeys: ["engine"] });
    const afterFirstIdle = stateFixture({ doneKeys: ["engine", "roles"] });
    api.getOnboardState
      .mockResolvedValueOnce(alreadyDoneAtMount)
      .mockResolvedValueOnce(afterFirstIdle);

    render({ runtime: RUNTIME });
    await runEffects();
    // Same single-render-reuse pattern as above: this render's prevDoneRef
    // gets synchronously seeded from `alreadyDoneAtMount` (engine already
    // done) the moment it executes, since `state` has already loaded by now.
    render({ runtime: RUNTIME });
    const onEvent = sse.calls.at(-1).opts.onEvent;

    onEvent("chat_state", JSON.stringify({ state: "idle" }));
    await flush();

    const tree = render({ runtime: RUNTIME });
    const receipts = byClass(tree, "onboarding-transcript__receipt").map(textOf);
    // Only "roles" is a genuine within-session transition — "engine" was
    // already done before this session started and must not be re-announced.
    expect(receipts).toEqual(["ROLES ✓ · TARGETING.YML UPDATED"]);
  });
});

// ---------------------------------------------------------------------------
// Inline markdown (Bug 1) — the transcript renders a safe subset of markdown
// instead of literal asterisks/backticks, and never trusts model text enough
// to inject raw HTML.
// ---------------------------------------------------------------------------

describe("InterviewSurface — inline markdown", () => {
  it("renders bold/italic/inline code as real elements, not literal markup characters", async () => {
    api.findChatBySkill.mockResolvedValue({ chatId: "resumed-md-1", state: "running" });
    render({ runtime: RUNTIME });
    await runEffects();
    render({ runtime: RUNTIME });

    const onEvent = sse.calls.at(-1).opts.onEvent;
    onEvent(
      "assistant",
      assistantEvent("Do you want **Deep** setup, or *Shallow* setup with `git status`?")
    );

    const tree = render({ runtime: RUNTIME });
    const textSpan = byClass(tree, "onboarding-transcript__text")[0];
    expect(textOf(textSpan)).toBe("Do you want Deep setup, or Shallow setup with git status?");
    expect(visit(textSpan, (n) => n.type === "strong").map(textOf)).toEqual(["Deep"]);
    expect(visit(textSpan, (n) => n.type === "em").map(textOf)).toEqual(["Shallow"]);
    expect(visit(textSpan, (n) => n.type === "code").map(textOf)).toEqual(["git status"]);
  });

  it("never injects raw HTML from model text — it renders as literal visible text, not markup", async () => {
    api.findChatBySkill.mockResolvedValue({ chatId: "resumed-md-2", state: "running" });
    render({ runtime: RUNTIME });
    await runEffects();
    render({ runtime: RUNTIME });

    const onEvent = sse.calls.at(-1).opts.onEvent;
    onEvent("assistant", assistantEvent('<img src=x onerror="alert(1)">'));

    const tree = render({ runtime: RUNTIME });
    const textSpan = byClass(tree, "onboarding-transcript__text")[0];
    expect(textOf(textSpan)).toBe('<img src=x onerror="alert(1)">');
    expect(visit(textSpan, (n) => n.type === "img")).toHaveLength(0);
  });

  it("only linkifies http(s) URLs — a javascript: scheme link stays plain text", async () => {
    api.findChatBySkill.mockResolvedValue({ chatId: "resumed-md-3", state: "running" });
    render({ runtime: RUNTIME });
    await runEffects();
    render({ runtime: RUNTIME });

    const onEvent = sse.calls.at(-1).opts.onEvent;
    onEvent(
      "assistant",
      assistantEvent(
        "See [the board](https://example.com/jobs) or [click me](javascript:alert(1))"
      )
    );

    const tree = render({ runtime: RUNTIME });
    const textSpan = byClass(tree, "onboarding-transcript__text")[0];
    const links = visit(textSpan, (n) => n.type === "a");
    expect(links).toHaveLength(1);
    expect(links[0].props.href).toBe("https://example.com/jobs");
    expect(links[0].props.target).toBe("_blank");
    expect(textOf(textSpan)).toContain("[click me](javascript:alert(1))");
  });
});

// ---------------------------------------------------------------------------
// Assistant avatar (Bug 5) — no stale "R" brand-initial leftover.
// ---------------------------------------------------------------------------

describe("InterviewSurface — assistant avatar", () => {
  it("does not show the old product's 'R' initial", async () => {
    api.findChatBySkill.mockResolvedValue({ chatId: "resumed-avatar", state: "running" });
    render({ runtime: RUNTIME });
    await runEffects();
    render({ runtime: RUNTIME });

    const onEvent = sse.calls.at(-1).opts.onEvent;
    onEvent("assistant", assistantEvent("Hi there."));

    const tree = render({ runtime: RUNTIME });
    const avatar = byClass(tree, "onboarding-transcript__avatar")[0];
    expect(textOf(avatar)).not.toBe("R");
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
// Lane A / R1-R5 — confirm blocks
// ---------------------------------------------------------------------------

describe("InterviewSurface — confirm blocks (Lane A)", () => {
  it("parses a confirm fence out of an assistant event into a ConfirmPill, stripping it from the display text", async () => {
    api.findChatBySkill.mockResolvedValue({ chatId: "resumed-1", state: "running" });
    render({ runtime: RUNTIME });
    await runEffects();
    render({ runtime: RUNTIME });

    const onEvent = sse.calls.at(-1).opts.onEvent;
    const fence = confirmFence({
      kind: "authorization",
      summary: "Sounds authorized",
      patch: { work_authorized: true, requires_sponsorship: false },
    });
    onEvent("assistant", assistantEvent(`Got it.\n\n${fence}`));

    const tree = render({ runtime: RUNTIME });
    const assistantText = byClass(tree, "onboarding-transcript__text")[0];
    expect(textOf(assistantText)).toBe("Got it.");
    const pills = visit(tree, (n) => n.type === "mock-confirm-pill");
    expect(pills).toHaveLength(1);
    expect(pills[0].props.block.kind).toBe("authorization");
    expect(pills[0].props.block.status).toBe("pending");
  });

  it("a turn that is ONLY a confirm block (no prose) still renders a pill with no text span", async () => {
    api.findChatBySkill.mockResolvedValue({ chatId: "resumed-1", state: "running" });
    render({ runtime: RUNTIME });
    await runEffects();
    render({ runtime: RUNTIME });

    const onEvent = sse.calls.at(-1).opts.onEvent;
    onEvent("assistant", assistantEvent(confirmFence({ kind: "companies_suggest" })));

    const tree = render({ runtime: RUNTIME });
    expect(visit(tree, (n) => n.type === "mock-confirm-pill")).toHaveLength(1);
  });

  it("an unknown kind or malformed JSON is silently dropped (no pill, fence still stripped)", async () => {
    api.findChatBySkill.mockResolvedValue({ chatId: "resumed-1", state: "running" });
    render({ runtime: RUNTIME });
    await runEffects();
    render({ runtime: RUNTIME });

    const onEvent = sse.calls.at(-1).opts.onEvent;
    onEvent(
      "assistant",
      assistantEvent(`Noted.\n\n\`\`\`careerrat:confirm\n{"kind":"not_a_real_kind"}\n\`\`\``)
    );

    const tree = render({ runtime: RUNTIME });
    expect(visit(tree, (n) => n.type === "mock-confirm-pill")).toHaveLength(0);
    expect(textOf(byClass(tree, "onboarding-transcript__text")[0])).toBe("Noted.");
  });

  it("authorization pill confirm (true) saves only profile.authorization, then resolves", async () => {
    api.findChatBySkill.mockResolvedValue({ chatId: "resumed-1", state: "running" });
    api.saveCandidateFile.mockResolvedValue({ ok: true });
    render({ runtime: RUNTIME });
    await runEffects();
    render({ runtime: RUNTIME });

    const onEvent = sse.calls.at(-1).opts.onEvent;
    onEvent(
      "assistant",
      assistantEvent(
        confirmFence({
          kind: "authorization",
          patch: { work_authorized: true, requires_sponsorship: false },
        })
      )
    );

    let tree = render({ runtime: RUNTIME });
    let pill = visit(tree, (n) => n.type === "mock-confirm-pill")[0];
    await pill.props.onConfirm();
    await flush();

    expect(api.saveCandidateFile).toHaveBeenCalledTimes(1);
    expect(api.saveCandidateFile).toHaveBeenCalledWith("profile", {
      authorization: { work_authorized: true, requires_sponsorship: false },
    });

    tree = render({ runtime: RUNTIME });
    pill = visit(tree, (n) => n.type === "mock-confirm-pill")[0];
    expect(pill.props.block.status).toBe("resolved");
    expect(pill.props.block.resultSummary).toBe("Work authorization saved");
  });

  it("authorization pill confirm (false/false) also records declined_fields.authorization (R3)", async () => {
    api.findChatBySkill.mockResolvedValue({ chatId: "resumed-1", state: "running" });
    api.saveCandidateFile.mockResolvedValue({ ok: true });
    render({ runtime: RUNTIME });
    await runEffects();
    render({ runtime: RUNTIME });

    const onEvent = sse.calls.at(-1).opts.onEvent;
    onEvent(
      "assistant",
      assistantEvent(
        confirmFence({
          kind: "authorization",
          patch: { work_authorized: false, requires_sponsorship: false },
        })
      )
    );

    const tree = render({ runtime: RUNTIME });
    const pill = visit(tree, (n) => n.type === "mock-confirm-pill")[0];
    await pill.props.onConfirm();
    await flush();

    expect(api.saveCandidateFile).toHaveBeenCalledTimes(2);
    expect(api.saveCandidateFile).toHaveBeenNthCalledWith(1, "profile", {
      authorization: { work_authorized: false, requires_sponsorship: false },
    });
    expect(api.saveCandidateFile.mock.calls[1][0]).toBe("form-defaults");
    expect(
      api.saveCandidateFile.mock.calls[1][1].declined_fields.authorization.declined_at
    ).toEqual(expect.any(String));
  });

  it("authorization pill decline writes declined_fields.authorization, fires a [SYSTEM] note, and resolves the block (Decline UX)", async () => {
    api.findChatBySkill.mockResolvedValue({ chatId: "resumed-1", state: "running" });
    api.saveCandidateFile.mockResolvedValue({ ok: true });
    api.sendChatMessage.mockResolvedValue({ ok: true });
    render({ runtime: RUNTIME });
    await runEffects();
    render({ runtime: RUNTIME });

    const onEvent = sse.calls.at(-1).opts.onEvent;
    onEvent(
      "assistant",
      assistantEvent(
        confirmFence({
          kind: "authorization",
          patch: { work_authorized: false, requires_sponsorship: false },
        })
      )
    );

    let tree = render({ runtime: RUNTIME });
    let pill = visit(tree, (n) => n.type === "mock-confirm-pill")[0];
    await pill.props.onDecline();
    await flush();

    // Only form-defaults gets written — no profile write from a decline.
    expect(api.saveCandidateFile).toHaveBeenCalledTimes(1);
    expect(api.saveCandidateFile).toHaveBeenCalledWith("form-defaults", {
      declined_fields: { authorization: { declined_at: expect.any(String) } },
    });

    // Same [SYSTEM] chat-note flow handleFieldSaved uses, so the agent's
    // next turn acknowledges the decline instead of re-asking.
    expect(api.sendChatMessage).toHaveBeenCalledWith(
      "resumed-1",
      expect.stringContaining("[SYSTEM]")
    );
    expect(api.sendChatMessage.mock.calls[0][1].toLowerCase()).toContain("declined");

    tree = render({ runtime: RUNTIME });
    pill = visit(tree, (n) => n.type === "mock-confirm-pill")[0];
    expect(pill.props.block.status).toBe("resolved");
    expect(pill.props.block.resultSummary).toBe("Noted, won't ask again");
  });

  it("consent_mode pill confirm writes automation.setup_mode via buildAutomationModePatch", async () => {
    api.findChatBySkill.mockResolvedValue({ chatId: "resumed-1", state: "running" });
    api.saveCandidateFile.mockResolvedValue({ ok: true });
    render({ runtime: RUNTIME });
    await runEffects();
    render({ runtime: RUNTIME });

    const onEvent = sse.calls.at(-1).opts.onEvent;
    onEvent(
      "assistant",
      assistantEvent(confirmFence({ kind: "consent_mode", payload: "advanced" }))
    );

    const tree = render({ runtime: RUNTIME });
    const pill = visit(tree, (n) => n.type === "mock-confirm-pill")[0];
    await pill.props.onConfirm();
    await flush();

    expect(api.saveCandidateFile).toHaveBeenCalledWith("automation", { setup_mode: "advanced" });
  });

  it("consent_mode pill decline writes declined_fields.consent and NEVER touches automation (Decline UX)", async () => {
    api.findChatBySkill.mockResolvedValue({ chatId: "resumed-1", state: "running" });
    api.saveCandidateFile.mockResolvedValue({ ok: true });
    api.sendChatMessage.mockResolvedValue({ ok: true });
    render({ runtime: RUNTIME });
    await runEffects();
    render({ runtime: RUNTIME });

    const onEvent = sse.calls.at(-1).opts.onEvent;
    onEvent(
      "assistant",
      assistantEvent(confirmFence({ kind: "consent_mode", payload: "advanced" }))
    );

    let tree = render({ runtime: RUNTIME });
    let pill = visit(tree, (n) => n.type === "mock-confirm-pill")[0];
    await pill.props.onDecline();
    await flush();

    expect(api.saveCandidateFile).toHaveBeenCalledTimes(1);
    expect(api.saveCandidateFile).toHaveBeenCalledWith("form-defaults", {
      declined_fields: { consent: { declined_at: expect.any(String) } },
    });
    // The declined_fields key is "consent", not "consent_mode" — and
    // automation/setup_mode is never written on a decline.
    const automationCalls = api.saveCandidateFile.mock.calls.filter(
      (call) => call[0] === "automation"
    );
    expect(automationCalls).toHaveLength(0);

    expect(api.sendChatMessage).toHaveBeenCalledWith(
      "resumed-1",
      expect.stringContaining("[SYSTEM]")
    );

    tree = render({ runtime: RUNTIME });
    pill = visit(tree, (n) => n.type === "mock-confirm-pill")[0];
    expect(pill.props.block.status).toBe("resolved");
    expect(pill.props.block.resultSummary).toBe("Noted, won't ask again");
  });

  it("consent_capability pill confirm errors (no write) when automationStatus.mode isn't advanced", async () => {
    api.findChatBySkill.mockResolvedValue({ chatId: "resumed-1", state: "running" });
    api.getAutomationSettings.mockResolvedValue({ mode: "basic", capabilities: [] });
    render({ runtime: RUNTIME });
    await runEffects();
    render({ runtime: RUNTIME });

    const onEvent = sse.calls.at(-1).opts.onEvent;
    onEvent(
      "assistant",
      assistantEvent(
        confirmFence({
          kind: "consent_capability",
          payload: { capability: "messaging", platform: "linkedin" },
        })
      )
    );

    let tree = render({ runtime: RUNTIME });
    let pill = visit(tree, (n) => n.type === "mock-confirm-pill")[0];
    await pill.props.onConfirm();
    await flush();

    expect(api.saveCandidateFile).not.toHaveBeenCalled();
    tree = render({ runtime: RUNTIME });
    pill = visit(tree, (n) => n.type === "mock-confirm-pill")[0];
    expect(pill.props.block.status).toBe("error");
    expect(pill.props.block.error).toMatch(/advanced/i);
  });

  it("consent_capability pill confirm (advanced mode) sets capability+platform+consent together in ONE write (R1)", async () => {
    api.findChatBySkill.mockResolvedValue({ chatId: "resumed-1", state: "running" });
    api.saveCandidateFile.mockResolvedValue({ ok: true });
    api.getAutomationSettings.mockResolvedValue({ mode: "advanced", capabilities: [] });
    render({ runtime: RUNTIME });
    await runEffects();
    render({ runtime: RUNTIME });

    const onEvent = sse.calls.at(-1).opts.onEvent;
    onEvent(
      "assistant",
      assistantEvent(
        confirmFence({
          kind: "consent_capability",
          payload: { capability: "messaging", platform: "linkedin" },
        })
      )
    );

    const tree = render({ runtime: RUNTIME });
    const pill = visit(tree, (n) => n.type === "mock-confirm-pill")[0];
    await pill.props.onConfirm();
    await flush();

    expect(api.saveCandidateFile).toHaveBeenCalledTimes(1);
    expect(api.saveCandidateFile).toHaveBeenCalledWith("automation", {
      capabilities: { messaging: { enabled: true, platforms: { linkedin: true } } },
      consent: { linkedin: true },
    });
  });

  it("company_add pill confirm unions the new name into tracked_companies (R2, never a replace)", async () => {
    api.findChatBySkill.mockResolvedValue({ chatId: "resumed-1", state: "running" });
    api.saveCandidateFile.mockResolvedValue({ ok: true });
    api.getOnboardState.mockResolvedValue(
      stateFixture({ data: { targeting: { tracked_companies: ["Stripe"] } } })
    );
    render({ runtime: RUNTIME });
    await runEffects();
    render({ runtime: RUNTIME });

    const onEvent = sse.calls.at(-1).opts.onEvent;
    onEvent(
      "assistant",
      assistantEvent(confirmFence({ kind: "company_add", payload: { name: "Anthropic" } }))
    );

    const tree = render({ runtime: RUNTIME });
    const pill = visit(tree, (n) => n.type === "mock-confirm-pill")[0];
    await pill.props.onConfirm();
    await flush();

    expect(api.saveCandidateFile).toHaveBeenCalledWith("targeting", {
      tracked_companies: ["Stripe", "Anthropic"],
    });
  });

  it("candidate_patch pill confirm writes payload.patch to payload.doc, then refreshes state", async () => {
    api.findChatBySkill.mockResolvedValue({ chatId: "resumed-1", state: "running" });
    api.saveCandidateFile.mockResolvedValue({ ok: true });
    render({ runtime: RUNTIME });
    await runEffects();
    render({ runtime: RUNTIME });

    const onEvent = sse.calls.at(-1).opts.onEvent;
    onEvent(
      "assistant",
      assistantEvent(
        confirmFence({
          kind: "candidate_patch",
          payload: {
            doc: "profile",
            patch: { candidate: { full_name: "Ada Lovelace", email: "ada@example.com" } },
          },
        })
      )
    );

    let tree = render({ runtime: RUNTIME });
    let pill = visit(tree, (n) => n.type === "mock-confirm-pill")[0];
    await pill.props.onConfirm();
    await flush();

    expect(api.saveCandidateFile).toHaveBeenCalledTimes(1);
    expect(api.saveCandidateFile).toHaveBeenCalledWith("profile", {
      candidate: { full_name: "Ada Lovelace", email: "ada@example.com" },
    });
    expect(api.getOnboardState).toHaveBeenCalled();

    tree = render({ runtime: RUNTIME });
    pill = visit(tree, (n) => n.type === "mock-confirm-pill")[0];
    expect(pill.props.block.status).toBe("resolved");
    expect(pill.props.block.resultSummary).toBe("Profile saved");
  });

  it("evidence_claim pill confirm calls saveEvidenceSeed with the single claim/evidence pair", async () => {
    api.findChatBySkill.mockResolvedValue({ chatId: "resumed-1", state: "running" });
    api.saveEvidenceSeed.mockResolvedValue({ ok: true });
    render({ runtime: RUNTIME });
    await runEffects();
    render({ runtime: RUNTIME });

    const onEvent = sse.calls.at(-1).opts.onEvent;
    onEvent(
      "assistant",
      assistantEvent(
        confirmFence({
          kind: "evidence_claim",
          payload: { claim: "Ran a 12-person kitchen", evidence: "Candidate-stated during setup" },
        })
      )
    );

    let tree = render({ runtime: RUNTIME });
    let pill = visit(tree, (n) => n.type === "mock-confirm-pill")[0];
    await pill.props.onConfirm();
    await flush();

    expect(api.saveEvidenceSeed).toHaveBeenCalledWith([
      { claim: "Ran a 12-person kitchen", evidence: "Candidate-stated during setup" },
    ]);

    tree = render({ runtime: RUNTIME });
    pill = visit(tree, (n) => n.type === "mock-confirm-pill")[0];
    expect(pill.props.block.status).toBe("resolved");
    expect(pill.props.block.resultSummary).toBe("Evidence saved");
  });

  it("companies_suggest pill confirm calls createCompanyProposals and reloads the pending list for FilePane", async () => {
    api.findChatBySkill.mockResolvedValue({ chatId: "resumed-1", state: "running" });
    api.createCompanyProposals.mockResolvedValue({ ok: true });
    api.getCompanyProposals.mockResolvedValue({
      data: {
        batch: {
          batchId: "b1",
          proposals: [{ proposalId: "p1", company: { name: "Acme" }, version: 1 }],
        },
      },
    });
    render({ runtime: RUNTIME });
    await runEffects();
    render({ runtime: RUNTIME });

    const onEvent = sse.calls.at(-1).opts.onEvent;
    onEvent("assistant", assistantEvent(confirmFence({ kind: "companies_suggest" })));

    const tree = render({ runtime: RUNTIME });
    const pill = visit(tree, (n) => n.type === "mock-confirm-pill")[0];
    await pill.props.onConfirm();
    await flush();

    expect(api.createCompanyProposals).toHaveBeenCalledWith({});
    render({ runtime: RUNTIME });
    expect(captured.filePane.companyProposals).toEqual([
      { proposalId: "p1", name: "Acme", version: 1 },
    ]);
  });

  it("the docked header status reads the dynamic total instead of a hardcoded 7", async () => {
    api.findChatBySkill.mockResolvedValue({ chatId: "resumed-1", state: "running" });
    render({ runtime: RUNTIME });
    await runEffects();
    const tree = render({ runtime: RUNTIME });
    expect(textOf(byClass(tree, "onboarding-app__status")[0])).toBe(
      "SETUP · 0 OF 9 · INTERVIEW IN PROGRESS"
    );
  });
});

// ---------------------------------------------------------------------------
// Completion (3e)
// ---------------------------------------------------------------------------

describe("InterviewSurface — completion screen (3e)", () => {
  it("renders 'Setup complete · 9 of 9', expands the disclosure, and kicks off the first sweep once", async () => {
    vi.useFakeTimers();
    try {
      const completeState = stateFixture({
        doneKeys: ALL_SETUP_KEYS,
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

      expect(textOf(byClass(tree, "onboarding-app__status")[0])).toBe("SETUP · 9 OF 9 · DONE");
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

  // Without this link the completion screen is a dead end: App.jsx's setup
  // gate sends every route here until setup reads complete, so finishing
  // setup would strand the user on a screen with no way into the app but
  // hand-editing the URL. Asserts `to` reached the DOM (the mocked Link
  // renders <a href={to}>) rather than a raw href that would resolve
  // outside the BrowserRouter basename.
  it("offers a way into the app once setup is complete", async () => {
    vi.useFakeTimers();
    try {
      api.getOnboardState.mockResolvedValue(
        stateFixture({ doneKeys: ALL_SETUP_KEYS, complete: true })
      );
      api.startFirstSearchRun.mockResolvedValue({ status: "running" });

      render({ runtime: RUNTIME });
      await runEffects();
      render({ runtime: RUNTIME });
      await runEffects();
      await flush();
      const tree = render({ runtime: RUNTIME });

      const cta = visit(tree, (n) => n.type === "a" && n.props?.href === "/")[0];
      expect(cta).toBeTruthy();
      expect(textOf(cta)).toBe("Go to your dashboard");
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });
});
