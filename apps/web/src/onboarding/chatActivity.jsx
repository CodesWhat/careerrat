import {
  EyeIcon,
  GlobeIcon,
  PencilIcon,
  SettingsIcon,
  StarIcon,
  TerminalIcon,
} from "../components/icons.jsx";

// chatActivity — turns a chat runtime tool_use event's {name, input} (see
// mapSdkMessage in src/core/ai/skill-runtime.mjs) into the icon + friendly,
// present-tense label ChatPanel renders in place of the old raw "tool: X" /
// "result: ok|error" text lines. The product's audience is job seekers, not
// developers (see AGENTS.md's "teach as you go" framing), so the primary
// reading path never names an SDK tool — the raw name only ever shows up in
// the line's `title` attribute for a hover.
//
// Read/Glob/Grep all read as "looking at files" from the user's point of
// view even though they're distinct SDK tools; same for Write/Edit/
// NotebookEdit as "writing". Skill is handled separately by
// describeToolActivity below because its friendly label depends on the
// event's own input (the skill name), not a static table lookup.
const TOOL_ACTIVITY = {
  Read: { Icon: EyeIcon, label: "Reading files" },
  Glob: { Icon: EyeIcon, label: "Reading files" },
  Grep: { Icon: EyeIcon, label: "Reading files" },
  WebSearch: { Icon: GlobeIcon, label: "Searching the web" },
  WebFetch: { Icon: GlobeIcon, label: "Searching the web" },
  Write: { Icon: PencilIcon, label: "Writing" },
  Edit: { Icon: PencilIcon, label: "Writing" },
  NotebookEdit: { Icon: PencilIcon, label: "Writing" },
  Bash: { Icon: TerminalIcon, label: "Running a command" },
};

// Anything not in TOOL_ACTIVITY and not "Skill" — an unmapped/future SDK
// tool never breaks the transcript, it just reads as generic "Working".
const DEFAULT_ACTIVITY = { Icon: SettingsIcon, label: "Working" };

const DETAIL_MAX = 60;

function truncate(text) {
  const trimmed = typeof text === "string" ? text.trim() : "";
  if (!trimmed) return "";
  return trimmed.length > DETAIL_MAX ? `${trimmed.slice(0, DETAIL_MAX - 1)}…` : trimmed;
}

// toolInputDetail — a short trailing detail pulled from the tool_use event's
// own `input` (the Agent SDK's real per-tool schema: Read/Write/Edit ->
// file_path, NotebookEdit -> notebook_path, Bash -> command, WebSearch ->
// query, WebFetch -> url, Glob/Grep -> pattern), so the line can read
// "Reading files: resume.pdf" instead of a bare "Reading files". Any
// field that isn't a string (or is missing) yields no detail rather than
// throwing — the input shape isn't guaranteed across SDK versions.
function toolInputDetail(name, input) {
  if (!input || typeof input !== "object") return "";
  switch (name) {
    case "Read":
    case "Write":
    case "Edit":
      return truncate(input.file_path);
    case "NotebookEdit":
      return truncate(input.notebook_path);
    case "Bash":
      return truncate(input.command);
    case "WebSearch":
      return truncate(input.query);
    case "WebFetch":
      return truncate(input.url);
    case "Glob":
    case "Grep":
      return truncate(input.pattern);
    default:
      return "";
  }
}

// describeToolActivity — pure name/input -> {Icon, label, detail} mapping.
// Exported so the tool-name-to-label table is unit-testable
// (chatActivity.test.jsx) without mounting ChatPanel.
export function describeToolActivity(name, input) {
  if (name === "Skill") {
    const skillName = typeof input?.skill === "string" ? input.skill.trim() : "";
    return {
      Icon: StarIcon,
      label: skillName ? `Using the ${skillName} skill` : "Using a skill",
      detail: "",
    };
  }
  const entry = TOOL_ACTIVITY[name] || DEFAULT_ACTIVITY;
  return { ...entry, detail: toolInputDetail(name, input) };
}
