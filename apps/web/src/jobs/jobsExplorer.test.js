import { describe, expect, it } from "vitest";
import {
  DEFAULT_EXPLORER_STATE,
  railActionToFilters,
  rowMatchesFilters,
  rowMatchesStage,
  sanitizeExplorerState,
  sortRows,
  sortValue,
  stageLabelFor,
  stageOrder,
} from "./jobsExplorer.js";

function job(patch = {}) {
  return {
    id: "job-1",
    source: "application",
    company: "Northstar Systems",
    role: "Applied AI Engineer",
    stage: "applied",
    stageLabel: "Applied",
    sourceBucket: "src-cold",
    channel: "board",
    mode: "hybrid",
    fit: 78,
    baseK: 210,
    compMidpointK: 220,
    terminal: false,
    roundsReached: 0,
    needsReview: false,
    needsAction: false,
    stale: false,
    ghosted: false,
    missingComp: false,
    highFit: false,
    interviewPath: false,
    actionState: "active",
    workstream: "watch",
    appliedAt: "2026-07-02",
    appliedLabel: "Jul 2",
    searchText: "northstar systems applied ai engineer hybrid board",
    ...patch,
  };
}

describe("jobsExplorer stage predicates", () => {
  it("matches awaiting, heardback, terminal, stale, ghosted, and round filters", () => {
    expect(rowMatchesStage(job({ stage: "applied" }), "awaiting")).toBe(true);
    expect(rowMatchesStage(job({ stage: "screen" }), "awaiting")).toBe(false);
    expect(rowMatchesStage(job({ stage: "technical" }), "heardback")).toBe(true);
    expect(rowMatchesStage(job({ stage: "rejected", terminal: true }), "heardback")).toBe(true);
    expect(rowMatchesStage(job({ stage: "rejected", terminal: true }), "terminal")).toBe(true);
    expect(rowMatchesStage(job({ stale: true }), "stale")).toBe(true);
    expect(rowMatchesStage(job({ ghosted: true }), "ghosted")).toBe(true);
    expect(rowMatchesStage(job({ roundsReached: 2, terminal: true }), "round-2")).toBe(true);
    expect(rowMatchesStage(job({ roundsReached: 1 }), "round-2")).toBe(false);
  });

  it("matches source buckets and cumulative named stages from server fields", () => {
    expect(rowMatchesStage(job({ sourceBucket: "src-recruiter" }), "src-recruiter")).toBe(true);
    expect(rowMatchesStage(job({ stage: "onsite" }), "technical")).toBe(true);
    expect(rowMatchesStage(job({ stage: "screen" }), "technical")).toBe(false);
    expect(rowMatchesStage(job({ source: "sourced", sourceBucket: "src-cold" }), "src-cold")).toBe(
      false
    );
  });
});

describe("jobsExplorer full filtering", () => {
  it("filters by query, mode, source, min comp, min fit, and reviewOnly", () => {
    const row = job({ needsReview: true, fit: 84, baseK: 230 });

    expect(
      rowMatchesFilters(row, {
        query: "applied ai",
        mode: "hybrid",
        source: "board",
        minComp: "225",
        minFit: "80",
        reviewOnly: true,
      })
    ).toBe(true);
    expect(rowMatchesFilters(row, { query: "platform" })).toBe(false);
    expect(rowMatchesFilters(row, { mode: "remote" })).toBe(false);
    expect(rowMatchesFilters(row, { source: "recruiter" })).toBe(false);
    expect(rowMatchesFilters(row, { minComp: "240" })).toBe(false);
    expect(rowMatchesFilters(row, { minFit: "90" })).toBe(false);
    expect(rowMatchesFilters(job({ needsReview: false }), { reviewOnly: true })).toBe(false);
  });

  it("filters by server-derived action flags and workstream state", () => {
    expect(rowMatchesFilters(job({ highFit: true }), { action: "high-fit" })).toBe(true);
    expect(rowMatchesFilters(job({ needsReview: true }), { action: "review" })).toBe(true);
    expect(rowMatchesFilters(job({ interviewPath: true }), { action: "interview" })).toBe(true);
    expect(
      rowMatchesFilters(job({ actionState: "needs-action" }), { action: "needs-action" })
    ).toBe(true);
    expect(rowMatchesFilters(job({ workstream: "stale" }), { action: "stale" })).toBe(true);
    expect(rowMatchesFilters(job({ highFit: false }), { action: "high-fit" })).toBe(false);
  });

  it("honors terminal and decay visibility controls", () => {
    expect(rowMatchesFilters(job({ terminal: true, stage: "rejected" }), { stage: "all" })).toBe(
      false
    );
    expect(
      rowMatchesFilters(job({ terminal: true, stage: "rejected" }), {
        stage: "all",
        showTerminal: true,
      })
    ).toBe(true);
    expect(rowMatchesFilters(job({ ghosted: true }), { stage: "all" })).toBe(false);
    expect(rowMatchesFilters(job({ ghosted: true }), { stage: "all", showGhosted: true })).toBe(
      true
    );
    expect(rowMatchesFilters(job({ stale: true }), { stage: "all", hideStale: true })).toBe(false);
    expect(rowMatchesFilters(job({ stale: true }), { stage: "stale", hideStale: true })).toBe(true);
  });
});

describe("jobsExplorer sorting and labels", () => {
  it("returns original stage and action ordering values", () => {
    expect(stageOrder("technical")).toBe(2.5);
    expect(sortValue(job({ actionState: "needs-action" }), "action")).toBe(0);
    expect(sortValue(job({ stage: "hiring-manager" }), "stage")).toBe(2.7);
    expect(sortValue(job({ baseK: null, compMidpointK: 245 }), "base")).toBe(245);
  });

  it("sorts rows for each supported key and direction", () => {
    const rows = [
      job({
        id: "b",
        company: "Zephyr",
        role: "Platform",
        fit: 70,
        baseK: 210,
        mode: "remote",
        stage: "screen",
        actionState: "active",
        appliedAt: "2026-07-03",
      }),
      job({
        id: "a",
        company: "Acme",
        role: "AI",
        fit: 95,
        baseK: 250,
        mode: "hybrid",
        stage: "technical",
        actionState: "needs-action",
        appliedAt: "2026-07-01",
      }),
    ];

    for (const key of ["action", "company", "role", "base", "mode", "fit", "stage", "applied"]) {
      expect(sortRows(rows, key, 1)).toHaveLength(2);
      expect(sortRows(rows, key, -1)).toHaveLength(2);
    }
    expect(sortRows(rows, "company", 1).map((row) => row.id)).toEqual(["a", "b"]);
    expect(sortRows(rows, "fit", -1).map((row) => row.id)).toEqual(["a", "b"]);
    expect(sortRows(rows, "action", 1).map((row) => row.id)).toEqual(["a", "b"]);
  });

  it("labels stages from sankey filters before falling back to title case", () => {
    const sankey = { nodes: [{ id: "n1", label: "Recruiter", filter: "src-recruiter" }] };

    expect(stageLabelFor("all", sankey)).toBe("All Active");
    expect(stageLabelFor("terminal", sankey)).toBe("Rejected / withdrawn");
    expect(stageLabelFor("src-recruiter", sankey)).toBe("Recruiter");
    expect(stageLabelFor("hiring-manager", sankey)).toBe("Hiring Manager");
  });
});

describe("jobsExplorer state helpers", () => {
  it("maps next-decision rail actions to explorer presets", () => {
    expect(railActionToFilters("manual-review")).toMatchObject({
      action: "review",
      reviewOnly: true,
      sortKey: "fit",
      sortDir: -1,
      view: "table",
    });
    expect(railActionToFilters("high-fit")).toMatchObject({ action: "high-fit", minFit: "80" });
    expect(railActionToFilters("interview-path")).toMatchObject({
      action: "interview",
      stage: "interview",
      sortKey: "stage",
    });
    expect(railActionToFilters("terminal")).toMatchObject({
      stage: "terminal",
      sortKey: "applied",
    });
  });

  it("sanitizes persisted explorer state and clamps garbage", () => {
    expect(
      sanitizeExplorerState({
        stage: "",
        query: "  Applied AI  ",
        view: "grid",
        showTerminal: true,
        sortKey: "salary",
        sortDir: 7,
        action: "unknown",
        mode: "space",
        source: "friend",
        minComp: "5000",
        minFit: "120",
        reviewOnly: true,
      })
    ).toEqual({
      ...DEFAULT_EXPLORER_STATE,
      query: "applied ai",
      showTerminal: true,
      minComp: "2000",
      minFit: "100",
      reviewOnly: true,
    });
  });
});
