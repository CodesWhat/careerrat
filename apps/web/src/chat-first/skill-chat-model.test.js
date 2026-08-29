import { describe, expect, it, vi } from "vitest";
import {
  buildSkillChatThreads,
  commitSkillChatCompletion,
  commitSkillChatDecision,
  discoveryIntentFor,
  hydrateSkillChatMessages,
  parseSkillChatText,
  reduceSkillChatEvent,
  resolveSkillChatSession,
  skillChatCompletionFor,
  skillChatEventNeedsHydration,
  skillChatFromWorkspaceResult,
  skillChatStreamUrl,
  skillChatSubmitBlocked,
} from "./skill-chat-model.js";

describe("skill chat model", () => {
  const exactSourceCandidates = [
    [
      "LandEarly",
      "https://www.landearly.com/remote-jobs/platform-engineer",
      "url-query",
      "Dated US platform roles, including senior and staff openings with pay data",
      "high",
    ],
    [
      "4 Day Week",
      "https://4dayweek.io/platform-engineering-jobs",
      "url-query",
      "Fresh platform and backend listings from named employers, with US remote roles",
      "high",
    ],
    [
      "TrulyRemote Dev",
      "https://trulyremote.dev/remote-backend-engineer-jobs",
      "url-query",
      "Updated backend board currently showing Staff Backend Engineer and distributed-systems roles",
      "high",
    ],
    [
      "Built In",
      "https://builtin.com/jobs/remote/dev-engineering/search/platform-engineer",
      "url-query",
      "Dated US platform listings, including staff roles above the compensation floor",
      "high",
    ],
    [
      "RemotePilot",
      "https://remotepilot.dev/categories/backend-engineering/",
      "url-query",
      "Staff backend, infrastructure, and distributed-systems listings",
      "borderline",
    ],
    [
      "DevJobsList",
      "https://www.devjobslist.com/",
      "browser",
      "Dated remote software listings with employer and compensation details",
      "borderline",
    ],
  ].map(([label, url, sourceType, why, confidence]) => ({
    label,
    url,
    sourceType,
    why,
    status: "proposed",
    confidence,
  }));
  exactSourceCandidates.push({
    label: "Anywhere Devs",
    url: "https://anywheredevs.com/",
    sourceType: "browser",
    why: "Landing page claims fresh remote engineering coverage but exposes no specific listings",
    status: "rejected",
    rejectionReason: "no visible dated listing",
  });
  const persistedSourceReviewTable = [
    "I found six useful new sources. Nothing has been added yet.",
    "| # | Board | Source type | Why relevant | Status |",
    "|---|---|---|---|---|",
    "| 1 | [LandEarly](https://www.landearly.com/remote-jobs/platform-engineer) | url-query | Dated US platform roles, including senior and staff openings with pay data | NEW |",
    "| 2 | [4 Day Week](https://4dayweek.io/platform-engineering-jobs) | url-query | Fresh platform and backend listings from named employers, with US remote roles | NEW |",
    "| 3 | [TrulyRemote Dev](https://trulyremote.dev/remote-backend-engineer-jobs) | url-query | Updated backend board currently showing Staff Backend Engineer and distributed-systems roles | NEW |",
    "| 4 | [Built In](https://builtin.com/jobs/remote/dev-engineering/search/platform-engineer) | url-query | Dated US platform listings, including staff roles above the compensation floor | NEW |",
    "| 5 | [RemotePilot](https://remotepilot.dev/categories/backend-engineering/) | url-query | Staff backend, infrastructure, and distributed-systems listings | NEW (borderline: some stale or poorly categorized results) |",
    "| 6 | [DevJobsList](https://www.devjobslist.com/) | browser | Dated remote software listings with employer and compensation details | NEW (borderline: weak US staff/platform targeting) |",
    "| 7 | [Anywhere Devs](https://anywheredevs.com/) | browser | Landing page claims fresh remote engineering coverage but exposes no specific listings | REJECTED: no visible dated listing |",
    "BOARDS FOUND: 7 screened",
    "PROPOSED (new): 6 (4 high-confidence, 2 borderline/medium)",
    "REJECTED: 1 (reasons: no visible dated listing)",
    "AUTO-ADDED: none (chat handoff — writes happen via the Add source/Skip controls, not this turn)",
  ].join("\n");

  it("parses one validated board-review artifact and never exposes its protocol payload", () => {
    const result = parseSkillChatText(
      [
        "The model wrote an ugly ledger that must not own presentation.",
        "BOARDS FOUND: 7 screened",
        "```careerrat:discovery",
        JSON.stringify({ kind: "source_review", candidates: exactSourceCandidates }),
        "```",
      ].join("\n"),
      "research-boards"
    );

    expect(result.text).toBe("I found 6 useful sources. Nothing has been added yet.");
    expect(result.discoveries).toEqual([
      expect.objectContaining({
        kind: "source_review",
        screenedCount: 7,
        proposalCount: 6,
        highConfidenceCount: 4,
        borderlineCount: 2,
        rejectedCount: 1,
        candidates: expect.arrayContaining([
          expect.objectContaining({ label: "LandEarly", status: "proposed" }),
          expect.objectContaining({
            label: "Anywhere Devs",
            status: "rejected",
            rejectionReason: "no visible dated listing",
          }),
        ]),
      }),
    ]);
    expect(JSON.stringify(result)).not.toMatch(/BOARDS FOUND|careerrat:discovery/);
  });

  it("hydrates a persisted structured source review and reconciles every durable decision", () => {
    const parsed = parseSkillChatText(
      `\`\`\`careerrat:discovery\n${JSON.stringify({ kind: "source_review", candidates: exactSourceCandidates })}\n\`\`\``,
      "research-boards"
    ).discoveries[0];
    const decidedId = parsed.candidates[0].id;
    const messages = hydrateSkillChatMessages({
      id: "skill:research-boards",
      skill: "research-boards",
      messages: [
        {
          id: "persisted-review",
          role: "assistant",
          text: "I found 6 useful sources. Nothing has been added yet.",
          artifacts: [parsed],
        },
      ],
      decisions: [
        {
          id: decidedId,
          action: "save",
          status: "completed",
          resultText: "Added LandEarly.",
        },
      ],
    });

    const review = messages[0].artifacts[0];
    expect(review.kind).toBe("source_review");
    expect(review.candidates).toHaveLength(7);
    expect(review.candidates[0].decision).toMatchObject({ action: "save", status: "completed" });
    expect(review.candidates[1].decision).toBeNull();
  });

  it("hydrates the persisted historical board ledger as one structured source review", () => {
    const [message] = hydrateSkillChatMessages({
      id: "skill:research-boards",
      skill: "research-boards",
      messages: [
        { id: "persisted-table-review", role: "assistant", text: persistedSourceReviewTable },
      ],
    });

    expect(message.text).toBe("I found 6 useful sources. Nothing has been added yet.");
    expect(message.artifacts).toEqual([
      expect.objectContaining({
        kind: "source_review",
        proposalCount: 6,
        highConfidenceCount: 4,
        borderlineCount: 2,
        rejectedCount: 1,
      }),
    ]);
    expect(JSON.stringify(message)).not.toMatch(/BOARDS FOUND|AUTO-ADDED|\| # \| Board/);
  });

  it("turns a malformed board-review payload into readable retry copy without raw protocol", () => {
    const result = parseSkillChatText(
      [
        "```careerrat:discovery",
        '{"kind":"source_review","candidates":[{"label":"Bad","url":"file:///etc/passwd"}]}',
        "```",
      ].join("\n"),
      "research-boards"
    );

    expect(result).toEqual({
      text: "I couldn't prepare the source review. Run it again.",
      discoveries: [],
    });
    expect(JSON.stringify(result)).not.toContain("file://");
  });

  it("fails a persisted historical board ledger closed when a row is unsafe", () => {
    const [result] = hydrateSkillChatMessages({
      id: "skill:research-boards",
      skill: "research-boards",
      messages: [
        {
          id: "persisted-unsafe-table",
          role: "assistant",
          text: [
            "| # | Board | Source type | Why relevant | Status |",
            "|---|---|---|---|---|",
            "| 1 | [Local file](file:///etc/passwd) | browser | Not a public source | NEW |",
            "BOARDS FOUND: 1 screened",
            "PROPOSED (new): 1 (1 high-confidence, 0 borderline/medium)",
            "REJECTED: 0",
            "AUTO-ADDED: none",
          ].join("\n"),
        },
      ],
    });

    expect(result).toMatchObject({
      text: "I couldn't prepare the source review. Run it again.",
      artifacts: [],
    });
    expect(JSON.stringify(result)).not.toMatch(/file:|AUTO-ADDED|\| # \| Board/);
  });

  it("accepts the runtime-validated source review on the live assistant event", () => {
    const review = parseSkillChatText(
      `\`\`\`careerrat:discovery\n${JSON.stringify({ kind: "source_review", candidates: exactSourceCandidates })}\n\`\`\``,
      "research-boards"
    ).discoveries[0];
    const state = reduceSkillChatEvent(
      {
        id: "skill:research-boards",
        skill: "research-boards",
        chatId: "boards-live",
        cursor: 0,
        messages: [],
      },
      {
        chatId: "boards-live",
        type: "assistant",
        eventId: 1,
        raw: JSON.stringify({
          message: {
            content: [
              { type: "text", text: "I found 6 useful sources. Nothing has been added yet." },
            ],
          },
          artifacts: [review],
        }),
      }
    );

    expect(state.messages[0].artifacts).toEqual([
      expect.objectContaining({ kind: "source_review", proposalCount: 6 }),
    ]);
  });

  it("extracts every supported discovery handoff without leaking the fenced payload into chat", () => {
    const payloads = [
      {
        kind: "source_proposal",
        label: "Remote OK",
        url: "https://remoteok.com/remote-dev-jobs",
        why: "Current remote engineering roles",
        confidence: "high",
      },
      {
        kind: "company_research_result",
        company: "Acme",
        slug: "acme",
        markdown: "---\ntype: company-research\ncompany: Acme\n---\n\nCited body.",
      },
      {
        kind: "comp_benchmark_result",
        role: "Staff Engineer",
        location: "New York, NY",
        stem: "comp-bench-staff-engineer-new-york-2026-08",
        benchmark: { floor: 175000, midpoint: 205000, ceiling: 235000, currency: "USD" },
        markdown: "---\ntype: comp-benchmark\n---\n\nCited body.",
      },
      {
        kind: "company_health_result",
        targetType: "application",
        targetId: "app-acme",
        company: "Acme",
        companyHealth: {
          rating: "watch",
          forFunction: "engineering",
          asOf: "2026-08-24",
          provenance: "built-from-data",
          crossCut: [],
          fitDelta: 0,
          dimensions: {},
          rationale: "Hiring slowed.",
          signals: [],
        },
      },
    ];
    const source = [
      "I finished the research.",
      ...payloads.map((payload) => `\`\`\`careerrat:discovery\n${JSON.stringify(payload)}\n\`\`\``),
    ].join("\n\n");

    const result = parseSkillChatText(source, "research-company");

    expect(result.text).toBe("I finished the research.");
    expect(result.discoveries).toHaveLength(4);
    expect(result.discoveries.map((item) => item.kind)).toEqual(payloads.map((item) => item.kind));
    expect(result.discoveries.every((item) => item.id.startsWith("discovery:"))).toBe(true);
    expect(JSON.stringify(result)).not.toContain("```careerrat:discovery");
  });

  it("ignores unknown, malformed, and unsafe discovery blocks while preserving ordinary prose", () => {
    const result = parseSkillChatText(
      [
        "Keep this sentence.",
        "```careerrat:discovery",
        '{"kind":"source_proposal","label":"Local file","url":"file:///etc/passwd"}',
        "```",
        "```careerrat:discovery",
        '{"kind":"unknown_write","path":"/tmp/nope"}',
        "```",
        "```careerrat:discovery",
        "{bad json",
        "```",
      ].join("\n"),
      "research-boards"
    );

    expect(result.text).toContain("Keep this sentence.");
    expect(result.discoveries).toEqual([]);
    expect(result.text).not.toContain("careerrat:discovery");
    expect(result.text).not.toContain("file:///etc/passwd");
  });

  it("suppresses the board-discovery completion marker and returns a typed completion", () => {
    const result = parseSkillChatText(
      'Board review is ready.\n\n```careerrat:discovery\n{"kind":"discovery_complete","step":"research-boards"}\n```',
      "research-boards"
    );

    expect(result.text).toBe("Board review is ready.");
    expect(result.discoveries).toEqual([
      expect.objectContaining({ kind: "discovery_complete", step: "research-boards" }),
    ]);
    expect(JSON.stringify(result)).not.toContain("```careerrat:discovery");
  });

  it("maps typed handoffs only to their canonical workspace intent owners", () => {
    expect(
      discoveryIntentFor({
        kind: "source_proposal",
        label: "Remote OK",
        url: "https://remoteok.com/remote-dev-jobs",
      })
    ).toEqual({
      type: "source.add",
      entity: { type: "workspace", id: "workspace-main" },
      input: { url: "https://remoteok.com/remote-dev-jobs", label: "Remote OK" },
    });
    expect(
      discoveryIntentFor({
        kind: "company_research_result",
        company: "Acme",
        slug: "acme",
        markdown: "research",
      })
    ).toEqual({
      type: "research.record",
      entity: { type: "workspace", id: "workspace-main" },
      input: {
        type: "company-research",
        name: "Acme",
        slug: "acme",
        markdown: "research",
      },
    });
    expect(
      discoveryIntentFor({
        kind: "comp_benchmark_result",
        role: "Staff Engineer",
        location: "New York, NY",
        stem: "comp-bench-staff-new-york-2026-08",
        markdown: "benchmark",
      })
    ).toEqual({
      type: "research.record",
      entity: { type: "workspace", id: "workspace-main" },
      input: {
        type: "comp-benchmark",
        name: "Staff Engineer",
        slug: "comp-bench-staff-new-york-2026-08",
        markdown: "benchmark",
      },
    });
    expect(
      discoveryIntentFor({
        kind: "company_health_result",
        targetType: "application",
        targetId: "app-acme",
        company: "Acme",
        companyHealth: { rating: "watch" },
      })
    ).toEqual({
      type: "company.health-record",
      entity: { type: "application", id: "app-acme" },
      input: { company: "Acme", companyHealth: { rating: "watch" } },
    });
    expect(discoveryIntentFor({ kind: "discovery_complete", step: "research-boards" })).toBeNull();
  });

  it("reconciles stable SSE event ids, visible activity, terminal errors, and typed results", () => {
    let state = { chatId: "chat-1", cursor: 0, state: "running", messages: [] };
    const event = (type, data, eventId) => ({
      chatId: "chat-1",
      type,
      raw: JSON.stringify(data),
      eventId,
    });
    state = reduceSkillChatEvent(
      state,
      event("tool_use", { id: "tool-1", name: "WebSearch", input: { query: "Acme" } }, 1)
    );
    state = reduceSkillChatEvent(
      state,
      event(
        "assistant",
        {
          answerMode: "yes-no",
          message: {
            content: [
              {
                type: "text",
                text: 'Ready.\n\n```careerrat:discovery\n{"kind":"company_research_result","company":"Acme","slug":"acme","markdown":"research"}\n```',
              },
            ],
          },
        },
        2
      )
    );
    state = reduceSkillChatEvent(state, event("chat_state", { state: "idle" }, 3));
    state = reduceSkillChatEvent(state, event("error", { message: "Research timed out." }, 4));
    state = reduceSkillChatEvent(state, event("error", { message: "Research timed out." }, 4));

    expect(state.cursor).toBe(4);
    expect(state.state).toBe("idle");
    expect(state.messages).toHaveLength(3);
    expect(state.messages[0]).toMatchObject({ kind: "status", text: "Searching the web" });
    expect(state.messages[1]).toMatchObject({ role: "assistant", text: "Ready." });
    expect(state.messages[1].metadata).toEqual({ answerMode: "yes-no" });
    expect(state.messages[1].artifacts[0].kind).toBe("company_research_result");
    expect(state.messages[2]).toMatchObject({ kind: "agent_error", text: "Research timed out." });
    expect(state.messages.map((message) => message.id)).toEqual([
      "skill-chat-1-event-1",
      "skill-chat-1-event-2",
      "skill-chat-1-event-4",
    ]);
  });

  it("does not append an equivalent persisted assistant response when SSE replays it with a new event id", () => {
    const response = [
      "I found Remote OK.",
      "```careerrat:discovery",
      JSON.stringify({
        kind: "source_proposal",
        label: "Remote OK",
        url: "https://remoteok.com/remote-dev-jobs",
        why: "Current remote engineering roles",
        confidence: "high",
      }),
      "```",
    ].join("\n");
    const messages = hydrateSkillChatMessages({
      id: "skill:research-boards",
      skill: "research-boards",
      messages: [{ id: "persisted-assistant", role: "assistant", text: response }],
    });

    const state = reduceSkillChatEvent(
      {
        id: "skill:research-boards",
        skill: "research-boards",
        chatId: "boards-chat",
        cursor: 0,
        messages,
      },
      {
        chatId: "boards-chat",
        type: "assistant",
        eventId: 17,
        raw: JSON.stringify({
          answerMode: "yes-no",
          message: { content: [{ type: "text", text: response }] },
        }),
      }
    );

    expect(state.cursor).toBe(17);
    expect(state.messages).toHaveLength(1);
    expect(state.messages[0]).toMatchObject({
      id: "persisted-assistant",
      text: "I found Remote OK.",
    });
    expect(state.messages.flatMap((message) => message.artifacts || [])).toEqual([
      expect.objectContaining({
        kind: "source_proposal",
        label: "Remote OK",
        url: "https://remoteok.com/remote-dev-jobs",
      }),
    ]);
  });

  it("preserves identical assistant prompts after an intervening user response", () => {
    const repeatedPrompt = "Should I search another set of boards?";
    const messages = hydrateSkillChatMessages({
      id: "skill:research-boards",
      skill: "research-boards",
      messages: [
        { id: "assistant-first", role: "assistant", text: repeatedPrompt },
        { id: "user-answer", role: "user", text: "Yes, keep going." },
      ],
    });

    const state = reduceSkillChatEvent(
      {
        id: "skill:research-boards",
        skill: "research-boards",
        chatId: "boards-chat",
        cursor: 17,
        messages,
      },
      {
        chatId: "boards-chat",
        type: "assistant",
        eventId: 18,
        raw: JSON.stringify({
          answerMode: "yes-no",
          message: { content: [{ type: "text", text: repeatedPrompt }] },
        }),
      }
    );

    expect(state.messages.map((message) => message.text)).toEqual([
      repeatedPrompt,
      "Yes, keep going.",
      repeatedPrompt,
    ]);
  });

  it("keeps the durable terminal turn state when an older launch artifact still says running", () => {
    const threads = buildSkillChatThreads(
      {
        messages: [
          {
            id: "launch",
            artifacts: [
              {
                kind: "research_chat",
                title: "Researching Acme",
                chatId: "live-chat",
                skill: "research-company",
                state: "running",
              },
            ],
          },
        ],
      },
      [
        {
          id: "skill:research-company",
          skill: "research-company",
          turnState: "awaiting-user",
          messages: [{ id: "saved-1", role: "assistant", text: "Durable research history" }],
          decisions: [{ id: "discovery:company:acme", action: "save", resultText: "Saved Acme." }],
        },
      ]
    );

    expect(threads).toEqual([
      expect.objectContaining({
        id: "skill:research-company",
        skill: "research-company",
        title: "Researching Acme",
        chatId: "live-chat",
        state: "awaiting-user",
        messages: [expect.objectContaining({ text: "Durable research history" })],
        decisions: [expect.objectContaining({ action: "save" })],
      }),
    ]);
  });

  it("finds the visible chat artifact in a committed workspace result", () => {
    expect(
      skillChatFromWorkspaceResult({
        data: {
          messages: [
            {
              artifacts: [
                {
                  kind: "board_discovery_chat",
                  chatId: "boards-live",
                  skill: "research-boards",
                  title: "Job board discovery",
                },
              ],
            },
          ],
        },
      })
    ).toEqual(expect.objectContaining({ id: "skill:research-boards", chatId: "boards-live" }));
  });

  it("does not reopen an old research thread after an unrelated foreground action", () => {
    expect(
      skillChatFromWorkspaceResult({
        data: {
          messages: [
            {
              role: "assistant",
              kind: "action_result",
              artifacts: [
                {
                  kind: "board_discovery_chat",
                  chatId: "boards-finished",
                  skill: "research-boards",
                  title: "Job board discovery",
                },
              ],
            },
            {
              role: "assistant",
              kind: "action_result",
              text: "Confirmed these screening answers.",
              artifacts: [{ kind: "screening_answer_confirmed" }],
            },
          ],
        },
      })
    ).toBeNull();
  });

  it("reuses a live skill session and recreates only a missing durable runtime session", async () => {
    const liveApi = {
      findChatBySkill: async () => ({
        chatId: "live-chat",
        skill: "research-company",
        state: "running",
      }),
      startChat: async () => {
        throw new Error("must not start a duplicate");
      },
    };
    await expect(
      resolveSkillChatSession(liveApi, { skill: "research-company", chatId: "old-chat" })
    ).resolves.toMatchObject({ chatId: "live-chat", state: "running" });

    const startChat = async (skill) => ({ chatId: "resumed-chat", skill, state: "idle" });
    await expect(
      resolveSkillChatSession(
        { findChatBySkill: async () => ({ chatId: null, state: "missing" }), startChat },
        { skill: "research-company", chatId: "old-chat" }
      )
    ).resolves.toEqual({
      chatId: "resumed-chat",
      skill: "research-company",
      state: "idle",
    });
  });

  it("uses the duplicate session id when start races another visible opener", async () => {
    const conflict = new Error("duplicate");
    conflict.status = 409;
    conflict.body = { chatId: "winner-chat" };
    await expect(
      resolveSkillChatSession(
        {
          findChatBySkill: async () => ({ chatId: null, state: "missing" }),
          startChat: async () => {
            throw conflict;
          },
        },
        { skill: "research-comp" }
      )
    ).resolves.toEqual({ chatId: "winner-chat", skill: "research-comp", state: "running" });
  });

  it("shares one in-flight session resolution across repeated hydration of the same thread", async () => {
    let releaseFind;
    const findPending = new Promise((resolve) => {
      releaseFind = resolve;
    });
    const api = {
      findChatBySkill: vi.fn(async () => {
        await findPending;
        return { chatId: null, state: "missing" };
      }),
      startChat: vi.fn(async (skill) => ({ chatId: "resumed-chat", skill, state: "idle" })),
    };
    const inFlight = new Map();

    const first = resolveSkillChatSession(api, { skill: "research-boards" }, inFlight);
    const repeated = resolveSkillChatSession(api, { skill: "research-boards" }, inFlight);
    releaseFind();

    await expect(Promise.all([first, repeated])).resolves.toEqual([
      { chatId: "resumed-chat", skill: "research-boards", state: "idle" },
      { chatId: "resumed-chat", skill: "research-boards", state: "idle" },
    ]);
    expect(api.findChatBySkill).toHaveBeenCalledOnce();
    expect(api.startChat).toHaveBeenCalledOnce();
  });

  it("blocks a selected research-thread submit until its runtime session resolves", () => {
    expect(skillChatSubmitBlocked({ id: "skill:research-company", chatId: null })).toBe(true);
    expect(skillChatSubmitBlocked({ id: "skill:research-company", chatId: "live-chat" })).toBe(
      false
    );
    expect(skillChatSubmitBlocked(null)).toBe(false);
  });

  it("hydrates durable state at terminal and typed-answer stream boundaries", () => {
    expect(skillChatEventNeedsHydration("result")).toBe(true);
    expect(skillChatEventNeedsHydration("error")).toBe(true);
    expect(
      skillChatEventNeedsHydration(
        "assistant",
        JSON.stringify({ answerMode: "yes-no", message: { content: [] } })
      )
    ).toBe(true);
    expect(
      skillChatEventNeedsHydration(
        "assistant",
        JSON.stringify({ answerMode: null, message: { content: [] } })
      )
    ).toBe(false);
  });

  it("makes board completion reachable only after every source proposal has a decision", () => {
    const completion = {
      id: "discovery:research-boards:discovery_complete:research-boards",
      kind: "discovery_complete",
      step: "research-boards",
    };
    const pending = skillChatCompletionFor([
      {
        artifacts: [
          { id: "source-1", kind: "source_proposal", decision: { status: "completed" } },
          { id: "source-2", kind: "source_proposal" },
          completion,
        ],
      },
    ]);
    expect(pending).toMatchObject({ item: completion, ready: false, pendingCount: 1 });

    const ready = skillChatCompletionFor([
      {
        artifacts: [
          { id: "source-1", kind: "source_proposal", decision: { status: "completed" } },
          { id: "source-2", kind: "source_proposal", decision: { status: "completed" } },
          completion,
        ],
      },
    ]);
    expect(ready).toMatchObject({ item: completion, ready: true, pendingCount: 0 });
  });

  it("counts unique source proposals and prefers a completed decision across duplicate copies", () => {
    const completion = {
      id: "discovery:research-boards:discovery_complete:research-boards",
      kind: "discovery_complete",
      step: "research-boards",
    };
    const duplicateId =
      "discovery:research-boards:source_proposal:https%3A%2F%2Fremoteok.com%2Fremote-dev-jobs";

    const result = skillChatCompletionFor([
      {
        id: "persisted-copy",
        artifacts: [
          {
            id: duplicateId,
            kind: "source_proposal",
            url: "https://remoteok.com/remote-dev-jobs",
          },
          completion,
        ],
      },
      {
        id: "replayed-copy",
        artifacts: [
          {
            id: duplicateId,
            kind: "source_proposal",
            url: "https://remoteok.com/remote-dev-jobs",
            decision: { status: "completed", action: "save" },
          },
          {
            id: "discovery:research-boards:source_proposal:https%3A%2F%2Fweworkremotely.com",
            kind: "source_proposal",
            url: "https://weworkremotely.com",
          },
        ],
      },
    ]);

    expect(result).toMatchObject({ item: completion, ready: false, pendingCount: 1 });
  });

  it("completes board discovery canonically before recording its durable thread result", async () => {
    const calls = [];
    const api = {
      completeDiscovery: async (step) => {
        calls.push({ owner: "discovery", step });
        return { completion: { added: true } };
      },
      recordSkillChatDecision: async (decision) => calls.push({ owner: "thread", decision }),
    };

    await expect(
      commitSkillChatCompletion({
        api,
        skill: "research-boards",
        item: {
          id: "discovery:research-boards:discovery_complete:research-boards",
          kind: "discovery_complete",
          step: "research-boards",
        },
      })
    ).resolves.toBe("Board discovery is complete.");
    expect(calls.map((call) => call.owner)).toEqual(["discovery", "thread"]);
    expect(calls[0]).toEqual({ owner: "discovery", step: "research-boards" });
    expect(calls[1].decision).toMatchObject({
      action: "save",
      status: "completed",
      resultText: "Board discovery is complete.",
    });
  });

  it("builds a resumable stream URL only after the runtime session resolves", () => {
    expect(skillChatStreamUrl({ chatId: null })).toBeNull();
    expect(skillChatStreamUrl({ chatId: "finished-chat", state: "closed" })).toBeNull();
    expect(skillChatStreamUrl({ chatId: "chat/1", streamAfter: 42 })).toBe(
      "/api/chat/events?id=chat%2F1&after=42"
    );
  });

  it("saves board, company, comp, and health results through canonical owners before recording the visible decision", async () => {
    const items = [
      {
        id: "source",
        kind: "source_proposal",
        label: "Remote OK",
        url: "https://remoteok.com/remote-dev-jobs",
      },
      {
        id: "company",
        kind: "company_research_result",
        company: "Acme",
        slug: "acme",
        markdown: "research",
      },
      {
        id: "comp",
        kind: "comp_benchmark_result",
        role: "Staff Engineer",
        location: "NYC",
        stem: "comp-bench-staff-nyc-2026-08",
        markdown: "benchmark",
      },
      {
        id: "health",
        kind: "company_health_result",
        targetType: "application",
        targetId: "app-acme",
        company: "Acme",
        companyHealth: { rating: "watch" },
      },
    ];

    for (const item of items) {
      const calls = [];
      const api = {
        runWorkspaceIntent: async (type, entity, input) => {
          calls.push({ owner: "workspace", type, entity, input });
          return { data: { messages: [{ text: `Canonical ${item.id} result` }] } };
        },
        recordSkillChatDecision: async (decision) => {
          calls.push({ owner: "thread", decision });
        },
      };
      await expect(
        commitSkillChatDecision({
          api,
          skill: "research-company",
          item,
          action: "save",
        })
      ).resolves.toBe(`Canonical ${item.id} result`);
      expect(calls.map((call) => call.owner)).toEqual(["workspace", "thread"]);
      expect(calls[1].decision).toMatchObject({
        decisionId: item.id,
        action: "save",
        resultText: `Canonical ${item.id} result`,
      });
    }
  });

  it("persists discard without a canonical domain write and records failed saves as visible terminal errors", async () => {
    const records = [];
    const item = {
      id: "company",
      kind: "company_research_result",
      company: "Acme",
      slug: "acme",
      markdown: "research",
    };
    const discardApi = {
      runWorkspaceIntent: async () => {
        throw new Error("discard must not mutate research");
      },
      recordSkillChatDecision: async (decision) => records.push(decision),
    };
    await commitSkillChatDecision({
      api: discardApi,
      skill: "research-company",
      item,
      action: "discard",
    });
    expect(records[0]).toMatchObject({ action: "discard", status: "completed" });

    const failure = new Error("Research artifact failed validation.");
    const failedApi = {
      runWorkspaceIntent: async () => {
        throw failure;
      },
      recordSkillChatDecision: async (decision) => records.push(decision),
    };
    await expect(
      commitSkillChatDecision({
        api: failedApi,
        skill: "research-company",
        item,
        action: "save",
      })
    ).rejects.toBe(failure);
    expect(records.at(-1)).toMatchObject({
      action: "save",
      status: "failed",
      resultText:
        "Something went wrong on this computer. Try again, and if it keeps happening, restart CareerRat.",
    });
    expect(records.at(-1).resultText).not.toContain("failed validation");
  });
});
