import { describe, expect, it } from "vitest";
import { deriveJobCta } from "./useApplicationGates.js";

function application(overrides = {}) {
  return {
    source: "application",
    status: "reviewed-hold",
    terminal: false,
    drawer: { artifacts: [] },
    ...overrides,
  };
}

describe("deriveJobCta", () => {
  it("returns Evaluate before a gate exists", () => {
    expect(deriveJobCta(application(), null)).toEqual({ label: "Evaluate", section: "evaluate" });
  });

  for (const gate of ["keep", "review"]) {
    it(`returns Generate documents for a ${gate} gate without a resume`, () => {
      expect(deriveJobCta(application(), { gate })).toEqual({
        label: "Generate documents",
        section: "documents",
      });
    });
  }

  it("returns Mark applied once a pre-applied row has a resume", () => {
    const row = application({ drawer: { artifacts: [{ kind: "Resume", note: "Ready" }] } });
    expect(deriveJobCta(row, { gate: "keep" })).toEqual({
      label: "Mark applied",
      section: "status",
    });
  });

  it("clears the CTA for applied and later statuses", () => {
    for (const status of ["applied", "screen", "interview", "offer", "accepted"]) {
      const row = application({
        status,
        drawer: { artifacts: [{ kind: "Resume", note: "Ready" }] },
      });
      expect(deriveJobCta(row, { gate: "keep" }), status).toBeNull();
    }
  });

  it("locks in the current cut-gate behavior: no next-step CTA", () => {
    expect(deriveJobCta(application(), { gate: "cut" })).toBeNull();
  });

  it("does not derive application CTAs for sourced or terminal rows", () => {
    expect(deriveJobCta(application({ source: "sourced" }), null)).toBeNull();
    expect(deriveJobCta(application({ terminal: true }), null)).toBeNull();
  });
});
