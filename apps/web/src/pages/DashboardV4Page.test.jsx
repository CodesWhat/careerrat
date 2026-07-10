import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";

const dashboardContext = vi.hoisted(() => ({
  useDashboardSnapshot: vi.fn(),
}));

vi.mock("../app-shell/DashboardContext.jsx", () => dashboardContext);
vi.mock("../components/Toast.jsx", () => ({
  InlineAlert: ({ message }) => message,
}));

import { DashboardV4Page } from "./DashboardV4Page.jsx";

globalThis.React = React;

const DASHBOARD_V4_DATA = {
  header: { dateLabel: "Thursday, July 9", overdueCount: 2 },
  metrics: [
    { key: "needs", label: "Needs you", value: 1200, tone: "danger", to: "/jobs?filter=needs" },
    {
      key: "interviewing",
      label: "Interviewing",
      value: 3,
      tone: "teal",
      to: "/jobs?stage=interviewing",
    },
    { key: "waiting", label: "Waiting", value: 9, tone: "sky", to: "/jobs?stage=waiting" },
    { key: "high-fit", label: "High-fit new", value: 4, tone: "gold", to: "/jobs?filter=high-fit" },
  ],
  focus: {
    id: "focus-northstar",
    dueLabel: "Due today",
    dueTone: "danger",
    title: "Prep Northstar technical screen",
    company: "Northstar AI",
    role: "Staff Applied AI Engineer",
    basis: {
      summary: "Fit 94 - recruiter replied 1d ago - JD saved",
      reasons: ["System design loop is tomorrow", "Comp floor matches target"],
    },
    facts: [
      { label: "Format", value: "Remote" },
      { label: "Location", value: "New York" },
      { label: "Fit", value: 94 },
    ],
    cta: { label: "Open dossier", to: "/jobs?open=focus-northstar" },
    secondary: { label: "Snooze" },
  },
  needs: [
    {
      id: "focus-northstar",
      kicker: "Interview",
      title: "Prep Northstar technical screen",
      meta: "Duplicate focus item should not render in Needs you",
      due: "Due today",
      tone: "danger",
      action: { label: "Open", to: "/jobs?open=focus-northstar" },
    },
    {
      id: "need-omni",
      kicker: "Follow-up",
      title: "Draft Omniware follow-up",
      meta: "AI Platform Lead recruiter thread",
      due: "3:00 PM",
      tone: "warning",
      action: { label: "Draft", to: "/inbox?thread=omni" },
    },
  ],
  needsOverflow: 1,
  agentTask: {
    id: "agent-evaluate",
    skill: "evaluate-job",
    title: "Evaluate 2 high-fit sourced roles",
    why: "Fit >= 86, JD bodies saved, none gated yet.",
    risk: "read",
    cta: { label: "Run evaluate-job" },
    dismiss: { label: "Not now" },
  },
  schedule: {
    overdue: [
      {
        id: "sched-omni",
        time: "Yesterday",
        title: "Omniware follow-up",
        meta: "Recruiter thread",
        to: "/inbox?thread=omni",
      },
    ],
    today: [
      {
        id: "sched-northstar",
        time: "11:30 AM",
        title: "Northstar technical screen",
        meta: "Staff Applied AI Engineer",
        to: "/jobs?open=focus-northstar",
      },
    ],
  },
  activity: [
    {
      id: "activity-apply",
      relTime: "8m",
      skill: "apply-job",
      summary: "Promoted Acme AI to applied",
      to: "/jobs?open=acme",
    },
  ],
  pipeline: {
    stages: [
      { key: "applied", label: "Applied", count: 5, conversionFromPrev: null },
      { key: "screen", label: "Screen", count: 2, conversionFromPrev: 40 },
      { key: "technical", label: "Technical", count: 1, conversionFromPrev: 50 },
    ],
    stale: [
      {
        id: "stale-omni",
        company: "Omniware",
        role: "AI Platform Lead",
        stage: "Waiting",
        days: 21,
        reason: "2.1x median",
      },
    ],
  },
};

function renderDashboardV4(snapshot = {}) {
  dashboardContext.useDashboardSnapshot.mockReturnValue({
    data: { v4: DASHBOARD_V4_DATA },
    loading: false,
    error: null,
    noDatabase: false,
    ...snapshot,
  });

  return renderToStaticMarkup(
    <MemoryRouter>
      <DashboardV4Page />
    </MemoryRouter>
  );
}

describe("DashboardV4Page", () => {
  it("renders an action-first V4 dashboard from the live V4 snapshot", () => {
    const html = renderDashboardV4();

    expect(html).toContain('class="v4-page"');
    expect(html).toContain("Today");
    expect(html).toContain("Thursday, July ");
    expect(html).toContain('<span class="v4-num">2</span> overdue');
    expect(html).toContain('aria-label="Dashboard V4 metrics"');
    expect(html).toContain('data-dashboard-v4-stat="needs"');
    expect(html).toContain("1,200");
    expect(html).toContain('href="/jobs?filter=needs"');
    expect(html).toContain("Prep Northstar technical screen");
    expect(html.match(/Prep Northstar technical screen/g)).toHaveLength(1);
    expect(html).toContain('Fit <span class="v4-num">94</span>');
    expect(html).toContain("Draft Omniware follow-up");
    expect(html).toContain('<span class="v4-num">1</span> more');
    expect(html).toContain("Evaluate 2 high-fit sourced roles");
    expect(html).toContain("Reads only — no writes.");
    expect(html).toContain("Northstar technical screen");
    expect(html).toContain("apply-job");
    expect(html).toContain("Promoted Acme AI to applied");
    expect(html).toContain("Screen");
    expect(html).toContain("40% from Applied");
    expect(html).not.toContain("Closed");
    expect(html).not.toContain("Archived");
  });

  it("uses the shared V4 mock data when the snapshot has no V4 payload", () => {
    const html = renderDashboardV4({
      data: {
        jobs: { visibleCount: 0 },
        calendar: { today: { events: [] } },
      },
    });

    expect(html).toContain("Wednesday, July ");
    expect(html).toContain('<span class="v4-num">3</span> overdue');
    expect(html).toContain("Juniper Square");
    expect(html).toContain("Ramp recruiter follow-up");
    expect(html).toContain("LangChain");
    expect(html).toContain("Partial JD");
    expect(html).toContain("Anthropic");
    expect(html).not.toContain("Northstar");
  });

  it("renders the fail-closed database alert copy when no database exists", () => {
    const html = renderDashboardV4({ data: null, noDatabase: true });

    expect(html).toContain(
      "No database workspace detected — run `rolester data import` (or `rolester data init`) first, then reload."
    );
    expect(html).not.toContain("Juniper Square");
  });

  it("renders structural skeleton rows while loading", () => {
    const html = renderDashboardV4({ data: null, loading: true });

    expect(html).toContain("v4-skeleton-row");
    expect(html).toContain("v4-skeleton-avatar");
    expect(html).toContain("v4-skeleton-chip");
    expect(html).not.toContain("Loading");
    expect(html).not.toContain("spinner");
  });
});
