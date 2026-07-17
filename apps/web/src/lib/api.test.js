import { afterEach, describe, expect, it, vi } from "vitest";
import { runAiWebSearchStream, streamResumeAi } from "./api.js";

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

    await runAiWebSearchStream({ onEvent: (event) => events.push(event) });

    expect(fetchMock).toHaveBeenCalledWith("/api/search/ai-web-search/run", {
      method: "POST",
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
