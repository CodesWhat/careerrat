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

  it("parses the research trio's conversational web handoff result blocks", () => {
    const raw = [
      fence({
        kind: "company_research_result",
        company: "Beacon Robotics",
        slug: "beacon-robotics",
        markdown: "---\ntype: company-research\n---\n\n## Overview\nBeacon builds robots.",
      }),
      fence({
        kind: "comp_benchmark_result",
        role: "Registered Nurse",
        location: "Denver, CO",
        stem: "comp-bench-registered-nurse-denver-co-2026-08",
        benchmark: {
          floor: 82000,
          midpoint: 94000,
          ceiling: 108000,
          currency: "USD",
          confidence: "high",
        },
        markdown: "---\ntype: comp-benchmark\n---\n\n## Market range\n$82k-$108k.",
      }),
      fence({
        kind: "company_health_result",
        targetType: "application",
        targetId: "app-riverside",
        company: "Riverside Health",
        companyHealth: {
          rating: "watch",
          forFunction: "clinical staffing",
          asOf: "2026-08-15",
          provenance: "built-from-data",
          dimensions: {},
          rationale: "Hiring freeze rumored.",
        },
      }),
    ].join("\n");

    const parsed = parseDiscoveryBlocks(raw);
    expect(parsed.blocks).toEqual([
      {
        kind: "company_research_result",
        company: "Beacon Robotics",
        slug: "beacon-robotics",
        markdown: "---\ntype: company-research\n---\n\n## Overview\nBeacon builds robots.",
      },
      {
        kind: "comp_benchmark_result",
        role: "Registered Nurse",
        location: "Denver, CO",
        stem: "comp-bench-registered-nurse-denver-co-2026-08",
        benchmark: {
          floor: 82000,
          midpoint: 94000,
          ceiling: 108000,
          currency: "USD",
          confidence: "high",
        },
        markdown: "---\ntype: comp-benchmark\n---\n\n## Market range\n$82k-$108k.",
      },
      {
        kind: "company_health_result",
        targetType: "application",
        targetId: "app-riverside",
        company: "Riverside Health",
        companyHealth: {
          rating: "watch",
          forFunction: "clinical staffing",
          asOf: "2026-08-15",
          provenance: "built-from-data",
          dimensions: {},
          rationale: "Hiring freeze rumored.",
        },
      },
    ]);
  });

  it("drops result blocks missing required fields", () => {
    expect(
      parseDiscoveryBlocks(fence({ kind: "company_research_result", company: "", markdown: "x" }))
        .blocks
    ).toEqual([]);
    expect(
      parseDiscoveryBlocks(fence({ kind: "comp_benchmark_result", role: "Nurse", markdown: "" }))
        .blocks
    ).toEqual([]);
    expect(
      parseDiscoveryBlocks(
        fence({
          kind: "company_health_result",
          targetType: "bogus",
          targetId: "x",
          companyHealth: {},
        })
      ).blocks
    ).toEqual([]);
  });
});
