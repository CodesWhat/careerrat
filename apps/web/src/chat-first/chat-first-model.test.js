import { describe, expect, it } from "vitest";
import { buildDashboardViewModel } from "../../../../src/core/tracker/dashboard-data.js";
import { buildCartView, filterSearchJobs } from "./browser-model.js";
import {
  artifactEmoji,
  buildChatFirstView,
  chatFirstReducer,
  createChatFirstState,
  filterPipelineJobs,
  foregroundDraftKey,
  highFitSearchIds,
  parseChatFirstForeground,
  readForegroundDraft,
  reconcileChatFirstForeground,
  resolveForegroundStorage,
  serializeChatFirstForeground,
  writeForegroundDraft,
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
  it("unwraps an old structured assistant reply in the thread rail", () => {
    const view = buildChatFirstView(dashboard, {
      ...runtime,
      jobThreads: [
        {
          ...runtime.jobThreads[0],
          messages: [
            {
              id: "legacy-reply",
              role: "assistant",
              kind: "text",
              text: '{"reply":"The packet is ready for review."}',
            },
          ],
        },
      ],
    });

    expect(view.threads[0].subtitle).toBe("The packet is ready for review.");
  });

  it("maps canonical dashboard compensation results into real browser filters and cart state", () => {
    const actualDashboard = buildDashboardViewModel(
      {
        sourced: [
          {
            id: "posted-clear",
            company: "Clear Co",
            role: "Staff Engineer",
            status: "sourced",
            fitScore: 90,
            base: "$200,000 - $240,000",
          },
          {
            id: "evaluated-clear",
            company: "Evaluated Co",
            role: "Principal Engineer",
            status: "reviewed-hold",
            fitScore: 88,
            base: "verify",
            evaluation: { compensation: { status: "clears-floor" } },
          },
          {
            id: "unknown-comp",
            company: "Unknown Co",
            role: "Platform Engineer",
            status: "sourced",
            fitScore: 86,
            base: "verify",
          },
        ],
        applications: [],
        communications: [],
      },
      {
        settings: {
          profile: {
            candidate: "Riley",
            minimumBase: "$190K",
            minimumBaseK: 190,
          },
        },
      }
    );
    const view = buildChatFirstView(actualDashboard, {});

    expect(view.browser.search).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "posted-clear", compStatus: "comp ✓" }),
        expect.objectContaining({ id: "evaluated-clear", compStatus: "comp ✓" }),
        expect.objectContaining({ id: "unknown-comp", compStatus: "comp pending" }),
      ])
    );
    expect(
      filterSearchJobs(view.browser.search, { comp: true })
        .map((row) => row.id)
        .sort()
    ).toEqual(["evaluated-clear", "posted-clear"]);
    expect(buildCartView(view.browser.search)).toMatchObject({
      count: 3,
      compPendingCount: 1,
    });
  });

  it("keeps partial job-description capture status on the matching search result", () => {
    const actualDashboard = buildDashboardViewModel({
      sourced: [
        {
          id: "partial-jd",
          company: "Partial Co",
          role: "Platform Engineer",
          status: "sourced",
          fitScore: 88,
          scanner: { bodyPartial: true },
          artifacts: { jd: "workspace/jobs/partial-co-platform-engineer.md" },
        },
        {
          id: "complete-jd",
          company: "Complete Co",
          role: "Staff Engineer",
          status: "sourced",
          fitScore: 86,
          scanner: { bodyPartial: false },
          artifacts: { jd: "workspace/jobs/complete-co-staff-engineer.md" },
        },
      ],
      applications: [],
      communications: [],
    });

    const view = buildChatFirstView(actualDashboard, {});

    expect(view.browser.search).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "partial-jd", descriptionPartial: true }),
        expect.objectContaining({ id: "complete-jd", descriptionPartial: false }),
      ])
    );
  });

  it("uses durable thread state and maps every browser surface from canonical data", () => {
    const view = buildChatFirstView(dashboard, runtime);

    expect(view.agentName).toBe("Paul");
    expect(view.locationPolicy).toEqual({
      home: "NYC",
      remoteRegion: "United States",
      remoteScope: "home-country",
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
      pipeline: 2,
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

  it("collapses multiple ready applications into one review action", () => {
    const submitStep = (id, company) => ({
      id: `submit-${id}`,
      action: "submit-gate",
      status: "blocked",
      jobRef: { id, company, role: "Engineer" },
      result: { requiresUserSubmit: true, applicationId: id },
    });
    const view = buildChatFirstView(
      { ...dashboard, allNextSteps: [] },
      {
        ...runtime,
        missions: [
          { id: "mission-one", steps: [submitStep("one", "Black Mesa")] },
          { id: "mission-one-old", steps: [submitStep("one", "Black Mesa")] },
          { id: "mission-two", steps: [submitStep("two", "Tyrell")] },
          { id: "mission-three", steps: [submitStep("three", "Abstergo")] },
        ],
        needsYou: [],
        touchDue: [{ id: "comm-1", name: "Angela" }],
      }
    );

    expect(view.needsYou).toEqual([
      expect.objectContaining({
        id: "submit-batch:mission-one:submit-one:mission-two:submit-two:mission-three:submit-three",
        kind: "submit-gate-group",
        gateIds: ["mission-one:submit-one", "mission-two:submit-two", "mission-three:submit-three"],
        title: "3 applications are ready",
        primaryLabel: "Apply to 3 jobs",
      }),
      expect.objectContaining({ id: "touch:comm-1" }),
    ]);
  });

  it("personalizes generated action copy with the configured agent name", () => {
    const view = buildChatFirstView(
      {
        ...dashboard,
        network: {
          companies: [
            {
              company: "Wayne Enterprises",
              contacts: [{ id: "lucius", name: "Lucius Fox", type: "Hiring manager" }],
            },
          ],
        },
      },
      {
        ...runtime,
        agentName: "Scout",
        missions: [],
        needsYou: [
          { id: "source-a", kind: "sourced-decision", sourceId: "source-a" },
          { id: "source-b", kind: "sourced-decision", sourceId: "source-b" },
        ],
      }
    );

    expect(view.browser.people[0].actionLabel).toBe("Ask Scout");
    expect(view.needsYou.find((item) => item.kind === "sourced-decision-group")?.detail).toContain(
      "before Scout prepares each application"
    );
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

  it("keeps question capture visible as a durable job-thread action", () => {
    const view = buildChatFirstView(
      { ...dashboard, allNextSteps: [] },
      {
        ...runtime,
        jobThreads: [
          {
            id: "thread-question-capture",
            applicationId: "app-1",
            company: "E Corp",
            packetReview: {
              gaps: [],
              questionCaptureRequired: true,
            },
          },
        ],
        missions: [],
        touchDue: [],
      }
    );

    expect(view.threads[0].needsAction).toBe(true);
  });

  it("degrades empty snapshots without inventing demo product state", () => {
    const view = buildChatFirstView(null, null);

    expect(view.threads).toEqual([]);
    expect(view.needsYou).toEqual([]);
    expect(view.browser.search).toEqual([]);
    expect(view.activeMission).toBeNull();
    expect(view.deepIngestPrompt).toEqual({ visible: false });
  });

  it("maps a durable Deep ingest thread and can navigate away and back without job context", () => {
    const view = buildChatFirstView(
      {},
      {
        deepIngestThread: {
          id: "ingest",
          title: "Deep ingest",
          subtitle: "add work history and review grounded evidence",
        },
      }
    );
    expect(view.deepIngestThread).toMatchObject({ id: "ingest", title: "Deep ingest" });

    let state = chatFirstReducer(createChatFirstState(), { type: "thread.open", id: "ingest" });
    expect(state).toMatchObject({ activeThread: "ingest", activeApplicationId: null });
    state = chatFirstReducer(state, { type: "thread.open", id: "today" });
    state = chatFirstReducer(state, { type: "thread.open", id: "ingest" });
    expect(state).toMatchObject({ activeThread: "ingest", activeApplicationId: null });
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

  it("does not count a reviewed-hold role as applied or heard back", () => {
    const view = buildChatFirstView(
      {
        ...dashboard,
        stats: { inPlay: 0 },
        jobs: {
          ...dashboard.jobs,
          visibleCount: 1,
          rows: [
            {
              id: "hold-1",
              company: "Curri",
              role: "Senior Software Engineer",
              status: "reviewed-hold",
              stage: "reviewed-hold",
              stageLabel: "Reviewed Hold",
              terminal: false,
            },
          ],
        },
      },
      { ...runtime, missions: [] }
    );

    expect(view.counts.pipeline).toBe(1);
    expect(view.browser.pipeline.applicationCount).toBe(1);
    expect(view.browser.pipeline.rows).toEqual([
      expect.objectContaining({ id: "applied", count: 0 }),
      expect.objectContaining({ id: "heard-back", count: 0 }),
      expect.objectContaining({ id: "onsite", count: 0 }),
      expect.objectContaining({ id: "final", count: 0 }),
      expect.objectContaining({ id: "offer", count: 0 }),
    ]);
  });

  it("uses the evaluated application display label in matching job threads", () => {
    const view = buildChatFirstView(
      {
        ...dashboard,
        jobs: {
          ...dashboard.jobs,
          rows: [
            {
              id: "hold-keep",
              company: "Keep Co",
              status: "reviewed-hold",
              stage: "reviewed-hold",
              stageLabel: "Ready to apply",
            },
            {
              id: "hold-review",
              company: "Review Co",
              status: "reviewed-hold",
              stage: "reviewed-hold",
              stageLabel: "Needs review",
            },
          ],
        },
      },
      {
        ...runtime,
        jobThreads: [
          { id: "job:hold-keep", applicationId: "hold-keep", stage: "reviewed-hold" },
          { id: "job:hold-review", applicationId: "hold-review", stage: "reviewed-hold" },
        ],
      }
    );

    expect(view.threads.map((thread) => thread.stage)).toEqual(["Ready to apply", "Needs review"]);
  });

  it("deduplicates saved artifacts by path without collapsing matching filenames", () => {
    const sharedPath = "workspace/jobs/acme-labs-senior-frontend-engineer.md";
    const sameNameDifferentPath = "workspace/archive/acme-labs-senior-frontend-engineer.md";
    const view = buildChatFirstView(
      {
        jobs: {
          rows: [],
          details: {
            "app-acme": {
              company: "Acme Labs",
              artifacts: [{ kind: "Job description", path: sharedPath }],
            },
          },
        },
        library: {
          cards: [
            {
              id: "library-acme",
              title: "acme-labs-senior-frontend-engineer.md",
              kind: "Job description",
              path: sharedPath,
            },
            {
              id: "library-archived-acme",
              title: "acme-labs-senior-frontend-engineer.md",
              kind: "Job description",
              path: sameNameDifferentPath,
            },
          ],
        },
      },
      {}
    );

    expect(view.browser.files.map((file) => file.path)).toEqual([
      sharedPath,
      sameNameDifferentPath,
    ]);
    expect(view.browser.files[0]).toEqual(
      expect.objectContaining({ id: "library-acme", applicationId: "app-acme" })
    );
    expect(view.counts.files).toBe(2);
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

  it("hydrates foreground navigation without resetting unrelated shell state", () => {
    const current = {
      ...createChatFirstState(),
      activityOpen: true,
      archiveOpen: true,
    };
    const state = chatFirstReducer(current, {
      type: "foreground.hydrate",
      foreground: {
        activeThread: "job:app-1",
        activeApplicationId: "app-1",
        browse: "pipeline",
        pipeView: "list",
        selection: ["sourced-1"],
        composerChips: ["app-1"],
        gateId: "submit-app-1",
      },
    });

    expect(state).toMatchObject({
      activeThread: "job:app-1",
      activeApplicationId: "app-1",
      browse: "pipeline",
      pipeView: "list",
      selection: ["sourced-1"],
      composerChips: ["app-1"],
      gateId: "submit-app-1",
      activityOpen: true,
      archiveOpen: true,
    });
  });
});

describe("chat-first foreground location", () => {
  it("round-trips stable foreground state through the URL", () => {
    const search = serializeChatFirstForeground({
      activeThread: "job:app-1",
      activeApplicationId: "app-1",
      browse: "search",
      pipeView: "list",
      selection: ["job-2", "job-1", "job-2"],
      searchSelectionSeeded: true,
      composerChips: ["job-1"],
      gateId: "submit-app-1",
      reviewKind: "company",
      reviewId: "batch-1",
      packetGapId: "gap-1",
      deepEditId: "proposal-1",
      deepInputMode: "paste",
      query: "staff platform",
      pipelineStage: "technical",
      filters: {
        fit80: true,
        comp: true,
        remote: false,
        stage: "offer",
        source: "greenhouse",
        posted: "7d",
        files: "resume",
        people: "needs-touch",
      },
    });

    expect(parseChatFirstForeground(search)).toEqual({
      activeThread: "job:app-1",
      activeApplicationId: "app-1",
      browse: "search",
      pipeView: "list",
      selection: ["job-2", "job-1"],
      searchSelectionSeeded: true,
      composerChips: ["job-1"],
      gateId: "submit-app-1",
      reviewKind: "company",
      reviewId: "batch-1",
      packetGapId: "gap-1",
      deepEditId: "proposal-1",
      deepInputMode: "paste",
      query: "staff platform",
      pipelineStage: "technical",
      filters: {
        fit80: true,
        comp: true,
        remote: false,
        stage: "offer",
        source: "greenhouse",
        posted: "7d",
        files: "resume",
        people: "needs-touch",
      },
    });
  });

  it("preserves the default Fit 80+ filter and an explicit show-all choice", () => {
    expect(parseChatFirstForeground("").filters.fit80).toBe(true);
    expect(parseChatFirstForeground("").filters.files).toBe("All");
    expect(serializeChatFirstForeground({ filters: { fit80: true, files: "All" } })).toBe("");
    const search = serializeChatFirstForeground({ filters: { fit80: false } });
    expect(search).toBe("?fit=all");
    expect(parseChatFirstForeground(search).filters.fit80).toBe(false);
  });

  it("ignores malformed saved review targets", () => {
    expect(parseChatFirstForeground("?review=unknown%3Abatch-1")).toMatchObject({
      reviewKind: null,
      reviewId: null,
    });
    expect(parseChatFirstForeground("?review=company")).toMatchObject({
      reviewKind: null,
      reviewId: null,
    });
  });

  it("round-trips an intentionally empty search selection across reload", () => {
    const search = serializeChatFirstForeground({
      browse: "search",
      selection: [],
      searchSelectionSeeded: true,
    });

    expect(search).toBe("?browse=search&selection=cleared");
    const foreground = parseChatFirstForeground(search);
    expect(foreground.selection).toEqual([]);
    expect(foreground.searchSelectionSeeded).toBe(true);

    const hydrated = chatFirstReducer(createChatFirstState(), {
      type: "foreground.hydrate",
      foreground,
    });
    expect(
      chatFirstReducer(hydrated, {
        type: "selection.seed-search",
        rows: [{ id: "high-fit", fitScore: 99 }],
      })
    ).toMatchObject({ selection: [], searchSelectionSeeded: true });
  });

  it("rehydrates the exact prior surface for browser back and forward", () => {
    const threadLocation = parseChatFirstForeground("?thread=job%3Aapp-1&application=app-1");
    const browserLocation = parseChatFirstForeground("?browse=people&people=needs-touch");
    let state = chatFirstReducer(createChatFirstState(), {
      type: "foreground.hydrate",
      foreground: browserLocation,
    });
    state = chatFirstReducer(state, {
      type: "foreground.hydrate",
      foreground: threadLocation,
    });

    expect(state).toMatchObject({
      activeThread: "job:app-1",
      activeApplicationId: "app-1",
      browse: false,
    });

    state = chatFirstReducer(state, {
      type: "foreground.hydrate",
      foreground: browserLocation,
    });
    expect(state).toMatchObject({ activeThread: "today", browse: "people" });
    expect(browserLocation.filters.people).toBe("needs-touch");
  });

  it("keeps a cleared selection cleared through browser back and forward", () => {
    const selectedLocation = parseChatFirstForeground(
      "?browse=search&selection=seeded&selected=job-1"
    );
    const clearedLocation = parseChatFirstForeground("?browse=search&selection=cleared");
    let state = chatFirstReducer(createChatFirstState(), {
      type: "foreground.hydrate",
      foreground: selectedLocation,
    });
    expect(state.selection).toEqual(["job-1"]);

    state = chatFirstReducer(state, {
      type: "foreground.hydrate",
      foreground: clearedLocation,
    });
    state = chatFirstReducer(state, {
      type: "selection.seed-search",
      rows: [{ id: "high-fit", fitScore: 99 }],
    });
    expect(state).toMatchObject({ selection: [], searchSelectionSeeded: true });

    state = chatFirstReducer(state, {
      type: "foreground.hydrate",
      foreground: selectedLocation,
    });
    expect(state).toMatchObject({ selection: ["job-1"], searchSelectionSeeded: true });
  });

  it("falls back clearly when a URL references entities that disappeared", () => {
    const result = reconcileChatFirstForeground(
      {
        ...createChatFirstState(),
        activeThread: "job:gone",
        activeApplicationId: "gone",
        selection: ["live", "gone"],
        composerChips: ["gone"],
        gateId: "gate-gone",
      },
      {
        threads: [{ id: "job:live", applicationId: "live" }],
        archivedThreads: [],
        skillChats: [],
        browser: { search: [{ id: "live" }] },
        missions: [],
      }
    );

    expect(result.state).toMatchObject({
      activeThread: "today",
      activeApplicationId: null,
      selection: ["live"],
      composerChips: [],
      gateId: null,
    });
    expect(result.notice).toBe("That saved workspace item no longer exists. You're back in Today.");
  });

  it("does not let newly completed background work hijack the foreground", () => {
    const foreground = {
      ...createChatFirstState(),
      activeThread: "job:app-1",
      activeApplicationId: "app-1",
      browse: false,
      selection: ["kept"],
    };
    const view = {
      threads: [{ id: "job:app-1", applicationId: "app-1" }],
      archivedThreads: [],
      skillChats: [],
      needsYou: [],
      browser: { search: [{ id: "kept" }, { id: "background-result" }] },
    };

    expect(reconcileChatFirstForeground(foreground, view)).toEqual({
      state: foreground,
      notice: null,
    });
  });

  it("keys private drafts to the stable foreground surface", () => {
    expect(foregroundDraftKey({ activeThread: "job:app-1", packetGapId: "gap-2" })).toBe(
      "careerrat:draft:job%3Aapp-1:gap-2"
    );
    expect(foregroundDraftKey({ activeThread: "today", browse: "people" })).toBe(
      "careerrat:draft:browser:people"
    );
  });

  it("restores bounded local drafts and removes empty ones", () => {
    const values = new Map();
    const storage = {
      getItem: (key) => values.get(key) ?? null,
      setItem: (key, value) => values.set(key, value),
      removeItem: (key) => values.delete(key),
    };
    const key = "careerrat:draft:today";

    writeForegroundDraft(storage, key, "A useful unsent reply");
    expect(readForegroundDraft(storage, key)).toBe("A useful unsent reply");
    writeForegroundDraft(storage, key, "");
    expect(readForegroundDraft(storage, key)).toBe("");
    expect(values.has(key)).toBe(false);
  });

  it("degrades safely when a managed browser blocks local storage access", () => {
    const scope = {};
    Object.defineProperty(scope, "localStorage", {
      get() {
        throw new Error("blocked");
      },
    });

    expect(resolveForegroundStorage(scope)).toBeNull();
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
