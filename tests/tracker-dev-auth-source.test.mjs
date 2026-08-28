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

test("authenticated source handoff rejects private URLs before opening a browser session", async () => {
  let sessionRequests = 0;
  const result = await openAuthenticatedSource(
    {
      get() {
        sessionRequests += 1;
        throw new Error("must not create a session");
      },
    },
    { platform: "linkedin", url: "http://127.0.0.1:7777/private" }
  );

  assert.equal(sessionRequests, 0);
  assert.equal(result.state, "needs-user");
  assert.equal(
    result.summary,
    "CareerRat couldn't open that LinkedIn link. Add a public job-site URL and try again."
  );
});

test("authenticated source handoff hides technical browser startup errors", async () => {
  const unavailable = await openAuthenticatedSource(
    {
      get() {
        return {
          available: false,
          reason:
            "browserType.launchPersistentContext: Executable doesn't exist at /private/path/chromium",
        };
      },
    },
    { platform: "linkedin", url: "https://www.linkedin.com/jobs/search/?keywords=platform" }
  );
  const failed = await openAuthenticatedSource(
    {
      get() {
        return {
          available: true,
          async open() {
            throw new Error("Target page, context or browser has been closed");
          },
        };
      },
    },
    { platform: "indeed", url: "https://www.indeed.com/jobs?q=operations" }
  );

  assert.equal(
    unavailable.summary,
    "LinkedIn couldn't open in CareerRat. Close and reopen CareerRat, then try again."
  );
  assert.equal(
    failed.summary,
    "Indeed couldn't open in CareerRat. Close and reopen CareerRat, then try again."
  );
  assert.doesNotMatch(
    `${unavailable.summary} ${failed.summary}`,
    /launch|executable|context|chromium/i
  );
});
