// apps/web/src/app-shell/AskBar.test.jsx
// vitest coverage for the W3 shell-docked ask bar (commit 95f27540).
//
// This repo's vitest config runs in the default "node" environment (no
// jsdom, no @testing-library/react — see JobDrawer.test.jsx/
// DashboardContext.test.jsx for the house convention this file follows): a
// hand-rolled hook harness replaces useState/useRef/useEffect via
// vi.mock("react", ...), the component is invoked as a plain function, and
// the returned React-element tree is walked directly. Unlike the existing
// harnesses, AskBar's state machine genuinely depends on effect *cleanup*
// (the debounce timer, the outside-click listener, the elapsed ticker), so
// this harness's useEffect tracks deps AND runs the previous cleanup before
// re-running a changed effect — closer to real React than the simpler
// "always re-run" version in JobDrawer.test.jsx.
//
// vi.useFakeTimers() drives the ~300ms preview debounce and the 1s elapsed
// ticker deterministically (also fakes Date, so Date.now()-based elapsed math
// in AskBar.jsx advances in lockstep with vi.advanceTimersByTimeAsync()).

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Hook harness
// ---------------------------------------------------------------------------

const hooks = vi.hoisted(() => ({
  cursor: 0,
  states: [],
  refs: [],
  effectDeps: [],
  effectCleanups: [],
  pending: [],
  reset() {
    this.cursor = 0;
    this.pending = [];
  },
  clear() {
    this.cursor = 0;
    this.states = [];
    this.refs = [];
    this.effectDeps = [];
    this.effectCleanups = [];
    this.pending = [];
  },
}));

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal();

  function dependenciesChanged(previous, next) {
    if (!previous || !next || previous.length !== next.length) return true;
    return next.some((value, index) => !Object.is(value, previous[index]));
  }

  return {
    ...actual,
    useState(initial) {
      const index = hooks.cursor++;
      if (!(index in hooks.states)) {
        hooks.states[index] = typeof initial === "function" ? initial() : initial;
      }
      const setValue = (next) => {
        hooks.states[index] = typeof next === "function" ? next(hooks.states[index]) : next;
      };
      return [hooks.states[index], setValue];
    },
    useRef(initial) {
      const index = hooks.cursor++;
      if (!(index in hooks.refs)) hooks.refs[index] = { current: initial };
      return hooks.refs[index];
    },
    useEffect(effect, deps) {
      const index = hooks.cursor++;
      if (dependenciesChanged(hooks.effectDeps[index], deps)) {
        const prevCleanup = hooks.effectCleanups[index];
        hooks.effectDeps[index] = deps;
        hooks.pending.push({ index, effect, prevCleanup });
      }
    },
  };
});

// react-router-dom — controllable per test via routerState.
const routerState = vi.hoisted(() => ({
  pathname: "/",
  searchParams: new URLSearchParams(),
}));
vi.mock("react-router-dom", () => ({
  useLocation: () => ({ pathname: routerState.pathname }),
  useSearchParams: () => [routerState.searchParams],
}));

// The global ⌘K/Ctrl+K hook — mocked wholesale so this file can assert on
// *what AskBar renders*, not on document-level keydown wiring (that's
// useGlobalShortcut's own concern, and it never touches AskBar's state
// machine). Captures the registered key + trigger for the one light
// assertion that AskBar actually wires it up.
const shortcut = vi.hoisted(() => ({ key: null, trigger: null }));
vi.mock("../lib/useGlobalShortcut.js", () => ({
  useGlobalShortcut: (key, onTrigger) => {
    shortcut.key = key;
    shortcut.trigger = onTrigger;
  },
}));

vi.mock("../components/icons.jsx", () => ({
  ArrowUpIcon: () => null,
  PaperclipIcon: () => null,
}));

const chatPanel = vi.hoisted(() => ({ props: null }));
vi.mock("../onboarding/ChatPanel.jsx", () => ({
  ChatPanel: (props) => {
    chatPanel.props = props;
    return { type: "chat-panel", props };
  },
}));

const api = vi.hoisted(() => ({
  ApiError: class ApiError extends Error {
    constructor(status, body) {
      super(`request failed with status ${status}`);
      this.name = "ApiError";
      this.status = status;
      this.body = body;
    }
  },
  getWorkspaceThread: vi.fn(),
  previewWorkspaceQuery: vi.fn(),
  runWorkspaceIntent: vi.fn(),
  sendWorkspaceMessage: vi.fn(),
  createIntake: vi.fn(),
  uploadIntakeFile: vi.fn(),
  listIntake: vi.fn(),
  confirmIntake: vi.fn(),
  reclassifyIntake: vi.fn(),
  dismissIntake: vi.fn(),
  completeDiscoveryStep: vi.fn(),
}));
vi.mock("../lib/api.js", () => api);

import { AskBar } from "./AskBar.jsx";

// ---------------------------------------------------------------------------
// Render + tree-walking helpers
// ---------------------------------------------------------------------------

function renderAskBar() {
  hooks.reset();
  return AskBar();
}

// Runs every effect queued by the render just performed, honoring cleanup:
// the previous run's cleanup (if any) fires before the new effect body does,
// same ordering real React uses on a dependency change.
function runPendingEffects() {
  const items = hooks.pending.splice(0);
  for (const { index, effect, prevCleanup } of items) {
    if (typeof prevCleanup === "function") prevCleanup();
    const cleanup = effect();
    hooks.effectCleanups[index] = typeof cleanup === "function" ? cleanup : undefined;
  }
}

async function flushMicrotasks() {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

// Inlines function-component children (AskBarPreview/AskBarTurn/EngineReceipt
// are plain, hook-free render functions defined in AskBar.jsx) so visit()/
// textOf() below can walk straight through to host elements.
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

function optionRows(tree) {
  return visit(tree, (n) => n.props?.role === "option");
}

function buttonByText(tree, label) {
  return visit(tree, (n) => n.type === "button").find((n) => textOf(n).trim() === label);
}

function render() {
  return expand(renderAskBar());
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function actionPreview({ engineAvailable = true } = {}) {
  return {
    action: {
      label: "Run a job search sweep",
      intent: {
        type: "search.run",
        entity: { type: "workspace", id: "workspace-thread" },
        input: { purpose: "manual-search" },
      },
    },
    answer: { label: 'Answer: "sweep my boards"' },
    engineAvailable,
  };
}

function jobActionPreview({
  type = "job.evaluate-request",
  label = "Capture and evaluate this job",
} = {}) {
  return {
    action: {
      label,
      intent: {
        type,
        entity: { type: "workspace", id: "workspace-main" },
        input: { jobUrl: "https://boards.greenhouse.io/acme/jobs/123" },
      },
    },
    answer: { label: "Answer about this job" },
    engineAvailable: true,
  };
}

function companyActionPreview() {
  return {
    action: {
      label: "Discover more matching companies",
      intent: {
        type: "company.discover",
        entity: { type: "workspace", id: "workspace-main" },
        input: { requestedCount: 12, request: "find more companies for me" },
      },
    },
    answer: { label: "Answer about company discovery" },
    engineAvailable: true,
  };
}

function boardDiscoveryActionPreview() {
  return {
    action: {
      label: "Find and review new job boards",
      intent: {
        type: "source.discover",
        entity: { type: "workspace", id: "workspace-main" },
        input: { request: "find more job boards for me" },
      },
    },
    answer: { label: "Answer about job board discovery" },
    engineAvailable: true,
  };
}

function answerOnlyPreview({ engineAvailable = true } = {}) {
  return {
    action: null,
    answer: { label: "Answer: “what's blocking my top role?”" },
    engineAvailable,
  };
}

function deferred() {
  let resolve;
  const promise = new Promise((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

function intakeItem(overrides = {}) {
  return {
    id: "intake-1",
    kind: "jd-text",
    status: "proposed",
    classification: { proposedAction: "Will tailor + apply." },
    trackerMatch: { matched: false },
    dispatchSummary: "tailor-application",
    ...overrides,
  };
}

// Minimal FileReader stand-in — this repo's vitest config runs in the "node"
// environment (no jsdom), so there's no real FileReader; readFileAsText
// (AskBar.jsx) only ever calls .readAsText(file) and reads .onload/.result,
// so that's all this fakes. Fixtures pass the text to read via a `__content`
// property on the fake File object rather than a real Blob body.
class FakeFileReader {
  readAsText(file) {
    Promise.resolve().then(() => {
      this.result = file?.__content ?? "";
      this.onload?.();
    });
  }
}

function pasteEvent(text) {
  return {
    preventDefault: vi.fn(),
    clipboardData: { getData: (type) => (type === "text/plain" ? text : "") },
  };
}

function dropEvent({ file, text, uri } = {}) {
  return {
    preventDefault: vi.fn(),
    dataTransfer: {
      files: file ? [file] : [],
      getData: (type) => {
        if (type === "text/uri-list") return uri || "";
        if (type === "text/plain") return text || "";
        return "";
      },
    },
  };
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

beforeEach(() => {
  hooks.clear();
  vi.clearAllMocks();
  vi.useFakeTimers();
  routerState.pathname = "/";
  routerState.searchParams = new URLSearchParams();
  shortcut.key = null;
  shortcut.trigger = null;
  chatPanel.props = null;
  globalThis.document = {
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  };
  globalThis.FileReader = FakeFileReader;
  // useNeedsYouCount's own mount effect (queued whenever a test calls
  // runPendingEffects()) fetches this — default to "nothing pending" so
  // tests that don't care about the NEEDS-YOU chip aren't forced to stub it.
  api.listIntake.mockResolvedValue({ items: [] });
});

afterEach(() => {
  vi.useRealTimers();
});

// ---------------------------------------------------------------------------
// 1. Idle
// ---------------------------------------------------------------------------

describe("AskBar — idle", () => {
  it("shows the pipeline placeholder on /jobs without a search tab", () => {
    routerState.pathname = "/jobs";
    routerState.searchParams = new URLSearchParams();
    const input = byTag(render(), "input");
    expect(input.props.placeholder).toBe("what's blocking my top role?");
  });

  it("shows the finder placeholder on /jobs?tab=search", () => {
    routerState.pathname = "/jobs";
    routerState.searchParams = new URLSearchParams({ tab: "search" });
    const input = byTag(render(), "input");
    expect(input.props.placeholder).toBe("sweep my pinned boards");
  });

  it("shows a route-specific placeholder on /calendar", () => {
    routerState.pathname = "/calendar";
    const input = byTag(render(), "input");
    expect(input.props.placeholder).toBe("when's my next prep?");
  });

  it("shows a route-specific placeholder on /network", () => {
    routerState.pathname = "/network";
    const input = byTag(render(), "input");
    expect(input.props.placeholder).toBe("draft a nudge to a contact");
  });

  it("falls back to the dashboard placeholder on an unmapped route", () => {
    routerState.pathname = "/somewhere-else";
    const input = byTag(render(), "input");
    expect(input.props.placeholder).toBe("what should I do next?");
  });

  it("shows the ⌘K hint while the input is empty, and registers the k shortcut", () => {
    const tree = render();
    const hint = byClass(tree, "ask-bar__kbd");
    expect(hint).toBeTruthy();
    expect(textOf(hint)).toBe("⌘K");
    expect(shortcut.key).toBe("k");
    expect(typeof shortcut.trigger).toBe("function");
  });

  it("keeps the shell's neutral 1px border while idle (no focused preview open)", () => {
    const tree = render();
    expect(hasClass(byClass(tree, "ask-bar__shell"), "ask-bar__shell--active")).toBe(false);
  });

  it("hides the ⌘K hint once there is text", () => {
    let tree = render();
    const input = byTag(tree, "input");
    input.props.onChange({ target: { value: "s" } });
    tree = render();
    expect(byClass(tree, "ask-bar__kbd")).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// 2. Focused — debounced preview
// ---------------------------------------------------------------------------

describe("AskBar — focused preview", () => {
  it("debounces typing into a single classify call, rendering ACTION+ANSWER when an action exists", async () => {
    api.previewWorkspaceQuery.mockResolvedValue(actionPreview());
    let tree = render();
    const input = byTag(tree, "input");
    input.props.onFocus();
    input.props.onChange({ target: { value: "sweep my boards" } });
    tree = render();
    runPendingEffects();

    expect(api.previewWorkspaceQuery).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(300);
    await flushMicrotasks();
    expect(api.previewWorkspaceQuery).toHaveBeenCalledTimes(1);
    expect(api.previewWorkspaceQuery).toHaveBeenCalledWith("sweep my boards");

    tree = render();
    const rows = optionRows(tree);
    expect(rows).toHaveLength(2);
    expect(textOf(rows[0])).toContain("Run a job search sweep");
    expect(textOf(rows[1])).toContain('Answer: "sweep my boards"');
  });

  it("gives the ACTION row DESIGN-SPEC.md's accent-tinted pill, the ANSWER row a neutral one, and turns the shell border active", async () => {
    api.previewWorkspaceQuery.mockResolvedValue(actionPreview());
    let tree = render();
    const input = byTag(tree, "input");
    input.props.onFocus();
    input.props.onChange({ target: { value: "sweep my boards" } });
    tree = render();
    runPendingEffects();
    await vi.advanceTimersByTimeAsync(300);
    await flushMicrotasks();
    tree = render();

    const rows = optionRows(tree);
    const actionKind = visit(rows[0], (n) => hasClass(n, "ask-bar__preview-kind"))[0];
    const answerKind = visit(rows[1], (n) => hasClass(n, "ask-bar__preview-kind"))[0];
    expect(hasClass(actionKind, "ask-bar__preview-kind--action")).toBe(true);
    expect(hasClass(answerKind, "ask-bar__preview-kind--action")).toBe(false);
    expect(hasClass(byClass(tree, "ask-bar__shell"), "ask-bar__shell--active")).toBe(true);
  });

  it("renders ANSWER only when the preview has no action", async () => {
    api.previewWorkspaceQuery.mockResolvedValue(answerOnlyPreview());
    let tree = render();
    const input = byTag(tree, "input");
    input.props.onFocus();
    input.props.onChange({ target: { value: "what's blocking my top role?" } });
    tree = render();
    runPendingEffects();
    await vi.advanceTimersByTimeAsync(300);
    await flushMicrotasks();

    tree = render();
    const rows = optionRows(tree);
    expect(rows).toHaveLength(1);
    expect(textOf(rows[0])).toContain("what's blocking my top role?");
  });

  it("passes the explicitly open job as context for 'this job' requests", async () => {
    routerState.pathname = "/jobs";
    routerState.searchParams = new URLSearchParams({ open: "app-acme" });
    api.previewWorkspaceQuery.mockResolvedValue(
      jobActionPreview({ label: "Evaluate this saved job" })
    );
    let tree = render();
    const input = byTag(tree, "input");
    input.props.onFocus();
    input.props.onChange({ target: { value: "rate this job" } });
    tree = render();
    runPendingEffects();
    await vi.advanceTimersByTimeAsync(300);
    await flushMicrotasks();

    expect(api.previewWorkspaceQuery).toHaveBeenCalledWith("rate this job", {
      pathname: "/jobs",
      jobId: "app-acme",
    });
  });

  it("a stale preview response resolving after a newer one does not overwrite it", async () => {
    const first = deferred();
    const second = deferred();
    api.previewWorkspaceQuery.mockImplementationOnce(() => first.promise);
    api.previewWorkspaceQuery.mockImplementationOnce(() => second.promise);

    let tree = render();
    let input = byTag(tree, "input");
    input.props.onFocus();
    input.props.onChange({ target: { value: "aaa" } });
    tree = render();
    runPendingEffects();
    await vi.advanceTimersByTimeAsync(300); // fires the "aaa" debounce -> first.promise

    tree = render();
    input = byTag(tree, "input");
    input.props.onChange({ target: { value: "bbb" } });
    tree = render();
    runPendingEffects();
    await vi.advanceTimersByTimeAsync(300); // fires the "bbb" debounce -> second.promise

    expect(api.previewWorkspaceQuery).toHaveBeenCalledTimes(2);

    // Newer ("bbb") resolves first.
    second.resolve({ action: null, answer: { label: "Answer: B" }, engineAvailable: true });
    await flushMicrotasks();
    tree = render();
    expect(textOf(optionRows(tree)[0])).toContain("Answer: B");

    // Older ("aaa") resolves late — must be ignored.
    first.resolve({ action: null, answer: { label: "Answer: A (stale)" }, engineAvailable: true });
    await flushMicrotasks();
    tree = render();
    expect(textOf(optionRows(tree)[0])).toContain("Answer: B");
    expect(textOf(optionRows(tree)[0])).not.toContain("stale");
  });
});

// ---------------------------------------------------------------------------
// 3. Nothing runs on a guess
// ---------------------------------------------------------------------------

describe("AskBar — nothing runs on a guess", () => {
  it("typing and a resolved preview never call the message/intent APIs on their own", async () => {
    api.previewWorkspaceQuery.mockResolvedValue(actionPreview());
    let tree = render();
    const input = byTag(tree, "input");
    input.props.onFocus();
    input.props.onChange({ target: { value: "sweep my boards" } });
    tree = render();
    runPendingEffects();
    await vi.advanceTimersByTimeAsync(300);
    await flushMicrotasks();
    render();

    expect(api.sendWorkspaceMessage).not.toHaveBeenCalled();
    expect(api.runWorkspaceIntent).not.toHaveBeenCalled();
  });

  it("Enter commits the selected ACTION row via runWorkspaceIntent", async () => {
    api.previewWorkspaceQuery.mockResolvedValue(actionPreview());
    api.runWorkspaceIntent.mockResolvedValue({
      data: {
        messages: [{ role: "assistant", kind: "action_result", text: "Sweep started." }],
      },
    });
    let tree = render();
    let input = byTag(tree, "input");
    input.props.onFocus();
    input.props.onChange({ target: { value: "sweep my boards" } });
    tree = render();
    runPendingEffects();
    await vi.advanceTimersByTimeAsync(300);
    await flushMicrotasks();
    tree = render();
    input = byTag(tree, "input");

    input.props.onKeyDown({ key: "Enter", preventDefault: vi.fn() });
    await flushMicrotasks();

    expect(api.runWorkspaceIntent).toHaveBeenCalledWith(
      "search.run",
      { type: "workspace", id: "workspace-thread" },
      { purpose: "manual-search" }
    );
    expect(api.sendWorkspaceMessage).not.toHaveBeenCalled();
  });

  it("Enter commits an ANSWER row via sendWorkspaceMessage when there is no action", async () => {
    api.sendWorkspaceMessage.mockResolvedValue({
      data: { messages: [{ role: "assistant", kind: "text", text: "Here you go." }] },
    });
    let tree = render();
    let input = byTag(tree, "input");
    input.props.onFocus();
    input.props.onChange({ target: { value: "what's blocking my top role?" } });
    tree = render();
    input = byTag(tree, "input");

    input.props.onKeyDown({ key: "Enter", preventDefault: vi.fn() });
    await flushMicrotasks();

    expect(api.sendWorkspaceMessage).toHaveBeenCalledWith("what's blocking my top role?");
    expect(api.runWorkspaceIntent).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// 4. Acting
// ---------------------------------------------------------------------------

describe("AskBar — acting", () => {
  it("renders a progress line with a live elapsed ticker while an action runs", async () => {
    const pending = deferred();
    api.runWorkspaceIntent.mockReturnValueOnce(pending.promise);
    // Seed the preview via the real debounce path so `selected` defaults to
    // "action" the same way a real user session would arrive at it.
    api.previewWorkspaceQuery.mockResolvedValue(actionPreview());

    let tree = render();
    let input = byTag(tree, "input");
    input.props.onFocus();
    input.props.onChange({ target: { value: "sweep my boards" } });
    tree = render();
    runPendingEffects();
    await vi.advanceTimersByTimeAsync(300);
    await flushMicrotasks();
    tree = render();

    input = byTag(tree, "input");
    input.props.onKeyDown({ key: "Enter", preventDefault: vi.fn() });
    tree = render();
    runPendingEffects(); // registers the ticker now that turn.status is "running"

    let progress = byClass(tree, "ask-bar__progress");
    expect(textOf(progress)).toContain("Running · Run a job search sweep · 0S");
    expect(byClass(tree, "ask-bar__progress-spinner")).toBeTruthy();
    // The panel's 1.5px active border is a focused-preview signal — once the
    // turn starts running, text/preview are cleared and the shell reverts to
    // its neutral idle border (DESIGN-SPEC.md: acting state, not focused).
    expect(hasClass(byClass(tree, "ask-bar__shell"), "ask-bar__shell--active")).toBe(false);

    await vi.advanceTimersByTimeAsync(3000);
    tree = render();
    progress = byClass(tree, "ask-bar__progress");
    expect(textOf(progress)).toContain("3S");

    pending.resolve({
      data: { messages: [{ role: "assistant", kind: "action_result", text: "Done." }] },
    });
    await flushMicrotasks();
    render();
  });

  it("renders a completed answer inline with the AI · <label> · <N>S receipt", async () => {
    api.sendWorkspaceMessage.mockResolvedValue({
      data: {
        messages: [
          {
            role: "assistant",
            kind: "text",
            text: "Here's your answer.",
            metadata: { engine: { id: "claude", label: "Claude Code" }, elapsedMs: 4200 },
          },
        ],
      },
    });
    let tree = render();
    let input = byTag(tree, "input");
    input.props.onChange({ target: { value: "what should I do next?" } });
    tree = render();
    input = byTag(tree, "input");
    input.props.onKeyDown({ key: "Enter", preventDefault: vi.fn() });
    await flushMicrotasks();
    tree = render();

    const answer = byClass(tree, "ask-bar__answer");
    expect(textOf(answer)).toBe("Here's your answer.");
    const receipt = byClass(tree, "ask-bar__receipt");
    expect(textOf(receipt)).toBe("AI · Claude Code · 4S");
  });

  it("renders a structured job evaluation and runs its typed next action", async () => {
    api.previewWorkspaceQuery.mockResolvedValue(jobActionPreview());
    api.runWorkspaceIntent
      .mockResolvedValueOnce({
        data: {
          messages: [
            {
              role: "assistant",
              kind: "action_result",
              text: "Evaluated Acme — Staff AI Engineer: Keep (92/100 fit).",
              artifacts: [
                {
                  kind: "job_evaluation",
                  title: "Acme — Staff AI Engineer — Keep",
                  applicationId: "app-acme",
                  evaluation: {
                    gate: "keep",
                    fitScore: 92,
                    fitReasons: ["Strong production AI evidence"],
                    fitRisks: ["Travel frequency is unclear"],
                    compensation: { summary: "Posted range clears the floor." },
                  },
                },
              ],
              metadata: {
                state: "keep",
                nextActions: [
                  {
                    label: "Prepare application",
                    intent: {
                      type: "job.generate-documents",
                      entity: { type: "application", id: "app-acme" },
                      input: { applyIntent: true, formats: ["pdf"] },
                    },
                  },
                ],
              },
            },
          ],
        },
      })
      .mockResolvedValueOnce({
        data: {
          messages: [
            {
              role: "assistant",
              kind: "action_result",
              text: "Generated the application packet.",
              artifacts: [
                {
                  kind: "packet_generation",
                  status: "reviewable",
                  uploadReady: false,
                  blockingGapCount: 0,
                  gaps: [{ kind: "answers", message: "Application questions are pending." }],
                },
              ],
            },
          ],
        },
      });

    let tree = render();
    const input = byTag(tree, "input");
    input.props.onFocus();
    input.props.onChange({
      target: { value: "rate https://boards.greenhouse.io/acme/jobs/123" },
    });
    tree = render();
    runPendingEffects();
    await vi.advanceTimersByTimeAsync(300);
    await flushMicrotasks();
    tree = render();
    byTag(tree, "input").props.onKeyDown({ key: "Enter", preventDefault: vi.fn() });
    await flushMicrotasks();
    tree = render();

    const evaluation = byClass(tree, "ask-bar__evaluation");
    expect(textOf(evaluation)).toContain("KEEP");
    expect(textOf(evaluation)).toContain("92/100 fit");
    expect(textOf(evaluation)).toContain("Posted range clears the floor.");
    expect(textOf(evaluation)).toContain("Strong production AI evidence");
    expect(textOf(evaluation)).toContain("Travel frequency is unclear");

    buttonByText(tree, "Prepare application").props.onClick();
    await flushMicrotasks();
    tree = render();
    expect(textOf(byClass(tree, "ask-bar__packet-status"))).not.toContain("needs review");
    expect(api.runWorkspaceIntent).toHaveBeenNthCalledWith(
      2,
      "job.generate-documents",
      { type: "application", id: "app-acme" },
      { applyIntent: true, formats: ["pdf"] }
    );
  });

  it("renders company proposals and keeps Track or Skip decisions in the workspace thread", async () => {
    api.previewWorkspaceQuery.mockResolvedValue(companyActionPreview());
    const proposal = {
      proposalId: "proposal-acme",
      company: { name: "Acme AI" },
      why: "Matches your applied AI focus.",
      roleSeen: "Applied AI Engineer",
      atsProvider: "lever",
      confidenceTier: "high-confidence",
      version: 1,
    };
    api.runWorkspaceIntent
      .mockResolvedValueOnce({
        data: {
          messages: [
            {
              role: "assistant",
              kind: "action_result",
              text: "Found 1 new company beyond your focus examples.",
              artifacts: [
                {
                  kind: "company_proposals",
                  title: "Company discovery: 1 to review",
                  batchId: "batch-acme",
                  version: 1,
                  proposals: [proposal],
                  rejected: [],
                  counts: { seeds: 1, proposals: 1, rejected: 0 },
                  seedSource: "ai",
                },
              ],
              metadata: { state: "needs-review" },
            },
          ],
        },
      })
      .mockResolvedValueOnce({
        data: {
          messages: [
            {
              role: "assistant",
              kind: "action_result",
              text: "Tracking Acme AI. All company proposals are reviewed.",
              artifacts: [
                {
                  kind: "company_proposals",
                  title: "Company discovery: review complete",
                  batchId: "batch-acme",
                  version: 2,
                  proposals: [],
                  rejected: [],
                  counts: { seeds: 1, proposals: 1, rejected: 0 },
                  seedSource: null,
                },
              ],
              metadata: {
                state: "complete",
                nextActions: [
                  {
                    label: "Search the expanded company set",
                    intent: {
                      type: "search.run",
                      entity: { type: "workspace", id: "workspace-main" },
                      input: { purpose: "manual-search" },
                    },
                  },
                ],
              },
            },
          ],
        },
      });

    let tree = render();
    const input = byTag(tree, "input");
    input.props.onFocus();
    input.props.onChange({ target: { value: "find more companies for me" } });
    tree = render();
    runPendingEffects();
    await vi.advanceTimersByTimeAsync(300);
    await flushMicrotasks();
    tree = render();
    byTag(tree, "input").props.onKeyDown({ key: "Enter", preventDefault: vi.fn() });
    await flushMicrotasks();
    tree = render();

    const card = byClass(tree, "ask-bar__company-proposals");
    expect(textOf(card)).toContain("Acme AI");
    expect(textOf(card)).toContain("Matches your applied AI focus.");
    expect(textOf(card)).toContain("Applied AI Engineer");

    buttonByText(tree, "Track").props.onClick();
    await flushMicrotasks();
    tree = render();

    expect(api.runWorkspaceIntent).toHaveBeenNthCalledWith(
      2,
      "company.proposal-decide",
      { type: "company-proposal", id: "proposal-acme" },
      {
        batchId: "batch-acme",
        proposalId: "proposal-acme",
        action: "approve-supported-ats",
        expectedVersion: 1,
      }
    );
    expect(textOf(tree)).toContain("All company proposals are reviewed");
    expect(buttonByText(tree, "Search the expanded company set")).toBeTruthy();
  });

  it("keeps post-setup job-board discovery visible in Ask and returns to Jobs or Settings", async () => {
    api.previewWorkspaceQuery.mockResolvedValue(boardDiscoveryActionPreview());
    api.completeDiscoveryStep.mockResolvedValue({ ok: true });
    api.runWorkspaceIntent.mockResolvedValue({
      data: {
        messages: [
          {
            role: "assistant",
            kind: "action_result",
            text: "Started a guided search for new job boards. Review every source before adding it.",
            artifacts: [
              {
                kind: "board_discovery_chat",
                title: "Job board discovery",
                chatId: "research-boards-live",
                skill: "research-boards",
                state: "running",
                reused: false,
              },
            ],
            metadata: {
              state: "running",
              nextActions: [
                { label: "Search jobs", href: "/jobs?tab=search" },
                { label: "Manage sources", href: "/settings" },
              ],
            },
          },
        ],
      },
    });

    let tree = render();
    const input = byTag(tree, "input");
    input.props.onFocus();
    input.props.onChange({ target: { value: "find more job boards for me" } });
    tree = render();
    runPendingEffects();
    await vi.advanceTimersByTimeAsync(300);
    await flushMicrotasks();
    tree = render();
    byTag(tree, "input").props.onKeyDown({ key: "Enter", preventDefault: vi.fn() });
    await flushMicrotasks();
    tree = render();

    expect(api.runWorkspaceIntent).toHaveBeenCalledWith(
      "source.discover",
      { type: "workspace", id: "workspace-main" },
      { request: "find more job boards for me" }
    );
    expect(byTag(tree, "chat-panel")).toBeTruthy();
    expect(chatPanel.props).toMatchObject({
      skill: "research-boards",
      initialChatId: "research-boards-live",
      completionLabel: "Finish board review",
    });
    await chatPanel.props.onComplete();
    expect(api.completeDiscoveryStep).toHaveBeenCalledWith("research-boards");

    const links = visit(tree, (node) => node.type === "a");
    expect(links.map((link) => [textOf(link).trim(), link.props.href])).toEqual([
      ["Search jobs", "/app/jobs?tab=search"],
      ["Manage sources", "/app/settings"],
    ]);
  });

  it("shows recurring company proposals immediately while the job search continues", async () => {
    api.previewWorkspaceQuery.mockResolvedValue(actionPreview());
    api.runWorkspaceIntent.mockResolvedValue({
      data: {
        messages: [
          {
            role: "assistant",
            kind: "action_result",
            text: "Job search started. 1 company needs review while it runs.",
            artifacts: [
              {
                kind: "search_run",
                runId: "manual-search-recurring",
                status: "running",
              },
              {
                kind: "company_proposals",
                batchId: "batch-recurring",
                proposals: [
                  {
                    proposalId: "proposal-recurring",
                    company: { name: "Recurring Co" },
                    version: 1,
                  },
                ],
                rejected: [],
              },
            ],
            metadata: {
              searchRunId: "manual-search-recurring",
              searchTerminal: false,
              companyReview: true,
            },
          },
        ],
      },
    });

    let tree = render();
    const input = byTag(tree, "input");
    input.props.onFocus();
    input.props.onChange({ target: { value: "sweep my boards" } });
    tree = render();
    runPendingEffects();
    await vi.advanceTimersByTimeAsync(300);
    await flushMicrotasks();
    tree = render();
    byTag(tree, "input").props.onKeyDown({ key: "Enter", preventDefault: vi.fn() });
    await flushMicrotasks();
    tree = render();

    expect(textOf(tree)).toContain("Recurring Co");
    expect(api.getWorkspaceThread).not.toHaveBeenCalled();
  });

  it("allows the company-review handoff to open the current Jobs search tab", async () => {
    api.previewWorkspaceQuery.mockResolvedValue(companyActionPreview());
    api.runWorkspaceIntent.mockResolvedValue({
      data: {
        messages: [
          {
            role: "assistant",
            kind: "action_result",
            text: "All company proposals are reviewed.",
            metadata: {
              nextActions: [
                { label: "Review the current job search", href: "/jobs?tab=search" },
                { label: "Unsafe tab", href: "/jobs?tab=settings" },
              ],
            },
          },
        ],
      },
    });

    let tree = render();
    const input = byTag(tree, "input");
    input.props.onFocus();
    input.props.onChange({ target: { value: "find more companies" } });
    tree = render();
    runPendingEffects();
    await vi.advanceTimersByTimeAsync(300);
    await flushMicrotasks();
    tree = render();
    byTag(tree, "input").props.onKeyDown({ key: "Enter", preventDefault: vi.fn() });
    await flushMicrotasks();
    tree = render();

    const links = visit(tree, (node) => node.type === "a");
    expect(links).toHaveLength(1);
    expect(links[0].props.href).toBe("/app/jobs?tab=search");
  });

  it("keeps internal result actions inside the mounted /app router", async () => {
    api.previewWorkspaceQuery.mockResolvedValue(jobActionPreview());
    api.runWorkspaceIntent.mockResolvedValue({
      data: {
        messages: [
          {
            role: "assistant",
            kind: "action_result",
            text: "Evaluated Acme — Staff AI Engineer: Review (72/100 fit).",
            artifacts: [
              {
                kind: "job_evaluation",
                evaluation: { gate: "review", fitScore: 72 },
              },
            ],
            metadata: {
              nextActions: [
                { label: "Review this job", href: "/jobs?open=app-acme" },
                { label: "Unsafe route", href: "/jobs?open=%22%3E%3Cimg%20src=x%3E" },
                { label: "Unsafe scheme", href: "javascript:alert(1)" },
              ],
            },
          },
        ],
      },
    });

    let tree = render();
    const input = byTag(tree, "input");
    input.props.onFocus();
    input.props.onChange({ target: { value: "rate this job" } });
    tree = render();
    runPendingEffects();
    await vi.advanceTimersByTimeAsync(300);
    await flushMicrotasks();
    tree = render();
    byTag(tree, "input").props.onKeyDown({ key: "Enter", preventDefault: vi.fn() });
    await flushMicrotasks();
    tree = render();

    const link = visit(
      tree,
      (node) => node.type === "a" && textOf(node).trim() === "Review this job"
    )[0];
    expect(link.props.href).toBe("/app/jobs?open=app-acme");
    expect(visit(tree, (node) => node.type === "a")).toHaveLength(1);
  });

  it("renders a manual application handoff without claiming submission", async () => {
    api.previewWorkspaceQuery.mockResolvedValue(
      jobActionPreview({
        type: "job.prepare-request",
        label: "Evaluate and prepare this application",
      })
    );
    api.runWorkspaceIntent.mockResolvedValue({
      data: {
        messages: [
          {
            role: "assistant",
            kind: "action_result",
            text: "The site is ready for you. This application was not marked Applied.",
            artifacts: [
              {
                kind: "application_handoff",
                title: "Acme — Staff AI Engineer — Application site",
                applicationId: "app-acme",
                url: "https://boards.greenhouse.io/acme/jobs/123",
                submissionVerified: false,
              },
            ],
            metadata: {
              state: "manual-handoff",
              submissionVerified: false,
              nextActions: [
                {
                  label: "I applied",
                  intent: {
                    type: "application.record-external",
                    entity: { type: "application", id: "app-acme" },
                  },
                },
              ],
            },
          },
        ],
      },
    });

    let tree = render();
    const input = byTag(tree, "input");
    input.props.onFocus();
    input.props.onChange({
      target: { value: "apply https://boards.greenhouse.io/acme/jobs/123" },
    });
    tree = render();
    runPendingEffects();
    await vi.advanceTimersByTimeAsync(300);
    await flushMicrotasks();
    tree = render();
    byTag(tree, "input").props.onKeyDown({ key: "Enter", preventDefault: vi.fn() });
    await flushMicrotasks();
    tree = render();

    expect(textOf(tree)).toContain("This application was not marked Applied.");
    const siteLink = visit(
      tree,
      (node) => node.type === "a" && textOf(node).trim() === "Open application site"
    )[0];
    expect(siteLink.props.href).toBe("https://boards.greenhouse.io/acme/jobs/123");
    expect(buttonByText(tree, "I applied")).toBeTruthy();
    expect(textOf(tree)).not.toContain("Application submitted and verified");
  });

  it("does not render an executable application handoff URL", async () => {
    api.previewWorkspaceQuery.mockResolvedValue(
      jobActionPreview({
        type: "job.prepare-request",
        label: "Evaluate and prepare this application",
      })
    );
    api.runWorkspaceIntent.mockResolvedValue({
      data: {
        messages: [
          {
            role: "assistant",
            kind: "action_result",
            text: "The site handoff needs a valid posting URL.",
            artifacts: [
              {
                kind: "application_handoff",
                applicationId: "app-acme",
                url: "javascript:alert(1)",
                submissionVerified: false,
              },
            ],
          },
        ],
      },
    });

    let tree = render();
    const input = byTag(tree, "input");
    input.props.onFocus();
    input.props.onChange({
      target: { value: "apply https://boards.greenhouse.io/acme/jobs/123" },
    });
    tree = render();
    runPendingEffects();
    await vi.advanceTimersByTimeAsync(300);
    await flushMicrotasks();
    tree = render();
    byTag(tree, "input").props.onKeyDown({ key: "Enter", preventDefault: vi.fn() });
    await flushMicrotasks();
    tree = render();

    expect(
      visit(tree, (node) => node.type === "a" && textOf(node).trim() === "Open application site")
    ).toHaveLength(0);
  });

  it("renders an inline error when the agent turn comes back as agent_error", async () => {
    api.sendWorkspaceMessage.mockResolvedValue({
      data: {
        messages: [
          {
            role: "assistant",
            kind: "agent_error",
            text: "The agent hit a snag.",
            error: { code: "SOME_OTHER_CODE" },
          },
        ],
      },
    });
    let tree = render();
    let input = byTag(tree, "input");
    input.props.onChange({ target: { value: "what should I do next?" } });
    tree = render();
    input = byTag(tree, "input");
    input.props.onKeyDown({ key: "Enter", preventDefault: vi.fn() });
    await flushMicrotasks();
    tree = render();

    const error = byClass(tree, "ask-bar__error");
    expect(textOf(error)).toBe("The agent hit a snag.");
  });

  it("shows saved-job ambiguity as a clarification without a blind retry", async () => {
    api.previewWorkspaceQuery.mockResolvedValue(
      actionPreview({ type: "job.evaluate-request", label: "Evaluate this saved job" })
    );
    api.runWorkspaceIntent.mockRejectedValue(
      new api.ApiError(409, {
        code: "JOB_REFERENCE_AMBIGUOUS",
        error: { message: "internal text must not render" },
        details: {
          matches: [
            { company: "Acme", role: "Senior AI Engineer" },
            { company: "Acme", role: "Staff Platform Engineer" },
          ],
        },
      })
    );

    let tree = render();
    let input = byTag(tree, "input");
    input.props.onFocus();
    input.props.onChange({ target: { value: "rate the Acme role" } });
    tree = render();
    runPendingEffects();
    await vi.advanceTimersByTimeAsync(300);
    await flushMicrotasks();
    tree = render();
    input = byTag(tree, "input");
    input.props.onKeyDown({ key: "Enter", preventDefault: vi.fn() });
    await flushMicrotasks();
    tree = render();

    expect(textOf(byClass(tree, "ask-bar__error"))).toContain("Acme — Senior AI Engineer");
    expect(textOf(byClass(tree, "ask-bar__error"))).toContain("Acme — Staff Platform Engineer");
    expect(buttonByText(tree, "Try again")).toBeFalsy();
  });

  it("keeps a failed answer retryable and resends the exact request", async () => {
    api.sendWorkspaceMessage
      .mockRejectedValueOnce(new api.ApiError(500, { error: "upstream unavailable" }))
      .mockResolvedValueOnce({
        data: {
          messages: [
            {
              role: "assistant",
              kind: "text",
              text: "Recovered answer.",
              metadata: { engine: { id: "codex", label: "Codex" }, elapsedMs: 900 },
            },
          ],
        },
      });

    let tree = render();
    let input = byTag(tree, "input");
    input.props.onChange({ target: { value: "what should I do next?" } });
    tree = render();
    input = byTag(tree, "input");
    input.props.onKeyDown({ key: "Enter", preventDefault: vi.fn() });
    await flushMicrotasks();
    tree = render();

    const retry = buttonByText(tree, "Try again");
    expect(retry).toBeTruthy();
    retry.props.onClick();
    await flushMicrotasks();
    tree = render();

    expect(api.sendWorkspaceMessage).toHaveBeenCalledTimes(2);
    expect(api.sendWorkspaceMessage).toHaveBeenNthCalledWith(1, "what should I do next?");
    expect(api.sendWorkspaceMessage).toHaveBeenNthCalledWith(2, "what should I do next?");
    expect(textOf(byClass(tree, "ask-bar__answer"))).toBe("Recovered answer.");
  });

  it("commits straight to the NO ENGINE state when the preview says engineAvailable:false, without calling sendWorkspaceMessage", async () => {
    api.previewWorkspaceQuery.mockResolvedValue(answerOnlyPreview({ engineAvailable: false }));
    let tree = render();
    let input = byTag(tree, "input");
    input.props.onFocus();
    input.props.onChange({ target: { value: "what's blocking my top role?" } });
    tree = render();
    runPendingEffects();
    await vi.advanceTimersByTimeAsync(300);
    await flushMicrotasks();
    tree = render();
    input = byTag(tree, "input");

    input.props.onKeyDown({ key: "Enter", preventDefault: vi.fn() });
    await flushMicrotasks();
    tree = render();

    expect(api.sendWorkspaceMessage).not.toHaveBeenCalled();
    const error = byClass(tree, "ask-bar__error");
    expect(textOf(error)).toMatch(/No AI engine is configured yet/);
    const receipt = byClass(tree, "ask-bar__receipt--no-engine");
    expect(textOf(receipt)).toBe("No engine");
  });
});

// ---------------------------------------------------------------------------
// 5. Turn-id race guard (the fix commit 95f27540 landed)
// ---------------------------------------------------------------------------

describe("AskBar — turn-id race guard", () => {
  it("a superseded turn's late resolution never clobbers the newer turn's state", async () => {
    const firstCall = deferred();
    const secondCall = deferred();
    api.sendWorkspaceMessage.mockImplementationOnce(() => firstCall.promise);
    api.sendWorkspaceMessage.mockImplementationOnce(() => secondCall.promise);

    // Commit turn 1 — its promise stays unresolved.
    let tree = render();
    let input = byTag(tree, "input");
    input.props.onChange({ target: { value: "first request" } });
    tree = render();
    input = byTag(tree, "input");
    input.props.onKeyDown({ key: "Enter", preventDefault: vi.fn() });
    tree = render();
    expect(textOf(byClass(tree, "ask-bar__progress"))).toContain("first request");

    // Commit turn 2 while turn 1 is still in flight.
    input = byTag(tree, "input");
    input.props.onChange({ target: { value: "second request" } });
    tree = render();
    input = byTag(tree, "input");
    input.props.onKeyDown({ key: "Enter", preventDefault: vi.fn() });
    tree = render();
    expect(textOf(byClass(tree, "ask-bar__progress"))).toContain("second request");

    // Turn 2 finishes first.
    secondCall.resolve({
      data: { messages: [{ role: "assistant", kind: "text", text: "Second answer" }] },
    });
    await flushMicrotasks();
    tree = render();
    expect(textOf(byClass(tree, "ask-bar__answer"))).toBe("Second answer");

    // Turn 1 finally resolves — must be dropped, not clobber turn 2's state.
    firstCall.resolve({
      data: { messages: [{ role: "assistant", kind: "text", text: "First result (late)" }] },
    });
    await flushMicrotasks();
    tree = render();
    expect(textOf(byClass(tree, "ask-bar__answer"))).toBe("Second answer");
  });
});

// ---------------------------------------------------------------------------
// 6. Esc collapse/blur + arrow-key selection
// ---------------------------------------------------------------------------

describe("AskBar — keyboard: Esc and arrow keys", () => {
  it("Escape collapses the preview panel when it is open", async () => {
    api.previewWorkspaceQuery.mockResolvedValue(actionPreview());
    let tree = render();
    let input = byTag(tree, "input");
    input.props.onFocus();
    input.props.onChange({ target: { value: "sweep my boards" } });
    tree = render();
    runPendingEffects();
    await vi.advanceTimersByTimeAsync(300);
    await flushMicrotasks();
    tree = render();
    expect(optionRows(tree).length).toBeGreaterThan(0);

    input = byTag(tree, "input");
    input.props.onKeyDown({ key: "Escape", preventDefault: vi.fn() });
    tree = render();
    expect(optionRows(tree)).toHaveLength(0);
  });

  it("Escape with the panel already closed is a safe no-op (blurs an idle bar)", () => {
    const tree = render();
    const input = byTag(tree, "input");
    expect(() => input.props.onKeyDown({ key: "Escape", preventDefault: vi.fn() })).not.toThrow();
  });

  it("arrow keys move the selected preview row and wrap around", async () => {
    api.previewWorkspaceQuery.mockResolvedValue(actionPreview());
    let tree = render();
    let input = byTag(tree, "input");
    input.props.onFocus();
    input.props.onChange({ target: { value: "sweep my boards" } });
    tree = render();
    runPendingEffects();
    await vi.advanceTimersByTimeAsync(300);
    await flushMicrotasks();
    tree = render();

    function selectedKind(t) {
      const row = optionRows(t).find((r) => r.props["aria-selected"]);
      return textOf(row).includes("Action") ? "action" : "answer";
    }

    expect(selectedKind(tree)).toBe("action");

    input = byTag(tree, "input");
    input.props.onKeyDown({ key: "ArrowDown", preventDefault: vi.fn() });
    tree = render();
    expect(selectedKind(tree)).toBe("answer");

    input = byTag(tree, "input");
    input.props.onKeyDown({ key: "ArrowDown", preventDefault: vi.fn() });
    tree = render();
    expect(selectedKind(tree)).toBe("action");

    input = byTag(tree, "input");
    input.props.onKeyDown({ key: "ArrowUp", preventDefault: vi.fn() });
    tree = render();
    expect(selectedKind(tree)).toBe("answer");
  });
});

// ---------------------------------------------------------------------------
// 7. Lane B — universal intake (paste/drop/attach capture)
// ---------------------------------------------------------------------------

describe("AskBar — Lane B: paste routing", () => {
  it("a multi-line paste flips into capture mode with a CAPTURE row as the default", () => {
    let tree = render();
    const input = byTag(tree, "input");
    const evt = pasteEvent("Line one\nLine two");
    input.props.onPaste(evt);
    expect(evt.preventDefault).toHaveBeenCalled();

    tree = render();
    // The main text control swaps to a <textarea>; note a hidden
    // <input type="file"> (the attach control) is always present in the
    // row, so this checks the ask-bar__input-classed element specifically
    // rather than asserting no <input> tag exists anywhere.
    expect(byTag(tree, "textarea")).toBeTruthy();
    expect(byClass(tree, "ask-bar__input").type).toBe("textarea");
    const rows = optionRows(tree);
    expect(rows).toHaveLength(2);
    expect(textOf(rows[0])).toContain("Send to triage");
    expect(rows[0].props["aria-selected"]).toBe(true);
    expect(textOf(rows[1])).toContain("Ask the workspace agent");

    // CAPTURE commits on Enter, same as ACTION — same accent-tinted pill.
    const captureKind = visit(rows[0], (n) => hasClass(n, "ask-bar__preview-kind"))[0];
    expect(hasClass(captureKind, "ask-bar__preview-kind--action")).toBe(true);
  });

  it("a paste over 200 chars (no newline) also flips into capture mode", () => {
    let tree = render();
    const input = byTag(tree, "input");
    const long = "x".repeat(210);
    const evt = pasteEvent(long);
    input.props.onPaste(evt);
    expect(evt.preventDefault).toHaveBeenCalled();

    tree = render();
    expect(byTag(tree, "textarea").props.value).toBe(long);
  });

  it("a short single-line paste is left to the browser's default behavior, unchanged", () => {
    let tree = render();
    const input = byTag(tree, "input");
    const evt = pasteEvent("sweep my boards");
    input.props.onPaste(evt);
    expect(evt.preventDefault).not.toHaveBeenCalled();

    tree = render();
    expect(byTag(tree, "textarea")).toBeFalsy();
    expect(byClass(tree, "ask-bar__input").type).toBe("input");
  });

  it("does not call previewWorkspaceQuery while in capture mode", async () => {
    let tree = render();
    const input = byTag(tree, "input");
    input.props.onPaste(pasteEvent("Line one\nLine two"));
    tree = render();
    runPendingEffects();
    await vi.advanceTimersByTimeAsync(300);
    await flushMicrotasks();

    expect(api.previewWorkspaceQuery).not.toHaveBeenCalled();
  });

  it("preserves a typed apply request when a JD is pasted after it", async () => {
    api.createIntake.mockResolvedValue({
      item: intakeItem({ status: "proposed", requestedAction: "prepare" }),
    });
    let tree = render();
    byClass(tree, "ask-bar__input").props.onChange({ target: { value: "Apply to this job" } });
    tree = render();
    byClass(tree, "ask-bar__input").props.onPaste(
      pasteEvent("Acme\nSRE\nKeep production reliable.")
    );
    tree = render();

    expect(textOf(optionRows(tree)[0])).toContain("evaluate, and prepare");
    byTag(tree, "textarea").props.onKeyDown({ key: "Enter", preventDefault: vi.fn() });
    await flushMicrotasks();

    expect(api.createIntake).toHaveBeenCalledWith({
      text: "Acme\nSRE\nKeep production reliable.",
      requestedAction: "prepare",
    });
  });

  it("separates an apply instruction from a JD pasted in one block", async () => {
    api.createIntake.mockResolvedValue({
      item: intakeItem({ status: "proposed", requestedAction: "prepare" }),
    });
    let tree = render();
    byClass(tree, "ask-bar__input").props.onPaste(
      pasteEvent("Apply to this job:\nAcme\nSRE\nKeep production reliable.")
    );
    tree = render();

    expect(byTag(tree, "textarea").props.value).toBe("Acme\nSRE\nKeep production reliable.");
    byTag(tree, "textarea").props.onKeyDown({ key: "Enter", preventDefault: vi.fn() });
    await flushMicrotasks();

    expect(api.createIntake).toHaveBeenCalledWith({
      text: "Acme\nSRE\nKeep production reliable.",
      requestedAction: "prepare",
    });
  });
});

describe("AskBar — Lane B: drop", () => {
  it("dropping a .txt file reads it client-side and treats it as pasted text", async () => {
    let tree = render();
    const shell = byClass(tree, "ask-bar__shell");
    const file = { name: "jd.txt", type: "text/plain", __content: "Line one\nLine two" };
    await shell.props.onDrop(dropEvent({ file }));
    await flushMicrotasks();

    tree = render();
    expect(api.uploadIntakeFile).not.toHaveBeenCalled();
    expect(byTag(tree, "textarea").props.value).toBe("Line one\nLine two");
  });

  it("dropping a non-text file uploads it via the raw-bytes endpoint", async () => {
    api.uploadIntakeFile.mockResolvedValue({ item: intakeItem({ status: "needs_you" }) });
    let tree = render();
    const shell = byClass(tree, "ask-bar__shell");
    const file = { name: "resume.pdf", type: "application/pdf" };
    await shell.props.onDrop(dropEvent({ file }));
    await flushMicrotasks();

    expect(api.uploadIntakeFile).toHaveBeenCalledWith(file);
    tree = render();
    expect(textOf(byClass(tree, "ask-bar__intake"))).toContain("Needs you");
  });
});

describe("AskBar — Lane B: attach", () => {
  it("picking a non-text file through the hidden file input uploads it, same as drop", async () => {
    api.uploadIntakeFile.mockResolvedValue({ item: intakeItem({ status: "proposed" }) });
    const tree = render();
    const fileInput = byClass(tree, "ask-bar__file-input");
    const file = { name: "resume.pdf", type: "application/pdf" };
    await fileInput.props.onChange({ target: { files: [file], value: "x" } });

    expect(api.uploadIntakeFile).toHaveBeenCalledWith(file);
  });

  it("passes a typed apply request with an attached binary JD", async () => {
    api.uploadIntakeFile.mockResolvedValue({
      item: intakeItem({ status: "proposed", requestedAction: "prepare" }),
    });
    let tree = render();
    byClass(tree, "ask-bar__input").props.onChange({ target: { value: "Apply to this job" } });
    tree = render();
    const file = { name: "jd.pdf", type: "application/pdf" };
    await byClass(tree, "ask-bar__file-input").props.onChange({
      target: { files: [file], value: "x" },
    });

    expect(api.uploadIntakeFile).toHaveBeenCalledWith(file, { requestedAction: "prepare" });
  });
});

describe("AskBar — Lane B: capture receipt decide actions", () => {
  async function commitLongPaste() {
    let tree = render();
    let input = byTag(tree, "input");
    input.props.onPaste(pasteEvent("Line one\nLine two"));
    tree = render();
    input = byTag(tree, "textarea");
    input.props.onKeyDown({ key: "Enter", preventDefault: vi.fn() });
    await flushMicrotasks();
    return render();
  }

  it("Confirm hits confirmIntake for a proposed item", async () => {
    api.createIntake.mockResolvedValue({ item: intakeItem({ status: "proposed" }) });
    api.confirmIntake.mockResolvedValue({
      item: intakeItem({
        status: "running",
        dispatch: { lane: "B", params: { skill: "tailor-application" } },
      }),
    });
    let tree = await commitLongPaste();

    expect(api.createIntake).toHaveBeenCalledWith({ text: "Line one\nLine two" });
    const confirm = buttonByText(tree, "Confirm");
    expect(confirm).toBeTruthy();
    confirm.props.onClick();
    await flushMicrotasks();

    expect(api.confirmIntake).toHaveBeenCalledWith("intake-1");
    tree = render();
    expect(textOf(byClass(tree, "ask-bar__intake"))).toContain("Running");
  });

  it("renders a confirmed JD's evaluation and a safe link to its saved job", async () => {
    api.createIntake.mockResolvedValue({ item: intakeItem({ status: "proposed" }) });
    api.confirmIntake.mockResolvedValue({
      item: intakeItem({
        status: "done",
        dispatch: {
          lane: "W",
          action: "workspace_intent",
          params: { intentType: "job.evaluate-request" },
        },
        result: {
          summary: "Evaluated Acme — SRE: Keep (91/100 fit).",
          applicationId: "app-acme",
          evaluation: {
            gate: "keep",
            fitScore: 91,
            fitReasons: ["Strong reliability evidence"],
          },
          nextActions: [
            {
              label: "Prepare application",
              intent: {
                type: "job.generate-documents",
                entity: { type: "application", id: "app-acme" },
                input: { applyIntent: true, formats: ["pdf"] },
              },
            },
          ],
        },
      }),
    });
    let tree = await commitLongPaste();
    buttonByText(tree, "Confirm").props.onClick();
    await flushMicrotasks();
    tree = render();

    expect(textOf(byClass(tree, "ask-bar__receipt"))).toContain(
      "Evaluated Acme — SRE: Keep (91/100 fit)."
    );
    expect(textOf(byClass(tree, "ask-bar__evaluation"))).toContain("91/100 fit");
    const link = visit(tree, (node) => node.type === "a" && textOf(node) === "Review this job")[0];
    expect(link.props.href).toBe("/app/jobs?open=app-acme");
    expect(buttonByText(tree, "Prepare application")).toBeTruthy();
  });

  it("renders the packet and supervised handoff returned by direct apply intake", async () => {
    api.createIntake.mockResolvedValue({ item: intakeItem({ status: "proposed" }) });
    api.confirmIntake.mockResolvedValue({
      item: intakeItem({
        status: "done",
        requestedAction: "prepare",
        result: {
          summary: "Evaluated Acme — SRE: Keep. Generated the application packet.",
          applicationId: "app-acme",
          artifacts: [
            { kind: "job_evaluation", evaluation: { gate: "keep", fitScore: 91 } },
            {
              kind: "packet_generation",
              status: "ready",
              uploadReady: true,
              gaps: [],
              blockingGapCount: 0,
            },
            {
              kind: "application_handoff",
              url: "https://boards.greenhouse.io/acme/jobs/123",
            },
          ],
          nextActions: [],
        },
      }),
    });
    let tree = await commitLongPaste();
    buttonByText(tree, "Confirm").props.onClick();
    await flushMicrotasks();
    tree = render();

    expect(textOf(byClass(tree, "ask-bar__packet-status"))).toContain("Application packet: ready");
    const handoff = visit(
      tree,
      (node) => node.type === "a" && textOf(node) === "Open application site"
    )[0];
    expect(handoff.props.href).toBe("https://boards.greenhouse.io/acme/jobs/123");
  });

  it("Reclassify and Dismiss are offered (not Confirm) for a needs_you item, and hit their APIs", async () => {
    api.createIntake.mockResolvedValue({ item: intakeItem({ status: "needs_you" }) });
    api.reclassifyIntake.mockResolvedValue({ item: intakeItem({ status: "proposed" }) });
    api.dismissIntake.mockResolvedValue({ item: intakeItem({ status: "dismissed" }) });
    let tree = await commitLongPaste();

    expect(buttonByText(tree, "Confirm")).toBeFalsy();
    const reclassify = buttonByText(tree, "Reclassify");
    reclassify.props.onClick();
    await flushMicrotasks();
    expect(api.reclassifyIntake).toHaveBeenCalledWith("intake-1");

    tree = render();
    const dismiss = buttonByText(tree, "Dismiss");
    dismiss.props.onClick();
    await flushMicrotasks();
    expect(api.dismissIntake).toHaveBeenCalledWith("intake-1");
  });

  it("a Confirm failure renders a friendly one-line message, never the raw server string", async () => {
    api.createIntake.mockResolvedValue({ item: intakeItem({ status: "proposed" }) });
    // 422 deliberately isn't one of resolveErrorCopy's mapped statuses (401/
    // 403/404/5xx all have their own rule-provided message) — this exercises
    // the true generic bucket, where describeDecideError's own "Confirm
    // failed" fallback (not resolveErrorCopy's GENERIC_ERROR_MESSAGE) applies.
    api.confirmIntake.mockRejectedValue(new api.ApiError(422, { error: "boom" }));
    let tree = await commitLongPaste();

    const confirm = buttonByText(tree, "Confirm");
    confirm.props.onClick();
    await flushMicrotasks();
    tree = render();

    // describeDecideError() routes through resolveErrorCopy() — the raw
    // server string ("boom") must never render as the primary message, and
    // this receipt's error slot is a plain one-line <p>, so there is no
    // action/detail to check either.
    const errorLine = byClass(tree, "ask-bar__error");
    expect(textOf(errorLine)).toBe("Confirm failed");
    expect(textOf(errorLine)).not.toContain("boom");
  });

  it("a capture error is shown inline and does not clobber the previous turn silently", async () => {
    api.createIntake.mockRejectedValue(new api.ApiError(500, { error: "boom" }));
    const tree = await commitLongPaste();

    // The raw server string ("boom") must never render as the primary
    // message — resolveErrorCopy() maps an unmapped 500 to human copy.
    expect(textOf(byClass(tree, "ask-bar__error"))).toBe(
      "Something went wrong on the server. Try again in a moment."
    );
  });
});

describe("AskBar — Lane B: NEEDS-YOU chip", () => {
  it("shows the pending needs_you count and stays hidden at zero", async () => {
    let tree = render();
    runPendingEffects();
    await flushMicrotasks();
    tree = render();
    expect(byClass(tree, "ask-bar__needs-chip")).toBeFalsy();
  });

  it("expands into the same decide actions when there is a pending count", async () => {
    api.listIntake.mockResolvedValue({
      items: [intakeItem({ id: "n1", status: "needs_you", kind: "recruiter-email" })],
    });
    api.dismissIntake.mockResolvedValue({ item: intakeItem({ id: "n1", status: "dismissed" }) });

    let tree = render();
    runPendingEffects();
    await flushMicrotasks();
    tree = render();

    const chip = byClass(tree, "ask-bar__needs-chip");
    expect(textOf(chip)).toContain("1");
    expect(byClass(tree, "ask-bar__needs-list")).toBeFalsy();

    chip.props.onClick();
    tree = render();
    const list = byClass(tree, "ask-bar__needs-list");
    expect(list).toBeTruthy();
    expect(textOf(list)).toContain("Recruiter email");

    const dismiss = buttonByText(tree, "Dismiss");
    dismiss.props.onClick();
    await flushMicrotasks();
    expect(api.dismissIntake).toHaveBeenCalledWith("n1");
  });
});
