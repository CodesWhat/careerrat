import { describe, expect, it } from "vitest";

async function loadModel() {
  return import("./browser-model.js");
}

describe("chat-first browser sort", () => {
  it("keeps the given order when no sort key is recognized", async () => {
    const { sortJobs } = await loadModel();
    const jobs = [
      { id: "a", fit: 60 },
      { id: "b", fit: 90 },
      { id: "c", fit: 75 },
    ];

    expect(sortJobs(jobs, "default")).toEqual(jobs);
    expect(sortJobs(jobs, undefined)).toEqual(jobs);
    expect(sortJobs(jobs)).toEqual(jobs);
  });

  it("sorts by fit descending", async () => {
    const { sortJobs } = await loadModel();
    const jobs = [
      { id: "a", fit: 60 },
      { id: "b", fit: 90 },
      { id: "c", fit: 75 },
    ];

    expect(sortJobs(jobs, "fit").map((job) => job.id)).toEqual(["b", "c", "a"]);
  });

  it("sorts by posted date, newest first, pushing unknown dates last", async () => {
    const { sortJobs } = await loadModel();
    const jobs = [
      { id: "a", postedAt: "2026-08-01T00:00:00Z" },
      { id: "b", postedAt: "2026-09-01T00:00:00Z" },
      { id: "c", postedAt: "" },
      { id: "d", datePosted: "2026-08-20T00:00:00Z" },
    ];

    expect(sortJobs(jobs, "posted").map((job) => job.id)).toEqual(["b", "d", "a", "c"]);
  });

  it("sorts by last-updated timestamp, newest first, using the best available field", async () => {
    const { sortJobs } = await loadModel();
    const jobs = [
      { id: "applied-old", appliedAt: "2026-07-01T00:00:00Z" },
      { id: "applied-new", appliedAt: "2026-09-01T00:00:00Z" },
      { id: "sourced-only", sourcedAt: "2026-08-15T00:00:00Z" },
      { id: "posted-only", postedAt: "2026-08-10T00:00:00Z" },
      { id: "unknown" },
    ];

    expect(sortJobs(jobs, "updated").map((job) => job.id)).toEqual([
      "applied-new",
      "sourced-only",
      "posted-only",
      "applied-old",
      "unknown",
    ]);
  });

  it("does not mutate the input array", async () => {
    const { sortJobs } = await loadModel();
    const jobs = [
      { id: "a", fit: 60 },
      { id: "b", fit: 90 },
    ];
    const original = [...jobs];

    sortJobs(jobs, "fit");

    expect(jobs).toEqual(original);
  });

  it("labels a triage guess with a tilde and an evaluated fit without one", async () => {
    const { fitDisplayLabel } = await loadModel();

    expect(fitDisplayLabel({ fit: 72, fitBasis: "triage" })).toBe("~72");
    expect(fitDisplayLabel({ fit: 72, fitBasis: "evaluated" })).toBe("72");
    expect(fitDisplayLabel({ fit: 72 })).toBe("72");
    expect(fitDisplayLabel({})).toBe("0");
  });
});
