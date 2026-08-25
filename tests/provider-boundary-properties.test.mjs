import assert from "node:assert/strict";
import { test } from "node:test";
import fc from "fast-check";

import { acpPermissionDecision } from "../src/core/ai/acp-runtime.mjs";
import { validatePublicHttpUrl } from "../src/core/net/public-http-fetch.mjs";

const OPTIONS = [
  { optionId: "allow", name: "Allow once", kind: "allow_once" },
  { optionId: "reject", name: "Reject", kind: "reject_once" },
];

const grantedTools = fc.uniqueArray(
  fc.constantFrom("Read", "WebSearch", "WebFetch", "Glob", "Grep", "Skill"),
  { maxLength: 6 }
);
const segment = fc
  .array(fc.constantFrom(..."abcdefghijklmnopqrstuvwxyz0123456789-_"), {
    minLength: 1,
    maxLength: 16,
  })
  .map((chars) => chars.join(""));

function selectedOption(decision) {
  return decision?.outcome?.outcome === "selected" ? decision.outcome.optionId : null;
}

test("ACP permission fuzzing never grants a state-changing tool kind", () => {
  fc.assert(
    fc.property(
      fc.constantFrom("execute", "edit", "delete", "move", "write"),
      grantedTools,
      segment,
      (kind, tools, path) => {
        const decision = acpPermissionDecision({
          tools,
          cwd: "/safe/task",
          request: { toolCall: { kind, rawInput: { path } }, options: OPTIONS },
        });
        assert.notEqual(selectedOption(decision), "allow");
      }
    ),
    { numRuns: 300 }
  );
});

test("ACP permission fuzzing rejects provider-supplied read paths and allows only the staged-input tool", () => {
  fc.assert(
    fc.property(fc.array(segment, { minLength: 1, maxLength: 5 }), (segments) => {
      const relativePath = segments.join("/");
      const inside = acpPermissionDecision({
        tools: ["Read"],
        cwd: "/safe/task",
        request: {
          toolCall: {
            kind: "read",
            name: "read_staged_input",
            rawInput: { path: relativePath },
          },
          options: OPTIONS,
        },
      });
      const outside = acpPermissionDecision({
        tools: ["Read"],
        cwd: "/safe/task",
        request: {
          toolCall: {
            kind: "read",
            name: "read_staged_input",
            rawInput: { path: `../outside/${relativePath}` },
          },
          options: OPTIONS,
        },
      });
      const staged = acpPermissionDecision({
        tools: ["Read"],
        cwd: "/safe/task",
        request: {
          toolCall: { kind: "read", name: "read_staged_input", rawInput: {} },
          options: OPTIONS,
        },
      });
      assert.notEqual(selectedOption(inside), "allow");
      assert.notEqual(selectedOption(outside), "allow");
      assert.equal(selectedOption(staged), "allow");
    }),
    { numRuns: 300 }
  );
});

test("public-web fuzzing admits only the scoped MCP fetch for public HTTPS hosts", () => {
  fc.assert(
    fc.property(segment, (hostLabel) => {
      const url = `https://${hostLabel}.example.com/jobs`;
      assert.equal(validatePublicHttpUrl(url).ok, true);
      const scopedDecision = acpPermissionDecision({
        tools: ["WebSearch", "WebFetch"],
        request: {
          toolCall: {
            kind: "fetch",
            name: "mcp__careerrat_scoped_tools__fetch",
            rawInput: { url },
          },
          options: OPTIONS,
        },
      });
      const nativeFetchDecision = acpPermissionDecision({
        tools: ["WebSearch", "WebFetch"],
        request: {
          toolCall: { kind: "fetch", name: "fetch", rawInput: { url } },
          options: OPTIONS,
        },
      });
      const nativeSearchDecision = acpPermissionDecision({
        tools: ["WebSearch", "WebFetch"],
        request: {
          toolCall: { kind: "search", name: "web_search", rawInput: { query: hostLabel } },
          options: OPTIONS,
        },
      });
      assert.equal(selectedOption(scopedDecision), "allow");
      assert.notEqual(selectedOption(nativeFetchDecision), "allow");
      assert.notEqual(selectedOption(nativeSearchDecision), "allow");
    }),
    { numRuns: 300 }
  );

  fc.assert(
    fc.property(
      fc.constantFrom(
        "http://localhost:7777/private",
        "http://127.0.0.1/private",
        "http://10.0.0.1/private",
        "http://169.254.169.254/latest/meta-data",
        "http://[::1]/private"
      ),
      (url) => {
        assert.equal(validatePublicHttpUrl(url).ok, false);
        const decision = acpPermissionDecision({
          tools: ["WebSearch", "WebFetch"],
          request: {
            toolCall: {
              kind: "fetch",
              name: "mcp__careerrat_scoped_tools__fetch",
              rawInput: { url },
            },
            options: OPTIONS,
          },
        });
        assert.notEqual(selectedOption(decision), "allow");
      }
    ),
    { numRuns: 100 }
  );
});
