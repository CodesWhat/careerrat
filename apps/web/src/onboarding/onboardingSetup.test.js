// apps/web/src/onboarding/onboardingSetup.test.js
// vitest coverage for the W4 chat-first onboarding surface's pure view-model
// helpers (commit c1d601e3). No React, no fetch, no hook harness needed —
// every export here is a plain function of its inputs, so this file just
// calls them directly and asserts on the returned shapes.

import { describe, expect, it } from "vitest";
import {
  buildSetupItemViewModels,
  companiesDetailLine,
  detailLineFor,
  engineDetailLine,
  evidenceDetailLine,
  guardrailsDetailLine,
  quickFactsDetailLine,
  resumeDetailLine,
  rolesDetailLine,
  SETUP_ITEM_LABELS,
  SETUP_ITEM_ORDER,
  setupCompletedCount,
  setupIsComplete,
  setupProgressFromState,
} from "./onboardingSetup.js";

describe("SETUP_ITEM_ORDER / SETUP_ITEM_LABELS", () => {
  it("has exactly the 7 setup items in the documented order", () => {
    expect(SETUP_ITEM_ORDER).toEqual([
      "engine",
      "resume",
      "roles",
      "companies",
      "evidence",
      "guardrails",
      "quickFacts",
    ]);
  });

  it("has a label for every item", () => {
    for (const key of SETUP_ITEM_ORDER) {
      expect(typeof SETUP_ITEM_LABELS[key]).toBe("string");
      expect(SETUP_ITEM_LABELS[key].length).toBeGreaterThan(0);
    }
  });
});

describe("buildSetupItemViewModels", () => {
  it("marks every item not-done, and the FIRST item as UP NEXT, when doneByKey is empty", () => {
    const items = buildSetupItemViewModels({});
    expect(items).toHaveLength(7);
    expect(items.every((item) => item.done === false)).toBe(true);
    expect(items[0].key).toBe("engine");
    expect(items[0].isNext).toBe(true);
    expect(items.filter((item) => item.isNext)).toHaveLength(1);
  });

  it("marks only the first NOT-done item after a run of done items as UP NEXT", () => {
    const items = buildSetupItemViewModels({ engine: true, resume: true, roles: false });
    const roles = items.find((item) => item.key === "roles");
    const companies = items.find((item) => item.key === "companies");
    expect(roles.isNext).toBe(true);
    expect(companies.isNext).toBe(false);
    expect(items.filter((item) => item.isNext)).toHaveLength(1);
  });

  it("assigns no UP NEXT item once every item is done", () => {
    const allDone = Object.fromEntries(SETUP_ITEM_ORDER.map((key) => [key, true]));
    const items = buildSetupItemViewModels(allDone);
    expect(items.every((item) => item.done === true)).toBe(true);
    expect(items.some((item) => item.isNext)).toBe(false);
  });

  it("carries the label and chipLabel through for every row", () => {
    const items = buildSetupItemViewModels({});
    const roles = items.find((item) => item.key === "roles");
    expect(roles.label).toBe("Roles");
    expect(roles.chipLabel).toBe("ROLES");
  });
});

describe("setupProgressFromState", () => {
  it("derives a done-by-key map from state.setupProgress.items", () => {
    const state = {
      setupProgress: {
        items: [
          { key: "engine", done: true },
          { key: "resume", done: false },
        ],
      },
    };
    expect(setupProgressFromState(state)).toEqual({ engine: true, resume: false });
  });

  it("returns an empty object when setupProgress.items is missing or not an array", () => {
    expect(setupProgressFromState(undefined)).toEqual({});
    expect(setupProgressFromState({})).toEqual({});
    expect(setupProgressFromState({ setupProgress: {} })).toEqual({});
    expect(setupProgressFromState({ setupProgress: { items: "not-an-array" } })).toEqual({});
  });

  it("coerces a non-boolean done value to a strict boolean", () => {
    const state = { setupProgress: { items: [{ key: "engine", done: 1 }] } };
    expect(setupProgressFromState(state)).toEqual({ engine: true });
  });
});

describe("setupCompletedCount / setupIsComplete", () => {
  it("defaults to 0 / false when setupProgress is absent", () => {
    expect(setupCompletedCount(undefined)).toBe(0);
    expect(setupCompletedCount({})).toBe(0);
    expect(setupIsComplete(undefined)).toBe(false);
    expect(setupIsComplete({})).toBe(false);
  });

  it("reads completedCount and complete straight off state.setupProgress", () => {
    const state = { setupProgress: { completedCount: 5, complete: false } };
    expect(setupCompletedCount(state)).toBe(5);
    expect(setupIsComplete(state)).toBe(false);

    const done = { setupProgress: { completedCount: 7, complete: true } };
    expect(setupCompletedCount(done)).toBe(7);
    expect(setupIsComplete(done)).toBe(true);
  });

  it("setupIsComplete requires complete to be strictly true", () => {
    expect(setupIsComplete({ setupProgress: { complete: "true" } })).toBe(false);
    expect(setupIsComplete({ setupProgress: { complete: 1 } })).toBe(false);
  });
});

describe("engineDetailLine", () => {
  it("returns null when there is no runtime", () => {
    expect(engineDetailLine({})).toBeNull();
    expect(engineDetailLine()).toBeNull();
  });

  it("renders '<name> · launch probe' for a registry runtime", () => {
    expect(engineDetailLine({ runtime: { id: "claude", name: "Claude Code" } })).toBe(
      "Claude Code · launch probe"
    );
  });

  it("renders the raw command shape for the custom runtime, or null without one", () => {
    expect(
      engineDetailLine({ runtime: { id: "custom", commandShape: "~/bin/my-agent --chat" } })
    ).toBe("~/bin/my-agent --chat");
    expect(engineDetailLine({ runtime: { id: "custom", commandShape: null } })).toBeNull();
  });
});

describe("resumeDetailLine", () => {
  it("returns null when no source résumé is present, regardless of claim count", () => {
    expect(
      resumeDetailLine({
        state: { sourceResumePresent: false, data: { evidence: { claims: [1] } } },
      })
    ).toBeNull();
  });

  it("returns 'Uploaded' when present with zero claims", () => {
    expect(resumeDetailLine({ state: { sourceResumePresent: true, data: {} } })).toBe("Uploaded");
  });

  it("pluralizes the claim count when present", () => {
    expect(
      resumeDetailLine({
        state: { sourceResumePresent: true, data: { evidence: { claims: [1] } } },
      })
    ).toBe("1 claim extracted");
    expect(
      resumeDetailLine({
        state: { sourceResumePresent: true, data: { evidence: { claims: [1, 2, 3] } } },
      })
    ).toBe("3 claims extracted");
  });
});

describe("rolesDetailLine", () => {
  it("returns null with no role buckets", () => {
    expect(rolesDetailLine({ state: { data: { targeting: { role_buckets: [] } } } })).toBeNull();
    expect(rolesDetailLine({ state: {} })).toBeNull();
  });

  it("counts buckets and total titles across all buckets, singular/plural correctly", () => {
    const state = {
      data: {
        targeting: {
          role_buckets: [{ titles: ["A", "B"] }, { titles: ["C"] }],
        },
      },
    };
    expect(rolesDetailLine({ state })).toBe("2 buckets · 3 titles");

    const singleState = { data: { targeting: { role_buckets: [{ titles: ["A"] }] } } };
    expect(rolesDetailLine({ state: singleState })).toBe("1 bucket · 1 title");
  });
});

describe("companiesDetailLine", () => {
  it("returns null with no tracked companies, else '<n> tracked'", () => {
    expect(companiesDetailLine({ state: {} })).toBeNull();
    expect(
      companiesDetailLine({ state: { data: { targeting: { tracked_companies: ["Stripe"] } } } })
    ).toBe("1 tracked");
  });
});

describe("evidenceDetailLine", () => {
  it("returns null with no claims, else pluralized '<n> claim(s) kept'", () => {
    expect(evidenceDetailLine({ state: {} })).toBeNull();
    expect(evidenceDetailLine({ state: { data: { evidence: { claims: [1] } } } })).toBe(
      "1 claim kept"
    );
    expect(evidenceDetailLine({ state: { data: { evidence: { claims: [1, 2] } } } })).toBe(
      "2 claims kept"
    );
  });
});

describe("guardrailsDetailLine", () => {
  it("returns null with no cut signals, else pluralized '<n> dealbreaker(s)'", () => {
    expect(guardrailsDetailLine({ state: {} })).toBeNull();
    expect(
      guardrailsDetailLine({ state: { data: { targeting: { cut_signals: ["Below $200K"] } } } })
    ).toBe("1 dealbreaker");
    expect(
      guardrailsDetailLine({
        state: { data: { targeting: { cut_signals: ["Below $200K", "No remote"] } } },
      })
    ).toBe("2 dealbreakers");
  });
});

describe("quickFactsDetailLine", () => {
  it("returns null when no location mode is set", () => {
    expect(quickFactsDetailLine({ state: {} })).toBeNull();
    expect(quickFactsDetailLine({ state: { data: { profile: { location: {} } } } })).toBeNull();
  });

  it("joins whichever modes are set, in Remote/Hybrid/On-site order", () => {
    expect(
      quickFactsDetailLine({
        state: { data: { profile: { location: { remote: true, onsite: true } } } },
      })
    ).toBe("Remote · On-site");
    expect(
      quickFactsDetailLine({
        state: { data: { profile: { location: { remote: true, hybrid: true, onsite: true } } } },
      })
    ).toBe("Remote · Hybrid · On-site");
  });
});

describe("detailLineFor", () => {
  it("dispatches to the matching builder by key", () => {
    expect(
      detailLineFor("companies", { state: { data: { targeting: { tracked_companies: ["A"] } } } })
    ).toBe("1 tracked");
  });

  it("returns null for an unknown key rather than throwing", () => {
    expect(detailLineFor("not-a-real-key", { state: {} })).toBeNull();
  });
});
