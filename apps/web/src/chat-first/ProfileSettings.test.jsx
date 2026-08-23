import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

async function loadProfile() {
  return import("./ProfileSettings.jsx");
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
  if (typeof node.type === "function") return findElement(node.type(node.props), predicate);
  return findElement(node.props?.children, predicate);
}

const PROFILE = {
  targets: ["Staff Software Engineer", "ML infra · platform", "Remote, or hybrid SF"],
  locationPolicy: {
    home: "NYC",
    remoteRegion: "United States",
    hybrid: true,
    onsite: true,
    confirmed: true,
    summary: "NYC local + US remote",
    boundary: "On-site limited to NYC",
  },
  compensation: { floor: "$210k", target: "$230k+" },
  dealbreakers: ["Fully onsite", "Crypto / web3", "Less than 4 weeks PTO"],
  evidence: { roles: 6, promotions: 3, stories: 14 },
  writingStyle: { sampleCount: 2, description: "plain, direct, no buzzwords" },
  searchRules: ["72 boards scanned", "Sweeps daily at 7am", "Shows only fit 70+"],
};

const PERMISSIONS = [
  {
    id: "draft",
    name: "Draft documents",
    description: "resumes and covers",
    enabled: true,
    mutable: false,
    statusLabel: "Always on",
  },
  {
    id: "email",
    name: "Send email replies",
    description: "off = drafts only",
    enabled: false,
    mutable: true,
  },
];

describe("ProfileSettings", () => {
  it("renders What Paul knows from candidate data instead of demo constants", async () => {
    const { ProfileSettings } = await loadProfile();
    const html = renderToStaticMarkup(
      <ProfileSettings
        agentName="Paul"
        activeTab="profile"
        profile={PROFILE}
        permissions={PERMISSIONS}
      />
    );

    expect(html).toContain("What Paul knows");
    expect(html).toContain("Staff Software Engineer");
    expect(html).toContain("LOCATION POLICY");
    expect(html).toContain("NYC local + US remote");
    expect(html).toContain("Remote · United States");
    expect(html).toContain("On-site · NYC only");
    expect(html).toContain("Confirmed search boundary");
    expect(html).toContain("$210k");
    expect(html).toContain("14 stories captured");
    expect(html).toContain("plain, direct, no buzzwords");
    expect(html).toContain("edit anything here");
  });

  it("routes location-policy edits into the chat-first conversation", async () => {
    const { ProfileSettings } = await loadProfile();
    const onEditSection = vi.fn();
    const tree = ProfileSettings({
      agentName: "Paul",
      activeTab: "profile",
      profile: PROFILE,
      onEditSection,
    });

    const edit = findElement(
      tree,
      (node) => node.type === "button" && node.props?.["aria-label"] === "Edit location policy"
    );
    edit.props.onClick();

    expect(onEditSection).toHaveBeenCalledWith("location-policy");
  });

  it("renders settings in plain language and keeps every submit gated", async () => {
    const { ProfileSettings } = await loadProfile();
    const html = renderToStaticMarkup(
      <ProfileSettings
        agentName="Paul"
        activeTab="settings"
        profile={PROFILE}
        permissions={PERMISSIONS}
        engine={{ name: "Claude Code", connected: true }}
        sources={{ scannedCount: 72, pinnedCount: 4, lastSweep: "7:02am", blockedCount: 1 }}
      />
    );

    expect(html).toContain("AI ENGINE");
    expect(html).toContain("Connected");
    expect(html).toContain("WHAT PAUL MAY DO ON HIS OWN");
    expect(html).toContain("Submitting an application always gates back to you");
    expect(html).toContain("1 board blocked by a bot wall");
    expect(html).toContain('role="switch"');
    expect(html).toContain('aria-checked="false"');
    expect(html).toContain("Always on");
    expect(html.match(/role="switch"/g)).toHaveLength(1);
  });

  it("renders actionable engine setup, source entry, and technical details dialogs inline", async () => {
    const { ProfileSettings } = await loadProfile();
    const onCloseEnginePicker = vi.fn();
    const onSelectEngine = vi.fn();
    const onConnectEngine = vi.fn();
    const onRetryEngine = vi.fn();
    const onCloseSourceDialog = vi.fn();
    const onSourceDraftChange = vi.fn();
    const onSubmitSource = vi.fn();
    const onCloseTechnicalDetails = vi.fn();
    const tree = ProfileSettings({
      agentName: "Maya",
      activeTab: "settings",
      permissions: PERMISSIONS,
      engine: {
        name: "Claude Code",
        connected: false,
        choices: [
          {
            id: "claude",
            name: "Claude Code",
            available: true,
            ready: false,
            status: "authentication_required",
            action: "open_terminal",
          },
          { id: "codex", name: "Codex", available: false, ready: false },
        ],
      },
      browser: {
        provider: "Automatic browser connection",
        effectiveProvider: "Chrome extension",
        presenceStatus: "unverified",
        presenceDetail: "Google Chrome detected. Confirm the extension is signed in.",
        automaticFillSupported: false,
        playwright: {
          ready: true,
          detail: "Playwright and Chromium are installed.",
        },
      },
      enginePickerOpen: true,
      sourceDialogOpen: true,
      sourceDraft: "https://jobs.example.com",
      technicalDetailsOpen: true,
      onCloseEnginePicker,
      onSelectEngine,
      onConnectEngine,
      onRetryEngine,
      onCloseSourceDialog,
      onSourceDraftChange,
      onSubmitSource,
      onCloseTechnicalDetails,
    });
    const html = renderToStaticMarkup(tree);

    expect(html).toContain("Choose an AI engine");
    expect(html.match(/cf-runtime-icon/g)).toHaveLength(2);
    expect(html).toContain("Open Terminal to sign in");
    expect(html).toContain("Retry detection");
    expect(html).toContain("Add a niche board");
    expect(html).toContain('value="https://jobs.example.com"');
    expect(html).toContain("Technical details");
    expect(html).toContain("Browser connection");
    expect(html).toContain("Automatic browser connection");
    expect(html).toContain("Chrome extension");
    expect(html).toContain("Needs confirmation");
    expect(html).toContain("Playwright");
    expect(html).toContain("Ready");
    expect(html).toContain("Automatic application fill");
    expect(html).toContain("Unavailable with this browser connection");
    expect(html).not.toContain("window.prompt");

    findElement(
      tree,
      (node) => node.type === "button" && textOf(node) === "Open Terminal to sign in"
    ).props.onClick();
    findElement(
      tree,
      (node) => node.type === "button" && textOf(node) === "Retry detection"
    ).props.onClick();
    expect(onConnectEngine).toHaveBeenCalledWith("claude");
    expect(onRetryEngine).toHaveBeenCalledWith("codex");
  });

  it("keeps an empty engine picker actionable", async () => {
    const { ProfileSettings } = await loadProfile();
    const onRefreshEngines = vi.fn();
    const tree = ProfileSettings({
      activeTab: "settings",
      permissions: PERMISSIONS,
      engine: { name: "AI engine", connected: false, choices: [] },
      enginePickerOpen: true,
      onRefreshEngines,
    });
    const html = renderToStaticMarkup(tree);

    expect(html).toContain("No supported AI tools were found");
    const retry = findElement(
      tree,
      (node) => node.type === "button" && textOf(node) === "Check again"
    );
    retry.props.onClick();
    expect(onRefreshEngines).toHaveBeenCalledOnce();
  });

  it("dispatches navigation, edits, permission changes, and settings actions", async () => {
    const { ProfileSettings } = await loadProfile();
    const actions = {
      onBack: vi.fn(),
      onTabChange: vi.fn(),
      onEditSection: vi.fn(),
      onOpenFiles: vi.fn(),
      onPermissionChange: vi.fn(),
      onChangeEngine: vi.fn(),
      onShowTechnicalDetails: vi.fn(),
      onAddSource: vi.fn(),
      onExportData: vi.fn(),
    };
    const tree = ProfileSettings({
      agentName: "Paul",
      activeTab: "settings",
      profile: PROFILE,
      permissions: PERMISSIONS,
      engine: { name: "Codex", connected: true },
      sources: {},
      ...actions,
    });
    const header = tree.props.children[0];
    header.props.children[0].props.onClick();
    header.props.children[2].props.children[0].props.onClick();
    expect(actions.onBack).toHaveBeenCalledOnce();
    expect(actions.onTabChange).toHaveBeenCalledWith("profile");

    const settings = tree.props.children[1];
    const permissionCard = settings.props.children[1];
    const mutablePermission = permissionCard.props.children[1][1];
    mutablePermission.props.children[1].props.onClick();
    expect(actions.onPermissionChange).toHaveBeenCalledWith("email", true);
  });

  it("keeps its exact desktop profile grid in a separate stylesheet", () => {
    const css = readFileSync(
      fileURLToPath(new URL("./profile-settings.css", import.meta.url)),
      "utf8"
    );

    expect(css).toContain("grid-template-columns: repeat(3, minmax(0, 1fr))");
    expect(css).toContain("max-width: 1200px");
    expect(css).toContain("border-radius: 20px");
    expect(css).toMatch(/\.cf-profile__grid\s*\{[^}]*box-sizing:\s*content-box/s);
    expect(css).toMatch(/\.cf-settings\s*\{[^}]*box-sizing:\s*content-box/s);
    expect(css).toMatch(/\.cf-profile__header\s*\{[^}]*padding-left:\s*92px/s);
    expect(css).toMatch(/\.cf-profile__header\s*\{[^}]*-webkit-app-region:\s*drag/s);
    expect(css).toMatch(/\.cf-profile__header button\s*\{[^}]*-webkit-app-region:\s*no-drag/s);
    expect(css).toMatch(
      /\.cf-settings-dialog__technical-row\s*\{[^}]*grid-template-columns:\s*minmax\(0, 1fr\)/s
    );
  });
});
