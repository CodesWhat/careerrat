import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const hookHarness = vi.hoisted(() => ({
  cursor: 0,
  states: [],
  refs: [],
  reset() {
    this.cursor = 0;
  },
  clear() {
    this.cursor = 0;
    this.states = [];
    this.refs = [];
  },
}));

const apiMock = vi.hoisted(() => ({
  state: null,
  buildDeepIngestProposals: vi.fn(),
  decideDeepIngestProposal: vi.fn(),
  getDeepIngestState: vi.fn(),
  submitDeepIngestSource: vi.fn(),
  updateDeepIngestLaneState: vi.fn(),
  uploadDeepIngestFile: vi.fn(),
}));
const captured = vi.hoisted(() => ({ buttons: [], fields: [], nativeButtons: [] }));

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    useEffect() {},
    useRef(initialValue) {
      const index = hookHarness.cursor++;
      if (!hookHarness.refs[index]) hookHarness.refs[index] = { current: initialValue };
      return hookHarness.refs[index];
    },
    useState(initialValue) {
      const index = hookHarness.cursor++;
      if (!(index in hookHarness.states)) {
        hookHarness.states[index] =
          typeof initialValue === "function" ? initialValue() : initialValue;
      }
      const setValue = (nextValue) => {
        hookHarness.states[index] =
          typeof nextValue === "function" ? nextValue(hookHarness.states[index]) : nextValue;
      };
      return [hookHarness.states[index], setValue];
    },
  };
});

vi.mock("../lib/api.js", () => apiMock);

vi.mock("../components/Button.jsx", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    Button: (props) => {
      captured.buttons.push(props);
      return actual.Button(props);
    },
  };
});

vi.mock("../components/form.jsx", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    TextArea: (props) => {
      captured.fields.push(props);
      return actual.TextArea(props);
    },
    TextField: (props) => {
      captured.fields.push(props);
      return actual.TextField(props);
    },
  };
});

import { DeepIngestPage } from "./DeepIngestPage.jsx";

const FORBIDDEN_DEEP_INGEST_TEXT = [
  "AI interview",
  "guided interview",
  "full interview",
  "interview transcript",
  "/api/chat",
  "POST /api/skill/run",
  "/api/skill/run",
];

function deepIngestState(overrides = {}) {
  return {
    lanes: [
      { key: "source_coverage", label: "Source coverage", status: "completed" },
      { key: "evidence_claims", label: "Evidence", status: "review_needed" },
      { key: "story_bank", label: "Story", status: "gap" },
      { key: "honesty_boundaries", label: "Honesty", status: "completed" },
      {
        key: "writing_voice",
        label: "Writing voice",
        status: "deferred",
        reason: "No samples yet",
      },
      { key: "role_signals", label: "Role signal", status: "needs_source" },
      { key: "open_gaps", label: "Open gaps", status: "not_available", reason: "No gaps known" },
    ],
    readiness: {
      ready: false,
      terminalCount: 4,
      requiredCount: 7,
      missing: ["Evidence needs review", "Role signal needs source"],
    },
    sources: [
      {
        id: "src-1",
        title: "Portfolio paste",
        kind: "paste",
        targetShape: "evidence",
        status: "proposal_ready",
        preview: "Built incident automation and led billing migration.",
      },
      {
        id: "src-2",
        title: "Private repo",
        kind: "url",
        targetShape: "story",
        status: "manual_fallback",
        preview: "Private or login-gated source. Enter manually or defer this lane.",
      },
    ],
    proposals: [
      {
        id: "proposal-1",
        lane: "evidence",
        sourceId: "src-1",
        status: "review_needed",
        title: "Incident automation",
        summary: "Cut triage time from 45 minutes to 8.",
        supportingQuote: "cut manual triage from 45 minutes to 8",
      },
      {
        id: "proposal-2",
        lane: "story",
        sourceId: "src-2",
        status: "blocked",
        title: "Manual fallback needed",
        summary: "Login-gated source needs a manual note.",
      },
    ],
    selectedSourceId: "src-1",
    selectedProposalId: "proposal-1",
    ...overrides,
  };
}

function renderPage(state = deepIngestState()) {
  apiMock.state = state;
  hookHarness.reset();
  captured.buttons = [];
  captured.fields = [];
  captured.nativeButtons = [];
  const tree = DeepIngestPage({ initialState: state });
  const html = renderToStaticMarkup(tree);
  const renderedButtons = captured.buttons;
  const renderedFields = captured.fields;
  captureNativeButtons(tree);
  captured.buttons = renderedButtons;
  captured.fields = renderedFields;
  return html;
}

function captureNativeButtons(node) {
  if (Array.isArray(node)) {
    for (const child of node) captureNativeButtons(child);
    return;
  }
  if (!node || typeof node !== "object") return;
  if (typeof node.type === "function") {
    captureNativeButtons(node.type(node.props));
    return;
  }
  if (node.type === "button") captured.nativeButtons.push(node.props);
  captureNativeButtons(node.props?.children);
}

function capturedButton(label) {
  const button = captured.buttons.find((props) => props.children === label);
  expect(button).toBeDefined();
  return button;
}

function capturedField(label) {
  const field = captured.fields.find((props) => props["aria-label"] === label);
  expect(field).toBeDefined();
  return field;
}

function childText(value) {
  if (Array.isArray(value)) return value.map(childText).join("");
  if (typeof value === "string" || typeof value === "number") return String(value);
  if (!value || typeof value !== "object") return "";
  return childText(value.props?.children);
}

function capturedNativeButton(label, className = null) {
  const button = captured.nativeButtons.find(
    (props) =>
      childText(props.children).includes(label) && (!className || props.className === className)
  );
  expect(button).toBeDefined();
  return button;
}

function expectNoDeepIngestRuntimeTokens(html) {
  for (const token of FORBIDDEN_DEEP_INGEST_TEXT) {
    expect(html, `Deep ingest UI leaked ${token}`).not.toContain(token);
  }
}

beforeEach(() => {
  hookHarness.clear();
  apiMock.state = null;
  captured.buttons = [];
  captured.fields = [];
  captured.nativeButtons = [];
  vi.clearAllMocks();
  apiMock.buildDeepIngestProposals.mockResolvedValue({ ok: true });
  apiMock.decideDeepIngestProposal.mockResolvedValue({ ok: true });
  apiMock.getDeepIngestState.mockImplementation(async () => apiMock.state);
  apiMock.submitDeepIngestSource.mockResolvedValue({
    ok: true,
    status: "proposal_ready",
    proposals: [],
  });
  apiMock.updateDeepIngestLaneState.mockResolvedValue({ ok: true });
  apiMock.uploadDeepIngestFile.mockResolvedValue({ ok: true });
});

describe("DeepIngestPage route contract", () => {
  it("registers /deep-ingest in the app route map", () => {
    const source = readFileSync(new URL("../App.jsx", import.meta.url), "utf8");

    expect(source).toContain('path="/deep-ingest"');
    expect(source).toContain("DeepIngestPage");
  });
});

describe("DeepIngestPage workbench", () => {
  it("renders the target selector, empty-state copy, and disabled ingest action until input is valid", async () => {
    const html = await renderPage(
      deepIngestState({
        sources: [],
        proposals: [],
        selectedSourceId: null,
        selectedProposalId: null,
      })
    );

    expect(html).toContain("No deep ingest sources yet");
    expect(html).toContain(
      "Paste, drop, or link profile material to create reviewable proposals for evidence, stories, honesty, voice, and role signals."
    );
    for (const label of [
      "Auto",
      "Evidence",
      "Story",
      "Writing voice",
      "Honesty",
      "Role signal",
      "Paste",
      "Link",
    ]) {
      expect(html).toContain(label);
    }
    expect(html).toMatch(/<button[^>]*disabled[^>]*>Ingest source<\/button>/);
    expectNoDeepIngestRuntimeTokens(html);
  });

  it("renders lane progress, review filters, source preview, and editable proposal actions", async () => {
    const html = await renderPage();

    expect(html).toContain("4 of 7 lanes terminal");
    expect(html).toContain("Source preview");
    expect(html).toContain("Portfolio paste");
    expect(html).toContain("Review queue");
    expect(html).toContain("All");
    expect(html).toContain("Needs review");
    expect(html).toContain("Blocked");
    expect(html).toContain("Confirmed");
    expect(html).toContain("Proposal editor");
    expect(html).toContain("Save edits");
    expect(html).toContain("Confirm proposal");
    expect(html).toContain("Review proposals");
    expectNoDeepIngestRuntimeTokens(html);
  });

  it("renders proposal payload primitives as read-only chips", () => {
    const state = deepIngestState();
    state.proposals[0].payload = {
      metric: "37% faster",
      source: "portfolio",
      nested: { hidden: true },
    };

    const html = renderPage(state);

    expect(html).toContain('<span class="field__label">metric:</span> 37% faster');
    expect(html).toContain('<span class="field__label">source:</span> portfolio');
    expect(html).not.toContain("nested:");
    expect(html).not.toContain('value="37% faster"');
  });

  it("shows the destination line only while a proposal is open", () => {
    const state = deepIngestState();
    const openHtml = renderPage(state);
    expect(openHtml).toContain("Will: save to your Evidence");

    state.proposals[0] = { ...state.proposals[0], status: "confirmed" };
    const confirmedHtml = renderPage(state);

    expect(confirmedHtml).not.toContain("Will: save to your");
  });

  it("reopens a confirmed proposal through the decision wrapper", async () => {
    const state = deepIngestState();
    state.proposals[0] = { ...state.proposals[0], status: "confirmed", version: 4 };
    renderPage(state);

    await capturedButton("Reopen").onClick();

    expect(apiMock.decideDeepIngestProposal).toHaveBeenCalledWith({
      proposalId: "proposal-1",
      expectedVersion: 4,
      decision: "reopen",
    });
  });

  it.each([
    ["Defer lane", "deferred"],
    ["Mark not available", "not_available"],
  ])("reveals preset reasons for %s and requires a non-empty reason", async (action, status) => {
    const state = deepIngestState();
    renderPage(state);

    capturedButton(action).onClick();
    let html = renderPage(state);

    expect(html).toContain("Not relevant to me");
    expect(html).toContain("Don&#x27;t have this yet");
    expect(html).toContain("I&#x27;ll do it later");
    expect(capturedButton(action).disabled).toBe(true);

    capturedNativeButton("I'll do it later").onClick();
    html = renderPage(state);
    expect(html).toContain("Skipping is fine");
    expect(capturedButton(action).disabled).toBe(false);
    await capturedButton(action).onClick();

    expect(apiMock.updateDeepIngestLaneState).toHaveBeenCalledWith({
      lane: "evidence_claims",
      status,
      reason: "I'll do it later",
    });
  });

  it("filters the proposal queue from a lane row and restores all lanes", () => {
    const state = deepIngestState({
      proposals: [
        {
          id: "proposal-evidence",
          lane: "evidence_claims",
          sourceId: "src-1",
          status: "review_needed",
          title: "Evidence-only proposal",
        },
        {
          id: "proposal-story",
          lane: "story_bank",
          sourceId: "src-2",
          status: "review_needed",
          title: "Story-only proposal",
        },
      ],
      selectedProposalId: "proposal-evidence",
    });
    renderPage(state);

    capturedNativeButton("Story", "deep-ingest__lane-main").onClick();
    let html = renderPage(state);
    let queueHtml = html.match(
      /aria-label="Review queue"[\s\S]*?aria-label="Proposal editor"/
    )?.[0];

    expect(html).toContain("Filtered to Story");
    expect(queueHtml).toContain("Story-only proposal");
    expect(queueHtml).not.toContain("Evidence-only proposal");

    capturedNativeButton("Show all lanes", "deep-ingest__clear-lane-filter").onClick();
    html = renderPage(state);
    queueHtml = html.match(/aria-label="Review queue"[\s\S]*?aria-label="Proposal editor"/)?.[0];
    expect(queueHtml).toContain("Story-only proposal");
    expect(queueHtml).toContain("Evidence-only proposal");
    expect(html).not.toContain("Filtered to Story");
  });

  it("marks non-terminal evidence as the starting lane and renders honest payoff copy", () => {
    const state = deepIngestState();
    const html = renderPage(state);

    expect(html).toContain("Start here");
    expect(html).toContain(
      "Powers every tailored résumé, cover letter, and answer you generate from here on."
    );
    expect(html).toContain(
      "Saved to your Library as reference material you can browse and copy from."
    );

    state.lanes = state.lanes.map((lane) =>
      lane.key === "evidence_claims" ? { ...lane, status: "completed" } : lane
    );
    expect(renderPage(state)).not.toContain("Start here");
  });

  it("shows explicit manual fallback and terminal lane actions for unreadable, deferred, and unavailable sources", async () => {
    const html = await renderPage();

    expect(html).toContain("manual_fallback");
    expect(html).toContain("Enter manually");
    expect(html).toContain("Retry ingest");
    expect(html).toContain("Defer lane");
    expect(html).toContain("Mark not available");
    expectNoDeepIngestRuntimeTokens(html);
  });

  it("saves proposal edits through edits.items[] and falls back to untouched proposal fields", async () => {
    const state = deepIngestState();
    renderPage(state);

    capturedField("Proposal title").onChange("Edited incident automation");
    renderPage(state);
    await capturedButton("Save edits").onClick();

    expect(apiMock.decideDeepIngestProposal).toHaveBeenCalledWith({
      proposalId: "proposal-1",
      expectedVersion: undefined,
      decision: "save_edits",
      edits: {
        items: [
          {
            sourceId: "src-1",
            title: "Edited incident automation",
            summary: "Cut triage time from 45 minutes to 8.",
            supportingQuote: "cut manual triage from 45 minutes to 8",
          },
        ],
      },
    });
  });

  it("confirms proposals through edits.items[] with proposal values for untouched fields", async () => {
    const state = deepIngestState();
    renderPage(state);

    capturedField("Proposal summary").onChange("Edited measurable outcome.");
    renderPage(state);
    await capturedButton("Confirm proposal").onClick();

    expect(apiMock.decideDeepIngestProposal).toHaveBeenCalledWith({
      proposalId: "proposal-1",
      expectedVersion: undefined,
      decision: "confirm",
      edits: {
        items: [
          {
            sourceId: "src-1",
            title: "Incident automation",
            summary: "Edited measurable outcome.",
            supportingQuote: "cut manual triage from 45 minutes to 8",
          },
        ],
      },
    });
  });

  it("generates proposals for proposal-ready sources and refreshes server state", async () => {
    const state = deepIngestState();
    const html = renderPage(state);

    expect(html).toContain("Generate proposals");
    await capturedButton("Generate proposals").onClick();

    expect(apiMock.buildDeepIngestProposals).toHaveBeenCalledWith({
      sourceId: "src-1",
      targetShape: "evidence",
    });
    expect(apiMock.getDeepIngestState).toHaveBeenCalledTimes(1);
  });

  it("renders an inline error when proposal generation fails", async () => {
    const state = deepIngestState();
    apiMock.buildDeepIngestProposals.mockRejectedValueOnce(new Error("Proposal builder offline"));
    renderPage(state);

    await capturedButton("Generate proposals").onClick();
    const html = renderPage(state);

    expect(html).toContain("Proposal builder offline");
    expect(apiMock.getDeepIngestState).not.toHaveBeenCalled();
  });
});
