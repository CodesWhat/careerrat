import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

async function loadFirstRun() {
  return import("./FirstRunExperience.jsx");
}

function textOf(node) {
  if (node == null || typeof node === "boolean") return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textOf).join("");
  return textOf(node.props?.children);
}

function findElement(node, predicate) {
  if (node == null || typeof node === "boolean") return null;
  if (Array.isArray(node)) {
    for (const child of node) {
      const match = findElement(child, predicate);
      if (match) return match;
    }
    return null;
  }
  if (typeof node !== "object") return null;
  if (predicate(node)) return node;
  return findElement(node.props?.children, predicate);
}

function findElements(node, predicate, matches = []) {
  if (node == null || typeof node === "boolean") return matches;
  if (Array.isArray(node)) {
    for (const child of node) findElements(child, predicate, matches);
    return matches;
  }
  if (typeof node !== "object") return matches;
  if (predicate(node)) matches.push(node);
  findElements(node.props?.children, predicate, matches);
  return matches;
}

const ENGINES = [
  {
    id: "claude",
    name: "Claude Code",
    supported: true,
    detected: true,
    ready: true,
    selectable: true,
    capabilityTier: "task_tools",
    capabilities: { completion: true, taskTools: true, research: true },
  },
  {
    id: "codex",
    name: "Codex",
    supported: true,
    detected: true,
    ready: true,
    selectable: false,
    capabilityTier: "detected_unverified",
    capabilities: { completion: false },
  },
];

const MESSAGES = [
  {
    id: "m1",
    role: "assistant",
    text: "One question at a time. First: what kind of role are you actually after?",
    options: [{ id: "staff-ml", label: "Staff SWE · ML infra" }],
  },
  { id: "m2", role: "user", text: "Staff SWE, ML infrastructure." },
  {
    id: "m3",
    role: "assistant",
    text: "I found two facts.\n\n\nWhat notice period do you need?",
    blocks: [
      { kind: "candidate_patch", summary: "New York City and US-remote only" },
      {
        kind: "evidence_claim",
        summary: "Cut production deploy time from 42 minutes to 11 minutes",
      },
    ],
    options: [
      { id: "confirm:0", label: "Save this" },
      { id: "decline:0", label: "Change it" },
      { id: "confirm:1", label: "Save this" },
      { id: "decline:1", label: "Change it" },
    ],
  },
];

describe("FirstRunExperience", () => {
  it("uses an ink-only selected rail item with no lime surround or avatar tile", () => {
    const css = readFileSync(fileURLToPath(new URL("./first-run.css", import.meta.url)), "utf8");
    const rule = css.match(/\.cf-first-run__paul-card\s*\{([^}]*)\}/)?.[1] || "";
    const avatarRule = css.match(/\.cf-first-run__rail-avatar\s*\{([^}]*)\}/)?.[1] || "";

    expect(rule).toMatch(/background:\s*var\(--cf-selection-fill\)/);
    expect(rule).toMatch(/border:\s*var\(--cf-selection-border\)/);
    expect(rule).toMatch(/box-shadow:\s*var\(--cf-selection-shadow\)/);
    expect(rule).toMatch(/outline:\s*var\(--cf-selection-outline\)/);
    expect(rule).not.toMatch(/#e6fa8d|rgba\(230,\s*250,\s*141/);
    expect(avatarRule).toMatch(/background:\s*var\(--cf-selection-avatar-surface\)/);
  });

  it("keeps the guided installer action readable over its ink fill", () => {
    const css = readFileSync(fileURLToPath(new URL("./first-run.css", import.meta.url)), "utf8");
    const rule =
      css.match(/\.cf-first-run__engine\s+\.cf-first-run__guided-action\s*\{([^}]*)\}/)?.[1] || "";

    expect(rule).toMatch(/background:\s*var\(--ink\)/);
    expect(rule).toMatch(/color:\s*var\(--paper\)/);
  });

  it("uses the fixed chat-first top bar and workspace frame during setup", async () => {
    const { FirstRunShell } = await loadFirstRun();
    const onOpenSettings = vi.fn();
    const tree = FirstRunShell({
      agentName: "Paul",
      onOpenSettings,
      children: <div data-stage="engine">Engine selection</div>,
    });
    const topBar = tree.props.children[0].type(tree.props.children[0].props);
    topBar.props.children[1].props.children[0].props.onClick();

    const html = renderToStaticMarkup(tree);
    expect(html).toContain('class="chat-first-workspace cf-first-run-shell"');
    expect(html).toContain('class="chat-first-topbar"');
    expect(html).toContain("CareerRat");
    expect(html).toContain("Profile &amp; settings");
    expect(html).not.toContain("Open activity");
    expect(html).toContain('class="cf-first-run-shell__body"');
    expect(html).toContain('data-stage="engine"');
    expect(onOpenSettings).toHaveBeenCalledOnce();
  });

  it("renders detected engine choices and delegates the selection", async () => {
    const { FirstRunExperience } = await loadFirstRun();
    const onSelectEngine = vi.fn();
    const tree = FirstRunExperience({
      stage: "engine",
      agentName: "Paul",
      engines: ENGINES.map((engine) => ({
        ...engine,
        selected: engine.id === "claude",
      })),
      onChooseEngine: onSelectEngine,
      onStartInterview: vi.fn(),
    });
    const html = renderToStaticMarkup(tree);

    expect(html).toContain("Pick your engine.");
    expect(html).toContain("We found 2 AI tools on this computer.");
    expect(html).toContain("Every choice shown here runs the complete CareerRat workflow.");
    expect(html).toContain("Claude Code");
    expect(html).toContain(">READY</span>");
    expect(html).toContain("UNAVAILABLE");
    expect(html).not.toMatch(/not yet supported/i);
    expect(html).toContain('<fieldset class="cf-first-run__engine-choices">');
    expect(html).toContain(
      '<legend class="cf-first-run__engine-legend">Detected AI tools</legend>'
    );
    expect(html).toContain("Start the interview");
    expect(html).not.toContain("RECOMMENDED");

    const choice = findElement(
      tree,
      (node) => node.type?.name === "DetectedEngine" && node.props.engine.id === "claude"
    );
    choice.type(choice.props).props.onClick();
    expect(onSelectEngine).toHaveBeenCalledWith("claude");
  });

  it("marks the configured engine as selected without a separate accent tile", async () => {
    const { FirstRunExperience } = await loadFirstRun();
    const html = renderToStaticMarkup(
      <FirstRunExperience stage="engine" engines={[{ ...ENGINES[0], selected: true }]} />
    );

    expect(html).toContain('aria-pressed="true"');
  });

  it("keeps unaccepted runtime adapters out of the engine inventory", async () => {
    const { FirstRunExperience } = await loadFirstRun();
    const html = renderToStaticMarkup(
      <FirstRunExperience
        stage="engine"
        engines={[
          ...ENGINES,
          { id: "gemini", name: "Gemini CLI", detected: false, ready: false },
          { id: "opencode", name: "OpenCode", detected: false, ready: false },
          {
            id: "copilot",
            name: "GitHub Copilot CLI",
            detected: false,
            ready: false,
          },
        ]}
      />
    );

    expect(html).toContain("Claude Code");
    expect(html).toContain("Codex");
    expect(html).not.toContain("NOT INSTALLED");
    expect(html).not.toContain("Gemini CLI");
    expect(html).not.toContain("OpenCode");
    expect(html).not.toContain("GitHub Copilot CLI");
  });

  it("starts sign-in for an installed engine without sending a beginner into Settings", async () => {
    const { FirstRunExperience } = await loadFirstRun();
    const onSelectEngine = vi.fn();
    const onRetryEngine = vi.fn();
    const onStartEngineSignIn = vi.fn();
    const tree = FirstRunExperience({
      stage: "engine",
      agentName: "Maya",
      engines: [
        {
          id: "claude",
          name: "Claude Code",
          supported: true,
          detected: true,
          ready: false,
          selectable: false,
          status: "authentication_required",
          action: "start_sign_in",
        },
        {
          id: "codex",
          name: "Codex",
          supported: true,
          detected: false,
          ready: false,
          status: "not_found",
        },
      ],
      error: "Runtime check failed.",
      onSelectEngine,
      onRetryEngine,
      onStartEngineSignIn,
    });
    const html = renderToStaticMarkup(tree);

    expect(html).toContain("Pick your engine.");
    expect(html).toContain("AUTH REQUIRED");
    expect(html).toContain("Detected on this computer. Sign in before CareerRat can use it.");
    expect(html).not.toContain("account already signed in");
    expect(html).toContain("Sign in");
    expect(html).toContain("Set up another supported AI tool");
    expect(html).toContain("Install guide");
    expect(html).toContain("Runtime check failed.");
    expect(html).toContain("Check again");

    const claude = findElement(
      tree,
      (node) => node.type?.name === "DetectedEngine" && node.props.engine.id === "claude"
    );
    const claudeView = claude.type(claude.props);
    const retry = findElement(
      claudeView,
      (node) => node.type === "button" && textOf(node) === "Check again"
    );
    const signIn = findElement(
      claudeView,
      (node) => node.type === "button" && textOf(node) === "Sign in"
    );
    expect(claudeView.props["aria-disabled"]).toBeUndefined();
    signIn.props.onClick();
    retry.props.onClick();
    expect(onRetryEngine).toHaveBeenCalledWith("claude");
    expect(onStartEngineSignIn).toHaveBeenCalledWith("claude");
    expect(onSelectEngine).not.toHaveBeenCalled();
  });

  it("shows a failed completion check as a plain retry instead of Ready", async () => {
    const { FirstRunExperience } = await loadFirstRun();
    const onRetryEngine = vi.fn();
    const tree = FirstRunExperience({
      stage: "engine",
      engines: [
        {
          id: "codex",
          name: "Codex",
          supported: true,
          detected: true,
          ready: false,
          selectable: false,
          status: "completion_probe_failed",
          action: "retry",
          actionLabel: "Try again",
          probeMessage: "Codex is signed in, but it didn't return a usable test reply.",
        },
      ],
      onRetryEngine,
    });
    const html = renderToStaticMarkup(tree);
    const codex = findElement(
      tree,
      (node) => node.type?.name === "DetectedEngine" && node.props.engine.id === "codex"
    );
    const retry = findElement(
      codex.type(codex.props),
      (node) => node.type === "button" && textOf(node) === "Try again"
    );

    expect(html).toContain("didn&#x27;t return a usable test reply");
    expect(html).toContain("NEEDS A RETRY");
    expect(html).not.toContain(">READY</span>");
    retry.props.onClick();
    expect(onRetryEngine).toHaveBeenCalledWith("codex");
  });

  it("gives a first-time user a plain-English Claude setup path", async () => {
    const { FirstRunExperience } = await loadFirstRun();
    const onStartGuidedSetup = vi.fn();
    const onRefreshEngines = vi.fn();
    const tree = FirstRunExperience({
      stage: "engine",
      engines: [
        {
          id: "claude",
          name: "Claude Code",
          supported: true,
          detected: false,
          ready: false,
          installUrl: "https://code.claude.com/docs/en/quickstart",
        },
        {
          id: "codex",
          name: "Codex",
          supported: true,
          detected: false,
          ready: false,
          installUrl: "https://developers.openai.com/codex/cli/",
        },
      ],
      onStartGuidedSetup,
      onRefreshEngines,
    });
    const html = renderToStaticMarkup(tree);

    expect(html).toContain("Let’s get CareerRat ready.");
    expect(html).not.toContain("We found 0 AI tools");
    expect(html).toContain("New to AI tools? We’ll walk you through it.");
    expect(html).toContain("Claude Code needs a paid Claude plan. Pro is enough");
    expect(html).toContain("Get Claude through Scott’s referral");
    expect(html).toContain('href="https://claude.ai/referral/rOLHwxlsfA"');
    expect(html).not.toMatch(/curl|install\.sh|\| bash/i);
    expect(html).toContain("Install inside CareerRat");
    expect(html).toContain("Check setup");
    expect(html).toContain("Choose Claude Code or OpenAI Codex");
    expect(html).toContain("Set up OpenAI Codex instead");
    expect(html).not.toContain("You only need a Claude account");
    expect(html).not.toContain("Set up Claude");
    const alternateTools = html.match(
      /<details class="cf-first-run__engine-missing">.*<\/details>/
    )?.[0];
    expect(alternateTools).toContain("Codex");
    expect(alternateTools).not.toContain("Claude Code");
    expect(html).not.toContain("CareerRat AI");
    expect(html).not.toContain("Start the interview");
    expect(html).not.toContain("every runtime CareerRat knows");

    const guide = findElement(tree, (node) => node.type?.name === "ClaudeSetupGuide");
    const guideView = guide.type(guide.props);
    const start = findElement(
      guideView,
      (node) => node.type === "button" && textOf(node) === "Install inside CareerRat"
    );
    start.props.onClick();
    expect(onStartGuidedSetup).toHaveBeenCalledWith("claude");
  });

  it("shows installation progress inside the CareerRat window", async () => {
    const { FirstRunExperience } = await loadFirstRun();
    const onRefreshEngines = vi.fn();
    const tree = FirstRunExperience({
      stage: "engine",
      engines: [],
      guidedSetup: {
        runtimeId: "claude",
        status: "installing",
        lines: [
          "npm ERR! auth failed",
          "/Users/person/.npm/_logs/debug.log",
          "at install (/private/tmp/setup.js:42:9)",
        ],
      },
      onRefreshEngines,
    });
    const html = renderToStaticMarkup(tree);

    expect(html).toContain("Installing inside CareerRat");
    expect(html).toContain("CareerRat is installing Claude Code");
    expect(html).toContain("CareerRat setup");
    expect(html).not.toMatch(/npm|auth failed|\/Users\/person|private\/tmp|setup\.js/i);

    const guide = findElement(tree, (node) => node.type?.name === "ClaudeSetupGuide");
    const checkSetup = findElement(
      guide.type(guide.props),
      (node) => node.type === "button" && textOf(node) === "Check setup"
    );
    checkSetup.props.onClick();
    expect(onRefreshEngines).toHaveBeenCalledOnce();
  });

  it("offers a plain retry after the in-app installer fails", async () => {
    const { FirstRunExperience } = await loadFirstRun();
    const onStartGuidedSetup = vi.fn();
    const tree = FirstRunExperience({
      stage: "engine",
      engines: [],
      guidedSetup: {
        runtimeId: "claude",
        status: "failed",
        lines: [
          "SSE stream closed with 401 Unauthorized",
          "npm ERR! /Users/person/.npm/_logs/debug.log",
        ],
      },
      onStartGuidedSetup,
    });
    const html = renderToStaticMarkup(tree);

    expect(html).toContain("CareerRat couldn&#x27;t finish installing Claude Code");
    expect(html).toContain("Nothing in your setup was lost");
    expect(html).not.toMatch(/SSE|401|Unauthorized|npm|\/Users\/person/i);
    expect(html).toContain("RETRY");
    const guide = findElement(tree, (node) => node.type?.name === "ClaudeSetupGuide");
    const retry = findElement(
      guide.type(guide.props),
      (node) => node.type === "button" && textOf(node) === "Try installation again"
    );
    retry.props.onClick();
    expect(onStartGuidedSetup).toHaveBeenCalledWith("claude");
  });

  it("does not loop back into an unavailable in-app installer", async () => {
    const { FirstRunExperience } = await loadFirstRun();
    const onStartGuidedSetup = vi.fn();
    const onRefreshEngines = vi.fn();
    const tree = FirstRunExperience({
      stage: "engine",
      engines: [],
      guidedSetup: { runtimeId: "claude", status: "unavailable" },
      onStartGuidedSetup,
      onRefreshEngines,
    });
    const html = renderToStaticMarkup(tree);
    const guide = findElement(tree, (node) => node.type?.name === "ClaudeSetupGuide");
    const checkSetup = findElement(
      guide.type(guide.props),
      (node) => node.type === "button" && textOf(node) === "Check setup"
    );

    expect(html).toContain("In-app installation isn&#x27;t available here");
    expect(html).toContain("Install Claude Code from its setup guide");
    expect(html).toContain("finish installation, then choose Check setup");
    expect(html).not.toContain("Let CareerRat install Claude Code");
    expect(html).not.toContain("CareerRat can install Claude Code here");
    expect(html).toContain('href="https://code.claude.com/docs/en/quickstart"');
    expect(html).toContain("Open Claude setup guide");
    expect(html).not.toContain("Try installation again");
    expect(html).toContain(">SETUP</span>");
    expect(html).not.toContain(">RETRY</span>");
    checkSetup.props.onClick();
    expect(onRefreshEngines).toHaveBeenCalledOnce();
    expect(onStartGuidedSetup).not.toHaveBeenCalled();
  });

  it("retries inventory discovery from the empty state", async () => {
    const { FirstRunExperience } = await loadFirstRun();
    const onRefreshEngines = vi.fn();
    const tree = FirstRunExperience({
      stage: "engine",
      engines: [],
      onRefreshEngines,
    });
    const guide = findElement(tree, (node) => node.type?.name === "ClaudeSetupGuide");
    const checkAgain = findElement(
      guide.type(guide.props),
      (node) => node.type === "button" && textOf(node) === "Check setup"
    );

    expect(checkAgain).not.toBeNull();
    checkAgain.props.onClick();
    expect(onRefreshEngines).toHaveBeenCalledOnce();
  });

  it("keeps a detected runtime without a secure tool boundary visible but not selectable", async () => {
    const { FirstRunExperience } = await loadFirstRun();
    const onSelectEngine = vi.fn();
    const tree = FirstRunExperience({
      stage: "engine",
      engines: [
        {
          id: "codex",
          name: "Codex",
          supported: true,
          detected: true,
          ready: true,
          selectable: false,
          selected: true,
          capabilityTier: "detected_unverified",
          capabilities: { completion: false },
          capabilityReason: "Detected, but CareerRat cannot safely use this CLI for tool runs yet.",
        },
      ],
      onChooseEngine: onSelectEngine,
    });
    const html = renderToStaticMarkup(tree);
    const runtime = findElement(
      tree,
      (node) => node.type?.name === "DetectedEngine" && node.props.engine.id === "codex"
    );
    const runtimeView = runtime.type(runtime.props);
    const start = findElement(
      tree,
      (node) => node.type === "button" && textOf(node).includes("Start the interview")
    );

    expect(html).toContain("cannot safely use this CLI");
    expect(runtimeView.type).toBe("article");
    expect(start.props.disabled).toBe(true);
    expect(onSelectEngine).not.toHaveBeenCalled();
  });

  it("does not expose internal capability tiers for a supported ready runtime", async () => {
    const { FirstRunExperience } = await loadFirstRun();
    const tree = FirstRunExperience({
      stage: "engine",
      engines: [
        {
          id: "codex",
          name: "Codex",
          supported: true,
          detected: true,
          ready: true,
          selectable: true,
          capabilityTier: "chat_drafting",
          capabilities: { completion: true },
        },
      ],
    });
    const html = renderToStaticMarkup(tree);

    expect(html).toContain(">READY</span>");
    expect(html).toContain("Ready to run the complete CareerRat workflow with Codex.");
    expect(html).not.toMatch(/chat and drafting|task tools|capabilit/i);
  });

  it("keeps custom commands unavailable and collects CareerRat AI access interest inline", async () => {
    const { FirstRunExperience } = await loadFirstRun();
    const onHostedInterestStart = vi.fn();
    const idleTree = FirstRunExperience({
      stage: "engine",
      engines: ENGINES,
      hostedInterest: { status: "idle", email: "", error: null },
      onHostedInterestStart,
    });
    const tree = idleTree;
    const html = renderToStaticMarkup(tree);
    const hostedCard = findElement(tree, (node) => node.type?.name === "HostedInterestCard");
    const hostedCardView = hostedCard.type(hostedCard.props);

    expect(html).not.toContain("Custom command");
    expect(html).toContain("CareerRat AI");
    expect(html).toContain("COMING SOON");
    const requestAccess = findElement(
      hostedCardView,
      (node) => node.type === "button" && textOf(node) === "Request access"
    );
    expect(requestAccess.props.disabled).not.toBe(true);
    requestAccess.props.onClick();
    expect(onHostedInterestStart).toHaveBeenCalledOnce();

    const onHostedInterestChange = vi.fn();
    const onHostedInterestSubmit = vi.fn();
    const editingTree = FirstRunExperience({
      stage: "engine",
      engines: ENGINES,
      hostedInterest: {
        status: "error",
        email: "person@example.com",
        error: "Try again.",
      },
      onHostedInterestChange,
      onHostedInterestSubmit,
    });
    const editingCard = findElement(
      editingTree,
      (node) => node.type?.name === "HostedInterestCard"
    );
    const editingCardView = editingCard.type(editingCard.props);
    const input = findElement(
      editingCardView,
      (node) => node.type === "input" && node.props.type === "email"
    );
    const form = findElement(
      editingCardView,
      (node) => node.type === "form" && node.props.className === "cf-first-run__hosted-form"
    );
    expect(input.props.value).toBe("person@example.com");
    expect(renderToStaticMarkup(editingTree)).toContain("Try again.");
    input.props.onChange({ target: { value: "next@example.com" } });
    form.props.onSubmit({ preventDefault: vi.fn() });
    expect(onHostedInterestChange).toHaveBeenCalledWith("next@example.com");
    expect(onHostedInterestSubmit).toHaveBeenCalledOnce();

    const requestedHtml = renderToStaticMarkup(
      <FirstRunExperience
        stage="engine"
        engines={ENGINES}
        hostedInterest={{ status: "requested", email: "", error: null }}
      />
    );
    expect(requestedHtml).toContain("REQUESTED ✓");
    expect(requestedHtml).toContain("Thanks, we’ll email you when it’s ready.");
  });

  it("uses the runtime icon-and-label row for CareerRat AI with a restrained rat mark", async () => {
    const { FirstRunExperience } = await loadFirstRun();
    const tree = FirstRunExperience({
      stage: "engine",
      engines: ENGINES,
      hostedInterest: { status: "idle", email: "", error: null },
    });
    const hostedCard = findElement(tree, (node) => node.type?.name === "HostedInterestCard");
    const hostedCardView = hostedCard.type(hostedCard.props);
    const identity = findElement(
      hostedCardView,
      (node) => node.props?.className === "cf-first-run__engine-identity"
    );

    expect(identity).not.toBeNull();
    const spacer = findElement(
      hostedCardView,
      (node) => node.props?.className === "cf-first-run__engine-spacer"
    );
    expect(spacer).not.toBeNull();
    expect(spacer.props["aria-hidden"]).toBe("true");
    const nameRow = findElement(
      identity,
      (node) => node.props?.className === "cf-first-run__engine-name"
    );
    expect(nameRow).not.toBeNull();
    const icon = findElement(nameRow, (node) =>
      String(node.props?.className || "")
        .split(" ")
        .includes("cf-runtime-icon")
    );
    expect(textOf(icon)).toBe("🐀");
    expect(icon.props["aria-hidden"]).toBe("true");
    expect(textOf(nameRow)).toContain("CareerRat AI");

    const css = readFileSync(fileURLToPath(new URL("./first-run.css", import.meta.url)), "utf8");
    const ratIconRule = css.match(/\.cf-runtime-icon--careerrat\s*\{([^}]*)\}/)?.[1] || "";
    expect(css).toMatch(
      /\.cf-first-run__engine-special \.cf-runtime-icon\s*\{[^}]*filter:\s*grayscale\(1\);[^}]*opacity:\s*0\.58;/s
    );
    expect(css).toMatch(
      /\.cf-first-run__engine-special\s*\{[^}]*grid-template-columns:\s*28px minmax\(0, 1fr\) auto auto;/s
    );
    expect(ratIconRule).toMatch(/width:\s*28px/);
    expect(ratIconRule).toMatch(/height:\s*28px/);
  });

  it("aligns the hosted access action with the email control while retaining its label", async () => {
    const { FirstRunExperience } = await loadFirstRun();
    const html = renderToStaticMarkup(
      <FirstRunExperience
        stage="engine"
        engines={ENGINES}
        hostedInterest={{ status: "editing", email: "person@example.com", error: null }}
      />
    );
    const css = readFileSync(fileURLToPath(new URL("./first-run.css", import.meta.url)), "utf8");
    const formRule = css.match(/\.cf-first-run__hosted-form\s*\{([^}]*)\}/)?.[1] || "";
    const labelRule = css.match(/\.cf-first-run__hosted-label-text\s*\{([^}]*)\}/)?.[1] || "";

    expect(html).toContain(
      '<span class="cf-first-run__hosted-label-text">Email for CareerRat AI access</span>'
    );
    expect(formRule).toMatch(/align-items:\s*end/);
    expect(labelRule).toMatch(/position:\s*absolute/);
    expect(labelRule).toMatch(/clip-path:\s*inset\(50%\)/);
  });

  it("requires a selected safe runtime before the interview can start", async () => {
    const { FirstRunExperience } = await loadFirstRun();
    const onStartInterview = vi.fn();
    const withoutSelection = FirstRunExperience({
      stage: "engine",
      engines: ENGINES,
      onStartInterview,
    });
    const disabledStart = findElement(
      withoutSelection,
      (node) => node.type === "button" && textOf(node).includes("Start the interview")
    );
    expect(disabledStart.props.disabled).toBe(true);

    const withSelection = FirstRunExperience({
      stage: "engine",
      engines: [{ ...ENGINES[0], selected: true }],
      onStartInterview,
    });
    const enabledStart = findElement(
      withSelection,
      (node) => node.type === "button" && textOf(node).includes("Start the interview")
    );
    expect(enabledStart.props.disabled).toBe(false);
    enabledStart.props.onClick();
    expect(onStartInterview).toHaveBeenCalledWith("claude");
  });

  it("renders the staged chat and What Paul knows from persisted setup data", async () => {
    const { FirstRunExperience } = await loadFirstRun();
    const html = renderToStaticMarkup(
      <FirstRunExperience
        stage="chat"
        agentName="Paul"
        messages={MESSAGES}
        knowledge={[
          {
            id: "targets",
            label: "TARGETS",
            status: "complete",
            lines: ["Staff Software Engineer", "ML infra · platform"],
          },
          { id: "comp", label: "COMPENSATION", status: "active", lines: [] },
        ]}
        // Complete sections collapse by default now, so "targets" is opened
        // explicitly to assert its body content still renders correctly.
        expandedKnowledgeSections={{ targets: true }}
        progress={{ completed: 1, total: 6 }}
        draft=""
      />
    );

    expect(html).toContain("Hey");
    expect(html).toContain("I&#x27;m Paul, your recruiter.");
    expect(html).toContain("JOB CONVERSATIONS");
    expect(html).toContain("unlock after your first sweep");
    expect(html).toContain("WHAT PAUL KNOWS");
    expect(html).toContain("1 of 6");
    expect(html).toContain("Staff Software Engineer");
    expect(html).toContain("answering now");
    expect(html).toContain("Updating What Paul knows");
    expect(html).toContain("I found two facts.\nWhat notice period do you need?");
    expect(html).not.toContain("I found two facts.\n\n");
    expect(html).not.toContain("New York City and US-remote only");
    expect(html).not.toContain("Cut production deploy time from 42 minutes to 11 minutes");
    expect(html).not.toContain("Save this");
    expect(html).not.toContain("Change it");
  });

  it("gives each populated knowledge section one Edit action for the whole section", async () => {
    const { FirstRunChat } = await loadFirstRun();
    const onEditKnowledgeSection = vi.fn();
    const roles = {
      id: "roles",
      label: "ROLES",
      status: "complete",
      lines: ["Staff Engineer", "Platform Lead"],
      editor: { fields: [] },
    };
    const quickFacts = {
      id: "quickFacts",
      label: "QUICK FACTS",
      status: "populated",
      lines: ["NYC", "US remote", "$210K floor"],
      editor: { fields: [] },
    };
    const tree = FirstRunChat({
      agentName: "Paul",
      messages: [],
      knowledge: [roles, quickFacts, { id: "evidence", label: "EVIDENCE", status: "pending" }],
      progress: { completed: 1, total: 3 },
      onEditKnowledgeSection,
      // "roles" is complete, so it collapses by default. Expand it up front
      // (the same state a header click leaves behind) so its Edit action and
      // checked lines are part of what this test can see.
      expandedKnowledgeSections: { roles: true },
    });
    const panelElement = tree.props.children[2];
    const panel = panelElement.type(panelElement.props);
    const panelHtml = renderToStaticMarkup(panel);
    // quickFacts is "populated", so it stays inline and reachable by the
    // plain element-tree walk. "roles" is "complete", so it renders through
    // the collapsible CompleteKnowledgeCard component and has to be invoked
    // directly to reach its (already-expanded) Edit button.
    const quickFactsEdit = findElement(
      panel,
      (node) => node.type === "button" && textOf(node) === "Edit"
    );
    const rolesCardElement = findElement(panel, (node) => node.props?.item?.id === "roles");
    const rolesTree = rolesCardElement.type(rolesCardElement.props);
    const rolesEdit = findElement(
      rolesTree,
      (node) => node.type === "button" && textOf(node) === "Edit"
    );

    expect(panelHtml).toContain("✓ Staff Engineer");
    expect(panelHtml).not.toContain("✓ NYC");
    quickFactsEdit.props.onClick();
    rolesEdit.props.onClick();
    expect(onEditKnowledgeSection.mock.calls).toEqual([[quickFacts], [roles]]);
  });

  it("renders a complete knowledge section collapsed with a Done pill and no visible body", async () => {
    const { FirstRunChat } = await loadFirstRun();
    const html = renderToStaticMarkup(
      <FirstRunChat
        agentName="Paul"
        messages={[]}
        knowledge={[
          {
            id: "engine",
            label: "ENGINE",
            status: "complete",
            lines: ["Claude Code · ready"],
            editor: { fields: [] },
          },
        ]}
        progress={{ completed: 1, total: 6 }}
      />
    );

    expect(html).toContain("ENGINE");
    expect(html).toContain('<span class="cf-first-run__knowledge-done">Done</span>');
    expect(html).toContain('aria-expanded="false"');
    expect(html).not.toContain("Claude Code · ready");
    expect(html).not.toContain(">Edit<");
  });

  it("clicking the header toggles the section and reveals the Edit action once expanded", async () => {
    const { FirstRunChat } = await loadFirstRun();
    const onToggleKnowledgeSection = vi.fn();
    const engine = {
      id: "engine",
      label: "ENGINE",
      status: "complete",
      lines: ["Claude Code · ready"],
      editor: { fields: [] },
    };
    const tree = FirstRunChat({
      agentName: "Paul",
      messages: [],
      knowledge: [engine],
      progress: { completed: 1, total: 6 },
      onToggleKnowledgeSection,
    });
    const panelElement = tree.props.children[2];
    const panel = panelElement.type(panelElement.props);
    const engineCardElement = findElement(panel, (node) => node.props?.item?.id === "engine");
    const engineTree = engineCardElement.type(engineCardElement.props);
    const toggle = findElement(
      engineTree,
      (node) =>
        node.type === "button" && node.props.className === "cf-first-run__knowledge-card-toggle"
    );
    toggle.props.onClick();
    expect(onToggleKnowledgeSection).toHaveBeenCalledWith("engine");

    // The click above only hands the section id to the controller, which owns
    // expandedKnowledgeSections and re-renders. Render that resulting state
    // directly to confirm the body (lines, Edit action, open chevron) shows
    // once expanded.
    const expandedHtml = renderToStaticMarkup(
      <FirstRunChat
        agentName="Paul"
        messages={[]}
        knowledge={[engine]}
        progress={{ completed: 1, total: 6 }}
        expandedKnowledgeSections={{ engine: true }}
      />
    );
    expect(expandedHtml).toContain("Claude Code · ready");
    expect(expandedHtml).toContain(">Edit<");
    expect(expandedHtml).toContain('aria-expanded="true"');
    expect(expandedHtml).toContain("cf-first-run__knowledge-chevron--open");
  });

  it("renders an incomplete section expanded with no Done pill and no toggle", async () => {
    const { FirstRunChat } = await loadFirstRun();
    const html = renderToStaticMarkup(
      <FirstRunChat
        agentName="Paul"
        messages={[]}
        knowledge={[
          {
            id: "comp",
            label: "COMPENSATION",
            status: "populated",
            lines: ["$210K floor"],
            editor: { fields: [] },
          },
        ]}
        progress={{ completed: 0, total: 6 }}
      />
    );

    expect(html).toContain("$210K floor");
    expect(html).not.toContain("cf-first-run__knowledge-done");
    expect(html).not.toContain("aria-expanded");
  });

  it("keeps explicit non-profile confirmation choices visible", async () => {
    const { FirstRunChat } = await loadFirstRun();
    const onChooseOption = vi.fn();
    const tree = FirstRunChat({
      agentName: "Paul",
      messages: [
        {
          id: "consent-1",
          role: "assistant",
          text: "Browser access needs your approval.",
          blocks: [{ kind: "consent_capability" }],
          options: [
            { id: "confirm:0", label: "Allow" },
            { id: "decline:0", label: "Not now" },
          ],
        },
      ],
      knowledge: [],
      progress: { completed: 0, total: 8 },
      onChooseOption,
    });
    const option = findElement(tree, (node) => node.type === "button" && textOf(node) === "Allow");

    expect(renderToStaticMarkup(tree)).toContain("Browser access needs your approval.");
    option.props.onClick();
    expect(onChooseOption).toHaveBeenCalledWith("consent-1", "confirm:0");
  });

  it("renders an accessible whole-section editor and delegates cancel and submit", async () => {
    const { KnowledgeSectionEditor } = await loadFirstRun();
    const item = {
      id: "roles",
      label: "Roles",
      editor: {
        fields: [
          {
            id: "titles",
            label: "Target role titles",
            type: "textarea",
            value: "Staff Engineer\nPlatform Lead",
          },
        ],
      },
    };
    const onCancel = vi.fn();
    const onSave = vi.fn();
    const tree = KnowledgeSectionEditor({
      agentName: "Maya",
      item,
      onCancel,
      onSave,
    });
    const html = renderToStaticMarkup(tree);

    expect(html).toContain('role="dialog"');
    expect(html).toContain('aria-modal="true"');
    expect(html).toContain("Edit Roles");
    expect(html).toContain("WHAT MAYA KNOWS");
    expect(html).toContain("Staff Engineer\nPlatform Lead");

    const cancel = findElement(tree, (node) => node.type === "button" && textOf(node) === "Cancel");
    const form = findElement(tree, (node) => node.type === "form");
    cancel.props.onClick();
    form.props.onSubmit({
      preventDefault: vi.fn(),
      currentTarget: {
        elements: {
          namedItem: (name) => (name === "titles" ? { value: "Principal Engineer" } : null),
        },
      },
    });

    expect(onCancel).toHaveBeenCalledOnce();
    expect(onSave).toHaveBeenCalledWith(item, { titles: "Principal Engineer" });
  });

  it("renders remote eligibility as one select and submits its chosen scope", async () => {
    const { KnowledgeSectionEditor } = await loadFirstRun();
    const item = {
      id: "quickFacts",
      label: "Quick facts",
      editor: {
        fields: [
          {
            id: "remoteScope",
            label: "Remote job eligibility",
            type: "select",
            value: "home-country",
            options: [
              { value: "off", label: "Not open to remote roles" },
              { value: "home-country", label: "Remote within my home country" },
              { value: "worldwide", label: "Remote worldwide" },
            ],
          },
        ],
      },
    };
    const onSave = vi.fn();
    const tree = KnowledgeSectionEditor({ item, onSave });
    const html = renderToStaticMarkup(tree);
    const form = findElement(tree, (node) => node.type === "form");

    expect(html).toContain("Remote job eligibility");
    expect(html).toContain("Remote within my home country");
    expect(html).toContain("Remote worldwide");
    form.props.onSubmit({
      preventDefault: vi.fn(),
      currentTarget: {
        elements: { namedItem: () => ({ value: "worldwide" }) },
      },
    });
    expect(onSave).toHaveBeenCalledWith(item, { remoteScope: "worldwide" });
  });

  it("renders the explicit keep-or-switch compensation mode for two saved floors", async () => {
    const { KnowledgeSectionEditor } = await loadFirstRun();
    const { buildFirstRunKnowledge } = await import("./first-run-controller.js");
    const knowledge = buildFirstRunKnowledge(
      {
        setupProgress: {
          completedCount: 0,
          total: 8,
          items: [{ key: "quickFacts", done: false }],
        },
        data: {
          profile: {
            compensation: { minimum_base: 50000, minimum_annual_earnings: 85000 },
          },
        },
      },
      { name: "Claude Code" }
    );
    const item = knowledge.items.find((entry) => entry.id === "quickFacts");
    const html = renderToStaticMarkup(<KnowledgeSectionEditor item={item} />);

    expect(html).toContain("How should CareerRat screen pay?");
    expect(html).toContain("Keep both floors");
    expect(html).toContain("Guaranteed base pay only");
    expect(html).toContain("Annual cash earnings only");
    expect(html).toContain("Minimum guaranteed base pay");
    expect(html).toContain("Minimum annual cash earnings");
  });

  it("accepts resume files from the conversation drop target and Resume section picker", async () => {
    const { FirstRunChat } = await loadFirstRun();
    const onResumeFile = vi.fn();
    const onEditKnowledgeSection = vi.fn();
    const resume = {
      id: "resume",
      label: "RESUME",
      status: "pending",
      lines: [],
      editor: {
        fields: [
          {
            id: "resumeText",
            label: "Resume text",
            type: "textarea",
            value: "",
          },
        ],
      },
    };
    const tree = FirstRunChat({
      agentName: "Paul",
      messages: [],
      knowledge: [resume],
      progress: { completed: 0, total: 8 },
      onResumeFile,
      onEditKnowledgeSection,
    });
    const conversation = tree.props.children[1];
    const file = { name: "resume.pdf", type: "application/pdf" };
    const preventDefault = vi.fn();
    conversation.props.onDragOver({ preventDefault });
    conversation.props.onDrop({
      preventDefault,
      dataTransfer: { files: [file] },
    });

    const panelElement = tree.props.children[2];
    const panel = panelElement.type(panelElement.props);
    const picker = findElement(
      panel,
      (node) => node.type === "input" && node.props?.type === "file"
    );
    const edit = findElement(panel, (node) => node.type === "button" && textOf(node) === "Edit");
    expect(renderToStaticMarkup(panel)).toContain("Drop resume");
    expect(picker.props.accept).toContain(".pdf");
    expect(picker.props.accept).toContain(".docx");
    picker.props.onChange({ target: { files: [file], value: "resume.pdf" } });
    edit.props.onClick();

    expect(preventDefault).toHaveBeenCalledTimes(2);
    expect(onResumeFile).toHaveBeenCalledTimes(2);
    expect(onResumeFile).toHaveBeenNthCalledWith(1, file);
    expect(onResumeFile).toHaveBeenNthCalledWith(2, file);
    expect(onEditKnowledgeSection).toHaveBeenCalledWith(resume);
  });

  it("shows resume upload progress and failures beside the composer", async () => {
    const { FirstRunChat } = await loadFirstRun();
    const html = renderToStaticMarkup(
      <FirstRunChat
        agentName="Paul"
        messages={[]}
        knowledge={[]}
        progress={{ completed: 0, total: 8 }}
        error="That resume could not be read."
        resumeUploading
        resumeUploadingName="resume.pdf"
      />
    );

    expect(html).toContain('role="alert"');
    expect(html).toContain("That resume could not be read.");
    expect(html).toContain('role="status"');
    expect(html).toContain("Reading resume.pdf");
  });

  it("shows a direct search retry action beside a failed onboarding search", async () => {
    const { FirstRunChat } = await loadFirstRun();
    const onRetrySearch = vi.fn();
    const tree = FirstRunChat({
      agentName: "Paul",
      messages: [],
      knowledge: [],
      progress: { completed: 8, total: 8 },
      error: "Your profile is saved, but the first job search couldn't start.",
      onRetrySearch,
    });
    const retry = findElement(
      tree,
      (node) => node.type === "button" && textOf(node) === "Retry search"
    );

    expect(retry).toBeTruthy();
    retry.props.onClick();
    expect(onRetrySearch).toHaveBeenCalledOnce();
  });

  it("offers the completed company review without replacing the active draft", async () => {
    const { FirstRunChat } = await loadFirstRun();
    const onOpenCompanyReview = vi.fn();
    const tree = FirstRunChat({
      agentName: "Paul",
      messages: [],
      knowledge: [],
      progress: { completed: 5, total: 8 },
      draft: "Keep this answer",
      companyReviewReady: true,
      onOpenCompanyReview,
    });
    const review = findElement(
      tree,
      (node) => node.type === "button" && textOf(node) === "Review companies"
    );
    const input = findElement(tree, (node) => node.type === "input" && node.props?.value);

    expect(input.props.value).toBe("Keep this answer");
    review.props.onClick();
    expect(onOpenCompanyReview).toHaveBeenCalledOnce();
  });

  it("keeps the voluntary-form choice local and offers leave blank as the skip", async () => {
    const { FirstRunExperience } = await loadFirstRun();
    const onChooseVoluntaryDefaults = vi.fn();
    const tree = FirstRunExperience({
      stage: "chat",
      agentName: "Paul",
      messages: [],
      knowledge: [],
      progress: { completed: 8, total: 8 },
      voluntaryDefaultsRequired: true,
      onChooseVoluntaryDefaults,
    });
    const html = renderToStaticMarkup(tree);

    expect(html).toContain('role="dialog"');
    expect(html).toContain("Optional application questions");
    expect(html).toContain("race, gender, disability, or veteran status");
    expect(html).toContain("This choice stays on this computer and isn’t shared with Paul.");

    const promptElement = findElement(
      tree,
      (node) => node.type?.name === "VoluntaryDefaultsPrompt"
    );
    const prompt = promptElement.type(promptElement.props);
    const leaveBlank = findElement(
      prompt,
      (node) => node.type === "button" && textOf(node) === "Leave them blank"
    );
    const decline = findElement(
      prompt,
      (node) => node.type === "button" && textOf(node) === "Choose decline when available"
    );
    leaveBlank.props.onClick();
    decline.props.onClick();

    expect(onChooseVoluntaryDefaults).toHaveBeenNthCalledWith(1, "leave_blank");
    expect(onChooseVoluntaryDefaults).toHaveBeenNthCalledWith(2, "decline_when_available");
  });

  it("shows a voluntary-defaults save failure inside the blocking dialog", async () => {
    const { FirstRunExperience } = await loadFirstRun();
    const html = renderToStaticMarkup(
      FirstRunExperience({
        stage: "voluntary-defaults",
        agentName: "Paul",
        error: "That application default could not be saved.",
      })
    );

    expect(html).toContain('role="alert"');
    expect(html).toContain("That application default could not be saved.");
  });

  it.each([
    ["ready", [{ ...ENGINES[0], selected: true }]],
    ["unavailable", [{ ...ENGINES[0], selected: false, ready: false, selectable: false }]],
  ])(
    "renders only the local upgrade dialog when the saved runtime is %s",
    async (_name, engines) => {
      const { FirstRunExperience } = await loadFirstRun();
      const html = renderToStaticMarkup(
        FirstRunExperience({
          stage: "voluntary-defaults",
          agentName: "Paul",
          engines,
          voluntaryDefaultsRequired: true,
        })
      );

      expect(html).toContain("Optional application questions");
      expect(html).not.toContain("Pick your engine");
      expect(html).not.toContain("Let’s get CareerRat ready");
      expect(html).not.toContain("setup conversation will continue here");
    }
  );

  it("keeps search retry reachable from the engine stage without starting the interview", async () => {
    const { FirstRunExperience } = await loadFirstRun();
    const onRetrySearch = vi.fn();
    const onStartInterview = vi.fn();
    const tree = FirstRunExperience({
      stage: "engine",
      engines: [{ ...ENGINES[0], selected: true }],
      error: "Your profile is saved, but the first job search couldn't start.",
      onRetrySearch,
      onStartInterview,
    });
    const retry = findElement(
      tree,
      (node) => node.type === "button" && textOf(node) === "Retry search"
    );

    expect(retry).toBeTruthy();
    retry.props.onClick();
    expect(onRetrySearch).toHaveBeenCalledOnce();
    expect(onStartInterview).not.toHaveBeenCalled();
  });

  it("presents assistant emphasis and headings without raw markdown controls", async () => {
    const { FirstRunChat } = await loadFirstRun();
    const html = renderToStaticMarkup(
      <FirstRunChat
        agentName="Paul"
        messages={[
          {
            id: "formatted",
            role: "assistant",
            text: "## Next step\n**First question:** what role are you after?\n- Staff frontend",
          },
        ]}
        knowledge={[]}
        progress={{ completed: 0, total: 8 }}
      />
    );

    expect(html).toContain("Next step\nFirst question: what role are you after?\n- Staff frontend");
    expect(html).not.toContain("## Next step");
    expect(html).not.toContain("**First question:**");
  });

  it("sends suggested and typed answers through actions without local demo progression", async () => {
    const { FirstRunChat } = await loadFirstRun();
    const onChooseOption = vi.fn();
    const onDraftChange = vi.fn();
    const onSubmitAnswer = vi.fn();
    const tree = FirstRunChat({
      agentName: "Paul",
      messages: MESSAGES,
      knowledge: [],
      progress: { completed: 0, total: 6 },
      draft: "platform roles",
      onChooseOption,
      onDraftChange,
      onSubmitAnswer,
    });
    const center = tree.props.children[1];
    const transcript = center.props.children[0];
    const option = findElement(
      transcript,
      (node) => node.type === "button" && textOf(node) === "Staff SWE · ML infra"
    );
    option.props.onClick();
    expect(onChooseOption).toHaveBeenCalledWith("m1", "staff-ml");

    const composer = findElement(
      center,
      (node) => node.type === "form" && node.props.className === "cf-first-run__composer"
    );
    composer.props.children[0].props.onChange({
      target: { value: "new answer" },
    });
    composer.props.onSubmit({ preventDefault: vi.fn() });
    expect(onDraftChange).toHaveBeenCalledWith("new answer");
    expect(onSubmitAnswer).toHaveBeenCalledWith("platform roles");
  });

  it("offers compact Yes and No answers only for the current typed binary question", async () => {
    const { FirstRunChat } = await loadFirstRun();
    const onSubmitAnswer = vi.fn();
    const tree = FirstRunChat({
      agentName: "Paul",
      messages: [
        {
          id: "binary",
          role: "assistant",
          text: "Are you authorized to work in the United States?",
          answerMode: "yes-no",
        },
      ],
      knowledge: [],
      progress: { completed: 0, total: 6 },
      submitting: true,
      onSubmitAnswer,
    });
    const buttons = findElements(
      tree,
      (node) => node.type === "button" && ["Yes", "No"].includes(textOf(node))
    );

    expect(buttons.map(textOf)).toEqual(["Yes", "No"]);
    expect(buttons.every((button) => button.props.disabled === true)).toBe(true);
    buttons[0].props.onClick();
    expect(onSubmitAnswer).toHaveBeenCalledWith("Yes");

    const answered = renderToStaticMarkup(
      <FirstRunChat
        messages={[
          {
            id: "binary",
            role: "assistant",
            text: "Are you authorized to work in the United States?",
            answerMode: "yes-no",
          },
          { id: "answer", role: "user", text: "Yes" },
        ]}
        knowledge={[]}
        progress={{ completed: 0, total: 6 }}
      />
    );
    const ordinary = renderToStaticMarkup(
      <FirstRunChat
        messages={[{ id: "open", role: "assistant", text: "Where do you want to work?" }]}
        knowledge={[]}
        progress={{ completed: 0, total: 6 }}
      />
    );

    expect(answered).not.toContain("cf-first-run__binary-actions");
    expect(ordinary).not.toContain("cf-first-run__binary-actions");
  });

  it("uses isolated fixed desktop geometry and handoff colors", () => {
    const css = readFileSync(fileURLToPath(new URL("./first-run.css", import.meta.url)), "utf8");

    expect(css).toContain("grid-template-columns: 250px minmax(0, 1fr) 272px");
    expect(css).toContain("var(--canvas)");
    expect(css).toContain("var(--lime)");
    expect(css).toContain("min-width: 1100px");
    expect(css).toContain(".cf-first-run__knowledge-card-heading");
    expect(css).toContain(".cf-first-run__knowledge-acknowledgement");
    expect(css).toContain(".cf-first-run__editor-cover");
    expect(css).toContain(".cf-first-run__composer-notice");
    expect(css).toContain(".cf-first-run__file-action");
    expect(css).toMatch(/\.cf-first-run__assistant-bubble\s*\{[^}]*white-space:\s*pre-wrap/s);
    expect(css).not.toContain(".cf-first-run__confirmation-actions");
    expect(css).toMatch(/\.cf-first-run__engine-content\s*\{[^}]*max-width:\s*1060px/s);
    expect(css).toMatch(/\.cf-first-run__engine-choice\s*\{[^}]*min-height:\s*84px/s);
    expect(css).toMatch(/\.cf-first-run__engine-choice\s*\{[^}]*cursor:\s*default/s);
    expect(css).toMatch(/button\.cf-first-run__engine-choice\s*\{[^}]*cursor:\s*pointer/s);
    expect(css).toMatch(
      /\.cf-first-run__engine-choice\s+\.cf-runtime-icon\s*\{[^}]*grayscale\(1\)/s
    );
    expect(css).toMatch(
      /\.cf-first-run__engine-choice:hover\s+\.cf-runtime-icon[^}]*grayscale\(0\)/s
    );
    expect(css).toMatch(/\.cf-first-run-shell__body\s*\{[^}]*height:\s*calc\(100dvh - 52px\)/s);
    expect(css).toMatch(/\.cf-first-run-shell__body\s*\{[^}]*padding:\s*0 20px 20px/s);
    expect(css).toMatch(
      /\.cf-first-run__user-bubble\s*\{[^}]*background:\s*var\(--cf-message-user-surface\)[^}]*color:\s*var\(--cf-message-user-foreground\)/s
    );
    expect(css).toMatch(
      /\.cf-first-run__engine \.cf-first-run__engine-start\s*\{[^}]*color:\s*var\(--paper\)/s
    );
    expect(css).toMatch(/\.cf-first-run__engine-capability\s*\{[^}]*color:\s*var\(--ink-soft\)/s);
  });

  it("does not apply the cream hover surface to the selected engine", async () => {
    const { FirstRunExperience } = await loadFirstRun();
    const html = renderToStaticMarkup(
      <FirstRunExperience stage="engine" engines={[{ ...ENGINES[0], selected: true }]} />
    );
    const css = readFileSync(fileURLToPath(new URL("./first-run.css", import.meta.url)), "utf8");

    expect(html).toContain('class="cf-first-run__engine-choice is-selected"');
    expect(css).toMatch(/button\.cf-first-run__engine-choice:not\(\.is-selected\):hover\s*\{/);
    expect(css).not.toMatch(/button\.cf-first-run__engine-choice:hover\s*\{/);
  });
});
