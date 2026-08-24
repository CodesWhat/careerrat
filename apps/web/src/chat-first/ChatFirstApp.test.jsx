import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

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

  it("replaces the thread workspace with the selected browser surface", async () => {
    const html = await renderView({ ui: { ...BASE_UI, browse: "search", selection: ["s1"] } });

    expect(html).toContain("Workspace browser");
    expect(html).toContain("Tyrell");
    expect(html).toContain("Draft 1 packet");
    expect(html).not.toContain("Conversation threads");
  });

  it("renders a durable job conversation and job-scoped context", async () => {
    const html = await renderView({
      ui: { ...BASE_UI, activeThread: "app-1", activeApplicationId: "app-1" },
    });

    expect(html).toContain("E CORP · STAFF SWE · OFFER");
    expect(html).toContain("I drafted the reply.");
    expect(html).toContain("Darlene Alderson · Recruiting");
    expect(html).toContain("Can you talk Friday morning?");
    expect(html).toContain("Approve &amp; copy");
    expect(html).toContain("THIS JOB");
    expect(html).toContain("91");
    expect(html).not.toContain("Run mock interview");
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
      mockSession: { id: "mock-existing", applicationId: "app-1" },
    });

    expect(html).toContain("Continue mock interview");
    expect(html).not.toContain("Run mock interview");
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
