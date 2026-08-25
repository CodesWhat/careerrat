import assert from "node:assert/strict";
import { test } from "node:test";

import { parseContactIdentity } from "../src/core/automation/contact-identity.mjs";

test("parseContactIdentity separates a display name from an enclosed email", () => {
  assert.deepEqual(parseContactIdentity("Jordan Recruiter <jordan@acme.example>"), {
    name: "Jordan Recruiter",
    email: "jordan@acme.example",
  });
});

test("parseContactIdentity cannot leave nested angle-bracket markup in the display name", () => {
  const identity = parseContactIdentity("Jordan <scr<script>ipt> <jordan@acme.example>");
  assert.equal(identity.email, "jordan@acme.example");
  assert.doesNotMatch(identity.name, /[<>]/);
  assert.doesNotMatch(identity.name, /<script/i);
});
