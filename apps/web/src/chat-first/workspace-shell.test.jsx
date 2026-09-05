import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import {
  ChatFirstWorkspace,
  Composer,
  NeedsYouPanel,
  ThreadRail,
  TopBar,
} from "./workspace-shell.jsx";

function markup(node) {
  return renderToStaticMarkup(node);
}

describe("TopBar", () => {
  it("uses an in-app profile action instead of escaping the Router basename", () => {
    const onOpenProfile = vi.fn();
    const tree = TopBar({
      agentName: "Mina",
      activityItems: [],
      activityOpen: false,
      onToggleActivity: () => {},
      onOpenProfile,
    });
    const profile = tree.props.children[1].props.children[0];
    profile.props.onClick();
    expect(onOpenProfile).toHaveBeenCalledOnce();

    const html = markup(
      <TopBar
        agentName="Mina"
        activityItems={[]}
        activityOpen={false}
        onToggleActivity={() => {}}
        onOpenProfile={onOpenProfile}
      />
    );

    expect(html).toContain("CareerRat");
    expect(html).not.toContain('href="/settings"');
    expect(html).toContain('type="button"');
    expect(html).toContain("Profile &amp; settings");
    expect(html).toContain('class="chat-first-topbar__actions"');
    expect(html).toContain('aria-label="Open activity"');
    expect(html).toContain('aria-expanded="false"');
    expect(html).not.toContain("WHAT MINA DID TODAY");
  });

  it("shows mission state and an accessible activity dropdown", () => {
    const html = markup(
      <TopBar
        agentName="Mina"
        activityOpen
        missionLive
        onToggleActivity={() => {}}
        activityItems={[
          { id: "sweep", time: "7:02", mark: "✓", label: "Morning sweep complete" },
          { id: "packet", time: "8:41", mark: "◐", label: "Packet drafting" },
        ]}
      />
    );

    expect(html).toContain("activity · mission live");
    expect(html).toContain('aria-expanded="true"');
    expect(html).toContain('aria-label="Close activity"');
    expect(html).toContain('role="status"');
    expect(html).toContain("WHAT MINA DID TODAY");
    expect(html).toContain("Morning sweep complete");
    expect(html).toContain("Every step is logged. The full history lives in your local files.");
  });

  it("can hide Activity when a shell state has no real activity feed", () => {
    const html = markup(<TopBar agentName="Mina" showActivity={false} />);

    expect(html).toContain("Profile &amp; settings");
    expect(html).not.toContain("Open activity");
  });

  it("shows desktop update status and actions without adding controls to browser mode", () => {
    const onPrimary = vi.fn();
    const onDismiss = vi.fn();
    const desktop = TopBar({
      agentName: "Mina",
      showActivity: false,
      desktopUpdate: {
        visible: true,
        kind: "ready",
        version: "0.14.1",
        primaryLabel: "Restart and install",
        onPrimary,
        onDismiss,
      },
    });
    const desktopHtml = markup(desktop);

    expect(desktopHtml).toContain('aria-label="CareerRat update available"');
    expect(desktopHtml).toContain("CareerRat 0.14.1 is downloaded and ready to install");
    expect(desktopHtml).toContain("Restart and install");
    expect(desktopHtml).toContain("Later");

    const buttons = [];
    function visit(node) {
      if (!node || typeof node !== "object") return;
      if (Array.isArray(node)) return node.forEach(visit);
      if (typeof node.type === "function") return visit(node.type(node.props));
      if (node.type === "button") buttons.push(node);
      visit(node.props?.children);
    }
    visit(desktop);
    buttons.find((node) => node?.props?.children === "Restart and install").props.onClick();
    buttons.find((node) => node?.props?.children === "Later").props.onClick();
    expect(onPrimary).toHaveBeenCalledOnce();
    expect(onDismiss).toHaveBeenCalledOnce();

    const browserHtml = markup(<TopBar agentName="Mina" showActivity={false} />);
    expect(browserHtml).not.toContain("CareerRat update available");
    expect(browserHtml).not.toContain("Check for updates");
  });

  it("shows update progress without pretending the update can install yet", () => {
    const html = markup(
      <TopBar
        showActivity={false}
        desktopUpdate={{
          visible: true,
          kind: "downloading",
          version: "0.14.1",
          progress: 37,
          message: "Downloading CareerRat 0.14.1… 37%",
        }}
      />
    );

    expect(html).toContain("Downloading CareerRat 0.14.1… 37%");
    expect(html).not.toContain("Restart and install");
    expect(html).toContain(">Dismiss</button>");
  });

  it("puts a clear retry action beside update failures", () => {
    const html = markup(
      <TopBar
        showActivity={false}
        desktopUpdate={{
          visible: true,
          kind: "error",
          message: "CareerRat couldn't download the update. Check your connection and try again.",
          primaryLabel: "Try again",
        }}
      />
    );

    expect(html).toContain("Check your connection and try again");
    expect(html).toContain(">Try again</button>");
  });

  it("opens the fixed Windows download fallback as an external link", () => {
    const html = markup(
      <TopBar
        showActivity={false}
        desktopUpdate={{
          visible: true,
          kind: "unsupported",
          message:
            "CareerRat can't install updates inside the Windows app yet because a signed Windows installer isn't publicly available yet. See Windows release status for availability.",
          primaryLabel: "Windows release status",
          primaryHref: "https://github.com/CodesWhat/careerrat/blob/main/docs/WINDOWS.md",
          onDismiss: () => {},
        }}
      />
    );

    expect(html).toContain("a signed Windows installer isn&#x27;t publicly available yet");
    expect(html).toContain(
      'href="https://github.com/CodesWhat/careerrat/blob/main/docs/WINDOWS.md"'
    );
    expect(html).toContain('target="_blank"');
    expect(html).toContain('rel="noopener noreferrer"');
    expect(html).not.toContain(">Windows release status</button>");
  });

  it("omits the Dismiss control while an accepted install is in progress", () => {
    const onDismiss = vi.fn();
    const html = markup(
      <TopBar
        showActivity={false}
        desktopUpdate={{
          visible: true,
          kind: "installing",
          message: "Restarting to install…",
          onDismiss,
        }}
      />
    );

    expect(html).toContain("Restarting to install");
    expect(html).not.toContain(">Dismiss</button>");
    expect(html).not.toContain(">Later</button>");
  });

  it("styles the updater states the desktop bridge actually emits", () => {
    const css = readFileSync(fileURLToPath(new URL("./chat-first.css", import.meta.url)), "utf8");

    expect(css).toMatch(/\.chat-first-update-notice--error\s*\{/);
    expect(css).toMatch(/\.chat-first-update-notice--ready button:first-of-type\s*\{/);
    expect(css).not.toContain(".chat-first-update-notice--failed");
    expect(css).not.toContain(".chat-first-update-notice--available");
  });

  it("keeps a full day of activity inside the fixed desktop window", () => {
    const css = readFileSync(fileURLToPath(new URL("./chat-first.css", import.meta.url)), "utf8");

    expect(css).toMatch(
      /\.chat-first-activity__menu\s*\{[^}]*max-height:\s*calc\(100dvh - 64px\)/s
    );
    expect(css).toMatch(/\.chat-first-activity__rows\s*\{[^}]*overflow-y:\s*auto/s);
  });

  it("keeps controller alerts from blocking workspace controls", () => {
    const css = readFileSync(fileURLToPath(new URL("./chat-first.css", import.meta.url)), "utf8");

    expect(css).toMatch(/\.chat-first-controller-alert\s*\{[^}]*pointer-events:\s*none/s);
  });

  it("styles passive controller notices with the neutral palette", () => {
    const css = readFileSync(fileURLToPath(new URL("./chat-first.css", import.meta.url)), "utf8");

    expect(css).toMatch(
      /\.chat-first-controller-alert--notice\s*\{[^}]*border-color:\s*var\(--line-cool\)[^}]*background:\s*var\(--tint-cool\)/s
    );
  });
});

describe("ThreadRail", () => {
  const baseProps = {
    agentName: "Paul",
    activeThread: "today",
    needsAction: true,
    threads: [
      {
        id: "ecorp",
        title: "E Corp · Offer",
        subtitle: "recruiter replied 2h ago",
        needsAction: true,
      },
      { id: "cyber", title: "Cyberdyne · Interview", subtitle: "panel Thursday · dossier ready" },
    ],
    browserLaunchers: [
      { id: "search", label: "Search", meta: "11 need action", tone: "lime" },
      { id: "pipeline", label: "Pipeline", meta: "22 in play" },
      { id: "files", label: "Files", meta: "24" },
      { id: "people", label: "People", meta: "1 touch due", tone: "attention" },
      { id: "schedule", label: "Schedule", meta: "next: Thu" },
    ],
    archiveThreads: [
      { id: "old", title: "Initrode · Rejected", subtitle: "after onsite · Aug 12" },
    ],
    onSelectThread: vi.fn(),
    onOpenBrowser: vi.fn(),
    onToggleArchive: vi.fn(),
  };

  it("renders the active Paul thread, earned job conversations, and browser launchers", () => {
    const html = markup(<ThreadRail {...baseProps} archiveOpen={false} />);

    expect(html).toContain('aria-label="Conversation threads"');
    expect(html).toContain('aria-current="page"');
    expect(html).toContain("main chat · briefs, missions, questions");
    expect(html).toContain("JOB CONVERSATIONS · 2");
    expect(html).toContain("E Corp · Offer");
    expect(html).toContain("BROWSE");
    expect(html).toContain("11 need action");
    expect(html).toContain("1 touch due");
    expect(html).toContain('aria-expanded="false"');
    expect(html).not.toContain("Initrode · Rejected");
  });

  it("renders the durable Deep ingest thread with a pickaxe and selects it like any thread", () => {
    const onSelectThread = vi.fn();
    const tree = ThreadRail({
      ...baseProps,
      activeThread: "ingest",
      deepIngestThread: {
        id: "ingest",
        title: "Deep ingest",
        subtitle: "add work history and review grounded evidence",
      },
      onSelectThread,
    });
    const buttons = [];
    function visit(node) {
      if (!node || typeof node !== "object") return;
      if (Array.isArray(node)) return node.forEach(visit);
      if (typeof node.type === "function") return visit(node.type(node.props));
      if (node.type === "button") buttons.push(node);
      visit(node.props?.children);
    }
    visit(tree);
    const deepButton = buttons.find((button) =>
      String(button.props.className || "").includes("chat-first-thread-card--deep")
    );
    expect(markup(tree)).toContain('data-icon="pickaxe"');
    expect(markup(tree)).toContain("chat-first-thread-card__icon-badge");
    expect(markup(tree)).toContain('aria-current="page"');
    deepButton.props.onClick();
    expect(onSelectThread).toHaveBeenCalledWith("ingest");
  });

  it("gives Paul and Deep ingest the same small badge geometry with stable varied palette colors", () => {
    const html = markup(
      <ThreadRail
        {...baseProps}
        activeThread="ingest"
        deepIngestThread={{
          id: "ingest",
          title: "Deep ingest",
          subtitle: "add work history and review grounded evidence",
        }}
      />
    );
    const css = readFileSync(fileURLToPath(new URL("./chat-first.css", import.meta.url)), "utf8");
    const badgeRule = css.match(/\.chat-first-thread-card__icon-badge\s*\{([^}]*)\}/)?.[1] || "";
    const badgeIconRule =
      css.match(/\.chat-first-thread-card__icon-badge svg\s*\{([^}]*)\}/)?.[1] || "";

    expect(html.match(/class="chat-first-thread-card__icon-badge /g)).toHaveLength(2);
    expect(html).toContain("chat-first-thread-card__icon-badge--lilac");
    expect(html).toContain("chat-first-thread-card__icon-badge--lime");
    expect(html).not.toContain("chat-first-avatar--small");
    expect(badgeRule).toMatch(/width:\s*24px/);
    expect(badgeRule).toMatch(/height:\s*24px/);
    expect(badgeRule).toMatch(/border-radius:\s*9px/);
    expect(badgeRule).not.toMatch(/background:/);
    expect(badgeRule).toMatch(/font-size:\s*14px/);
    expect(badgeIconRule).toMatch(/width:\s*14px/);
    expect(badgeIconRule).toMatch(/height:\s*14px/);
    for (const [tone, surface] of [
      ["lime", "--lime"],
      ["sky", "--sky"],
      ["lilac", "--lilac"],
      ["cool", "--tint-cool-2"],
      ["cream", "--cream-edge"],
    ]) {
      expect(css).toMatch(
        new RegExp(
          `\\.chat-first-thread-card__icon-badge--${tone}\\s*\\{[^}]*background:\\s*var\\(${surface}\\)`
        )
      );
    }
    expect(css).not.toMatch(
      /\.chat-first-thread-card\.is-active \.chat-first-thread-card__icon-badge\s*\{/
    );
  });

  it("renders durable visible research chats as ordinary navigable threads", () => {
    const onSelectThread = vi.fn();
    const tree = ThreadRail({
      ...baseProps,
      activeThread: "skill:research-company",
      skillThreads: [
        {
          id: "skill:research-company",
          title: "Researching Acme",
          subtitle: "research complete · review the result",
          state: "idle",
        },
      ],
      onSelectThread,
    });
    const buttons = [];
    function visit(node) {
      if (!node || typeof node !== "object") return;
      if (Array.isArray(node)) return node.forEach(visit);
      if (typeof node.type === "function") return visit(node.type(node.props));
      if (node.type === "button") buttons.push(node);
      visit(node.props?.children);
    }
    visit(tree);

    expect(markup(tree)).toContain("RESEARCH · 1");
    expect(markup(tree)).toContain("Researching Acme");
    expect(markup(tree)).toContain('aria-current="page"');
    buttons
      .find((button) =>
        String(button.props.className || "").includes("chat-first-thread-card--skill")
      )
      .props.onClick();
    expect(onSelectThread).toHaveBeenCalledWith("skill:research-company");
  });

  it("expands archived conversations without treating them as deleted", () => {
    const html = markup(<ThreadRail {...baseProps} archiveOpen />);

    expect(html).toContain('aria-expanded="true"');
    expect(html).toContain("Initrode · Rejected");
    expect(html).toContain("auto-archived on close · nothing is deleted");
  });

  it("shows the handoff skeleton instead of a zero-count heading when no job thread is earned", () => {
    const html = markup(
      <ThreadRail agentName="Paul" threads={[]} browserLaunchers={[]} archiveThreads={[]} />
    );

    expect(html).toContain("JOB CONVERSATIONS");
    expect(html).not.toContain("JOB CONVERSATIONS · 0");
    expect(html).toContain("threads appear when a recruiter replies or an interview lands");
    expect(html).toContain('class="chat-first-thread-rail__empty"');
  });
});

describe("Composer", () => {
  it("renders context chips, a keyboard hint, and a labeled send control", () => {
    const html = markup(
      <Composer
        value=""
        onChange={() => {}}
        onSubmit={() => {}}
        chips={[{ id: "tyrell", label: "Tyrell Corp" }]}
        onRemoveChip={() => {}}
        onClearChips={() => {}}
      />
    );

    expect(html).toContain("◇ Tyrell Corp");
    expect(html).toContain("clear");
    expect(html).toContain('placeholder="tell Paul what to do…"');
    expect(html).toContain('aria-label="Message Paul"');
    expect(html).toContain("⌘K");
    expect(html).toContain('aria-label="Send message"');
  });
});

describe("NeedsYouPanel", () => {
  it("keeps decisions in a dedicated queue and docks deep ingest at the bottom right", () => {
    const html = markup(
      <NeedsYouPanel
        items={[
          {
            id: "submit",
            eyebrow: "EXPIRES 6PM",
            title: "E Corp application ready: you press submit",
            tone: "attention",
            primaryLabel: "Review & submit",
            onPrimary: () => {},
          },
          {
            id: "apply",
            title: "Apply to Tyrell Corp? 88",
            detail: "gate cleared · comp works",
            primaryLabel: "Apply",
            secondaryLabel: "Skip",
            onPrimary: () => {},
            onSecondary: () => {},
          },
        ]}
        deepIngestPrompt={{ visible: true }}
        onStartIngest={() => {}}
        onDismissIngest={() => {}}
      />
    );

    expect(html).toContain("NEEDS YOU · 2");
    expect(html).toContain("EXPIRES 6PM");
    expect(html).toContain("Review &amp; submit");
    expect(html).toContain(
      "Decisions queue here so they never get buried in chat. Expiring ones interrupt."
    );
    expect(html).toContain("GO DEEPER");
    expect(html).toContain('class="chat-first-deep-dock"');
    expect(html).toContain('data-icon="pickaxe"');
    expect(html).toContain('aria-label="Dismiss deep ingest prompt"');
    expect(html).toContain(">Dismiss</button>");
    expect(html).toContain("Deep ingest your history");
    expect(html).toContain("old resumes, reviews, project docs");
  });

  it("removes the deep ingest dock after completion or dismissal", () => {
    const html = markup(<NeedsYouPanel items={[]} deepIngestPrompt={{ visible: false }} />);

    expect(html).not.toContain("GO DEEPER");
    expect(html).not.toContain("Deep ingest your history");
  });

  it("continues an existing durable deep-ingest thread from the Today dock", () => {
    const html = markup(
      <NeedsYouPanel
        items={[]}
        deepIngestPrompt={{ visible: true }}
        deepIngestStarted={true}
        onStartIngest={() => {}}
      />
    );

    expect(html).toContain(">Continue</button>");
    expect(html).not.toContain(">Start</button>");
  });
});

describe("ChatFirstWorkspace", () => {
  it("assembles the fixed desktop rail, conversation, and context columns", () => {
    const html = markup(
      <ChatFirstWorkspace
        topBar={<div data-slot="top">Top</div>}
        rail={<nav data-slot="rail">Rail</nav>}
        conversation={<main data-slot="conversation">Conversation</main>}
        context={<aside data-slot="context">Context</aside>}
      />
    );

    expect(html).toContain('class="chat-first-workspace"');
    expect(html).toContain('class="chat-first-workspace__body"');
    expect(html).toContain('class="chat-first-workspace__rail"');
    expect(html).toContain('class="chat-first-workspace__conversation"');
    expect(html).toContain('class="chat-first-workspace__context"');
    expect(html).toContain('data-slot="top"');
    expect(html).toContain('data-slot="rail"');
    expect(html).toContain('data-slot="conversation"');
    expect(html).toContain('data-slot="context"');
  });

  it("keeps selected conversation rows neutral gray with no glow or focus surround", () => {
    const foundation = readFileSync(
      fileURLToPath(new URL("./app-foundation.css", import.meta.url)),
      "utf8"
    );
    const css = readFileSync(fileURLToPath(new URL("./chat-first.css", import.meta.url)), "utf8");
    const firstRun = readFileSync(
      fileURLToPath(new URL("./first-run.css", import.meta.url)),
      "utf8"
    );
    const browser = readFileSync(
      fileURLToPath(new URL("./workspace-browser.css", import.meta.url)),
      "utf8"
    );
    const profile = readFileSync(
      fileURLToPath(new URL("./profile-settings.css", import.meta.url)),
      "utf8"
    );
    const activeRule = css.match(/\.chat-first-thread-card\.is-active\s*\{([^}]*)\}/)?.[1] || "";
    const activeFocusRule =
      css.match(
        /\.chat-first-workspace \.chat-first-thread-card\.is-active:focus-visible\s*\{([^}]*)\}/
      )?.[1] || "";
    const badgeIconRule =
      css.match(/\.chat-first-thread-card__icon-badge svg\s*\{([^}]*)\}/)?.[1] || "";
    const firstRunRule = firstRun.match(/\.cf-first-run__paul-card\s*\{([^}]*)\}/)?.[1] || "";
    const firstRunAvatar = firstRun.match(/\.cf-first-run__rail-avatar\s*\{([^}]*)\}/)?.[1] || "";
    const browserTab =
      browser.match(/\.cf-browser__tab\[aria-selected="true"\]\s*\{([^}]*)\}/)?.[1] || "";
    const profileTab =
      profile.match(/\.cf-profile__tabs button\[aria-selected="true"\]\s*\{([^}]*)\}/)?.[1] || "";

    expect(foundation).toMatch(/--gray-selected:\s*#474a4f/);
    expect(foundation).toMatch(/--cf-selection-fill:\s*var\(--gray-selected\)/);
    expect(foundation).toMatch(/--cf-selection-foreground:\s*var\(--paper\)/);
    expect(foundation).toMatch(/--cf-selection-border:\s*0/);
    expect(foundation).toMatch(/--cf-selection-outline:\s*0/);
    expect(foundation).toMatch(/--cf-selection-shadow:\s*none/);
    expect(foundation).toMatch(/--cf-selection-avatar-surface:\s*transparent/);
    for (const rule of [activeRule, firstRunRule, browserTab, profileTab]) {
      expect(rule).toMatch(/background:\s*var\(--cf-selection-fill\)/);
      expect(rule).toMatch(/color:\s*var\(--cf-selection-foreground\)/);
      expect(rule).toMatch(/border:\s*var\(--cf-selection-border\)/);
      expect(rule).toMatch(/outline:\s*var\(--cf-selection-outline\)/);
      expect(rule).toMatch(/box-shadow:\s*var\(--cf-selection-shadow\)/);
      expect(rule).not.toMatch(/lime|#e6fa8d|rgba\(230,\s*250,\s*141|color-mix/);
    }
    expect(activeFocusRule).toMatch(/outline:\s*var\(--cf-selection-outline\)/);
    expect(activeFocusRule).toMatch(/box-shadow:\s*var\(--cf-selection-shadow\)/);
    expect(badgeIconRule).toMatch(/width:\s*14px/);
    expect(badgeIconRule).toMatch(/height:\s*14px/);
    expect(firstRunAvatar).toMatch(/background:\s*var\(--cf-selection-avatar-surface\)/);
  });

  it("allows only component-scoped custom properties in inline chat-first styles", () => {
    const directory = fileURLToPath(new URL(".", import.meta.url));
    const occurrences = readdirSync(directory)
      .filter((name) => name.endsWith(".jsx") && !name.endsWith(".test.jsx"))
      .flatMap((name) => {
        const source = readFileSync(fileURLToPath(new URL(`./${name}`, import.meta.url)), "utf8");
        expect(source, name).not.toMatch(
          /style=\{\{(?:(?!\}\}).)*\b(?:transform|width|height|fontSize)\s*:/s
        );
        return [...source.matchAll(/style=\{\{([^}]+)\}\}/g)].map((match) => ({
          name,
          declaration: match[1],
        }));
      });

    expect(occurrences.length).toBeGreaterThan(0);
    for (const { name, declaration } of occurrences) {
      expect(declaration, name).not.toMatch(/\b(?:transform|width|height|fontSize)\s*:/);
      expect(declaration, name).toMatch(/^\s*"--cf-[a-z-]+"\s*:/);
    }
  });

  it("reserves the native macOS controls and marks only chrome as draggable", () => {
    const css = readFileSync(fileURLToPath(new URL("./chat-first.css", import.meta.url)), "utf8");

    expect(css).toMatch(/\.chat-first-topbar\s*\{[^}]*padding-left:\s*92px/s);
    expect(css).toMatch(/\.chat-first-topbar\s*\{[^}]*-webkit-app-region:\s*drag/s);
    expect(css).toMatch(/\.chat-first-topbar__actions\s*\{[^}]*margin-left:\s*auto/s);
    expect(css).toMatch(/\.chat-first-topbar button,[^{]*\{[^}]*-webkit-app-region:\s*no-drag/s);
    expect(css).toMatch(/\.chat-first-workspace__body\s*\{[^}]*-webkit-app-region:\s*no-drag/s);
  });

  it("caps Lucide icons at their exact handoff sizes", () => {
    const css = readFileSync(fileURLToPath(new URL("./chat-first.css", import.meta.url)), "utf8");

    expect(css).toMatch(
      /\.chat-first-activity__trigger svg\[data-icon="activity"\]\s*\{[^}]*width:\s*14px[^}]*height:\s*14px/s
    );
    expect(css).toMatch(
      /\.chat-first-activity__trigger svg\[data-icon="chevron-down"\]\s*\{[^}]*width:\s*13px[^}]*height:\s*13px/s
    );
    expect(css).toMatch(
      /\.chat-first-composer__send svg\s*\{[^}]*width:\s*17px[^}]*height:\s*17px/s
    );
    expect(css).toMatch(
      /\.chat-first-drop-card__icon svg\s*\{[^}]*width:\s*22px[^}]*height:\s*22px/s
    );
  });

  it("keeps attention pill copy visible over its ink background", () => {
    const css = readFileSync(fileURLToPath(new URL("./chat-first.css", import.meta.url)), "utf8");

    expect(css).toMatch(
      /\.chat-first-pill--ink\s*\{[^}]*color:\s*var\(--lime[^}]*background:\s*var\(--ink/s
    );
  });

  it("uses the exact handoff geometry for Needs You cards and pills", () => {
    const css = readFileSync(fileURLToPath(new URL("./chat-first.css", import.meta.url)), "utf8");
    const reset = css.match(/\.chat-first-workspace button,[^{]*\{([^}]*)\}/s)?.[1] || "";

    expect(reset).not.toMatch(/\bfont:\s*inherit;/);
    expect(reset).toMatch(/font-family:\s*inherit;[\s\S]*font-size:\s*inherit;/);
    expect(css).toMatch(/\.chat-first-need-card\s*\{[^}]*padding:\s*13px 15px/s);
    expect(css).toMatch(/\.chat-first-need-card,[^}]*border-radius:\s*18px/s);
    expect(css).toMatch(/\.chat-first-needs \.chat-first-pill\s*\{[^}]*padding:\s*6px 14px/s);
    expect(css).toMatch(/\.chat-first-pill\s*\{[^}]*font-weight:\s*700/s);
    expect(css).toMatch(/\.chat-first-deep-card__dismiss\s*\{[^}]*font-weight:\s*700/s);
    expect(css).toMatch(/\.chat-first-pill\s*\{[^}]*border-radius:\s*999px/s);
    expect(css).not.toMatch(/\.chat-first-pill\s*\{[^}]*min-height:/s);
    expect(css).toMatch(
      /\.chat-first-needs \.chat-first-pill--outline\s*\{[^}]*padding:\s*5px 13px[^}]*border-color:\s*var\(--line-warm\)/s
    );
  });

  it("right-aligns the collapsed Needs You actions", () => {
    const css = readFileSync(fileURLToPath(new URL("./chat-first.css", import.meta.url)), "utf8");
    const actionsRule = css.match(/\.chat-first-need-card__actions\s*\{([^}]*)\}/)?.[1] || "";

    expect(actionsRule).toMatch(/justify-content:\s*flex-end/);
  });

  it("gives the Go Deeper pickaxe the same small palette badge as its thread", () => {
    const html = markup(<NeedsYouPanel />);
    const css = readFileSync(fileURLToPath(new URL("./chat-first.css", import.meta.url)), "utf8");
    const iconRule = css.match(/\.chat-first-deep-card__icon-badge svg\s*\{([^}]*)\}/)?.[1] || "";

    expect(html).toContain(
      'class="chat-first-thread-card__icon-badge chat-first-thread-card__icon-badge--lime chat-first-deep-card__icon-badge"'
    );
    expect(html).toMatch(/chat-first-deep-card__icon-badge[^>]*><svg[^>]*data-icon="pickaxe"/);
    expect(iconRule).toMatch(/width:\s*14px/);
    expect(iconRule).toMatch(/height:\s*14px/);
  });

  it("leaves component-owned control colors out of the global button reset", () => {
    const css = readFileSync(fileURLToPath(new URL("./chat-first.css", import.meta.url)), "utf8");
    const reset = css.match(/\.chat-first-workspace button,[^{]*\{([^}]*)\}/s)?.[1] || "";

    expect(reset).not.toMatch(/\bcolor\s*:/);
  });

  it("leaves the archive auto margin out of the global button reset", () => {
    const css = readFileSync(fileURLToPath(new URL("./chat-first.css", import.meta.url)), "utf8");
    const reset = css.match(/\.chat-first-workspace button,[^{]*\{([^}]*)\}/s)?.[1] || "";

    expect(reset).not.toMatch(/\bmargin\s*:/);
    expect(css).toMatch(/\.chat-first-archive-toggle\s*\{[^}]*margin-top:\s*auto/s);
  });
});
