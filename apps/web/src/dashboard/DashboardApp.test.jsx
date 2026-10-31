import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import { DashboardView, dashboardChanges, dashboardHandoff } from "./DashboardApp.jsx";

vi.mock("../jobs/ArtifactViewerModal.jsx", async (importOriginal) => ({
  ...(await importOriginal()),
  ArtifactViewerModal: () => null,
}));

const change = {
  kind: "knowledge_write",
  target: "evidence",
  label: "Leadership example",
  beforeAbsent: true,
  after: { claim: "Led four engineers" },
  revertible: true,
};
const view = {
  candidateName: "Alex Morgan",
  mainThread: {
    id: "workspace-main",
    messages: [
      {
        id: "write-1",
        kind: "action_result",
        text: "Evidence saved",
        createdAt: "2026-10-31T12:00:00.000Z",
        artifacts: [change],
      },
    ],
  },
  threads: [
    {
      id: "job:app-1",
      applicationId: "app-1",
      company: "Northstar",
      role: "Manager",
      messages: [],
    },
  ],
  archivedThreads: [],
  needsYou: [
    {
      id: "need-1",
      applicationId: "app-1",
      title: "Follow up with Northstar",
      detail: "Screen completed",
    },
  ],
  counts: { pipeline: 1, search: 2, files: 1 },
  browser: {
    pipeline: {
      jobs: [{ id: "app-1", company: "Northstar", role: "Manager", stage: "Interviewing" }],
    },
    search: [],
    schedule: [],
    files: [
      { id: "file-1", name: "Northstar résumé.pdf", applicationId: "app-1", packetKind: "resume" },
    ],
  },
  activity: [],
  jobDetails: {},
};

function render(props = {}) {
  return renderToStaticMarkup(
    <MemoryRouter>
      <DashboardView
        view={view}
        tab="today"
        startCommand="careerrat start codex"
        actions={{}}
        {...props}
      />
    </MemoryRouter>
  );
}

describe("CLI dashboard", () => {
  it("shows the canonical saved-change timestamp", () => {
    expect(render({ tab: "changes" })).toContain("2026-10-31T12:00:00.000Z");
  });

  it("uses a workspace label for an unset candidate name", () => {
    const html = render({ view: { ...view, candidateName: "Not set" } });
    expect(html).toContain("Your workspace");
    expect(html).toContain("Your search");
    expect(html).not.toContain("Not set");
  });
  it("shows canonical next steps and workspace identity without an AI composer", () => {
    const html = render();
    expect(html).toContain("Alex Morgan");
    expect(html).toContain("Follow up with Northstar");
    expect(html).toContain("Pipeline");
    expect(html).toContain("Changes");
    expect(html).not.toContain("textarea");
    expect(html).not.toContain("EngineDownCover");
  });

  it("renders the pipeline from the shared canonical projection", () => {
    const html = render({ tab: "pipeline" });
    expect(html).toContain("Northstar");
    expect(html).toContain("Interviewing");
    expect(html).not.toContain("Run mission");
  });

  it("shows a CLI setup handoff when no database exists", () => {
    const html = render({ view: null, noDatabase: true });
    expect(html).toContain("Start your workspace");
    expect(html).toContain("careerrat start codex");
    expect(html).not.toContain("AI provider");
  });

  it("displays and copies the server command from both launch buttons", () => {
    const startCommand = "CAREERRAT_HOME='/some custom workspace' careerrat start codex";
    const copy = vi.fn();
    const element = DashboardView({
      view: null,
      noDatabase: true,
      startCommand,
      actions: { copy },
    });
    function visit(node) {
      if (!node || typeof node !== "object") return;
      if (
        node.type === "button" &&
        JSON.stringify(node.props.children).includes("Copy start command")
      ) {
        node.props.onClick();
      }
      for (const child of [node.props?.children].flat(Infinity)) visit(child);
    }
    visit(element);
    expect(copy.mock.calls).toEqual([[startCommand], [startCommand]]);
    expect(render({ view: null, noDatabase: true, startCommand })).toContain(
      "CAREERRAT_HOME=&#x27;/some custom workspace&#x27; careerrat start codex"
    );
  });

  it("disables both launch buttons while the workspace command is loading", () => {
    const html = render({
      view: null,
      noDatabase: true,
      startCommand: undefined,
      workspaceKnown: false,
    });
    expect(html).toContain("Loading workspace command…");
    expect(html.match(/disabled=""/g)).toHaveLength(2);
    expect(html).not.toContain("careerrat start codex");
  });

  it("keeps existing rows visible when refresh fails and offers retry", () => {
    const html = render({ tab: "pipeline", error: "Refresh failed" });
    expect(html).toContain("Refresh failed");
    expect(html).toContain("Retry");
    expect(html).toContain("Northstar");
  });

  it("keeps a missing linked job distinct from another job", () => {
    const html = render({ tab: "job", applicationId: "gone" });
    expect(html).toContain("This job is no longer in this workspace");
    expect(html).not.toContain("Engineering Manager");
  });

  it("shows saved documents without generation controls", () => {
    const html = render({ tab: "files" });
    expect(html).toContain("Northstar résumé.pdf");
    expect(html).not.toContain("Generate");
  });

  it("marks a write undone using its persisted inverse entry", () => {
    const completed = {
      ...view,
      mainThread: {
        messages: [
          ...view.mainThread.messages,
          {
            id: "undo-1",
            artifacts: [{ ...change, revertOf: { messageId: "write-1", index: 0 } }],
          },
        ],
      },
    };
    const changes = dashboardChanges(completed);
    expect(changes).toHaveLength(1);
    expect(changes[0].reverted).toBe(true);
    const html = render({ view: completed, tab: "changes" });
    expect(html).toContain("Undone");
    expect(html).not.toContain(">Undo<");
  });

  it("copies a job-specific prompt without compensation or unrelated context", () => {
    expect(dashboardHandoff({ id: "app-1", company: "Northstar", role: "Manager" })).toBe(
      "Continue work on Northstar's Manager application (app-1). Read its saved job thread and record the result there."
    );
  });
});
