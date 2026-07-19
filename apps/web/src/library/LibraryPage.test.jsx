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
}));

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
vi.mock("./libraryPreviewData.js", () => ({
  PREVIEW_DOCUMENTS: [],
  PREVIEW_LIBRARY: { cards: [], metrics: {}, preview: false },
}));

import { LibraryPage } from "./LibraryPage.jsx";

function renderLibrary() {
  hookHarness.reset();
  return renderToStaticMarkup(LibraryPage());
}

async function flushEffects() {
  const effects = hookHarness.pendingEffects.splice(0);
  for (const effect of effects) effect();
  for (let turn = 0; turn < 5; turn += 1) await Promise.resolve();
}

beforeEach(() => {
  hookHarness.clear();
  vi.clearAllMocks();
  dashboardContext.useDashboardSnapshot.mockReturnValue({
    data: { library: { cards: [] }, jobs: { rows: [] } },
    loading: false,
    error: null,
    noDatabase: false,
  });
  apiMocks.getDeepIngestState.mockResolvedValue({ readiness: { ready: true } });
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
});
