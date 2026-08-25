import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { ApiError } from "../lib/api.js";

vi.mock("../jobs/ArtifactViewerModal.jsx", () => ({
  ArtifactViewerModal: ({ artifact, title }) => (artifact ? <div>{`viewer:${title}`}</div> : null),
}));

const VIEW = {
  agentName: "Paul",
  mainThread: {
    messages: [
      { id: "m1", role: "assistant", kind: "text", text: "I found six strong roles." },
      { id: "m2", role: "user", kind: "text", text: "Start with Tyrell." },
    ],
  },
  threads: [
    {
      id: "job:app-1",
      applicationId: "app-1",
      title: "E Corp",
      company: "E Corp",
      role: "Staff SWE",
      stage: "offer",
      fitScore: 91,
      subtitle: "recruiter replied 2h ago",
      needsAction: true,
      communications: [
        {
          id: "comm-1",
          participants: [{ name: "Darlene Alderson", role: "Recruiting" }],
          messages: [{ direction: "inbound", summary: "Can you talk Friday morning?" }],
          draft: { body: "Friday morning works. I can do 10:00 ET." },
        },
      ],
      messages: [{ id: "j1", role: "assistant", kind: "text", text: "I drafted the reply." }],
    },
  ],
  archivedThreads: [],
  needsYou: [
    {
      id: "mission-1:submit-1",
      kind: "submit",
      title: "E Corp application ready",
      detail: "The form is filled. You press submit.",
      primaryLabel: "Review & submit",
      tone: "attention",
    },
  ],
  missions: [
    {
      id: "mission-1",
      title: "Apply to 1 role",
      status: "paused",
      steps: [{ id: "submit-1", label: "Submit E Corp", status: "blocked" }],
    },
  ],
  activeMission: null,
  activity: [{ id: "act-1", relTime: "8:14", title: "Sweep complete", type: "success" }],
  counts: { search: 1, pipeline: 1, files: 1, people: 1, touchDue: 1, archived: 0 },
  browser: {
    search: [{ id: "s1", source: "sourced", company: "Tyrell", role: "Staff", fit: 88 }],
    pipeline: { applicationCount: 1, rows: [], leaks: [], jobs: [] },
    files: [],
    people: [],
    schedule: [{ day: "THURSDAY", items: [{ id: "event-1", time: "2:00 PM", title: "Panel" }] }],
  },
  jobDetails: {},
  mockSessions: [],
  skillChats: [],
};

const BASE_UI = {
  activeThread: "today",
  activeApplicationId: null,
  browse: false,
  pipeView: "funnel",
  selection: [],
  composerChips: [],
  gateId: null,
  activityOpen: false,
  archiveOpen: false,
};

async function renderView(props = {}) {
  const { ChatFirstAppView } = await import("./ChatFirstApp.jsx");
  return renderToStaticMarkup(
    <ChatFirstAppView
      view={VIEW}
      ui={BASE_UI}
      composerValue=""
      sourceSweep={{ status: "idle", summary: "today · 6 qualified" }}
      actions={{}}
      {...props}
    />
  );
}

describe("ChatFirstAppView", () => {
  it("routes new-shell navigation intents without sending retired href actions to the API", async () => {
    const { dispatchChatFirstMessageIntent } = await import("./ChatFirstApp.jsx");
    const openJob = vi.fn();
    const openBrowser = vi.fn();
    const openSettings = vi.fn();
    const openArtifact = vi.fn();
    const openSourced = vi.fn();
    const runWorkspaceIntent = vi.fn();
    const callbacks = {
      openJob,
      openBrowser,
      openSettings,
      openArtifact,
      openSourced,
      runWorkspaceIntent,
    };

    dispatchChatFirstMessageIntent(
      {
        type: "ui.navigate",
        entity: { type: "application", id: "app-1" },
        input: { surface: "job" },
      },
      callbacks
    );
    for (const surface of ["search", "files", "schedule"]) {
      dispatchChatFirstMessageIntent(
        {
          type: "ui.navigate",
          entity: { type: "workspace", id: "workspace-main" },
          input: { surface },
        },
        callbacks
      );
    }
    dispatchChatFirstMessageIntent(
      {
        type: "ui.navigate",
        entity: { type: "application", id: "app-1" },
        input: { surface: "files", artifactKind: "interview-dossier" },
      },
      callbacks
    );
    dispatchChatFirstMessageIntent(
      {
        type: "ui.navigate",
        entity: { type: "sourced", id: "sourced-1" },
        input: { surface: "search" },
      },
      callbacks
    );
    dispatchChatFirstMessageIntent(
      {
        type: "ui.navigate",
        entity: { type: "workspace", id: "workspace-main" },
        input: { surface: "settings", section: "sources" },
      },
      callbacks
    );
    const runtimeIntent = {
      type: "company.health",
      entity: { type: "application", id: "app-1" },
      input: {},
    };
    dispatchChatFirstMessageIntent(runtimeIntent, callbacks);

    expect(openJob).toHaveBeenCalledWith("app-1");
    expect(openBrowser.mock.calls.map(([surface]) => surface)).toEqual([
      "search",
      "files",
      "schedule",
    ]);
    expect(openSettings).toHaveBeenCalledWith("sources");
    expect(openArtifact).toHaveBeenCalledWith(
      { type: "application", id: "app-1" },
      "interview-dossier"
    );
    expect(openSourced).toHaveBeenCalledWith("sourced-1");
    expect(runWorkspaceIntent).toHaveBeenCalledWith(runtimeIntent);
  });

  it("loads the exact dossier artifact behind the Open dossier navigation action", async () => {
    const { loadChatFirstNavigationArtifact } = await import("./ChatFirstApp.jsx");
    const dossier = { markdown: "# Acme interview dossier" };
    const api = {
      getInterviewDossier: vi.fn().mockResolvedValue({ data: { dossier } }),
    };

    const result = await loadChatFirstNavigationArtifact({
      api,
      entity: { type: "application", id: "app-acme" },
      artifactKind: "interview-dossier",
      files: [],
    });

    expect(api.getInterviewDossier).toHaveBeenCalledWith("app-acme");
    expect(result).toEqual({ title: "Interview dossier", artifact: dossier });
  });

  it("reveals an exact sourced CTA target through every conflicting Search filter", async () => {
    const { dispatchChatFirstMessageIntent, revealSourcedTarget } = await import(
      "./ChatFirstApp.jsx"
    );
    const { filterSearchJobs } = await import("./browser-model.js");
    const initialFilters = {
      fit80: true,
      comp: true,
      remote: true,
      stage: "interview",
      source: "referral",
      posted: "1",
      files: "Resumes",
      people: "touch-due",
    };
    let filters = initialFilters;
    let query = "a different company";
    const actions = [];

    revealSourcedTarget("sourced-low-fit", {
      dispatch: (action) => actions.push(action),
      setQuery: (value) => {
        query = value;
      },
      setBrowserFilters: (update) => {
        filters = update(filters);
      },
    });

    expect(filters).toEqual({
      fit80: false,
      comp: false,
      remote: false,
      stage: "all",
      source: "all",
      posted: "all",
      files: "Resumes",
      people: "touch-due",
    });
    expect(query).toBe("");
    expect(actions).toEqual([
      { type: "selection.replace", ids: ["sourced-low-fit"] },
      { type: "browser.open", tab: "search" },
    ]);
    expect(
      filterSearchJobs(
        [
          {
            id: "sourced-low-fit",
            company: "Target Co",
            role: "Backend Engineer",
            fit: 62,
            compStatus: "comp pending",
            workMode: "onsite",
            stage: "new",
            sourceLabel: "Direct",
            postedAt: "2025-01-01T00:00:00.000Z",
          },
        ],
        { ...filters, query }
      )
    ).toHaveLength(1);

    filters = initialFilters;
    dispatchChatFirstMessageIntent(
      {
        type: "ui.navigate",
        entity: { type: "workspace", id: "workspace-main" },
        input: { surface: "search" },
      },
      { openBrowser: vi.fn() }
    );
    expect(filters).toBe(initialFilters);
  });

  it("renders a rejected workspace intent error envelope as natural text", async () => {
    const { runChatFirstOperation } = await import("./ChatFirstApp.jsx");
    const failure = new ApiError(404, {
      code: "COMPANY_NOT_FOUND",
      error: "application table lookup failed for app-missing",
    });
    const api = {
      runWorkspaceIntent: vi.fn().mockRejectedValue(failure),
    };
    const errors = [];
    const result = await runChatFirstOperation(
      () =>
        api.runWorkspaceIntent("company.health", { type: "application", id: "app-missing" }, {}),
      {
        refetch: vi.fn(),
        setBusy: vi.fn(),
        setError: (value) => errors.push(value),
        setEngineDown: vi.fn(),
      }
    );

    expect(result).toBeNull();
    expect(errors).toEqual([
      null,
      "CareerRat couldn't find that company among your saved jobs. Name it exactly as it appears there.",
    ]);
    const html = await renderView({ error: errors.at(-1) });
    expect(html).toContain('role="alert"');
    expect(html).toContain(
      "CareerRat couldn&#x27;t find that company among your saved jobs. Name it exactly as it appears there."
    );
    expect(html).not.toContain("application table lookup failed");
    expect(html).not.toContain("[object Object]");
  });

  it("keeps application answers in the review column instead of the packet column", async () => {
    const module = await import("./ChatFirstApp.jsx");
    expect(module.packetRows).toBeTypeOf("function");
    expect(
      module.packetRows({
        artifacts: {
          resume: { html: "resume" },
          coverLetter: { html: "cover" },
          answers: { html: "answers" },
        },
      })
    ).toEqual([
      expect.objectContaining({ id: "resume", icon: "📄" }),
      expect.objectContaining({ id: "coverLetter", icon: "✉️" }),
    ]);
  });

  it("integrates the durable Today thread, missions, decision queue, and composer", async () => {
    const html = await renderView();

    expect(html).toContain("CareerRat");
    expect(html).toContain("I found six strong roles.");
    expect(html).toContain("Start with Tyrell.");
    expect(html).toContain("Apply to 1 role");
    expect(html).toContain("E Corp application ready");
    expect(html).toContain("tell Paul what to do");
    expect(html).toContain("1 touch due");
    expect(html).toContain("next: Thu");
    expect(html).toContain("chat-first-browser-launcher--attention");
  });

  it("owns durable Today receipt and artifact actions", async () => {
    const { ChatFirstAppView } = await import("./ChatFirstApp.jsx");
    const openActivity = vi.fn();
    const openThreadArtifact = vi.fn();
    const buttons = [];
    const tree = ChatFirstAppView({
      view: {
        ...VIEW,
        mainThread: {
          messages: [
            {
              id: "run-with-artifact",
              role: "system",
              kind: "action_result",
              text: "Packet drafted.",
              artifacts: [{ id: "resume", kind: "resume", title: "Tyrell resume" }],
            },
          ],
        },
      },
      ui: BASE_UI,
      composerValue: "",
      sourceSweep: {},
      actions: { openActivity, openThreadArtifact },
    });

    function visit(node) {
      if (!node || typeof node !== "object") return;
      if (Array.isArray(node)) {
        node.forEach(visit);
        return;
      }
      if (typeof node.type === "function") {
        visit(node.type(node.props));
        return;
      }
      if (node.type === "button") buttons.push(node);
      visit(node.props?.children);
    }
    visit(tree);

    buttons.find((button) => button.props.children === "activity").props.onClick();
    buttons.find((button) => button.props.children === "Open").props.onClick();

    expect(openActivity).toHaveBeenCalledOnce();
    expect(openThreadArtifact).toHaveBeenCalledWith(
      null,
      expect.objectContaining({ id: "resume" })
    );
  });

  it("routes the latest typed transcript action to the app controller", async () => {
    const { ChatFirstAppView } = await import("./ChatFirstApp.jsx");
    const runMessageIntent = vi.fn();
    const intent = {
      type: "screening.answer-confirm",
      entity: { type: "application", id: "app-1" },
      input: { question: "Who inspired Curri?", answer: "Mike" },
    };
    const tree = ChatFirstAppView({
      view: {
        ...VIEW,
        mainThread: {
          messages: [
            {
              id: "answer-ready",
              role: "assistant",
              kind: "action_result",
              text: "Review this answer before using it.",
              metadata: { nextActions: [{ label: "Use this answer", intent }] },
            },
          ],
        },
      },
      ui: BASE_UI,
      composerValue: "",
      sourceSweep: {},
      actions: { runMessageIntent },
    });
    const buttons = [];
    function visit(node) {
      if (!node || typeof node !== "object") return;
      if (Array.isArray(node)) {
        node.forEach(visit);
        return;
      }
      if (typeof node.type === "function") {
        visit(node.type(node.props));
        return;
      }
      if (node.type === "button") buttons.push(node);
      visit(node.props?.children);
    }
    visit(tree);

    buttons.find((button) => button.props.children === "Use this answer").props.onClick();
    expect(runMessageIntent).toHaveBeenCalledWith(intent);
  });

  it("replaces the thread workspace with the selected browser surface", async () => {
    const html = await renderView({ ui: { ...BASE_UI, browse: "search", selection: ["s1"] } });

    expect(html).toContain("Workspace browser");
    expect(html).toContain("Tyrell");
    expect(html).toContain("Apply to 1 job");
    expect(html).not.toContain("Conversation threads");
  });

  it("keeps internal tracker notes out of Pipeline and labels the tab by tracked rows", async () => {
    const view = {
      ...VIEW,
      counts: { ...VIEW.counts, pipeline: 2 },
      browser: {
        ...VIEW.browser,
        pipeline: {
          applicationCount: 2,
          rows: [],
          leaks: [],
          jobs: [
            {
              id: "keep-1",
              company: "Keep Co",
              role: "Platform Engineer",
              stage: "Ready to apply",
              note: "gate keep; fit 88",
              statusNote: "Cleared review and ready for preparation.",
              fit: 88,
            },
            {
              id: "review-1",
              company: "Review Co",
              role: "Staff Engineer",
              stage: "Needs review",
              note: "gate review; fit 84",
              fit: 84,
            },
          ],
        },
      },
    };
    const pipeline = await renderView({
      view,
      ui: { ...BASE_UI, browse: "pipeline", pipeView: "list" },
    });
    const threads = await renderView({ view });

    expect(pipeline).toContain("Ready to apply");
    expect(pipeline).toContain("Needs review");
    expect(pipeline).toContain("Cleared review and ready for preparation.");
    expect(pipeline).not.toContain("gate keep; fit 88");
    expect(pipeline).not.toContain("gate review; fit 84");
    expect(threads).toContain("2 tracked");
    expect(threads).not.toContain("0 in play");
  });

  it("renders a durable job conversation and job-scoped context", async () => {
    const html = await renderView({
      view: {
        ...VIEW,
        threads: [{ ...VIEW.threads[0], location: "Remote - United States", mode: "Remote" }],
        jobDetails: {
          "app-1": {
            base: "$185,000 - $215,000",
            compNote: "Clears the stated minimum by $25,000.",
            sourceLabel: "Ashby",
            postedAt: "2026-08-19T12:00:00.000Z",
            statusNote: "Ready for application preparation. Not submitted.",
            nextAction: {
              summary: "Ready for application preparation. Not submitted.",
            },
            roleFit: {
              why: ["React and TypeScript evidence matches"],
              risks: ["No logistics background recorded"],
            },
          },
        },
      },
      ui: { ...BASE_UI, activeThread: "app-1", activeApplicationId: "app-1" },
    });

    expect(html).toContain("E CORP · STAFF SWE · OFFER");
    expect(html).toContain("I drafted the reply.");
    expect(html).toContain("Darlene Alderson · Recruiting");
    expect(html).toContain("Can you talk Friday morning?");
    expect(html).toContain("Approve &amp; copy");
    expect(html).toContain("THIS JOB");
    expect(html).toContain("91");
    expect(html).toContain("$185,000 - $215,000");
    expect(html).toContain("Clears the stated minimum by $25,000.");
    expect(html).toContain("Remote - United States");
    expect(html).not.toContain("Remote - United States · Remote");
    expect(html).toContain("Ashby · posted Aug 19");
    expect(html).toContain("Ready for application preparation. Not submitted.");
    const jobCard = html.match(
      /<section class="chat-first-context-card chat-first-context-card--job">[\s\S]*?<\/section>/
    )?.[0];
    expect(jobCard).toContain("$185,000 - $215,000");
    expect(jobCard).toContain("Clears the stated minimum by $25,000.");
    expect(jobCard).toContain("Remote - United States");
    expect(jobCard).toContain("Ashby · posted Aug 19");
    expect(jobCard).toContain("Ready for application preparation. Not submitted.");
    expect(jobCard).toContain("React and TypeScript evidence matches");
    expect(jobCard).toContain("No logistics background recorded");
    expect(jobCard.match(/Ready for application preparation\. Not submitted\./g)).toHaveLength(1);
    expect(html).not.toContain("Current position");
    expect(html).not.toContain("chat-first-context-card--cream");
    expect(html).not.toContain("Run mock interview");
  });

  it("labels each canonical job date by what happened", async () => {
    for (const [field, expected] of [
      ["sourcedAt", "Ashby · found Aug 20"],
      ["appliedAt", "Ashby · applied Aug 21"],
    ]) {
      const html = await renderView({
        view: {
          ...VIEW,
          jobDetails: {
            "app-1": {
              sourceLabel: "Ashby",
              [field]: field === "sourcedAt" ? "2026-08-20T12:00:00.000Z" : "2026-08-21",
            },
          },
        },
        ui: { ...BASE_UI, activeThread: "app-1", activeApplicationId: "app-1" },
      });

      expect(html).toContain(expected);
    }
  });

  it("offers a first-class mock interview from a reviewed saved job", async () => {
    const html = await renderView({
      view: {
        ...VIEW,
        threads: [{ ...VIEW.threads[0], stage: "reviewed hold" }],
      },
      ui: { ...BASE_UI, activeThread: "app-1", activeApplicationId: "app-1" },
    });

    expect(html).toContain("Run mock interview");
  });

  it("renders a visible research thread with streamed activity, typed save/discard controls, and durable results", async () => {
    const html = await renderView({
      view: {
        ...VIEW,
        skillChats: [
          {
            id: "skill:research-company",
            skill: "research-company",
            title: "Researching Acme",
            subtitle: "research complete · review the result",
            state: "idle",
          },
        ],
      },
      ui: { ...BASE_UI, activeThread: "skill:research-company" },
      activeSkillChat: {
        id: "skill:research-company",
        skill: "research-company",
        title: "Researching Acme",
        state: "idle",
        messages: [
          { id: "activity", role: "system", kind: "status", text: "Searching the web" },
          {
            id: "result",
            role: "assistant",
            kind: "text",
            text: "Research is ready.",
            artifacts: [
              {
                id: "discovery:company:acme",
                kind: "company_research_result",
                title: "Acme research",
                subtitle: "cited research ready to review",
              },
            ],
          },
          {
            id: "saved",
            role: "system",
            kind: "action_result",
            text: "Saved research for Acme to your workspace.",
          },
        ],
      },
    });

    expect(html).toContain("RESEARCHING ACME");
    expect(html).toContain("Searching the web");
    expect(html).toContain("Research is ready.");
    expect(html).toContain("Save to workspace");
    expect(html).toContain("Discard");
    expect(html).toContain("Saved research for Acme to your workspace.");
    expect(html).toContain("Research runs stay in this thread");
  });

  it("disables the composer while a selected research thread is reopening", async () => {
    const html = await renderView({
      view: {
        ...VIEW,
        skillChats: [
          {
            id: "skill:research-company",
            skill: "research-company",
            title: "Researching Acme",
            state: "idle",
          },
        ],
      },
      ui: { ...BASE_UI, activeThread: "skill:research-company" },
      composerValue: "Continue the research",
      activeSkillChat: {
        id: "skill:research-company",
        skill: "research-company",
        title: "Researching Acme",
        chatId: null,
        state: "idle",
        messages: [],
      },
    });

    expect(html).toMatch(/aria-label="Message Paul"[^>]*disabled=""/);
    expect(html).toMatch(/aria-label="Send message"[^>]*disabled=""/);
  });

  it("renders structured canonical next actions as readable job context", async () => {
    const html = await renderView({
      view: {
        ...VIEW,
        jobDetails: {
          "app-1": {
            floor: 215,
            marketP50: 235,
            ask: 240,
            nextAction: {
              state: "needs-action",
              label: "Follow-up",
              title: "Follow up",
              summary: "Respond to the E Corp offer this week.",
              dueText: "2 days",
            },
          },
        },
      },
      ui: { ...BASE_UI, activeThread: "app-1", activeApplicationId: "app-1" },
    });

    expect(html).toContain("Respond to the E Corp offer this week.");
    expect(html).toContain("your floor $215k · market midpoint $235k · target $240k");
    expect(html).toContain("<small>NEGOTIATION</small>");
    expect(html).not.toContain("Negotiation position");
    expect(html).not.toContain("[object Object]");
  });

  it("renders deep ingest and its evidence context inside the same shell", async () => {
    const html = await renderView({
      ui: { ...BASE_UI, activeThread: "ingest" },
      deepIngest: { evidenceItems: ["6 roles", "14 stories"], lastSession: "resume.pdf" },
    });

    expect(html).toContain("DEEP INGEST");
    expect(html).toContain("drop files here");
    expect(html).toContain("14 stories");
    expect(html).toContain("Pause");
  });

  it("renders deep ingest review state from the durable view model", async () => {
    const html = await renderView({
      ui: { ...BASE_UI, activeThread: "ingest" },
      deepIngest: {
        evidenceItems: ["3 confirmed items"],
        counts: { sources: 2, proposals: 4, reviewQueue: 1, confirmed: 3 },
        sources: [
          {
            id: "source-1",
            label: "Pasted notes: billing migration",
            statusLabel: "Ready to analyze",
            canAnalyze: true,
          },
        ],
        proposals: [
          {
            id: "proposal-1",
            lane: "story_bank",
            title: "Billing migration",
            summary: "Led a billing migration.",
            supportingQuote: "Reduced reconciliation time by 31%.",
          },
        ],
        receipt: "Analysis complete. 1 proposal needs review.",
      },
    });

    expect(html).toContain("Analysis complete. 1 proposal needs review.");
    expect(html).toContain("Billing migration");
    expect(html).toContain("Ready to analyze");
    expect(html).toContain("1 to review");
  });

  it("renders the live mock session with the owning job still active", async () => {
    const html = await renderView({
      ui: { ...BASE_UI, activeThread: "mock", activeApplicationId: "app-1" },
      mockSession: {
        id: "mock-1",
        questionNumber: 2,
        totalQuestions: 6,
        question: "Why E Corp?",
        worked: "Specific story",
        tighten: "Lead with impact",
        loadedContext: "Job description · confirmed story bank",
      },
    });

    expect(html).toContain("MOCK INTERVIEW · E CORP CONTEXT · QUESTION 2 OF 6");
    expect(html).toContain("Why E Corp?");
    expect(html).toContain("Specific story");
    expect(html).toContain("LIVE SESSION");
    expect(html).toContain("Job description · confirmed story bank");
    expect(html).not.toContain("Job description, dossier, and confirmed story bank");
    expect(html).toContain('aria-current="page"');
  });

  it("reopens an active durable mock from its owning job instead of starting another session", async () => {
    const html = await renderView({
      view: {
        ...VIEW,
        threads: [{ ...VIEW.threads[0], stage: "technical" }],
      },
      ui: { ...BASE_UI, activeThread: "app-1", activeApplicationId: "app-1" },
      mockSession: {
        id: "mock-existing",
        applicationId: "app-1",
        status: "active",
        questionReady: true,
      },
    });

    expect(html).toContain("Continue mock interview");
    expect(html).not.toContain("Run mock interview");
  });

  it("shows an ended mock on its job thread and reopens the complete transcript after reload", async () => {
    const endedMock = {
      id: "mock-ended",
      applicationId: "app-1",
      status: "ended",
      summary: "Strong evidence. Tighten the tradeoff.",
      questionReady: true,
      questionNumber: 2,
      totalQuestions: 2,
      question: "Describe the migration.",
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
    };
    const jobHtml = await renderView({
      view: { ...VIEW, threads: [{ ...VIEW.threads[0], stage: "technical" }] },
      ui: { ...BASE_UI, activeThread: "app-1", activeApplicationId: "app-1" },
      mockSession: endedMock,
    });
    const transcriptHtml = await renderView({
      ui: { ...BASE_UI, activeThread: "mock", activeApplicationId: "app-1" },
      mockSession: endedMock,
    });

    expect(jobHtml).toContain("Review mock interview");
    expect(transcriptHtml).toContain("SESSION COMPLETE");
    expect(transcriptHtml).toContain("Strong evidence. Tighten the tradeoff.");
    expect(transcriptHtml).toContain("Why this role?");
    expect(transcriptHtml).toContain("The product fit.");
    expect(transcriptHtml).toContain("Specific motivation");
    expect(transcriptHtml).toContain("Describe the migration.");
    expect(transcriptHtml).toContain("I led three teams.");
    expect(transcriptHtml).toContain("Explain the tradeoff");
    expect(transcriptHtml).not.toContain('aria-label="Message Paul"');
  });

  it("shows a disabled preparing state while question one is still generating", async () => {
    const html = await renderView({
      view: { ...VIEW, threads: [{ ...VIEW.threads[0], stage: "technical" }] },
      ui: { ...BASE_UI, activeThread: "app-1", activeApplicationId: "app-1" },
      mockSession: {
        id: "mock-preparing",
        applicationId: "app-1",
        status: "active",
        questionReady: false,
        question: null,
      },
    });

    expect(html).toContain("Preparing first question…");
    expect(html).toMatch(/Preparing first question…<\/button>/);
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Preparing first question…<\/button>/);
    expect(html).not.toContain("Continue mock interview");
    expect(html).not.toContain("Tell me about the experience most relevant to this role.");
  });

  it("offers an explicit resume action for a durable paused mission", async () => {
    const html = await renderView({
      view: {
        ...VIEW,
        missions: [
          {
            ...VIEW.missions[0],
            steps: [
              { id: "packet", label: "Draft E Corp packet", status: "completed" },
              { id: "prepare", label: "Prepare E Corp form", status: "pending" },
            ],
          },
        ],
      },
    });

    expect(html).toContain(">resume</button>");
    expect(html).not.toContain(">pause</button>");
  });

  it("mounts the submit gate, artifact viewer, and engine-down cover as real overlays", async () => {
    const html = await renderView({
      activeGate: {
        company: "E Corp",
        role: "Staff SWE",
        channel: "Greenhouse",
        packet: [{ id: "resume", name: "resume.pdf" }],
      },
      artifactViewer: { title: "Resume preview", artifact: { html: "<p>Resume</p>" } },
      engineDown: true,
    });

    expect(html).toContain("Submit to E Corp");
    expect(html).toContain("Nothing sends until you press submit");
    expect(html).toContain("viewer:Resume preview");
    expect(html).toContain("Paul can&#x27;t think right now");
  });
});
