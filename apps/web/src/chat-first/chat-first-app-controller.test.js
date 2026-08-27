import { describe, expect, it, vi } from "vitest";
import * as controller from "./chat-first-app-controller.js";
import {
  applicationPreparationPermission,
  calendarAction,
  commitComposerTurn,
  commitJobThreadComposer,
  confirmPacketGapAnswer,
  createMissionAndRun,
  downloadBinaryArtifact,
  downloadTextArtifact,
  enableApplicationPreparation,
  engineUnavailable,
  findGate,
  focusApplicationHandoff,
  isEngineFailure,
  mapActivityItems,
  mapComposerChips,
  mapMockSession,
  mockStartContext,
  openApplicationHandoff,
  packetExportReceipt,
  resolveMissionTextCommand,
  resolveMockInterviewTextCommand,
  resolveNeedDecision,
  resolvePersonAction,
  resumePacketPreparation,
  selectedSourcedDismissal,
  selectMockSession,
  sourceSweepPresentation,
  sourceSweepWithAvailableMatches,
} from "./chat-first-app-controller.js";

describe("chat-first app controller", () => {
  it("recognizes only explicit mission commands valid for the durable mission state", () => {
    expect(resolveMissionTextCommand("pause mission", { id: "mission-1", status: "running" })).toBe(
      "pause"
    );
    expect(
      resolveMissionTextCommand("please resume this mission", {
        id: "mission-1",
        status: "paused",
      })
    ).toBe("resume");
    expect(
      resolveMissionTextCommand("pause mission", { id: "mission-1", status: "paused" })
    ).toBeNull();
    expect(
      resolveMissionTextCommand("I need to pause and think about my search", {
        id: "mission-1",
        status: "running",
      })
    ).toBeNull();
  });

  it("ends mock interviews only for an explicit control command", () => {
    for (const command of [
      "end mock interview",
      "end this mock interview",
      "please end the mock interview",
      "stop mock interview",
    ]) {
      expect(resolveMockInterviewTextCommand(command)).toBe("end");
    }
    for (const answer of [
      "I ended the project by shipping the migration.",
      "At the end, I reviewed the results.",
      "I would stop and ask the customer what changed.",
      "end",
    ]) {
      expect(resolveMockInterviewTextCommand(answer)).toBeNull();
    }
  });

  it("returns a newly-created mission before its execution reaches the submit gates", async () => {
    let finishRun;
    const onExecutionStart = vi.fn();
    const api = {
      createChatFirstMission: vi.fn().mockResolvedValue({ data: { mission: { id: "m-live" } } }),
      runChatFirstMission: vi.fn().mockImplementation(
        () =>
          new Promise((resolve) => {
            finishRun = resolve;
          })
      ),
    };
    expect(controller.createMissionAndStart).toBeTypeOf("function");

    const result = await controller.createMissionAndStart({
      api,
      selection: ["s1"],
      rows: [{ id: "s1", source: "sourced", company: "Tyrell", role: "Staff", fit: 88 }],
      mode: "prepare-to-submit",
      onExecutionStart,
    });

    expect(result.mission.id).toBe("m-live");
    expect(api.runChatFirstMission).toHaveBeenCalledWith("m-live");
    expect(onExecutionStart).toHaveBeenCalledWith("m-live");
    expect(result.execution).toBeInstanceOf(Promise);
    finishRun({ data: { mission: { id: "m-live", status: "paused" } } });
    await result.execution;
  });

  it("resumes a hydrated running mission exactly once per active client execution", async () => {
    expect(controller.resumeHydratedMission).toBeTypeOf("function");
    const inFlight = new Set();
    let finish;
    const api = {
      resumeChatFirstMission: vi.fn(
        () =>
          new Promise((resolve) => {
            finish = resolve;
          })
      ),
    };
    const mission = { id: "mission-after-restart", status: "running" };

    const first = controller.resumeHydratedMission({ api, mission, inFlight });
    const duplicate = controller.resumeHydratedMission({ api, mission, inFlight });

    expect(api.resumeChatFirstMission).toHaveBeenCalledOnce();
    expect(duplicate).toBeNull();
    expect(inFlight.has(mission.id)).toBe(true);
    finish({ data: { mission: { ...mission, status: "paused" } } });
    await first;
    expect(inFlight.has(mission.id)).toBe(false);
  });

  it("loads every job-scoped file kind into the shared artifact viewer contract", async () => {
    expect(controller.loadChatFirstArtifact).toBeTypeOf("function");

    const api = {
      getPacket: vi.fn().mockResolvedValue({
        artifacts: { resume: { html: "<p>Résumé</p>" } },
      }),
      getJobDescription: vi.fn().mockResolvedValue({
        data: { artifact: { html: "<p>Job description</p>" } },
      }),
      getInterviewDossier: vi.fn().mockResolvedValue({
        data: { dossier: { html: "<p>Dossier</p>", markdown: "# Dossier" } },
      }),
    };

    await expect(
      controller.loadChatFirstArtifact({
        api,
        applicationId: "app-1",
        file: { kind: "Resume" },
      })
    ).resolves.toEqual({ html: "<p>Résumé</p>" });
    await expect(
      controller.loadChatFirstArtifact({
        api,
        applicationId: "app-1",
        file: { kind: "Job description" },
      })
    ).resolves.toEqual({ html: "<p>Job description</p>" });
    await expect(
      controller.loadChatFirstArtifact({
        api,
        applicationId: "app-1",
        file: { kind: "Interview dossier" },
      })
    ).resolves.toEqual({ html: "<p>Dossier</p>", markdown: "# Dossier" });

    expect(api.getJobDescription).toHaveBeenCalledWith({ source: "application", id: "app-1" });
    expect(api.getInterviewDossier).toHaveBeenCalledWith("app-1");
  });

  it("resolves schedule rows that use either applicationId or dashboard detailId", () => {
    expect(controller.scheduleApplicationId({ applicationId: "app-1" })).toBe("app-1");
    expect(controller.scheduleApplicationId({ detailId: "app-2" })).toBe("app-2");
    expect(controller.scheduleApplicationId({ id: "calendar-only" })).toBeNull();
  });

  it("routes people actions through the owning application before drafting a nudge", () => {
    expect(
      resolvePersonAction({ id: "person-1", name: "William Bell", applicationId: "app-2" })
    ).toEqual({
      applicationId: "app-2",
      prompt: "Draft a nudge for William Bell.",
    });
    expect(resolvePersonAction({ id: "person-2", name: "Angela" })).toEqual({
      applicationId: null,
      prompt: "Draft a nudge for Angela.",
    });
  });

  it("maps durable activity and composer context for the shell", () => {
    expect(
      mapActivityItems([
        { id: "a1", relTime: "8:14", title: "Sweep complete", type: "success" },
        { id: "a2", at: "2026-08-23T14:15:00Z", summary: "Packet ready", type: "error" },
        {
          id: "a3",
          relTime: "Today, 6:53 PM",
          title: "Job targets updated",
          type: "system",
        },
      ])
    ).toEqual([
      { id: "a1", time: "8:14", label: "Sweep complete", mark: "✓", tone: "done" },
      { id: "a2", time: "2:15pm", label: "Packet ready", mark: "!", tone: "attention" },
      {
        id: "a3",
        time: "6:53pm",
        label: "Job targets updated",
        mark: "✓",
        tone: "done",
      },
    ]);
    expect(
      mapComposerChips(
        ["job-2", "missing-job"],
        [
          { id: "job-1", company: "Tyrell" },
          { id: "job-2", company: "Aperture", role: "Staff Engineer" },
        ]
      )
    ).toEqual([
      { id: "job-2", label: "Aperture" },
      { id: "missing-job", label: "Job context" },
    ]);
  });

  it("runs plain main-chat answers through the durable workspace thread", async () => {
    const api = { sendWorkspaceMessage: vi.fn().mockResolvedValue({ data: { messages: [] } }) };
    const context = { pathname: "/jobs", jobId: "app-temporal" };

    const result = await commitComposerTurn({
      api,
      text: "What should I do today?",
      context,
    });

    expect(api.sendWorkspaceMessage).toHaveBeenCalledWith("What should I do today?", context);
    expect(result.kind).toBe("message");
  });

  it("returns the exact committed permission intent so the open job can refresh in place", async () => {
    const intent = {
      type: "settings.apply",
      entity: { type: "workspace", id: "workspace-main" },
      input: {
        change: {
          kind: "automation",
          op: "contextual-permission",
          permission: "application-preparation",
        },
      },
    };
    const api = { runWorkspaceIntent: vi.fn().mockResolvedValue({ ok: true }) };

    const result = await commitComposerTurn({
      api,
      text: "Allow form preparation",
      preview: { action: { label: "Allow form preparation", intent } },
    });

    expect(api.runWorkspaceIntent).toHaveBeenCalledWith(intent.type, intent.entity, intent.input);
    expect(result).toEqual({ kind: "intent", intent, response: { ok: true } });
  });

  it("turns packet export paths into an observable receipt", () => {
    expect(
      packetExportReceipt({
        data: {
          userFacing: {
            resume: [
              {
                name: "acme-resume.pdf",
                path: "workspace/tailored/acme-resume.pdf",
                downloadsPath: "/Users/riley/Downloads/acme-resume.pdf",
              },
            ],
            coverLetter: [
              {
                name: "acme-cover.pdf",
                path: "workspace/tailored/acme-cover.pdf",
              },
            ],
            answers: [],
          },
        },
      })
    ).toEqual({
      title: "Export complete",
      artifact: {
        kind: "Export receipt",
        text: [
          "Saved 2 files locally.",
          "",
          "acme-resume.pdf",
          "/Users/riley/Downloads/acme-resume.pdf",
          "",
          "acme-cover.pdf",
          "workspace/tailored/acme-cover.pdf",
        ].join("\n"),
      },
    });
    expect(packetExportReceipt({ data: { userFacing: {} } })).toBeNull();
  });

  it("only treats sourced search rows as durable Dismiss all decisions", () => {
    expect(
      selectedSourcedDismissal(
        [
          { id: "source-1", source: "sourced" },
          { id: "app-1", source: "application" },
          { id: "source-2", source: "sourced" },
        ],
        ["source-1", "app-1", "source-2"]
      )
    ).toEqual({ sourcedIds: ["source-1", "source-2"], unsupportedCount: 1 });
  });

  it("runs classified actions but converts job.apply into a user-gated mission", async () => {
    const api = {
      runWorkspaceIntent: vi.fn(),
      createChatFirstMission: vi.fn().mockResolvedValue({ data: { mission: { id: "m1" } } }),
      runChatFirstMission: vi.fn().mockResolvedValue({ data: { mission: { id: "m1" } } }),
    };
    const preview = {
      action: {
        label: "Apply",
        intent: { type: "job.apply", entity: { type: "application", id: "app-1" } },
      },
    };

    const result = await commitComposerTurn({ api, text: "Apply", preview });

    expect(api.runWorkspaceIntent).not.toHaveBeenCalled();
    expect(api.createChatFirstMission).toHaveBeenCalledWith({
      title: "Apply to 1 role",
      mode: "prepare-to-submit",
      requiresUserSubmit: true,
      jobs: [{ type: "application", id: "app-1", company: "", role: "", fit: null }],
    });
    expect(api.runChatFirstMission).toHaveBeenCalledWith("m1");
    expect(result.kind).toBe("mission");
  });

  it("converts an open saved-job prepare request into the same user-gated mission", async () => {
    const api = {
      runWorkspaceIntent: vi.fn(),
      createChatFirstMission: vi.fn().mockResolvedValue({ data: { mission: { id: "m2" } } }),
      runChatFirstMission: vi.fn().mockResolvedValue({ data: { mission: { id: "m2" } } }),
    };
    const preview = {
      action: {
        label: "Evaluate and prepare this saved job",
        intent: {
          type: "job.prepare-request",
          entity: { type: "workspace", id: "workspace-main" },
          input: { jobId: "app-curri" },
        },
      },
    };

    await commitComposerTurn({ api, text: "Fill this application", preview });

    expect(api.runWorkspaceIntent).not.toHaveBeenCalled();
    expect(api.createChatFirstMission).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "Apply to 1 role",
        mode: "prepare-to-submit",
        jobs: [expect.objectContaining({ type: "application", id: "app-curri" })],
      })
    );
  });

  it("routes an actionable job-thread message into a durable mission instead of generic AI chat", async () => {
    const api = {
      previewWorkspaceQuery: vi.fn().mockResolvedValue({
        data: {
          action: {
            label: "Evaluate and prepare this saved job",
            intent: {
              type: "job.prepare-request",
              entity: { type: "workspace", id: "workspace-main" },
              input: { jobId: "app-curri" },
            },
          },
        },
      }),
      appendJobThreadMessage: vi.fn().mockResolvedValue({ ok: true }),
      sendJobThreadTurn: vi.fn(),
      createChatFirstMission: vi.fn().mockResolvedValue({ data: { mission: { id: "m3" } } }),
      runChatFirstMission: vi.fn().mockResolvedValue({ data: { mission: { id: "m3" } } }),
    };

    const result = await commitJobThreadComposer({
      api,
      applicationId: "app-curri",
      text: "Prepare and fill this application, but do not submit it.",
    });

    expect(api.sendJobThreadTurn).not.toHaveBeenCalled();
    expect(api.appendJobThreadMessage).toHaveBeenNthCalledWith(1, {
      applicationId: "app-curri",
      role: "user",
      kind: "text",
      text: "Prepare and fill this application, but do not submit it.",
    });
    expect(api.appendJobThreadMessage).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        applicationId: "app-curri",
        role: "assistant",
        text: expect.stringMatching(/supervised apply mission.*final Submit/i),
      })
    );
    expect(result.kind).toBe("mission");
  });

  it("routes job-thread mock-interview language into the durable mock API", async () => {
    expect(controller.isMockInterviewStartRequest).toBeTypeOf("function");
    expect(controller.startMockFromJobThread).toBeTypeOf("function");
    if (
      typeof controller.isMockInterviewStartRequest !== "function" ||
      typeof controller.startMockFromJobThread !== "function"
    ) {
      return;
    }

    expect(
      controller.isMockInterviewStartRequest("Start a mock interview for this Curri role.")
    ).toBe(true);
    expect(controller.isMockInterviewStartRequest("Run mock interview practice.")).toBe(true);
    expect(controller.isMockInterviewStartRequest("End this mock interview.")).toBe(false);
    expect(controller.isMockInterviewStartRequest("Review the mock interview.")).toBe(false);

    const api = {
      appendJobThreadMessage: vi.fn().mockResolvedValue({ ok: true }),
      startMockInterview: vi.fn().mockResolvedValue({
        data: { session: { id: "mock-curri", applicationId: "app-curri", status: "active" } },
      }),
      sendJobThreadTurn: vi.fn(),
    };

    const result = await controller.startMockFromJobThread({
      api,
      applicationId: "app-curri",
      text: "Start a mock interview for this Curri role.",
      title: "Reviewed hold practice",
      context: {
        company: "Curri",
        role: "Senior Software Engineer",
        round: "Reviewed hold",
        loadedContext: "confirmed story bank",
      },
    });

    expect(api.appendJobThreadMessage).toHaveBeenCalledWith({
      applicationId: "app-curri",
      role: "user",
      kind: "text",
      text: "Start a mock interview for this Curri role.",
    });
    expect(api.startMockInterview).toHaveBeenCalledWith({
      applicationId: "app-curri",
      questionTotal: 6,
      title: "Reviewed hold practice",
      context: {
        company: "Curri",
        role: "Senior Software Engineer",
        round: "Reviewed hold",
        loadedContext: "confirmed story bank",
      },
    });
    expect(api.sendJobThreadTurn).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      data: { session: { id: "mock-curri", status: "active" } },
    });
  });

  it("projects a classified workspace result and its one review action into the job thread", async () => {
    const nextActions = [
      {
        label: "Use reviewed answers",
        intent: {
          type: "screening.answer-confirm",
          entity: { type: "application", id: "app-curri" },
          input: { answers: [{ questionId: "linkedin", answer: "https://example.test/riley" }] },
        },
      },
    ];
    const artifacts = [
      {
        kind: "screening_answers",
        title: "Curri: Screening answers",
        answers: [{ questionId: "linkedin", answer: "https://example.test/riley" }],
      },
    ];
    const api = {
      previewWorkspaceQuery: vi.fn().mockResolvedValue({
        data: {
          action: {
            label: "Draft an evidence-backed screening answer",
            intent: {
              type: "screening.answer",
              entity: { type: "application", id: "app-curri" },
              input: { questionText: "LinkedIn URL: https://example.test/riley" },
            },
          },
        },
      }),
      appendJobThreadMessage: vi.fn().mockResolvedValue({ ok: true }),
      sendJobThreadTurn: vi.fn(),
      runWorkspaceIntent: vi.fn().mockResolvedValue({
        data: {
          messages: [
            {
              role: "assistant",
              kind: "action_result",
              text: "I drafted this answer. Review it before using it. Nothing was submitted.",
              metadata: { state: "reviewable", nextActions },
              artifacts,
            },
          ],
        },
      }),
    };

    await commitJobThreadComposer({
      api,
      applicationId: "app-curri",
      text: "Answer this application question: LinkedIn URL",
    });

    expect(api.sendJobThreadTurn).not.toHaveBeenCalled();
    expect(api.appendJobThreadMessage).toHaveBeenNthCalledWith(2, {
      applicationId: "app-curri",
      role: "assistant",
      kind: "action_result",
      text: "I drafted this answer. Review it before using it. Nothing was submitted.",
      metadata: { state: "reviewable", nextActions },
      artifacts,
    });
  });

  it("persists an exact packet-gap answer through the typed writer and mirrors the result into the job thread", async () => {
    const response = {
      data: {
        messages: [
          {
            role: "assistant",
            kind: "action_result",
            text: "Confirmed this answer. 1 packet item still needs review.",
            metadata: { state: "confirmed", persisted: true, gapCount: 1 },
          },
        ],
      },
    };
    const api = {
      appendJobThreadMessage: vi.fn().mockResolvedValue({ ok: true }),
      runWorkspaceIntent: vi.fn().mockResolvedValue(response),
    };
    const gap = {
      id: "linkedin-profile",
      questionId: "linkedin-profile",
      label: "LinkedIn Profile",
    };

    await confirmPacketGapAnswer({
      api,
      applicationId: "app-hightouch",
      gap,
      answer: "https://www.linkedin.com/in/riley",
    });

    expect(api.runWorkspaceIntent).toHaveBeenCalledWith(
      "screening.answer-confirm",
      { type: "application", id: "app-hightouch" },
      {
        questionId: "linkedin-profile",
        question: "LinkedIn Profile",
        answer: "https://www.linkedin.com/in/riley",
      }
    );
    expect(api.appendJobThreadMessage).toHaveBeenNthCalledWith(1, {
      applicationId: "app-hightouch",
      role: "user",
      kind: "text",
      text: "LinkedIn Profile: https://www.linkedin.com/in/riley",
    });
    expect(api.appendJobThreadMessage).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        applicationId: "app-hightouch",
        role: "assistant",
        text: "Confirmed this answer. 1 packet item still needs review.",
        metadata: { state: "confirmed", persisted: true, gapCount: 1 },
      })
    );
  });

  it("resumes the paused mission that owns a packet instead of starting an orphan prepare action", async () => {
    const api = {
      resumeChatFirstMission: vi.fn().mockResolvedValue({ data: { mission: { id: "mission-1" } } }),
      runWorkspaceIntent: vi.fn(),
    };
    const missions = [
      {
        id: "mission-1",
        status: "paused",
        steps: [
          {
            id: "prepare",
            action: "prepare-submit",
            status: "blocked",
            result: { applicationId: "app-hightouch", state: "blocked" },
          },
        ],
      },
    ];

    await expect(
      resumePacketPreparation({ api, missions, applicationId: "app-hightouch" })
    ).resolves.toMatchObject({ data: { mission: { id: "mission-1" } } });
    expect(api.resumeChatFirstMission).toHaveBeenCalledWith("mission-1");
    expect(api.runWorkspaceIntent).not.toHaveBeenCalled();
  });

  it("creates and runs a durable application mission when no paused mission remains", async () => {
    const api = {
      resumeChatFirstMission: vi.fn(),
      createChatFirstMission: vi
        .fn()
        .mockResolvedValue({ data: { mission: { id: "mission-fresh" } } }),
      runChatFirstMission: vi
        .fn()
        .mockResolvedValue({ data: { mission: { id: "mission-fresh", status: "paused" } } }),
      runWorkspaceIntent: vi.fn(),
    };

    await expect(
      resumePacketPreparation({ api, missions: [], applicationId: "app-hightouch" })
    ).resolves.toMatchObject({ data: { mission: { id: "mission-fresh" } } });
    expect(api.resumeChatFirstMission).not.toHaveBeenCalled();
    expect(api.createChatFirstMission).toHaveBeenCalledWith({
      title: "Prepare this application",
      mode: "prepare-to-submit",
      requiresUserSubmit: true,
      jobs: [{ type: "application", id: "app-hightouch" }],
    });
    expect(api.runChatFirstMission).toHaveBeenCalledWith("mission-fresh");
    expect(api.runWorkspaceIntent).not.toHaveBeenCalled();
  });

  it("ignores unrelated or completed paused missions when resuming packet preparation", async () => {
    const api = {
      resumeChatFirstMission: vi.fn().mockResolvedValue({ ok: true }),
    };
    const missions = [
      {
        id: "mission-unrelated",
        status: "paused",
        updatedAt: "2026-08-27T12:00:00.000Z",
        steps: [
          {
            action: "evaluate",
            status: "blocked",
            result: { applicationId: "app-hightouch" },
          },
        ],
      },
      {
        id: "mission-finished-prepare",
        status: "paused",
        updatedAt: "2026-08-27T11:00:00.000Z",
        steps: [
          {
            action: "prepare-submit",
            status: "completed",
            result: { applicationId: "app-hightouch" },
          },
        ],
      },
      {
        id: "mission-current-prepare",
        status: "paused",
        updatedAt: "2026-08-27T10:00:00.000Z",
        steps: [
          {
            action: "prepare-submit",
            status: "blocked",
            result: { applicationId: "app-hightouch" },
          },
        ],
      },
    ];

    await resumePacketPreparation({ api, missions, applicationId: "app-hightouch" });

    expect(api.resumeChatFirstMission).toHaveBeenCalledWith("mission-current-prepare");
  });

  it("treats form preparation as ready only when its supported application sites are allowed", () => {
    expect(applicationPreparationPermission({ capabilities: [] })).toMatchObject({
      status: "blocked",
      ready: false,
    });
    expect(
      applicationPreparationPermission({
        capabilities: [
          {
            capability: "authenticated_apply_preparation",
            enabled: true,
            platforms: [
              { platform: "greenhouse", allowed: true },
              { platform: "external_ats", allowed: false },
            ],
          },
        ],
      })
    ).toMatchObject({ status: "blocked", ready: false });
    expect(
      applicationPreparationPermission({
        capabilities: [
          {
            capability: "authenticated_apply_preparation",
            enabled: true,
            platforms: [
              { platform: "greenhouse", allowed: true },
              { platform: "external_ats", allowed: true },
            ],
          },
        ],
      })
    ).toMatchObject({ status: "ready", ready: true });
  });

  it("enables supervised form preparation in place and re-reads the effective permission", async () => {
    const automation = {
      capabilities: [
        {
          capability: "authenticated_apply_preparation",
          enabled: true,
          platforms: [{ platform: "greenhouse", allowed: true }],
        },
      ],
    };
    const api = {
      runWorkspaceIntent: vi.fn().mockResolvedValue({ ok: true }),
      getAutomationSettings: vi.fn().mockResolvedValue(automation),
    };

    await expect(enableApplicationPreparation({ api })).resolves.toMatchObject({
      status: "ready",
      ready: true,
    });
    expect(api.runWorkspaceIntent).toHaveBeenCalledWith(
      "settings.apply",
      { type: "workspace", id: "workspace-main" },
      {
        change: {
          kind: "automation",
          op: "contextual-permission",
          permission: "application-preparation",
        },
      }
    );
    expect(api.getAutomationSettings).toHaveBeenCalledOnce();
  });

  it("does not claim form permission when the server-owned write fails", async () => {
    const api = {
      runWorkspaceIntent: vi.fn().mockRejectedValue(new Error("write failed")),
      getAutomationSettings: vi.fn(),
    };

    await expect(enableApplicationPreparation({ api })).rejects.toThrow("write failed");
    expect(api.getAutomationSettings).not.toHaveBeenCalled();
  });

  it("creates draft-only and prepare-to-submit cart missions from current rows", async () => {
    const api = {
      createChatFirstMission: vi.fn().mockResolvedValue({ data: { mission: { id: "m2" } } }),
      runChatFirstMission: vi.fn().mockResolvedValue({ data: { mission: { id: "m2" } } }),
    };
    const rows = [{ id: "s1", source: "sourced", company: "Tyrell", role: "Staff", fit: 88 }];

    await createMissionAndRun({ api, selection: ["s1"], rows, mode: "draft" });

    expect(api.createChatFirstMission).toHaveBeenCalledWith({
      title: "Draft 1 packet",
      mode: "draft",
      requiresUserSubmit: true,
      jobs: [{ id: "s1", type: "sourced", company: "Tyrell", role: "Staff", fit: 88 }],
    });
    expect(api.runChatFirstMission).toHaveBeenCalledWith("m2");
  });

  it("finds durable submit gates and opens only safe application handoffs", () => {
    const gate = findGate(
      [
        {
          id: "mission-1",
          steps: [
            {
              id: "submit-1",
              action: "submit-gate",
              status: "blocked",
              jobRef: { company: "E Corp", role: "Staff SWE" },
              result: {
                applicationId: "app-1",
                requiresUserSubmit: true,
                answeredCount: 2,
                questionCount: 3,
                packet: [
                  { id: "resume", name: "resume.pdf", kind: "Resume" },
                  { id: "coverLetter", name: "cover-letter.pdf", kind: "Cover letter" },
                ],
              },
            },
          ],
        },
      ],
      "mission-1:submit-1",
      {
        "app-1": {
          artifacts: [
            {
              kind: "Application handoff",
              url: "https://jobs.example.test/submit",
              channel: "Greenhouse",
            },
          ],
        },
      }
    );
    const open = vi.fn();

    expect(gate).toMatchObject({
      company: "E Corp",
      applicationId: "app-1",
      channel: "Greenhouse",
      answeredCount: 2,
      questionCount: 3,
      packet: [
        { id: "resume", name: "resume.pdf", kind: "Resume", icon: "📄" },
        { id: "coverLetter", name: "cover-letter.pdf", kind: "Cover letter", icon: "✉️" },
      ],
    });
    expect(openApplicationHandoff(gate, open)).toBe(true);
    expect(open).toHaveBeenCalledWith(
      "https://jobs.example.test/submit",
      "_blank",
      "noopener,noreferrer"
    );
    expect(openApplicationHandoff({ handoffUrl: "javascript:alert(1)" }, open)).toBe(false);
  });

  it("returns a submit gate through its durable mission owner instead of a workspace shortcut", async () => {
    const api = {
      resumeChatFirstMission: vi.fn().mockResolvedValue({ data: { mission: { id: "mission-1" } } }),
      runWorkspaceIntent: vi.fn(),
    };
    const gate = {
      missionId: "mission-1",
      applicationId: "app-1",
      handoffUrl: "https://jobs.example.test/submit",
    };

    await expect(focusApplicationHandoff(gate, api)).resolves.toBe(true);
    expect(api.resumeChatFirstMission).toHaveBeenCalledWith("mission-1", {
      focusApplicationId: "app-1",
    });
    expect(api.runWorkspaceIntent).not.toHaveBeenCalled();
  });

  it("does not fall back to a fresh URL when a submit gate has no retained application owner", async () => {
    const api = { resumeChatFirstMission: vi.fn() };

    await expect(
      focusApplicationHandoff({ handoffUrl: "https://jobs.example.test/submit" }, api)
    ).resolves.toBe(false);
    expect(api.resumeChatFirstMission).not.toHaveBeenCalled();
  });

  it("resolves every canonical Needs You decision to its durable owner action", () => {
    const sourced = {
      kind: "sourced-decision",
      sourceId: "source-1",
      title: "Apply to E Corp?",
      actions: [
        { id: "apply", body: { id: "source-1", decision: "apply" } },
        { id: "skip", body: { id: "source-1", decision: "skip" } },
      ],
    };
    expect(resolveNeedDecision(sourced, "primary")).toEqual({
      kind: "sourced-decision",
      payload: { id: "source-1", decision: "apply" },
    });
    expect(resolveNeedDecision(sourced, "secondary")).toEqual({
      kind: "sourced-decision",
      payload: { id: "source-1", decision: "skip" },
    });

    const sourcedGroup = {
      kind: "sourced-decision-group",
      sourceIds: ["source-1", "source-2", "source-3"],
    };
    expect(resolveNeedDecision(sourcedGroup, "primary")).toEqual({
      kind: "sourced-batch-apply",
      ids: ["source-1", "source-2", "source-3"],
    });
    expect(resolveNeedDecision(sourcedGroup, "secondary")).toEqual({
      kind: "review-sourced-batch",
      ids: ["source-1", "source-2", "source-3"],
    });

    const touch = {
      kind: "touch-due",
      touchId: "comm-1",
      owner: { type: "communication", id: "comm-1", applicationId: "app-1" },
      title: "Nudge Angela?",
      actions: [
        { id: "draft", kind: "open-owner" },
        { id: "dismiss", body: { id: "comm-1", source: "communication" } },
      ],
    };
    expect(resolveNeedDecision(touch, "primary")).toEqual({
      kind: "draft-touch",
      applicationId: "app-1",
      prompt: "Draft a nudge for Angela.",
    });
    expect(resolveNeedDecision(touch, "secondary")).toEqual({
      kind: "dismiss-touch",
      payload: { id: "comm-1", source: "communication" },
    });

    expect(
      resolveNeedDecision({ kind: "application-next-action", applicationId: "app-2" }, "primary")
    ).toEqual({ kind: "open-application", applicationId: "app-2" });
    expect(resolveNeedDecision({ kind: "submit-gate", id: "mission:gate" }, "primary")).toEqual({
      kind: "open-gate",
      gateId: "mission:gate",
    });
    expect(
      resolveNeedDecision(
        { kind: "submit-gate-group", gateIds: ["mission-a:gate", "mission-b:gate"] },
        "primary"
      )
    ).toEqual({ kind: "open-gate", gateId: "mission-a:gate" });
  });

  it("maps durable search-run snapshots without claiming a running sweep completed", () => {
    expect(
      sourceSweepPresentation({
        run: {
          id: "manual-1",
          status: "running",
          progress: { completedSources: 2, totalSources: 5, foundCount: 7 },
        },
      })
    ).toEqual({
      id: "manual-1",
      status: "running",
      detail: "2 of 5 sources checked · 7 found",
    });
    expect(
      sourceSweepPresentation({
        status: "completed",
        completedAt: "2026-08-23T15:00:00.000Z",
        summary: { new: 4, qualified: 3, scanned: 91, attemptedSources: 5 },
      })
    ).toMatchObject({
      status: "complete",
      summary: "4 new · 3 qualified · 91 scanned · 5 sources",
    });
    expect(
      sourceSweepPresentation({ status: "failed", error: { message: "Board access failed" } })
    ).toEqual({ status: "error", summary: "Board access failed" });
  });

  it("shows persisted matches instead of treating a dedupe-only refresh as zero useful jobs", () => {
    const completed = sourceSweepPresentation({
      status: "completed",
      summary: { new: 0, qualified: 0, scanned: 358, attemptedSources: 5 },
    });

    expect(sourceSweepWithAvailableMatches(completed, 7)).toMatchObject({
      status: "complete",
      summary: "7 matches ready · 0 new · 358 scanned · 5 sources",
    });
    expect(sourceSweepWithAvailableMatches(completed, 0)).toBe(completed);
  });

  it("keeps provider and source labels exposed by durable sweep progress", () => {
    expect(
      sourceSweepPresentation({
        id: "manual-labeled",
        status: "running",
        progress: {
          completedSources: 1,
          totalSources: 3,
          foundCount: 4,
          providers: ["Greenhouse", { label: "Lever" }],
          batch: { kind: "company", label: "Acme careers" },
        },
      })
    ).toEqual({
      id: "manual-labeled",
      status: "running",
      detail: "1 of 3 sources checked · 4 found",
      providers: ["Greenhouse", "Lever", "Acme careers"],
    });
  });

  it("maps a durable mock session into the prototype conversation contract", () => {
    expect(
      mapMockSession({
        id: "mock-1",
        questionTotal: 6,
        currentQuestion: 2,
        messages: [
          { id: "q1", role: "assistant", kind: "question", questionNumber: 2, text: "Why now?" },
          { id: "a1", role: "user", kind: "answer", questionNumber: 2, text: "Because…" },
        ],
        feedback: [{ questionNumber: 2, worked: "Specific", tighten: "Lead with impact" }],
      })
    ).toMatchObject({
      questionNumber: 2,
      totalQuestions: 6,
      question: "Why now?",
      userAnswer: "Because…",
      worked: "Specific",
      tighten: "Lead with impact",
    });
  });

  it("preserves explicit negative feedback instead of treating false as unreviewed", () => {
    const mapped = mapMockSession({
      id: "mock-negative-feedback",
      currentQuestion: 2,
      messages: [
        { id: "q1", role: "assistant", kind: "question", questionNumber: 1, text: "Why now?" },
        { id: "q2", role: "assistant", kind: "question", questionNumber: 2, text: "Why us?" },
      ],
      feedback: [
        { questionNumber: 1, worked: false },
        { questionNumber: 2, worked: false },
      ],
    });

    expect(mapped.worked).toBe(false);
    expect(mapped.previousFeedback.worked).toBe(false);
    expect(mapped.turns[0].worked).toBe(false);
    expect(mapped.turns[1].worked).toBe(false);
  });

  it("keeps the backend's current question after feedback and maps supplied interview context", () => {
    expect(
      mapMockSession({
        id: "mock-2",
        title: "Hiring manager practice",
        questionTotal: 6,
        currentQuestion: 3,
        context: {
          company: "Cyberdyne",
          round: "Hiring manager",
          interviewer: { name: "Nina Sharp", role: "VP Engineering" },
          loadedContext: "Dossier and Nexus story",
        },
        messages: [
          { id: "q2", role: "assistant", kind: "question", questionNumber: 2, text: "Why now?" },
          { id: "a2", role: "user", kind: "answer", questionNumber: 2, text: "Because…" },
          {
            id: "q3",
            role: "assistant",
            kind: "question",
            questionNumber: 3,
            text: "Tell me about the migration.",
          },
        ],
        feedback: [{ questionNumber: 2, worked: "Specific", tighten: "Lead with impact" }],
      })
    ).toEqual({
      id: "mock-2",
      status: "active",
      summary: null,
      title: "Hiring manager practice",
      company: "Cyberdyne",
      round: "Hiring manager",
      interviewer: "Nina Sharp",
      interviewerHint: "Nina Sharp · VP Engineering",
      loadedContext: "Dossier and Nexus story",
      questionNumber: 3,
      totalQuestions: 6,
      questionReady: true,
      question: "Tell me about the migration.",
      userAnswer: null,
      worked: null,
      tighten: null,
      previousFeedback: {
        questionNumber: 2,
        worked: "Specific",
        tighten: "Lead with impact",
      },
      retryPrompt: null,
      turns: [
        {
          questionId: "q2",
          questionNumber: 2,
          question: "Why now?",
          answer: "Because…",
          worked: "Specific",
          tighten: "Lead with impact",
        },
        {
          questionId: "q3",
          questionNumber: 3,
          question: "Tell me about the migration.",
          answer: null,
          worked: null,
          tighten: null,
        },
      ],
    });
  });

  it("marks an empty durable mock as preparing instead of inventing a fallback question", () => {
    expect(
      mapMockSession({
        id: "mock-preparing",
        status: "active",
        questionTotal: 6,
        currentQuestion: 0,
        messages: [],
        feedback: [],
      })
    ).toMatchObject({
      status: "active",
      questionReady: false,
      question: null,
      turns: [],
    });
  });

  it("maps every ended-session turn and its feedback for durable review", () => {
    expect(
      mapMockSession({
        id: "mock-ended",
        status: "ended",
        summary: "Strong evidence. Tighten the tradeoff.",
        questionTotal: 2,
        currentQuestion: 2,
        messages: [
          { id: "q1", kind: "question", questionNumber: 1, text: "Why this role?" },
          { id: "a1", kind: "answer", questionNumber: 1, text: "The product fit." },
          { id: "q2", kind: "question", questionNumber: 2, text: "Describe the migration." },
          { id: "a2", kind: "answer", questionNumber: 2, text: "I led three teams." },
        ],
        feedback: [
          { questionNumber: 1, worked: "Specific motivation", tighten: "Name the user" },
          { questionNumber: 2, worked: "Clear ownership", tighten: "Explain the tradeoff" },
        ],
      })
    ).toMatchObject({
      status: "ended",
      summary: "Strong evidence. Tighten the tradeoff.",
      questionReady: true,
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
    });
  });

  it("reselects the owning job's ended mock after a dashboard reload", () => {
    expect(
      selectMockSession(
        [
          { id: "mock-other", applicationId: "app-other", status: "active" },
          { id: "mock-ended", applicationId: "app-1", status: "ended" },
        ],
        "app-1"
      )
    ).toMatchObject({ id: "mock-ended", status: "ended" });
    expect(
      selectMockSession(
        [
          { id: "mock-ended", applicationId: "app-1", status: "ended" },
          { id: "mock-active", applicationId: "app-1", status: "active" },
        ],
        "app-1"
      )
    ).toMatchObject({ id: "mock-active", status: "active" });
  });

  it("builds mock-session display context from the owning job and latest real round", () => {
    expect(
      mockStartContext(
        { company: "Cyberdyne", role: "Staff ML Engineer", stage: "interview" },
        {
          conversations: [
            {
              kind: "hiring manager",
              who: "Nina Sharp",
              processNote: "VP Engineering",
            },
          ],
          artifacts: [{ kind: "Interview dossier", name: "Cyberdyne dossier" }],
        }
      )
    ).toEqual({
      title: "Hiring manager practice",
      context: {
        company: "Cyberdyne",
        role: "Staff ML Engineer",
        round: "Hiring manager",
        interviewer: { name: "Nina Sharp", role: "VP Engineering" },
        loadedContext: "Cyberdyne dossier · confirmed story bank",
      },
    });
  });

  it("uses a neutral interview round when a reviewed job has no scheduled round yet", () => {
    expect(
      mockStartContext(
        { company: "Curri", role: "Senior Software Engineer", stage: "reviewed hold" },
        {}
      )
    ).toMatchObject({
      title: "Interview practice",
      context: {
        company: "Curri",
        role: "Senior Software Engineer",
        round: "Interview",
      },
    });
  });

  it("opens safe calendar handoffs and downloads the generated calendar file", () => {
    const groups = [
      {
        day: "THURSDAY",
        items: [
          {
            id: "event-1",
            export: {
              googleUrl: "https://calendar.google.com/calendar/render?action=TEMPLATE",
              outlookUrl: "https://outlook.live.com/calendar/0/deeplink/compose?subject=Interview",
              filename: "interview.ics",
              ics: "BEGIN:VCALENDAR\r\nEND:VCALENDAR",
            },
          },
        ],
      },
    ];
    const open = vi.fn();
    const link = { click: vi.fn(), remove: vi.fn() };
    const documentRef = {
      body: { appendChild: vi.fn() },
      createElement: vi.fn(() => link),
    };

    expect(calendarAction("Google", groups, { openWindow: open, documentRef })).toBe(true);
    expect(open).toHaveBeenCalledWith(
      "https://calendar.google.com/calendar/render?action=TEMPLATE",
      "_blank",
      "noopener,noreferrer"
    );
    expect(calendarAction("Outlook", groups, { openWindow: open, documentRef })).toBe(true);
    expect(calendarAction("Download file", groups, { openWindow: open, documentRef })).toBe(true);
    expect(link.download).toBe("interview.ics");
    expect(link.href).toContain("data:text/calendar;charset=utf-8,");
    expect(link.click).toHaveBeenCalledOnce();
    expect(link.remove).toHaveBeenCalledOnce();
  });

  it("refuses unsafe or incomplete calendar exports", () => {
    const open = vi.fn();
    const schedule = [
      {
        day: "UPCOMING",
        items: [
          {
            export: {
              googleUrl: "javascript:alert(1)",
              filename: "../bad.ics",
              ics: "not a calendar",
            },
          },
        ],
      },
    ];

    expect(calendarAction("Google", schedule, { openWindow: open })).toBe(false);
    expect(
      calendarAction("Download file", schedule, {
        documentRef: { body: {}, createElement: vi.fn() },
      })
    ).toBe(false);
    expect(open).not.toHaveBeenCalled();
  });

  it("detects when the selected local AI runtime is unavailable", () => {
    expect(
      engineUnavailable({
        selectedId: "claude",
        providerFallback: false,
        runtimes: [{ id: "claude", ready: false }],
      })
    ).toBe(true);
    expect(
      engineUnavailable({
        selectedId: "codex",
        providerFallback: false,
        runtimes: [{ id: "codex", ready: true }],
      })
    ).toBe(false);
    expect(
      engineUnavailable({
        providerFallback: true,
        providerFallbackAllowed: true,
        runtimes: [],
      })
    ).toBe(false);
    expect(
      engineUnavailable({
        providerFallback: true,
        providerFallbackAllowed: false,
        runtimes: [],
      })
    ).toBe(true);
  });

  it("does not cover the workspace for ordinary validation errors", () => {
    expect(isEngineFailure({ status: 422, body: { code: "BAD_REQUEST" } })).toBe(false);
    expect(isEngineFailure({ status: 422, body: { code: "AI_RUNTIME_UNAVAILABLE" } })).toBe(true);
    expect(isEngineFailure({ status: 502, body: { code: "UPSTREAM_FAILURE" } })).toBe(true);
  });

  it("downloads a plain-text evidence artifact with a safe filename", () => {
    const link = { click: vi.fn(), remove: vi.fn() };
    const documentRef = {
      body: { appendChild: vi.fn() },
      createElement: vi.fn(() => link),
    };

    expect(
      downloadTextArtifact(
        { name: "Nexus / launch story", text: "Reduced launch time by 30%." },
        documentRef
      )
    ).toBe(true);
    expect(link.download).toBe("Nexus-launch-story.txt");
    expect(link.href).toContain("data:text/plain;charset=utf-8,");
    expect(link.click).toHaveBeenCalledOnce();
  });

  it("downloads a rendered PDF response and revokes its temporary browser URL", () => {
    const link = { click: vi.fn(), remove: vi.fn() };
    const documentRef = {
      body: { appendChild: vi.fn() },
      createElement: vi.fn(() => link),
    };
    const urlApi = { createObjectURL: vi.fn(() => "blob:dossier"), revokeObjectURL: vi.fn() };
    const result = { blob: new Blob(["%PDF-1.7"]), filename: "cyberdyne-dossier.pdf" };

    expect(downloadBinaryArtifact(result, { documentRef, urlApi })).toBe(true);
    expect(link.href).toBe("blob:dossier");
    expect(link.download).toBe("cyberdyne-dossier.pdf");
    expect(link.click).toHaveBeenCalledOnce();
    expect(link.remove).toHaveBeenCalledOnce();
    expect(urlApi.revokeObjectURL).toHaveBeenCalledWith("blob:dossier");
  });
});
