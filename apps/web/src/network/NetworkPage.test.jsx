import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";

const dashboardMock = vi.hoisted(() => ({
  snapshot: {
    data: null,
    loading: false,
    error: null,
    noDatabase: false,
  },
}));

vi.mock("../app-shell/DashboardContext.jsx", () => ({
  useDashboardSnapshot: () => dashboardMock.snapshot,
}));

import { NetworkPage } from "./NetworkPage.jsx";

const networkPayload = {
  network: {
    metrics: {
      warmPaths: 1,
      companies: 2,
      dormant: 1,
    },
    companies: [
      {
        company: "Northstar AI",
        domain: "northstar.example",
        initials: "NA",
        role: "Staff Platform Engineer",
        status: "Screen",
        warmth: 72,
        contacts: [
          {
            type: "Recruiter",
            name: "Maya Chen",
            note: "Discussed platform scope and next step.",
          },
          {
            type: "Decision maker",
            name: "Jordan Lee",
            note: "Hiring manager for the platform team.",
          },
        ],
        reuseState: "caution",
        reuseTitle: "Caution: active loop first",
        reuseBody: "Use this relationship for the current process first.",
        reuseScope: "Reuse scope: same practice",
        nextTouch: "After screen",
        progressTone: "var(--mustard)",
        stateLabel: "In process",
        latestAt: "2026-07-01T16:00:00Z",
        notes: [
          "Recruiter screen cleared; hiring manager debrief is next.",
          "Comp band needs confirmation before broadening the ask.",
        ],
      },
      {
        company: "Archive Labs",
        domain: "",
        initials: "AL",
        role: "Relationship record",
        status: "Closed",
        warmth: 42,
        contacts: [],
        reuseState: "closed",
        reuseTitle: "Closed: memory only",
        reuseBody: "Do not use as an immediate reach-out path.",
        reuseScope: "Reuse scope: none now",
        nextTouch: "New role only",
        progressTone: "var(--plum)",
        stateLabel: "Closed",
        latestAt: "2026-06-15T11:00:00Z",
        notes: ["Closed-loop objection belongs in prep, not an immediate re-ping."],
      },
    ],
    coverage: {
      recruiters: 1,
      hiringManagers: 1,
      signals: 2,
    },
    gaps: ["Referral nodes are absent from the warmest active loops."],
    guardrails: ["Same-company routing is a good use when the new role is specific."],
    objections: ["Comp/job-code ambiguity belongs to the relationship record."],
    sourcing: {
      capability: "relationship_sourcing",
      platforms: ["linkedin", "wellfound"],
      reviewLeads: [],
      targets: [],
      guardrails: [],
    },
  },
};

function renderNetwork(initialEntry = "/network") {
  return renderToStaticMarkup(
    <MemoryRouter initialEntries={[initialEntry]}>
      <NetworkPage />
    </MemoryRouter>
  );
}

describe("NetworkPage", () => {
  it("renders relationship records from the dashboard network payload", () => {
    dashboardMock.snapshot = {
      data: networkPayload,
      loading: false,
      error: null,
      noDatabase: false,
    };

    const html = renderNetwork();

    expect(html).toContain("Network");
    expect(html).toContain("Warm Paths");
    expect(html).toContain("Northstar AI");
    expect(html).toContain("Staff Platform Engineer");
    expect(html).toContain("2 contacts");
    expect(html).toContain("Jul 1, 2026");
    expect(html).toContain("Archive Labs");
    expect(html).toContain("Closed");
    expect(html).toContain("Referral nodes are absent");
  });

  it("renders an honest empty state when no network data exists", () => {
    dashboardMock.snapshot = {
      data: {
        network: {
          metrics: { warmPaths: 0, companies: 0, dormant: 0 },
          companies: [],
          coverage: { recruiters: 0, hiringManagers: 0, signals: 0 },
          gaps: [],
          guardrails: [],
          objections: [],
          sourcing: { reviewLeads: [], targets: [] },
        },
      },
      loading: false,
      error: null,
      noDatabase: false,
    };

    const html = renderNetwork();

    expect(html).toContain("No relationship records yet");
    expect(html).toContain("communications capture");
    expect(html).toContain("relationship sourcing");
  });

  it("reveals contacts and conversation timeline for the open company", () => {
    dashboardMock.snapshot = {
      data: networkPayload,
      loading: false,
      error: null,
      noDatabase: false,
    };

    const html = renderNetwork("/network?open=Northstar%20AI");

    expect(html).toContain("Relationship detail");
    expect(html).toContain("Maya Chen");
    expect(html).toContain("Decision maker");
    expect(html).toContain("Conversation timeline");
    expect(html).toContain("Recruiter screen cleared");
    expect(html).toContain("Comp band needs confirmation");
    expect(html).toContain("Caution: active loop first");
  });
});
