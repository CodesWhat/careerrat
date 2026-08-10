import { beforeEach, describe, expect, it, vi } from "vitest";

const hooks = vi.hoisted(() => {
  const harness = {
    cursor: 0,
    effects: [],
    state: [],
    reset() {
      this.cursor = 0;
      this.effects = [];
      this.state = [];
    },
    begin() {
      this.cursor = 0;
      this.effects = [];
    },
    useState(initial) {
      const index = this.cursor++;
      if (!(index in this.state)) {
        this.state[index] = typeof initial === "function" ? initial() : initial;
      }
      return [
        this.state[index],
        (next) => {
          this.state[index] = typeof next === "function" ? next(this.state[index]) : next;
        },
      ];
    },
    useEffect(effect) {
      this.effects.push(effect);
    },
  };
  return harness;
});

const api = vi.hoisted(() => ({
  exportPacketDocuments: vi.fn(),
  generatePacketDocuments: vi.fn(),
  getPacket: vi.fn(),
}));

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    useCallback: (fn) => fn,
    useEffect: (effect) => hooks.useEffect(effect),
    useState: (initial) => hooks.useState(initial),
  };
});

vi.mock("../lib/api.js", () => api);

import { PacketDocumentsCard } from "./PacketDocumentsCard.jsx";

function renderCard({ gate = "keep" } = {}) {
  hooks.begin();
  return PacketDocumentsCard({ applicationId: "app-1", gate, onView: vi.fn() });
}

function materialize(node) {
  if (node == null || typeof node === "boolean") return null;
  if (typeof node === "string" || typeof node === "number") return node;
  if (Array.isArray(node)) return node.map(materialize);
  if (typeof node.type === "function") return materialize(node.type(node.props));
  return {
    type: node.type,
    props: node.props,
    children: materialize(node.props?.children),
  };
}

function textOf(node) {
  if (node == null) return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textOf).join("");
  return textOf(node.children);
}

function buttons(node, found = []) {
  if (!node) return found;
  if (Array.isArray(node)) {
    for (const child of node) buttons(child, found);
    return found;
  }
  if (node.type === "button") found.push(node);
  buttons(node.children, found);
  return found;
}

async function runInitialEffect() {
  for (const effect of hooks.effects) effect();
  await Promise.resolve();
  await Promise.resolve();
}

beforeEach(() => {
  hooks.reset();
  vi.clearAllMocks();
  api.getPacket.mockResolvedValue({ artifacts: {} });
});

describe("PacketDocumentsCard", () => {
  it("blocks document generation until evaluation returns KEEP", async () => {
    renderCard({ gate: "review" });
    await runInitialEffect();
    const tree = materialize(renderCard({ gate: "review" }));
    const generate = buttons(tree).find((button) => textOf(button) === "Generate documents");

    expect(generate.props.disabled).toBe(true);
    await generate.props.onClick();
    expect(api.generatePacketDocuments).not.toHaveBeenCalled();
    expect(textOf(tree)).toContain("A KEEP evaluation is required before tailoring documents.");
  });

  it("generates PDFs, refetches the packet, and renders artifact availability", async () => {
    api.getPacket.mockResolvedValueOnce({ artifacts: {} }).mockResolvedValueOnce({
      artifacts: {
        resume: { html: "<p>Resume</p>" },
        coverLetter: { html: "<p>Cover letter</p>" },
      },
    });
    api.generatePacketDocuments.mockResolvedValueOnce({
      data: { status: "reviewable", gaps: [{ kind: "answers", message: "answers skipped" }] },
    });
    let tree = renderCard();
    await runInitialEffect();
    tree = materialize(renderCard());

    const generate = buttons(tree).find((button) => textOf(button) === "Generate documents");
    await generate.props.onClick();

    expect(api.generatePacketDocuments).toHaveBeenCalledWith({
      applicationId: "app-1",
      formats: ["pdf"],
    });
    expect(api.getPacket).toHaveBeenCalledTimes(2);
    tree = materialize(renderCard());
    expect(textOf(tree)).toContain("Resume: View");
    expect(textOf(tree)).toContain("Cover letter: View");
    expect(textOf(tree)).toContain("Answers: Not generated yet");
    expect(textOf(tree)).toContain("Packet reviewable: 1 gap.");
  });

  it("shows a disabled busy label while generation is pending", async () => {
    let resolveGenerate;
    api.generatePacketDocuments.mockImplementationOnce(
      () => new Promise((resolve) => (resolveGenerate = resolve))
    );
    renderCard();
    await runInitialEffect();
    let tree = materialize(renderCard());
    const pending = buttons(tree)
      .find((button) => textOf(button) === "Generate documents")
      .props.onClick();

    tree = materialize(renderCard());
    const busy = buttons(tree).find((button) => textOf(button) === "Generating…");
    expect(busy.props.disabled).toBe(true);

    resolveGenerate({ data: { status: "reviewable", gaps: [] } });
    await pending;
  });

  it("exports PDFs and refetches the packet", async () => {
    api.exportPacketDocuments.mockResolvedValueOnce({
      data: { userFacing: { resume: [{ format: "pdf", path: "workspace/tailored/resume.pdf" }] } },
    });
    renderCard();
    await runInitialEffect();
    const tree = materialize(renderCard());
    await buttons(tree)
      .find((button) => textOf(button) === "Export")
      .props.onClick();

    expect(api.exportPacketDocuments).toHaveBeenCalledWith({
      applicationId: "app-1",
      formats: ["pdf"],
    });
    expect(api.getPacket).toHaveBeenCalledTimes(2);
    expect(textOf(materialize(renderCard()))).toContain("workspace/tailored/resume.pdf");
  });

  it("renders the server error body through InlineAlert", async () => {
    api.generatePacketDocuments.mockRejectedValueOnce({
      body: { error: { message: "Question capture is malformed" } },
    });
    renderCard();
    await runInitialEffect();
    const tree = materialize(renderCard());
    await buttons(tree)
      .find((button) => textOf(button) === "Generate documents")
      .props.onClick();

    const failed = materialize(renderCard());
    expect(textOf(failed)).toContain("Question capture is malformed");
    expect(JSON.stringify(failed)).toContain("inline-alert");
  });
});
