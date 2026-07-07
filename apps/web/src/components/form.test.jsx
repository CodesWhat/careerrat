import { describe, expect, it } from "vitest";

import { filterChipSuggestions } from "./form.jsx";

describe("filterChipSuggestions", () => {
  it("matches typed text against labels and aliases while hiding already selected values", () => {
    const suggestions = [
      { emoji: "🏠", label: "Remote unavailable", value: "Remote unavailable", aliases: ["wfh"] },
      { emoji: "🧳", label: "Heavy travel", value: "Heavy travel", aliases: ["travel"] },
      { emoji: "🛂", label: "Visa sponsorship unavailable", value: "Visa sponsorship unavailable" },
    ];

    expect(filterChipSuggestions({ draft: "wfh", values: [], suggestions })).toEqual([
      suggestions[0],
    ]);
    expect(
      filterChipSuggestions({ draft: "travel", values: ["Heavy travel"], suggestions })
    ).toEqual([]);
    expect(filterChipSuggestions({ draft: "visa", values: [], suggestions })).toEqual([
      expect.objectContaining({
        emoji: "🛂",
        label: "Visa sponsorship unavailable",
        value: "Visa sponsorship unavailable",
      }),
    ]);
  });
});
