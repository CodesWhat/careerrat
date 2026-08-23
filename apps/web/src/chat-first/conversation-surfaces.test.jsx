import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import {
  CanonicalJobConversation,
  ConversationPanel,
  DeepIngestContext,
  DeepIngestConversation,
  EngineDownCover,
  JobContextPanel,
  JobConversation,
  MessageTranscript,
  MockInterviewContext,
  MockInterviewConversation,
  SubmitGateModal,
  TodayConversation,
} from "./conversation-surfaces.jsx";

function markup(node) {
  return renderToStaticMarkup(node);
}

describe("TodayConversation", () => {
  it("keeps indented cards at the handoff intrinsic desktop widths", () => {
    const css = readFileSync(fileURLToPath(new URL("./chat-first.css", import.meta.url)), "utf8");

    expect(css).toMatch(/\.chat-first-indented-card\s*\{[^}]*width:\s*fit-content/s);
    for (const className of [
      "chat-first-artifact-card",
      "chat-first-mission",
      "chat-first-feedback",
      "chat-first-drop-card",
    ]) {
      expect(css).toMatch(new RegExp(`\\.${className}\\s*\\{[^}]*box-sizing:\\s*content-box`, "s"));
    }
  });

  it("renders completed search-run artifact summaries as readable copy", () => {
    const html = markup(
      <MessageTranscript
        messages={[
          {
            id: "search-complete",
            role: "assistant",
            kind: "action_result",
            text: "Job search complete: 7 qualified roles presented.",
            artifacts: [
              {
                kind: "search_run",
                title: "First job search: Complete",
                summary: {
                  attemptedSources: 5,
                  scanned: 361,
                  qualified: 7,
                  filtered: 354,
                  reasonCounts: { title: 302, location: 52 },
                  errors: [],
                  zeroResults: false,
                },
              },
            ],
          },
        ]}
      />
    );

    expect(html).toContain("First job search: Complete");
    expect(html).toContain("7 qualified · 361 scanned · 5 sources");
    expect(html).not.toContain("[object Object]");
  });

  it("renders durable action outcomes and every attached artifact with action callbacks", () => {
    const onArtifactAction = vi.fn();
    const onMessageAction = vi.fn();
    const tree = MessageTranscript({
      agentName: "Paul",
      onArtifactAction,
      onMessageAction,
      messages: [
        {
          id: "done",
          role: "assistant",
          kind: "action_result",
          text: "Packet drafted.",
          artifacts: [
            { kind: "resume", title: "Tyrell resume", summary: "Evidence backed" },
            { kind: "cover_letter", name: "Tyrell cover letter" },
          ],
        },
        {
          id: "failed",
          role: "assistant",
          kind: "action_error",
          text: "Source sweep could not finish.",
          error: { code: "SOURCE_DOWN" },
        },
      ],
    });
    const buttons = [];
    function visit(node) {
      if (!node || typeof node !== "object") return;
      if (Array.isArray(node)) {
        for (const child of node) visit(child);
        return;
      }
      if (typeof node.type === "function") {
        visit(node.type(node.props));
        return;
      }
      if (node.type === "button") buttons.push(node);
      for (const child of Array.isArray(node.props?.children)
        ? node.props.children
        : [node.props?.children])
        visit(child);
    }
    visit(tree);
    buttons.find((button) => button.props.children === "Open").props.onClick();
    buttons.find((button) => button.props.children === "activity").props.onClick();

    const html = markup(tree);
    expect(html).toContain("Packet drafted.");
    expect(html).toContain("Tyrell resume");
    expect(html).toContain("Tyrell cover letter");
    expect(html).toContain("Evidence backed");
    expect(html).toContain("Source sweep could not finish.");
    expect(html).toContain("chat-first-run-receipt--error");
    expect(onArtifactAction).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "resume" }),
      expect.objectContaining({ id: "done" })
    );
    expect(onMessageAction).toHaveBeenCalledWith(expect.objectContaining({ id: "done" }));
  });

  it("renders an arbitrary durable transcript without moving gates into chat", () => {
    const html = markup(
      <MessageTranscript
        agentName="Paul"
        messages={[
          { id: "a1", role: "assistant", kind: "text", text: "I found three strong roles." },
          { id: "u1", role: "user", kind: "text", text: "Draft the best two." },
          { id: "r1", role: "assistant", kind: "run", text: "2 packets ready" },
          {
            id: "f1",
            role: "assistant",
            kind: "artifact",
            text: "Resume ready for Tyrell",
            metadata: { subtitle: "built from your evidence", actionLabel: "View" },
          },
          { id: "gate", role: "assistant", kind: "gate", text: "Do not render me" },
        ]}
      />
    );

    expect(html).toContain("I found three strong roles.");
    expect(html).toContain("Draft the best two.");
    expect(html).toContain("2 packets ready");
    expect(html).toContain("Resume ready for Tyrell");
    expect(html).not.toContain("Do not render me");
  });

  it("renders agent copy, a run receipt, and an editable artifact without approval copy", () => {
    const html = markup(
      <TodayConversation
        agentName="Paul"
        dateLabel="SUNDAY, AUG 23"
        intro="Morning. First sweep of the day: 4 boards, 361 postings, 6 worth your time."
        run={{
          label: "Morning sweep · 361 found · 355 filtered · 6 qualified",
          actionLabel: "activity",
        }}
        artifacts={[
          {
            id: "resume",
            icon: "📄",
            title: "Resume ready for Tyrell",
            subtitle: "built from your evidence, ask me to change anything",
            actionLabel: "View",
            onAction: () => {},
          },
        ]}
      />
    );

    expect(html).toContain("SUNDAY, AUG 23");
    expect(html).toContain("Morning. First sweep of the day");
    expect(html).toContain("Morning sweep · 361 found · 355 filtered · 6 qualified");
    expect(html).toContain("Resume ready for Tyrell");
    expect(html).toContain("ask me to change anything");
    expect(html).not.toMatch(/approve|deny/i);
  });

  it("renders a live mission as a run of runs", () => {
    const html = markup(
      <TodayConversation
        agentName="Paul"
        dateLabel="TODAY"
        intro="Work is moving."
        mission={{
          title: "Apply to 3 roles",
          steps: ["✓ 3 queued · gates cleared", "◐ Drafting packet 1 of 3 · Aperture Science"],
          footnote: "applies start as each packet lands · submits gate back here",
          onPause: () => {},
        }}
      />
    );

    expect(html).toContain("MISSION");
    expect(html).toContain("Apply to 3 roles");
    expect(html).toContain("Drafting packet 1 of 3 · Aperture Science");
    expect(html).toContain("submits gate back here");
    expect(html).toContain("pause");
  });
});

describe("JobConversation and JobContextPanel", () => {
  it("presents canonical inbound communication and its saved reply draft", () => {
    const onApproveAndCopy = vi.fn();
    const onEditDraft = vi.fn();
    const onCoach = vi.fn();
    const tree = CanonicalJobConversation({
      eyebrow: "E CORP · STAFF SWE · OFFER STAGE",
      agentName: "Paul",
      communication: {
        subject: "Offer next steps",
        participants: [{ name: "Sarah Nolan", role: "Recruiting" }],
        messages: [
          {
            id: "inbound-1",
            direction: "inbound",
            from: "Sarah Nolan",
            summary: "Great news. Are you free Friday to talk numbers?",
          },
        ],
        draft: {
          subject: "Re: Offer next steps",
          body: "Friday works. I'm looking forward to talking through the full package.",
        },
      },
      threadMessages: [
        { id: "thread-1", role: "assistant", kind: "text", text: "I checked the market range." },
      ],
      onApproveAndCopy,
      onEditDraft,
      onCoach,
    });
    const actions = tree.props.actions;
    actions[0].onAction();
    actions[1].onAction();
    actions[2].onAction();

    const html = markup(tree);
    expect(html).toContain("Sarah Nolan");
    expect(html).toContain("Great news. Are you free Friday to talk numbers?");
    expect(html).toContain("Friday works. I&#x27;m looking forward");
    expect(html).toContain("Approve &amp; copy");
    expect(html).toContain("Edit");
    expect(html).toContain("Coach me live");
    expect(html).toContain("I checked the market range.");
    expect(onApproveAndCopy).toHaveBeenCalledWith(
      expect.objectContaining({ body: expect.any(String) }),
      expect.objectContaining({ subject: "Offer next steps" })
    );
    expect(onEditDraft).toHaveBeenCalledWith(
      expect.objectContaining({ body: expect.any(String) }),
      expect.objectContaining({ subject: "Offer next steps" })
    );
    expect(onCoach).toHaveBeenCalledWith(expect.objectContaining({ subject: "Offer next steps" }));
  });

  it("renders a recruiter message, the drafted response, and job-scoped run history", () => {
    const html = markup(
      <JobConversation
        eyebrow="E CORP · STAFF SWE · OFFER STAGE"
        inbound={{
          sender: "Sarah Nolan · E Corp recruiting",
          body: "Great news. Are you free Friday to talk numbers?",
        }}
        agentName="Paul"
        agentReply="Drafted a reply: accepts Friday, holds your floor at $210k, and doesn't name a number first."
        actions={[
          { id: "copy", label: "Approve & copy", tone: "primary", onAction: () => {} },
          { id: "edit", label: "Edit", onAction: () => {} },
          { id: "coach", label: "Coach me live", onAction: () => {} },
        ]}
        receipt={{ label: "Comp research · 3 sources cited", actionLabel: "view" }}
        userMessage="what if they lowball friday?"
        finalReply="Then we anchor back to $228k and use your two competing loops as leverage."
      />
    );

    expect(html).toContain("E CORP · STAFF SWE · OFFER STAGE");
    expect(html).toContain("Sarah Nolan · E Corp recruiting");
    expect(html).toContain("Approve &amp; copy");
    expect(html).toContain("Comp research · 3 sources cited");
    expect(html).toContain("what if they lowball friday?");
    expect(html).toContain("anchor back to $228k");
  });

  it("renders job-scoped artifacts with primary and export actions", () => {
    const html = markup(
      <JobConversation
        eyebrow="CYBERDYNE SYSTEMS · STAFF ML ENGINEER · INTERVIEW"
        agentName="Paul"
        agentReply="Your dossier is ready."
        artifacts={[
          {
            id: "dossier",
            icon: "📕",
            title: "Interview dossier",
            subtitle: "5 interviewers · likely questions · comp context",
            actionLabel: "Open",
            onAction: () => {},
            secondaryActions: [{ id: "export", label: "Export PDF", onAction: () => {} }],
          },
        ]}
        receipt={{
          label: "Dossier built · web research + your story bank",
          actionLabel: "activity",
        }}
      />
    );

    expect(html).toContain("Interview dossier");
    expect(html).toContain("5 interviewers · likely questions · comp context");
    expect(html).toContain("Open");
    expect(html).toContain("Export PDF");
    expect(html).toContain("Dossier built · web research + your story bank");
  });

  it("keeps job facts and actions in a dedicated context panel", () => {
    const html = markup(
      <JobContextPanel
        job={{
          company: "Cyberdyne Systems",
          role: "Staff ML Engineer",
          stage: "Interview",
          fit: 86,
          badge: "panel Thu 10am",
        }}
        summary={{
          title: "Prep plan",
          lines: ["Tue: systems design mock", "Wed: stories pass + comp answer"],
        }}
        files={[
          {
            id: "dossier",
            icon: "📕",
            name: "Interview dossier",
            meta: "ready · built Saturday",
            onOpen: () => {},
            onExport: () => {},
          },
        ]}
        action={{ label: "Run mock interview", onAction: () => {} }}
      />
    );

    expect(html).toContain("THIS JOB");
    expect(html).toContain("Cyberdyne Systems");
    expect(html).toContain("86");
    expect(html).toContain("Prep plan");
    expect(html).toContain("Interview dossier");
    expect(html).toContain("Open");
    expect(html).toContain("Export PDF");
    expect(html).toContain("Run mock interview");
  });

  it("can place a prep summary after files for interview-stage context", () => {
    const html = markup(
      <JobContextPanel
        job={{ company: "Cyberdyne", role: "Staff ML Engineer", stage: "Interview", fit: 86 }}
        files={[{ id: "dossier", name: "Interview dossier" }]}
        summary={{ title: "Prep plan", lines: ["Tue: systems design mock"] }}
        summaryPosition="after-files"
      />
    );

    expect(html.indexOf("Interview dossier")).toBeLessThan(html.indexOf("Prep plan"));
  });
});

describe("focused conversation modes", () => {
  it("shows prior feedback separately while leading with the current backend question and round", () => {
    const html = markup(
      <MockInterviewConversation
        company="Cyberdyne"
        round="Hiring manager"
        interviewerHint="Nina Sharp · VP Engineering"
        questionNumber={3}
        totalQuestions={6}
        question="Tell me about the migration."
        previousFeedback={{
          questionNumber: 2,
          worked: "Specific story",
          tighten: "Lead with impact",
        }}
      />
    );

    expect(html).toContain("MOCK INTERVIEW · CYBERDYNE · HIRING MANAGER · QUESTION 3 OF 6");
    expect(html).toContain("Tell me about the migration.");
    expect(html).toContain("Nina Sharp · VP Engineering");
    expect(html).toContain("FEEDBACK · QUESTION 2");
    expect(html).toContain("Specific story");
    expect(html.indexOf("FEEDBACK · QUESTION 2")).toBeLessThan(
      html.indexOf("Tell me about the migration.")
    );
    expect(html).not.toContain("Again, tighter");
  });

  it("renders a calibrated mock interview with immediate feedback", () => {
    const html = markup(
      <MockInterviewConversation
        company="Cyberdyne"
        questionNumber={2}
        totalQuestions={6}
        question="You're designing the model-serving layer for their vision fleet. Where do you start?"
        interviewerHint="Nina Sharp asks this kind of question. Answer out loud or type."
        userAnswer="I'd start from the SLO and work backwards."
        worked="Leading with the SLO, that's staff-level framing."
        tighten="Name the caching-vs-sharding tradeoff and put a number on rollout."
        retryPrompt="Again, tighter this time. Same question, 90 seconds."
      />
    );

    expect(html).toContain("MOCK INTERVIEW · CYBERDYNE CONTEXT · QUESTION 2 OF 6");
    expect(html).toContain("Nina Sharp");
    expect(html).toContain("FEEDBACK");
    expect(html).toContain("Worked:");
    expect(html).toContain("Tighten:");
    expect(html).toContain("Again, tighter this time");
  });

  it("renders job-loaded mock session context with an exit action", () => {
    const html = markup(
      <MockInterviewContext
        title="Systems design · Cyberdyne panel"
        detail="question 2 of 6 · calibrated to Thursday's interviewers"
        loadedContext="their ML org rebuild · your Nexus story · the dossier's likely questions"
        onEnd={() => {}}
      />
    );

    expect(html).toContain("LIVE SESSION");
    expect(html).toContain("Context loaded");
    expect(html).toContain("End session → back to thread");
  });

  it("renders deep ingest as a resumable conversation with accessible intake actions", () => {
    const html = markup(
      <DeepIngestConversation
        agentName="Paul"
        intro="Let's mine the history your resume skips."
        lastSession="resume.pdf · 6 roles, 3 promotions, 14 stories"
        onFiles={() => {}}
        onPaste={() => {}}
        onLinkRepo={() => {}}
      />
    );

    expect(html).toContain("DEEP INGEST · PICKS UP WHERE YOU LEFT OFF");
    expect(html).toContain("drop files here");
    expect(html).toContain('<fieldset class="chat-first-drop-card"');
    expect(html).toContain('aria-label="Files to ingest"');
    expect(html).toContain('aria-label="Choose files to ingest"');
    expect(html).toContain("Paste text");
    expect(html).toContain("Link a repo");
    expect(html).toContain("Last session: resume.pdf");
  });

  it("sends files dropped on the ingest card to the owning upload action", () => {
    const onFiles = vi.fn();
    const files = [{ name: "resume.pdf" }, { name: "review.txt" }];
    const tree = DeepIngestConversation({ onFiles });
    let dropCard;

    function visit(node) {
      if (!node || typeof node !== "object" || dropCard) return;
      if (Array.isArray(node)) {
        node.forEach(visit);
        return;
      }
      if (node.props?.className === "chat-first-drop-card") dropCard = node;
      visit(node.props?.children);
    }
    visit(tree);

    const preventDefault = vi.fn();
    dropCard.props.onDragOver({ preventDefault });
    dropCard.props.onDrop({ preventDefault, dataTransfer: { files } });

    expect(preventDefault).toHaveBeenCalledTimes(2);
    expect(onFiles).toHaveBeenCalledWith(files);
  });

  it("renders inline paste and repository capture without native dialogs", () => {
    const html = markup(
      <DeepIngestConversation
        inputMode="paste"
        inputValue="A long project history"
        onInputChange={() => {}}
        onInputSubmit={() => {}}
        onInputCancel={() => {}}
        onPaste={() => {}}
        onLinkRepo={() => {}}
      />
    );

    expect(html).toContain('aria-label="Career material to ingest"');
    expect(html).toContain("A long project history");
    expect(html).toContain("Add material");
    expect(html).toContain("Cancel");
    expect(html).not.toMatch(/window\.prompt|window\.alert/);
  });

  it("renders durable source receipts, proposal counts, and review-card actions", () => {
    const html = markup(
      <DeepIngestConversation
        counts={{ sources: 2, proposals: 4, reviewQueue: 1, confirmed: 3 }}
        receipt="Saved edits. 1 proposal still needs review."
        sources={[
          {
            id: "source-ready",
            label: "github.com/example/work",
            statusLabel: "Ready to analyze",
            canAnalyze: true,
          },
        ]}
        proposals={[
          {
            id: "proposal-1",
            lane: "story_bank",
            title: "Billing migration",
            summary: "Led a three-service migration.",
            supportingQuote: "Reduced reconciliation time by 31%.",
          },
        ]}
        editingId="proposal-1"
        editDraft={{
          title: "Billing migration",
          summary: "Led a three-service migration.",
          supportingQuote: "Reduced reconciliation time by 31%.",
        }}
        onAnalyze={() => {}}
        onStartEdit={() => {}}
        onEditChange={() => {}}
        onSaveEdit={() => {}}
        onConfirm={() => {}}
        onDefer={() => {}}
        onReject={() => {}}
      />
    );

    expect(html).toContain("2 sources");
    expect(html).toContain("3 confirmed");
    expect(html).toContain("Saved edits. 1 proposal still needs review.");
    expect(html).toContain("github.com/example/work");
    expect(html).toContain("Analyze");
    expect(html).toContain('aria-label="Proposal title"');
    expect(html).toContain('aria-label="Proposal summary"');
    expect(html).toContain('aria-label="Supporting quote"');
    expect(html).toContain("Save changes");
    expect(html).toContain("Confirm");
    expect(html).toContain("Defer");
    expect(html).toContain("Reject");
  });

  it("summarizes the evidence bank and keeps pause navigation in context", () => {
    const html = markup(
      <DeepIngestContext
        evidenceItems={["6 roles from resume.pdf", "14 stories captured"]}
        unlockSummary="sharper fit scores · resumes with real numbers · answers that don't sound generic"
        onPause={() => {}}
      />
    );

    expect(html).toContain("EVIDENCE BANK");
    expect(html).toContain("14 stories captured");
    expect(html).toContain("What this unlocks");
    expect(html).toContain("Pause → back to Today");
  });
});

describe("ConversationPanel", () => {
  it("keeps the scrollable conversation and composer in one rounded panel", () => {
    const html = markup(
      <ConversationPanel composer={<div data-composer="true">Composer</div>}>
        <p>Conversation</p>
      </ConversationPanel>
    );

    expect(html).toContain('class="chat-first-conversation-panel"');
    expect(html).toContain('class="chat-first-conversation-panel__scroll"');
    expect(html).toContain('class="chat-first-conversation-panel__composer"');
    expect(html).toContain('data-composer="true"');
  });
});

describe("SubmitGateModal", () => {
  it("makes the user's final submit explicit and leaves EEO questions blank", () => {
    const html = markup(
      <SubmitGateModal
        open
        agentName="Paul"
        gate={{
          company: "E Corp",
          role: "Staff Software Engineer",
          channel: "Greenhouse",
          deadline: "closes 6pm today",
          expiryLabel: "EXPIRES 6PM",
          answeredCount: 3,
          packet: [
            { id: "resume", icon: "📄", name: "Resume · E Corp" },
            { id: "cover", icon: "✉", name: "Cover letter" },
          ],
        }}
        onClose={() => {}}
        onReviewAnswers={() => {}}
        onViewPacket={() => {}}
        onRequestChanges={() => {}}
        onSubmit={() => {}}
      />
    );

    expect(html).toContain('role="dialog"');
    expect(html).toContain('aria-modal="true"');
    expect(html).toContain("Submit to E Corp · Staff Software Engineer");
    expect(html).toContain("WHAT PAUL FILLED");
    expect(html).toContain("3 application questions answered");
    expect(html).toContain("Demographic / EEO questions");
    expect(html).toContain("left blank for you · never auto-answered");
    expect(html).toContain("Nothing sends until you press submit.");
    expect(html).toContain("Open Greenhouse &amp; submit ↗");
  });

  it("renders nothing when the gate is closed", () => {
    expect(markup(<SubmitGateModal open={false} />)).toBe("");
  });

  it("turns an ISO gate deadline into the handoff's human closing copy", () => {
    const todayAtSix = new Date();
    todayAtSix.setHours(18, 0, 0, 0);
    const isoDeadline = todayAtSix.toISOString();
    const html = markup(
      <SubmitGateModal
        open
        gate={{ company: "E Corp", role: "Staff Engineer", deadline: isoDeadline }}
      />
    );

    expect(html).toContain("closes 6pm today");
    expect(html).not.toContain(isoDeadline);
  });
});

describe("EngineDownCover", () => {
  it("covers the workspace without implying that local data is lost", () => {
    const html = markup(
      <EngineDownCover
        open
        agentName="Paul"
        onRetry={() => {}}
        onOpenSettings={() => {}}
        onShowTechnical={() => {}}
        technicalDetails="Selected runtime returned RUNTIME_UNAVAILABLE."
      />
    );

    expect(html).toContain('role="alertdialog"');
    expect(html).toContain("Paul can&#x27;t think right now");
    expect(html).toContain("Your data is fine");
    expect(html).toContain("everything lives in local files");
    expect(html).toContain("Retry");
    expect(html).toContain("Open settings");
    expect(html).toContain("what happened, technically");
    expect(html).toContain("Selected runtime returned RUNTIME_UNAVAILABLE.");
  });
});
