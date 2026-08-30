import assert from "node:assert/strict";
import { join } from "node:path";
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

test("browser session manager keeps a server-selected provider separate from the configured session", async () => {
  const created = [];
  const manager = createBrowserSessionManager({
    createSessionImpl: (options) => {
      created.push(options);
      return { available: true, async close() {} };
    },
  });

  const configured = manager.get({ platform: "linkedin" });
  const careerRatBrowser = manager.get({ platform: "linkedin", provider: "playwright" });

  assert.notEqual(careerRatBrowser, configured);
  assert.equal(manager.get({ platform: "linkedin", provider: "playwright" }), careerRatBrowser);
  assert.deepEqual(created, [
    { platform: "linkedin" },
    { platform: "linkedin", provider: "playwright" },
  ]);
  await manager.shutdown();
});

test("browser session manager keeps hidden and visible Playwright sessions separate", async () => {
  const created = [];
  const manager = createBrowserSessionManager({
    createSessionImpl: (options) => {
      created.push(options);
      return { available: true, async close() {} };
    },
  });

  const hidden = manager.get({ platform: "linkedin", provider: "playwright", headless: true });
  const visible = manager.get({ platform: "linkedin", provider: "playwright", headless: false });

  assert.notEqual(hidden, visible);
  assert.equal(
    manager.get({ platform: "linkedin", provider: "playwright", headless: true }),
    hidden
  );
  assert.equal(
    manager.get({ platform: "linkedin", provider: "playwright", headless: false }),
    visible
  );
  assert.deepEqual(created, [
    { platform: "linkedin", provider: "playwright", headless: true },
    { platform: "linkedin", provider: "playwright", headless: false },
  ]);
  await manager.shutdown();
});

test("configured sessions expose whether every network request has a pinned public boundary", () => {
  const playwright = createConfiguredBrowserSession({
    repoRoot: "/repo",
    env: {},
    platform: "linkedin",
    loadAutomationImpl: () => ({ data: { session: { provider: "playwright" } } }),
    launchImpl: async () => ({ close: async () => {} }),
  });
  const orca = createConfiguredBrowserSession({
    repoRoot: "/repo",
    env: {},
    platform: "linkedin",
    loadAutomationImpl: () => ({ data: { session: { provider: "orca" } } }),
    runOrcaImpl: async () => ({}),
  });

  assert.equal(playwright.networkBoundary, "pinned-public-http");
  assert.equal(orca.networkBoundary, "untrusted");
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
  assert.equal(
    launchOptions.profileDir,
    "/tmp/careerrat-browser-channel-test/profiles/gmail",
    "an explicit session.profile_root must remain authoritative"
  );
  await session.close();
});

test("configured Playwright sessions forward an explicit public-target resolver", async () => {
  let routeHandler = null;
  let resolverCalls = 0;
  let continued = false;
  let aborted = false;
  const page = {
    async goto() {},
    url: () => "http://127.0.0.1/fixture",
    title: async () => "Fixture",
    locator: () => ({ innerText: async () => "Fixture" }),
  };
  const session = createConfiguredBrowserSession({
    repoRoot: "/tmp/careerrat-browser-resolver-test",
    env: {},
    platform: "gmail",
    headless: true,
    loadAutomationImpl: () => ({
      data: {
        session: {
          provider: "playwright",
          profile_root: "/tmp/careerrat-browser-resolver-test/profiles",
        },
      },
    }),
    launchImpl: async () => ({
      async route(_pattern, handler) {
        routeHandler = handler;
      },
      newPage: async () => page,
      close: async () => {},
    }),
    resolvePublicTargetImpl: async (rawUrl) => {
      resolverCalls += 1;
      return { ok: true, url: new URL(rawUrl).toString() };
    },
  });

  await session.open("http://127.0.0.1/fixture");
  await routeHandler({
    request: () => ({
      url: () => "http://127.0.0.1/fixture",
      isNavigationRequest: () => true,
      frame: () => ({}),
    }),
    continue: async () => {
      continued = true;
    },
    abort: async () => {
      aborted = true;
    },
  });

  assert.equal(resolverCalls, 1);
  assert.equal(continued, true);
  assert.equal(aborted, false);
  await session.close();
});

test("configured Playwright sessions isolate default profiles by CareerRat home", async () => {
  async function launchedProfileDir(dataRoot) {
    let launchOptions = null;
    const page = {
      async goto() {},
      url: () => "http://127.0.0.1/fixture",
      title: async () => "Fixture",
      locator: () => ({ innerText: async () => "Fixture" }),
    };
    const session = createConfiguredBrowserSession({
      repoRoot: "/repo",
      env: { CAREERRAT_HOME: dataRoot },
      platform: "linkedin",
      headless: true,
      loadAutomationImpl: () => ({ data: { session: { provider: "playwright" } } }),
      launchImpl: async (options) => {
        launchOptions = options;
        return {
          newPage: async () => page,
          close: async () => {},
        };
      },
    });

    await session.open("http://127.0.0.1/fixture");
    await session.close();
    return launchOptions.profileDir;
  }

  const first = await launchedProfileDir("/private/candidate-a");
  const second = await launchedProfileDir("/private/candidate-b");

  assert.equal(first, join("/private/candidate-a", "board-profiles", "linkedin"));
  assert.equal(second, join("/private/candidate-b", "board-profiles", "linkedin"));
  assert.notEqual(first, second);
});
