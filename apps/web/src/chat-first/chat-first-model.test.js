import { describe, expect, it } from "vitest";
import {
  artifactEmoji,
  buildChatFirstView,
  chatFirstReducer,
  createChatFirstState,
  filterPipelineJobs,
  highFitSearchIds,
} from "./chat-first-model.js";

const dashboard = {
  settings: { profile: { candidate: "Riley", location: "Remote / hybrid / on-site - NYC" } },
  sourcedRoles: [{ id: "sourced-1", company: "Tyrell", role: "Staff Engineer", fit: 88 }],
  reviewHoldRoles: [{ detailId: "hold-1", company: "Aperture", role: "Platform Lead", fit: 84 }],
  allNextSteps: [
    {
      detailId: "app-1",
      company: "E Corp",
      title: "Review application",
      detail: "Staff Software Engineer",
      dueText: "today",
      tone: "error",
    },
  ],
  jobs: {
    visibleCount: 22,
    terminalCount: 9,
    rows: [
      {
        id: "app-1",
        company: "E Corp",
        role: "Staff Software Engineer",
        stageLabel: "Offer",
        fit: 95,
        terminal: false,
      },
      {
        id: "app-2",
        company: "Initrode",
        role: "Principal Engineer",
        stageLabel: "Rejected",
        fit: 80,
        terminal: true,
      },
      {
        id: "sourced-in-jobs",
        source: "sourced",
        company: "Should Stay In Search",
        role: "Staff Engineer",
        stage: "sourced",
        stageLabel: "Sourced",
        fit: 91,
        terminal: false,
      },
    ],
    details: {
      "app-1": {
        company: "E Corp",
        artifacts: [
          {
            kind: "Resume",
            note: "Generated today",
            path: "workspace/tailored/e-corp/resume.md",
          },
          {
            kind: "Interview dossier",
            note: "Prepared today",
            path: "workspace/interview-prep/e-corp.md",
          },
        ],
      },
    },
    funnel: [{ id: "offer", label: "Offer", count: 2, pct: 9 }],
  },
  library: { cards: [{ id: "file-1", title: "resume.md", kind: "Resume" }] },
  network: {
    companies: [
      {
        applicationId: "app-1",
        company: "E Corp",
        contacts: [{ name: "Angela Moss", type: "Recruiter" }],
        nextTouch: "Aug 26",
      },
    ],
  },
  calendar: {
    thisWeek: {
      events: [{ id: "event-1", date: "2026-08-27", time: "14:00", title: "Cyberdyne panel" }],
    },
  },
  activity: [{ id: "activity-1", relTime: "2m", title: "Sweep complete" }],
};

const runtime = {
  agentName: "Paul",
  mainThread: {
    id: "workspace-main",
    messages: [{ id: "main-1", role: "assistant", kind: "text", text: "Morning sweep is done." }],
  },
  jobThreads: [
    {
      id: "thread-app-1",
      applicationId: "app-1",
      company: "E Corp",
      role: "Staff Software Engineer",
      stage: "Offer",
      archived: false,
      needsAction: true,
    },
    {
      id: "thread-app-2",
      applicationId: "app-2",
      company: "Initrode",
      stage: "Rejected",
      archived: true,
    },
  ],
  missions: [
    {
      id: "mission-1",
      title: "Apply to 2 roles",
      status: "paused",
      steps: [
        {
          id: "submit-app-1",
          action: "submit-gate",
          status: "blocked",
          label: "Submit E Corp",
          jobRef: { id: "app-1", company: "E Corp", role: "Staff Software Engineer" },
          result: {
            applicationId: "app-1",
            requiresUserSubmit: true,
            answeredCount: 2,
            questionCount: 3,
            packet: [{ id: "resume", name: "resume.pdf", kind: "Resume" }],
          },
        },
      ],
    },
  ],
  touchDue: [{ id: "lead-1", name: "William Bell", dueAt: "2026-08-26" }],
  mockSessions: [],
};

describe("buildChatFirstView", () => {
  it("uses durable thread state and maps every browser surface from canonical data", () => {
    const view = buildChatFirstView(dashboard, runtime);

    expect(view.agentName).toBe("Paul");
    expect(view.locationPolicy).toEqual({
      home: "NYC",
      remoteRegion: "United States",
      hybrid: true,
      onsite: true,
      confirmed: true,
      summary: "NYC local + US remote",
      boundary: "On-site limited to NYC",
    });
    expect(view.mainThread.messages[0].text).toBe("Morning sweep is done.");
    expect(view.threads).toEqual([expect.objectContaining(runtime.jobThreads[0])]);
    expect(view.archivedThreads).toEqual([expect.objectContaining(runtime.jobThreads[1])]);
    expect(view.counts).toEqual({
      search: 2,
      pipeline: 22,
      files: 3,
      people: 1,
      touchDue: 1,
      archived: 1,
    });
    expect(view.browser.search.map((row) => row.id)).toEqual(["sourced-1", "hold-1"]);
    expect(view.browser.pipeline).toMatchObject({
      applicationCount: 2,
      rows: [
        expect.objectContaining({ id: "applied", label: "Applied", count: 2, pct: 100 }),
        expect.objectContaining({ id: "heard-back", label: "Heard back", count: 1, pct: 50 }),
        expect.objectContaining({ id: "onsite", label: "Onsite", count: 1, pct: 50 }),
        expect.objectContaining({ id: "final", label: "Final", count: 1, pct: 50 }),
        expect.objectContaining({ id: "offer", label: "Offer", count: 1, pct: 50 }),
      ],
      jobs: [
        expect.objectContaining({
          id: "app-1",
          company: "E Corp",
          role: "Staff Software Engineer",
          stageId: "offer",
        }),
        expect.objectContaining({
          id: "app-2",
          company: "Initrode",
          role: "Principal Engineer",
          stageId: "rejected",
        }),
      ],
    });
    expect(view.browser.files).toEqual([
      expect.objectContaining({ id: "file-1", name: "resume.md", kind: "Resume" }),
      expect.objectContaining({
        id: "app-1:resume",
        applicationId: "app-1",
        packetKind: "resume",
        kind: "Resume",
      }),
      expect.objectContaining({
        id: "app-1:interview-dossier",
        applicationId: "app-1",
        kind: "Interview dossier",
      }),
    ]);
    expect(view.browser.people[0].name).toBe("Angela Moss");
    expect(view.browser.schedule).toEqual([
      {
        day: "THURSDAY",
        items: [
          expect.objectContaining({
            id: "event-1",
            title: "Cyberdyne panel",
            actionLabel: "Open prep",
          }),
        ],
      },
    ]);
    expect(view.activeMission.id).toBe("mission-1");
    expect(view.needsYou[0]).toMatchObject({
      id: "mission-1:submit-app-1",
      kind: "submit",
      applicationId: "app-1",
      company: "E Corp",
      primaryLabel: "Review & submit",
      tone: "plain",
      answeredCount: 2,
      questionCount: 3,
      packet: [{ id: "resume", name: "resume.pdf", kind: "Resume" }],
    });
    expect(view.needsYou[0].eyebrow).toBeUndefined();
    expect(view.needsYou).toContainEqual(
      expect.objectContaining({
        id: "touch:lead-1",
        touchId: "lead-1",
        kind: "touch",
        title: "Nudge William Bell?",
        primaryLabel: "Draft it",
      })
    );
    expect(view.threads[0]).toMatchObject({
      title: "E Corp",
      subtitle: "Offer",
      needsAction: true,
    });
  });

  it("never exposes an automatic submit action", () => {
    const view = buildChatFirstView(dashboard, runtime);

    expect(view.submitPolicy).toEqual({
      automatic: false,
      actionLabel: "Open form and submit",
      note: "Nothing sends until you press submit.",
    });
    expect(JSON.stringify(view)).not.toMatch(/submits skip|auto-submit/i);
  });

  it("uses the typed backend decision queue without duplicating touch-due cards", () => {
    const view = buildChatFirstView(
      { ...dashboard, allNextSteps: [] },
      {
        ...runtime,
        missions: [],
        needsYou: [
          {
            id: "sourced:source-1:decision",
            kind: "sourced-decision",
            sourceId: "source-1",
            title: "Apply to E Corp?",
          },
          {
            id: "touch:communication:comm-1",
            kind: "touch-due",
            touchId: "comm-1",
            title: "Nudge Angela?",
          },
        ],
        touchDue: [{ id: "comm-1", source: "communication", name: "Angela" }],
      }
    );

    expect(view.needsYou.map((item) => item.id)).toEqual([
      "sourced:source-1:decision",
      "touch:communication:comm-1",
    ]);
  });

  it("collapses sourced decisions into one batch action without hiding other needs", () => {
    const view = buildChatFirstView(
      { ...dashboard, allNextSteps: [] },
      {
        ...runtime,
        missions: [],
        needsYou: [
          {
            id: "sourced:one:decision",
            kind: "sourced-decision",
            sourceId: "one",
            title: "Apply to Black Mesa?",
          },
          {
            id: "sourced:two:decision",
            kind: "sourced-decision",
            sourceId: "two",
            title: "Apply to Tyrell?",
          },
          {
            id: "sourced:three:decision",
            kind: "sourced-decision",
            sourceId: "three",
            title: "Apply to Abstergo?",
          },
          {
            id: "touch:communication:comm-1",
            kind: "touch-due",
            touchId: "comm-1",
            title: "Nudge Angela?",
          },
        ],
      }
    );

    expect(view.needsYou).toEqual([
      expect.objectContaining({
        id: "sourced-batch:one:two:three",
        kind: "sourced-decision-group",
        sourceIds: ["one", "two", "three"],
        title: "3 qualified jobs are ready",
        primaryLabel: "Apply to 3 jobs",
        secondaryLabel: "Review",
      }),
      expect.objectContaining({ id: "touch:communication:comm-1" }),
    ]);
  });

  it("reserves the red thread dot for durable user actions, not ordinary agent replies", () => {
    const view = buildChatFirstView(
      { ...dashboard, allNextSteps: [] },
      {
        ...runtime,
        jobThreads: [
          {
            id: "thread-clear",
            applicationId: "app-1",
            company: "E Corp",
            messages: [{ id: "reply", role: "assistant", kind: "text", text: "Here is the plan." }],
          },
        ],
        missions: [],
        touchDue: [],
      }
    );

    expect(view.threads[0].needsAction).toBe(false);
  });

  it("degrades empty snapshots without inventing demo product state", () => {
    const view = buildChatFirstView(null, null);

    expect(view.threads).toEqual([]);
    expect(view.needsYou).toEqual([]);
    expect(view.browser.search).toEqual([]);
    expect(view.activeMission).toBeNull();
    expect(view.deepIngestPrompt).toEqual({ visible: false });
  });

  it("routes an unlinked real contact to Paul instead of showing a dead thread action", () => {
    const view = buildChatFirstView(
      {
        ...dashboard,
        network: {
          companies: [
            { company: "Massive Dynamic", contacts: [{ id: "nina", name: "Nina Sharp" }] },
          ],
        },
      },
      runtime
    );

    expect(view.browser.people[0]).toMatchObject({
      name: "Nina Sharp",
      applicationId: null,
      actionLabel: "Ask Paul",
    });
  });

  it("keeps terminal leak rows available to the pipeline filters", () => {
    const view = buildChatFirstView(
      {
        ...dashboard,
        jobs: {
          ...dashboard.jobs,
          visibleCount: 4,
          rows: [
            { id: "active", company: "Acme", stageLabel: "Applied", terminal: false },
            {
              id: "rejected",
              company: "Beta",
              stage: "rejected",
              stageLabel: "Rejected",
              terminal: true,
              terminalExitStage: "hiring-manager",
            },
            { id: "ghosted", company: "Gamma", stageLabel: "Ghosted", terminal: true },
            { id: "withdrawn", company: "Delta", stageLabel: "Withdrawn", terminal: true },
          ],
        },
      },
      { ...runtime, missions: [] }
    );

    expect(view.browser.pipeline.jobs.map((row) => row.id)).toEqual([
      "active",
      "rejected",
      "ghosted",
      "withdrawn",
    ]);
    expect(filterPipelineJobs(view.browser.pipeline.jobs, "rejected").map((row) => row.id)).toEqual(
      ["rejected"]
    );
    expect(filterPipelineJobs(view.browser.pipeline.jobs, "ghosted").map((row) => row.id)).toEqual([
      "ghosted",
    ]);
    expect(
      filterPipelineJobs(view.browser.pipeline.jobs, "withdrawn").map((row) => row.id)
    ).toEqual(["withdrawn"]);
  });
});

describe("chatFirstReducer", () => {
  it("seeds high-fit search jobs once and preserves later user changes", () => {
    expect(
      highFitSearchIds([
        { id: "fit-field", fit: 88 },
        { id: "score-field", fitScore: 91 },
        { id: "below", fitScore: 79 },
        { id: "pending", fitScore: null },
      ])
    ).toEqual(["fit-field", "score-field"]);

    let state = createChatFirstState();
    state = chatFirstReducer(state, {
      type: "selection.seed-search",
      rows: [
        { id: "fit-field", fit: 88 },
        { id: "score-field", fitScore: 91 },
        { id: "below", fitScore: 79 },
      ],
    });
    expect(state.selection).toEqual(["fit-field", "score-field"]);
    expect(state.searchSelectionSeeded).toBe(true);

    state = chatFirstReducer(state, { type: "selection.toggle", id: "fit-field" });
    state = chatFirstReducer(state, { type: "browser.close" });
    state = chatFirstReducer(state, { type: "browser.open", tab: "search" });
    state = chatFirstReducer(state, {
      type: "selection.seed-search",
      rows: [{ id: "later-refresh", fitScore: 99 }],
    });

    expect(state.selection).toEqual(["score-field"]);
  });

  it("replaces the browser selection for a grouped Needs You review", () => {
    const state = chatFirstReducer(
      { ...createChatFirstState(), selection: ["old"] },
      { type: "selection.replace", ids: ["one", "two", "one", null] }
    );

    expect(state.selection).toEqual(["one", "two"]);
  });

  it("preserves selected jobs across browser close and turns them into composer context", () => {
    let state = createChatFirstState();
    state = chatFirstReducer(state, { type: "browser.open", tab: "search" });
    state = chatFirstReducer(state, { type: "selection.toggle", id: "sourced-1" });
    state = chatFirstReducer(state, { type: "selection.toggle", id: "hold-1" });
    state = chatFirstReducer(state, { type: "selection.chat" });

    expect(state.browse).toBe(false);
    expect(state.selection).toEqual(["sourced-1", "hold-1"]);
    expect(state.composerChips).toEqual(["sourced-1", "hold-1"]);
    expect(state.activeThread).toBe("today");

    state = chatFirstReducer(state, { type: "composer.remove-context", id: "sourced-1" });
    expect(state.composerChips).toEqual(["hold-1"]);
    expect(state.selection).toEqual(["sourced-1", "hold-1"]);
  });

  it("can scope Today composer changes to an application without earning a job thread", () => {
    let state = chatFirstReducer(createChatFirstState(), {
      type: "composer.set-context",
      ids: ["app-submit", "app-submit"],
    });
    state = chatFirstReducer(state, { type: "thread.open", id: "today" });

    expect(state.activeThread).toBe("today");
    expect(state.activeApplicationId).toBeNull();
    expect(state.composerChips).toEqual(["app-submit"]);
  });

  it("keeps the handoff state transitions explicit and reversible", () => {
    let state = createChatFirstState();
    state = chatFirstReducer(state, { type: "thread.open", id: "app-1" });
    state = chatFirstReducer(state, { type: "mock.open", applicationId: "app-1" });
    state = chatFirstReducer(state, { type: "gate.open", id: "submit-app-1" });
    state = chatFirstReducer(state, { type: "archive.toggle" });

    expect(state.activeThread).toBe("mock");
    expect(state.activeApplicationId).toBe("app-1");
    expect(state.gateId).toBe("submit-app-1");
    expect(state.archiveOpen).toBe(true);

    state = chatFirstReducer(state, { type: "gate.close" });
    state = chatFirstReducer(state, { type: "mock.close" });
    expect(state.gateId).toBeNull();
    expect(state.activeThread).toBe("app-1");
  });
});

describe("artifactEmoji", () => {
  it("uses the handoff artifact glyphs", () => {
    expect(artifactEmoji("Resume")).toBe("📄");
    expect(artifactEmoji("Cover letter")).toBe("✉️");
    expect(artifactEmoji("Interview dossier")).toBe("📕");
    expect(artifactEmoji("Story bank")).toBe("⭐");
    expect(artifactEmoji("Evidence")).toBe("🧾");
  });
});

describe("filterPipelineJobs", () => {
  it("turns a funnel-bar selection into the matching list rows", () => {
    const jobs = [
      { id: "a", stage: "Applied" },
      { id: "b", stage: "Offer" },
      { id: "c", stage: "Going stale" },
    ];

    expect(filterPipelineJobs(jobs, "offer").map((job) => job.id)).toEqual(["b"]);
    expect(filterPipelineJobs(jobs, "going-stale").map((job) => job.id)).toEqual(["c"]);
    expect(filterPipelineJobs(jobs, null)).toEqual(jobs);
  });
});
