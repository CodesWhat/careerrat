import { describe, expect, it } from "vitest";
import { mapErrors } from "./error-map.js";

describe("mapErrors", () => {
  it("maps a known schema path to its field id", () => {
    const { byField, unmapped } = mapErrors(
      [{ path: "candidate.domain", message: "expected type string, got number" }],
      { "candidate.domain": "profile-domain" }
    );
    expect(byField["profile-domain"]).toBe("expected type string, got number");
    expect(unmapped).toHaveLength(0);
  });

  it("collects errors with no matching field id as unmapped, not dropped", () => {
    const { byField, unmapped } = mapErrors(
      [{ path: "", message: 'missing required property "candidate"' }],
      { "candidate.domain": "profile-domain" }
    );
    expect(Object.keys(byField)).toHaveLength(0);
    expect(unmapped).toHaveLength(1);
    expect(unmapped[0].message).toBe('missing required property "candidate"');
  });

  it("handles an empty or undefined error list without throwing", () => {
    expect(mapErrors(undefined, {}).unmapped).toHaveLength(0);
    expect(mapErrors([], {}).unmapped).toHaveLength(0);
  });
});
