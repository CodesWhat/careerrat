import { readFile } from "node:fs/promises";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { normalizeSourceReviewArtifact } from "../../../../src/core/discovery/source-review-artifact.mjs";
import { ApiError } from "../lib/api.js";

vi.mock("../jobs/ArtifactViewerModal.jsx", async (importOriginal) => ({
  ...(await importOriginal()),
  ArtifactViewerModal: ({ artifact, title }) => (artifact ? <div>{`viewer:${title}`}</div> : null),
}));

const VIEW = {
  agentName: "Paul",
  mainThread: {
    messages: [
      { id: "m1", role: "assistant", kind: "text", text: "I found six strong roles." },
      { id: "m2", role: "user", kind: "text", text: "Start with Tyrell." },
    ],
  },
  threads: [
    {
      id: "job:app-1",
      applicationId: "app-1",
      title: "E Corp",
      company: "E Corp",
      role: "Staff SWE",
      stage: "offer",
      fitScore: 91,
      subtitle: "recruiter replied 2h ago",
      needsAction: true,
      communications: [
        {
          id: "comm-1",
          participants: [{ name: "Darlene Alderson", role: "Recruiting" }],
          messages: [{ direction: "inbound", summary: "Can you talk Friday morning?" }],
          draft: { body: "Friday morning works. I can do 10:00 ET." },
        },
      ],
      messages: [{ id: "j1", role: "assistant", kind: "text", text: "I drafted the reply." }],
    },
  ],
  archivedThreads: [],
  needsYou: [
    {
      id: "mission-1:submit-1",
      kind: "submit",
      title: "E Corp application ready",
      detail: "The form is filled. You press submit.",
      primaryLabel: "Review & submit",
      tone: "attention",
    },
  ],
  missions: [
    {
      id: "mission-1",
      title: "Apply to 1 role",
      status: "paused",
      steps: [{ id: "submit-1", label: "Submit E Corp", status: "blocked" }],
    },
  ],
  activeMission: null,
  activity: [{ id: "act-1", relTime: "8:14", title: "Sweep complete", type: "success" }],
  counts: { search: 1, pipeline: 1, files: 1, people: 1, touchDue: 1, archived: 0 },
  browser: {
    search: [{ id: "s1", source: "sourced", company: "Tyrell", role: "Staff", fit: 88 }],
    pipeline: { applicationCount: 1, rows: [], leaks: [], jobs: [] },
    files: [],
    people: [],
    schedule: [{ day: "THURSDAY", items: [{ id: "event-1", time: "2:00 PM", title: "Panel" }] }],
  },
  jobDetails: {},
  mockSessions: [],
  skillChats: [],
};

const BASE_UI = {
  activeThread: "today",
  activeApplicationId: null,
  browse: false,
  pipeView: "funnel",
  selection: [],
  composerChips: [],
  gateId: null,
  activityOpen: false,
  archiveOpen: false,
};

async function renderView(props = {}) {
  const { ChatFirstAppView } = await import("./ChatFirstApp.jsx");
  return renderToStaticMarkup(
    <ChatFirstAppView
      view={VIEW}
      ui={BASE_UI}
      composerValue=""
      sourceSweep={{ status: "idle", summary: "today · 6 qualified" }}
      actions={{}}
      {...props}
    />
  );
}

describe("ChatFirstAppView", () => {
  it("mounts the GitHub star prompt over conversation and browser surfaces", async () => {
    const prompt = { visible: true, onDismiss: vi.fn() };
    const conversationHtml = await renderView({ githubStarPrompt: prompt });
    const browserHtml = await renderView({
      ui: { ...BASE_UI, browse: "search" },
      githubStarPrompt: prompt,
    });

    expect(conversationHtml).toContain('class="chat-first-star-prompt"');
    expect(browserHtml).toContain('class="chat-first-star-prompt"');
  });

  it("hydrates saved search state before exposing a new search action", async () => {
    const module = await import("./ChatFirstApp.jsx");

    expect(module.initialVisibleSearchState({ getSourcingRun: vi.fn() })).toEqual({
      status: "hydrating",
      detail: "Loading your saved search",
    });
    expect(module.initialVisibleSearchState({})).toEqual({
      status: "idle",
      summary: "Ready to sweep configured sources",
    });
  });

  it("keeps the Search launcher in a loading state while saved runs hydrate", async () => {
    const html = await renderView({
      view: {
        ...VIEW,
        counts: { ...VIEW.counts, search: 0 },
        browser: { ...VIEW.browser, search: [] },
      },
      sourceSweep: { status: "hydrating", detail: "Loading your saved search" },
    });

    expect(html).toContain("loading search");
    expect(html).not.toContain("start here");
  });

  it("shows persisted Search jobs after a dedupe-only final-input refresh", async () => {
    const html = await renderView({
      ui: { ...BASE_UI, browse: "search" },
      sourceSweep: {
        status: "complete",
        metrics: { new: 0, qualified: 0, scanned: 358, sources: 5 },
        summary: "0 new · 0 qualified · 358 scanned · 5 sources",
      },
    });

    expect(html).toContain("1 match ready · 0 new · 358 scanned · 5 sources");
    expect(html).not.toContain("0 qualified");
  });

  it("loads manual, onboarding, and AI search runs together", async () => {
    const module = await import("./ChatFirstApp.jsx");
    const firstSearch = {
      purpose: "first-search",
      run: { id: "first-search-1", purpose: "first-search", status: "running" },
    };
    const aiWeb = {
      purpose: "ai-web-search",
      run: { id: "ai-web-search-1", purpose: "ai-web-search", status: "failed" },
    };
    const getSourcingRun = vi.fn(async ({ purpose }) =>
      purpose === "manual-search"
        ? { purpose, status: "not_started", run: null }
        : purpose === "first-search"
          ? firstSearch
          : aiWeb
    );

    await expect(module.loadVisibleSearchRuns({ getSourcingRun })).resolves.toEqual({
      deterministic: firstSearch,
      aiWeb,
    });
    expect(getSourcingRun).toHaveBeenCalledTimes(3);
    expect(getSourcingRun).toHaveBeenCalledWith({ purpose: "manual-search" });
    expect(getSourcingRun).toHaveBeenCalledWith({ purpose: "first-search" });
    expect(getSourcingRun).toHaveBeenCalledWith({ purpose: "ai-web-search" });
  });

  it("chooses the running deterministic run over an older completed manual run", async () => {
    const module = await import("./ChatFirstApp.jsx");
    const manualSearch = {
      purpose: "manual-search",
      run: {
        id: "manual-old",
        purpose: "manual-search",
        status: "completed",
        updated_at: "2026-08-25T12:00:00.000Z",
      },
    };
    const firstSearch = {
      purpose: "first-search",
      run: {
        id: "first-running",
        purpose: "first-search",
        status: "running",
        updated_at: "2026-08-25T11:00:00.000Z",
      },
    };
    const getSourcingRun = vi.fn(async ({ purpose }) =>
      purpose === "manual-search"
        ? manualSearch
        : purpose === "first-search"
          ? firstSearch
          : { purpose, run: null }
    );

    await expect(module.loadVisibleSearchRuns({ getSourcingRun })).resolves.toMatchObject({
      deterministic: firstSearch,
    });
  });

  it("chooses the newest terminal deterministic run instead of preferring manual by existence", async () => {
    const module = await import("./ChatFirstApp.jsx");
    const manualSearch = {
      purpose: "manual-search",
      run: {
        id: "manual-old",
        purpose: "manual-search",
        status: "completed",
        updatedAt: "2026-08-25T12:00:00.000Z",
      },
    };
    const firstSearch = {
      purpose: "first-search",
      run: {
        id: "first-new",
        purpose: "first-search",
        status: "completed",
        updatedAt: "2026-08-25T13:00:00.000Z",
      },
    };
    const getSourcingRun = vi.fn(async ({ purpose }) =>
      purpose === "manual-search"
        ? manualSearch
        : purpose === "first-search"
          ? firstSearch
          : { purpose, run: null }
    );

    await expect(module.loadVisibleSearchRuns({ getSourcingRun })).resolves.toMatchObject({
      deterministic: firstSearch,
    });
  });

  it("ignores a parked not-started manual placeholder when a real first search exists", async () => {
    const module = await import("./ChatFirstApp.jsx");
    const manualSearch = {
      purpose: "manual-search",
      run: { status: "not_started", error: { message: "Add a search location." } },
    };
    const firstSearch = {
      purpose: "first-search",
      run: { id: "first-complete", purpose: "first-search", status: "completed" },
    };
    const getSourcingRun = vi.fn(async ({ purpose }) =>
      purpose === "manual-search"
        ? manualSearch
        : purpose === "first-search"
          ? firstSearch
          : { purpose, run: null }
    );

    await expect(module.loadVisibleSearchRuns({ getSourcingRun })).resolves.toMatchObject({
      deterministic: firstSearch,
    });
  });

  it("hydrates a durable AI failure into a visible exact-prompt retry", async () => {
    const module = await import("./ChatFirstApp.jsx");
    const deterministic = {
      run: {
        id: "manual-1",
        purpose: "manual-search",
        status: "completed",
        metadata: { searchExecutionId: "search-execution-1" },
        summary: { new: 3, scanned: 10, attemptedSources: 2 },
      },
    };
    const aiWeb = {
      run: {
        id: "ai-1",
        purpose: "ai-web-search",
        status: "failed",
        metadata: { searchExecutionId: "search-execution-1" },
        error: {
          message: "second query timed out",
          failedPromptIds: ["p2"],
        },
      },
    };

    const hydrated = module.hydrateVisibleSearchRuns({ deterministic, aiWeb });

    expect(hydrated).toMatchObject({
      retry: { aiPromptIds: ["p2"], searchExecutionId: "search-execution-1" },
      sourceSweep: {
        status: "complete",
        lanes: {
          deterministic: { status: "succeeded" },
          aiWeb: {
            status: "failed",
            error: "second query timed out",
            failedPromptIds: ["p2"],
          },
        },
      },
    });

    const runDeterministicLane = vi.fn(async () => ({ ok: true }));
    const runAiLane = vi.fn(async () => ({ ok: true }));
    await module.runChatFirstJobSearch({
      api: {
        getSearchSourceStatus: vi.fn(async () => ({
          searches: { enabled: 1 },
          deterministicSources: { attempted: 1 },
        })),
        getRuntimeConfig: vi.fn(async () => ({ ai: { available: true } })),
      },
      retry: hydrated.retry,
      runDeterministicLane,
      runAiLane,
    });

    expect(runDeterministicLane).not.toHaveBeenCalled();
    expect(runAiLane).toHaveBeenCalledWith(expect.objectContaining({ promptIds: ["p2"] }));
  });

  it("lets the server heal sources while AI searches when no boards are pinned", async () => {
    const module = await import("./ChatFirstApp.jsx");
    const runDeterministicLane = vi.fn(async () => ({ ok: true }));
    const runAiLane = vi.fn(async () => ({ ok: true, data: { new: 3 } }));

    const result = await module.runChatFirstJobSearch({
      api: {
        getSearchSourceStatus: vi.fn(async () => ({
          searches: { enabled: 0 },
          enabledTrackedCompanies: 0,
          deterministicSources: { attempted: 0 },
        })),
        getRuntimeConfig: vi.fn(async () => ({ ai: { available: true } })),
      },
      runDeterministicLane,
      runAiLane,
      createSearchExecutionId: () => "search-tester-fixture",
    });

    expect(result).toMatchObject({ ok: true });
    expect(runDeterministicLane).toHaveBeenCalledWith(
      expect.objectContaining({ searchExecutionId: "search-tester-fixture" })
    );
    expect(runAiLane).toHaveBeenCalledWith(
      expect.objectContaining({ searchExecutionId: "search-tester-fixture" })
    );
  });

  it("does not combine an unrelated durable AI failure with a newer deterministic search", async () => {
    const module = await import("./ChatFirstApp.jsx");
    const hydrated = module.hydrateVisibleSearchRuns({
      deterministic: {
        run: {
          id: "manual-new",
          purpose: "manual-search",
          status: "completed",
          metadata: { searchExecutionId: "search-execution-new" },
          summary: { new: 2 },
        },
      },
      aiWeb: {
        run: {
          id: "ai-old",
          purpose: "ai-web-search",
          status: "failed",
          metadata: { searchExecutionId: "search-execution-old" },
          error: { message: "stale AI failure", failedPromptIds: ["old-prompt"] },
        },
      },
    });

    expect(hydrated.retry).toBeNull();
    expect(hydrated.sourceSweep.lanes).not.toHaveProperty("aiWeb");
    expect(hydrated.sourceSweep.summary).not.toContain("retry");
  });

  it("does not attach a legacy AI failure to a deterministic search with an execution id", async () => {
    const module = await import("./ChatFirstApp.jsx");
    const hydrated = module.hydrateVisibleSearchRuns({
      deterministic: {
        run: {
          id: "manual-new",
          purpose: "manual-search",
          status: "completed",
          metadata: { searchExecutionId: "search-execution-new" },
          summary: { new: 2 },
        },
      },
      aiWeb: {
        run: {
          id: "ai-legacy",
          purpose: "ai-web-search",
          status: "failed",
          error: { message: "legacy stale failure", failedPromptIds: ["legacy-prompt"] },
        },
      },
    });

    expect(hydrated.retry).toBeNull();
    expect(hydrated.sourceSweep.lanes).not.toHaveProperty("aiWeb");
    expect(hydrated.sourceSweep.summary).not.toContain("retry");
  });

  it("keeps a current AI-only lane visible when the deterministic run has no execution id", async () => {
    const module = await import("./ChatFirstApp.jsx");
    const hydrated = module.hydrateVisibleSearchRuns({
      deterministic: {
        run: {
          id: "first-search-without-execution-id",
          purpose: "first-search",
          status: "completed",
          completedAt: "2026-08-26T15:00:00.000Z",
          summary: { new: 2 },
        },
      },
      aiWeb: {
        run: {
          id: "ai-current",
          purpose: "ai-web-search",
          status: "failed",
          completedAt: "2026-08-26T15:01:00.000Z",
          metadata: { searchExecutionId: "search-execution-current" },
          error: { message: "current AI lane failed", failedPromptIds: ["current-prompt"] },
        },
      },
    });

    expect(hydrated).toMatchObject({
      retry: {
        aiPromptIds: ["current-prompt"],
        searchExecutionId: "search-execution-current",
      },
      sourceSweep: {
        status: "complete",
        lanes: {
          deterministic: { status: "succeeded" },
          aiWeb: { status: "failed", error: "current AI lane failed" },
        },
      },
    });
  });

  it("hydrates a durable AI cancellation as skipped without offering retry", async () => {
    const module = await import("./ChatFirstApp.jsx");
    const hydrated = module.hydrateVisibleSearchRuns({
      deterministic: { run: null },
      aiWeb: {
        run: {
          id: "ai-cancelled",
          purpose: "ai-web-search",
          status: "failed",
          error: { code: "AI_WEB_SEARCH_ABORTED", message: "AI web search was cancelled." },
        },
      },
    });

    expect(hydrated.retry).toBeNull();
    expect(hydrated.sourceSweep).toMatchObject({
      status: "idle",
      reason: "cancelled",
      summary: "Search cancelled.",
      lanes: { aiWeb: { status: "skipped", reason: "cancelled" } },
    });
  });

  it("keeps a successful sibling lane when AI web search is cancelled", async () => {
    const module = await import("./ChatFirstApp.jsx");
    const hydrated = module.hydrateVisibleSearchRuns({
      deterministic: {
        run: {
          id: "manual-success",
          purpose: "manual-search",
          status: "completed",
          metadata: { searchExecutionId: "search-execution-cancelled" },
          summary: { new: 3, qualified: 2, scanned: 9, attemptedSources: 2 },
        },
      },
      aiWeb: {
        run: {
          id: "ai-cancelled",
          purpose: "ai-web-search",
          status: "failed",
          metadata: { searchExecutionId: "search-execution-cancelled" },
          error: { code: "AI_WEB_SEARCH_ABORTED", message: "AI web search was cancelled." },
        },
      },
    });

    expect(hydrated.retry).toBeNull();
    expect(hydrated.sourceSweep).toMatchObject({
      status: "complete",
      summary: "3 new · 2 qualified · 9 scanned · 2 sources",
      lanes: {
        deterministic: { status: "succeeded" },
        aiWeb: { status: "skipped", reason: "cancelled" },
      },
    });
  });

  it("keeps a partial sibling result and its retry when AI web search is cancelled", async () => {
    const module = await import("./ChatFirstApp.jsx");
    const hydrated = module.hydrateVisibleSearchRuns({
      deterministic: {
        run: {
          id: "manual-partial",
          purpose: "manual-search",
          status: "completed",
          metadata: { searchExecutionId: "search-execution-cancelled" },
          summary: { new: 2, errorCount: 1 },
        },
      },
      aiWeb: {
        run: {
          id: "ai-cancelled",
          purpose: "ai-web-search",
          status: "failed",
          metadata: { searchExecutionId: "search-execution-cancelled" },
          error: { code: "AI_WEB_SEARCH_ABORTED", message: "AI web search was cancelled." },
        },
      },
    });

    expect(hydrated.retry).toEqual({
      deterministic: true,
      searchExecutionId: "search-execution-cancelled",
    });
    expect(hydrated.sourceSweep).toMatchObject({
      status: "complete",
      summary: "1 search lane finished · 1 lane needs retry",
      lanes: {
        deterministic: { status: "failed", partial: true },
        aiWeb: { status: "skipped", reason: "cancelled" },
      },
    });
  });

  it("keeps a failed sibling lane and its retry when AI web search is cancelled", async () => {
    const module = await import("./ChatFirstApp.jsx");
    const hydrated = module.hydrateVisibleSearchRuns({
      deterministic: {
        run: {
          id: "manual-failed",
          purpose: "manual-search",
          status: "failed",
          metadata: { searchExecutionId: "search-execution-cancelled" },
          error: { message: "configured sources failed" },
        },
      },
      aiWeb: {
        run: {
          id: "ai-cancelled",
          purpose: "ai-web-search",
          status: "failed",
          metadata: { searchExecutionId: "search-execution-cancelled" },
          error: { code: "AI_WEB_SEARCH_ABORTED", message: "AI web search was cancelled." },
        },
      },
    });

    expect(hydrated.retry).toEqual({
      deterministic: true,
      searchExecutionId: "search-execution-cancelled",
    });
    expect(hydrated.sourceSweep).toMatchObject({
      status: "error",
      summary: "0 search lanes finished · 1 lane needs retry",
      lanes: {
        deterministic: { status: "failed", error: "configured sources failed" },
        aiWeb: { status: "skipped", reason: "cancelled" },
      },
    });
  });

  it("shows both durable lanes while the correlated AI lane is still running", async () => {
    const module = await import("./ChatFirstApp.jsx");
    const hydrated = module.hydrateVisibleSearchRuns({
      deterministic: {
        run: {
          id: "manual-done",
          purpose: "manual-search",
          status: "completed",
          metadata: { searchExecutionId: "search-execution-running" },
          summary: { new: 2 },
        },
      },
      aiWeb: {
        run: {
          id: "ai-running",
          purpose: "ai-web-search",
          status: "running",
          metadata: { searchExecutionId: "search-execution-running" },
        },
      },
    });

    expect(hydrated.sourceSweep).toMatchObject({
      status: "running",
      lanes: {
        deterministic: { status: "succeeded" },
        aiWeb: { status: "running" },
      },
    });
  });

  it("follows every running durable purpose by exact id before reloading all purposes", async () => {
    const module = await import("./ChatFirstApp.jsx");
    const loaded = {
      deterministic: {
        purpose: "manual-search",
        run: { id: "manual-running", purpose: "manual-search", status: "running" },
      },
      aiWeb: {
        purpose: "ai-web-search",
        run: { id: "ai-running", purpose: "ai-web-search", status: "running" },
      },
    };
    const terminalByPurpose = {
      "manual-search": {
        purpose: "manual-search",
        run: { id: "manual-running", purpose: "manual-search", status: "completed" },
      },
      "first-search": { purpose: "first-search", run: null },
      "ai-web-search": {
        purpose: "ai-web-search",
        run: { id: "ai-running", purpose: "ai-web-search", status: "completed" },
      },
    };
    const getSourcingRun = vi.fn(async ({ purpose }) => terminalByPurpose[purpose]);

    const followed = await module.followVisibleSearchRuns({
      loaded,
      getSourcingRun,
      pollIntervalMs: 0,
    });

    expect(followed).toMatchObject({
      aborted: false,
      timedOut: false,
      runs: {
        deterministic: terminalByPurpose["manual-search"],
        aiWeb: terminalByPurpose["ai-web-search"],
      },
    });
    expect(getSourcingRun).toHaveBeenCalledWith({
      purpose: "manual-search",
      id: "manual-running",
    });
    expect(getSourcingRun).toHaveBeenCalledWith({
      purpose: "ai-web-search",
      id: "ai-running",
    });
    expect(getSourcingRun).toHaveBeenCalledWith({ purpose: "manual-search" });
    expect(getSourcingRun).toHaveBeenCalledWith({ purpose: "first-search" });
    expect(getSourcingRun).toHaveBeenCalledWith({ purpose: "ai-web-search" });
  });

  it("aborts an in-flight exact durable poll without reloading search purposes", async () => {
    const module = await import("./ChatFirstApp.jsx");
    const controller = new AbortController();
    const loaded = {
      deterministic: {
        purpose: "manual-search",
        run: { id: "manual-running", purpose: "manual-search", status: "running" },
      },
      aiWeb: { purpose: "ai-web-search", run: null },
    };
    const getSourcingRun = vi.fn(
      ({ signal }) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener(
            "abort",
            () => reject(new DOMException("Aborted", "AbortError")),
            { once: true }
          );
        })
    );

    const following = module.followVisibleSearchRuns({
      loaded,
      getSourcingRun,
      signal: controller.signal,
      pollIntervalMs: 0,
    });
    await vi.waitFor(() => expect(getSourcingRun).toHaveBeenCalledOnce());
    controller.abort();

    await expect(following).resolves.toMatchObject({ aborted: true, runs: loaded });
    expect(getSourcingRun).toHaveBeenCalledWith({
      purpose: "manual-search",
      id: "manual-running",
      signal: controller.signal,
    });
  });

  it("removes each abort listener after a normal durable poll timer finishes", async () => {
    const module = await import("./ChatFirstApp.jsx");
    const controller = new AbortController();
    const addListener = vi.spyOn(controller.signal, "addEventListener");
    const removeListener = vi.spyOn(controller.signal, "removeEventListener");
    const loaded = {
      deterministic: {
        purpose: "manual-search",
        run: { id: "manual-running", purpose: "manual-search", status: "running" },
      },
      aiWeb: { purpose: "ai-web-search", run: null },
    };
    let exactReads = 0;
    const getSourcingRun = vi.fn(async ({ purpose, id }) => {
      if (id) {
        exactReads += 1;
        return {
          purpose,
          run: {
            id,
            purpose,
            status: exactReads < 3 ? "running" : "completed",
          },
        };
      }
      return purpose === "manual-search"
        ? {
            purpose,
            run: { id: "manual-running", purpose, status: "completed" },
          }
        : { purpose, run: null };
    });

    await module.followVisibleSearchRuns({
      loaded,
      getSourcingRun,
      signal: controller.signal,
      pollIntervalMs: 0,
    });

    expect(addListener).toHaveBeenCalledTimes(3);
    expect(removeListener).toHaveBeenCalledTimes(3);
    for (let index = 0; index < addListener.mock.calls.length; index += 1) {
      expect(removeListener.mock.calls[index][1]).toBe(addListener.mock.calls[index][1]);
    }
  });

  it("hydrates configured-source summary errors as partial retry state", async () => {
    const module = await import("./ChatFirstApp.jsx");
    const hydrated = module.hydrateVisibleSearchRuns({
      deterministic: {
        run: {
          id: "manual-partial",
          status: "completed",
          summary: {
            new: 2,
            errorCount: 1,
            errors: [{ company: "Acme", error: "careers page timed out" }],
          },
        },
      },
      aiWeb: { run: null },
    });

    expect(hydrated).toMatchObject({
      retry: { deterministic: true },
      sourceSweep: {
        status: "complete",
        lanes: {
          deterministic: {
            status: "failed",
            partial: true,
            error: "1 configured source couldn't be searched.",
          },
        },
      },
    });
  });

  it("starts deterministic search without a source-permission preflight", async () => {
    const module = await import("./ChatFirstApp.jsx");
    expect(module.runChatFirstJobSearch).toBeTypeOf("function");
    const controller = new AbortController();
    const sourceStatus = {
      searches: { enabled: 2 },
      enabledTrackedCompanies: 1,
      deterministicSources: { attempted: 3 },
    };
    const runtimeStatus = { ai: { available: true, route: "installed" } };
    const api = {
      getSearchSourceStatus: vi.fn(async () => sourceStatus),
      getRuntimeConfig: vi.fn(async () => runtimeStatus),
      getInstalledAiRuntimes: vi.fn(() => {
        throw new Error("a search must not re-probe installed runtimes");
      }),
      startSearchRun: vi.fn(),
      getSourcingRun: vi.fn(),
    };
    const runDeterministicLane = vi.fn(async () => ({ ok: true }));
    const runAiLane = vi.fn(async () => ({ ok: true }));
    const runCoordinator = vi.fn(async (options) => {
      expect(options.capabilities).toEqual({
        deterministic: { configured: true, executable: true },
        aiWeb: { configured: true, executable: true },
      });
      await options.runDeterministic({ signal: controller.signal, onLaneState: vi.fn() });
      await options.runAiWeb({ signal: controller.signal, onLaneState: vi.fn() });
      return { ok: true };
    });

    await module.runChatFirstJobSearch({
      api,
      refetch: vi.fn(),
      setSearchState: vi.fn(),
      signal: controller.signal,
      runCoordinator,
      runDeterministicLane,
      runAiLane,
      createSearchExecutionId: () => "search-execution-shared",
    });

    expect(api.getSearchSourceStatus).not.toHaveBeenCalled();
    expect(api.getRuntimeConfig).toHaveBeenCalledOnce();
    expect(api.getInstalledAiRuntimes).not.toHaveBeenCalled();
    expect(runDeterministicLane).toHaveBeenCalledWith(
      expect.objectContaining({
        startSearchRun: api.startSearchRun,
        getSourcingRun: api.getSourcingRun,
        searchExecutionId: "search-execution-shared",
        signal: controller.signal,
      })
    );
    expect(runAiLane).toHaveBeenCalledWith(
      expect.objectContaining({
        searchExecutionId: "search-execution-shared",
        signal: controller.signal,
      })
    );
  });

  it("still starts deterministic search when optional AI availability cannot be read", async () => {
    const module = await import("./ChatFirstApp.jsx");
    const runDeterministicLane = vi.fn(async () => ({ ok: true }));
    const runAiLane = vi.fn(async () => ({ ok: true }));

    const result = await module.runChatFirstJobSearch({
      api: {
        getRuntimeConfig: vi.fn(async () => {
          throw new Error("runtime status unavailable");
        }),
      },
      runDeterministicLane,
      runAiLane,
      createSearchExecutionId: () => "search-without-ai-status",
    });

    expect(result).toMatchObject({ ok: true });
    expect(runDeterministicLane).toHaveBeenCalledWith(
      expect.objectContaining({ searchExecutionId: "search-without-ai-status" })
    );
    expect(runAiLane).not.toHaveBeenCalled();
  });

  it("retries only the exact failed AI prompts through the chat-first search wrapper", async () => {
    const module = await import("./ChatFirstApp.jsx");
    const api = {
      getSearchSourceStatus: vi.fn(async () => ({
        searches: { enabled: 2 },
        deterministicSources: { attempted: 2 },
      })),
      getRuntimeConfig: vi.fn(async () => ({
        ai: { available: true, route: "installed" },
      })),
      startSearchRun: vi.fn(),
      getSourcingRun: vi.fn(),
    };
    const runDeterministicLane = vi.fn(async () => ({ ok: true }));
    const runAiLane = vi.fn(async () => ({ ok: true, data: { new: 1 } }));

    const result = await module.runChatFirstJobSearch({
      api,
      retry: { aiPromptIds: ["p2"] },
      refetch: vi.fn(),
      setSearchState: vi.fn(),
      runDeterministicLane,
      runAiLane,
    });

    expect(runDeterministicLane).not.toHaveBeenCalled();
    expect(runAiLane).toHaveBeenCalledWith(expect.objectContaining({ promptIds: ["p2"] }));
    expect(result).toMatchObject({ ok: true, partial: false });
  });

  it("routes new-shell navigation intents without sending retired href actions to the API", async () => {
    const { dispatchChatFirstMessageIntent } = await import("./ChatFirstApp.jsx");
    const openJob = vi.fn();
    const openBrowser = vi.fn();
    const openSettings = vi.fn();
    const openArtifact = vi.fn();
    const openSourced = vi.fn();
    const runWorkspaceIntent = vi.fn();
    const callbacks = {
      openJob,
      openBrowser,
      openSettings,
      openArtifact,
      openSourced,
      runWorkspaceIntent,
    };

    dispatchChatFirstMessageIntent(
      {
        type: "ui.navigate",
        entity: { type: "application", id: "app-1" },
        input: { surface: "job" },
      },
      callbacks
    );
    for (const surface of ["search", "files", "schedule"]) {
      dispatchChatFirstMessageIntent(
        {
          type: "ui.navigate",
          entity: { type: "workspace", id: "workspace-main" },
          input: { surface },
        },
        callbacks
      );
    }
    dispatchChatFirstMessageIntent(
      {
        type: "ui.navigate",
        entity: { type: "application", id: "app-1" },
        input: { surface: "files", artifactKind: "interview-dossier" },
      },
      callbacks
    );
    dispatchChatFirstMessageIntent(
      {
        type: "ui.navigate",
        entity: { type: "sourced", id: "sourced-1" },
        input: { surface: "search" },
      },
      callbacks
    );
    dispatchChatFirstMessageIntent(
      {
        type: "ui.navigate",
        entity: { type: "workspace", id: "workspace-main" },
        input: { surface: "settings", section: "sources" },
      },
      callbacks
    );
    const runtimeIntent = {
      type: "company.health",
      entity: { type: "application", id: "app-1" },
      input: {},
    };
    dispatchChatFirstMessageIntent(runtimeIntent, callbacks);

    expect(openJob).toHaveBeenCalledWith("app-1");
    expect(openBrowser.mock.calls.map(([surface]) => surface)).toEqual([
      "search",
      "files",
      "schedule",
    ]);
    expect(openSettings).toHaveBeenCalledWith("sources");
    expect(openArtifact).toHaveBeenCalledWith(
      { type: "application", id: "app-1" },
      "interview-dossier"
    );
    expect(openSourced).toHaveBeenCalledWith("sourced-1");
    expect(runWorkspaceIntent).toHaveBeenCalledWith(runtimeIntent);
  });

  it("loads the exact dossier artifact behind the Open dossier navigation action", async () => {
    const { loadChatFirstNavigationArtifact } = await import("./ChatFirstApp.jsx");
    const dossier = { markdown: "# Acme interview dossier" };
    const api = {
      getInterviewDossier: vi.fn().mockResolvedValue({ data: { dossier } }),
    };

    const result = await loadChatFirstNavigationArtifact({
      api,
      entity: { type: "application", id: "app-acme" },
      artifactKind: "interview-dossier",
      files: [],
    });

    expect(api.getInterviewDossier).toHaveBeenCalledWith("app-acme");
    expect(result).toEqual({ title: "Interview dossier", artifact: dossier });
  });

  it("reveals an exact sourced CTA target through every conflicting Search filter", async () => {
    const { dispatchChatFirstMessageIntent, revealSourcedTarget } = await import(
      "./ChatFirstApp.jsx"
    );
    const { filterSearchJobs } = await import("./browser-model.js");
    const initialFilters = {
      fit80: true,
      fitFloor: 65,
      comp: true,
      remote: true,
      stage: "interview",
      source: "referral",
      posted: "1",
      files: "Resumes",
      people: "touch-due",
    };
    let filters = initialFilters;
    let query = "a different company";
    const actions = [];

    revealSourcedTarget("sourced-low-fit", {
      dispatch: (action) => actions.push(action),
      setQuery: (value) => {
        query = value;
      },
      setBrowserFilters: (update) => {
        filters = update(filters);
      },
    });

    expect(filters).toEqual({
      fit80: false,
      fitFloor: 65,
      comp: false,
      remote: false,
      stage: "all",
      source: "all",
      posted: "all",
      files: "Resumes",
      people: "touch-due",
    });
    expect(query).toBe("");
    expect(actions).toEqual([
      { type: "selection.replace", ids: ["sourced-low-fit"] },
      { type: "browser.open", tab: "search" },
    ]);
    expect(
      filterSearchJobs(
        [
          {
            id: "sourced-low-fit",
            company: "Target Co",
            role: "Backend Engineer",
            fit: 62,
            compStatus: "comp pending",
            workMode: "onsite",
            stage: "new",
            sourceLabel: "Direct",
            postedAt: "2025-01-01T00:00:00.000Z",
          },
        ],
        { ...filters, query }
      )
    ).toHaveLength(1);

    filters = initialFilters;
    dispatchChatFirstMessageIntent(
      {
        type: "ui.navigate",
        entity: { type: "workspace", id: "workspace-main" },
        input: { surface: "search" },
      },
      { openBrowser: vi.fn() }
    );
    expect(filters).toBe(initialFilters);
  });

  it("clears only Search query and filters while preserving other browser tabs", async () => {
    const { resetBrowserSearchFilters } = await import("./ChatFirstApp.jsx");
    let query = "platform engineer";
    let filters = {
      fit80: true,
      fitFloor: 65,
      comp: true,
      remote: true,
      stage: "new",
      source: "greenhouse",
      posted: "7d",
      files: "Evidence",
      people: "touch-due",
    };

    resetBrowserSearchFilters({
      setQuery: (value) => {
        query = value;
      },
      setBrowserFilters: (update) => {
        filters = update(filters);
      },
    });

    expect(query).toBe("");
    expect(filters).toEqual({
      fit80: false,
      fitFloor: 65,
      comp: false,
      remote: false,
      stage: "all",
      source: "all",
      posted: "all",
      files: "Evidence",
      people: "touch-due",
    });
  });

  it("wires the filtered Search empty state to the app reset action", async () => {
    const { ChatFirstAppView } = await import("./ChatFirstApp.jsx");
    const clearSearchFilters = vi.fn();
    const tree = ChatFirstAppView({
      view: VIEW,
      ui: { ...BASE_UI, browse: "search" },
      composerValue: "",
      query: "missing role",
      browserFilters: {
        fit80: true,
        fitFloor: 65,
        comp: false,
        remote: false,
        stage: "all",
        source: "all",
        posted: "all",
        files: "All",
        people: "all",
      },
      sourceSweep: { status: "complete", summary: "0 new · 1 scanned" },
      actions: { clearSearchFilters },
    });
    const buttons = [];
    function visit(node) {
      if (!node || typeof node !== "object") return;
      if (Array.isArray(node)) {
        node.forEach(visit);
        return;
      }
      if (typeof node.type === "function") {
        visit(node.type(node.props));
        return;
      }
      if (node.type === "button") buttons.push(node);
      visit(node.props?.children);
    }
    visit(tree);

    buttons.find((button) => button.props.children === "Clear filters").props.onClick();
    expect(clearSearchFilters).toHaveBeenCalledOnce();
  });

  it("renders a rejected workspace intent error envelope as natural text", async () => {
    const { runChatFirstOperation } = await import("./ChatFirstApp.jsx");
    const failure = new ApiError(404, {
      code: "COMPANY_NOT_FOUND",
      error: "application table lookup failed for app-missing",
    });
    const api = {
      runWorkspaceIntent: vi.fn().mockRejectedValue(failure),
    };
    const errors = [];
    const result = await runChatFirstOperation(
      () =>
        api.runWorkspaceIntent("company.health", { type: "application", id: "app-missing" }, {}),
      {
        refetch: vi.fn(),
        setBusy: vi.fn(),
        setError: (value) => errors.push(value),
        setEngineDown: vi.fn(),
      }
    );

    expect(result).toBeNull();
    expect(errors).toEqual([
      null,
      {
        message:
          "CareerRat couldn't find that company among your saved jobs. Name it exactly as it appears there.",
        action: null,
        detail: "application table lookup failed for app-missing",
      },
    ]);
    const html = await renderView({ error: errors.at(-1) });
    expect(html).toContain('role="alert"');
    expect(html).toContain(
      "CareerRat couldn&#x27;t find that company among your saved jobs. Name it exactly as it appears there."
    );
    expect(html).toContain("Technical details");
    expect(html).toContain(
      "CareerRat hides raw technical details here because they can include private information."
    );
    expect(html).not.toContain("application table lookup failed");
    expect(html).not.toContain("[object Object]");
  });

  it("renders mapped recovery actions without exposing raw diagnostics", async () => {
    const { ChatFirstAppView } = await import("./ChatFirstApp.jsx");
    const retry = vi.fn();
    const error = {
      message: "Something went wrong on the server. Try again in a moment.",
      action: { label: "Try again", retry: true, onRetry: retry },
      detail:
        "SQLITE_BUSY: route schema parser failed at /Users/person/workspace. password=hunter2\n    at loadDashboard (dashboard.mjs:18:4)",
    };
    const tree = ChatFirstAppView({
      view: VIEW,
      ui: BASE_UI,
      composerValue: "",
      sourceSweep: {},
      error,
      actions: {},
    });
    const buttons = [];
    function visit(node) {
      if (!node || typeof node !== "object") return;
      if (Array.isArray(node)) {
        node.forEach(visit);
        return;
      }
      if (typeof node.type === "function") {
        visit(node.type(node.props));
        return;
      }
      if (node.type === "button") buttons.push(node);
      visit(node.props?.children);
    }
    visit(tree);

    buttons.find((button) => button.props.children === "Try again").props.onClick();
    expect(retry).toHaveBeenCalledOnce();

    const html = renderToStaticMarkup(tree);
    expect(html).toContain("Something went wrong on the server. Try again in a moment.");
    expect(html).toContain("<details");
    expect(html).toContain("Technical details");
    expect(html).toContain(
      "CareerRat hides raw technical details here because they can include private information."
    );
    expect(html).not.toMatch(
      /SQLITE_BUSY|route schema|parser failed|\/Users\/person|hunter2|loadDashboard|dashboard\.mjs/i
    );
  });

  it("renders a passive background completion as a neutral status, not an error alert", async () => {
    const html = await renderView({
      error: {
        tone: "notice",
        message: "Your company suggestions are ready whenever you want to review them.",
        action: { label: "Review companies", onAction: vi.fn() },
        detail: null,
      },
    });

    expect(html).toContain(
      'class="chat-first-controller-alert chat-first-controller-alert--notice"'
    );
    expect(html).toContain('role="status"');
    expect(html).toContain('aria-live="polite"');
    expect(html).not.toContain('role="alert"');
    expect(html).toContain("Review companies");
  });

  it("surfaces dashboard load failures ahead of the setup fallback", async () => {
    const { chatFirstControllerError } = await import("./ChatFirstApp.jsx");
    const dashboardError = {
      message: "Something went wrong on the server. Try again in a moment.",
      action: { label: "Try again", retry: true, onRetry: vi.fn() },
      detail: "SQLITE_BUSY",
    };

    expect(
      chatFirstControllerError(null, {
        error: dashboardError,
        noDatabase: true,
      })
    ).toBe(dashboardError);
  });

  it("gives file failures plain-English recoveries", async () => {
    const { localFileError } = await import("./ChatFirstApp.jsx");
    const retry = vi.fn();

    expect(localFileError("unsafe-link").message).toBe(
      "CareerRat blocked that saved link because it isn't a safe web address. Check the URL or ask Paul to replace it."
    );
    expect(localFileError("preview", { name: "resume.pdf", onRetry: retry })).toEqual({
      message:
        "CareerRat couldn't build a preview for resume.pdf yet. Try again, or ask Paul to recreate it.",
      action: { label: "Try preview again", retry: true, onRetry: retry },
      detail: null,
    });
    expect(localFileError("dossier-download", { onRetry: retry })).toEqual({
      message:
        "CareerRat made the dossier PDF, but this window couldn't download it. Try the export again.",
      action: { label: "Try export again", retry: true, onRetry: retry },
      detail: null,
    });
    expect(localFileError("missing-export-path", { onRetry: retry })).toEqual({
      message:
        "CareerRat finished the export, but couldn't find the saved file. Try exporting it again.",
      action: { label: "Try export again", retry: true, onRetry: retry },
      detail: null,
    });
    expect(localFileError("not-exportable", { name: "Evidence notes" }).message).toBe(
      "Evidence notes doesn't have enough saved content to export yet. Ask Paul to rebuild it, then try again."
    );
    expect(localFileError("no-calendar-event").message).toBe(
      "Choose an interview or follow-up first, then try adding it to your calendar again."
    );
  });

  it("retries the exact packet load that failed", async () => {
    const { loadGatePacketWithRetry } = await import("./ChatFirstApp.jsx");
    const failure = new ApiError(500, { error: "packet table locked" });
    const packet = { artifacts: { resume: { text: "Resume" } } };
    const api = {
      getPacket: vi.fn().mockRejectedValueOnce(failure).mockResolvedValueOnce(packet),
    };
    const errors = [];
    const setGatePacket = vi.fn();
    let cancelled = false;

    await loadGatePacketWithRetry({
      api,
      applicationId: "app-1",
      setGatePacket,
      setError: (value) => errors.push(value),
      isCancelled: () => cancelled,
    });

    const retry = errors.at(-1).action.onRetry;
    expect(retry).toBeTypeOf("function");
    cancelled = true;
    await retry();
    expect(api.getPacket).toHaveBeenCalledTimes(2);
    expect(api.getPacket).toHaveBeenLastCalledWith("app-1");
    expect(setGatePacket).toHaveBeenCalledWith(packet);
    expect(errors.at(-1)).toBeNull();
  });

  it("retries the exact deep-ingest state load that failed", async () => {
    const { loadDeepIngestStateWithRetry } = await import("./ChatFirstApp.jsx");
    const failure = new ApiError(500, { error: "deep ingest state unavailable" });
    const state = { counts: { proposals: 3 } };
    const api = {
      getDeepIngestState: vi.fn().mockRejectedValueOnce(failure).mockResolvedValueOnce(state),
    };
    const errors = [];
    const setDeepState = vi.fn();
    let cancelled = false;

    await loadDeepIngestStateWithRetry({
      api,
      setDeepState,
      setError: (value) => errors.push(value),
      isCancelled: () => cancelled,
    });

    const retry = errors.at(-1).action.onRetry;
    expect(retry).toBeTypeOf("function");
    cancelled = true;
    await retry();
    expect(api.getDeepIngestState).toHaveBeenCalledTimes(2);
    expect(setDeepState).toHaveBeenCalledWith(state);
    expect(errors.at(-1)).toBeNull();
  });

  it("retries the exact discovery decision that failed", async () => {
    const { runDiscoveryDecisionWithRetry } = await import("./ChatFirstApp.jsx");
    const failure = new ApiError(500, { error: "source decision failed" });
    const commit = vi.fn().mockRejectedValueOnce(failure).mockResolvedValueOnce(undefined);
    const errors = [];
    let review = { candidates: [{ id: "source-1", decision: null }] };
    let skillChat = { id: "skill-1", messages: [] };
    const args = {
      api: {},
      activeSkillChat: { id: "skill-1", skill: "research-boards" },
      item: { id: "source-1" },
      action: "save",
      commit,
      setBusy: vi.fn(),
      setError: (value) => errors.push(value),
      setSourceReview: (update) => {
        review = update(review);
      },
      setSkillChatState: (update) => {
        skillChat = update(skillChat);
      },
      refetch: vi.fn().mockResolvedValue(undefined),
    };

    await runDiscoveryDecisionWithRetry(args);
    const retry = errors.findLast((value) => value?.action?.onRetry).action.onRetry;
    await retry();

    expect(commit).toHaveBeenCalledTimes(2);
    expect(commit).toHaveBeenLastCalledWith({
      api: args.api,
      skill: "research-boards",
      item: args.item,
      action: "save",
    });
    expect(review.candidates[0].decision).toEqual({ action: "save", status: "completed" });
    expect(skillChat.messages.at(-1).text).toBe(
      errors.findLast((value) => value?.action?.onRetry).message
    );
    expect(skillChat.messages.at(-1).text).not.toContain("source decision failed");
  });

  it("retries the exact discovery completion that failed", async () => {
    const { runDiscoveryCompletionWithRetry } = await import("./ChatFirstApp.jsx");
    const failure = new ApiError(500, { error: "source completion failed" });
    const commit = vi.fn().mockRejectedValueOnce(failure).mockResolvedValueOnce(undefined);
    const errors = [];
    const setSourceReview = vi.fn();
    const args = {
      api: {},
      activeSkillChat: { id: "skill-1", skill: "research-boards" },
      item: { id: "source-1" },
      commit,
      setBusy: vi.fn(),
      setError: (value) => errors.push(value),
      setSourceReview,
      refetch: vi.fn().mockResolvedValue(undefined),
    };

    await runDiscoveryCompletionWithRetry(args);
    const retry = errors.findLast((value) => value?.action?.onRetry).action.onRetry;
    await retry();

    expect(commit).toHaveBeenCalledTimes(2);
    expect(commit).toHaveBeenLastCalledWith({
      api: args.api,
      skill: "research-boards",
      item: args.item,
    });
    expect(setSourceReview).toHaveBeenCalledWith(null);
  });

  it("keeps application answers in the review column instead of the packet column", async () => {
    const module = await import("./ChatFirstApp.jsx");
    expect(module.packetRows).toBeTypeOf("function");
    expect(
      module.packetRows({
        artifacts: {
          resume: { html: "resume" },
          coverLetter: { html: "cover" },
          answers: { html: "answers" },
        },
      })
    ).toEqual([
      expect.objectContaining({ id: "resume", icon: "📄" }),
      expect.objectContaining({ id: "coverLetter", icon: "✉️" }),
    ]);
  });

  it("integrates the durable Today thread, missions, decision queue, and composer", async () => {
    const html = await renderView();

    expect(html).toContain("CareerRat");
    expect(html).toContain("I found six strong roles.");
    expect(html).toContain("Start with Tyrell.");
    expect(html).toContain("Apply to 1 role");
    expect(html).toContain("E Corp application ready");
    expect(html).toContain("tell Paul what to do");
    expect(html).toContain("1 touch due");
    expect(html).toContain("next: Thu");
    expect(html).toContain("chat-first-browser-launcher--attention");
  });

  it("keeps first-run Search visibly actionable and labels its running state", async () => {
    const railHtml = await renderView({
      view: {
        ...VIEW,
        counts: { ...VIEW.counts, search: 0 },
        browser: { ...VIEW.browser, search: [] },
      },
      sourceSweep: { status: "running", detail: "Scanning configured sources" },
    });
    const searchHtml = await renderView({
      ui: { ...BASE_UI, browse: "search" },
      onboardingHandoff: true,
      sourceSweep: { status: "running", detail: "Scanning configured sources" },
    });

    expect(railHtml).toContain("searching now");
    expect(railHtml).toContain("chat-first-browser-launcher--lime");
    expect(searchHtml).toMatch(/aria-selected="true"[^>]*class="cf-browser__tab"/);
    expect(searchHtml).not.toMatch(/aria-selected="true"[^>]*disabled/);
    expect(searchHtml).toContain("Your first job search is running now.");
  });

  it("routes a binary answer button through the same composer submit action", async () => {
    const { ChatFirstAppView } = await import("./ChatFirstApp.jsx");
    const submitComposer = vi.fn();
    const tree = ChatFirstAppView({
      view: {
        ...VIEW,
        mainThread: {
          messages: [
            {
              id: "binary-question",
              role: "assistant",
              kind: "text",
              text: "Should I keep this company in your search?",
              metadata: {
                choicePrompt: {
                  id: "choice-company",
                  version: 1,
                  threadId: "workspace-main",
                  messageId: "binary-question",
                  question: "Should I keep this company in your search?",
                  mode: "binary",
                  minSelections: 1,
                  maxSelections: 1,
                  allowText: true,
                  options: [
                    { id: "yes", label: "Yes", actionRef: { input: { text: "Yes" } } },
                    { id: "no", label: "No", actionRef: { input: { text: "No" } } },
                  ],
                  state: "pending",
                },
              },
            },
          ],
        },
      },
      ui: BASE_UI,
      composerValue: "",
      sourceSweep: {},
      actions: { submitComposer },
    });
    const buttons = [];
    function visit(node) {
      if (!node || typeof node !== "object") return;
      if (Array.isArray(node)) {
        node.forEach(visit);
        return;
      }
      if (typeof node.type === "function") {
        visit(node.type(node.props));
        return;
      }
      if (node.type === "button") buttons.push(node);
      visit(node.props?.children);
    }
    visit(tree);

    buttons.find((button) => button.props.children === "Yes").props.onClick();
    expect(submitComposer).toHaveBeenCalledWith("Yes", {
      promptId: "choice-company",
      version: 1,
      optionIds: ["yes"],
    });
  });

  it("resolves ordinary text only for the exact sole finite application question", async () => {
    const { resolvePacketGapTextAnswer } = await import("./ChatFirstApp.jsx");
    const gap = {
      id: "north-america",
      questionId: "north-america",
      label: "Are you currently located in North America?",
      answerable: true,
      options: ["Yes", "No"],
    };

    expect(resolvePacketGapTextAnswer({ gaps: [gap] }, " no ")).toEqual({ gap, answer: "No" });
    expect(
      resolvePacketGapTextAnswer(
        {
          gaps: [
            gap,
            {
              id: "travel",
              questionId: "travel",
              label: "Can you travel?",
              answerable: true,
              options: ["Yes", "No"],
            },
          ],
        },
        "No"
      )
    ).toBeNull();
    expect(resolvePacketGapTextAnswer({ gaps: [gap] }, "Maybe")).toBeNull();
  });

  it("submits named review options through the same sequential batch writers", async () => {
    const { submitConversationalReviewText } = await import("./ChatFirstApp.jsx");
    const sourceDecision = vi.fn(async () => true);
    const sourceComplete = vi.fn(async () => true);
    const sourceReview = normalizeSourceReviewArtifact({
      kind: "source_review",
      candidates: [
        {
          label: "LandEarly",
          url: "https://landearly.example/jobs",
          sourceType: "url-query",
          why: "Current hospitality roles",
          status: "proposed",
          confidence: "high",
        },
        {
          label: "Culinary Agents",
          url: "https://culinaryagents.example/jobs",
          sourceType: "browser",
          why: "NYC hospitality roles",
          status: "proposed",
          confidence: "high",
        },
      ],
    });

    await expect(
      submitConversationalReviewText({
        text: "Add Culinary Agents",
        sourceReview,
        onSourceDecision: sourceDecision,
        onSourceComplete: sourceComplete,
      })
    ).resolves.toEqual({ handled: true, completed: true });
    expect(sourceDecision.mock.calls.map(([candidate, action]) => [candidate.id, action])).toEqual([
      [sourceReview.candidates[0].id, "discard"],
      [sourceReview.candidates[1].id, "save"],
    ]);
    expect(sourceComplete).toHaveBeenCalledOnce();

    const onCompanyIntent = vi.fn(async () => true);
    await expect(
      submitConversationalReviewText({
        text: "Track Tyrell Systems",
        companyProposalReview: {
          kind: "company_proposals",
          batchId: "batch-1",
          proposals: [
            {
              proposalId: "proposal-acme",
              company: { name: "Acme AI" },
              classification: "supported_ats",
              atsProvider: "greenhouse",
              jobBoardUrl: "https://boards.example/acme",
              version: 3,
            },
            {
              proposalId: "proposal-tyrell",
              company: { name: "Tyrell Systems" },
              classification: "supported_ats",
              atsProvider: "ashby",
              jobBoardUrl: "https://boards.example/tyrell",
              version: 7,
            },
          ],
        },
        onCompanyIntent,
      })
    ).resolves.toEqual({ handled: true, completed: true });
    expect(onCompanyIntent.mock.calls.map(([intent]) => intent)).toEqual([
      expect.objectContaining({
        entity: { type: "company-proposal", id: "proposal-acme" },
        input: expect.objectContaining({ action: "reject", expectedVersion: 3 }),
      }),
      expect.objectContaining({
        entity: { type: "company-proposal", id: "proposal-tyrell" },
        input: expect.objectContaining({ action: "approve-supported-ats", expectedVersion: 7 }),
      }),
    ]);
  });

  it("does not consume ordinary chat when visible review names do not match exactly", async () => {
    const { submitConversationalReviewText } = await import("./ChatFirstApp.jsx");
    const sourceDecision = vi.fn();
    const companyDecision = vi.fn();

    await expect(
      submitConversationalReviewText({
        text: "Could you research more boards?",
        sourceReview: normalizeSourceReviewArtifact({
          kind: "source_review",
          candidates: [
            {
              label: "Culinary Agents",
              url: "https://culinaryagents.example/jobs",
              sourceType: "browser",
              why: "NYC hospitality roles",
              status: "proposed",
              confidence: "high",
            },
          ],
        }),
        onSourceDecision: sourceDecision,
      })
    ).resolves.toEqual({ handled: false, completed: false });
    expect(sourceDecision).not.toHaveBeenCalled();

    await expect(
      submitConversationalReviewText({
        text: "Why is Culinary Agents relevant?",
        sourceReview: normalizeSourceReviewArtifact({
          kind: "source_review",
          candidates: [
            {
              label: "Culinary Agents",
              url: "https://culinaryagents.example/jobs",
              sourceType: "browser",
              why: "NYC hospitality roles",
              status: "proposed",
              confidence: "high",
            },
          ],
        }),
        onSourceDecision: sourceDecision,
      })
    ).resolves.toEqual({ handled: false, completed: false });
    expect(sourceDecision).not.toHaveBeenCalled();

    await expect(
      submitConversationalReviewText({
        text: "Why is Acme AI relevant?",
        companyProposalReview: {
          kind: "company_proposals",
          batchId: "batch-1",
          proposals: [
            {
              proposalId: "proposal-acme",
              company: { name: "Acme AI" },
              classification: "supported_ats",
              atsProvider: "greenhouse",
              jobBoardUrl: "https://boards.example/acme",
              version: 3,
            },
          ],
        },
        onCompanyIntent: companyDecision,
      })
    ).resolves.toEqual({ handled: false, completed: false });
    expect(companyDecision).not.toHaveBeenCalled();
  });

  it("keeps a failed company decision active and only refreshes a successful review", async () => {
    const { commitCompanyProposalDecision } = await import("./ChatFirstApp.jsx");
    const intent = {
      type: "company.proposal-decide",
      entity: { type: "company-proposal", id: "proposal-acme" },
      input: { batchId: "batch-1", action: "reject", expectedVersion: 3 },
    };
    const setCompanyProposalReview = vi.fn();

    await expect(
      commitCompanyProposalDecision({
        intent,
        execute: vi.fn(async () => null),
        setCompanyProposalReview,
      })
    ).resolves.toBe(false);
    expect(setCompanyProposalReview).not.toHaveBeenCalled();

    await expect(
      commitCompanyProposalDecision({
        intent,
        execute: vi.fn(async () => ({
          messages: [
            {
              artifacts: [
                {
                  kind: "company_proposals",
                  batchId: "batch-1",
                  proposals: [
                    {
                      proposalId: "proposal-tyrell",
                      company: { name: "Tyrell Systems" },
                      version: 7,
                    },
                  ],
                },
              ],
            },
          ],
        })),
        setCompanyProposalReview,
      })
    ).resolves.toBe(true);
    expect(setCompanyProposalReview).toHaveBeenLastCalledWith(
      expect.objectContaining({ batchId: "batch-1" })
    );
  });

  it("restores only the exact saved review artifact from the active conversation", async () => {
    const { foregroundReviewArtifact } = await import("./ChatFirstApp.jsx");
    const olderCompany = {
      kind: "company_proposals",
      batchId: "batch-older",
      proposals: [{ proposalId: "proposal-older", version: 1 }],
    };
    const newerCompany = {
      kind: "company_proposals",
      batchId: "batch-newer",
      proposals: [{ proposalId: "proposal-newer", version: 1 }],
    };
    const olderSource = normalizeSourceReviewArtifact({
      kind: "source_review",
      candidates: [
        {
          label: "Culinary Agents",
          url: "https://culinaryagents.example/jobs",
          sourceType: "browser",
          why: "NYC hospitality roles",
          status: "proposed",
          confidence: "high",
        },
      ],
    });
    const newerSource = normalizeSourceReviewArtifact({
      kind: "source_review",
      candidates: [
        {
          label: "Hospitality Online",
          url: "https://hospitalityonline.example/jobs",
          sourceType: "url-query",
          why: "Current hospitality roles",
          status: "proposed",
          confidence: "high",
        },
      ],
    });
    const messages = [
      { artifacts: [olderCompany, olderSource] },
      { artifacts: [newerCompany, newerSource] },
    ];

    expect
      .soft(
        foregroundReviewArtifact({
          reviewKind: "company",
          reviewId: olderCompany.batchId,
          messages,
        })
      )
      .toMatchObject({ kind: "company_proposals", batchId: olderCompany.batchId });
    expect
      .soft(
        foregroundReviewArtifact({
          reviewKind: "source",
          reviewId: olderSource.id,
          messages,
        })
      )
      .toMatchObject({ kind: "source_review", id: olderSource.id });
    expect(
      foregroundReviewArtifact({ reviewKind: "company", reviewId: "missing-company", messages })
    ).toBeNull();
    expect(
      foregroundReviewArtifact({ reviewKind: "source", reviewId: "missing-source", messages })
    ).toBeNull();
  });

  it("keeps durable Today artifacts actionable without repeating an activity link", async () => {
    const { ChatFirstAppView } = await import("./ChatFirstApp.jsx");
    const openActivity = vi.fn();
    const openThreadArtifact = vi.fn();
    const buttons = [];
    const tree = ChatFirstAppView({
      view: {
        ...VIEW,
        mainThread: {
          messages: [
            {
              id: "run-with-artifact",
              role: "system",
              kind: "action_result",
              text: "Packet drafted.",
              artifacts: [{ id: "resume", kind: "resume", title: "Tyrell resume" }],
            },
          ],
        },
      },
      ui: BASE_UI,
      composerValue: "",
      sourceSweep: {},
      actions: { openActivity, openThreadArtifact },
    });

    function visit(node) {
      if (!node || typeof node !== "object") return;
      if (Array.isArray(node)) {
        node.forEach(visit);
        return;
      }
      if (typeof node.type === "function") {
        visit(node.type(node.props));
        return;
      }
      if (node.type === "button") buttons.push(node);
      visit(node.props?.children);
    }
    visit(tree);

    expect(buttons.find((button) => button.props.children === "activity")).toBeUndefined();
    buttons.find((button) => button.props.children === "Open").props.onClick();

    expect(openActivity).not.toHaveBeenCalled();
    expect(openThreadArtifact).toHaveBeenCalledWith(
      null,
      expect.objectContaining({ id: "resume" })
    );
  });

  it("mounts an opened company proposal artifact as an in-app review surface", async () => {
    const onIntent = vi.fn();
    const onClose = vi.fn();
    const html = await renderView({
      companyProposalReview: {
        kind: "company_proposals",
        title: "Company discovery: 1 to review",
        batchId: "batch-acme",
        version: 4,
        proposals: [
          {
            proposalId: "proposal-acme",
            company: { name: "Acme AI", domain: "acme.example" },
            roleSeen: "Staff Applied AI Engineer",
            why: "Matches the candidate's applied AI focus.",
            jobBoardUrl: "https://boards.greenhouse.io/acme",
            atsProvider: "greenhouse",
            classification: "supported_ats",
            proposedAction: "approve-supported-ats",
            version: 3,
          },
        ],
      },
      actions: { decideCompanyProposal: onIntent, closeCompanyProposalReview: onClose },
    });

    expect(html).toContain('aria-label="Company discovery: 1 to review"');
    expect(html).toContain("Acme AI");
    expect(html).toContain("Which companies should CareerRat track?");
    expect(html).toContain('type="checkbox"');
    expect(html).toContain(">Save choices<");
    expect(html).not.toContain(">Track<");
    expect(html).not.toContain(">Skip<");
    expect(onIntent).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });

  it("routes the latest typed transcript action to the app controller", async () => {
    const { ChatFirstAppView } = await import("./ChatFirstApp.jsx");
    const runMessageIntent = vi.fn();
    const intent = {
      type: "screening.answer-confirm",
      entity: { type: "application", id: "app-1" },
      input: { question: "Who inspired Curri?", answer: "Mike" },
    };
    const tree = ChatFirstAppView({
      view: {
        ...VIEW,
        mainThread: {
          messages: [
            {
              id: "answer-ready",
              role: "assistant",
              kind: "action_result",
              text: "Review this answer before using it.",
              metadata: { nextActions: [{ label: "Use this answer", intent }] },
            },
          ],
        },
      },
      ui: BASE_UI,
      composerValue: "",
      sourceSweep: {},
      actions: { runMessageIntent },
    });
    const buttons = [];
    function visit(node) {
      if (!node || typeof node !== "object") return;
      if (Array.isArray(node)) {
        node.forEach(visit);
        return;
      }
      if (typeof node.type === "function") {
        visit(node.type(node.props));
        return;
      }
      if (node.type === "button") buttons.push(node);
      visit(node.props?.children);
    }
    visit(tree);

    buttons.find((button) => button.props.children === "Use this answer").props.onClick();
    expect(runMessageIntent).toHaveBeenCalledWith(intent);
  });

  it("replaces the thread workspace with the selected browser surface", async () => {
    const html = await renderView({ ui: { ...BASE_UI, browse: "search", selection: ["s1"] } });

    expect(html).toContain("Workspace browser");
    expect(html).toContain("Tyrell");
    expect(html).toContain("Apply to 1 job");
    expect(html).not.toContain("Conversation threads");
  });

  it("keeps internal tracker notes out of Pipeline and labels the tab by tracked rows", async () => {
    const view = {
      ...VIEW,
      counts: { ...VIEW.counts, pipeline: 2 },
      browser: {
        ...VIEW.browser,
        pipeline: {
          applicationCount: 2,
          rows: [],
          leaks: [],
          jobs: [
            {
              id: "keep-1",
              company: "Keep Co",
              role: "Platform Engineer",
              stage: "Ready to apply",
              note: "gate keep; fit 88",
              statusNote: "Cleared review and ready for preparation.",
              fit: 88,
            },
            {
              id: "review-1",
              company: "Review Co",
              role: "Staff Engineer",
              stage: "Needs review",
              note: "gate review; fit 84",
              fit: 84,
            },
          ],
        },
      },
    };
    const pipeline = await renderView({
      view,
      ui: { ...BASE_UI, browse: "pipeline", pipeView: "list" },
    });
    const threads = await renderView({ view });

    expect(pipeline).toContain("Ready to apply");
    expect(pipeline).toContain("Needs review");
    expect(pipeline).toContain("Cleared review and ready for preparation.");
    expect(pipeline).not.toContain("gate keep; fit 88");
    expect(pipeline).not.toContain("gate review; fit 84");
    expect(threads).toContain("2 tracked");
    expect(threads).not.toContain("0 in play");
  });

  it("renders a durable job conversation and job-scoped context", async () => {
    const html = await renderView({
      view: {
        ...VIEW,
        threads: [{ ...VIEW.threads[0], location: "Remote - United States", mode: "Remote" }],
        jobDetails: {
          "app-1": {
            base: "$185,000 - $215,000",
            compNote: "Clears the stated minimum by $25,000.",
            sourceLabel: "Ashby",
            postedAt: "2026-08-19T12:00:00.000Z",
            statusNote: "Ready for application preparation. Not submitted.",
            nextAction: {
              summary: "Ready for application preparation. Not submitted.",
            },
            roleFit: {
              why: ["React and TypeScript evidence matches"],
              risks: ["No logistics background recorded"],
            },
          },
        },
      },
      ui: { ...BASE_UI, activeThread: "app-1", activeApplicationId: "app-1" },
    });

    expect(html).toContain("E CORP · STAFF SWE · OFFER");
    expect(html).toContain("I drafted the reply.");
    expect(html).toContain("Darlene Alderson · Recruiting");
    expect(html).toContain("Can you talk Friday morning?");
    expect(html).toContain("Approve &amp; copy");
    expect(html).toContain("THIS JOB");
    expect(html).toContain("91");
    expect(html).toContain("$185,000 - $215,000");
    expect(html).toContain("Clears the stated minimum by $25,000.");
    expect(html).toContain("Remote - United States");
    expect(html).not.toContain("Remote - United States · Remote");
    expect(html).toContain("Ashby · posted Aug 19");
    expect(html).toContain("Ready for application preparation. Not submitted.");
    const jobCard = html.match(
      /<section class="chat-first-context-card chat-first-context-card--job">[\s\S]*?<\/section>/
    )?.[0];
    expect(jobCard).toContain("$185,000 - $215,000");
    expect(jobCard).toContain("Clears the stated minimum by $25,000.");
    expect(jobCard).toContain("Remote - United States");
    expect(jobCard).toContain("Ashby · posted Aug 19");
    expect(jobCard).toContain("Ready for application preparation. Not submitted.");
    expect(jobCard).toContain("React and TypeScript evidence matches");
    expect(jobCard).toContain("No logistics background recorded");
    expect(jobCard.match(/Ready for application preparation\. Not submitted\./g)).toHaveLength(1);
    expect(html).not.toContain("Current position");
    expect(html).not.toContain("chat-first-context-card--cream");
    expect(html).not.toContain("Run mock interview");
  });

  it("wires packet-gap review into the job thread and its composer", async () => {
    const packetGap = {
      id: "linkedin-profile",
      questionId: "linkedin-profile",
      label: "LinkedIn Profile",
      answerable: true,
    };
    const html = await renderView({
      view: {
        ...VIEW,
        threads: [
          {
            ...VIEW.threads[0],
            messages: [],
            communications: [],
            packetReview: {
              status: "reviewable",
              uploadReady: false,
              gapCount: 1,
              canResume: false,
              gaps: [packetGap],
            },
          },
        ],
      },
      ui: { ...BASE_UI, activeThread: "app-1", activeApplicationId: "app-1" },
      packetAnswerGap: packetGap,
    });

    expect(html).toContain("I need 1 application answer before I can continue");
    expect(html).toContain("APPLICATION ANSWERS · 1 NEEDED");
    expect(html).toContain('placeholder="Answer LinkedIn Profile…"');
  });

  it("keeps packet resume behind a clear application-preparation permission action", async () => {
    const html = await renderView({
      view: {
        ...VIEW,
        threads: [
          {
            ...VIEW.threads[0],
            packetReview: {
              status: "upload-ready",
              uploadReady: true,
              gapCount: 0,
              canResume: true,
              gaps: [],
            },
          },
        ],
      },
      ui: { ...BASE_UI, activeThread: "app-1", activeApplicationId: "app-1" },
      actions: {
        applicationPreparation: { status: "blocked", ready: false },
      },
    });

    expect(html).toContain("Allow form preparation");
    expect(html).not.toContain("Resume preparation");
  });

  it("labels each canonical job date by what happened", async () => {
    for (const [field, expected] of [
      ["sourcedAt", "Ashby · found Aug 20"],
      ["appliedAt", "Ashby · applied Aug 21"],
    ]) {
      const html = await renderView({
        view: {
          ...VIEW,
          jobDetails: {
            "app-1": {
              sourceLabel: "Ashby",
              [field]: field === "sourcedAt" ? "2026-08-20T12:00:00.000Z" : "2026-08-21",
            },
          },
        },
        ui: { ...BASE_UI, activeThread: "app-1", activeApplicationId: "app-1" },
      });

      expect(html).toContain(expected);
    }
  });

  it("offers a first-class mock interview from a reviewed saved job", async () => {
    const html = await renderView({
      view: {
        ...VIEW,
        threads: [{ ...VIEW.threads[0], stage: "reviewed hold" }],
      },
      ui: { ...BASE_UI, activeThread: "app-1", activeApplicationId: "app-1" },
    });

    expect(html).toContain("Run mock interview");
  });

  it("offers a mock interview when a promoted job is ready to apply", async () => {
    const html = await renderView({
      view: {
        ...VIEW,
        threads: [{ ...VIEW.threads[0], stage: "Ready to apply" }],
      },
      ui: { ...BASE_UI, activeThread: "app-1", activeApplicationId: "app-1" },
    });

    expect(html).toContain("Run mock interview");
  });

  it("renders a visible research thread with streamed activity, typed save/discard controls, and durable results", async () => {
    const html = await renderView({
      view: {
        ...VIEW,
        skillChats: [
          {
            id: "skill:research-company",
            skill: "research-company",
            title: "Researching Acme",
            subtitle: "research complete · review the result",
            state: "idle",
          },
        ],
      },
      ui: { ...BASE_UI, activeThread: "skill:research-company" },
      activeSkillChat: {
        id: "skill:research-company",
        skill: "research-company",
        title: "Researching Acme",
        state: "idle",
        messages: [
          { id: "activity", role: "system", kind: "status", text: "Searching the web" },
          {
            id: "result",
            role: "assistant",
            kind: "text",
            text: "Research is ready.",
            artifacts: [
              {
                id: "discovery:company:acme",
                kind: "company_research_result",
                title: "Acme research",
                subtitle: "cited research ready to review",
              },
            ],
          },
          {
            id: "saved",
            role: "system",
            kind: "action_result",
            text: "Saved research for Acme to your workspace.",
          },
        ],
      },
    });

    expect(html).toContain("RESEARCHING ACME");
    expect(html).toContain("Searching the web");
    expect(html).toContain("Research is ready.");
    expect(html).toContain("Save to workspace");
    expect(html).toContain("Discard");
    expect(html).toContain("Saved research for Acme to your workspace.");
    expect(html).toContain("Research runs stay in this thread");
  });

  it("opens board candidates in one dedicated source-review overlay", async () => {
    const sourceReview = normalizeSourceReviewArtifact({
      kind: "source_review",
      candidates: [
        {
          label: "LandEarly",
          url: "https://www.landearly.com/remote-jobs/platform-engineer",
          sourceType: "url-query",
          why: "Dated US platform roles",
          status: "proposed",
          confidence: "high",
        },
        {
          label: "Anywhere Devs",
          url: "https://anywheredevs.com/",
          sourceType: "browser",
          why: "No specific listings were visible",
          status: "rejected",
          rejectionReason: "no visible dated listing",
        },
      ],
    });
    const html = await renderView({
      view: {
        ...VIEW,
        skillChats: [
          {
            id: "skill:research-boards",
            skill: "research-boards",
            title: "Job board discovery",
            state: "idle",
          },
        ],
      },
      ui: { ...BASE_UI, activeThread: "skill:research-boards" },
      activeSkillChat: {
        id: "skill:research-boards",
        skill: "research-boards",
        title: "Job board discovery",
        state: "idle",
        messages: [
          {
            id: "review",
            role: "assistant",
            kind: "text",
            text: "I found 1 useful source. Nothing has been added yet.",
            artifacts: [sourceReview],
          },
        ],
      },
      sourceReview,
    });

    expect(html).toContain("1 source found");
    expect(html).toContain("Review sources");
    expect(html).toContain('role="dialog"');
    expect(html).toContain("1 source to review");
    expect(html).toContain("Anywhere Devs");
    expect(html).toContain("no visible dated listing");
  });

  it("disables the composer while a selected research thread is reopening", async () => {
    const html = await renderView({
      view: {
        ...VIEW,
        skillChats: [
          {
            id: "skill:research-company",
            skill: "research-company",
            title: "Researching Acme",
            state: "idle",
          },
        ],
      },
      ui: { ...BASE_UI, activeThread: "skill:research-company" },
      composerValue: "Continue the research",
      activeSkillChat: {
        id: "skill:research-company",
        skill: "research-company",
        title: "Researching Acme",
        chatId: null,
        state: "idle",
        messages: [],
      },
    });

    expect(html).toMatch(/aria-label="Message Paul"[^>]*disabled=""/);
    expect(html).toMatch(/aria-label="Send message"[^>]*disabled=""/);
  });

  it("renders structured canonical next actions as readable job context", async () => {
    const html = await renderView({
      view: {
        ...VIEW,
        jobDetails: {
          "app-1": {
            floor: 215,
            marketP50: 235,
            ask: 240,
            nextAction: {
              state: "needs-action",
              label: "Follow-up",
              title: "Follow up",
              summary: "Respond to the E Corp offer this week.",
              dueText: "2 days",
            },
          },
        },
      },
      ui: { ...BASE_UI, activeThread: "app-1", activeApplicationId: "app-1" },
    });

    expect(html).toContain("Respond to the E Corp offer this week.");
    expect(html).toContain("your floor $215k · market midpoint $235k · target $240k");
    expect(html).toContain("<small>NEGOTIATION</small>");
    expect(html).not.toContain("Negotiation position");
    expect(html).not.toContain("[object Object]");
  });

  it("renders deep ingest and its evidence context inside the same shell", async () => {
    const html = await renderView({
      ui: { ...BASE_UI, activeThread: "ingest" },
      deepIngest: { evidenceItems: ["6 roles", "14 stories"], lastSession: "resume.pdf" },
    });

    expect(html).toContain("DEEP INGEST");
    expect(html).toContain("drop files here");
    expect(html).toContain("14 stories");
    expect(html).toContain("Pause");
  });

  it("renders deep ingest review state from the durable view model", async () => {
    const html = await renderView({
      ui: { ...BASE_UI, activeThread: "ingest" },
      deepIngest: {
        evidenceItems: ["3 confirmed items"],
        counts: { sources: 2, proposals: 4, reviewQueue: 1, confirmed: 3 },
        sources: [
          {
            id: "source-1",
            label: "Pasted notes: billing migration",
            statusLabel: "Ready to analyze",
            canAnalyze: true,
          },
        ],
        proposals: [
          {
            id: "proposal-1",
            lane: "story_bank",
            title: "Billing migration",
            summary: "Led a billing migration.",
            supportingQuote: "Reduced reconciliation time by 31%.",
          },
        ],
        receipt: "Analysis complete. 1 proposal needs review.",
      },
    });

    expect(html).toContain("Analysis complete. 1 proposal needs review.");
    expect(html).toContain("Billing migration");
    expect(html).toContain("Ready to analyze");
    expect(html).toContain("1 to review");
  });

  it("renders the live mock session with the owning job still active", async () => {
    const html = await renderView({
      ui: { ...BASE_UI, activeThread: "mock", activeApplicationId: "app-1" },
      mockSession: {
        id: "mock-1",
        questionNumber: 2,
        totalQuestions: 6,
        question: "Why E Corp?",
        worked: "Specific story",
        tighten: "Lead with impact",
        loadedContext: "Job description · confirmed story bank",
      },
    });

    expect(html).toContain("MOCK INTERVIEW · E CORP CONTEXT · QUESTION 2 OF 6");
    expect(html).toContain("Why E Corp?");
    expect(html).toContain("Specific story");
    expect(html).toContain("LIVE SESSION");
    expect(html).toContain("Job description · confirmed story bank");
    expect(html).not.toContain("Job description, dossier, and confirmed story bank");
    expect(html).toContain('aria-current="page"');
  });

  it("reopens an active durable mock from its owning job instead of starting another session", async () => {
    const html = await renderView({
      view: {
        ...VIEW,
        threads: [{ ...VIEW.threads[0], stage: "technical" }],
      },
      ui: { ...BASE_UI, activeThread: "app-1", activeApplicationId: "app-1" },
      mockSession: {
        id: "mock-existing",
        applicationId: "app-1",
        status: "active",
        questionReady: true,
      },
    });

    expect(html).toContain("Continue mock interview");
    expect(html).not.toContain("Run mock interview");
  });

  it("shows an ended mock on its job thread and reopens the complete transcript after reload", async () => {
    const endedMock = {
      id: "mock-ended",
      applicationId: "app-1",
      status: "ended",
      summary: "Strong evidence. Tighten the tradeoff.",
      questionReady: true,
      questionNumber: 2,
      totalQuestions: 2,
      question: "Describe the migration.",
      turns: [
        {
          questionNumber: 1,
          question: "Why this role?",
          answer: "The product fit.",
          worked: "Specific motivation",
          tighten: "Name the user",
        },
        {
          questionNumber: 2,
          question: "Describe the migration.",
          answer: "I led three teams.",
          worked: "Clear ownership",
          tighten: "Explain the tradeoff",
        },
      ],
    };
    const jobHtml = await renderView({
      view: { ...VIEW, threads: [{ ...VIEW.threads[0], stage: "technical" }] },
      ui: { ...BASE_UI, activeThread: "app-1", activeApplicationId: "app-1" },
      mockSession: endedMock,
    });
    const transcriptHtml = await renderView({
      ui: { ...BASE_UI, activeThread: "mock", activeApplicationId: "app-1" },
      mockSession: endedMock,
    });

    expect(jobHtml).toContain("Review mock interview");
    expect(transcriptHtml).toContain("SESSION COMPLETE");
    expect(transcriptHtml).toContain("Strong evidence. Tighten the tradeoff.");
    expect(transcriptHtml).toContain("Why this role?");
    expect(transcriptHtml).toContain("The product fit.");
    expect(transcriptHtml).toContain("Specific motivation");
    expect(transcriptHtml).toContain("Describe the migration.");
    expect(transcriptHtml).toContain("I led three teams.");
    expect(transcriptHtml).toContain("Explain the tradeoff");
    expect(transcriptHtml).not.toContain('aria-label="Message Paul"');
  });

  it("shows a disabled preparing state while question one is still generating", async () => {
    const html = await renderView({
      view: { ...VIEW, threads: [{ ...VIEW.threads[0], stage: "technical" }] },
      ui: { ...BASE_UI, activeThread: "app-1", activeApplicationId: "app-1" },
      mockSession: {
        id: "mock-preparing",
        applicationId: "app-1",
        status: "active",
        questionReady: false,
        question: null,
      },
    });

    expect(html).toContain("Preparing first question…");
    expect(html).toMatch(/Preparing first question…<\/button>/);
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Preparing first question…<\/button>/);
    expect(html).not.toContain("Continue mock interview");
    expect(html).not.toContain("Tell me about the experience most relevant to this role.");
  });

  it("offers an explicit resume action for a durable paused mission", async () => {
    const html = await renderView({
      view: {
        ...VIEW,
        missions: [
          {
            ...VIEW.missions[0],
            steps: [
              { id: "packet", label: "Draft E Corp packet", status: "completed" },
              { id: "prepare", label: "Prepare E Corp form", status: "pending" },
            ],
          },
        ],
      },
    });

    expect(html).toContain(">resume</button>");
    expect(html).not.toContain(">pause</button>");
  });

  it("mounts the submit gate, artifact viewer, and engine-down cover as real overlays", async () => {
    const html = await renderView({
      activeGate: {
        company: "E Corp",
        role: "Staff SWE",
        channel: "Greenhouse",
        packet: [{ id: "resume", name: "resume.pdf" }],
      },
      artifactViewer: { title: "Resume preview", artifact: { html: "<p>Resume</p>" } },
      engineDown: true,
    });

    expect(html).toContain("Submit to E Corp");
    expect(html).toContain("Nothing sends until you press submit");
    expect(html).toContain("viewer:Resume preview");
    expect(html).toContain("Paul can&#x27;t think right now");
  });

  it("wires durable company and Deep operation owners without route-owned background state", async () => {
    const source = await readFile(new URL("./ChatFirstApp.jsx", import.meta.url), "utf8");

    expect(source).toContain("createDeepIngestOperationController({");
    expect(source).toContain("readDeepIngestOperation(deepOperationStorage)");
    expect(source).toContain('if (ui.activeThread !== "ingest") return;');
    expect(source).toContain("controller: deepOperationController");
    expect(source).toContain("uploadDeepIngestFilesAndRefresh({");
    expect(source).toContain("companyDiscoveryChildFromWorkspaceResult({");
    expect(source).toContain("followCompanyDiscoveryOperation({");
    expect(source).toContain("companyProposalBatchIsResolved(batch)");
    expect(source).toContain("readWorkspaceOperationId(workspaceOperationStorage)");
    expect(source).toContain("rememberWorkspaceOperation(workspaceOperationStorage, exactId)");
    expect(source).toContain("const id = workspaceOperationId;");
    expect(source).toContain('ui.activeThread === "ingest" && deepBusy');
    expect(source).not.toContain(
      "runDeepOperation = useCallback(\n    async (operation, receiptFor) => {\n      setBusy(true)"
    );
  });
});
