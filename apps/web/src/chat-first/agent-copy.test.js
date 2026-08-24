import { describe, expect, it } from "vitest";
import { cleanAgentCopy } from "./agent-copy.js";

describe("cleanAgentCopy", () => {
  it("unwraps a saved structured reply before rendering it", () => {
    expect(cleanAgentCopy('{"reply":"I can prepare and fill the form safely."}')).toBe(
      "I can prepare and fill the form safely."
    );
  });

  it("leaves ordinary braces and malformed JSON as ordinary copy", () => {
    expect(cleanAgentCopy("Use {company} in the draft.")).toBe("Use {company} in the draft.");
    expect(cleanAgentCopy('{"reply":')).toBe('{"reply":');
  });
});
