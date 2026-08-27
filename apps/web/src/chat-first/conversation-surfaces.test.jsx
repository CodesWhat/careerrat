import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { normalizeSourceReviewArtifact } from "../../../../src/core/discovery/source-review-artifact.mjs";
import { GENERIC_ERROR_MESSAGE } from "../lib/errorCopy.js";
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
  SkillChatConversation,
  SubmitGateModal,
  TodayConversation,
} from "./conversation-surfaces.jsx";
import { hydrateSkillChatMessages } from "./skill-chat-model.js";

function markup(node) {
  return renderToStaticMarkup(node);
}

describe("TodayConversation", () => {
  it("renders current user turns on the shared quiet message surface", () => {
    const foundation = readFileSync(
      fileURLToPath(new URL("./app-foundation.css", import.meta.url)),
      "utf8"
    );
    const css = readFileSync(fileURLToPath(new URL("./chat-first.css", import.meta.url)), "utf8");
    const html = markup(
      <MessageTranscript
        messages={[
          {
            id: "intent",
            role: "user",
            kind: "intent",
            text: "Use this reviewed answer for the application.",
          },
        ]}
      />
    );

    expect(html).toContain("Use this reviewed answer for the application.");
    expect(foundation).toMatch(/--cf-message-user-surface:\s*var\(--tint-cool-2\)/);
    expect(foundation).toMatch(/--cf-message-user-foreground:\s*var\(--ink\)/);
    expect(css).toMatch(
      /\.chat-first-bubble--user\s*\{[^}]*color:\s*var\(--cf-message-user-foreground\)[^}]*background:\s*var\(--cf-message-user-surface\)/s
    );
    expect(css).not.toMatch(/\.chat-first-bubble--user\s*\{[^}]*background:\s*var\(--ink\)/s);
  });

  it("presents agent emphasis and headings without raw markdown controls", () => {
    const css = readFileSync(fileURLToPath(new URL("./chat-first.css", import.meta.url)), "utf8");
    const html = markup(
      <MessageTranscript
        messages={[
          {
            id: "formatted",
            role: "assistant",
            kind: "text",
            text: "## Search update\n**Good news:** three roles match.\n- New York",
          },
        ]}
      />
    );

    expect(html).toContain("Search update\nGood news: three roles match.\n- New York");
    expect(html).not.toContain("## Search update");
    expect(html).not.toContain("**Good news:**");
    expect(css).toMatch(/\.chat-first-bubble\s*\{[^}]*white-space:\s*pre-wrap/s);
  });

  it("offers Yes and No only for the latest unanswered typed binary question", () => {
    const onAnswer = vi.fn();
    const tree = MessageTranscript({
      onAnswer,
      answerBusy: true,
      messages: [
        {
          id: "question",
          role: "assistant",
          kind: "text",
          text: "Should I keep this company in your search?",
          metadata: { answerMode: "yes-no" },
        },
      ],
    });
    const buttons = [];
    function visit(node) {
      if (!node || typeof node !== "object") return;
      if (Array.isArray(node)) {
        node.forEach(visit);
        return;
      }
      if (typeof node.type === "function") {
        visit(node.type(node.props));
        return;
      }
      if (node.type === "button") buttons.push(node);
      visit(node.props?.children);
    }
    visit(tree);

    expect(buttons.map((button) => button.props.children)).toEqual(["Yes", "No"]);
    expect(buttons.every((button) => button.props.disabled === true)).toBe(true);
    buttons[1].props.onClick();
    expect(onAnswer).toHaveBeenCalledWith("No");

    const answered = markup(
      <MessageTranscript
        onAnswer={onAnswer}
        messages={[
          {
            id: "question",
            role: "assistant",
            kind: "text",
            text: "Should I keep this company in your search?",
            metadata: { answerMode: "yes-no" },
          },
          { id: "answer", role: "user", kind: "text", text: "No" },
        ]}
      />
    );
    const untyped = markup(
      <MessageTranscript
        onAnswer={onAnswer}
        messages={[
          {
            id: "looks-binary",
            role: "assistant",
            kind: "text",
            text: "Would you rather focus on platform or product roles?",
          },
        ]}
      />
    );

    expect(answered).not.toContain("chat-first-binary-actions");
    expect(untyped).not.toContain("chat-first-binary-actions");
  });

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
        onMessageAction={() => undefined}
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
                  rejectionSamples: {
                    title: [
                      {
                        company: "Acme",
                        title: "Sales Engineer",
                        location: "Remote - US",
                        reason: "title-negative-blocker",
                        kind: "blocker",
                      },
                    ],
                    location: [
                      {
                        company: "Elsewhere",
                        title: "Staff Engineer",
                        location: "Remote Spain",
                        reason: "location-policy-mismatch",
                      },
                    ],
                  },
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
    expect(html).toContain("Why some jobs were filtered");
    expect(html).toContain("Sales Engineer at Acme");
    expect(html).toContain("blocked by your role settings");
    expect(html).toContain("Remote Spain");
    expect(html).toContain("outside your location settings");
    expect(html).not.toContain(">activity<");
    expect(html).not.toContain("[object Object]");
  });

  it("replaces browser-workflow failure summaries with actionable candidate copy", () => {
    const html = markup(
      <MessageTranscript
        onMessageAction={() => undefined}
        messages={[
          {
            id: "browser-failed",
            role: "assistant",
            kind: "action_result",
            text: "Browser failed at /Users/person/workspace with password=hunter2 and route schema output.",
            metadata: {
              mark: "secret=receipt-mark",
              actionLabel: "/Users/person/open-debug-log",
            },
            artifacts: [
              {
                kind: "browser_workflow_result",
                state: "needs-user",
                title: "parser.mjs:42 provider openai secret=abc123",
                icon: "password=icon-secret",
                actionLabel: "Open /Users/person/private/report",
                secondaryActions: [
                  { id: "raw", label: "bearer auxiliary-secret", onAction: () => undefined },
                ],
                summary:
                  "Model output did not match the route schema for provider openai at /Users/person/workspace. password=hunter2\n    at parseResponse (parser.mjs:42:9)",
              },
            ],
          },
        ]}
      />
    );

    expect(html).toContain(
      "CareerRat couldn&#x27;t finish this browser task. Try again. If it still doesn&#x27;t work, open Settings and check the browser connection."
    );
    expect(html).toContain("Browser task needs attention");
    expect(html).toContain("<strong>Browser task</strong>");
    expect(html).toContain(">🌐</span>");
    expect(html).not.toMatch(
      /route schema|provider openai|\/Users\/person|hunter2|secret=abc123|parseResponse|parser\.mjs|receipt-mark|icon-secret|auxiliary-secret/i
    );
  });

  it("does not trust a browser-workflow summary even when the result says it completed", () => {
    const html = markup(
      <MessageTranscript
        messages={[
          {
            id: "browser-complete",
            role: "assistant",
            kind: "action_result",
            text: "Browser task complete.",
            artifacts: [
              {
                kind: "browser_workflow_result",
                state: "completed",
                title: "Webmail check",
                summary: "Saved 2 messages. Debug route: /api/mail?secret=abc123",
              },
            ],
          },
        ]}
      />
    );

    expect(html).toContain("Browser task finished. Review what CareerRat saved.");
    expect(html).not.toMatch(/\/api\/mail|secret=abc123/i);
  });

  it("does not render diagnostic text from a non-receipt browser-workflow message", () => {
    const html = markup(
      <MessageTranscript
        messages={[
          {
            id: "browser-text-message",
            role: "assistant",
            kind: "text",
            text: "Provider failed at /Users/person/private with secret=abc123.",
            artifacts: [
              {
                kind: "browser_workflow_result",
                state: "needs-user",
                blockers: [{ code: "BROWSER_UNAVAILABLE" }],
              },
            ],
          },
        ]}
      />
    );

    expect(html).toContain(
      "CareerRat can&#x27;t open the browser yet. Open Settings, check the browser connection, then retry."
    );
    expect(html).toContain("Browser task needs attention");
    expect(html).not.toMatch(/provider failed|\/Users\/person|secret=abc123/i);
  });

  it("maps typed browser blockers to the right safe recovery step", () => {
    const html = markup(
      <MessageTranscript
        messages={[
          {
            id: "browser-consent",
            role: "assistant",
            kind: "action_result",
            text: "raw consent backend output",
            artifacts: [
              {
                kind: "browser_workflow_result",
                skill: "optimize-linkedin",
                state: "needs-user",
                blockers: [{ code: "CONSENT_REQUIRED" }],
              },
            ],
          },
          {
            id: "browser-status-url",
            role: "assistant",
            kind: "action_result",
            text: "raw status backend output",
            artifacts: [
              {
                kind: "browser_workflow_result",
                skill: "sync-status",
                state: "needs-user",
                blockers: [{ code: "STATUS_URL_REQUIRED" }],
              },
            ],
          },
          {
            id: "browser-auth",
            role: "assistant",
            kind: "action_result",
            text: "raw auth backend output",
            artifacts: [
              {
                kind: "browser_workflow_result",
                skill: "ingest-mail",
                state: "needs-user",
                blockers: [{ code: "AUTH_REQUIRED" }],
              },
            ],
          },
        ]}
      />
    );

    expect(html).toContain("CareerRat needs your permission for this browser task");
    expect(html).toContain("signed-in application dashboard link");
    expect(html).toContain("Sign in or finish the verification step in the CareerRat browser");
    expect(html).not.toMatch(/raw (?:consent|status|auth) backend output/i);
  });

  it("keeps a malformed persisted artifact field from crashing the transcript", () => {
    const html = markup(
      <MessageTranscript
        messages={[
          {
            id: "legacy-malformed-artifacts",
            role: "assistant",
            kind: "action_result",
            text: "Action updated",
            artifacts: { kind: "browser_workflow_result", title: "/Users/person/private" },
          },
        ]}
      />
    );

    expect(html).toContain("Action updated");
    expect(html).not.toContain("/Users/person/private");
  });

  it("does not claim a dedupe-only refresh found zero useful jobs", () => {
    const html = markup(
      <MessageTranscript
        messages={[
          {
            id: "search-refresh",
            role: "assistant",
            kind: "action_result",
            text: "Job search complete.",
            artifacts: [
              {
                kind: "search_run",
                title: "First job search: Complete",
                summary: {
                  attemptedSources: 5,
                  scanned: 358,
                  qualified: 0,
                  reasonCounts: { duplicate: 4 },
                },
              },
            ],
          },
        ]}
      />
    );

    expect(html).toContain("4 matches already saved · 358 scanned · 5 sources");
    expect(html).not.toContain("0 qualified");
  });

  it("collapses superseded search activity into the latest compact result", () => {
    const searchArtifact = (runId, status) => ({
      kind: "search_run",
      title: `First job search: ${status === "running" ? "Running" : "Complete"}`,
      purpose: "first-search",
      runId,
      status,
      summary:
        status === "completed"
          ? { attemptedSources: 2, scanned: runId === "run-2" ? 240 : 200, qualified: 0 }
          : null,
    });
    const html = markup(
      <MessageTranscript
        onMessageAction={() => undefined}
        messages={[
          {
            id: "user-1",
            role: "user",
            kind: "intent",
            text: "Search for qualified jobs.",
            intent: { type: "search.run" },
          },
          {
            id: "start-1",
            role: "assistant",
            kind: "action_result",
            text: "Job search started.",
            artifacts: [searchArtifact("run-1", "running")],
          },
          {
            id: "done-1",
            role: "assistant",
            kind: "action_result",
            text: "Job search complete.",
            artifacts: [searchArtifact("run-1", "completed")],
          },
          {
            id: "user-2",
            role: "user",
            kind: "intent",
            text: "Search for qualified jobs.",
            intent: { type: "search.run" },
          },
          {
            id: "start-2",
            role: "assistant",
            kind: "action_result",
            text: "Job search started.",
            artifacts: [searchArtifact("run-2", "running")],
          },
          {
            id: "done-2",
            role: "assistant",
            kind: "action_result",
            text: "Job search complete.",
            artifacts: [searchArtifact("run-2", "completed")],
          },
        ]}
      />
    );

    expect(html.match(/First job search: Complete/g)).toHaveLength(1);
    expect(html).toContain("240 scanned");
    expect(html).not.toContain("200 scanned");
    expect(html).not.toContain("First job search: Running");
    expect(html).not.toContain("Search for qualified jobs");
    expect(html).not.toContain("Job search started");
    expect(html).not.toContain("Action updated");
    expect(html).not.toContain(">activity<");
  });

  it("keeps one real company-review card while compacting its search lifecycle", () => {
    const proposal = {
      kind: "company_proposals",
      batchId: "batch-1",
      title: "Company discovery: 3 to review",
    };
    const html = markup(
      <MessageTranscript
        messages={[
          {
            id: "search-start",
            role: "assistant",
            kind: "action_result",
            text: "Job search started.",
            artifacts: [
              {
                kind: "search_run",
                purpose: "manual-search",
                runId: "run-1",
                status: "running",
                title: "Job search: Running",
              },
              proposal,
            ],
          },
          {
            id: "search-done",
            role: "assistant",
            kind: "action_result",
            text: "Job search complete.",
            artifacts: [
              {
                kind: "search_run",
                purpose: "manual-search",
                runId: "run-1",
                status: "completed",
                title: "Job search: Complete",
              },
              proposal,
            ],
          },
        ]}
      />
    );

    expect(html.match(/Company discovery: 3 to review/g)).toHaveLength(1);
    expect(html).toContain("Job search: Complete");
    expect(html).not.toContain("Job search: Running");
    expect(html).not.toContain("Job search started");
    expect(html).not.toContain("Job search complete");
  });

  it("prefers a terminal search artifact over an older running artifact when history is newest-first", () => {
    const html = markup(
      <MessageTranscript
        messages={[
          {
            id: "done",
            sequence: 53,
            role: "assistant",
            kind: "action_result",
            artifacts: [
              {
                kind: "search_run",
                purpose: "first-search",
                runId: "run-1",
                status: "completed",
                title: "First job search: Complete",
              },
            ],
          },
          {
            id: "running",
            sequence: 50,
            role: "assistant",
            kind: "action_result",
            artifacts: [
              {
                kind: "search_run",
                purpose: "first-search",
                runId: "run-1",
                status: "running",
                title: "First job search: Running",
              },
            ],
          },
        ]}
      />
    );

    expect(html).toContain("First job search: Complete");
    expect(html).not.toContain("First job search: Running");
  });

  it("offers binary controls for a clear persisted yes-or-no question without model metadata", () => {
    const html = markup(
      <MessageTranscript
        onAnswer={() => undefined}
        messages={[
          {
            id: "sponsorship",
            role: "assistant",
            kind: "text",
            text: "Do you need employer sponsorship now or in the future?",
          },
        ]}
      />
    );

    expect(html).toContain(">Yes<");
    expect(html).toContain(">No<");
  });

  it("does not collapse a compound persisted question into one Yes or No choice", () => {
    const html = markup(
      <MessageTranscript
        onAnswer={() => undefined}
        messages={[
          {
            id: "authorization-and-sponsorship",
            role: "assistant",
            kind: "text",
            text: "Are you authorized to work in the US and will you need sponsorship?",
          },
        ]}
      />
    );

    expect(html).not.toContain(">Yes<");
    expect(html).not.toContain(">No<");
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
          metadata: { actionLabel: "Details" },
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
    buttons.find((button) => button.props.children === "Details").props.onClick();

    const html = markup(tree);
    expect(html).toContain("Packet drafted.");
    expect(html).toContain("Tyrell resume");
    expect(html).toContain("Tyrell cover letter");
    expect(html).toContain("📄");
    expect(html).toContain("✉️");
    expect(html).toContain("Evidence backed");
    expect(html).toContain(GENERIC_ERROR_MESSAGE);
    expect(html).not.toContain("Source sweep could not finish.");
    expect(html).toContain("chat-first-run-receipt--error");
    expect(html).not.toContain(">activity<");
    expect(onArtifactAction).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "resume" }),
      expect.objectContaining({ id: "done" })
    );
    expect(onMessageAction).toHaveBeenCalledWith(expect.objectContaining({ id: "done" }));
  });

  it("maps persisted and legacy transcript errors without rendering raw internal copy", () => {
    const raw = "answers contains unresolved placeholders";
    const messages = [
      {
        id: "persisted-error",
        role: "assistant",
        kind: "action_error",
        text: raw,
        error: { code: "ACTION_FAILED", message: raw },
      },
      {
        id: "legacy-error",
        role: "assistant",
        kind: "agent_error",
        text: `body.${raw}`,
      },
      {
        id: "mapped-error",
        role: "assistant",
        kind: "agent_error",
        text: "No AI key is configured for this workspace",
        error: { code: "missing_key", message: "No AI key is configured for this workspace" },
      },
    ];

    const html = markup(<MessageTranscript messages={messages} />);

    expect(html).toContain("No AI key is connected yet.");
    expect(html).toContain(GENERIC_ERROR_MESSAGE);
    expect(html).not.toContain(raw);
    expect(html).not.toContain(`body.${raw}`);
    expect(messages[0].error.message).toBe(raw);
  });

  it("renders typed actions only for the latest actionable result", () => {
    const onIntentAction = vi.fn();
    const useAnswer = {
      type: "screening.answer-confirm",
      entity: { type: "application", id: "app-curri" },
      input: { question: "Who inspired Curri?", answer: "Mike" },
    };
    const resumeApply = {
      type: "job.apply",
      entity: { type: "application", id: "app-curri" },
      input: { resumeSession: true },
    };
    const tree = MessageTranscript({
      onIntentAction,
      messages: [
        {
          id: "drafted",
          role: "assistant",
          kind: "action_result",
          text: "Review this answer before using it.",
          metadata: { nextActions: [{ label: "Use this answer", intent: useAnswer }] },
        },
        {
          id: "confirmed",
          role: "assistant",
          kind: "action_result",
          text: "Confirmed this answer.",
          metadata: {
            nextActions: [{ label: "Resume supervised apply", intent: resumeApply }],
          },
        },
      ],
    });
    const buttons = [];
    function visit(node) {
      if (!node || typeof node !== "object") return;
      if (Array.isArray(node)) {
        node.forEach(visit);
        return;
      }
      if (typeof node.type === "function") {
        visit(node.type(node.props));
        return;
      }
      if (node.type === "button") buttons.push(node);
      visit(node.props?.children);
    }
    visit(tree);

    const labels = buttons.map((button) => button.props.children);
    expect(labels).toContain("Resume supervised apply");
    expect(labels).not.toContain("Use this answer");
    buttons.find((button) => button.props.children === "Resume supervised apply").props.onClick();
    expect(onIntentAction).toHaveBeenCalledWith(
      resumeApply,
      expect.objectContaining({ id: "confirmed" }),
      expect.objectContaining({ label: "Resume supervised apply" })
    );
  });

  it.each(["action_result", "action_error"])(
    "retires old typed actions after a terminal %s without follow-ups",
    (terminalKind) => {
      const html = markup(
        <MessageTranscript
          onIntentAction={vi.fn()}
          messages={[
            {
              id: "offered",
              role: "assistant",
              kind: "action_result",
              text: "Review this answer before using it.",
              metadata: {
                nextActions: [
                  {
                    label: "Use this answer",
                    intent: {
                      type: "screening.answer-confirm",
                      entity: { type: "application", id: "app-curri" },
                    },
                  },
                ],
              },
            },
            {
              id: "terminal",
              role: "assistant",
              kind: terminalKind,
              text:
                terminalKind === "action_error" ? "That action failed." : "That action is done.",
            },
          ]}
        />
      );

      expect(html).not.toContain("Use this answer");
    }
  );

  it("derives the handoff glyph for durable transcript artifacts", () => {
    const html = markup(
      <MessageTranscript
        messages={[
          {
            id: "artifacts",
            role: "assistant",
            kind: "action_result",
            text: "Files ready.",
            artifacts: [
              { kind: "interview_dossier", title: "Interview dossier" },
              { kind: "story_bank", title: "Story bank" },
              { kind: "evidence", title: "Evidence bank" },
            ],
          },
        ]}
      />
    );

    expect(html).toContain("📕");
    expect(html).toContain("⭐");
    expect(html).toContain("🧾");
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

describe("SkillChatConversation", () => {
  it("collapses the real board-research payload into one review card without transcript bookkeeping", () => {
    const candidates = [
      ["LandEarly", "https://www.landearly.com/remote-jobs/platform-engineer", "url-query", "high"],
      ["4 Day Week", "https://4dayweek.io/platform-engineering-jobs", "url-query", "high"],
      [
        "TrulyRemote Dev",
        "https://trulyremote.dev/remote-backend-engineer-jobs",
        "url-query",
        "high",
      ],
      [
        "Built In",
        "https://builtin.com/jobs/remote/dev-engineering/search/platform-engineer",
        "url-query",
        "high",
      ],
      [
        "RemotePilot",
        "https://remotepilot.dev/categories/backend-engineering/",
        "url-query",
        "borderline",
      ],
      ["DevJobsList", "https://www.devjobslist.com/", "browser", "borderline"],
    ].map(([label, url, sourceType, confidence]) => ({
      label,
      url,
      sourceType,
      confidence,
      why: `${label} has dated relevant listings`,
      status: "proposed",
    }));
    candidates.push({
      label: "Anywhere Devs",
      url: "https://anywheredevs.com/",
      sourceType: "browser",
      why: "Landing page claims fresh remote engineering coverage but exposes no specific listings",
      status: "rejected",
      rejectionReason: "no visible dated listing",
    });
    const review = normalizeSourceReviewArtifact({ kind: "source_review", candidates });
    const html = markup(
      <SkillChatConversation
        thread={{
          title: "Job board discovery",
          skill: "research-boards",
          state: "idle",
        }}
        messages={[
          {
            id: "result",
            role: "assistant",
            kind: "text",
            text: "I found 6 useful sources. Nothing has been added yet.",
            artifacts: [review],
          },
        ]}
        onDecision={() => {}}
        onComplete={() => {}}
        onReviewSources={() => {}}
      />
    );

    expect(html).toContain("6 sources found");
    expect(html).toContain("LandEarly");
    expect(html).toContain("4 Day Week");
    expect(html).toContain("TrulyRemote Dev");
    expect(html).toContain("Built In");
    expect(html).toContain("Review sources");
    expect(html).not.toContain("RemotePilot");
    expect(html).not.toContain("Anywhere Devs");
    expect(html).not.toContain("Save to workspace");
    expect(html).not.toContain("Discard");
    expect(html).not.toContain("| # | Board |");
    expect(html).not.toContain("BOARDS FOUND");
    expect(html.match(/chat-first-indented-card/g)).toHaveLength(1);
  });

  it("renders a persisted historical board ledger as the source review card instead of raw text", () => {
    const messages = hydrateSkillChatMessages({
      id: "skill:research-boards",
      skill: "research-boards",
      messages: [
        {
          id: "persisted-table-review",
          role: "assistant",
          text: [
            "I found two useful new sources. Nothing has been added yet.",
            "| # | Board | Source type | Why relevant | Status |",
            "|---|---|---|---|---|",
            "| 1 | [LandEarly](https://www.landearly.com/remote-jobs/platform-engineer) | url-query | Dated US platform roles | NEW |",
            "| 2 | [DevJobsList](https://www.devjobslist.com/) | browser | Dated remote software listings | NEW (borderline: weak targeting) |",
            "BOARDS FOUND: 2 screened",
            "PROPOSED (new): 2 (1 high-confidence, 1 borderline/medium)",
            "REJECTED: 0",
            "AUTO-ADDED: none",
          ].join("\n"),
        },
      ],
    });
    const html = markup(
      <SkillChatConversation
        thread={{ title: "Job board discovery", skill: "research-boards", state: "idle" }}
        messages={messages}
        onDecision={() => {}}
        onComplete={() => {}}
        onReviewSources={() => {}}
      />
    );

    expect(html).toContain("2 sources found");
    expect(html).toContain("LandEarly");
    expect(html).toContain("DevJobsList");
    expect(html).toContain("Review sources");
    expect(html).not.toContain("| # | Board |");
    expect(html).not.toContain("BOARDS FOUND");
    expect(html).not.toContain("AUTO-ADDED");
  });

  it("never renders the raw completion marker and gates completion on proposal decisions", () => {
    const onComplete = vi.fn();
    const completion = {
      id: "discovery:research-boards:discovery_complete:research-boards",
      kind: "discovery_complete",
      step: "research-boards",
    };
    const messages = [
      {
        id: "result",
        role: "assistant",
        kind: "text",
        text: "Board review is ready.",
        artifacts: [
          {
            id: "source-1",
            kind: "source_proposal",
            label: "Remote OK",
            url: "https://remoteok.com/remote-dev-jobs",
          },
          completion,
        ],
      },
    ];

    const pending = SkillChatConversation({
      thread: { title: "Job board discovery", state: "idle" },
      messages,
      onComplete,
    });
    expect(markup(pending)).not.toContain("Finish board discovery");
    expect(markup(pending)).not.toContain("careerrat:discovery");

    const ready = SkillChatConversation({
      thread: { title: "Job board discovery", state: "idle" },
      messages: [
        {
          ...messages[0],
          artifacts: [
            { ...messages[0].artifacts[0], decision: { action: "discard", status: "completed" } },
            completion,
          ],
        },
      ],
      onComplete,
    });
    const buttons = [];
    function visit(node) {
      if (!node || typeof node !== "object") return;
      if (Array.isArray(node)) return node.forEach(visit);
      if (typeof node.type === "function") return visit(node.type(node.props));
      if (node.type === "button") buttons.push(node);
      visit(node.props?.children);
    }
    visit(ready);
    const finish = buttons.find((button) => button.props.children === "Finish board discovery");
    expect(finish).toBeTruthy();
    finish.props.onClick();
    expect(onComplete).toHaveBeenCalledWith(completion);
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
    const css = readFileSync(fileURLToPath(new URL("./chat-first.css", import.meta.url)), "utf8");
    const html = markup(
      <JobContextPanel
        job={{
          company: "Cyberdyne Systems International Autonomous Logistics Division",
          role: "Staff Machine Learning Infrastructure and Autonomous Systems Engineer",
          stage: "Hiring manager review in progress",
          fit: 86,
          compensation: "$190,000 - $225,000",
          compensationNote: "Posted range clears the candidate floor.",
          location: "New York, NY",
          mode: "Hybrid",
          source: "Ashby · posted Aug 19",
          fitReasons: ["Platform scale matches the role"],
          risks: ["No robotics experience recorded"],
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
    expect(html).toContain("COMPENSATION");
    expect(html).toContain("$190,000 - $225,000");
    expect(html).toContain("Posted range clears the candidate floor.");
    expect(html).toContain("New York, NY · Hybrid");
    expect(html).toContain("Ashby · posted Aug 19");
    expect(html).toContain("Prep plan");
    expect(html).toContain("chat-first-context-card__fact--status");
    expect(html).toContain("<small>Prep plan</small>");
    expect(html).not.toContain(
      '<div class="chat-first-context-card__section"><strong>Prep plan</strong>'
    );
    expect(html).toContain("Why it fits");
    expect(html).toContain("Watch");
    expect(html).not.toContain("chat-first-context-card--cream");
    const jobCard = html.match(
      /<section class="chat-first-context-card chat-first-context-card--job">[\s\S]*?<\/section>/
    )?.[0];
    expect(jobCard).toContain("$190,000 - $225,000");
    expect(jobCard).toContain("New York, NY · Hybrid");
    expect(jobCard).toContain("Ashby · posted Aug 19");
    expect(jobCard).toContain("Tue: systems design mock");
    expect(jobCard).toContain("Why it fits");
    expect(jobCard).toContain("Watch");
    expect(html).toContain("Interview dossier");
    expect(html).toContain("Open");
    expect(html).toContain("Export PDF");
    expect(html).toContain("Run mock interview");
    expect(css).toMatch(
      /\.chat-first-context-card__stage\s*\{[^}]*max-width:\s*42%[^}]*overflow-wrap:\s*anywhere/s
    );
    expect(css).toMatch(
      /\.chat-first-context-card__title,[^{]*\.chat-first-context-card__section li\s*\{[^}]*overflow-wrap:\s*anywhere/s
    );
  });

  it("never lets retired placement hints detach a job summary from the structured card", () => {
    const html = markup(
      <JobContextPanel
        job={{ company: "Cyberdyne", role: "Staff ML Engineer", stage: "Interview", fit: 86 }}
        files={[{ id: "dossier", name: "Interview dossier" }]}
        summary={{ title: "Prep plan", lines: ["Tue: systems design mock"] }}
        summaryPosition="after-files"
      />
    );

    expect(html).toContain("chat-first-context-card__fact--status");
    expect(html).toContain("<small>Prep plan</small>");
    expect(html).not.toContain("chat-first-context-card--cream");
    expect(html.indexOf("Prep plan")).toBeLessThan(html.indexOf("Interview dossier"));
  });

  it("does not repeat a work mode already stated by the location", () => {
    const html = markup(
      <JobContextPanel
        job={{
          company: "Curri",
          role: "Senior Software Engineer",
          stage: "Reviewed Hold",
          fit: 85,
          location: "Remote - United States",
          mode: "remote",
        }}
      />
    );

    expect(html).toContain("Remote - United States");
    expect(html).not.toContain("Remote - United States · Remote");
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

  it("lets someone retry or remove a failed deep-ingest source", () => {
    const source = {
      id: "source-failed",
      label: "career-notes.txt",
      statusLabel: "CareerRat couldn't read this source. Try again or remove it.",
      canRetry: true,
      canRemove: true,
    };
    const onRetry = vi.fn();
    const onRemove = vi.fn();
    const tree = DeepIngestConversation({
      sources: [source],
      counts: { sources: 1 },
      onRetry,
      onRemove,
    });
    const buttons = [];

    function visit(node) {
      if (!node || typeof node !== "object") return;
      if (Array.isArray(node)) {
        node.forEach(visit);
        return;
      }
      if (node.type === "button") buttons.push(node);
      visit(node.props?.children);
    }
    visit(tree);

    const retry = buttons.find((button) => button.props.children === "Try again");
    const remove = buttons.find((button) => button.props.children === "Remove source");
    expect(retry).toBeDefined();
    expect(remove).toBeDefined();
    retry.props.onClick();
    remove.props.onClick();
    expect(onRetry).toHaveBeenCalledWith(source);
    expect(onRemove).toHaveBeenCalledWith(source);
  });

  it("shows deep-ingest findings one at a time instead of an action wall", () => {
    const proposals = Array.from({ length: 8 }, (_, index) => ({
      id: `proposal-${index + 1}`,
      lane: index ? "open_gaps" : "evidence_claims",
      title: index ? `Later finding ${index + 1}` : "First grounded finding",
      summary: `Finding ${index + 1} summary`,
    }));
    const html = markup(
      <DeepIngestConversation
        counts={{ reviewQueue: 8 }}
        proposals={proposals}
        onConfirm={() => {}}
        onDefer={() => {}}
        onReject={() => {}}
      />
    );

    expect(html).toContain("REVIEW 1 OF 8");
    expect(html).toContain("First grounded finding");
    expect(html).not.toContain("Later finding 2");
    expect((html.match(/chat-first-deep-proposal"/g) || []).length).toBe(1);
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
  it("makes final submit explicit and describes the local voluntary-question boundary", () => {
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
    expect(html).toContain("Voluntary form questions");
    expect(html).toContain("uses only your local Application defaults · otherwise left blank");
    expect(html).toContain("Nothing sends until you press submit.");
    expect(html).toContain("Return to Greenhouse &amp; submit ↗");
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
  it("covers the workspace without implying that local data is lost or exposing diagnostics", () => {
    const html = markup(
      <EngineDownCover
        open
        agentName="Paul"
        onRetry={() => {}}
        onOpenSettings={() => {}}
        onShowTechnical={() => {}}
        technicalDetails={
          "Provider route schema parser failed with RUNTIME_UNAVAILABLE at /Users/person/workspace. api_key=secret\n    at runAgent (runtime.mjs:18:4)"
        }
      />
    );

    expect(html).toContain('role="alertdialog"');
    expect(html).toContain("Paul can&#x27;t think right now");
    expect(html).toContain("Your data is fine");
    expect(html).toContain("everything lives in local files");
    expect(html).toContain("Retry");
    expect(html).toContain("Open settings");
    expect(html).toContain("what happened, technically");
    expect(html).toContain(
      "CareerRat hides raw technical details here because they can include private information."
    );
    expect(html).not.toMatch(
      /provider route|schema parser|RUNTIME_UNAVAILABLE|\/Users\/person|api_key|secret|runAgent|runtime\.mjs/i
    );
  });
});
