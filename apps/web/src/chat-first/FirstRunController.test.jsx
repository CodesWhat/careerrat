import { beforeEach, describe, expect, it, vi } from "vitest";

const hooks = vi.hoisted(() => ({
  callbackDeps: [],
  callbacks: [],
  cursor: 0,
  effectDeps: [],
  pendingEffects: [],
  refs: [],
  states: [],
  resetRender() {
    this.cursor = 0;
    this.pendingEffects = [];
  },
  clear() {
    this.callbackDeps = [];
    this.callbacks = [];
    this.cursor = 0;
    this.effectDeps = [];
    this.pendingEffects = [];
    this.refs = [];
    this.states = [];
  },
}));

const sse = vi.hoisted(() => ({ calls: [] }));
const navigate = vi.hoisted(() => vi.fn());

function dependenciesChanged(previous, next) {
  return (
    !previous ||
    !next ||
    previous.length !== next.length ||
    next.some((value, index) => !Object.is(value, previous[index]))
  );
}

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    useCallback(callback, dependencies) {
      const index = hooks.cursor++;
      if (dependenciesChanged(hooks.callbackDeps[index], dependencies)) {
        hooks.callbacks[index] = callback;
        hooks.callbackDeps[index] = dependencies;
      }
      return hooks.callbacks[index];
    },
    useEffect(effect, dependencies) {
      const index = hooks.cursor++;
      if (dependenciesChanged(hooks.effectDeps[index], dependencies)) {
        hooks.effectDeps[index] = dependencies;
        hooks.pendingEffects.push(effect);
      }
    },
    useRef(initialValue) {
      const index = hooks.cursor++;
      if (!hooks.refs[index]) hooks.refs[index] = { current: initialValue };
      return hooks.refs[index];
    },
    useState(initialValue) {
      const index = hooks.cursor++;
      if (!(index in hooks.states)) {
        hooks.states[index] = typeof initialValue === "function" ? initialValue() : initialValue;
      }
      const setValue = (nextValue) => {
        hooks.states[index] =
          typeof nextValue === "function" ? nextValue(hooks.states[index]) : nextValue;
      };
      return [hooks.states[index], setValue];
    },
  };
});

vi.mock("react-router-dom", () => ({ useNavigate: () => navigate }));

vi.mock("../lib/sse.js", () => ({
  useEventSource: (url, options) => sse.calls.push({ url, options }),
}));

vi.mock("./FirstRunExperience.jsx", () => ({
  FirstRunExperience: () => null,
  FirstRunShell: ({ children }) => children,
}));

const ONBOARD_STATE = {
  data: {
    modes: { agent_name: "Paul" },
    setup: { readiness: { search_ready: false } },
    sourcing: {},
  },
  setupProgress: { complete: false, completedCount: 0, total: 1, items: [] },
};

function createApi(draft = { transcript: [] }) {
  return {
    createCompanyProposals: vi.fn().mockResolvedValue({ ok: true }),
    extractResumeAi: vi.fn(),
    extractResumeDocx: vi.fn(),
    findChatBySkill: vi.fn().mockResolvedValue({ chatId: "chat-1", state: "idle" }),
    getInstalledAiRuntimes: vi.fn().mockResolvedValue({
      selectedId: "claude",
      runtimes: [{ id: "claude", available: true, ready: true, selectable: true }],
    }),
    getOnboardingDraft: vi.fn().mockResolvedValue({ draft }),
    getOnboardState: vi.fn().mockResolvedValue(ONBOARD_STATE),
    initOnboard: vi.fn().mockResolvedValue({ ok: true }),
    parseResumeText: vi.fn().mockResolvedValue({ profileSeed: {}, evidenceSeed: { claims: [] } }),
    probeInstalledAiRuntime: vi.fn().mockResolvedValue({ ok: true }),
    removeEvidenceClaim: vi.fn().mockResolvedValue({ ok: true }),
    replaceEvidenceClaims: vi.fn().mockResolvedValue({ ok: true }),
    requestHostedInterest: vi.fn().mockResolvedValue({ ok: true }),
    saveCandidateFile: vi.fn().mockResolvedValue({ ok: true }),
    saveEvidenceSeed: vi.fn().mockResolvedValue({ ok: true }),
    saveOnboardingDraft: vi.fn().mockResolvedValue({ ok: true }),
    selectInstalledAiRuntime: vi.fn().mockResolvedValue({ ok: true }),
    sendChatMessage: vi.fn().mockResolvedValue({ accepted: true }),
    startChat: vi.fn(),
    startFirstSearchRun: vi.fn(),
  };
}

async function flushEffects() {
  const effects = hooks.pendingEffects.splice(0);
  for (const effect of effects) effect();
  for (let turn = 0; turn < 8; turn += 1) await Promise.resolve();
}

async function bootController(module, api, { startInterview = true } = {}) {
  hooks.resetRender();
  module.FirstRunController({ api, inWorkspace: false });
  await flushEffects();

  hooks.resetRender();
  module.FirstRunController({ api, inWorkspace: false });
  await flushEffects();

  hooks.resetRender();
  const view = module.FirstRunController({ api, inWorkspace: false });
  if (!startInterview || view.props.stage !== "engine") return view;
  const selectedEngine = view.props.engines.find((engine) => engine.selected);
  if (!selectedEngine) return view;

  await view.props.onStartInterview(selectedEngine.id);
  hooks.resetRender();
  module.FirstRunController({ api, inWorkspace: false });
  await flushEffects();
  hooks.resetRender();
  return module.FirstRunController({ api, inWorkspace: false });
}

function rerender(module, api) {
  hooks.resetRender();
  return module.FirstRunController({ api, inWorkspace: false });
}

function assistantPayload(text) {
  return JSON.stringify({ message: { content: [{ type: "text", text }] } });
}

function twoBlockReply() {
  return [
    "I found two facts.",
    "```careerrat:confirm",
    '{"kind":"candidate_patch","summary":"Domain","payload":{"doc":"profile","patch":{"candidate":{"domain":"Infrastructure"}}}}',
    "```",
    "```careerrat:confirm",
    '{"kind":"candidate_patch","summary":"Targets","payload":{"doc":"targeting","patch":{"role_buckets":[{"name":"Primary","priority":"primary","titles":["Staff Engineer"]}]}}}',
    "```",
  ].join("\n");
}

beforeEach(() => {
  hooks.clear();
  sse.calls = [];
  vi.clearAllMocks();
});

describe("FirstRunController chat event reconciliation", () => {
  it("does not skip the picker when a fresh install auto-selected its only safe runtime", async () => {
    const module = await import("./FirstRunController.jsx");
    const api = createApi({ transcript: [] });
    const view = await bootController(module, api, { startInterview: false });

    expect(view.props.stage).toBe("engine");
    expect(view.props.engines[0]).toMatchObject({
      id: "claude",
      selected: true,
    });
  });

  it("chooses a safe runtime before the explicit Start the interview action persists it", async () => {
    const module = await import("./FirstRunController.jsx");
    const api = createApi();
    api.getInstalledAiRuntimes
      .mockResolvedValueOnce({
        selectedId: null,
        runtimes: [
          {
            id: "claude",
            name: "Claude Code",
            available: true,
            ready: true,
            selectable: true,
          },
        ],
      })
      .mockResolvedValue({
        selectedId: "claude",
        runtimes: [
          {
            id: "claude",
            name: "Claude Code",
            available: true,
            ready: true,
            selectable: true,
          },
        ],
      });
    const view = await bootController(module, api, { startInterview: false });

    expect(view.props.stage).toBe("engine");
    expect(view.props.engines[0].selected).toBe(false);
    view.props.onChooseEngine("claude");
    expect(api.selectInstalledAiRuntime).not.toHaveBeenCalled();

    const selectedView = rerender(module, api);
    expect(selectedView.props.engines[0].selected).toBe(true);
    await selectedView.props.onStartInterview("claude");
    expect(api.selectInstalledAiRuntime).toHaveBeenCalledWith({
      runtimeId: "claude",
    });

    const chatView = rerender(module, api);
    expect(chatView.props.stage).toBe("chat");
  });

  it("submits hosted access interest and keeps a failed email ready to retry", async () => {
    const module = await import("./FirstRunController.jsx");
    const api = createApi({ transcript: [] });
    api.requestHostedInterest
      .mockRejectedValueOnce({
        body: { error: "Interest service is unavailable." },
      })
      .mockResolvedValueOnce({ ok: true });
    let view = await bootController(module, api, { startInterview: false });

    view.props.onHostedInterestStart();
    view = rerender(module, api);
    expect(view.props.hostedInterest).toMatchObject({
      status: "editing",
      email: "",
    });

    view.props.onHostedInterestChange("person@example.com");
    view = rerender(module, api);
    await view.props.onHostedInterestSubmit();
    view = rerender(module, api);
    expect(view.props.hostedInterest).toEqual({
      status: "error",
      email: "person@example.com",
      error: "Interest service is unavailable.",
    });

    await view.props.onHostedInterestSubmit();
    view = rerender(module, api);
    expect(api.requestHostedInterest).toHaveBeenNthCalledWith(2, "person@example.com");
    expect(view.props.hostedInterest).toEqual({
      status: "requested",
      email: "",
      error: null,
    });
  });

  it("refreshes an empty runtime inventory without probing a made-up runtime", async () => {
    const module = await import("./FirstRunController.jsx");
    const api = createApi({ transcript: [] });
    api.getInstalledAiRuntimes.mockResolvedValue({
      selectedId: null,
      providerFallback: false,
      runtimes: [],
    });
    let view = await bootController(module, api, { startInterview: false });
    const callsBeforeRetry = api.getInstalledAiRuntimes.mock.calls.length;

    await view.props.onRefreshEngines();
    view = rerender(module, api);

    expect(api.getInstalledAiRuntimes).toHaveBeenCalledTimes(callsBeforeRetry + 1);
    expect(api.probeInstalledAiRuntime).not.toHaveBeenCalled();
    expect(view.props.engines).toEqual([]);
  });

  it("reconnects from the last observed event after a posted answer", async () => {
    const module = await import("./FirstRunController.jsx");
    const api = createApi();
    let view = await bootController(module, api);
    const subscription = sse.calls.at(-1);

    subscription.options.onEvent("assistant", assistantPayload("First question"), {
      lastEventId: "2",
    });
    subscription.options.onEvent("chat_state", JSON.stringify({ state: "idle" }), {
      lastEventId: "4",
    });
    await Promise.resolve();
    view = rerender(module, api);

    expect(view.props.messages[0].id).toBe("chat-chat-1-event-2");
    await view.props.onSubmitAnswer("My answer");
    view = rerender(module, api);

    const reconnected = sse.calls.at(-1);
    expect(reconnected.url).toContain("after=4");
    expect(reconnected.url).not.toBe(subscription.url);
    expect(view.props.submitting).toBe(true);

    reconnected.options.onEvent("assistant", assistantPayload("Second question"), {
      lastEventId: "6",
    });
    reconnected.options.onEvent("chat_state", JSON.stringify({ state: "idle" }), {
      lastEventId: "8",
    });
    view = rerender(module, api);

    expect(view.props.submitting).toBe(false);
    expect(
      view.props.messages
        .filter((message) => message.role === "assistant")
        .map((message) => message.id)
    ).toEqual(["chat-chat-1-event-2", "chat-chat-1-event-6"]);
  });

  it("deduplicates full SSE replay against the persisted transcript", async () => {
    const module = await import("./FirstRunController.jsx");
    const api = createApi({
      chatCursor: { chatId: "chat-1", eventId: 4 },
      transcript: [
        {
          id: "chat-chat-1-event-2",
          chatId: "chat-1",
          eventId: 2,
          role: "assistant",
          text: "First question",
          blocks: [],
        },
      ],
    });
    let view = await bootController(module, api);
    const subscription = sse.calls.at(-1);

    expect(subscription.url).toContain("after=4");
    subscription.options.onEvent("assistant", assistantPayload("First question"), {
      lastEventId: "2",
    });
    subscription.options.onEvent("assistant", assistantPayload("Second question"), {
      lastEventId: "6",
    });
    view = rerender(module, api);

    expect(view.props.messages.map((message) => message.id)).toEqual([
      "chat-chat-1-event-2",
      "chat-chat-1-event-6",
    ]);
  });

  it("saves a group of extracted profile facts without rendering per-fact controls", async () => {
    const module = await import("./FirstRunController.jsx");
    const api = createApi();
    let view = await bootController(module, api);
    const subscription = sse.calls.at(-1);
    subscription.options.onEvent("assistant", assistantPayload(twoBlockReply()), {
      lastEventId: "2",
    });
    view = rerender(module, api);

    expect(view.props.messages[0].options).toEqual([]);
    await flushEffects();
    view = rerender(module, api);

    expect(api.saveCandidateFile).toHaveBeenCalledTimes(2);
    expect(view.props.messages[0].blocks).toEqual([
      expect.objectContaining({ status: "resolved", resultSummary: "Saved" }),
      expect.objectContaining({ status: "resolved", resultSummary: "Saved" }),
    ]);
    expect(view.props.messages[0].options).toEqual([]);
    expect(api.sendChatMessage).toHaveBeenCalledTimes(1);
    expect(api.sendChatMessage.mock.calls[0][1]).toContain("profile sections");
  });

  it("keeps successful extracted writes resolved when a later generated field is rejected", async () => {
    const module = await import("./FirstRunController.jsx");
    const api = createApi();
    api.saveCandidateFile.mockResolvedValueOnce({ ok: true }).mockRejectedValueOnce({
      status: 400,
      message: "request failed with status 400",
      body: {
        error: "form-defaults does not validate",
        errors: [
          {
            path: "auto_submit",
            message: 'unexpected property "auto_submit"',
          },
        ],
      },
    });
    let view = await bootController(module, api);
    const stateReadsBeforeReply = api.getOnboardState.mock.calls.length;
    const reply = [
      "I found two facts.",
      "```careerrat:confirm",
      '{"kind":"candidate_patch","summary":"Domain","payload":{"doc":"profile","patch":{"candidate":{"domain":"Infrastructure"}}}}',
      "```",
      "```careerrat:confirm",
      '{"kind":"candidate_patch","summary":"Submission","payload":{"doc":"form-defaults","patch":{"auto_submit":false}}}',
      "```",
    ].join("\n");
    sse.calls.at(-1).options.onEvent("assistant", assistantPayload(reply), { lastEventId: "2" });

    rerender(module, api);
    await flushEffects();
    view = rerender(module, api);

    expect(api.saveCandidateFile).toHaveBeenCalledTimes(2);
    expect(view.props.messages[0].blocks).toEqual([
      expect.objectContaining({ status: "resolved", resultSummary: "Saved" }),
      expect.objectContaining({ status: "error" }),
    ]);
    expect(view.props.error).toMatch(
      /auto_submit.*not a supported setting.*other valid details were saved/i
    );
    expect(api.getOnboardState.mock.calls.length).toBeGreaterThan(stateReadsBeforeReply);
  });

  it("routes the engine section editor to settings", async () => {
    const module = await import("./FirstRunController.jsx");
    const api = createApi();
    const view = await bootController(module, api);

    view.props.onEditKnowledgeSection({ id: "engine", label: "ENGINE" });
    expect(navigate).toHaveBeenCalledWith("/settings", {
      state: { activeTab: "settings", openEnginePicker: true },
    });
  });

  it("writes whole-section modal edits through canonical candidate APIs", async () => {
    const module = await import("./FirstRunController.jsx");
    const api = createApi();
    const view = await bootController(module, api);

    await view.props.onSaveKnowledgeSection(
      { id: "roles" },
      { titles: "Staff Engineer\nPrincipal JavaScript Engineer" }
    );
    expect(api.saveCandidateFile).toHaveBeenCalledWith("targeting", {
      role_buckets: [
        {
          name: "Primary targets",
          priority: "primary",
          titles: ["Staff Engineer", "Principal JavaScript Engineer"],
        },
      ],
    });

    await view.props.onSaveKnowledgeSection(
      { id: "quickFacts" },
      {
        name: "Jordan Rivera",
        email: "jordan@example.test",
        phone: "+1 212 555 0199",
        home: "New York, NY",
        minimumBase: "$190,000",
        remoteScope: "worldwide",
        hybrid: true,
        onsite: false,
      }
    );
    expect(api.saveCandidateFile).toHaveBeenCalledWith("profile", {
      candidate: {
        full_name: "Jordan Rivera",
        email: "jordan@example.test",
        phone: "+1 212 555 0199",
        location: "New York, NY",
      },
      location: {
        home: "New York, NY",
        remote: true,
        remote_scope: "worldwide",
        hybrid: true,
        onsite: false,
        mode_preferences_confirmed: true,
      },
      compensation: { minimum_base: 190000 },
    });

    await view.props.onSaveKnowledgeSection(
      {
        id: "evidence",
        editor: {
          existingClaimIds: ["seed-001"],
          existingClaims: [
            {
              id: "seed-001",
              claim: "Led a team",
              evidence: "Candidate resume",
            },
          ],
        },
      },
      { claims: "Led a team :: Candidate resume" }
    );
    expect(api.replaceEvidenceClaims).toHaveBeenCalledWith([
      { id: "seed-001", claim: "Led a team", evidence: "Candidate resume" },
    ]);
    expect(api.removeEvidenceClaim).not.toHaveBeenCalled();
  });

  it("round-trips named target lanes and evidence claim ids through whole-section edits", async () => {
    const module = await import("./FirstRunController.jsx");
    const api = createApi();
    const view = await bootController(module, api);
    const roleBuckets = [
      {
        name: "Platform",
        priority: "primary",
        titles: ["Staff Engineer"],
        fit_signals: ["distributed systems"],
      },
      {
        name: "Applied AI",
        priority: "stretch",
        titles: ["AI Platform Lead"],
      },
      { name: "Operator", priority: "oe", titles: ["Fractional CTO"] },
    ];

    await view.props.onSaveKnowledgeSection(
      { id: "roles", editor: { roleBuckets } },
      {
        titles: "Principal Platform Engineer",
        "titles:1": "Applied AI Engineering Lead",
        "titles:2": "Fractional CTO",
      }
    );
    expect(api.saveCandidateFile).toHaveBeenCalledWith("targeting", {
      role_buckets: [
        { ...roleBuckets[0], titles: ["Principal Platform Engineer"] },
        { ...roleBuckets[1], titles: ["Applied AI Engineering Lead"] },
        roleBuckets[2],
      ],
    });

    await view.props.onSaveKnowledgeSection(
      {
        id: "evidence",
        editor: {
          existingClaims: [
            {
              id: "seed-001",
              claim: "Built the first version",
              evidence: "Resume",
            },
            {
              id: "seed-002",
              claim: "Led the rollout",
              evidence: "Project notes",
            },
          ],
        },
      },
      {
        claims: "Built the production version :: Resume v2\nLed the rollout :: Project notes",
      }
    );
    expect(api.replaceEvidenceClaims).toHaveBeenCalledWith([
      {
        id: "seed-001",
        claim: "Built the production version",
        evidence: "Resume v2",
      },
      { id: "seed-002", claim: "Led the rollout", evidence: "Project notes" },
    ]);
    expect(api.removeEvidenceClaim).not.toHaveBeenCalled();
    expect(api.saveEvidenceSeed).not.toHaveBeenCalled();
  });

  it("leaves the existing evidence bank untouched when atomic replacement fails", async () => {
    const module = await import("./FirstRunController.jsx");
    const api = createApi();
    api.replaceEvidenceClaims.mockRejectedValueOnce(new Error("replacement rolled back"));
    const view = await bootController(module, api);

    await expect(
      view.props.onSaveKnowledgeSection(
        {
          id: "evidence",
          editor: {
            existingClaims: [
              {
                id: "seed-001",
                claim: "Built the first version",
                evidence: "Resume",
              },
            ],
          },
        },
        { claims: "Built the production version :: Resume v2" }
      )
    ).rejects.toThrow("replacement rolled back");
    expect(api.removeEvidenceClaim).not.toHaveBeenCalled();
    expect(api.saveEvidenceSeed).not.toHaveBeenCalled();
  });

  it("preserves evidence ids only for exact or unambiguous edits", async () => {
    const module = await import("./FirstRunController.jsx");
    const api = createApi();
    const existingClaims = [
      { id: "id-a", claim: "Claim A", evidence: "Resume A" },
      { id: "id-b", claim: "Claim B", evidence: "Resume B" },
    ];
    const item = { id: "evidence", editor: { existingClaims } };
    const view = await bootController(module, api);

    await view.props.onSaveKnowledgeSection(item, {
      claims: "New claim :: Notes\nClaim A :: Resume A\nClaim B :: Resume B",
    });
    expect(api.replaceEvidenceClaims).toHaveBeenLastCalledWith([
      { claim: "New claim", evidence: "Notes" },
      { id: "id-a", claim: "Claim A", evidence: "Resume A" },
      { id: "id-b", claim: "Claim B", evidence: "Resume B" },
    ]);

    await view.props.onSaveKnowledgeSection(item, {
      claims: "Claim B :: Resume B",
    });
    expect(api.replaceEvidenceClaims).toHaveBeenLastCalledWith([
      { id: "id-b", claim: "Claim B", evidence: "Resume B" },
    ]);

    await view.props.onSaveKnowledgeSection(item, {
      claims: "Claim B :: Resume B\nClaim A :: Resume A",
    });
    expect(api.replaceEvidenceClaims).toHaveBeenLastCalledWith([
      { id: "id-b", claim: "Claim B", evidence: "Resume B" },
      { id: "id-a", claim: "Claim A", evidence: "Resume A" },
    ]);

    await view.props.onSaveKnowledgeSection(item, {
      claims: "Claim B :: Resume B\nClaim A, edited :: Resume A v2",
    });
    expect(api.replaceEvidenceClaims).toHaveBeenLastCalledWith([
      { id: "id-b", claim: "Claim B", evidence: "Resume B" },
      { id: "id-a", claim: "Claim A, edited", evidence: "Resume A v2" },
    ]);

    await view.props.onSaveKnowledgeSection(item, {
      claims: "New claim :: Notes\nClaim A, edited :: Resume A v2\nClaim B :: Resume B",
    });
    expect(api.replaceEvidenceClaims).toHaveBeenLastCalledWith([
      { claim: "New claim", evidence: "Notes" },
      { claim: "Claim A, edited", evidence: "Resume A v2" },
      { id: "id-b", claim: "Claim B", evidence: "Resume B" },
    ]);

    await view.props.onSaveKnowledgeSection(
      {
        id: "evidence",
        editor: {
          existingClaims: [
            ...existingClaims,
            { id: "id-c", claim: "Claim C", evidence: "Resume C" },
          ],
        },
      },
      {
        claims: "New claim :: Notes\nClaim A, edited :: Resume A v2\nClaim C :: Resume C",
      }
    );
    expect(api.replaceEvidenceClaims).toHaveBeenLastCalledWith([
      { claim: "New claim", evidence: "Notes" },
      { claim: "Claim A, edited", evidence: "Resume A v2" },
      { id: "id-c", claim: "Claim C", evidence: "Resume C" },
    ]);

    await view.props.onSaveKnowledgeSection(item, {
      claims: "  CLAIM A   :: Resume A\nClaim B :: Resume B",
    });
    expect(api.replaceEvidenceClaims).toHaveBeenLastCalledWith([
      { id: "id-a", claim: "CLAIM A", evidence: "Resume A" },
      { id: "id-b", claim: "Claim B", evidence: "Resume B" },
    ]);
  });

  it("drops a text resume into canonical setup and continues from the extracted facts", async () => {
    const module = await import("./FirstRunController.jsx");
    const api = createApi();
    api.parseResumeText.mockResolvedValue({
      profileSeed: {
        candidate: { full_name: "Jordan Rivera", location: "New York, NY" },
      },
      targetingSeed: {
        role_buckets: [
          {
            name: "Primary",
            priority: "primary",
            titles: ["Staff Software Engineer"],
          },
        ],
      },
      evidenceSeed: {
        claims: [{ claim: "Led a platform team", evidence: "Candidate resume" }],
      },
    });
    const view = await bootController(module, api);
    const file = {
      name: "jordan-resume.md",
      text: vi.fn().mockResolvedValue("# Jordan Rivera\nStaff Software Engineer"),
    };

    await view.props.onResumeFile(file);

    expect(api.parseResumeText).toHaveBeenCalledWith("# Jordan Rivera\nStaff Software Engineer", {
      save: true,
    });
    expect(api.saveCandidateFile).toHaveBeenCalledWith("profile", {
      candidate: { full_name: "Jordan Rivera", location: "New York, NY" },
      location: { home: "New York, NY" },
    });
    expect(api.saveEvidenceSeed).toHaveBeenCalledWith([
      { claim: "Led a platform team", evidence: "Candidate resume" },
    ]);
    expect(api.sendChatMessage.mock.calls.at(-1)[1]).toContain(
      'The resume "jordan-resume.md" was uploaded and parsed'
    );
  });

  it("does not keep a saved profile section blocked on the agent acknowledgement", async () => {
    const module = await import("./FirstRunController.jsx");
    const api = createApi();
    api.sendChatMessage.mockReturnValue(new Promise(() => {}));
    const view = await bootController(module, api);

    const result = await Promise.race([
      view.props
        .onSaveKnowledgeSection({ id: "guardrails", label: "Guardrails" }, { signals: "Crypto" })
        .then(() => "saved"),
      new Promise((resolve) => setTimeout(() => resolve("blocked"), 10)),
    ]);

    expect(result).toBe("saved");
    expect(api.saveCandidateFile).toHaveBeenCalledWith("targeting", {
      cut_signals: ["Crypto"],
    });
    expect(api.sendChatMessage).toHaveBeenCalledOnce();
  });
});
