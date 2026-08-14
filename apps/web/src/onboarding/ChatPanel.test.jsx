// apps/web/src/onboarding/ChatPanel.test.jsx
// Same house convention as InterviewSurface.test.jsx/JobDrawer.test.jsx:
// default "node" vitest environment, no jsdom — a hand-rolled hook harness
// (ChatPanel only ever calls useState, no useEffect/useRef/useCallback)
// replaces React's own, the component is invoked as a plain function, and
// the returned element tree is walked directly. Button/TextArea are left
// unmocked and expanded via expand() (same technique as InterviewSurface's
// own harness) since they're plain host-element wrappers; InlineAlert and
// useEventSource are mocked so error payloads and the SSE wiring can be read
// straight off captured props/calls instead of parsed back out of markup.
import { beforeEach, describe, expect, it, vi } from "vitest";

const hooks = vi.hoisted(() => ({
  cursor: 0,
  state: [],
  reset() {
    this.cursor = 0;
    this.state = [];
  },
  begin() {
    this.cursor = 0;
  },
  useState(initial) {
    const index = this.cursor++;
    if (!(index in this.state))
      this.state[index] = typeof initial === "function" ? initial() : initial;
    return [
      this.state[index],
      (next) => {
        this.state[index] = typeof next === "function" ? next(this.state[index]) : next;
      },
    ];
  },
}));

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    useState: (initial) => hooks.useState(initial),
  };
});

const api = vi.hoisted(() => ({
  // resolveErrorCopy() (lib/errorCopy.js) checks `err instanceof ApiError` —
  // real callers throw the real class, so this mock has to supply one too,
  // same as the other converted-site test fixtures.
  ApiError: class ApiError extends Error {
    constructor(status, body) {
      super(`request failed with status ${status}`);
      this.name = "ApiError";
      this.status = status;
      this.body = body;
    }
  },
  addBoard: vi.fn(),
  closeChat: vi.fn(),
  saveCompanyBoard: vi.fn(),
  sendChatMessage: vi.fn(),
  startChat: vi.fn(),
}));
vi.mock("../lib/api.js", () => api);

vi.mock("../components/Toast.jsx", () => ({ InlineAlert: "inline-alert" }));

const sse = vi.hoisted(() => ({ calls: [] }));
vi.mock("../lib/sse.js", () => ({
  useEventSource: (url, opts) => {
    sse.calls.push({ url, opts });
  },
}));

import { ChatPanel } from "./ChatPanel.jsx";

function expand(node) {
  if (node == null || typeof node !== "object") return node;
  if (Array.isArray(node)) return node.map(expand);
  if (typeof node.type === "function") return expand(node.type(node.props));
  return { ...node, props: { ...node.props, children: expand(node.props?.children) } };
}

function visit(node, predicate, found = []) {
  if (node == null || typeof node === "boolean") return found;
  if (Array.isArray(node)) {
    for (const child of node) visit(child, predicate, found);
    return found;
  }
  if (typeof node !== "object") return found;
  if (predicate(node)) found.push(node);
  visit(node.props?.children, predicate, found);
  return found;
}

function textOf(node) {
  if (node == null || typeof node === "boolean") return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textOf).join("");
  return textOf(node.props?.children);
}

function byTag(tree, tag) {
  return visit(tree, (n) => n.type === tag)[0];
}

function button(tree, label) {
  return visit(tree, (n) => n.type === "button" && textOf(n) === label)[0];
}

function render(props) {
  hooks.begin();
  return expand(ChatPanel(props));
}

async function flush() {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

beforeEach(() => {
  hooks.reset();
  vi.clearAllMocks();
  sse.calls = [];
});

describe("ChatPanel — start failure", () => {
  it("a non-409 startChat failure renders the resolved friendly message, not the raw server string, with a working retry", async () => {
    // 422 deliberately isn't one of resolveErrorCopy's mapped statuses/
    // strings, so this exercises the true generic bucket, where the bespoke
    // "Could not start" fallback (not resolveErrorCopy's own
    // GENERIC_ERROR_MESSAGE) applies.
    api.startChat.mockRejectedValueOnce(
      new api.ApiError(422, { error: "skill ingest-profile is not registered" })
    );
    api.startChat.mockResolvedValueOnce({ chatId: "chat-retry-1", state: "running" });

    let tree = render({ skill: "ingest-profile", kickoffLabel: "Start interview" });
    expect(byTag(tree, "inline-alert")).toBeUndefined();

    await button(tree, "Start interview").props.onClick();
    await flush();
    tree = render({ skill: "ingest-profile", kickoffLabel: "Start interview" });

    const alert = byTag(tree, "inline-alert");
    expect(alert).toBeTruthy();
    expect(alert.props.message).toBe("Could not start");
    expect(alert.props.message).not.toContain("ingest-profile is not registered");
    expect(alert.props.detail).toBe("skill ingest-profile is not registered");
    expect(alert.props.action.retry).toBe(true);
    expect(typeof alert.props.action.onRetry).toBe("function");

    await alert.props.action.onRetry();
    await flush();
    tree = render({ skill: "ingest-profile", kickoffLabel: "Start interview" });

    expect(byTag(tree, "inline-alert")).toBeUndefined();
    expect(api.startChat).toHaveBeenLastCalledWith("ingest-profile");
    expect(button(tree, "End session")).toBeTruthy();
  });

  it("a 409 with a chatId reconnects instead of showing an error", async () => {
    api.startChat.mockRejectedValueOnce(
      Object.assign(new Error("conflict"), { status: 409, body: { chatId: "existing-chat-1" } })
    );

    let tree = render({ skill: "ingest-profile", kickoffLabel: "Start interview" });
    await button(tree, "Start interview").props.onClick();
    await flush();
    tree = render({ skill: "ingest-profile", kickoffLabel: "Start interview" });

    expect(byTag(tree, "inline-alert")).toBeUndefined();
    expect(button(tree, "End session")).toBeTruthy();
  });
});

describe("ChatPanel — send failure", () => {
  it("a message-send failure renders the resolved friendly message, not the raw server string, and retry re-sends the exact same text", async () => {
    api.sendChatMessage.mockRejectedValueOnce(
      new api.ApiError(422, { error: "chat chat-99 has no active turn" })
    );
    api.sendChatMessage.mockResolvedValueOnce({ ok: true });

    let tree = render({
      skill: "ingest-profile",
      kickoffLabel: "Start interview",
      initialChatId: "chat-99",
    });
    const textarea = byTag(tree, "textarea");
    textarea.props.onChange({ target: { value: "What roles fit me?" } });
    tree = render({
      skill: "ingest-profile",
      kickoffLabel: "Start interview",
      initialChatId: "chat-99",
    });

    await button(tree, "Send").props.onClick();
    await flush();
    tree = render({
      skill: "ingest-profile",
      kickoffLabel: "Start interview",
      initialChatId: "chat-99",
    });

    const userBubble = visit(
      tree,
      (n) => n.type === "div" && n.props?.className?.includes("chat-bubble--user")
    )[0];
    expect(textOf(userBubble)).toBe("What roles fit me?");

    const alert = byTag(tree, "inline-alert");
    expect(alert).toBeTruthy();
    expect(alert.props.message).toBe("Message failed to send.");
    expect(alert.props.message).not.toContain("no active turn");
    expect(alert.props.detail).toBe("chat chat-99 has no active turn");
    expect(alert.props.action.retry).toBe(true);

    await alert.props.action.onRetry();
    await flush();
    tree = render({
      skill: "ingest-profile",
      kickoffLabel: "Start interview",
      initialChatId: "chat-99",
    });

    expect(byTag(tree, "inline-alert")).toBeUndefined();
    expect(api.sendChatMessage).toHaveBeenCalledTimes(2);
    expect(api.sendChatMessage).toHaveBeenNthCalledWith(1, "chat-99", "What roles fit me?");
    expect(api.sendChatMessage).toHaveBeenNthCalledWith(2, "chat-99", "What roles fit me?");
  });
});

describe("ChatPanel — typed discovery proposals", () => {
  it("adds a reviewed source through the source API and advances only after every decision", async () => {
    api.addBoard.mockResolvedValue({ ok: true });
    api.closeChat.mockResolvedValue({ ok: true });
    const onComplete = vi.fn().mockResolvedValue(undefined);
    const props = {
      skill: "research-boards",
      initialChatId: "boards-chat",
      completionLabel: "Continue to company discovery",
      onComplete,
    };

    render(props);
    const onEvent = sse.calls.at(-1).opts.onEvent;
    onEvent(
      "assistant",
      JSON.stringify({
        message: {
          content: [
            {
              type: "text",
              text: [
                "I found one new board.",
                "```careerrat:discovery",
                JSON.stringify({
                  kind: "source_proposal",
                  label: "AI Jobs Board",
                  url: "https://example.com/jobs",
                  why: "Current dated applied-AI listings",
                  confidence: "high",
                }),
                "```",
                "```careerrat:discovery",
                JSON.stringify({ kind: "discovery_complete", step: "research-boards" }),
                "```",
              ].join("\n"),
            },
          ],
        },
      })
    );
    onEvent("chat_state", JSON.stringify({ state: "idle" }));

    let tree = render(props);
    expect(button(tree, "Continue to company discovery")).toBeUndefined();
    await button(tree, "Add source").props.onClick();
    await flush();
    tree = render(props);

    expect(api.addBoard).toHaveBeenCalledWith({
      label: "AI Jobs Board",
      url: "https://example.com/jobs",
    });
    expect(textOf(tree)).toContain("Added");

    await button(tree, "Continue to company discovery").props.onClick();
    await flush();
    expect(onComplete).toHaveBeenCalledWith({ skill: "research-boards" });
    expect(api.closeChat).toHaveBeenCalledWith("boards-chat");
  });

  it("tracks a reviewed company through the supported board API", async () => {
    api.saveCompanyBoard.mockResolvedValue({ ok: true });
    const props = { skill: "discover-companies", initialChatId: "companies-chat" };
    render(props);
    sse.calls.at(-1).opts.onEvent(
      "assistant",
      JSON.stringify({
        message: {
          content: [
            {
              type: "text",
              text: `\`\`\`careerrat:discovery\n${JSON.stringify({
                kind: "company_proposal",
                name: "Example Co",
                url: "https://jobs.ashbyhq.com/example",
                why: "Hiring the target role",
                confidence: "high",
              })}\n\`\`\``,
            },
          ],
        },
      })
    );

    let tree = render(props);
    await button(tree, "Track company").props.onClick();
    await flush();
    tree = render(props);

    expect(api.saveCompanyBoard).toHaveBeenCalledWith({
      name: "Example Co",
      url: "https://jobs.ashbyhq.com/example",
      enabled: true,
    });
    expect(textOf(tree)).toContain("Tracked");
  });
});
