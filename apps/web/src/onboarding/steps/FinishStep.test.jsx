import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as Api from "../../lib/api.js";

const dashboardMock = vi.hoisted(() => ({
  snapshot: {
    data: null,
    noDatabase: false,
    refetch: async () => {},
  },
}));

const chatMock = vi.hoisted(() => ({
  renders: [],
}));

vi.mock("../../app-shell/DashboardContext.jsx", () => ({
  useDashboardSnapshot: () => dashboardMock.snapshot,
}));

vi.mock("../ChatPanel.jsx", () => ({
  ChatPanel: ({ skill, initialChatId }) => {
    chatMock.renders.push({ skill, initialChatId });
    return (
      <div data-testid="chat-marker">
        CHAT:{skill}:{initialChatId}
      </div>
    );
  },
}));

import * as FinishStepModule from "./FinishStep.jsx";

const { buildQuickStartAction, buildReadinessRows, FinishStep } = FinishStepModule;

const FORBIDDEN_FIRST_SEARCH_TOKENS = [
  "chat",
  "skill",
  "research-boards",
  "discover-companies",
  "search-jobs",
  "/api/chat",
  "/api/skill/run",
];

const SEARCH_READY_STATE = {
  data: {
    setup: {
      readiness: {
        search_ready: true,
        gate_ready: false,
        apply_ready: false,
        deep_ingest_complete: false,
      },
      missing: {
        search_ready: [],
        gate_ready: ["compensation floor"],
        apply_ready: ["evidence claims"],
        deep_ingest_complete: ["deeper evidence bank"],
      },
    },
    sourcing: {
      sourceSetup: {
        deterministicSources: { attempted: 1, rss: 1, supportedAtsCompanies: 0, skipped: 0 },
      },
    },
    targeting: {
      search_preferences: {},
    },
  },
  searchSourcesPresent: true,
};

function stateWithFirstSearch(firstSearchRun, extra = {}) {
  return {
    ...SEARCH_READY_STATE,
    ...extra,
    data: {
      ...SEARCH_READY_STATE.data,
      ...(extra.data || {}),
      firstSearchRun,
      sourcing: {
        ...(SEARCH_READY_STATE.data.sourcing || {}),
        ...(extra.data?.sourcing || {}),
        firstSearchRun,
      },
    },
    firstSearchRun,
  };
}

function renderFinish(state = SEARCH_READY_STATE) {
  dashboardMock.snapshot = {
    data: null,
    noDatabase: false,
    refetch: async () => {},
  };
  chatMock.renders = [];

  return renderToStaticMarkup(
    <MemoryRouter>
      <FinishStep
        state={state}
        aiEnabled={true}
        runtimeCapabilities={{ discoveryChatHandoffs: false, aiAvailable: true }}
        reload={async () => {}}
        goBack={() => {}}
      />
    </MemoryRouter>
  );
}

function expectNoFirstSearchRuntimeTokens(markup) {
  const lowerMarkup = markup.toLowerCase();
  const start = lowerMarkup.indexOf("first search");
  const end = lowerMarkup.indexOf("</section>", start);
  const lower =
    start === -1 ? lowerMarkup : markup.slice(start, end === -1 ? undefined : end).toLowerCase();
  for (const token of FORBIDDEN_FIRST_SEARCH_TOKENS) {
    expect(lower, `first-search UI leaked ${token}`).not.toContain(token.toLowerCase());
  }
  expect(chatMock.renders).toEqual([]);
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

describe("buildReadinessRows", () => {
  it("maps staged DB setup readiness without merging search/gate/apply gates", () => {
    const rows = buildReadinessRows(SEARCH_READY_STATE);

    expect(rows).toEqual([
      {
        key: "search_ready",
        label: "Search",
        status: "Ready",
        detail: "Rolester can start sourcing roles now.",
        ready: true,
      },
      {
        key: "gate_ready",
        label: "Gate",
        status: "Needs setup",
        detail: "Needs compensation floor.",
        ready: false,
      },
      {
        key: "apply_ready",
        label: "Apply",
        status: "Needs setup",
        detail: "Needs evidence claims.",
        ready: false,
      },
      {
        key: "deep_ingest_complete",
        label: "Deep ingest",
        status: "Needs setup",
        detail: "Needs deeper evidence bank.",
        ready: false,
      },
    ]);
  });
});

describe("buildQuickStartAction", () => {
  it("prompts for first deterministic search while keeping stricter readiness caveats visible", () => {
    const action = buildQuickStartAction(SEARCH_READY_STATE);

    expect(action).toEqual({
      enabled: true,
      label: "Search jobs now",
      detail:
        "Rolester can start the first deterministic search now. Gate and apply stay locked until compensation floor and evidence claims are complete.",
    });
  });

  it("does not offer first search until search-ready fields are complete", () => {
    const action = buildQuickStartAction({
      data: {
        setup: {
          readiness: { search_ready: false },
          missing: {
            search_ready: ["source resume", "role titles"],
          },
        },
      },
    });

    expect(action).toEqual({
      enabled: false,
      label: "Complete Search setup",
      detail: "Needs source resume and role titles.",
    });
  });
});

describe("first-search API wrappers", () => {
  it("startFirstSearchRun targets POST /api/sourcing/first-run/start", async () => {
    expect(Api.startFirstSearchRun).toBeTypeOf("function");
    const fetchMock = vi.fn(async () => {
      return new Response(JSON.stringify({ ok: true, run: { id: "run-1", status: "running" } }), {
        status: 202,
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const body = await Api.startFirstSearchRun();

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/sourcing/first-run/start",
      expect.objectContaining({ method: "POST" })
    );
    expect(body.run.status).toBe("running");
  });
});

describe("FinishStep first-search setup task", () => {
  it("renders cadence choices, default recommendation copy, and a yes-by-default search prompt", () => {
    const html = renderFinish(stateWithFirstSearch({ status: "not_started" }));

    expect(html).toContain("Search now?");
    expect(html).toContain("Daily");
    expect(html).toContain("Every 3 days");
    expect(html).toContain("Weekly");
    expect(html).toContain("Manual only");
    expect(html).toContain("Default recommendation - no local history yet");
    expect(html).toContain("Search jobs now");
    expect(html).toContain("Not now");
    expect(html).toContain("Not started");
    expect(html).toContain("Open Deep ingest");
    expect(html).toContain('href="/deep-ingest"');
    expect(html).not.toContain("Start the deeper interview");
    expectNoFirstSearchRuntimeTokens(html);
  });

  it("does not enable first search when explicit deterministic source counts are zero", () => {
    const task = FinishStepModule.buildFirstSearchTask({
      state: stateWithFirstSearch(
        { status: "not_started" },
        {
          searchSourcesPresent: true,
          deterministicSources: { attempted: 0, rss: 0, supportedAtsCompanies: 0, skipped: 1 },
          data: {
            sourcing: {
              sourceSetup: {
                deterministicSources: {
                  attempted: 0,
                  rss: 0,
                  supportedAtsCompanies: 0,
                  skipped: 1,
                },
              },
            },
          },
        }
      ),
      run: { status: "not_started" },
    });

    expect(task.canStart).toBe(false);
    expect(task.canDefer).toBe(false);
    expect(task.detail).toContain("Add an RSS source or supported public ATS company");
  });

  it("enables first search when supported ATS-only source setup is runnable", () => {
    const task = FinishStepModule.buildFirstSearchTask({
      state: stateWithFirstSearch(
        { status: "not_started" },
        {
          searchSourcesPresent: true,
          deterministicSources: { attempted: 1, rss: 0, supportedAtsCompanies: 1, skipped: 0 },
          data: {
            sourcing: {
              sourceSetup: {
                deterministicSources: {
                  attempted: 1,
                  rss: 0,
                  supportedAtsCompanies: 1,
                  skipped: 0,
                },
              },
            },
          },
        }
      ),
      run: { status: "not_started" },
    });

    expect(task.canStart).toBe(true);
    expect(task.canDefer).toBe(true);
  });

  it("keeps existing first-search runs visible even if current deterministic counts are zero", () => {
    expect(
      FinishStepModule.isSourceSetupReady({
        state: stateWithFirstSearch(
          { status: "running" },
          {
            deterministicSources: { attempted: 0, rss: 0, supportedAtsCompanies: 0, skipped: 1 },
            data: {
              sourcing: {
                sourceSetup: {
                  deterministicSources: {
                    attempted: 0,
                    rss: 0,
                    supportedAtsCompanies: 0,
                    skipped: 1,
                  },
                },
              },
            },
          }
        ),
        firstSearchRun: { status: "running" },
      })
    ).toBe(true);
  });

  it("persists a non-default cadence before starting the first search", async () => {
    expect(FinishStepModule.saveCadenceAndStartFirstSearch).toBeTypeOf("function");
    const calls = [];

    await FinishStepModule.saveCadenceAndStartFirstSearch({
      mode: "every-3-days",
      existingSearchPreferences: { posting_age: { mode: "since-last-run" } },
      now: () => "2026-07-05T22:30:00.000Z",
      saveCandidateFile: async (name, patch) => {
        calls.push(["save", name, patch]);
        return { ok: true };
      },
      startFirstSearchRun: async () => {
        calls.push(["start"]);
        return { ok: true, run: { id: "run-2", status: "running" } };
      },
    });

    expect(calls).toEqual([
      [
        "save",
        "targeting",
        {
          search_preferences: {
            posting_age: { mode: "since-last-run" },
            cadence: {
              mode: "every-3-days",
              recommended_from: "default",
              saved_at: "2026-07-05T22:30:00.000Z",
            },
          },
        },
      ],
      ["start"],
    ]);
  });

  it("saves cadence without starting a run when the user chooses Not now", async () => {
    expect(FinishStepModule.saveCadencePreference).toBeTypeOf("function");
    const calls = [];

    await FinishStepModule.saveCadencePreference({
      mode: "manual",
      existingSearchPreferences: { posting_age: { mode: "fixed-days", days: 7 } },
      now: () => "2026-07-05T22:45:00.000Z",
      saveCandidateFile: async (name, patch) => {
        calls.push(["save", name, patch]);
        return { ok: true };
      },
    });

    expect(calls).toEqual([
      [
        "save",
        "targeting",
        {
          search_preferences: {
            posting_age: { mode: "fixed-days", days: 7 },
            cadence: {
              mode: "manual",
              recommended_from: "default",
              saved_at: "2026-07-05T22:45:00.000Z",
            },
          },
        },
      ],
    ]);
  });

  it("starts first search before continuing deep onboarding when Search now is selected", async () => {
    expect(FinishStepModule.continueDeepOnboardingAction).toBeTypeOf("function");
    const calls = [];

    const result = await FinishStepModule.continueDeepOnboardingAction({
      firstSearchTask: { canStart: true },
      searchChoice: "now",
      startFirstSearch: async () => {
        calls.push("start");
      },
      deferFirstSearch: async () => {
        calls.push("defer");
      },
    });

    expect(result).toBe("started");
    expect(calls).toEqual(["start"]);
  });

  it("blocks deep onboarding handoff when the first search start fails", async () => {
    const result = await FinishStepModule.continueDeepOnboardingAction({
      firstSearchTask: { canStart: true },
      searchChoice: "now",
      startFirstSearch: async () => false,
    });

    expect(result).toBe("blocked");
  });

  it("records the explicit Not now choice before continuing deep onboarding", async () => {
    const calls = [];

    const result = await FinishStepModule.continueDeepOnboardingAction({
      firstSearchTask: { canStart: true },
      searchChoice: "later",
      startFirstSearch: async () => {
        calls.push("start");
      },
      deferFirstSearch: async () => {
        calls.push("defer");
      },
    });

    expect(result).toBe("deferred");
    expect(calls).toEqual(["defer"]);
  });

  it("renders saved cadence as compact text after state refresh", () => {
    const html = renderFinish(
      stateWithFirstSearch(
        { status: "not_started" },
        {
          data: {
            targeting: {
              search_preferences: {
                cadence: { mode: "every-3-days" },
              },
            },
          },
        }
      )
    );

    expect(html).toContain("Cadence: Every 3 days");
  });

  it("keeps deep onboarding available while the first search is running", () => {
    const html = renderFinish(stateWithFirstSearch({ status: "running" }));

    expect(html).toContain("Running");
    expect(html).toContain("Searching deterministic public sources...");
    expect(html).toContain("Continue deep onboarding");
    expectNoFirstSearchRuntimeTokens(html);
  });

  it("shows completed run counts and sourced-role navigation", () => {
    const html = renderFinish(
      stateWithFirstSearch({
        status: "completed",
        summary: { sourcesAttempted: 3, rolesFound: 2 },
      })
    );

    expect(html).toContain("Completed");
    expect(html).toContain("3 sources attempted");
    expect(html).toContain("2 roles found");
    expect(html).toContain("View sourced roles");
    expectNoFirstSearchRuntimeTokens(html);
  });

  it("shows truthful zero-result completed copy without a sourced-role link", () => {
    const html = renderFinish(
      stateWithFirstSearch({
        status: "completed",
        summary: { sourcesAttempted: 3, rolesFound: 0 },
      })
    );

    expect(html).toContain("Completed");
    expect(html).toContain("3 sources attempted");
    expect(html).toContain("0 roles found");
    expect(html).toContain(
      "Search completed. No matching roles found yet; refine titles or add a source, then search again from Jobs."
    );
    expect(html).not.toContain("View sourced roles");
    expectNoFirstSearchRuntimeTokens(html);
  });

  it("shows actionable failed state copy and retry starts a new first-run request", async () => {
    const html = renderFinish(
      stateWithFirstSearch({
        status: "failed",
        error: { message: "No deterministic sources were fetchable." },
      })
    );

    expect(html).toContain("Failed");
    expect(html).toContain(
      "First search failed. Review the source setup message, fix the issue, then retry."
    );
    expect(html).toContain("No deterministic sources were fetchable.");
    expect(html).toContain("Retry search");
    expectNoFirstSearchRuntimeTokens(html);

    expect(FinishStepModule.retryFirstSearch).toBeTypeOf("function");
    let displayedRun = null;
    let retryPayload = null;
    const result = await FinishStepModule.retryFirstSearch({
      startFirstSearchRun: async (payload) => {
        retryPayload = payload;
        return {
          ok: true,
          run: { id: "run-retry", status: "running" },
        };
      },
      setFirstSearchRun: (run) => {
        displayedRun = run;
      },
    });

    expect(retryPayload).toEqual({ retry: true });
    expect(result.run.status).toBe("running");
    expect(displayedRun).toEqual({ id: "run-retry", status: "running" });
  });
});

describe("FinishStep Deep ingest readiness", () => {
  it("links incomplete Deep ingest readiness to the workbench without interview or chat copy", () => {
    const html = renderFinish({
      ...SEARCH_READY_STATE,
      data: {
        ...SEARCH_READY_STATE.data,
        setup: {
          readiness: {
            ...SEARCH_READY_STATE.data.setup.readiness,
            deep_ingest_complete: false,
          },
          missing: {
            ...SEARCH_READY_STATE.data.setup.missing,
            deep_ingest_complete: ["4 of 7 lanes terminal", "Role signal needs source"],
          },
        },
        deepIngest: {
          readiness: {
            ready: false,
            terminalCount: 4,
            requiredCount: 7,
            todos: [{ lane: "role_signals", reason: "Role signal needs source" }],
            gaps: [{ lane: "story_bank", reason: "Login-gated source deferred" }],
          },
        },
      },
    });

    expect(html).toContain("Deep ingest");
    expect(html).toContain("4 of 7 lanes terminal");
    expect(html).toContain("Open Deep ingest");
    expect(html).toContain('href="/deep-ingest"');
    expect(html).not.toContain("AI interview");
    expect(html).not.toContain("guided interview");
    expect(html).not.toContain("deeper interview");
    expect(html).not.toContain('href="/chat"');
    expect(html).not.toContain("/api/chat");
    expect(html).not.toContain("/api/skill/run");
  });
});
