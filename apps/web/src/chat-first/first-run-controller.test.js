import { describe, expect, it, vi } from "vitest";
import {
  applyFirstRunConfirmation,
  buildFirstRunKnowledge,
  firstRunAssistantMessage,
} from "./first-run-controller.js";

describe("chat-first onboarding controller", () => {
  it("keeps a stale unavailable runtime selection on the engine stage", async () => {
    const controller = await import("./first-run-controller.js");

    expect(typeof controller.runtimeSelectionReady).toBe("function");
    expect(
      controller.runtimeSelectionReady({
        selectedId: "claude",
        providerFallback: false,
        runtimes: [{ id: "claude", available: true, ready: false }],
      })
    ).toBe(false);
    expect(
      controller.runtimeSelectionReady({
        selectedId: "codex",
        providerFallback: false,
        runtimes: [{ id: "codex", available: true, ready: true }],
      })
    ).toBe(true);
  });

  it("keeps every supported runtime in the first-run chooser", async () => {
    const controller = await import("./first-run-controller.js");

    expect(typeof controller.firstRunRuntimeChoices).toBe("function");
    expect(
      controller.firstRunRuntimeChoices({
        runtimes: [
          { id: "hermes", name: "Hermes Agent", available: true, ready: true },
          { id: "codex", name: "Codex", available: false, ready: false },
          { id: "claude", name: "Claude Code", available: true, ready: false },
          { id: "opencode", name: "OpenCode", available: true, ready: true },
          { id: "custom", name: "Custom", available: true, ready: true },
        ],
      })
    ).toEqual([
      expect.objectContaining({ id: "claude", detected: true, ready: false }),
      expect.objectContaining({ id: "codex", detected: false, ready: false }),
      expect.objectContaining({ id: "hermes", detected: true, ready: true }),
      expect.objectContaining({ id: "opencode", detected: true, ready: true }),
      expect.objectContaining({ id: "custom", detected: true, ready: true }),
    ]);
  });

  it("uses the configured agent name from persisted onboarding state", async () => {
    const controller = await import("./first-run-controller.js");

    expect(typeof controller.firstRunAgentName).toBe("function");
    expect(controller.firstRunAgentName({ data: { modes: { agent_name: "Maya" } } }, "Paul")).toBe(
      "Maya"
    );
    expect(controller.firstRunAgentName(null, "Paul")).toBe("Paul");
  });

  it("turns canonical setup progress into the staged knowledge panel", () => {
    const state = {
      setupProgress: {
        completedCount: 2,
        total: 3,
        items: [
          { key: "engine", done: true },
          { key: "roles", done: true },
          { key: "evidence", done: false },
        ],
      },
      data: {
        profile: {},
        targeting: { role_buckets: [{ titles: ["Staff Engineer"] }] },
        evidence: { claims: [] },
      },
    };

    expect(buildFirstRunKnowledge(state, { name: "Claude Code" })).toMatchObject({
      progress: { completed: 2, total: 3 },
      items: [
        { id: "engine", status: "complete", lines: ["Claude Code"] },
        { id: "roles", status: "complete", lines: ["Staff Engineer"] },
        { id: "evidence", status: "active" },
      ],
    });
  });

  it("keeps extracted blocks for persistence without exposing fact-by-fact chat choices", () => {
    const message = firstRunAssistantMessage(
      `I have your target role.\n\n\`\`\`careerrat:confirm\n{"kind":"candidate_patch","summary":"Staff roles","payload":{"doc":"targeting","patch":{"role_buckets":[{"name":"Staff","titles":["Staff Engineer"]}]}}}\n\`\`\``,
      "assistant-1"
    );

    expect(message.text).toBe("I have your target role.");
    expect(message.options).toEqual([]);
    expect(message.blocks[0].kind).toBe("candidate_patch");
  });

  it.each([
    [
      "consent_capability",
      { capability: "authenticated_search", platform: "linkedin" },
      "Allow",
      "Not now",
    ],
    ["consent_mode", "basic", "Use this setup", "Keep current"],
    ["company_add", { name: "Acme" }, "Add company", "Not now"],
    ["companies_suggest", {}, "Show suggestions", "Not now"],
  ])(
    "uses contextual actions for an explicit %s confirmation",
    (kind, payload, confirm, decline) => {
      const message = firstRunAssistantMessage(
        `This needs an explicit choice.\n\n\`\`\`careerrat:confirm\n${JSON.stringify({ kind, payload })}\n\`\`\``,
        `assistant-${kind}`
      );

      expect(message.text).toBe("This needs an explicit choice.");
      expect(message.options.map((option) => option.label)).toEqual([confirm, decline]);
      expect(message.blocks[0].kind).toBe(kind);
    }
  );

  it("fills canonical knowledge sections from persisted partial facts before a section is done", () => {
    const state = {
      setupProgress: {
        completedCount: 5,
        total: 8,
        items: [
          { key: "engine", done: true },
          { key: "resume", done: false },
          { key: "roles", done: true },
          { key: "companies", done: true },
          { key: "evidence", done: true },
          { key: "guardrails", done: true },
          { key: "quickFacts", done: false },
          { key: "authorization", done: true },
        ],
      },
      data: {
        profile: {
          candidate: { full_name: "Riley", email: "riley@example.com", location: "NYC" },
          location: {
            home: "NYC",
            remote: true,
            hybrid: true,
            onsite: false,
            mode_preferences_confirmed: true,
          },
          compensation: {},
          authorization: { work_authorized: true, requires_sponsorship: false },
        },
        targeting: {
          role_buckets: [{ titles: ["Staff Engineer"] }],
          company_preferences: {
            confirmed: true,
            industries: ["AI infrastructure"],
            business_models: ["AI infrastructure"],
            examples: ["Acme"],
          },
          cut_signals: ["On-site outside NYC"],
        },
        evidence: {
          claims: [
            {
              id: "claim-1",
              claim: "Led a platform migration",
              evidence: "Migrated three services without downtime",
            },
          ],
        },
      },
    };

    const knowledge = buildFirstRunKnowledge(state, { name: "Claude Code" });

    expect(knowledge.items.map((item) => item.id)).toEqual([
      "engine",
      "resume",
      "roles",
      "companies",
      "evidence",
      "guardrails",
      "quickFacts",
      "authorization",
    ]);
    expect(knowledge.items.find((item) => item.id === "roles")).toMatchObject({
      status: "complete",
      lines: ["Staff Engineer"],
      editor: {
        fields: [{ id: "titles", value: "Staff Engineer" }],
      },
    });
    expect(knowledge.items.find((item) => item.id === "companies").editor).toMatchObject({
      fields: [
        expect.objectContaining({ id: "focus", value: "AI infrastructure" }),
        expect.objectContaining({ id: "examples", value: "Acme" }),
      ],
    });
    expect(knowledge.items.find((item) => item.id === "quickFacts")).toMatchObject({
      status: "populated",
      lines: ["Riley", "riley@example.com", "NYC", "Remote", "Hybrid"],
    });
    expect(knowledge.items.find((item) => item.id === "quickFacts").editor.fields).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "home", value: "NYC" }),
        expect.objectContaining({ id: "remote", checked: true }),
        expect.objectContaining({ id: "onsite", checked: false }),
      ])
    );
    expect(knowledge.items.find((item) => item.id === "evidence").editor).toMatchObject({
      existingClaimIds: ["claim-1"],
      fields: [
        {
          id: "claims",
          value: "Led a platform migration :: Migrated three services without downtime",
        },
      ],
    });
    expect(knowledge.items.find((item) => item.id === "resume")).toMatchObject({
      status: "active",
      lines: [],
    });
  });

  it("adds the deterministic first-question suggestion without replacing typed answers", () => {
    const message = firstRunAssistantMessage(
      "One question at a time. First: what kind of role are you actually after?",
      "assistant-first"
    );

    expect(message.options).toEqual([
      {
        id: "suggest:targets",
        label: "Staff SWE · ML infra · remote or hybrid SF",
      },
    ]);
    expect(message.allowTypedAnswer).toBe(true);
  });

  it("writes confirmed profile facts through the existing canonical endpoints", async () => {
    const api = {
      saveCandidateFile: vi.fn().mockResolvedValue({ ok: true }),
      saveEvidenceSeed: vi.fn().mockResolvedValue({ ok: true }),
      createCompanyProposals: vi.fn().mockResolvedValue({ ok: true }),
    };

    await applyFirstRunConfirmation(
      {
        kind: "authorization",
        patch: { work_authorized: true, requires_sponsorship: false },
      },
      { api, state: {} }
    );
    await applyFirstRunConfirmation(
      {
        kind: "evidence_claim",
        payload: { claim: "Led a migration", evidence: "Shipped across three teams" },
      },
      { api, state: {} }
    );

    expect(api.saveCandidateFile.mock.calls).toEqual([
      ["profile", { authorization: { work_authorized: true, requires_sponsorship: false } }],
      ["form-defaults", { work_authorization: "Yes", requires_sponsorship: "No" }],
    ]);
    expect(api.saveEvidenceSeed).toHaveBeenCalledWith([
      { claim: "Led a migration", evidence: "Shipped across three teams" },
    ]);
  });
});
