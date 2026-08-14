import { describe, expect, it } from "vitest";
import {
  formatTokenCount,
  formatUsd,
  topUsageFeatures,
  usageFeatureLabel,
} from "./usage-summary.js";

describe("usage summary helpers", () => {
  it("formats token and USD values for compact settings display", () => {
    expect(formatTokenCount(999)).toBe("999");
    expect(formatTokenCount(12_300)).toBe("12.3K");
    expect(formatTokenCount(1_250_000)).toBe("1.3M");
    expect(formatUsd(0)).toBe("$0.00");
    expect(formatUsd(0.0042)).toBe("$0.0042");
    expect(formatUsd(12.345)).toBe("$12.35");
  });

  it("humanizes feature ids without changing the durable key", () => {
    expect(usageFeatureLabel("onboarding.resume-ingestion")).toBe("Onboarding resume ingestion");
    expect(usageFeatureLabel("company-discovery")).toBe("Company discovery");
    expect(usageFeatureLabel(null)).toBe("Unlabeled");
  });

  it("returns the top priced feature buckets and leaves the original list untouched", () => {
    const rows = [
      { feature: "job-evaluation", cost_usd: 0.02, requests: 3 },
      { feature: "company-discovery", cost_usd: 0.08, requests: 2 },
      { feature: "onboarding.resume-ingestion", cost_usd: 0.04, requests: 1 },
    ];

    expect(topUsageFeatures(rows, 2).map((row) => row.feature)).toEqual([
      "company-discovery",
      "onboarding.resume-ingestion",
    ]);
    expect(rows.map((row) => row.feature)).toEqual([
      "job-evaluation",
      "company-discovery",
      "onboarding.resume-ingestion",
    ]);
  });
});
