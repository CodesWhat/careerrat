import { afterEach, describe, expect, it, vi } from "vitest";
import {
  applyOnSite,
  completeDiscovery,
  exportPacketDocuments,
  extractResumeAi,
  finishOnboarding,
  getResumeExtraction,
  getRuntimeConfig,
  getSourcingRun,
  markCommSent,
  openDeepIngestThread,
  promoteSourced,
  recordExternalApplication,
  recordSkillChatDecision,
  removeDeepIngestSource,
  replaceEvidenceClaims,
  requestHostedInterest,
  retryDeepIngestSource,
  runAiWebSearchStream,
  runWorkspaceIntent,
  scheduleInterview,
  sendChatMessage,
  sendWorkspaceMessage,
  setAppStatus,
  setAutomationSessionProvider,
  setPublicSyncPreference,
  setSourcedStatus,
  startInstalledAiRuntimeGuidedSetup,
  streamResumeAi,
} from "./api.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("durable resume extraction", () => {
  it("returns the completed operation with a server-saved seed", async () => {
    const operation = { id: "resume-extraction-1", status: "completed" };
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            ok: true,
            data: { profileSeed: { candidate: { full_name: "Jordan Rivera" } } },
            operation,
          }),
          { status: 200, headers: { "content-type": "application/json" } }
        )
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await extractResumeAi({ name: "resume.pdf" });

    expect(result).toEqual({
      profileSeed: { candidate: { full_name: "Jordan Rivera" } },
      operation,
      seedSaved: true,
    });
  });

  it("reloads one exact extraction operation by id or upload digest", async () => {
    const operation = {
      id: "resume-extraction-1",
      uploadDigest: "a".repeat(64),
      status: "running",
    };
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ ok: true, operation }), {
          status: 200,
          headers: { "content-type": "application/json" },
        })
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(getResumeExtraction({ id: operation.id })).resolves.toEqual(operation);
    await expect(getResumeExtraction({ digest: operation.uploadDigest })).resolves.toEqual(
      operation
    );
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/onboard/resume-ai/operation?id=resume-extraction-1",
      expect.any(Object)
    );
    expect(fetchMock).toHaveBeenCalledWith(
      `/api/onboard/resume-ai/operation?digest=${"a".repeat(64)}`,
      expect.any(Object)
    );
  });
});

describe("durable company discovery", () => {
  it("starts, follows, retries, and loads one exact proposal batch", async () => {
    const api = await import("./api.js");
    const operation = {
      id: "app-operation-company-1",
      kind: "company.discovery",
      status: "running",
    };
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ ok: true, operation }), {
          status: 202,
          headers: { "content-type": "application/json" },
        })
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ ok: true, operation }), {
          status: 200,
          headers: { "content-type": "application/json" },
        })
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ ok: true, operation: { ...operation, attempt: 2 } }), {
          status: 202,
          headers: { "content-type": "application/json" },
        })
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ ok: true, data: { batch: { batchId: "cpb_exact" } } }), {
          status: 200,
          headers: { "content-type": "application/json" },
        })
      );
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      api.createCompanyProposals({ manualSeeds: [{ name: "Acme" }] })
    ).resolves.toMatchObject({ operation });
    await expect(api.getAppOperation(operation.id)).resolves.toEqual(operation);
    await expect(api.retryAppOperation(operation.id)).resolves.toMatchObject({
      operation: { attempt: 2 },
    });
    await expect(api.getCompanyProposalBatch("cpb_exact")).resolves.toEqual({
      batchId: "cpb_exact",
    });
    expect(fetchMock.mock.calls.map(([path]) => path)).toEqual([
      "/api/discovery/company-proposals",
      "/api/app-operations/operation?id=app-operation-company-1",
      "/api/app-operations/retry",
      "/api/discovery/company-proposals?id=cpb_exact",
    ]);
  });

  it("loads the exact durable workspace thread used to find a child operation", async () => {
    const api = await import("./api.js");
    const thread = { id: "workspace-main", messages: [{ id: "workspace-message-exact" }] };
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ ok: true, data: thread }), {
          status: 200,
          headers: { "content-type": "application/json" },
        })
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(api.getWorkspaceThread()).resolves.toEqual(thread);
    expect(fetchMock).toHaveBeenCalledWith("/api/workspace/thread", {
      headers: { "content-type": "application/json" },
    });
  });
});

describe("finishOnboarding", () => {
  it("commits onboarding graduation before the app navigates", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { "content-type": "application/json" },
        })
    );
    vi.stubGlobal("fetch", fetchMock);

    await finishOnboarding();

    expect(fetchMock).toHaveBeenCalledWith("/api/onboard/finish", {
      method: "POST",
      body: JSON.stringify({}),
      headers: { "content-type": "application/json" },
    });
  });
});

describe("getSearchSourceStatus", () => {
  it("reads the existing provider-neutral search source preflight", async () => {
    const api = await import("./api.js");
    expect(api.getSearchSourceStatus).toBeTypeOf("function");
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ deterministicSources: { attempted: 2 } }), {
          status: 200,
          headers: { "content-type": "application/json" },
        })
    );
    vi.stubGlobal("fetch", fetchMock);

    await api.getSearchSourceStatus();

    expect(fetchMock).toHaveBeenCalledWith("/api/search/sources", {
      headers: { "content-type": "application/json" },
    });
  });
});

describe("getRuntimeConfig", () => {
  it("reads persisted AI route readiness without probing installed runtimes", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ ai: { available: true, route: "installed" } }), {
          status: 200,
          headers: { "content-type": "application/json" },
        })
    );
    vi.stubGlobal("fetch", fetchMock);

    await getRuntimeConfig();

    expect(fetchMock).toHaveBeenCalledWith("/api/runtime/config", {
      headers: { "content-type": "application/json" },
    });
  });
});

describe("requestHostedInterest", () => {
  it("posts the inline first-run email to the existing hosted-interest route", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { "content-type": "application/json" },
        })
    );
    vi.stubGlobal("fetch", fetchMock);

    await requestHostedInterest("person@example.com");

    expect(fetchMock).toHaveBeenCalledWith("/api/hosted-interest", {
      method: "POST",
      body: JSON.stringify({ email: "person@example.com" }),
      headers: { "content-type": "application/json" },
    });
  });
});

describe("setPublicSyncPreference", () => {
  it("writes the existing onboarding preference endpoint", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            ok: true,
            publicSyncPreference: { enabled: false, source: "user", updatedAt: null },
          }),
          { status: 200, headers: { "content-type": "application/json" } }
        )
    );
    vi.stubGlobal("fetch", fetchMock);

    await setPublicSyncPreference(false);

    expect(fetchMock).toHaveBeenCalledWith("/api/onboard/public-sync-preference", {
      method: "POST",
      body: JSON.stringify({ enabled: false }),
      headers: { "content-type": "application/json" },
    });
  });
});

describe("setAutomationSessionProvider", () => {
  it("writes the dedicated automation settings endpoint", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { "content-type": "application/json" },
        })
    );
    vi.stubGlobal("fetch", fetchMock);

    await setAutomationSessionProvider("playwright");

    expect(fetchMock).toHaveBeenCalledWith("/api/settings/automation/session", {
      method: "POST",
      body: JSON.stringify({ provider: "playwright" }),
      headers: { "content-type": "application/json" },
    });
  });
});

describe("replaceEvidenceClaims", () => {
  it("sends the whole edited evidence bank to the atomic replacement route", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ ok: true, total: 1 }), {
          status: 200,
          headers: { "content-type": "application/json" },
        })
    );
    vi.stubGlobal("fetch", fetchMock);
    const claims = [{ id: "seed-001", claim: "Edited claim", evidence: "Resume" }];

    await replaceEvidenceClaims(claims);

    expect(fetchMock).toHaveBeenCalledWith("/api/onboard/candidate/evidence/replace", {
      method: "POST",
      body: JSON.stringify({ claims }),
      headers: { "content-type": "application/json" },
    });
  });
});

describe("openDeepIngestThread", () => {
  it("uses the durable create-or-open endpoint", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ ok: true, data: { thread: { id: "ingest" } } }), {
          status: 200,
          headers: { "content-type": "application/json" },
        })
    );
    vi.stubGlobal("fetch", fetchMock);

    await openDeepIngestThread();

    expect(fetchMock).toHaveBeenCalledWith("/api/chat-first/deep-ingest/open", {
      method: "POST",
      body: JSON.stringify({}),
      headers: { "content-type": "application/json" },
    });
  });
});

describe("removeDeepIngestSource", () => {
  it("posts the source id to the existing removal route", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ ok: true, data: { id: "source-failed" } }), {
          status: 200,
          headers: { "content-type": "application/json" },
        })
    );
    vi.stubGlobal("fetch", fetchMock);

    await removeDeepIngestSource({ sourceId: "source-failed" });

    expect(fetchMock).toHaveBeenCalledWith("/api/deep-ingest/sources/remove", {
      method: "POST",
      body: JSON.stringify({ sourceId: "source-failed" }),
      headers: { "content-type": "application/json" },
    });
  });
});

describe("retryDeepIngestSource", () => {
  it("posts the source id to the source rescan route", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ ok: true, data: { id: "source-failed" } }), {
          status: 200,
          headers: { "content-type": "application/json" },
        })
    );
    vi.stubGlobal("fetch", fetchMock);

    await retryDeepIngestSource({ sourceId: "source-failed" });

    expect(fetchMock).toHaveBeenCalledWith("/api/deep-ingest/sources/retry", {
      method: "POST",
      body: JSON.stringify({ sourceId: "source-failed" }),
      headers: { "content-type": "application/json" },
    });
  });
});

describe("sendWorkspaceMessage", () => {
  it("carries selected context and a choice reference into the durable agent turn", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ ok: true, data: { messages: [] } }), {
          status: 200,
          headers: { "content-type": "application/json" },
        })
    );
    vi.stubGlobal("fetch", fetchMock);
    const context = { pathname: "/jobs", jobId: "app-temporal" };
    const choice = { promptId: "choice-1", version: 1, optionIds: ["yes"] };

    await sendWorkspaceMessage("Yes", context, choice, {
      requestId: "workspace-message-test-1",
    });

    expect(fetchMock).toHaveBeenCalledWith("/api/workspace/message", {
      method: "POST",
      body: JSON.stringify({
        requestId: "workspace-message-test-1",
        text: "Yes",
        context,
        choice,
      }),
      headers: { "content-type": "application/json" },
    });
  });

  it("gives direct typed intents an exact durable request identity", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ ok: true, operation: { id: "app-operation-intent-1" } }), {
          status: 202,
          headers: { "content-type": "application/json" },
        })
    );
    vi.stubGlobal("fetch", fetchMock);

    await runWorkspaceIntent(
      "settings.explain",
      { type: "workspace", id: "workspace-main" },
      {},
      { requestId: "workspace-intent-test-1" }
    );

    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({
      requestId: "workspace-intent-test-1",
      intent: {
        type: "settings.explain",
        entity: { type: "workspace", id: "workspace-main" },
        input: {},
      },
    });
  });
});

describe("sendChatMessage", () => {
  it("sends the same durable choice reference used by the transcript button", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ accepted: true }), {
          status: 202,
          headers: { "content-type": "application/json" },
        })
    );
    vi.stubGlobal("fetch", fetchMock);
    const choice = { promptId: "choice-1", version: 1, optionIds: ["no"] };

    await sendChatMessage("chat-1", "No", choice, { requestId: "chat-request-choice-0001" });

    expect(fetchMock).toHaveBeenCalledWith("/api/chat/message", {
      method: "POST",
      body: JSON.stringify({
        chatId: "chat-1",
        text: "No",
        choice,
        requestId: "chat-request-choice-0001",
      }),
      headers: { "content-type": "application/json" },
    });
  });
});

describe("recordSkillChatDecision", () => {
  it("records only visible skill-thread decision state on the chat owner route", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { "content-type": "application/json" },
        })
    );
    vi.stubGlobal("fetch", fetchMock);

    await recordSkillChatDecision({
      skill: "research-company",
      decisionId: "discovery:company:acme",
      action: "save",
      resultText: "Saved research for Acme.",
    });

    expect(fetchMock).toHaveBeenCalledWith("/api/chat/decision", {
      method: "POST",
      body: JSON.stringify({
        skill: "research-company",
        decisionId: "discovery:company:acme",
        action: "save",
        resultText: "Saved research for Acme.",
      }),
      headers: { "content-type": "application/json" },
    });
  });
});

describe("completeDiscovery", () => {
  it("uses the canonical durable discovery completion route", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ ok: true, completion: { added: true } }), {
          status: 200,
          headers: { "content-type": "application/json" },
        })
    );
    vi.stubGlobal("fetch", fetchMock);

    await completeDiscovery("research-boards");

    expect(fetchMock).toHaveBeenCalledWith("/api/discovery/complete", {
      method: "POST",
      body: JSON.stringify({ step: "research-boards" }),
      headers: { "content-type": "application/json" },
    });
  });
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
      searchExecutionId: "search-execution-shared",
    });

    expect(fetchMock).toHaveBeenCalledWith("/api/search/ai-web-search/run", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        promptIds: ["p2"],
        searchExecutionId: "search-execution-shared",
      }),
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

  it("requests an exact durable run when an id is supplied", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ ok: true, run: { id: "manual-running" } }), {
          status: 200,
          headers: { "content-type": "application/json" },
        })
    );
    vi.stubGlobal("fetch", fetchMock);

    await getSourcingRun({ purpose: "manual-search", id: "manual-running" });

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/sourcing/runs/latest?purpose=manual-search&id=manual-running",
      expect.any(Object)
    );
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

describe("startInstalledAiRuntimeGuidedSetup", () => {
  it("streams the in-app installer console until setup finishes", async () => {
    const encoder = new TextEncoder();
    const body = new ReadableStream({
      start(controller) {
        controller.enqueue(
          encoder.encode(
            'data: {"type":"started","runtimeId":"claude"}\n\ndata: {"type":"output","message":"Installing Claude Code…"}\n\ndata: {"type":"done","runtimeId":"claude"}\n\n'
          )
        );
        controller.close();
      },
    });
    const fetchMock = vi.fn(async () => new Response(body, { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const events = [];

    const result = await startInstalledAiRuntimeGuidedSetup("claude", {
      onEvent: (event) => events.push(event),
    });

    expect(result).toEqual({ runtimeId: "claude" });
    expect(events).toEqual([
      { type: "started", runtimeId: "claude" },
      { type: "output", message: "Installing Claude Code…" },
      { type: "done", runtimeId: "claude" },
    ]);
    expect(fetchMock).toHaveBeenCalledWith("/api/settings/ai-runtime/guided-setup", {
      method: "POST",
      body: JSON.stringify({ runtimeId: "claude" }),
      headers: { "content-type": "application/json" },
      signal: undefined,
    });
  });

  it("rejects an in-band installer failure after preserving its progress events", async () => {
    const encoder = new TextEncoder();
    const body = new ReadableStream({
      start(controller) {
        controller.enqueue(
          encoder.encode(
            'data: {"type":"output","message":"Downloading…"}\n\ndata: {"type":"error","code":"RUNTIME_GUIDED_SETUP_LAUNCH_FAILED","message":"Try again."}\n\n'
          )
        );
        controller.close();
      },
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(body, { status: 200 }))
    );
    const events = [];

    await expect(
      startInstalledAiRuntimeGuidedSetup("claude", {
        onEvent: (event) => events.push(event),
      })
    ).rejects.toMatchObject({
      code: "RUNTIME_GUIDED_SETUP_LAUNCH_FAILED",
      message: "Try again.",
    });
    expect(events).toEqual([
      { type: "output", message: "Downloading…" },
      {
        type: "error",
        code: "RUNTIME_GUIDED_SETUP_LAUNCH_FAILED",
        message: "Try again.",
      },
    ]);
  });
});

describe("apiFetch capability-cookie retry", () => {
  // Regression guard for issue #86: the dev server mints a fresh per-launch
  // capability credential on every process start (request-security.mjs), and
  // the file watcher restarts the process on a concurrent CLI write — an
  // open tab's cookie goes stale with no user action. The common case must
  // recover silently: refresh the cookie with an ordinary bootstrap GET, then
  // replay the exact request once.
  it("silently refreshes a stale capability cookie and retries the request once", async () => {
    const responses = [
      new Response(JSON.stringify({ error: "local browser capability is missing or invalid" }), {
        status: 401,
        headers: { "content-type": "application/json" },
      }),
      new Response("", { status: 200 }), // the bootstrap GET that mints a fresh cookie
      new Response(JSON.stringify({ ok: true, data: { operationResult: { ok: true } } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    ];
    const fetchMock = vi.fn(async () => responses.shift());
    vi.stubGlobal("fetch", fetchMock);

    await applyOnSite({ id: "app-1" });

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(fetchMock.mock.calls[1][0]).toBe("/app");
    expect(fetchMock.mock.calls[2][0]).toBe("/api/workspace/intent");
  });

  it("never retries a 401 that is not the stale-capability refusal", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ error: "unauthorized" }), {
          status: 401,
          headers: { "content-type": "application/json" },
        })
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(applyOnSite({ id: "app-1" })).rejects.toMatchObject({ status: 401 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("gives up after one retry so a genuinely broken credential still surfaces as an error", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ error: "local browser capability is missing or invalid" }), {
          status: 401,
          headers: { "content-type": "application/json" },
        })
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(applyOnSite({ id: "app-1" })).rejects.toMatchObject({ status: 401 });
    // original request + one refresh GET + exactly one retry — never a
    // second refresh/retry cycle.
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
});

describe("chat-first workflow actions", () => {
  it("gives packet exports a durable request identity", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ ok: true, data: { applicationId: "app-1" } }), {
          status: 200,
          headers: { "content-type": "application/json" },
        })
    );
    vi.stubGlobal("fetch", fetchMock);

    await exportPacketDocuments({ applicationId: "app-1", formats: ["pdf"] });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, options] = fetchMock.mock.calls[0];
    expect(JSON.parse(options.body)).toEqual({
      applicationId: "app-1",
      formats: ["pdf"],
      requestId: expect.stringMatching(/^workspace-/),
    });
  });

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

    const parsedBodies = fetchMock.mock.calls.map(([, options]) => JSON.parse(options.body));
    expect(parsedBodies.map((body) => body.requestId)).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/^workspace-/),
        expect.stringMatching(/^workspace-/),
        expect.stringMatching(/^workspace-/),
        expect.stringMatching(/^workspace-/),
        expect.stringMatching(/^workspace-/),
        expect.stringMatching(/^workspace-/),
        expect.stringMatching(/^workspace-/),
      ])
    );
    expect(new Set(parsedBodies.map((body) => body.requestId)).size).toBe(7);
    const bodies = fetchMock.mock.calls.map(([path, options]) => {
      const { requestId: _requestId, ...body } = JSON.parse(options.body);
      return [path, body];
    });
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
            type: "job.prepare-submit",
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
