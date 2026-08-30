import assert from "node:assert/strict";
import test from "node:test";
import * as trackerDev from "../src/cli/tracker-dev.mjs";
import { searchSourceBrowserSessionOptions } from "../src/core/automation/browser-session.mjs";

const { openAuthenticatedSource } = trackerDev;

const resolvePublic = async (rawUrl) => ({ ok: true, url: new URL(rawUrl).toString() });

test("public configured sources use hidden Playwright sessions", () => {
  assert.deepEqual(
    searchSourceBrowserSessionOptions({
      provider: "HiringCafe",
      source_type: "url-query",
    }),
    {
      platform: "HiringCafe",
      provider: "playwright",
      headless: true,
    }
  );
  assert.deepEqual(
    searchSourceBrowserSessionOptions({
      provider: "Wellfound",
      platform: "wellfound",
      source_type: "browser",
    }),
    {
      platform: "wellfound",
      provider: "playwright",
      headless: true,
    }
  );
});

test("login-backed configured sources keep visible Playwright sessions", () => {
  assert.deepEqual(
    searchSourceBrowserSessionOptions({
      provider: "LinkedIn",
      platform: "linkedin",
      source_type: "browser",
      auth: true,
    }),
    {
      platform: "linkedin",
      provider: "playwright",
      headless: false,
    }
  );
});

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
      assert.deepEqual(options, { platform: "linkedin", provider: "playwright" });
      return session;
    },
  };
  const url = "https://www.linkedin.com/jobs/search/?keywords=platform&location=New%20York";

  const result = await openAuthenticatedSource(
    browserSessionManager,
    {
      platform: "linkedin",
      url,
    },
    { resolvePublicTargetImpl: resolvePublic }
  );

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
    { platform: "linkedin", url: "http://127.0.0.1:7777/private" },
    { resolvePublicTargetImpl: resolvePublic }
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
    { platform: "linkedin", url: "https://www.linkedin.com/jobs/search/?keywords=platform" },
    { resolvePublicTargetImpl: resolvePublic }
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
    { platform: "indeed", url: "https://www.indeed.com/jobs?q=operations" },
    { resolvePublicTargetImpl: resolvePublic }
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

test("authenticated source handoff refuses Orca before opening a login URL without interception", async () => {
  let opened = false;
  const result = await openAuthenticatedSource(
    {
      get() {
        return {
          available: true,
          provider: "orca",
          networkBoundary: "untrusted",
          async open() {
            opened = true;
            throw new Error("must not open");
          },
        };
      },
    },
    { platform: "linkedin", url: "https://www.linkedin.com/jobs/search/?keywords=platform" },
    { resolvePublicTargetImpl: resolvePublic }
  );

  assert.equal(opened, false);
  assert.equal(result.state, "needs-user");
  assert.match(result.summary, /can't safely use the Orca browser/i);
  assert.doesNotMatch(result.summary, /permission|consent|settings/i);
});

test("authenticated source handoff refuses a private DNS target before creating a browser session", async () => {
  let sessionRequests = 0;
  const result = await openAuthenticatedSource(
    {
      get() {
        sessionRequests += 1;
        return { available: true };
      },
    },
    { platform: "indeed", url: "https://jobs.example.test/search" },
    {
      resolvePublicTargetImpl: async () => ({
        ok: false,
        reason: "host resolved to a private, local, or non-public address",
      }),
    }
  );

  assert.equal(sessionRequests, 0);
  assert.equal(result.state, "needs-user");
  assert.match(result.summary, /public job-site URL/i);
});

test("authenticated source handoff refuses a redirect that lands on a private target", async () => {
  const result = await openAuthenticatedSource(
    {
      get() {
        return {
          available: true,
          async open() {
            return { url: "http://127.0.0.1:7777/admin", title: "Admin", text: "private" };
          },
        };
      },
    },
    { platform: "linkedin", url: "https://jobs.example.test/search" },
    {
      resolvePublicTargetImpl: async (rawUrl) =>
        String(rawUrl).includes("127.0.0.1")
          ? { ok: false, reason: "private or local host is not fetchable" }
          : { ok: true, url: new URL(rawUrl).toString() },
    }
  );

  assert.equal(result.state, "needs-user");
  assert.match(result.summary, /public job-site URL/i);
});
