import { afterEach, describe, expect, it, vi } from "vitest";
import {
  applyOnSite,
  markCommSent,
  promoteSourced,
  recordExternalApplication,
  runAiWebSearchStream,
  scheduleInterview,
  setAppStatus,
  setSourcedStatus,
  streamResumeAi,
} from "./api.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("runAiWebSearchStream", () => {
  it("uses the shared split-frame/comment parser for AI lane events", async () => {
    const encoder = new TextEncoder();
    const body = new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode(": ping\n\nda"));
        controller.enqueue(
          encoder.encode(
            'ta: {"type":"activity","message":"Searching"}\n\n' +
              'data: {"type":"done","data":{"searched":1,"found":1,"new":1,"duplicates":0,"errors":[]}}'
          )
        );
        controller.close();
      },
    });
    const fetchMock = vi.fn(async () => new Response(body, { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const events = [];

    await runAiWebSearchStream({
      onEvent: (event) => events.push(event),
      promptIds: ["p2"],
    });

    expect(fetchMock).toHaveBeenCalledWith("/api/search/ai-web-search/run", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ promptIds: ["p2"] }),
      signal: undefined,
    });
    expect(events).toEqual([
      { type: "activity", message: "Searching" },
      {
        type: "done",
        data: { searched: 1, found: 1, new: 1, duplicates: 0, errors: [] },
      },
    ]);
  });
});

describe("streamResumeAi", () => {
  it("parses split SSE frames, skips comments and malformed data, and flushes the final frame", async () => {
    const chunks = [
      "da",
      'ta: {"type":"saved","saved',
      'Path":"workspace/resume.pdf"}\n\n: ping\n\ndata: not-json\n\ndata: {"type":"json",',
      '"chunk":"{\\"candidate\\":"}\n\n: ping\n\n',
      'data: {"type":"done","data":{"source":"ai"}}',
    ];
    const encoder = new TextEncoder();
    const body = new ReadableStream({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
        controller.close();
      },
    });
    const fetchMock = vi.fn(async () => new Response(body, { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const events = [];
    const signal = new AbortController().signal;
    const file = { name: "résumé 2026.pdf" };

    await streamResumeAi(file, { onEvent: (event) => events.push(event), signal });

    expect(events).toEqual([
      { type: "saved", savedPath: "workspace/resume.pdf" },
      { type: "json", chunk: '{"candidate":' },
      { type: "done", data: { source: "ai" } },
    ]);
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/onboard/resume-ai-stream?name=r%C3%A9sum%C3%A9%202026.pdf",
      { method: "POST", body: file, signal }
    );
  });
});

describe("chat-first workflow actions", () => {
  it("submits visible job actions as typed intents to workspace-main", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ ok: true, data: { operationResult: { ok: true } } }), {
          status: 200,
          headers: { "content-type": "application/json" },
        })
    );
    vi.stubGlobal("fetch", fetchMock);

    await promoteSourced({ id: "source-1" });
    await setSourcedStatus({ id: "source-2", to: "cut", note: "Travel" });
    await scheduleInterview({
      id: "app-1",
      at: "2030-08-14T18:30:00.000Z",
      round: "hiring manager",
      note: "With Avery",
    });
    await setAppStatus({ id: "app-1", to: "offer", note: "Verbal offer" });
    await recordExternalApplication({ id: "app-2", appliedAt: "2026-08-09T15:45:00.000Z" });
    await applyOnSite({ id: "app-3" });
    await markCommSent({ id: "comm-1", at: "2026-08-09T17:30:00.000Z" });

    const bodies = fetchMock.mock.calls.map(([path, options]) => [path, JSON.parse(options.body)]);
    expect(bodies).toEqual([
      [
        "/api/workspace/intent",
        {
          intent: {
            type: "sourced.promote",
            entity: { type: "sourced", id: "source-1" },
            input: {},
          },
        },
      ],
      [
        "/api/workspace/intent",
        {
          intent: {
            type: "sourced.skip",
            entity: { type: "sourced", id: "source-2" },
            input: { note: "Travel" },
          },
        },
      ],
      [
        "/api/workspace/intent",
        {
          intent: {
            type: "interview.schedule",
            entity: { type: "application", id: "app-1" },
            input: {
              at: "2030-08-14T18:30:00.000Z",
              round: "hiring manager",
              note: "With Avery",
            },
          },
        },
      ],
      [
        "/api/workspace/intent",
        {
          intent: {
            type: "outcome.record",
            entity: { type: "application", id: "app-1" },
            input: { to: "offer", note: "Verbal offer" },
          },
        },
      ],
      [
        "/api/workspace/intent",
        {
          intent: {
            type: "application.record-external",
            entity: { type: "application", id: "app-2" },
            input: { appliedAt: "2026-08-09T15:45:00.000Z" },
          },
        },
      ],
      [
        "/api/workspace/intent",
        {
          intent: {
            type: "job.apply",
            entity: { type: "application", id: "app-3" },
            input: {},
          },
        },
      ],
      [
        "/api/workspace/intent",
        {
          intent: {
            type: "communication.record-external",
            entity: { type: "communication", id: "comm-1" },
            input: { sentAt: "2026-08-09T17:30:00.000Z" },
          },
        },
      ],
    ]);
  });
});
