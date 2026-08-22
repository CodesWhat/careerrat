import { describe, expect, it } from "vitest";
import {
  EyeIcon,
  GlobeIcon,
  PencilIcon,
  SettingsIcon,
  StarIcon,
  TerminalIcon,
} from "../components/icons.jsx";
import { describeToolActivity } from "./chatActivity.jsx";

describe("describeToolActivity", () => {
  it.each([
    ["Read", EyeIcon, "Reading files"],
    ["Glob", EyeIcon, "Reading files"],
    ["Grep", EyeIcon, "Reading files"],
    ["WebSearch", GlobeIcon, "Searching the web"],
    ["WebFetch", GlobeIcon, "Searching the web"],
    ["Write", PencilIcon, "Writing"],
    ["Edit", PencilIcon, "Writing"],
    ["NotebookEdit", PencilIcon, "Writing"],
    ["Bash", TerminalIcon, "Running a command"],
  ])("maps %s to its icon and friendly label", (name, Icon, label) => {
    const activity = describeToolActivity(name, null);
    expect(activity.Icon).toBe(Icon);
    expect(activity.label).toBe(label);
  });

  it("maps an unmapped/future tool name to the generic gear + Working fallback", () => {
    const activity = describeToolActivity("SomeFutureTool", { anything: true });
    expect(activity.Icon).toBe(SettingsIcon);
    expect(activity.label).toBe("Working");
  });

  it("names the skill in the Skill tool's label when the input carries one", () => {
    const activity = describeToolActivity("Skill", { skill: "evaluate-job" });
    expect(activity.Icon).toBe(StarIcon);
    expect(activity.label).toBe("Using the evaluate-job skill");
  });

  it("falls back to a generic Skill label when the input has no skill name", () => {
    const activity = describeToolActivity("Skill", {});
    expect(activity.label).toBe("Using a skill");

    const activityNoInput = describeToolActivity("Skill", null);
    expect(activityNoInput.label).toBe("Using a skill");
  });

  it("appends a truncated trailing detail pulled from the tool's own input", () => {
    expect(describeToolActivity("Read", { file_path: "resume.pdf" }).detail).toBe("resume.pdf");
    expect(describeToolActivity("Bash", { command: "npm test" }).detail).toBe("npm test");
    expect(describeToolActivity("WebSearch", { query: "acme corp layoffs 2026" }).detail).toBe(
      "acme corp layoffs 2026"
    );
    expect(describeToolActivity("WebFetch", { url: "https://example.com/jobs/123" }).detail).toBe(
      "https://example.com/jobs/123"
    );

    const longPath = `/very/long/path/${"segment/".repeat(20)}resume.pdf`;
    const detail = describeToolActivity("Read", { file_path: longPath }).detail;
    expect(detail.length).toBeLessThanOrEqual(60);
    expect(detail.endsWith("…")).toBe(true);
  });

  it("yields no detail when input is missing or the field isn't a string", () => {
    expect(describeToolActivity("Read", null).detail).toBe("");
    expect(describeToolActivity("Read", {}).detail).toBe("");
    expect(describeToolActivity("Read", { file_path: 42 }).detail).toBe("");
  });
});
