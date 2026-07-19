import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const hookHarness = vi.hoisted(() => ({
  cursor: 0,
  effectDeps: [],
  params: new URLSearchParams(),
  pendingEffects: [],
  states: [],
  reset() {
    this.cursor = 0;
    this.pendingEffects = [];
  },
  clear() {
    this.cursor = 0;
    this.effectDeps = [];
    this.params = new URLSearchParams();
    this.pendingEffects = [];
    this.states = [];
  },
}));

const dashboardContext = vi.hoisted(() => ({
  useDashboardSnapshot: vi.fn(),
}));

const apiMocks = vi.hoisted(() => ({
  getDeepIngestState: vi.fn(),
  removeDeepIngestConfirmedItem: vi.fn(),
  removeEvidenceClaim: vi.fn(),
  saveCandidateFile: vi.fn(),
  updateDeepIngestConfirmedItem: vi.fn(),
}));

const dashboardEvents = vi.hoisted(() => ({
  emitDashboardChanged: vi.fn(),
}));

const captured = vi.hoisted(() => ({ buttons: [], fields: [] }));

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    useEffect(effect, dependencies) {
      const index = hookHarness.cursor++;
      const previous = hookHarness.effectDeps[index];
      const changed =
        !previous ||
        !dependencies ||
        dependencies.length !== previous.length ||
        dependencies.some((value, dependencyIndex) => !Object.is(value, previous[dependencyIndex]));
      hookHarness.effectDeps[index] = dependencies;
      if (changed) hookHarness.pendingEffects.push(effect);
    },
    useMemo(factory) {
      hookHarness.cursor += 1;
      return factory();
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

vi.mock("react-router-dom", () => ({
  Link: ({ children, to, ...props }) => (
    <a href={to} {...props}>
      {children}
    </a>
  ),
  useSearchParams: () => [
    hookHarness.params,
    (next) => {
      hookHarness.params =
        typeof next === "function" ? next(hookHarness.params) : new URLSearchParams(next);
    },
  ],
}));

vi.mock("../app-shell/DashboardContext.jsx", () => dashboardContext);
vi.mock("../lib/api.js", () => apiMocks);
vi.mock("../lib/dashboard-events.js", () => dashboardEvents);
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
    ChipInput: capture(actual.ChipInput),
    TextArea: capture(actual.TextArea),
    TextField: capture(actual.TextField),
  };
});
vi.mock("./libraryPreviewData.js", () => ({
  PREVIEW_DOCUMENTS: [],
  PREVIEW_LIBRARY: { cards: [], metrics: {}, preview: false },
}));

import { LibraryPage } from "./LibraryPage.jsx";

function renderLibrary() {
  hookHarness.reset();
  captured.buttons = [];
  captured.fields = [];
  return renderToStaticMarkup(LibraryPage());
}

function capturedButton(label) {
  const button = captured.buttons.find((props) => props.children === label);
  expect(button).toBeDefined();
  return button;
}

function capturedField(id) {
  const field = captured.fields.find((props) => props.id === id);
  expect(field).toBeDefined();
  return field;
}

function showCard(card, openId = card.id) {
  hookHarness.params = new URLSearchParams({ open: openId });
  dashboardContext.useDashboardSnapshot.mockReturnValue({
    data: { library: { cards: [card], metrics: {} }, jobs: { rows: [] } },
    loading: false,
    error: null,
    noDatabase: false,
    refetch: dashboardContext.refetch,
  });
}

async function flushEffects() {
  const effects = hookHarness.pendingEffects.splice(0);
  for (const effect of effects) effect();
  for (let turn = 0; turn < 5; turn += 1) await Promise.resolve();
}

beforeEach(() => {
  hookHarness.clear();
  captured.buttons = [];
  captured.fields = [];
  vi.clearAllMocks();
  dashboardContext.refetch = vi.fn().mockResolvedValue(undefined);
  dashboardContext.useDashboardSnapshot.mockReturnValue({
    data: { library: { cards: [] }, jobs: { rows: [] } },
    loading: false,
    error: null,
    noDatabase: false,
    refetch: dashboardContext.refetch,
  });
  apiMocks.getDeepIngestState.mockResolvedValue({ readiness: { ready: true } });
  apiMocks.removeDeepIngestConfirmedItem.mockResolvedValue({ ok: true });
  apiMocks.removeEvidenceClaim.mockResolvedValue({ ok: true });
  apiMocks.saveCandidateFile.mockResolvedValue({ ok: true });
  apiMocks.updateDeepIngestConfirmedItem.mockResolvedValue({ ok: true });
});

describe("LibraryPage", () => {
  it("renders real onboarding and deep-ingest links in the empty state", () => {
    const html = renderLibrary();

    expect(html).toContain("No reusable material yet");
    expect(html).toContain('<a href="/onboarding">onboarding</a>');
    expect(html).toContain('<a href="/deep-ingest">deep ingest</a>');
  });

  it("links to an incomplete deep dive with terminal and required counts", async () => {
    apiMocks.getDeepIngestState.mockResolvedValue({
      readiness: { ready: false, terminalCount: 3, requiredCount: 7 },
    });
    renderLibrary();
    await flushEffects();

    const html = renderLibrary();

    expect(html).toContain('href="/deep-ingest"');
    expect(html).toContain("Continue deep dive (3/7)");
  });

  it("omits the deep-dive hero link when readiness is complete", async () => {
    apiMocks.getDeepIngestState.mockResolvedValue({
      readiness: { ready: true, terminalCount: 7, requiredCount: 7 },
    });
    renderLibrary();
    await flushEffects();

    expect(renderLibrary()).not.toContain("Continue deep dive");
  });

  it("silently omits the deep-dive hero link when readiness loading fails", async () => {
    apiMocks.getDeepIngestState.mockRejectedValue(new Error("Deep ingest unavailable"));
    renderLibrary();
    await flushEffects();

    const html = renderLibrary();

    expect(html).not.toContain("Continue deep dive");
    expect(html).not.toContain("Deep ingest unavailable");
  });

  it("spreads evidence edits over the full raw claim before saving", () => {
    showCard({
      id: "evidence-001",
      kind: "evidence",
      label: "Evidence bank",
      title: "Built intake automation",
      summary: "Reusable evidence",
      note: "Source-grounded claim",
      tags: [],
      metadata: {
        claim: "Built intake automation.",
        evidence: "Project notes",
        metrics: ["30% faster"],
        links: [],
        allowed_wording: ["Built intake automation."],
        forbidden_wording: [],
        raw: {
          id: "evidence-001",
          claim: "Built intake automation.",
          evidence: "Project notes",
          sourceId: "source-private-001",
          role_signals: ["workflow builder"],
        },
      },
    });
    renderLibrary();

    capturedButton("Edit").onClick();
    renderLibrary();
    capturedField("library-edit-claim").onChange("Built production intake automation.");
    renderLibrary();
    capturedButton("Save").onClick();

    expect(apiMocks.saveCandidateFile).toHaveBeenCalledWith("evidence", {
      claims: [
        expect.objectContaining({
          id: "evidence-001",
          claim: "Built production intake automation.",
          sourceId: "source-private-001",
          role_signals: ["workflow builder"],
        }),
      ],
    });
  });

  it("requires inline confirmation before removing an evidence claim", async () => {
    showCard({
      id: "evidence-delete-001",
      kind: "evidence",
      label: "Evidence bank",
      title: "Delete this claim",
      summary: "Reusable evidence",
      note: "Source-grounded claim",
      tags: [],
      metadata: { raw: { id: "evidence-delete-001" } },
    });
    renderLibrary();

    expect(apiMocks.removeEvidenceClaim).not.toHaveBeenCalled();
    capturedButton("Remove from library").onClick();
    const html = renderLibrary();

    expect(html).toContain("Remove this from your library? This can&#x27;t be undone.");
    expect(apiMocks.removeEvidenceClaim).not.toHaveBeenCalled();
    await capturedButton("Confirm remove").onClick();
    expect(apiMocks.removeEvidenceClaim).toHaveBeenCalledWith("evidence-delete-001");
  });

  it.each([
    ["story", "story_bank", { title: "Rollout story" }],
    ["voice", "writing_voice", { summary: "Direct writing" }],
    ["honesty", "honesty_boundaries", { text: "Do not claim model training." }],
    ["role_signal", "role_signals", { text: "Agent workflow builder" }],
  ])("saves %s cards through the confirmed-item update wrapper", (kind, lane, metadata) => {
    const id = `${kind}-edit-001`;
    showCard({
      id,
      kind,
      label: kind,
      title: `${kind} card`,
      summary: "Reference material",
      note: "Reusable note",
      tags: [],
      metadata,
    });
    renderLibrary();

    capturedButton("Edit").onClick();
    renderLibrary();
    capturedButton("Save").onClick();

    expect(apiMocks.updateDeepIngestConfirmedItem).toHaveBeenCalledWith(
      expect.objectContaining({ lane, id })
    );
  });

  it("does not offer Edit or Delete controls for cards without a stored id", () => {
    showCard(
      {
        kind: "voice",
        label: "Writing voice",
        title: "Legacy voice",
        summary: "Derived compatibility summary",
        note: "Reference only",
        tags: [],
        metadata: { summary: "Derived compatibility summary" },
      },
      "voice-legacy-voice"
    );

    const html = renderLibrary();

    expect(html).toContain("Legacy voice");
    expect(captured.buttons.some((props) => props.children === "Edit")).toBe(false);
    expect(captured.buttons.some((props) => props.children === "Remove from library")).toBe(false);
  });

  it("labels honesty cards' forbidden wording as enforced, with education/tools still in Settings", () => {
    showCard({
      id: "honesty-disclaimer-001",
      kind: "honesty",
      label: "Honesty boundary",
      title: "Do not claim model training",
      summary: "Boundary captured from source material",
      note: "Reference only",
      tags: [],
      metadata: { text: "Do not claim model training." },
    });

    const html = renderLibrary();

    expect(html).toContain(
      "Its forbidden wording is enforced on every future generated document — but education policy and confirmed tools still live only in Settings → Honesty boundaries."
    );
  });
});
