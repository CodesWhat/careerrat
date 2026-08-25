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

  it("unwraps common structured envelopes instead of showing raw JSON", () => {
    expect(cleanAgentCopy('{"message":"I found three strong matches."}')).toBe(
      "I found three strong matches."
    );
    expect(cleanAgentCopy('{"answer":"Yes, that role fits your location settings."}')).toBe(
      "Yes, that role fits your location settings."
    );
  });

  it("replaces machine-only JSON with a normal sentence", () => {
    const copy = cleanAgentCopy('{"status":"AI_SCHEMA_INVALID","operation":"workspace:chat-turn"}');
    expect(copy).toBe("I couldn't turn that into a clear answer. Please try again.");
    expect(copy).not.toMatch(/[{}]|AI_SCHEMA_INVALID|workspace:chat-turn/);
  });

  it("drops internal report lines and explicit tool narration from assistant prose", () => {
    expect(
      cleanAgentCopy(
        "STATUS_CODE: AI_SCHEMA_INVALID\nUsing the WebSearch tool now.\nI need your target city before I can continue."
      )
    ).toBe("I need your target city before I can continue.");
  });

  it("drops fenced JSON payloads while keeping the useful plain-English answer", () => {
    expect(
      cleanAgentCopy('I found two good matches.\n```json\n{"status":"completed","count":2}\n```')
    ).toBe("I found two good matches.");
  });

  it("drops onboarding control fences from a rehydrated workspace answer", () => {
    expect(
      cleanAgentCopy(
        '```careerrat:confirm\n{"kind":"candidate_patch","summary":"Search focus","payload":{"doc":"profile","patch":{"candidate":{"domain":"developer infrastructure"}}}}\n```\nAre there kinds of companies whose values or size you especially like?'
      )
    ).toBe("Are there kinds of companies whose values or size you especially like?");
  });
});
