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
    remoteRegion: "Worldwide",
    remoteScope: "worldwide",
    hybrid: true,
    onsite: true,
    confirmed: true,
    summary: "NYC local + worldwide remote",
    boundary: "On-site limited to NYC",
  },
  compensation: { floor: "$210k", annualEarningsFloor: "$225k", target: "$230k+" },
  dealbreakers: ["Fully onsite", "Crypto / web3", "Less than 4 weeks PTO"],
  evidence: { roles: 6, promotions: 3, stories: 14 },
  writingStyle: { sampleCount: 2, description: "plain, direct, no buzzwords" },
  searchRules: ["72 boards scanned", "Sweeps daily at 7am", "Shows only fit 70+"],
  applicationDefaults: {
    action: "Leave these blank (default)",
    localNotice: "Local only on this computer. This setting never goes through Paul.",
  },
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
    name: "Read job-search email",
    description: "reads recruiting updates and verification codes from connected mail",
    providerScope: "Turning this on records consent for Gmail, Outlook, and webmail.",
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
    expect(html).toContain("NYC local + worldwide remote");
    expect(html).toContain("Remote · Worldwide");
    expect(html).toContain("On-site · NYC only");
    expect(html).toContain("Confirmed search boundary");
    expect(html).toContain("$210k");
    expect(html).toContain("$225k");
    expect(html).toContain("yearly cash earnings");
    expect(html).toContain("14 stories captured");
    expect(html).toContain("plain, direct, no buzzwords");
    expect(html).toContain("APPLICATION DEFAULTS");
    expect(html).toContain("Voluntary self-identification questions");
    expect(html).toContain("Leave these blank (default)");
    expect(html).toContain("Local only on this computer. This setting never goes through Paul.");
    expect(html).toContain("edit anything here");
  });

  it("uses a keyboard-safe tab pattern for profile and app settings", async () => {
    const { ProfileSettings } = await loadProfile();
    const onTabChange = vi.fn();
    const tree = ProfileSettings({
      agentName: "Paul",
      activeTab: "settings",
      permissions: PERMISSIONS,
      onTabChange,
    });
    const html = renderToStaticMarkup(tree);
    const appSettings = findElement(
      tree,
      (node) => node.type === "button" && textOf(node) === "App settings"
    );

    expect(html).toContain('role="tablist"');
    expect(html).toContain('id="profile-settings-tab-settings"');
    expect(appSettings.props).toMatchObject({
      role: "tab",
      "aria-selected": true,
      "aria-controls": "profile-settings-panel-settings",
      tabIndex: 0,
    });

    const preventDefault = vi.fn();
    appSettings.props.onKeyDown({ key: "ArrowLeft", preventDefault });
    expect(preventDefault).toHaveBeenCalledOnce();
    expect(onTabChange).toHaveBeenCalledWith("profile");
  });

  it("wraps arrow-key selection across both settings tabs", async () => {
    const { ProfileSettings } = await loadProfile();
    const onTabChange = vi.fn();
    const tree = ProfileSettings({
      activeTab: "settings",
      permissions: PERMISSIONS,
      onTabChange,
    });
    const appSettings = findElement(
      tree,
      (node) => node.type === "button" && textOf(node) === "App settings"
    );

    appSettings.props.onKeyDown({ key: "ArrowRight", preventDefault: vi.fn() });

    expect(onTabChange).toHaveBeenCalledWith("profile");
  });

  it("renders keyboard-operable provider-neutral quality and thinking choices", async () => {
    const { ProfileSettings } = await loadProfile();
    const onAiPreferenceChange = vi.fn();
    const tree = ProfileSettings({
      agentName: "Paul",
      activeTab: "settings",
      permissions: PERMISSIONS,
      aiPreferences: {
        quality: "balanced",
        reasoning: "high",
        source: "saved",
        updatedAt: "2026-08-27T16:00:00.000Z",
      },
      aiPreferencesStatus: "Saved on this computer",
      onAiPreferenceChange,
    });
    const html = renderToStaticMarkup(tree);

    expect(html).toContain("HOW PAUL THINKS");
    expect(html).toContain("Paul quality");
    expect(html).toContain("Thinking depth");
    expect(html).toContain("Automatic (recommended)");
    expect(html).toContain("Paul stays strong; searches and small helpers stay efficient.");
    expect(html).toContain("CareerRat chooses by task.");
    expect(html).toContain("Saved on this computer");
    expect(html.match(/<fieldset class="cf-settings__ai-group"/g)).toHaveLength(2);
    expect(html).not.toMatch(/opus|sonnet|haiku|gpt-5\.6|luna|terra|sol/i);

    const best = findElement(
      tree,
      (node) =>
        node.type === "input" && node.props.name === "paul-quality" && node.props.value === "best"
    );
    const high = findElement(
      tree,
      (node) =>
        node.type === "input" && node.props.name === "thinking-depth" && node.props.value === "high"
    );
    expect(best.props.checked).toBe(false);
    expect(high.props.checked).toBe(true);
    best.props.onChange({ target: { value: "best" } });
    expect(onAiPreferenceChange).toHaveBeenCalledWith("quality", "best");
  });

  it("disables every AI preference radio while a save is in flight", async () => {
    const { ProfileSettings } = await loadProfile();
    const html = renderToStaticMarkup(
      <ProfileSettings
        activeTab="settings"
        permissions={PERMISSIONS}
        aiPreferences={{ quality: "automatic", reasoning: "automatic" }}
        aiPreferencesBusy
        aiPreferencesStatus="Saving…"
      />
    );

    expect(html).toContain("Saving…");
    expect(html.match(/type="radio"/g)).toHaveLength(8);
    expect(html.match(/disabled=""/g).length).toBeGreaterThanOrEqual(8);
  });

  it("keeps the application-defaults editor local and never shows saved sensitive answers", async () => {
    const { ProfileSettings } = await loadProfile();
    const onAskAgent = vi.fn();
    const tree = ProfileSettings({
      agentName: "Paul",
      activeTab: "profile",
      profile: PROFILE,
      profileEditor: {
        id: "application-defaults",
        title: "Application defaults",
        localOnly: true,
        description:
          "Choose how CareerRat handles optional voluntary form questions. This stays local on this computer.",
        preservedAnswers: {
          disability: {
            value: "A private saved answer",
            confirmed_at: "2026-08-20T12:00:00.000Z",
          },
        },
        fields: [
          {
            id: "policy",
            label: "Voluntary self-identification questions",
            type: "select",
            options: [
              { value: "leave_blank", label: "Leave these blank (default)" },
              {
                value: "decline_when_available",
                label: "Choose the form's decline option when available",
              },
            ],
          },
        ],
      },
      editorValues: { policy: "leave_blank" },
      onAskAgent,
    });
    const html = renderToStaticMarkup(tree);

    expect(html).toContain("Application defaults");
    expect(html).toContain("This stays local on this computer");
    expect(html).toContain("Leave these blank (default)");
    expect(html).toContain("Choose the form&#x27;s decline option when available");
    expect(html).not.toContain("Ask Paul instead");
    expect(html).not.toContain("A private saved answer");
  });

  it("opens a whole-section editor instead of an inline approval list", async () => {
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

  it("renders a whole-section modal with manual save and Ask Paul paths", async () => {
    const { ProfileSettings } = await loadProfile();
    const onEditorChange = vi.fn();
    const onSaveEditor = vi.fn();
    const onAskAgent = vi.fn();
    const tree = ProfileSettings({
      agentName: "Paul",
      activeTab: "profile",
      profile: PROFILE,
      profileEditor: {
        id: "location-policy",
        title: "Edit location policy",
        fields: [
          { id: "home", label: "Home market", type: "text" },
          {
            id: "remoteScope",
            label: "Remote job eligibility",
            type: "select",
            options: [
              { value: "off", label: "Not open to remote roles" },
              { value: "home-country", label: "Remote within my home country" },
              { value: "worldwide", label: "Remote worldwide" },
            ],
          },
          {
            id: "relocation",
            label: "Relocation markets",
            type: "textarea",
            rows: 3,
          },
        ],
      },
      editorValues: {
        home: "New York, NY",
        remoteScope: "worldwide",
        relocation: "Boston, MA",
      },
      onEditorChange,
      onSaveEditor,
      onAskAgent,
    });
    const html = renderToStaticMarkup(tree);

    expect(html).toContain('role="dialog"');
    expect(html).toContain("Edit location policy");
    expect(html).toContain("New York, NY");
    expect(html).toContain("Boston, MA");
    expect(html).toContain("Remote worldwide");
    expect(html).toContain("Save section");
    expect(html).toContain("Ask Paul instead");
    expect(html).not.toMatch(/approve|deny/i);

    findElement(
      tree,
      (node) => node.type === "input" && node.props?.id === "cf-profile-editor-home"
    ).props.onChange({ target: { value: "Brooklyn, NY" } });
    findElement(
      tree,
      (node) => node.type === "button" && textOf(node) === "Ask Paul instead"
    ).props.onClick();
    const form = findElement(tree, (node) => node.type === "form");
    form.props.onSubmit({ preventDefault: vi.fn() });

    expect(onEditorChange).toHaveBeenCalledWith("home", "Brooklyn, NY");
    expect(onAskAgent).toHaveBeenCalledWith("location-policy");
    expect(onSaveEditor).toHaveBeenCalledOnce();
  });

  it("renders a clear unsaved-change choice with keep and discard actions", async () => {
    const { ProfileSettings } = await loadProfile();
    const onKeepEditing = vi.fn();
    const onDiscardEditor = vi.fn();
    const tree = ProfileSettings({
      agentName: "Paul",
      activeTab: "profile",
      profile: PROFILE,
      profileEditor: {
        id: "targets",
        title: "Edit targets",
        fields: [{ id: "titles", label: "Target roles", type: "textarea" }],
      },
      editorValues: { titles: "Principal Engineer" },
      discardEditorOpen: true,
      onKeepEditing,
      onDiscardEditor,
    });
    const html = renderToStaticMarkup(tree);
    const keep = findElement(
      tree,
      (node) => node.type === "button" && textOf(node) === "Keep editing"
    );
    const discard = findElement(
      tree,
      (node) => node.type === "button" && textOf(node) === "Discard changes"
    );

    expect(html).toContain("Discard unsaved changes?");
    expect(html).toContain("Your edits haven&#x27;t been saved yet.");
    keep.props.onClick();
    discard.props.onClick();
    expect(onKeepEditing).toHaveBeenCalledOnce();
    expect(onDiscardEditor).toHaveBeenCalledOnce();
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
        sources={{
          scannedCount: 72,
          pinnedCount: 4,
          lastSweep: "7:02am",
          blockedCount: 1,
        }}
        publicSyncPreference={{
          enabled: true,
          source: "default",
          updatedAt: null,
        }}
      />
    );

    expect(html).toContain("AI ENGINE");
    expect(html).toContain("Connected");
    expect(html).toContain("WHAT PAUL MAY DO ON HIS OWN");
    expect(html).toContain("Submitting an application always gates back to you");
    expect(html).toContain("Saved sources run when you search");
    expect(html).not.toContain("blocked by a bot wall");
    expect(html).not.toContain("permission to use LinkedIn");
    expect(html).toContain('role="switch"');
    expect(html).toContain('aria-checked="false"');
    expect(html).toContain("Always on");
    expect(html).toContain("Read job-search email");
    expect(html).toContain("Turning this on records consent for Gmail, Outlook, and webmail.");
    expect(html).toContain("Share public company and board metadata");
    expect(html).toContain(
      "company domains, career pages, ATS board links, providers, and scan confidence"
    );
    expect(html).toContain(
      "never sends résumé text, profile data, applications, private notes, compensation, fit scores, or local files"
    );
    expect(html).toContain("On by default · public metadata only");
    expect(html).toContain('aria-label="Share public company and board metadata: on"');
    expect(html.match(/role="switch"/g)).toHaveLength(2);
  });

  it("lets the candidate opt out and back in from App settings", async () => {
    const { ProfileSettings } = await loadProfile();
    const onPublicSyncChange = vi.fn();
    const tree = ProfileSettings({
      activeTab: "settings",
      permissions: PERMISSIONS,
      publicSyncPreference: { enabled: false, source: "user", updatedAt: null },
      onPublicSyncChange,
    });
    const toggle = findElement(
      tree,
      (node) =>
        node.type === "button" &&
        node.props?.["aria-label"] === "Share public company and board metadata: off"
    );

    expect(toggle).not.toBeNull();
    expect(toggle.props["aria-checked"]).toBe(false);
    expect(renderToStaticMarkup(tree)).toContain("Off · no public metadata shared");
    toggle.props.onClick();
    expect(onPublicSyncChange).toHaveBeenCalledWith(true);
  });

  it("shows desktop-only update preference and a manual check that works while opted out", async () => {
    const { ProfileSettings } = await loadProfile();
    const onEnabledChange = vi.fn();
    const onCheckNow = vi.fn();
    const tree = ProfileSettings({
      activeTab: "settings",
      permissions: PERMISSIONS,
      desktopUpdate: {
        available: true,
        supported: true,
        enabled: false,
        checking: false,
        status: "CareerRat is up to date.",
        onEnabledChange,
        onCheckNow,
      },
    });
    const html = renderToStaticMarkup(tree);

    expect(html).toContain("DESKTOP APP");
    expect(html).toContain("Automatically check for updates");
    expect(html).toContain("downloads it and waits for you to restart");
    expect(html).toContain("Check now downloads a new version in the app");
    expect(html).toContain("Check now");
    expect(html).toContain("CareerRat is up to date.");

    const updateToggle = findElement(
      tree,
      (node) =>
        node.type === "button" &&
        node.props?.["aria-label"] === "Automatically check for updates: off"
    );
    updateToggle.props.onClick();
    findElement(
      tree,
      (node) => node.type === "button" && textOf(node) === "Check now"
    ).props.onClick();

    expect(onEnabledChange).toHaveBeenCalledWith(true);
    expect(onCheckNow).toHaveBeenCalledOnce();
  });

  it("explains Windows updates and links safely to the current installer", async () => {
    const { ProfileSettings } = await loadProfile();
    const tree = (
      <ProfileSettings
        activeTab="settings"
        permissions={PERMISSIONS}
        desktopUpdate={{
          available: true,
          supported: false,
          status:
            "CareerRat can't install updates inside the Windows app yet because a signed Windows installer isn't publicly available yet. See Windows release status for availability.",
          downloadUrl: "https://github.com/CodesWhat/careerrat/blob/main/docs/WINDOWS.md",
        }}
      />
    );
    const html = renderToStaticMarkup(tree);
    const download = findElement(
      tree,
      (node) => node.type === "a" && textOf(node) === "Windows release status"
    );

    expect(html).toContain("a signed Windows installer isn&#x27;t publicly available yet");
    expect(html).not.toContain("Automatically check for updates");
    expect(html).not.toContain(">Check now</button>");
    expect(download).toMatchObject({
      props: {
        href: "https://github.com/CodesWhat/careerrat/blob/main/docs/WINDOWS.md",
        target: "_blank",
        rel: "noopener noreferrer",
      },
    });
  });

  it("does not render desktop update controls in the browser app", async () => {
    const { ProfileSettings } = await loadProfile();
    const html = renderToStaticMarkup(
      <ProfileSettings activeTab="settings" permissions={PERMISSIONS} />
    );

    expect(html).not.toContain("DESKTOP APP");
    expect(html).not.toContain("Automatically check for updates");
    expect(html).not.toContain("Check now");
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
    const onBrowserProviderChange = vi.fn();
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
            supported: true,
            available: true,
            ready: false,
            status: "authentication_required",
            action: "start_sign_in",
          },
          { id: "codex", name: "Codex", supported: true, available: false, ready: false },
        ],
      },
      browser: {
        providerId: "auto",
        provider: "Automatic browser connection",
        effectiveProviderId: "extension",
        effectiveProvider: "Chrome extension",
        presenceStatus: "unverified",
        presenceDetail: "Google Chrome detected. Confirm the extension is signed in.",
        automaticFillSupported: true,
        options: [
          {
            id: "auto",
            label: "Automatic browser connection",
            needs: "the bundled or supervised browser",
            automatedApply: false,
          },
          {
            id: "playwright",
            label: "Playwright persistent profile",
            needs: "one sign-in per platform",
            automatedApply: true,
          },
        ],
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
      onBrowserProviderChange,
    });
    const html = renderToStaticMarkup(tree);

    expect(html).toContain("Choose an AI engine");
    expect(html.match(/cf-runtime-icon/g)).toHaveLength(2);
    expect(html).toContain(">Sign in</button>");
    expect(html).not.toMatch(/open terminal/i);
    expect(html).toContain("Retry detection");
    expect(html).toContain("Add a job source");
    expect(html).toContain("Board or saved-search URL");
    expect(html).toContain("Add source");
    expect(html).not.toContain("Permission to use LinkedIn");
    expect(html).not.toContain("Set up LinkedIn");
    expect(html).toContain('value="https://jobs.example.com"');
    expect(html).toContain("Technical details");
    expect(html).toContain("Browser connection");
    expect(html).toContain("Let CareerRat choose");
    expect(html).toContain("Needs confirmation");
    expect(html).toContain("Use CareerRat browser");
    expect(html).toContain("Available once CareerRat confirms the browser");
    expect(html).not.toContain("Available after browser setup is fixed");
    expect(html).toContain("Automatic application fill");
    expect(html).toContain("Browser setup");
    expect(html).not.toMatch(/Chrome extension|Playwright persistent profile|Chromium/i);
    expect(html).not.toContain("window.prompt");

    findElement(
      tree,
      (node) => node.type === "button" && textOf(node) === "Sign in"
    ).props.onClick();
    findElement(
      tree,
      (node) => node.type === "button" && textOf(node) === "Retry detection"
    ).props.onClick();
    expect(onConnectEngine).toHaveBeenCalledWith("claude");
    expect(onRetryEngine).toHaveBeenCalledWith("codex");
    findElement(
      tree,
      (node) => node.type === "select" && node.props.id === "cf-browser-setup"
    ).props.onChange({ target: { value: "playwright" } });
    expect(onBrowserProviderChange).toHaveBeenCalledWith("playwright");
  });

  it("shows Playwright readiness without exposing profile paths or blanket sign-in setup", async () => {
    const { ProfileSettings } = await loadProfile();
    const html = renderToStaticMarkup(
      <ProfileSettings
        activeTab="settings"
        permissions={PERMISSIONS}
        technicalDetailsOpen
        browser={{
          providerId: "playwright",
          provider: "Playwright persistent profile",
          effectiveProviderId: "playwright",
          effectiveProvider: "Playwright persistent profile",
          presenceStatus: "ready",
          presenceDetail:
            "no persistent profiles yet (/Users/person/.careerrat/board-profiles). Sign in once per platform",
          automaticFillSupported: true,
          options: [
            {
              id: "playwright",
              label: "Playwright persistent profile",
              needs: "a one-time interactive login per platform (persistent profile reused after)",
              automatedApply: true,
            },
          ],
          playwright: {
            ready: true,
            detail: "Playwright and Chromium are installed.",
          },
        }}
      />
    );

    expect(html).toContain("Ready");
    expect(html).toMatch(/can open a browser when a job needs one/i);
    expect(html).not.toMatch(
      /\/Users\/person|\.careerrat|board-profiles|sign in once per platform/i
    );
    expect(html).not.toMatch(/create profile|check browser|sign in to platforms/i);
  });

  it("gives browser recovery inside Settings without rendering technical readiness details", async () => {
    const { ProfileSettings } = await loadProfile();
    const onBrowserProviderChange = vi.fn();
    const tree = ProfileSettings({
      activeTab: "settings",
      permissions: PERMISSIONS,
      technicalDetailsOpen: true,
      browser: {
        providerId: "auto",
        provider: "Automatic browser connection",
        effectiveProviderId: "extension",
        effectiveProvider: "Chrome extension",
        presenceStatus: "unverified",
        presenceDetail:
          "Google Chrome detected. Confirm the extension is signed in. Run `careerrat automation status`.",
        nextStep: {
          kind: "choose",
          provider: "playwright",
          label: "Use CareerRat browser",
        },
        automaticFillSupported: false,
        options: [
          { id: "auto", label: "Automatic browser connection", automatedApply: false },
          { id: "extension", label: "Chrome extension", automatedApply: false },
          { id: "playwright", label: "Playwright persistent profile", automatedApply: true },
        ],
        playwright: {
          ready: false,
          detail:
            "Playwright executable missing at /Users/person/.careerrat/board-profiles/chromium",
        },
      },
      onBrowserProviderChange,
    });
    const html = renderToStaticMarkup(tree);

    expect(html).toContain("CareerRat needs one more setup step before it can help with job forms");
    expect(html).toContain("Use CareerRat browser");
    expect(html).not.toMatch(
      /Chrome extension|Playwright executable|Playwright persistent|Chromium|\/Users\/person|\.careerrat|careerrat automation|Browser automation provider/i
    );

    findElement(
      tree,
      (node) => node.type === "button" && textOf(node) === "Use CareerRat browser"
    ).props.onClick();
    expect(onBrowserProviderChange).toHaveBeenCalledWith("playwright");
  });

  it("does not offer a retry button that cannot repair a missing CareerRat browser", async () => {
    const { ProfileSettings } = await loadProfile();
    const onBrowserProviderChange = vi.fn();
    const tree = ProfileSettings({
      activeTab: "settings",
      permissions: PERMISSIONS,
      technicalDetailsOpen: true,
      browser: {
        providerId: "auto",
        effectiveProviderId: "playwright",
        presenceStatus: "missing",
        presenceDetail: "Chromium missing at /Users/person/private/browser",
        nextStep: {
          kind: "retry",
          provider: "playwright",
          label: "Check browser again",
        },
        automaticFillSupported: true,
        options: [{ id: "playwright", label: "Playwright", automatedApply: true }],
      },
      onBrowserProviderChange,
    });
    const html = renderToStaticMarkup(tree);

    expect(html).toContain(
      "Close and reopen CareerRat. If the browser is still unavailable, reinstall the latest version."
    );
    expect(html).not.toContain("Check browser again");
    expect(html).toContain("Available after browser setup is fixed");
    expect(html).not.toContain("Available with this browser connection");
    expect(html).not.toMatch(/Chromium|\/Users\/person/i);
    expect(html).not.toContain(">Playwright<");
    expect(onBrowserProviderChange).not.toHaveBeenCalled();
  });

  it("keeps supported engines visible when they need setup without a Use action", async () => {
    const { ProfileSettings } = await loadProfile();
    const onSelectEngine = vi.fn();
    const tree = ProfileSettings({
      activeTab: "settings",
      permissions: PERMISSIONS,
      engine: {
        name: "Claude Code",
        connected: true,
        selectedId: "claude",
        choices: [
          {
            id: "claude",
            name: "Claude Code",
            supported: true,
            available: true,
            ready: true,
            selectable: true,
          },
          {
            id: "codex",
            name: "Codex",
            supported: true,
            available: true,
            ready: true,
            selectable: false,
            capabilityReason: "Detected, but cannot safely run CareerRat tools yet.",
          },
        ],
      },
      enginePickerOpen: true,
      onSelectEngine,
    });
    const html = renderToStaticMarkup(tree);

    expect(html).toContain("cannot safely run CareerRat tools");
    expect(html).not.toContain("Use this tool");
    expect(onSelectEngine).not.toHaveBeenCalled();
  });

  it("keeps an in-app sign-in visible while the provider browser flow is pending", async () => {
    const { ProfileSettings } = await loadProfile();
    const onRetryEngine = vi.fn();
    const tree = ProfileSettings({
      activeTab: "settings",
      permissions: PERMISSIONS,
      engine: {
        name: "Claude Code",
        connected: false,
        choices: [
          {
            id: "claude",
            name: "Claude Code",
            supported: true,
            available: true,
            ready: false,
            selectable: false,
            status: "authentication_required",
            action: "start_sign_in",
          },
        ],
      },
      enginePickerOpen: true,
      engineSignInId: "claude",
      onRetryEngine,
    });
    const html = renderToStaticMarkup(tree);

    expect(html).toContain("Finish sign-in in your browser, then check again.");
    expect(html).toContain(">Check sign-in</button>");
    expect(html).not.toContain(">Sign in</button>");
    findElement(
      tree,
      (node) => node.type === "button" && textOf(node) === "Check sign-in"
    ).props.onClick();
    expect(onRetryEngine).toHaveBeenCalledWith("claude");
  });

  it("shows the completion probe failure and its retry action in engine settings", async () => {
    const { ProfileSettings } = await loadProfile();
    const onRetryEngine = vi.fn();
    const tree = ProfileSettings({
      activeTab: "settings",
      permissions: PERMISSIONS,
      engine: {
        name: "Codex",
        connected: false,
        choices: [
          {
            id: "codex",
            name: "Codex",
            supported: true,
            available: true,
            ready: false,
            selectable: false,
            status: "completion_probe_failed",
            action: "retry",
            actionLabel: "Try again",
            probeMessage: "Codex is signed in, but it didn't return a usable test reply.",
          },
        ],
      },
      enginePickerOpen: true,
      onRetryEngine,
    });
    const html = renderToStaticMarkup(tree);
    const retry = findElement(
      tree,
      (node) => node.type === "button" && textOf(node) === "Try again"
    );

    expect(html).toContain("didn&#x27;t return a usable test reply");
    expect(html).toContain("Needs a retry");
    retry.props.onClick();
    expect(onRetryEngine).toHaveBeenCalledWith("codex");
  });

  it("presents supported engines with one Ready contract in settings", async () => {
    const { ProfileSettings } = await loadProfile();
    const html = renderToStaticMarkup(
      <ProfileSettings
        activeTab="settings"
        permissions={PERMISSIONS}
        engine={{
          name: "Codex",
          connected: true,
          selectedId: "codex",
          choices: [
            {
              id: "claude",
              name: "Claude Code",
              supported: true,
              available: true,
              ready: true,
              selectable: true,
              capabilityTier: "task_tools",
              capabilities: { completion: true, taskTools: true, research: true },
            },
            {
              id: "codex",
              name: "Codex",
              supported: true,
              available: true,
              ready: true,
              selectable: true,
              capabilityTier: "chat_drafting",
              capabilities: { completion: true, taskTools: false, research: false },
            },
            {
              id: "hermes",
              name: "Hermes Agent",
              supported: false,
              available: true,
              ready: true,
              selectable: false,
            },
          ],
        }}
        enginePickerOpen
      />
    );

    expect((html.match(/<span>Ready<\/span>/g) || []).length).toBe(2);
    expect(html).not.toMatch(/task tools|chat and drafting|capabilities not verified/i);
    expect(html).not.toContain("Hermes Agent");
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

    const mutablePermission = findElement(
      tree,
      (node) => node.type === "button" && node.props["aria-label"] === "Read job-search email: off"
    );
    mutablePermission.props.onClick();
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
