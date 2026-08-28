import assert from "node:assert/strict";
import test from "node:test";

import { openAuthenticatedSource } from "../src/cli/tracker-dev.mjs";

test("authenticated source handoff opens the exact URL and stops for visible verification", async () => {
  const opened = [];
  const session = {
    available: true,
    async open(url) {
      opened.push(url);
      return {
        url: "https://www.linkedin.com/checkpoint/challenge/123",
        title: "Security verification",
        text: "Enter the security code",
      };
    },
  };
  const browserSessionManager = {
    get(options) {
      assert.deepEqual(options, { platform: "linkedin" });
      return session;
    },
  };
  const url = "https://www.linkedin.com/jobs/search/?keywords=platform&location=New%20York";

  const result = await openAuthenticatedSource(browserSessionManager, {
    platform: "linkedin",
    url,
  });

  assert.deepEqual(opened, [url]);
  assert.equal(result.state, "needs-user");
  assert.equal(result.blocker.state, "verification_required");
  assert.match(result.summary, /Finish the visible sign-in or verification step/i);
});
