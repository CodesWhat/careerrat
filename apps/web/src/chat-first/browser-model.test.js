import { describe, expect, it } from "vitest";

async function loadModel() {
  return import("./browser-model.js");
}

describe("chat-first browser model", () => {
  it("normalizes externally-owned selection without losing its order", async () => {
    const { selectedJobs } = await loadModel();
    const jobs = [
      { id: "tyrell", company: "Tyrell", fit: 88 },
      { id: "aperture", company: "Aperture", fit: 84 },
      { id: "initech", company: "Initech", fit: 81 },
    ];

    expect(selectedJobs(jobs, new Set(["initech", "tyrell"]))).toEqual([jobs[0], jobs[2]]);
  });

  it("builds cart copy from the controlled selection", async () => {
    const { buildCartView } = await loadModel();
    const one = buildCartView([{ id: "tyrell", company: "Tyrell", fit: 88 }]);
    const many = buildCartView([
      { id: "tyrell", fit: 88, evaluationRequired: false, compStatus: "comp ✓" },
      { id: "aperture", fit: 84, evaluationRequired: true, compStatus: "comp pending" },
    ]);

    expect(one).toMatchObject({
      title: "SELECTED · 1",
      applyLabel: "Apply to 1 job",
    });
    expect(many).toMatchObject({
      title: "CART · 2 JOBS",
      averageFit: 86,
      evaluationCount: 1,
      compPendingCount: 1,
      applyLabel: "Apply to 2 jobs",
    });
  });

  it("keeps fit bars inside the handoff scale", async () => {
    const { fitBarWidth } = await loadModel();

    expect(fitBarWidth(42)).toBe(0);
    expect(fitBarWidth(80)).toBe(50);
    expect(fitBarWidth(88)).toBe(70);
    expect(fitBarWidth(110)).toBe(100);
  });

  it("scales pipeline bars from the largest real count", async () => {
    const { pipelineRowsWithWidths } = await loadModel();
    const rows = pipelineRowsWithWidths([
      { id: "applied", label: "Applied", count: 29 },
      { id: "heard-back", label: "Heard back", count: 10 },
      { id: "offer", label: "Offer", count: 2, highlight: true },
    ]);

    expect(rows.map(({ width }) => width)).toEqual([100, 34, 7]);
  });

  it("applies supported search, file, and people filters without hiding unrelated cart state", async () => {
    const { filterFiles, filterPeople, filterSearchJobs } = await loadModel();
    const jobs = [
      {
        id: "a",
        company: "Remote Co",
        role: "Staff",
        fit: 88,
        compStatus: "comp ✓",
        mode: "remote",
        stage: "Sourced",
        sourceLabel: "Greenhouse",
        postedAt: "2026-08-22T12:00:00Z",
      },
      {
        id: "b",
        company: "Office Co",
        role: "Lead",
        fit: 78,
        compStatus: "comp pending",
        mode: "hybrid",
        stage: "Review hold",
        sourceLabel: "Lever",
        postedAt: "2026-07-01T12:00:00Z",
      },
    ];

    expect(
      filterSearchJobs(jobs, {
        query: "remote",
        fit80: true,
        fitFloor: 65,
        comp: true,
        remote: true,
      }).map((job) => job.id)
    ).toEqual(["a"]);
    expect(filterSearchJobs(jobs, { fit80: true, fitFloor: 65 }).map((job) => job.id)).toEqual([
      "a",
      "b",
    ]);
    expect(filterSearchJobs(jobs, { fit80: true }).map((job) => job.id)).toEqual(["a", "b"]);
    expect(
      filterSearchJobs(
        jobs,
        { stage: "sourced", source: "greenhouse", posted: "7d" },
        new Date("2026-08-24T12:00:00Z")
      ).map((job) => job.id)
    ).toEqual(["a"]);
    expect(
      filterFiles(
        [
          { id: "r", kind: "Resume" },
          { id: "d", kind: "Interview dossier" },
          { id: "e", kind: "Evidence" },
        ],
        "Job ▾"
      ).map((file) => file.id)
    ).toEqual(["d"]);
    expect(
      filterPeople(
        [
          { id: "due", needsTouch: true },
          { id: "clear", needsTouch: false },
        ],
        "needs-touch"
      ).map((person) => person.id)
    ).toEqual(["due"]);
  });
});
