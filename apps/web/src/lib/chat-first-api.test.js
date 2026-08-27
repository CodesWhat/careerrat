import { afterEach, describe, expect, it, vi } from "vitest";
import {
  appendJobThreadMessage,
  archiveJobThread,
  createChatFirstMission,
  decideChatFirstSourced,
  dismissDeepIngestPrompt,
  dismissTouchDue,
  endMockInterview,
  exportInterviewDossierPdf,
  pinJobThread,
  recordMockFeedback,
  resumeChatFirstMission,
  runChatFirstMission,
  sendJobThreadTurn,
  sendMockInterviewMessage,
  sendMockInterviewTurn,
  setChatFirstMissionStatus,
  setChatFirstMissionStepStatus,
  startMockInterview,
  upsertDeepIngestConfirmedItem,
} from "./api.js";

afterEach(() => vi.unstubAllGlobals());

function okFetch() {
  const fetchMock = vi.fn(
    async () =>
      new Response(JSON.stringify({ ok: true, data: {} }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })
  );
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

describe("chat-first durable actions", () => {
  it("writes job thread pin and archive decisions through their domain routes", async () => {
    const fetchMock = okFetch();

    await pinJobThread({ applicationId: "app-1", pinned: true });
    await archiveJobThread({ applicationId: "app-1", archived: true });
    await appendJobThreadMessage({
      applicationId: "app-1",
      role: "user",
      text: "Coach me on the offer.",
    });

    expect(fetchMock.mock.calls).toEqual([
      [
        "/api/chat-first/job-thread/pin",
        {
          method: "POST",
          body: JSON.stringify({ applicationId: "app-1", pinned: true }),
          headers: { "content-type": "application/json" },
        },
      ],
      [
        "/api/chat-first/job-thread/archive",
        {
          method: "POST",
          body: JSON.stringify({ applicationId: "app-1", archived: true }),
          headers: { "content-type": "application/json" },
        },
      ],
      [
        "/api/chat-first/job-thread/message",
        {
          method: "POST",
          body: JSON.stringify({
            applicationId: "app-1",
            role: "user",
            text: "Coach me on the offer.",
          }),
          headers: { "content-type": "application/json" },
        },
      ],
    ]);
  });

  it("durably dismisses a touch-due decision", async () => {
    const fetchMock = okFetch();

    await dismissTouchDue({ id: "comm-touch", source: "communication" });

    expect(fetchMock).toHaveBeenCalledWith("/api/chat-first/touch-due/dismiss", {
      method: "POST",
      body: JSON.stringify({ id: "comm-touch", source: "communication" }),
      headers: { "content-type": "application/json" },
    });
  });

  it("durably dismisses the deep ingest dock", async () => {
    const fetchMock = okFetch();

    await dismissDeepIngestPrompt();

    expect(fetchMock).toHaveBeenCalledWith("/api/chat-first/deep-ingest-prompt/dismiss", {
      method: "POST",
      body: JSON.stringify({}),
      headers: { "content-type": "application/json" },
    });
  });

  it("saves a manually edited confirmed writing style", async () => {
    const fetchMock = okFetch();
    const payload = {
      lane: "writing_voice",
      id: "voice-1",
      fields: { summary: "Plain, direct, concrete." },
    };

    await upsertDeepIngestConfirmedItem(payload);

    expect(fetchMock).toHaveBeenCalledWith("/api/deep-ingest/confirmed/upsert", {
      method: "POST",
      body: JSON.stringify(payload),
      headers: { "content-type": "application/json" },
    });
  });

  it("writes sourced apply, skip, or restore decisions through the canonical route", async () => {
    const fetchMock = okFetch();
    const payload = {
      id: "source-1",
      decision: "apply",
      mode: "prepare-to-submit",
    };

    await decideChatFirstSourced(payload);

    expect(fetchMock).toHaveBeenCalledWith("/api/chat-first/sourced/decision", {
      method: "POST",
      body: JSON.stringify(payload),
      headers: { "content-type": "application/json" },
    });
  });

  it("exports an interview dossier as a real PDF attachment", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(Buffer.from("%PDF-1.7\ninterview dossier\n%%EOF", "utf8"), {
          status: 200,
          headers: {
            "content-type": "application/pdf",
            "content-disposition": 'attachment; filename="acme-engineer.pdf"',
            "x-careerrat-artifact-path": encodeURIComponent(
              "workspace/interview-prep/acme-engineer.pdf"
            ),
          },
        })
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await exportInterviewDossierPdf({
      applicationId: "app-dossier",
      artifactPath: "workspace/interview-prep/acme-engineer.md",
    });

    expect(fetchMock).toHaveBeenCalledWith("/api/chat-first/dossier/pdf", {
      method: "POST",
      body: JSON.stringify({
        applicationId: "app-dossier",
        artifactPath: "workspace/interview-prep/acme-engineer.md",
      }),
      headers: { "content-type": "application/json" },
    });
    expect(result.filename).toBe("acme-engineer.pdf");
    expect(result.path).toBe("workspace/interview-prep/acme-engineer.pdf");
    expect(await result.blob.text()).toMatch(/^%PDF-/);
  });

  it("creates, runs, and pauses durable missions without an automatic-submit option", async () => {
    const fetchMock = okFetch();
    const mission = {
      title: "Prepare 2 applications",
      requiresUserSubmit: true,
      jobs: [
        { type: "sourced", id: "source-1" },
        { type: "application", id: "app-1" },
      ],
    };

    await createChatFirstMission(mission);
    await runChatFirstMission("mission-1");
    await resumeChatFirstMission("mission-1");
    await resumeChatFirstMission("mission-1", { focusApplicationId: "app-1" });
    await setChatFirstMissionStatus({ id: "mission-1", status: "paused" });
    await setChatFirstMissionStepStatus({
      missionId: "mission-1",
      stepId: "submit-app-1",
      status: "completed",
      result: { submittedByUser: true },
    });

    const calls = fetchMock.mock.calls.map(([path, options]) => [path, JSON.parse(options.body)]);
    expect(calls).toEqual([
      ["/api/chat-first/missions", mission],
      ["/api/chat-first/missions/run", { id: "mission-1" }],
      ["/api/chat-first/missions/resume", { id: "mission-1" }],
      ["/api/chat-first/missions/resume", { id: "mission-1", focusApplicationId: "app-1" }],
      ["/api/chat-first/missions/status", { id: "mission-1", status: "paused" }],
      [
        "/api/chat-first/missions/step",
        {
          missionId: "mission-1",
          stepId: "submit-app-1",
          status: "completed",
          result: { submittedByUser: true },
        },
      ],
    ]);
    expect(JSON.stringify(calls)).not.toMatch(/automaticSubmit|auto-submit/i);
  });

  it("drives a durable mock interview session", async () => {
    const fetchMock = okFetch();

    await startMockInterview({
      applicationId: "app-1",
      questionTotal: 6,
      title: "Technical mock interview",
      context: { interviewer: "Miles" },
    });
    await sendMockInterviewMessage({
      sessionId: "mock-1",
      role: "user",
      kind: "answer",
      questionNumber: 1,
      text: "I start from the SLO.",
    });
    await recordMockFeedback({
      sessionId: "mock-1",
      messageId: "answer-1",
      questionNumber: 1,
      worked: "Good framing",
      tighten: "Add a rollout number",
    });
    await endMockInterview({ sessionId: "mock-1", summary: "Strong start." });

    const calls = fetchMock.mock.calls.map(([path, options]) => [path, JSON.parse(options.body)]);
    expect(calls).toEqual([
      [
        "/api/chat-first/mock/start",
        {
          applicationId: "app-1",
          questionTotal: 6,
          title: "Technical mock interview",
          context: { interviewer: "Miles" },
        },
      ],
      [
        "/api/chat-first/mock/message",
        {
          sessionId: "mock-1",
          role: "user",
          kind: "answer",
          questionNumber: 1,
          text: "I start from the SLO.",
        },
      ],
      [
        "/api/chat-first/mock/feedback",
        {
          sessionId: "mock-1",
          messageId: "answer-1",
          questionNumber: 1,
          worked: "Good framing",
          tighten: "Add a rollout number",
        },
      ],
      ["/api/chat-first/mock/end", { sessionId: "mock-1", summary: "Strong start." }],
    ]);
  });

  it("runs durable assistant turns for job threads and mock interviews", async () => {
    const fetchMock = okFetch();
    const choice = { promptId: "choice-offer", version: 1, optionIds: ["yes"] };

    await sendJobThreadTurn({ applicationId: "app-1", text: "Yes", choice });
    await sendMockInterviewTurn({ sessionId: "mock-1", text: "I led the migration." });

    const calls = fetchMock.mock.calls.map(([path, options]) => [path, JSON.parse(options.body)]);
    expect(calls).toEqual([
      ["/api/chat-first/job-thread/turn", { applicationId: "app-1", text: "Yes", choice }],
      ["/api/chat-first/mock/turn", { sessionId: "mock-1", text: "I led the migration." }],
    ]);
  });
});
