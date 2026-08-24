// apps/web/src/onboarding/onboardingSetup.test.js
// vitest coverage for the W4 chat-first onboarding surface's pure view-model
// helpers (commit c1d601e3). No React, no fetch, no hook harness needed —
// every export here is a plain function of its inputs, so this file just
// calls them directly and asserts on the returned shapes.

import { describe, expect, it } from "vitest";
import {
  authorizationDetailLine,
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
  setupCanGraduate,
  setupCompletedCount,
  setupDisclosureRows,
  setupIsComplete,
  setupProgressFromState,
  setupTotal,
} from "./onboardingSetup.js";

describe("SETUP_ITEM_ORDER / SETUP_ITEM_LABELS", () => {
  it("has exactly the 8 setup items in the documented order (Lane A adds authorization; consent was removed from the checklist)", () => {
    expect(SETUP_ITEM_ORDER).toEqual([
      "engine",
      "resume",
      "roles",
      "companies",
      "evidence",
      "guardrails",
      "quickFacts",
      "authorization",
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
    expect(items).toHaveLength(8);
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

  it("reads completedCount from progress and completion from progress plus readiness", () => {
    const state = { setupProgress: { completedCount: 5, complete: false } };
    expect(setupCompletedCount(state)).toBe(5);
    expect(setupIsComplete(state)).toBe(false);

    const done = {
      setupProgress: { completedCount: 7, complete: true },
      data: { setup: { readiness: { search_ready: true } } },
    };
    expect(setupCompletedCount(done)).toBe(7);
    expect(setupIsComplete(done)).toBe(true);
  });

  it("setupIsComplete requires complete to be strictly true", () => {
    expect(setupIsComplete({ setupProgress: { complete: "true" } })).toBe(false);
    expect(setupIsComplete({ setupProgress: { complete: 1 } })).toBe(false);
  });

  it("does not graduate onboarding until canonical candidate readiness is search-ready", () => {
    expect(
      setupIsComplete({
        setupProgress: { complete: true },
        data: { setup: { readiness: { search_ready: false } } },
      })
    ).toBe(false);
    expect(
      setupIsComplete({
        setupProgress: { complete: true },
        data: { setup: { readiness: { search_ready: true } } },
      })
    ).toBe(true);
  });
});

describe("setupCanGraduate", () => {
  const completedCandidate = {
    setupProgress: { complete: true },
    data: { setup: { readiness: { search_ready: true } } },
  };

  it("keeps a completed candidate in onboarding until usable sources and a first run exist", () => {
    expect(setupCanGraduate(completedCandidate)).toBe(false);
    expect(
      setupCanGraduate({
        ...completedCandidate,
        data: {
          ...completedCandidate.data,
          sourcing: {
            sourceSetup: { deterministicSources: { attempted: 2 } },
            firstSearchRun: { status: "not_started", run: null },
          },
        },
      })
    ).toBe(false);
  });

  it.each(["running", "completed"])(
    "graduates once sources exist and the first search is %s",
    (status) => {
      expect(
        setupCanGraduate({
          ...completedCandidate,
          data: {
            ...completedCandidate.data,
            sourcing: {
              sourceSetup: { deterministicSources: { attempted: 2 } },
              firstSearchRun: { status, run: { status } },
            },
          },
        })
      ).toBe(true);
    }
  );

  it("does not graduate a failed or explicitly paused search setup", () => {
    for (const status of ["failed", "paused"]) {
      expect(
        setupCanGraduate({
          ...completedCandidate,
          deterministicSources: { attempted: 1 },
          sourcing: { firstSearchRun: { run: { status } } },
        })
      ).toBe(false);
    }
  });
});

describe("setupTotal", () => {
  it("reads state.setupProgress.total when present", () => {
    expect(setupTotal({ setupProgress: { total: 9 } })).toBe(9);
  });

  it("falls back to SETUP_ITEM_ORDER.length when total is absent", () => {
    expect(setupTotal(undefined)).toBe(SETUP_ITEM_ORDER.length);
    expect(setupTotal({})).toBe(SETUP_ITEM_ORDER.length);
    expect(setupTotal({ setupProgress: {} })).toBe(SETUP_ITEM_ORDER.length);
  });
});

describe("setupDisclosureRows", () => {
  it("does not present the ambient remote search fallback as a confirmed preference", () => {
    const rows = setupDisclosureRows({
      state: {
        files: [{ name: "profile", exists: true }],
        setupProgress: { items: [{ key: "quickFacts", done: false }] },
        data: {
          profile: {
            candidate: { full_name: "Morgan Hale" },
            location: { home: "", remote: true, hybrid: false, onsite: false },
            compensation: { minimum_base: null },
          },
        },
      },
    });

    expect(rows.find((row) => row.key === "quickFacts").value).toBe("Morgan Hale");
  });

  it("shows the actual saved setup instead of eight done/not-set labels", () => {
    const state = {
      sourceResumePresent: true,
      data: {
        profile: {
          candidate: {
            full_name: "Jamie Rivera",
            email: "jamie@example.com",
            phone: "555-0100",
            location: "Baltimore, MD",
          },
          location: { remote: true },
          compensation: { minimum_base: 180000 },
          authorization: { work_authorized: true, requires_sponsorship: false },
        },
        targeting: {
          role_buckets: [{ titles: ["Applied AI Engineer", "Forward Deployed Engineer"] }],
          company_preferences: {
            confirmed: true,
            industries: ["fintech"],
            business_models: ["fintech"],
            sizes: ["large corporations"],
            examples: ["Anthropic", "OpenAI"],
          },
          cut_signals: ["Below $180K", "Five days on-site"],
        },
        evidence: {
          claims: [
            { claim: "Shipped an agent pipeline" },
            { claim: "Led an identity platform migration" },
          ],
        },
      },
    };

    expect(setupDisclosureRows({ state, runtime: { name: "Orca CLI" } })).toEqual([
      { key: "engine", label: "Engine", value: "Orca CLI" },
      { key: "resume", label: "Resume", value: "Uploaded · 2 evidence claims" },
      {
        key: "roles",
        label: "Roles",
        value: "Applied AI Engineer, Forward Deployed Engineer",
      },
      {
        key: "companies",
        label: "Company focus",
        value: "fintech · large corporations · Examples: Anthropic, OpenAI",
      },
      {
        key: "evidence",
        label: "Evidence",
        value: "2 claims · Shipped an agent pipeline · Led an identity platform migration",
      },
      {
        key: "guardrails",
        label: "Guardrails",
        value: "Below $180K · Five days on-site",
      },
      {
        key: "quickFacts",
        label: "Quick facts",
        value:
          "Jamie Rivera · jamie@example.com · 555-0100 · Baltimore, MD · Remote · $180,000 minimum base",
      },
      { key: "authorization", label: "Work authorization", value: "Authorized" },
    ]);
  });

  it("does not invent a broad-discovery state when no focus examples were named", () => {
    const state = {
      files: [{ name: "targeting", exists: true }],
      data: { targeting: { company_preferences: { confirmed: true } } },
    };
    const rows = setupDisclosureRows({
      state,
    });
    expect(rows.find((row) => row.key === "companies").value).toBe("No narrow focus");
    expect(companiesDetailLine({ state })).toBe("Broad discovery · no narrow focus");
  });

  it("does not infer broad discovery from tracked company sources", () => {
    const state = {
      data: {
        targeting: { tracked_companies: ["Acme"] },
      },
    };

    expect(setupDisclosureRows({ state }).find((row) => row.key === "companies").value).toBe(
      "Tracked sources: Acme"
    );
  });

  it("uses honest fallback copy for values that were declined or not provided", () => {
    const rows = setupDisclosureRows({
      state: {
        data: {
          "form-defaults": {
            declined_fields: {
              resume: { declined_at: "2026-08-13T00:00:00Z" },
              authorization: { declined_at: "2026-08-13T00:00:00Z" },
            },
          },
        },
      },
    });
    expect(rows.find((row) => row.key === "resume").value).toBe("Built from your answers");
    expect(rows.find((row) => row.key === "authorization").value).toBe("Declined");
    expect(rows.find((row) => row.key === "roles").value).toBe("Not provided");
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

  it("says the history was built from answers once 'I don't have a résumé' is recorded", () => {
    expect(
      resumeDetailLine({
        state: {
          sourceResumePresent: false,
          data: {
            "form-defaults": {
              declined_fields: { resume: { declined_at: "2026-08-10T12:00:00Z" } },
            },
          },
        },
      })
    ).toBe("Built from your answers");
  });

  it("Bug 4: suppresses 'Built from your answers' when form-defaults.yml hasn't actually been written", () => {
    expect(
      resumeDetailLine({
        state: {
          sourceResumePresent: false,
          files: [{ name: "form-defaults", exists: false }],
          data: {
            "form-defaults": {
              declined_fields: { resume: { declined_at: "2026-08-10T12:00:00Z" } },
            },
          },
        },
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

  it("Bug 4: returns null when state.files marks targeting.yml as not existing, even with role data present", () => {
    expect(
      rolesDetailLine({
        state: {
          files: [{ name: "targeting", exists: false }],
          data: { targeting: { role_buckets: [{ titles: ["A"] }] } },
        },
      })
    ).toBeNull();
  });
});

describe("companiesDetailLine", () => {
  it("returns null with no tracked sources, else makes their scope explicit", () => {
    expect(companiesDetailLine({ state: {} })).toBeNull();
    expect(
      companiesDetailLine({ state: { data: { targeting: { tracked_companies: ["Stripe"] } } } })
    ).toBe("1 tracked source · broad discovery on");
  });

  it("Bug 4: returns null when state.files marks targeting.yml as not existing", () => {
    expect(
      companiesDetailLine({
        state: {
          files: [{ name: "targeting", exists: false }],
          data: { targeting: { tracked_companies: ["Stripe"] } },
        },
      })
    ).toBeNull();
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

  it("Bug 4: returns null when state.files marks evidence.yml as not existing", () => {
    expect(
      evidenceDetailLine({
        state: {
          files: [{ name: "evidence", exists: false }],
          data: { evidence: { claims: [1, 2] } },
        },
      })
    ).toBeNull();
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

  it("Bug 4: returns null when state.files marks targeting.yml as not existing", () => {
    expect(
      guardrailsDetailLine({
        state: {
          files: [{ name: "targeting", exists: false }],
          data: { targeting: { cut_signals: ["Below $200K"] } },
        },
      })
    ).toBeNull();
  });
});

describe("quickFactsDetailLine", () => {
  it("does not expose the ambient remote fallback after an unrelated profile field is saved", () => {
    expect(
      quickFactsDetailLine({
        state: {
          files: [{ name: "profile", exists: true }],
          setupProgress: { items: [{ key: "quickFacts", done: false }] },
          data: {
            profile: {
              candidate: { full_name: "Morgan Hale" },
              location: { remote: true },
            },
          },
        },
      })
    ).toBeNull();
  });

  it("returns null when no location mode is set", () => {
    expect(quickFactsDetailLine({ state: {} })).toBeNull();
    expect(quickFactsDetailLine({ state: { data: { profile: { location: {} } } } })).toBeNull();
  });

  it("shows location modes with the missing or saved minimum base", () => {
    expect(
      quickFactsDetailLine({
        state: { data: { profile: { location: { remote: true, onsite: true } } } },
      })
    ).toBe("Remote · On-site · Add minimum base");
    expect(
      quickFactsDetailLine({
        state: {
          data: {
            profile: {
              location: { remote: true, hybrid: true, onsite: true },
              compensation: { minimum_base: 180000 },
            },
          },
        },
      })
    ).toBe("Remote · Hybrid · On-site · $180K floor");
    expect(
      quickFactsDetailLine({
        state: {
          data: {
            profile: {
              location: { remote: true, hybrid: true },
              compensation: { comp_floors: { remote: 175000, hybrid: 190000 } },
            },
          },
        },
      })
    ).toBe("Remote $175K floor · Hybrid $190K floor");
  });

  it("Bug 4: returns null when state.files marks profile.yml as not existing", () => {
    expect(
      quickFactsDetailLine({
        state: {
          files: [{ name: "profile", exists: false }],
          data: { profile: { location: { remote: true } } },
        },
      })
    ).toBeNull();
  });
});

describe("authorizationDetailLine", () => {
  it("returns null with no authorization answered and no decline", () => {
    expect(authorizationDetailLine({ state: {} })).toBeNull();
    expect(
      authorizationDetailLine({
        state: { data: { profile: { authorization: { work_authorized: false } } } },
      })
    ).toBeNull();
  });

  it("returns 'Declined' when declined_fields.authorization is recorded, regardless of the answer", () => {
    expect(
      authorizationDetailLine({
        state: { data: { "form-defaults": { declined_fields: { authorization: {} } } } },
      })
    ).toBe("Declined");
  });

  it("returns 'Authorized' or 'Needs sponsorship' from the profile answer", () => {
    expect(
      authorizationDetailLine({
        state: { data: { profile: { authorization: { work_authorized: true } } } },
      })
    ).toBe("Authorized");
    expect(
      authorizationDetailLine({
        state: { data: { profile: { authorization: { requires_sponsorship: true } } } },
      })
    ).toBe("Needs sponsorship");
  });

  it("Bug 4: suppresses 'Authorized'/'Needs sponsorship' when profile.yml doesn't exist", () => {
    expect(
      authorizationDetailLine({
        state: {
          files: [{ name: "profile", exists: false }],
          data: { profile: { authorization: { work_authorized: true } } },
        },
      })
    ).toBeNull();
  });

  it("Bug 4: suppresses 'Declined' when form-defaults.yml doesn't exist, even with a decline in the data", () => {
    expect(
      authorizationDetailLine({
        state: {
          files: [{ name: "form-defaults", exists: false }],
          data: { "form-defaults": { declined_fields: { authorization: {} } } },
        },
      })
    ).toBeNull();
  });
});

describe("detailLineFor", () => {
  it("dispatches to the matching builder by key", () => {
    expect(
      detailLineFor("companies", { state: { data: { targeting: { tracked_companies: ["A"] } } } })
    ).toBe("1 tracked source · broad discovery on");
  });

  it("returns null for an unknown key rather than throwing", () => {
    expect(detailLineFor("not-a-real-key", { state: {} })).toBeNull();
  });
});
