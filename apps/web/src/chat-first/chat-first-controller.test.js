import { describe, expect, it } from "vitest";
import {
  buildMissionPayload,
  resolveComposerCommit,
  workspaceMessages,
} from "./chat-first-controller.js";

describe("resolveComposerCommit", () => {
  it("commits the classifier's typed intent when one is available", () => {
    const intent = {
      type: "search.run",
      entity: { type: "workspace", id: "workspace-main" },
      input: {},
    };

    expect(
      resolveComposerCommit({ action: { label: "Sweep boards", intent } }, "find jobs")
    ).toEqual({ kind: "intent", label: "Sweep boards", intent });
  });

  it("sends an ordinary conversation turn when no action was classified", () => {
    expect(resolveComposerCommit({ answer: { label: "Ask Paul" } }, "coach me")).toEqual({
      kind: "message",
      text: "coach me",
    });
  });

  it("turns a classified apply into a user-gated mission instead of the apply executor", () => {
    const intent = {
      type: "job.apply",
      entity: { type: "application", id: "app-1" },
      input: {},
    };

    expect(resolveComposerCommit({ action: { label: "Apply", intent } }, "apply here")).toEqual({
      kind: "mission",
      mode: "prepare-to-submit",
      jobs: [{ type: "application", id: "app-1" }],
    });
  });
});

describe("buildMissionPayload", () => {
  const rows = [
    {
      id: "sourced-1",
      source: "sourced",
      company: "Tyrell",
      role: "Staff Engineer",
      fit: 88,
    },
    {
      id: "app-1",
      source: "reviewed-hold",
      company: "Aperture",
      role: "Platform Lead",
      fit: 84,
    },
  ];

  it("deduplicates selected jobs and makes the user-submit boundary explicit", () => {
    const payload = buildMissionPayload(
      ["sourced-1", "app-1", "sourced-1"],
      rows,
      "prepare-to-submit"
    );

    expect(payload).toEqual({
      title: "Apply to 2 roles",
      mode: "prepare-to-submit",
      requiresUserSubmit: true,
      jobs: [
        {
          id: "sourced-1",
          type: "sourced",
          company: "Tyrell",
          role: "Staff Engineer",
          fit: 88,
        },
        {
          id: "app-1",
          type: "application",
          company: "Aperture",
          role: "Platform Lead",
          fit: 84,
        },
      ],
    });
  });

  it("uses the handoff mission title for draft-only work", () => {
    const payload = buildMissionPayload(["sourced-1"], rows, "draft");

    expect(payload.title).toBe("Draft 1 packet");
  });

  it("rejects an empty or stale selection instead of creating a fake mission", () => {
    expect(() => buildMissionPayload(["missing"], rows, "draft")).toThrow(
      "Select at least one current job"
    );
  });
});

describe("workspaceMessages", () => {
  it("unwraps the durable workspace thread response", () => {
    expect(
      workspaceMessages({ data: { messages: [{ id: "m1", role: "assistant", text: "Hi" }] } })
    ).toEqual([{ id: "m1", role: "assistant", text: "Hi" }]);
    expect(workspaceMessages(null)).toEqual([]);
  });
});
