import { createOrcaOps, runOrcaCommand } from "../apply/orca-ops.mjs";
import { createPlaywrightOps } from "../apply/playwright-ops.mjs";
import { loadAutomation } from "./consent.mjs";
import { PROVIDERS, profilePath, resolveSession } from "./session.mjs";

const LOGIN_URL =
  /(?:accounts\.google\.com|login\.live\.com|login\.microsoftonline\.com|\/authwall(?:[/?#]|$)|\/(?:login|signin)(?:[/?#]|$))/i;
const VERIFICATION_URL = /\/(?:checkpoint|challenge)(?:[/?#]|$)/i;
const LOGIN_PROMPT = /\b(?:sign in|log in|choose an account)\b/i;
const LOGIN_CONTROL =
  /\b(?:password|email address|phone number|forgot password|use your .+ account)\b/i;
const VERIFICATION_PROMPT =
  /\b(?:two[- ](?:factor|step)|security verification|verify (?:it'?s|your) you|enter the (?:security )?code|approve (?:the )?sign[- ]in)\b/i;
const CHALLENGE_PROMPT = /\b(?:captcha|are you a robot)\b/i;

function unavailable(provider, reason) {
  return {
    available: false,
    provider,
    reason,
    async close() {},
  };
}

function wrapOps(ops, provider) {
  let pageId = null;
  return {
    available: true,
    provider,
    get pageId() {
      return pageId;
    },
    async open(url) {
      if (pageId) {
        await ops.navigate({ pageId, url });
      } else {
        const opened = await ops.openTab({ url });
        pageId = opened.pageId;
      }
      return this.pageContent();
    },
    async navigate(url) {
      if (!pageId) return this.open(url);
      await ops.navigate({ pageId, url });
      return this.pageContent();
    },
    async back() {
      if (!pageId) throw new Error("No browser page is open.");
      await ops.back({ pageId });
      return this.pageContent();
    },
    async pageContent(options = {}) {
      if (!pageId) throw new Error("No browser page is open.");
      return ops.pageContent({ pageId, ...options });
    },
    async extractText(options = {}) {
      if (!pageId) throw new Error("No browser page is open.");
      return ops.extractText({ pageId, ...options });
    },
    async extractRows(options = {}) {
      if (!pageId) throw new Error("No browser page is open.");
      return ops.extractRows({ pageId, ...options });
    },
    async clickRow(options = {}) {
      if (!pageId) throw new Error("No browser page is open.");
      await ops.clickRow({ pageId, ...options });
      return this.pageContent();
    },
    async scroll(amount) {
      if (!pageId) throw new Error("No browser page is open.");
      await ops.scroll({ pageId, amount });
      return this.pageContent();
    },
    async close() {
      pageId = null;
      await ops.close?.();
    },
  };
}

export function classifyBrowserAuthState(page = {}) {
  const url = String(page.url || "");
  const text = `${page.title || ""}\n${String(page.text || "").slice(0, 4_000)}`;
  let state = null;
  if (CHALLENGE_PROMPT.test(text)) state = "challenge_required";
  else if (VERIFICATION_URL.test(url) || VERIFICATION_PROMPT.test(text)) {
    state = "verification_required";
  } else if (LOGIN_URL.test(url) || (LOGIN_PROMPT.test(text) && LOGIN_CONTROL.test(text))) {
    state = "auth_required";
  }
  if (!state) return null;
  return {
    state,
    message:
      "Sign in or finish the visible verification step in the CareerRat browser, then retry this workflow.",
  };
}

function createPlaywrightBrowserSession({
  profileDir,
  launchImpl,
  headless = false,
  channel,
  resolvePublicTargetImpl,
} = {}) {
  return wrapOps(
    createPlaywrightOps({
      profileDir,
      launchImpl,
      headless,
      channel,
      ...(resolvePublicTargetImpl ? { resolvePublicTargetImpl } : {}),
    }),
    "playwright"
  );
}

function createOrcaBrowserSession({ repoRoot, env = process.env, runOrcaImpl } = {}) {
  const run = runOrcaImpl || ((args) => runOrcaCommand(args, { env, cwd: repoRoot }));
  return wrapOps(createOrcaOps({ runOrcaImpl: run }), "orca");
}

export function createConfiguredBrowserSession({
  repoRoot,
  env = process.env,
  platform,
  loadAutomationImpl = loadAutomation,
  launchImpl,
  runOrcaImpl,
  headless = false,
  channel,
  resolvePublicTargetImpl,
} = {}) {
  let data;
  try {
    data = loadAutomationImpl({ root: repoRoot, env }).data;
  } catch (error) {
    return unavailable("unknown", `Automation settings could not be read: ${error.message}`);
  }
  const resolved = resolveSession({ data, repoRoot, env });
  if (resolved.provider === "playwright") {
    return createPlaywrightBrowserSession({
      profileDir: profilePath(platform, {
        profileRoot: data?.session?.profile_root || resolved.profileRoot,
        repoRoot,
        env,
      }),
      launchImpl,
      headless,
      channel,
      resolvePublicTargetImpl,
    });
  }
  if (resolved.provider === "orca") {
    return createOrcaBrowserSession({ repoRoot, env, runOrcaImpl });
  }
  return unavailable(
    resolved.provider,
    `${PROVIDERS[resolved.provider]?.label || resolved.provider} has no callable app-owned browser surface. Choose Playwright or Orca in Settings.`
  );
}

export function createBrowserSessionManager({
  createSessionImpl = createConfiguredBrowserSession,
  defaults = {},
} = {}) {
  const sessions = new Map();
  return {
    get(options = {}) {
      const platform = String(options.platform || "default");
      if (sessions.has(platform)) return sessions.get(platform);
      const session = createSessionImpl({ ...defaults, ...options, platform });
      if (!session?.available) return session;
      const close = session.close.bind(session);
      session.close = async () => {
        if (sessions.get(platform) === session) sessions.delete(platform);
        await close();
      };
      sessions.set(platform, session);
      return session;
    },
    async shutdown() {
      const active = [...sessions.values()];
      sessions.clear();
      await Promise.allSettled(active.map((session) => session.close()));
    },
  };
}
