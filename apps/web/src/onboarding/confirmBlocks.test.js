// apps/web/src/onboarding/confirmBlocks.test.js
// vitest coverage for the Lane A confirm-fence parser. Pure function, no
// React/fetch — mirrors the fence syntax and closed kind enum
// src/core/ai/skill-runtime.mjs's CONFIRM_BLOCK_GUIDANCE documents to the
// model (see tests/skill-runtime.test.mjs on the server side for that
// contract's own coverage).

import { describe, expect, it } from "vitest";
import { CONFIRM_KINDS, parseConfirmBlocks, SINGLE_CLICK_KINDS } from "./confirmBlocks.js";

function fence(payload) {
  return `\`\`\`careerrat:confirm\n${JSON.stringify(payload)}\n\`\`\``;
}

describe("parseConfirmBlocks — no fence present", () => {
  it("returns the text unchanged (trimmed) and an empty blocks array", () => {
    expect(parseConfirmBlocks("  Tell me about your last role.  ")).toEqual({
      text: "Tell me about your last role.",
      blocks: [],
    });
  });

  it("handles non-string input without throwing", () => {
    expect(parseConfirmBlocks(undefined)).toEqual({ text: "", blocks: [] });
    expect(parseConfirmBlocks(null)).toEqual({ text: "", blocks: [] });
  });
});

describe("parseConfirmBlocks — authorization", () => {
  it("accepts a well-formed authorization block", () => {
    const raw = `Got it.\n\n${fence({
      kind: "authorization",
      summary: "Authorized, no sponsorship",
      patch: { work_authorized: true, requires_sponsorship: false },
    })}`;
    const { text, blocks } = parseConfirmBlocks(raw);
    expect(text).toBe("Got it.");
    expect(blocks).toEqual([
      {
        kind: "authorization",
        summary: "Authorized, no sponsorship",
        patch: { work_authorized: true, requires_sponsorship: false },
        payload: null,
      },
    ]);
  });

  it("also accepts the bare ```confirm fence syntax", () => {
    const raw = `\`\`\`confirm\n${JSON.stringify({
      kind: "authorization",
      patch: { work_authorized: true, requires_sponsorship: false },
    })}\n\`\`\``;
    expect(parseConfirmBlocks(raw).blocks).toHaveLength(1);
  });

  it("drops an authorization block missing a required patch field", () => {
    const raw = fence({ kind: "authorization", patch: { work_authorized: true } });
    expect(parseConfirmBlocks(raw).blocks).toEqual([]);
  });
});

describe("parseConfirmBlocks — consent_mode", () => {
  it("accepts payload 'basic' or 'advanced' only", () => {
    expect(
      parseConfirmBlocks(fence({ kind: "consent_mode", payload: "advanced" })).blocks
    ).toHaveLength(1);
    expect(
      parseConfirmBlocks(fence({ kind: "consent_mode", payload: "basic" })).blocks
    ).toHaveLength(1);
    expect(parseConfirmBlocks(fence({ kind: "consent_mode", payload: "yolo" })).blocks).toEqual([]);
  });
});

describe("parseConfirmBlocks — consent_capability", () => {
  it("requires non-empty string capability and platform", () => {
    const good = fence({
      kind: "consent_capability",
      payload: { capability: "messaging", platform: "linkedin" },
    });
    expect(parseConfirmBlocks(good).blocks).toHaveLength(1);

    const missingPlatform = fence({
      kind: "consent_capability",
      payload: { capability: "messaging" },
    });
    expect(parseConfirmBlocks(missingPlatform).blocks).toEqual([]);

    const blankCapability = fence({
      kind: "consent_capability",
      payload: { capability: "  ", platform: "linkedin" },
    });
    expect(parseConfirmBlocks(blankCapability).blocks).toEqual([]);
  });
});

describe("parseConfirmBlocks — companies_suggest / company_add", () => {
  it("companies_suggest needs no payload at all", () => {
    expect(parseConfirmBlocks(fence({ kind: "companies_suggest" })).blocks).toEqual([
      { kind: "companies_suggest", summary: "", patch: null, payload: null },
    ]);
  });

  it("company_add requires a non-empty payload.name", () => {
    expect(
      parseConfirmBlocks(fence({ kind: "company_add", payload: { name: "Anthropic" } })).blocks
    ).toHaveLength(1);
    expect(
      parseConfirmBlocks(fence({ kind: "company_add", payload: { name: "" } })).blocks
    ).toEqual([]);
    expect(parseConfirmBlocks(fence({ kind: "company_add" })).blocks).toEqual([]);
  });
});

describe("parseConfirmBlocks — candidate_patch", () => {
  it("accepts a well-formed patch to any of the four candidate docs", () => {
    for (const doc of ["profile", "targeting", "honesty", "form-defaults"]) {
      const raw = fence({
        kind: "candidate_patch",
        summary: "Saving what you told me",
        payload: { doc, patch: { some_field: "value" } },
      });
      expect(parseConfirmBlocks(raw).blocks).toHaveLength(1);
    }
  });

  it("carries doc/patch through inside payload, never touching the parser's top-level patch field", () => {
    const raw = fence({
      kind: "candidate_patch",
      payload: { doc: "profile", patch: { candidate: { full_name: "Ada Lovelace" } } },
    });
    const { blocks } = parseConfirmBlocks(raw);
    expect(blocks).toEqual([
      {
        kind: "candidate_patch",
        summary: "",
        patch: null,
        payload: { doc: "profile", patch: { candidate: { full_name: "Ada Lovelace" } } },
      },
    ]);
  });

  it("drops a block whose doc is outside the closed enum", () => {
    const raw = fence({
      kind: "candidate_patch",
      payload: { doc: "not_a_real_doc", patch: { foo: "bar" } },
    });
    expect(parseConfirmBlocks(raw).blocks).toEqual([]);
  });

  it("drops a block whose patch is missing, not an object, or empty", () => {
    expect(
      parseConfirmBlocks(fence({ kind: "candidate_patch", payload: { doc: "profile" } })).blocks
    ).toEqual([]);
    expect(
      parseConfirmBlocks(
        fence({ kind: "candidate_patch", payload: { doc: "profile", patch: "nope" } })
      ).blocks
    ).toEqual([]);
    expect(
      parseConfirmBlocks(fence({ kind: "candidate_patch", payload: { doc: "profile", patch: {} } }))
        .blocks
    ).toEqual([]);
  });

  it("normalizes a structured candidate location into the profile schema's string fields", () => {
    const raw = fence({
      kind: "candidate_patch",
      payload: {
        doc: "profile",
        patch: {
          candidate: {
            location: { city: "Baltimore", state: "MD", country: "United States" },
          },
        },
      },
    });

    expect(parseConfirmBlocks(raw).blocks[0].payload.patch).toEqual({
      candidate: { location: "Baltimore, MD, United States" },
      location: { home: "Baltimore, MD, United States" },
    });
  });

  it("fills schema-required role bucket names from their titles", () => {
    const raw = fence({
      kind: "candidate_patch",
      payload: {
        doc: "targeting",
        patch: {
          role_buckets: [
            { priority: "primary", titles: ["Staff Platform Engineer"] },
            { priority: "secondary", titles: ["Engineering Manager"] },
          ],
        },
      },
    });

    expect(parseConfirmBlocks(raw).blocks[0].payload.patch.role_buckets).toEqual([
      { name: "Staff Platform Engineer", priority: "primary", titles: ["Staff Platform Engineer"] },
      { name: "Engineering Manager", priority: "secondary", titles: ["Engineering Manager"] },
    ]);
  });
});

describe("parseConfirmBlocks — evidence_claim", () => {
  it("accepts a well-formed claim/evidence pair", () => {
    const raw = fence({
      kind: "evidence_claim",
      payload: { claim: "Ran a 12-person kitchen", evidence: "Candidate-stated during setup" },
    });
    const { blocks } = parseConfirmBlocks(raw);
    expect(blocks).toEqual([
      {
        kind: "evidence_claim",
        summary: "",
        patch: null,
        payload: { claim: "Ran a 12-person kitchen", evidence: "Candidate-stated during setup" },
      },
    ]);
  });

  it("drops a block missing either claim or evidence, or with a blank one", () => {
    expect(
      parseConfirmBlocks(fence({ kind: "evidence_claim", payload: { claim: "Ran a kitchen" } }))
        .blocks
    ).toEqual([]);
    expect(
      parseConfirmBlocks(
        fence({ kind: "evidence_claim", payload: { evidence: "Candidate-stated" } })
      ).blocks
    ).toEqual([]);
    expect(
      parseConfirmBlocks(
        fence({ kind: "evidence_claim", payload: { claim: "  ", evidence: "Candidate-stated" } })
      ).blocks
    ).toEqual([]);
  });
});

describe("parseConfirmBlocks — dropped/invalid blocks are still stripped from display text", () => {
  it("an unknown kind is silently dropped, and the fence is still removed", () => {
    const raw = `Noted.\n\n${fence({ kind: "not_a_real_kind" })}`;
    expect(parseConfirmBlocks(raw)).toEqual({ text: "Noted.", blocks: [] });
  });

  it("malformed JSON inside the fence is silently dropped, and the fence is still removed", () => {
    const raw = "Noted.\n\n```careerrat:confirm\n{not valid json\n```";
    expect(parseConfirmBlocks(raw)).toEqual({ text: "Noted.", blocks: [] });
  });

  it("never renders raw JSON — every matched fence is removed even when invalid", () => {
    const raw = fence({ kind: "authorization", patch: {} });
    expect(parseConfirmBlocks(raw).text).toBe("");
  });
});

describe("parseConfirmBlocks — multiple blocks in one turn", () => {
  it("parses every valid fence in order and strips all of them", () => {
    const raw = [
      "First:",
      fence({ kind: "company_add", payload: { name: "Stripe" } }),
      "Second:",
      fence({ kind: "company_add", payload: { name: "Anthropic" } }),
    ].join("\n\n");
    const { text, blocks } = parseConfirmBlocks(raw);
    // Each removed fence leaves its surrounding blank-line separators intact
    // (a plain-text replace, not a paragraph re-flow) — the caller only
    // needs "no raw JSON," not perfectly tidied whitespace.
    expect(text).toBe("First:\n\n\n\nSecond:");
    expect(blocks.map((b) => b.payload.name)).toEqual(["Stripe", "Anthropic"]);
  });
});

describe("CONFIRM_KINDS / SINGLE_CLICK_KINDS", () => {
  it("SINGLE_CLICK_KINDS is exactly authorization, company_add, companies_suggest, candidate_patch, evidence_claim", () => {
    expect(SINGLE_CLICK_KINDS).toEqual(
      new Set([
        "authorization",
        "company_add",
        "companies_suggest",
        "candidate_patch",
        "evidence_claim",
      ])
    );
  });

  it("consent_mode and consent_capability are recognized kinds but NOT single-click", () => {
    expect(CONFIRM_KINDS).toContain("consent_mode");
    expect(CONFIRM_KINDS).toContain("consent_capability");
    expect(SINGLE_CLICK_KINDS.has("consent_mode")).toBe(false);
    expect(SINGLE_CLICK_KINDS.has("consent_capability")).toBe(false);
  });
});
