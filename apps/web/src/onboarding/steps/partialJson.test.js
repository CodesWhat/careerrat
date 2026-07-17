import { describe, expect, it } from "vitest";
import { extractProgressiveSeed, parsePartialResumeJson } from "./partialJson.js";

describe("parsePartialResumeJson", () => {
  it("closes a string value cut in the middle", () => {
    expect(parsePartialResumeJson('{"candidate":{"full_name":"Jane Do')).toEqual({
      candidate: { full_name: "Jane Do" },
    });
  });

  it.each([
    ['{"candidate":{"full_name', { candidate: {} }],
    ['{"candidate":{"full_name":', { candidate: {} }],
  ])("discards a dangling object key from %s", (text, expected) => {
    expect(parsePartialResumeJson(text)).toEqual(expected);
  });

  it("discards a truncated array element while retaining completed elements", () => {
    const text = '{"claims":[{"claim":"one","evidence":"ok"},tru';
    expect(parsePartialResumeJson(text)).toEqual({
      claims: [{ claim: "one", evidence: "ok" }],
    });
  });

  it("discards a number cut before its delimiter", () => {
    expect(parsePartialResumeJson('{"sections":{"experience":12')).toEqual({
      sections: {},
    });
  });

  it("parses a complete fenced document", () => {
    expect(parsePartialResumeJson('```json\n{"candidate":{"full_name":"Jane"}}\n```')).toEqual({
      candidate: { full_name: "Jane" },
    });
  });

  it("repairs a fenced document without closing ticks", () => {
    expect(parsePartialResumeJson('```json\n{"candidate":{"full_name":"Jane')).toEqual({
      candidate: { full_name: "Jane" },
    });
  });

  it.each(["", "   ", "\n\t"])("returns null for empty input %j", (text) => {
    expect(parsePartialResumeJson(text)).toBeNull();
  });

  it("closes deeply nested objects and arrays", () => {
    const text = '{"outer":{"items":[{"nested":{"value":"deep';
    expect(parsePartialResumeJson(text)).toEqual({
      outer: { items: [{ nested: { value: "deep" } }] },
    });
  });

  it("preserves an escaped quote before a mid-string cut", () => {
    const text = String.raw`{"candidate":{"full_name":"Jane \"J. Do`;
    expect(parsePartialResumeJson(text)).toEqual({
      candidate: { full_name: 'Jane "J. Do' },
    });
  });

  it("drops a lone escape slash at the cut point before closing the string", () => {
    const text = '{"candidate":{"location":"C:\\\\Users\\\\Jane' + "\\";
    expect(parsePartialResumeJson(text)).toEqual({
      candidate: { location: "C:\\Users\\Jane" },
    });
  });

  it("fails safely when a unicode escape is cut mid-sequence", () => {
    const text = '{"candidate":{"full_name":"Jane \\u12';
    expect(parsePartialResumeJson(text)).toBeNull();
  });
});

describe("extractProgressiveSeed", () => {
  it("surfaces candidate domain from a streaming partial JSON preview", () => {
    const partial = parsePartialResumeJson(
      '{"candidate":{"full_name":"Jane Doe","domain":"industrial design'
    );

    expect(extractProgressiveSeed(partial)).toEqual({
      candidate: { full_name: "Jane Doe", domain: "industrial design" },
      claims: [],
      sections: null,
    });
  });

  it("maps candidate, claims, and only section keys present so far", () => {
    const result = extractProgressiveSeed({
      candidate: {
        full_name: "Jane Doe",
        email: " ",
        github: "https://github.com/jane",
        headline: "not part of the progressive schema",
      },
      claims: [
        { claim: "Led a team", evidence: "Experience section" },
        { claim: "Shipped a platform" },
        { evidence: "missing claim" },
      ],
      sections: { experience: 2, skills: 1, unknown: 9 },
    });

    expect(result).toEqual({
      candidate: {
        full_name: "Jane Doe",
        github: "https://github.com/jane",
      },
      claims: [
        { claim: "Led a team", evidence: "Experience section" },
        { claim: "Shipped a platform", evidence: "" },
      ],
      sections: { experience: 2, skills: 1 },
    });
  });

  it("omits absent candidate and section keys", () => {
    expect(extractProgressiveSeed({ candidate: { full_name: "Jane" } })).toEqual({
      candidate: { full_name: "Jane" },
      claims: [],
      sections: null,
    });
  });
});
