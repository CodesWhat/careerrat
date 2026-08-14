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
  removeDeepIngestSource: vi.fn(),
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

vi.mock("react-router-dom", () => ({
  Link: ({ children, to, ...props }) => (
    <a href={to} {...props}>
      {children}
    </a>
  ),
}));

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
  const capture = (Component) => (props) => {
    captured.fields.push(props);
    return Component(props);
  };
  return {
    ...actual,
    TextArea: capture(actual.TextArea),
    TextField: capture(actual.TextField),
  };
});

import { DeepIngestPage } from "./DeepIngestPage.jsx";

const LANE_KEYS = [
  "evidence_claims",
  "story_bank",
  "honesty_boundaries",
  "writing_voice",
  "role_signals",
];

function proposalRow({
  id,
  lane,
  sourceId = "deep_src_material",
  status = "review_needed",
  version = 1,
  title,
  summary,
  supportingQuote = "Quoted source material.",
  payload = {},
  proposalStatus = "draft",
  validationStatus = "valid",
  reason,
}) {
  return {
    id,
    lane,
    sourceId,
    status,
    version,
    ...(reason ? { reason } : {}),
    proposal: {
      status: proposalStatus,
      payload: {
        ...(title ? { title } : {}),
        ...(summary ? { summary } : {}),
        ...payload,
      },
      supportingQuote,
      validation: { status: validationStatus },
    },
  };
}

function deepIngestState(overrides = {}) {
  return {
    lanes: LANE_KEYS.map((key) => ({ key, status: "review_needed" })),
    sources: [
      {
        id: "deep_src_material",
        sourceKind: "paste",
        targetShape: "auto",
        status: "proposal_ready",
        textPreview: "Led a billing migration with measurable results.",
      },
    ],
    proposals: [
      proposalRow({
        id: "deep_prop_evidence",
        lane: "evidence_claims",
        title: "Billing migration",
        summary: "Led a billing migration with measurable results.",
      }),
    ],
    confirmed: {
      evidence: [],
      storyBank: [],
      honestyBoundaries: [],
      writingVoice: [],
      roleSignals: [],
    },
    openGaps: [],
    ...overrides,
  };
}

function childText(value) {
  if (Array.isArray(value)) return value.map(childText).join("");
  if (typeof value === "string" || typeof value === "number") return String(value);
  if (!value || typeof value !== "object") return "";
  return childText(value.props?.children);
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

function renderPage(state = apiMock.state || deepIngestState()) {
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

function capturedButton(label) {
  const button = captured.buttons.find((props) => childText(props.children) === label);
  expect(button).toBeDefined();
  return button;
}

function capturedField(label) {
  const field = captured.fields.find((props) => props["aria-label"] === label);
  expect(field).toBeDefined();
  return field;
}

function capturedNativeButton(label, classNamePart = null) {
  const button = captured.nativeButtons.find(
    (props) =>
      childText(props.children).includes(label) &&
      (!classNamePart || String(props.className || "").includes(classNamePart))
  );
  expect(button).toBeDefined();
  return button;
}

function capturedNavButton(label) {
  const button = captured.nativeButtons.find((props) => props["aria-label"] === label);
  expect(button).toBeDefined();
  return button;
}

function selectStep(label, state) {
  renderPage(state);
  capturedNativeButton(label, "onboarding-progress__case").onClick();
  return renderPage(state);
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
  apiMock.removeDeepIngestSource.mockResolvedValue({ ok: true });
  apiMock.submitDeepIngestSource.mockResolvedValue({ ok: true });
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

describe("DeepIngestPage wizard", () => {
  it("renders the seven-step rail with exactly one step card", () => {
    const html = renderPage();

    for (const label of [
      "Material",
      "Evidence",
      "Stories",
      "Honesty",
      "Voice",
      "Role signals",
      "Done",
    ]) {
      expect(html).toContain(`>${label}</span>`);
    }
    expect(html.match(/class="deep-wizard__step-card"/g)).toHaveLength(1);
    expect(html).toContain("Feed the machine");
    expect(html).toContain(
      'class="onboarding-progress__case onboarding-progress__case--clickable onboarding-progress__case--filled onboarding-progress__case--active"'
    );
  });

  it("renders human source labels and statuses without leaking enums or database ids", () => {
    const state = deepIngestState({
      sources: [
        {
          id: "deep_src_scanning",
          sourceKind: "paste",
          status: "scanning",
          textPreview: "Led the billing migration and cut cycle time substantially.",
        },
        {
          id: "deep_src_link",
          sourceKind: "url",
          status: "proposal_ready",
          metadata: { url: "https://www.example.com/profile/person" },
        },
        {
          id: "deep_src_file",
          sourceKind: "file",
          label: "Resume.pdf",
          status: "manual_fallback",
        },
        {
          id: "deep_src_skipped",
          sourceKind: "paste",
          status: "deferred",
          textPreview: "Older notes",
        },
      ],
      proposals: [
        proposalRow({
          id: "deep_prop_ready",
          sourceId: "deep_src_link",
          lane: "evidence_claims",
          title: "Private draft title",
          summary: "Private draft summary.",
        }),
      ],
    });

    const html = renderPage(state);

    expect(html).toContain("Pasted notes: Led the billing migration and cut");
    expect(html).toContain("example.com");
    expect(html).toContain("Resume.pdf");
    expect(html).toContain("Reading…");
    expect(html).toContain("Drafts ready");
    expect(html).toContain("Couldn&#x27;t draft, needs a look");
    expect(html).toContain("Skipped");
    for (const rawValue of [
      "deep_src_",
      "deep_prop_",
      "proposal_ready",
      "manual_fallback",
      "source_scanned",
    ]) {
      expect(html).not.toContain(rawValue);
    }
  });

  it("shows only the current lane's reviewable drafts", () => {
    const state = deepIngestState({
      proposals: [
        proposalRow({
          id: "deep_prop_real_evidence",
          lane: "evidence_claims",
          title: "Reviewable evidence",
          summary: "Evidence summary.",
        }),
        proposalRow({
          id: "deep_prop_blocked",
          lane: "evidence_claims",
          title: "Blocked evidence must stay hidden",
          summary: "Unsupported draft.",
          validationStatus: "blocked",
        }),
        proposalRow({
          id: "deep_prop_story",
          lane: "story_bank",
          title: "Story lane only",
          summary: "Story summary.",
        }),
        proposalRow({
          id: "deep_prop_scan_stub",
          lane: "open_gaps",
          title: "Source scanned and ready for review",
          validationStatus: "source_scanned",
        }),
      ],
    });

    const html = selectStep("Evidence", state);

    expect(html).toContain("Reviewable evidence");
    expect(html).toContain("0 of 1 reviewed");
    expect(html).not.toContain("Blocked evidence must stay hidden");
    expect(html).not.toContain("Story lane only");
    expect(html).not.toContain("Source scanned and ready for review");
    expect(html.match(/deep-wizard__proposal-card/g)).toHaveLength(1);
  });

  it("keeps empty lanes skippable with an enabled Continue button", () => {
    const state = deepIngestState({ proposals: [] });

    const html = selectStep("Honesty", state);

    expect(html).toContain(
      "No honesty drafts from your material yet. Add more in Material, or move on."
    );
    expect(capturedNavButton("Continue").disabled).toBe(false);
  });

  it("does not claim an empty deep dive is complete when the user leaves without material", () => {
    const state = deepIngestState({
      sources: [],
      proposals: [],
      lanes: LANE_KEYS.map((key) => ({ key, status: "not_started" })),
      readiness: {
        ready: false,
        terminalCount: 0,
        requiredCount: 7,
        progressText: "0 of 7 lanes terminal",
      },
    });
    renderPage(state);

    capturedNavButton("Continue").onClick();
    const html = renderPage(state);

    expect(html).toContain("Deep dive paused");
    expect(html).toContain("0 of 7 lanes finished. Deep ingest is still incomplete.");
    expect(html).not.toContain("Confirmed material now feeds every");
    expect(html).not.toContain(
      'class="onboarding-progress__case onboarding-progress__case--clickable onboarding-progress__case--filled" aria-label="Go to Material"'
    );
  });

  it("records source coverage before leaving Material with drafted sources", async () => {
    const state = deepIngestState({
      lanes: [
        { key: "source_coverage", status: "review_needed" },
        ...LANE_KEYS.map((key) => ({ key, status: "review_needed" })),
        { key: "open_gaps", status: "not_started" },
      ],
    });
    renderPage(state);

    await capturedNavButton("Continue").onClick();

    expect(apiMock.updateDeepIngestLaneState).toHaveBeenCalledWith({
      lane: "source_coverage",
      status: "completed",
    });
    expect(renderPage(state)).toContain('class="deep-wizard__step-label">Step 2');
  });

  it("treats a grounded open-gap result as drafted instead of offering an endless redraft loop", () => {
    const state = deepIngestState({
      proposals: [
        proposalRow({
          id: "deep_prop_gap_only",
          lane: "open_gaps",
          proposalStatus: "gap",
          payload: { reason: "Add a quantified leadership outcome." },
        }),
      ],
    });

    const html = renderPage(state);

    expect(html).toContain("Drafts ready");
    expect(capturedButton("Draft proposals").disabled).toBe(true);
    expect(capturedNavButton("Continue").disabled).toBe(false);
  });

  it("offers a real finalization write for the two readiness lanes outside the review steps", async () => {
    const state = deepIngestState({
      lanes: [
        { key: "source_coverage", status: "not_started" },
        ...LANE_KEYS.map((key) => ({ key, status: "completed" })),
        { key: "open_gaps", status: "not_started" },
      ],
      readiness: { ready: false, terminalCount: 5, requiredCount: 7 },
    });
    const html = selectStep("Done", state);

    expect(html).toContain("Finish deep ingest");
    await capturedButton("Finish deep ingest").onClick();

    expect(apiMock.updateDeepIngestLaneState).toHaveBeenNthCalledWith(1, {
      lane: "source_coverage",
      status: "completed",
    });
    expect(apiMock.updateDeepIngestLaneState).toHaveBeenNthCalledWith(2, {
      lane: "open_gaps",
      status: "completed",
    });
  });

  it("keeps confirmed open gaps visible as a deferred terminal decision", async () => {
    const state = deepIngestState({
      lanes: [
        { key: "source_coverage", status: "completed" },
        ...LANE_KEYS.map((key) => ({ key, status: "completed" })),
        { key: "open_gaps", status: "gap" },
      ],
      readiness: { ready: false, terminalCount: 6, requiredCount: 7 },
      openGaps: [
        proposalRow({
          id: "deep_prop_gap_finish",
          lane: "open_gaps",
          proposalStatus: "gap",
          payload: { reason: "Add a quantified leadership outcome." },
        }),
      ],
    });
    const html = selectStep("Done", state);

    expect(html).toContain("Finish with these gaps");
    await capturedButton("Finish with these gaps").onClick();

    expect(apiMock.updateDeepIngestLaneState).toHaveBeenCalledWith({
      lane: "open_gaps",
      status: "deferred",
      reason: "Keeping these open gaps to revisit later.",
    });
  });

  it.each([
    { action: "Confirm", decision: "confirm" },
    { action: "Discard", decision: "reject" },
  ])(
    "auto-advances after $action resolves the last pending lane proposal",
    async ({ action, decision }) => {
      const pending = proposalRow({
        id: "deep_prop_last",
        lane: "evidence_claims",
        title: "Last evidence draft",
        summary: "The only pending proposal.",
        version: 7,
      });
      const state = deepIngestState({ proposals: [pending] });
      selectStep("Evidence", state);
      apiMock.state = {
        ...state,
        proposals: [{ ...pending, status: decision === "confirm" ? "confirmed" : "rejected" }],
      };

      if (action === "Confirm") {
        await capturedButton("Confirm").onClick();
      } else {
        await capturedNativeButton("Discard", "deep-wizard__quiet-link").onClick();
      }
      const html = renderPage(apiMock.state);

      expect(apiMock.decideDeepIngestProposal).toHaveBeenCalledWith(
        expect.objectContaining({ proposalId: "deep_prop_last", decision })
      );
      expect(html).toContain('class="deep-wizard__step-label">Step 3');
      expect(html).toContain("Story bank");
    }
  );

  it("preserves structured AI payload fields when reviewer edits are confirmed", async () => {
    const boundary = proposalRow({
      id: "deep_prop_boundary",
      lane: "honesty_boundaries",
      sourceId: "deep_src_honesty",
      version: 4,
      title: "Generated boundary title",
      summary: "Do not overstate Rust experience.",
      supportingQuote: "Built services in TypeScript and Python.",
      payload: {
        boundaryType: "forbidden_claim",
        allowedWording: "Experienced with TypeScript and Python",
        forbiddenWording: "Rust expert",
      },
    });
    const state = deepIngestState({ proposals: [boundary] });
    selectStep("Honesty", state);

    capturedNativeButton("Generated boundary title", "deep-wizard__proposal-main").onClick();
    renderPage(state);
    capturedField("Title").onChange("Reviewer boundary title");
    capturedField("Summary").onChange("Reviewer-calibrated summary.");
    renderPage(state);
    await capturedButton("Confirm").onClick();

    expect(apiMock.decideDeepIngestProposal).toHaveBeenCalledWith({
      proposalId: "deep_prop_boundary",
      expectedVersion: 4,
      decision: "confirm",
      edits: {
        items: [
          {
            boundaryType: "forbidden_claim",
            allowedWording: "Experienced with TypeScript and Python",
            forbiddenWording: "Rust expert",
            sourceId: "deep_src_honesty",
            title: "Reviewer boundary title",
            summary: "Reviewer-calibrated summary.",
            supportingQuote: "Built services in TypeScript and Python.",
          },
        ],
      },
    });
  });

  it("ISSUE-013: honesty edits expose and replace the canonical enforcement semantics", async () => {
    const boundary = proposalRow({
      id: "deep_prop_boundary_semantics",
      lane: "honesty_boundaries",
      sourceId: "deep_src_honesty",
      version: 2,
      title: "Traffic attribution",
      summary: "Keep the event-volume metric with the employer.",
      supportingQuote: "The 31% cost reduction was shared work with FinOps.",
      payload: {
        boundaryType: "metric_attribution",
        text: "The event-volume metric belongs to Juniper Relay.",
        allowedWording: "Juniper Relay processed the events.",
        forbiddenWording: "Morgan processed the events.",
        reason: "Employer metric, not an individual metric.",
      },
    });
    const state = deepIngestState({ proposals: [boundary] });
    selectStep("Honesty", state);

    capturedNativeButton("Traffic attribution", "deep-wizard__proposal-main").onClick();
    renderPage(state);
    capturedField("Boundary type").onChange("shared_ownership");
    renderPage(state);
    expect(capturedField("Boundary type").value).toBe("shared_ownership");
    capturedField("Canonical boundary").onChange("Morgan co-led the cost reduction with FinOps.");
    renderPage(state);
    capturedField("Allowed wording").onChange("co-led with FinOps");
    renderPage(state);
    capturedField("Forbidden wording").onChange("single-handedly reduced costs");
    renderPage(state);
    capturedField("Enforcement reason").onChange("The source explicitly says shared work.");
    renderPage(state);
    expect(capturedField("Boundary type").value).toBe("shared_ownership");
    expect(capturedField("Canonical boundary").value).toBe(
      "Morgan co-led the cost reduction with FinOps."
    );
    expect(capturedField("Allowed wording").value).toBe("co-led with FinOps");
    expect(capturedField("Forbidden wording").value).toBe("single-handedly reduced costs");
    expect(capturedField("Enforcement reason").value).toBe(
      "The source explicitly says shared work."
    );
    await capturedButton("Confirm").onClick();

    const item = apiMock.decideDeepIngestProposal.mock.calls.at(-1)[0].edits.items[0];
    expect(item).toMatchObject({
      boundaryType: "shared_ownership",
      text: "Morgan co-led the cost reduction with FinOps.",
      allowedWording: "co-led with FinOps",
      forbiddenWording: "single-handedly reduced costs",
      reason: "The source explicitly says shared work.",
    });
    expect(item.text).not.toContain("event-volume");
  });

  it("ISSUE-015: unprocessed sources expose details and a real Remove action", async () => {
    const pendingSource = {
      id: "deep_src_pending",
      sourceKind: "url",
      targetShape: "auto",
      status: "proposal_ready",
      metadata: { url: "https://example.com" },
      textLength: 142,
    };
    const scanStub = proposalRow({
      id: "deep_prop_scan_stub",
      sourceId: pendingSource.id,
      lane: "open_gaps",
      validationStatus: "source_scanned",
    });
    const state = deepIngestState({ sources: [pendingSource], proposals: [scanStub] });

    const html = renderPage(state);
    expect(html).toContain("Details");
    expect(html).toContain("Remove source");
    await capturedNativeButton("Remove source", "deep-wizard__quiet-link").onClick();

    expect(apiMock.removeDeepIngestSource).toHaveBeenCalledWith({
      sourceId: "deep_src_pending",
    });
  });

  it("reports per-lane confirmed counts and only genuine gap rows on Done", () => {
    const state = deepIngestState({
      confirmed: {
        evidence: [{ id: "ev-1" }, { id: "ev-2" }],
        storyBank: [{ id: "story-1" }],
        honestyBoundaries: [],
        writingVoice: [{ id: "voice-1" }, { id: "voice-2" }, { id: "voice-3" }],
        roleSignals: [{ id: "signal-1" }, { id: "signal-2" }],
      },
      openGaps: [
        proposalRow({
          id: "deep_prop_gap",
          lane: "open_gaps",
          proposalStatus: "gap",
          payload: { reason: "Missing a quantified leadership outcome." },
        }),
        proposalRow({
          id: "deep_prop_provider_error",
          lane: "open_gaps",
          proposalStatus: "manual_fallback",
          payload: { reason: "Provider timed out while drafting." },
        }),
        proposalRow({
          id: "deep_prop_mechanical_stub",
          lane: "open_gaps",
          proposalStatus: "gap",
          validationStatus: "source_scanned",
          payload: { reason: "Mechanical scan stub." },
        }),
      ],
    });

    const html = selectStep("Done", state);

    expect(html).toContain("<strong>Evidence claims</strong>: 2 confirmed.");
    expect(html).toContain("<strong>Story bank</strong>: 1 confirmed.");
    expect(html).toContain("<strong>Honesty boundaries</strong>: 0 confirmed.");
    expect(html).toContain("<strong>Writing voice</strong>: 3 confirmed.");
    expect(html).toContain("<strong>Role signals</strong>: 2 confirmed.");
    expect(html).toContain("Still thin:");
    expect(html).toContain("Missing a quantified leadership outcome.");
    expect(html).not.toContain("Provider timed out while drafting.");
    expect(html).not.toContain("Mechanical scan stub.");
    expect(html).toContain('<a href="/" class="btn btn--primary">Back to Dashboard</a>');
  });

  it("ISSUE-015: Done reports sources that still need drafts and links back to Material", () => {
    const pendingSource = {
      id: "deep_src_pending",
      sourceKind: "url",
      targetShape: "auto",
      status: "proposal_ready",
      metadata: { url: "https://example.com" },
    };
    const scanStub = proposalRow({
      id: "deep_prop_scan_stub",
      sourceId: pendingSource.id,
      lane: "open_gaps",
      validationStatus: "source_scanned",
    });
    const state = deepIngestState({ sources: [pendingSource], proposals: [scanStub] });

    const html = selectStep("Done", state);

    expect(html).toContain("1 source still needs review");
    expect(html).toContain("Draft or remove it in Material");
    expect(html).toContain("Review material");
  });
});
