import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";

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

import {
  buildQuickStartAction,
  buildReadinessRows,
  DiscoveryChatPanel,
  extractDiscoveryGuidance,
  FinishStep,
  runNextDiscoveryHandoff,
  runQuickStartHandoff,
} from "./FinishStep.jsx";

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
      },
    },
  },
};

describe("buildReadinessRows", () => {
  it("maps DB setup readiness into quick-start status rows", () => {
    const rows = buildReadinessRows({
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
      },
    });

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
  it("enables sourcing when search-ready but keeps gate/apply caveats visible", () => {
    const action = buildQuickStartAction({
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
            gate_ready: ["compensation floor", "work authorization"],
            apply_ready: ["evidence claims"],
          },
        },
      },
    });

    expect(action).toEqual({
      enabled: true,
      label: "Prepare sourcing",
      detail:
        "Rolester can prepare source setup now. Gate and apply stay locked until compensation floor, work authorization, and evidence claims are complete.",
    });
  });

  it("disables sourcing until the search-ready fields are complete", () => {
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
      label: "Complete search setup",
      detail: "Needs source resume and role titles.",
    });
  });
});

describe("runQuickStartHandoff", () => {
  it("calls the backend discovery quick-start route, refreshes state, and exposes the returned chat", async () => {
    const calls = [];
    const outcome = await runQuickStartHandoff({
      quickStart: async () => {
        calls.push("quickStart");
        return {
          ok: true,
          written: ["config/search-sources.yml"],
          nextSkill: "research-boards",
          nextMessage:
            "Search sources are ready. Run research-boards next, then discover-companies before search-jobs.",
          guidance: {
            nextSkill: "research-boards",
            message:
              "Ask your agent to run research-boards next, then discover-companies before search-jobs.",
          },
          chat: { chatId: "chat-1", skill: "research-boards", state: "running" },
        };
      },
      refreshWorkspace: async () => {
        calls.push("refreshWorkspace");
      },
    });

    expect(calls).toEqual(["quickStart", "refreshWorkspace"]);
    expect(outcome.chat).toEqual({ chatId: "chat-1", skill: "research-boards", state: "running" });
    expect(outcome.chatError).toBe(null);
    expect(outcome.guidance.nextSkill).toBe("research-boards");
  });

  it("keeps the prepared source result when the backend reports no chat", async () => {
    const outcome = await runQuickStartHandoff({
      quickStart: async () => ({
        ok: true,
        written: [],
        nextSkill: "research-boards",
        chat: null,
        chatError: "no AI route configured",
      }),
    });

    expect(outcome.result.ok).toBe(true);
    expect(outcome.chat).toBe(null);
    expect(outcome.chatError).toBe("no AI route configured");
  });

  it("uses an already-running discovery chat returned by the backend", async () => {
    const outcome = await runQuickStartHandoff({
      quickStart: async () => ({
        ok: true,
        written: [],
        guidance: { nextSkill: "research-boards" },
        chat: {
          chatId: "existing-chat",
          skill: "research-boards",
          state: "running",
          reused: true,
        },
      }),
    });

    expect(outcome.chat).toEqual({
      chatId: "existing-chat",
      skill: "research-boards",
      state: "running",
      reused: true,
    });
    expect(outcome.chatError).toBe(null);
  });
});

describe("extractDiscoveryGuidance", () => {
  it("accepts only the supervised discovery skills from the dashboard guidance", () => {
    expect(
      extractDiscoveryGuidance({
        data: {
          agentGuidance: {
            nextSkill: "discover-companies",
            message: "Ask your agent to run discover-companies next before search-jobs.",
            ctaLabel: "Run discover-companies",
          },
        },
      })
    ).toEqual({
      nextSkill: "discover-companies",
      message: "Ask your agent to run discover-companies next before search-jobs.",
      ctaLabel: "Run discover-companies",
    });

    expect(
      extractDiscoveryGuidance({
        data: { agentGuidance: { nextSkill: "evaluate-job", message: "Gate a role." } },
      })
    ).toBe(null);

    expect(
      extractDiscoveryGuidance({
        guidance: {
          nextSkill: "search-jobs",
          message: "Ask your agent to run search-jobs next for the first sweep.",
        },
      })
    ).toEqual({
      nextSkill: "search-jobs",
      message: "Ask your agent to run search-jobs next for the first sweep.",
      ctaLabel: "Run search-jobs",
    });
  });
});

describe("runNextDiscoveryHandoff", () => {
  it("calls the backend next route and returns the current discovery chat", async () => {
    const calls = [];
    const outcome = await runNextDiscoveryHandoff({
      continueDiscovery: async () => {
        calls.push("continueDiscovery");
        return {
          ok: true,
          guidance: {
            nextSkill: "search-jobs",
            message: "Ask your agent to run search-jobs next for the first sweep.",
          },
          chat: { chatId: "chat-3", skill: "search-jobs", state: "running" },
        };
      },
      refreshWorkspace: async () => {
        calls.push("refreshWorkspace");
      },
    });

    expect(calls).toEqual(["continueDiscovery", "refreshWorkspace"]);
    expect(outcome.chat).toEqual({ chatId: "chat-3", skill: "search-jobs", state: "running" });
    expect(outcome.guidance.nextSkill).toBe("search-jobs");
  });
});

describe("FinishStep", () => {
  it("frames compatibility-file generation as explicit export support", () => {
    dashboardMock.snapshot = {
      data: null,
      noDatabase: false,
      refetch: async () => {},
    };

    const html = renderToStaticMarkup(
      <MemoryRouter>
        <FinishStep
          state={SEARCH_READY_STATE}
          aiEnabled={true}
          runtimeCapabilities={{ discoveryChatHandoffs: true }}
          reload={async () => {}}
          goBack={() => {}}
        />
      </MemoryRouter>
    );

    expect(html).toContain("Your app source setup is saved in SQLite.");
    expect(html).toContain("Export compatibility files only for CLI/debug support.");
    expect(html).toContain(">Export compatibility files<");
    expect(html).not.toContain("generates search sources from your profile and targeting");
    expect(html).not.toContain(">Write config<");
  });

  it("treats source readiness separately from compatibility export freshness", () => {
    dashboardMock.snapshot = {
      data: null,
      noDatabase: false,
      refetch: async () => {},
    };

    const html = renderToStaticMarkup(
      <MemoryRouter>
        <FinishStep
          state={{ ...SEARCH_READY_STATE, searchSourcesPresent: true }}
          aiEnabled={true}
          runtimeCapabilities={{ discoveryChatHandoffs: true }}
          reload={async () => {}}
          goBack={() => {}}
        />
      </MemoryRouter>
    );

    expect(html).toContain("SQLite source setup is ready.");
    expect(html).not.toContain("Already written in a previous session");
  });

  it("hides discovery chat CTAs when runtime capability disables handoffs while keeping manual finish available", () => {
    dashboardMock.snapshot = {
      data: {
        agentGuidance: {
          nextSkill: "research-boards",
          message: "Ask your agent to run research-boards next.",
          ctaLabel: "Run research-boards",
        },
      },
      noDatabase: false,
      refetch: async () => {},
    };
    chatMock.renders = [];

    const html = renderToStaticMarkup(
      <MemoryRouter>
        <FinishStep
          state={SEARCH_READY_STATE}
          aiEnabled={true}
          runtimeCapabilities={{ discoveryChatHandoffs: false }}
          reload={async () => {}}
          goBack={() => {}}
        />
      </MemoryRouter>
    );

    expect(html).not.toContain(">Prepare sourcing<");
    expect(html).not.toContain(">Run research-boards<");
    expect(html).toContain("Discovery chat handoffs are unavailable in this runtime.");
    expect(html).toContain(">Write config<");
    expect(html).toContain("Go to Home");
    expect(chatMock.renders).toEqual([]);
  });

  it("uses runtime capability handoffs ahead of legacy aiEnabled and keeps returned chats renderable", () => {
    dashboardMock.snapshot = {
      data: {
        agentGuidance: {
          nextSkill: "research-boards",
          message: "Ask your agent to run research-boards next.",
          ctaLabel: "Run research-boards",
        },
      },
      noDatabase: false,
      refetch: async () => {},
    };
    chatMock.renders = [];

    const html = renderToStaticMarkup(
      <MemoryRouter>
        <FinishStep
          state={SEARCH_READY_STATE}
          aiEnabled={false}
          runtimeCapabilities={{ discoveryChatHandoffs: true }}
          reload={async () => {}}
          goBack={() => {}}
        />
      </MemoryRouter>
    );

    expect(html).toContain(">Prepare sourcing<");
    expect(html).toContain(">Run research-boards<");
    expect(html).not.toContain("Add an AI key in the earlier step");

    const chatHtml = renderToStaticMarkup(
      <DiscoveryChatPanel
        discoveryChat={{ chatId: "chat-1", skill: "research-boards" }}
        discoveryGuidance={{
          nextSkill: "research-boards",
          message: "Ask your agent to run research-boards next.",
        }}
        quickStartResult={null}
      />
    );

    expect(chatHtml).toContain("CHAT:research-boards:chat-1");
    expect(chatMock.renders).toEqual([{ skill: "research-boards", initialChatId: "chat-1" }]);
  });

  it("ignores non-discovery guidance even when discovery handoffs are available", () => {
    dashboardMock.snapshot = {
      data: {
        agentGuidance: {
          nextSkill: "evaluate-job",
          message: "Ask your agent to evaluate a sourced role.",
          ctaLabel: "Run evaluate-job",
        },
      },
      noDatabase: false,
      refetch: async () => {},
    };

    const html = renderToStaticMarkup(
      <MemoryRouter>
        <FinishStep
          state={SEARCH_READY_STATE}
          aiEnabled={true}
          runtimeCapabilities={{ discoveryChatHandoffs: true }}
          reload={async () => {}}
          goBack={() => {}}
        />
      </MemoryRouter>
    );

    expect(html).not.toContain(">Run evaluate-job<");
    expect(html).toContain("No discovery handoff is ready yet.");
  });

  it("hides discovery CTAs without an AI key while keeping the manual finish path available", () => {
    dashboardMock.snapshot = {
      data: {
        agentGuidance: {
          nextSkill: "research-boards",
          message: "Ask your agent to run research-boards next.",
          ctaLabel: "Run research-boards",
        },
      },
      noDatabase: false,
      refetch: async () => {},
    };

    const html = renderToStaticMarkup(
      <MemoryRouter>
        <FinishStep
          state={SEARCH_READY_STATE}
          aiEnabled={false}
          reload={async () => {}}
          goBack={() => {}}
        />
      </MemoryRouter>
    );

    expect(html).not.toContain(">Prepare sourcing<");
    expect(html).not.toContain(">Run research-boards<");
    expect(html).toContain("Add an AI key in the earlier step");
    expect(html).toContain(">Write config<");
    expect(html).toContain("Go to Home");
  });
});
