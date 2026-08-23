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
  { id: "claude", name: "Claude Code", detected: true, ready: true, recommended: true },
  { id: "codex", name: "Codex", detected: true, ready: true },
];

const MESSAGES = [
  {
    id: "m1",
    role: "assistant",
    text: "One question at a time. First: what kind of role are you actually after?",
    options: [{ id: "staff-ml", label: "Staff SWE · ML infra · remote or hybrid SF" }],
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
  it("uses only the ink fill to mark the selected first-run rail item", () => {
    const css = readFileSync(fileURLToPath(new URL("./first-run.css", import.meta.url)), "utf8");
    const rule = css.match(/\.cf-first-run__paul-card\s*\{([^}]*)\}/)?.[1] || "";

    expect(rule).toMatch(/background:\s*#17171a/);
    expect(rule).not.toMatch(/border:\s*2px\s+solid\s+#e6fa8d/);
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
      engines: ENGINES,
      onSelectEngine,
    });
    const html = renderToStaticMarkup(tree);

    expect(html).toContain("Choose the AI that powers Paul");
    expect(html).toContain("Claude Code");
    expect(html).toContain("Ready · detected ✓");
    expect(html).toContain("RECOMMENDED");
    expect(html).toContain("no account, no CareerRat server");

    const choices = tree.props.children[2];
    choices.props.children[1].props.onClick();
    expect(onSelectEngine).toHaveBeenCalledWith("codex");
  });

  it("keeps first run to four compact icon choices and leaves the full list in settings", async () => {
    const { FirstRunExperience } = await loadFirstRun();
    const html = renderToStaticMarkup(
      <FirstRunExperience
        stage="engine"
        engines={[
          ...ENGINES,
          { id: "gemini", name: "Gemini CLI", detected: false, ready: false },
          { id: "opencode", name: "OpenCode", detected: false, ready: false },
          { id: "copilot", name: "GitHub Copilot CLI", detected: false, ready: false },
        ]}
      />
    );

    expect(html).toContain("Claude Code");
    expect(html).toContain("Codex");
    expect(html).toContain("Gemini CLI");
    expect(html).toContain("OpenCode");
    expect(html).not.toContain("GitHub Copilot CLI");
    expect(html.match(/cf-runtime-icon/g)).toHaveLength(4);
    expect(html).toContain("See all 5 in settings");
  });

  it("keeps sign-in-required engines inactive and routes setup through Settings", async () => {
    const { FirstRunExperience } = await loadFirstRun();
    const onSelectEngine = vi.fn();
    const onRetryEngine = vi.fn();
    const onOpenSettings = vi.fn();
    const tree = FirstRunExperience({
      stage: "engine",
      agentName: "Maya",
      engines: [
        {
          id: "claude",
          name: "Claude Code",
          detected: true,
          ready: false,
          status: "authentication_required",
          action: "open_terminal",
        },
        {
          id: "codex",
          name: "Codex",
          detected: false,
          ready: false,
          status: "not_found",
        },
      ],
      error: "Runtime check failed.",
      onSelectEngine,
      onRetryEngine,
      onOpenSettings,
    });
    const html = renderToStaticMarkup(tree);

    expect(html).toContain("Choose the AI that powers Maya");
    expect(html).toContain("Sign-in needed");
    expect(html).not.toContain("Open Terminal to sign in");
    expect(html).toContain("Not found");
    expect(html).toContain("Set up in settings");
    expect(html).toContain("Runtime check failed.");
    expect(html).toContain("Open settings");

    const setup = findElement(
      tree,
      (node) => node.type === "button" && textOf(node) === "Set up in settings"
    );
    const settings = findElement(
      tree,
      (node) => node.type === "button" && textOf(node) === "Open settings"
    );
    setup.props.onClick();
    settings.props.onClick();
    expect(onRetryEngine).not.toHaveBeenCalled();
    expect(onOpenSettings).toHaveBeenCalledTimes(2);
    expect(onSelectEngine).not.toHaveBeenCalled();
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
    });
    const panelElement = tree.props.children[2];
    const panel = panelElement.type(panelElement.props);
    const panelHtml = renderToStaticMarkup(panel);
    const edits = findElements(panel, (node) => node.type === "button" && textOf(node) === "Edit");

    expect(edits).toHaveLength(2);
    expect(panelHtml).toContain("✓ Staff Engineer");
    expect(panelHtml).not.toContain("✓ NYC");
    edits[0].props.onClick();
    edits[1].props.onClick();
    expect(onEditKnowledgeSection.mock.calls).toEqual([[roles], [quickFacts]]);
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
    const tree = KnowledgeSectionEditor({ item, onCancel, onSave });
    const html = renderToStaticMarkup(tree);

    expect(html).toContain('role="dialog"');
    expect(html).toContain('aria-modal="true"');
    expect(html).toContain("Edit Roles");
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

  it("accepts resume files from the conversation drop target and Resume section picker", async () => {
    const { FirstRunChat } = await loadFirstRun();
    const onResumeFile = vi.fn();
    const onEditKnowledgeSection = vi.fn();
    const resume = {
      id: "resume",
      label: "RESUME",
      status: "pending",
      lines: [],
      editor: { fields: [{ id: "resumeText", label: "Resume text", type: "textarea", value: "" }] },
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
    conversation.props.onDrop({ preventDefault, dataTransfer: { files: [file] } });

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
      (node) =>
        node.type === "button" && textOf(node) === "Staff SWE · ML infra · remote or hybrid SF"
    );
    option.props.onClick();
    expect(onChooseOption).toHaveBeenCalledWith("m1", "staff-ml");

    const composer = findElement(
      center,
      (node) => node.type === "form" && node.props.className === "cf-first-run__composer"
    );
    composer.props.children[0].props.onChange({ target: { value: "new answer" } });
    composer.props.onSubmit({ preventDefault: vi.fn() });
    expect(onDraftChange).toHaveBeenCalledWith("new answer");
    expect(onSubmitAnswer).toHaveBeenCalledWith("platform roles");
  });

  it("uses isolated fixed desktop geometry and handoff colors", () => {
    const css = readFileSync(fileURLToPath(new URL("./first-run.css", import.meta.url)), "utf8");

    expect(css).toContain("grid-template-columns: 250px minmax(0, 1fr) 272px");
    expect(css).toContain("#edf5fb");
    expect(css).toContain("#e6fa8d");
    expect(css).toContain("min-width: 1100px");
    expect(css).toContain(".cf-first-run__knowledge-card-heading");
    expect(css).toContain(".cf-first-run__knowledge-acknowledgement");
    expect(css).toContain(".cf-first-run__editor-cover");
    expect(css).toContain(".cf-first-run__composer-notice");
    expect(css).toContain(".cf-first-run__file-action");
    expect(css).not.toContain(".cf-first-run__confirmation-actions");
    expect(css).toMatch(
      /\.cf-first-run__engine-choices\s*\{[^}]*grid-template-columns:\s*repeat\(4,/s
    );
    expect(css).toMatch(/\.cf-first-run__engine-choice\s*\{[^}]*min-height:\s*96px/s);
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
  });
});
