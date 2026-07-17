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
const capturedButtons = vi.hoisted(() => []);

vi.mock("../../app-shell/DashboardContext.jsx", () => ({
  useDashboardSnapshot: () => dashboardMock.snapshot,
}));

vi.mock("../../components/Button.jsx", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    Button: (props) => {
      capturedButtons.push(props);
      return actual.Button(props);
    },
  };
});

import * as FinishStepModule from "./FinishStep.jsx";

const { FinishStep } = FinishStepModule;

const SEARCH_READY_STATE = {
  sourceResumePresent: true,
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

function renderFinish(state = SEARCH_READY_STATE, props = {}) {
  dashboardMock.snapshot = {
    data: null,
    noDatabase: false,
    refetch: async () => {},
  };

  return renderToStaticMarkup(
    <MemoryRouter>
      <FinishStep
        state={state}
        aiEnabled={true}
        runtimeCapabilities={{ aiAvailable: true }}
        reload={async () => {}}
        goBack={() => {}}
        {...props}
      />
    </MemoryRouter>
  );
}

function countOccurrences(value, token) {
  return (value.match(new RegExp(token, "g")) || []).length;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.unstubAllGlobals();
  capturedButtons.length = 0;
});

describe("FinishStep resume gate", () => {
  it("renders the blocked notice and routes its action back to the Resume step", () => {
    const onProgressSelect = vi.fn();
    const html = renderFinish(
      { ...SEARCH_READY_STATE, sourceResumePresent: false },
      { onProgressSelect }
    );

    expect(html).toContain("Résumé required");
    expect(html).toContain("Import it before finishing setup.");
    expect(html).toContain("Go to Resume step");
    expect(html).not.toContain("Go deeper while Roland searches");

    const resumeButton = capturedButtons.find((props) => props.children === "Go to Resume step");
    expect(resumeButton).toBeTruthy();
    resumeButton.onClick();
    expect(onProgressSelect).toHaveBeenCalledWith(2);
  });

  it("renders normal finish content when a source resume exists", () => {
    const html = renderFinish({ ...SEARCH_READY_STATE, sourceResumePresent: true });

    expect(html).toContain("Go deeper while Roland searches");
    expect(html).toContain("Search cadence");
    expect(html).not.toContain("Résumé required");
  });
});

describe("FinishStep shell layout", () => {
  it("renders as a standard two-panel Step 7 card in the onboarding shell", () => {
    const html = renderFinish();

    expect(html).toContain('class="onboarding-shell onboarding-shell--targeting"');
    expect(countOccurrences(html, "onboarding-progress__case--filled")).toBe(8);
    expect(html).toContain('class="onboarding-step-stack onboarding-step-stack--targeting"');
    expect(html).toContain('class="onboarding-step-label">Step 7');
    expect(html).toContain('class="onboarding-step-card onboarding-targeting onboarding-finish"');
    expect(html).toContain('class="onboarding-shell__actions"');
    expect(html).toContain('aria-label="Back"');
    expect(html).toContain('aria-label="Finish"');
    expect(html).toContain("onboarding-nav-button--back");
    expect(html).toContain("onboarding-nav-button--next");
    expect(html).not.toContain(">Back<");
    expect(html).not.toContain(">Finish<");
    expect(html).not.toContain("wizard-actions");
  });

  it("uses the shared icon-tile + serif-title media panel with completion copy", () => {
    const html = renderFinish();

    expect(html).toContain('class="onboarding-targeting__mark" aria-hidden="true">📊');
    expect(html).toContain('<h1 id="finish-title">');
    expect(html).toContain("all set");
    expect(html).toContain("kicking off your first search");
  });

  it("removes the Setup readiness checklist and every diagnostic/compat affordance", () => {
    const html = renderFinish();

    expect(html).not.toContain("Setup readiness");
    expect(html).not.toContain("Needs setup");
    expect(html).not.toContain("lanes terminal");
    expect(html).not.toContain("Compatibility export");
    expect(html).not.toContain("Export compatibility files");
    expect(html).not.toContain("write-config");
    expect(html).not.toContain("What's next");
    expect(html).not.toContain("Open Deep ingest");
    expect(html).not.toContain("Go to Settings");
    expect(html).not.toContain("Add your LinkedIn saved search");
    expect(html).not.toContain("board-preview");
    expect(html).not.toContain("RSS");
  });
});

describe("FinishStep first-search status line", () => {
  it("shows the starting line before any run exists", () => {
    const html = renderFinish(stateWithFirstSearch({ status: "not_started" }));

    expect(html).toContain("Starting your first search");
    expect(html).not.toContain("RSS");
  });

  it("shows a running line without exposing source-plumbing detail", () => {
    const html = renderFinish(stateWithFirstSearch({ status: "running" }));

    expect(html).toContain("First search is running");
    expect(html).toContain("fresh roles will land in Jobs");
    expect(html).not.toContain("Searching deterministic public sources");
    expect(html).not.toContain("RSS");
  });

  it("shows a completed line when roles were found", () => {
    const html = renderFinish(
      stateWithFirstSearch({
        status: "completed",
        summary: { sourcesAttempted: 3, rolesFound: 2 },
      })
    );

    expect(html).toContain("First search is done — fresh roles are in Jobs.");
    expect(html).not.toContain("RSS");
  });

  it("shows a truthful zero-result completed line", () => {
    const html = renderFinish(
      stateWithFirstSearch({
        status: "completed",
        summary: { sourcesAttempted: 3, rolesFound: 0 },
      })
    );

    expect(html).toContain("No matches yet");
    expect(html).not.toContain("RSS");
  });

  it("shows the fixed source-error copy and a Try again control on failure, never the raw server message", () => {
    const html = renderFinish(
      stateWithFirstSearch({
        status: "failed",
        error: { message: "No deterministic sources were fetchable." },
      })
    );

    expect(html).toContain(
      "Couldn&#x27;t reach any of your companies&#x27; job boards yet — retry below, or run a search from the Jobs tab anytime."
    );
    expect(html).toContain("Try again");
    expect(html).not.toContain("No deterministic sources were fetchable.");
    expect(html).not.toContain("RSS");
  });
});

describe("FinishStep deep-ingest hero", () => {
  it("renders the CTA using existing panel grammar with a primary action and a quiet finish link", () => {
    const html = renderFinish();

    expect(html).toContain(
      'class="onboarding-targeting__signal-panel onboarding-targeting__signal-panel--quiet onboarding-finish__hero"'
    );
    expect(html).toContain("Go deeper while Roland searches");
    expect(html).toContain(
      "A guided ingest of your work history makes packets and applications much stronger."
    );
    expect(html).toContain(">Start deep ingest<");
    expect(html).toContain("do it later");
  });
});

describe("FinishStep cadence row", () => {
  it("renders quiet cadence pills with a Most popular tag on Daily and no recommendation echo", () => {
    const html = renderFinish();

    expect(html).toContain("Search cadence");
    expect(html).toContain("Daily");
    expect(html).toContain("Every 3 days");
    expect(html).toContain("Weekly");
    expect(html).toContain("Manual only");
    expect(html).toContain("Most popular");
    expect(html).not.toContain("Default recommendation");
    expect(html).not.toContain("Recommended from recent search history");
    expect(html).not.toContain("Cadence: Daily");
  });

  it("marks the saved cadence as the selected pill", () => {
    const html = renderFinish(
      stateWithFirstSearch(
        { status: "not_started" },
        { data: { targeting: { search_preferences: { cadence: { mode: "every-3-days" } } } } }
      )
    );

    expect(html).toMatch(/aria-pressed="true"[^>]*>Every 3 days/);
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

describe("first-search pure helpers", () => {
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

  it("saves a cadence preference without starting a run", async () => {
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

  it("retryFirstSearch retries via startFirstSearchRun({ retry: true })", async () => {
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
