import { readFileSync } from "node:fs";
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
  it("keeps decisions in a dedicated queue and offers deep ingest", () => {
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
        onStartIngest={() => {}}
      />
    );

    expect(html).toContain("NEEDS YOU · 2");
    expect(html).toContain("EXPIRES 6PM");
    expect(html).toContain("Review &amp; submit");
    expect(html).toContain(
      "Decisions queue here so they never get buried in chat. Expiring ones interrupt."
    );
    expect(html).toContain("GO DEEPER");
    expect(html).toContain("Deep ingest your history");
    expect(html).toContain("old resumes, reviews, project docs");
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

  it("reserves the native macOS controls and marks only chrome as draggable", () => {
    const css = readFileSync(fileURLToPath(new URL("./chat-first.css", import.meta.url)), "utf8");

    expect(css).toMatch(/\.chat-first-topbar\s*\{[^}]*padding-left:\s*92px/s);
    expect(css).toMatch(/\.chat-first-topbar\s*\{[^}]*-webkit-app-region:\s*drag/s);
    expect(css).toMatch(/\.chat-first-topbar__actions\s*\{[^}]*margin-left:\s*auto/s);
    expect(css).toMatch(/\.chat-first-topbar button,[^{]*\{[^}]*-webkit-app-region:\s*no-drag/s);
    expect(css).toMatch(/\.chat-first-workspace__body\s*\{[^}]*-webkit-app-region:\s*no-drag/s);
  });

  it("keeps attention pill copy visible over its ink background", () => {
    const css = readFileSync(fileURLToPath(new URL("./chat-first.css", import.meta.url)), "utf8");

    expect(css).toMatch(
      /\.chat-first-pill--ink\s*\{[^}]*color:\s*var\(--cf-lime[^}]*background:\s*var\(--cf-ink/s
    );
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
