import assert from "node:assert/strict";
import { test } from "node:test";

import {
  classifyBrowserAuthState,
  createBrowserSessionManager,
  createConfiguredBrowserSession,
} from "../src/core/automation/browser-session.mjs";

test("auth classification ignores ordinary signed-in content that mentions signing in", () => {
  assert.equal(
    classifyBrowserAuthState({
      url: "https://mail.google.com/mail/u/0/#inbox",
      title: "Inbox",
      text: "Acme Security\nSign in to your new employee portal by Friday.",
    }),
    null
  );
});

test("auth classification recognizes provider login and verification walls", () => {
  assert.equal(
    classifyBrowserAuthState({
      url: "https://accounts.google.com/v3/signin/identifier",
      title: "Sign in",
      text: "Use your Google Account",
    })?.state,
    "auth_required"
  );
  assert.equal(
    classifyBrowserAuthState({
      url: "https://www.linkedin.com/checkpoint/challenge/",
      title: "Security verification",
      text: "Enter the code we sent to your phone",
    })?.state,
    "verification_required"
  );
});

test("browser session manager reuses one platform session until it closes", async () => {
  let creates = 0;
  let closes = 0;
  const manager = createBrowserSessionManager({
    createSessionImpl: ({ platform }) => {
      creates += 1;
      return {
        available: true,
        platform,
        async close() {
          closes += 1;
        },
      };
    },
  });

  const first = manager.get({ platform: "gmail" });
  const retry = manager.get({ platform: "gmail" });
  assert.equal(first, retry);
  assert.equal(creates, 1);

  await retry.close();
  assert.equal(closes, 1);
  assert.notEqual(manager.get({ platform: "gmail" }), first);
  await manager.shutdown();
  assert.equal(closes, 2);
});

test("configured Playwright sessions forward an explicit browser channel", async () => {
  let launchOptions = null;
  const page = {
    async goto() {},
    url: () => "http://127.0.0.1/fixture",
    title: async () => "Fixture",
    locator: () => ({ innerText: async () => "Fixture" }),
  };
  const session = createConfiguredBrowserSession({
    repoRoot: "/tmp/careerrat-browser-channel-test",
    env: {},
    platform: "gmail",
    channel: "chrome",
    headless: true,
    loadAutomationImpl: () => ({
      data: {
        session: {
          provider: "playwright",
          profile_root: "/tmp/careerrat-browser-channel-test/profiles",
        },
      },
    }),
    launchImpl: async (options) => {
      launchOptions = options;
      return {
        newPage: async () => page,
        close: async () => {},
      };
    },
  });

  await session.open("http://127.0.0.1/fixture");
  assert.equal(launchOptions.channel, "chrome");
  await session.close();
});
