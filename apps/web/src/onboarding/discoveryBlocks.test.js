import { describe, expect, it } from "vitest";
import { parseDiscoveryBlocks } from "./discoveryBlocks.js";

function fence(value) {
  return `Before\n\`\`\`careerrat:discovery\n${JSON.stringify(value)}\n\`\`\`\nAfter`;
}

describe("parseDiscoveryBlocks", () => {
  it("parses source, company, and completion blocks out of visible prose", () => {
    const raw = [
      fence({
        kind: "source_proposal",
        label: "AI Jobs Board",
        url: "https://example.com/jobs",
        why: "Current dated applied-AI listings",
        confidence: "high",
      }),
      fence({
        kind: "company_proposal",
        name: "Example Co",
        url: "https://jobs.ashbyhq.com/example",
        why: "Hiring the target role",
        confidence: "borderline",
      }),
      fence({ kind: "discovery_complete", step: "research-boards" }),
    ].join("\n");

    const parsed = parseDiscoveryBlocks(raw);
    expect(parsed.text).not.toContain("careerrat:discovery");
    expect(parsed.blocks).toEqual([
      {
        kind: "source_proposal",
        label: "AI Jobs Board",
        url: "https://example.com/jobs",
        why: "Current dated applied-AI listings",
        confidence: "high",
      },
      {
        kind: "company_proposal",
        name: "Example Co",
        url: "https://jobs.ashbyhq.com/example",
        why: "Hiring the target role",
        confidence: "borderline",
      },
      { kind: "discovery_complete", step: "research-boards" },
    ]);
  });

  it("drops malformed and unsafe proposal blocks", () => {
    expect(
      parseDiscoveryBlocks(
        fence({ kind: "source_proposal", label: "Bad", url: "javascript:alert(1)" })
      ).blocks
    ).toEqual([]);
    expect(
      parseDiscoveryBlocks(fence({ kind: "discovery_complete", step: "apply-job" })).blocks
    ).toEqual([]);
  });
});
