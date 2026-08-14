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
  // resolveErrorCopy() (lib/errorCopy.js) checks `err instanceof ApiError` —
  // real callers throw the real class, so this mock has to supply one too,
  // same as AskBar.test.jsx's own local ApiError fixture.
  ApiError: class ApiError extends Error {
    constructor(status, body) {
      super(`request failed with status ${status}`);
      this.name = "ApiError";
      this.status = status;
      this.body = body;
    }
  },
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
// Mocked as a plain host tag (JobDrawer.test.jsx's own convention) so a test
// can read the resolved {message, action, detail} straight off a node's
// props instead of parsing rendered text.
vi.mock("../components/Toast.jsx", () => ({ InlineAlert: "inline-alert" }));

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

function findByType(node, type, found = []) {
  if (!node) return found;
  if (Array.isArray(node)) {
    for (const child of node) findByType(child, type, found);
    return found;
  }
  if (node.type === type) found.push(node);
  findByType(node.children, type, found);
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
      packet: {
        uploadReady: false,
        status: "reviewable",
        gapCount: 1,
        gaps: [
          {
            kind: "answers",
            message: "answers artifact skipped — no application questions captured yet",
          },
        ],
      },
    });
    api.generatePacketDocuments.mockResolvedValueOnce({
      data: {
        status: "reviewable",
        gaps: [
          {
            kind: "answers",
            message: "answers artifact skipped — no application questions captured yet",
          },
        ],
      },
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
    expect(textOf(tree)).toContain("Answers: Waiting for application questions");
    expect(textOf(tree)).toContain(
      "Résumé and cover letter are ready. Answers will be added when the application form exposes its questions."
    );
    expect(textOf(tree)).not.toContain("Packet reviewable: 1 gap.");
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

  it("routes a generate failure through resolveErrorCopy — the fallback message renders, the raw server string only ever lives in `detail` — and wires a working retry", async () => {
    // 422 deliberately isn't one of resolveErrorCopy's mapped statuses (401/
    // 403/404/5xx all have their own rule-provided message) — this exercises
    // the true generic bucket, where the bespoke "Packet action failed"
    // fallback (not resolveErrorCopy's own GENERIC_ERROR_MESSAGE) applies.
    api.generatePacketDocuments.mockRejectedValueOnce(
      new api.ApiError(422, { error: { message: "Question capture is malformed" } })
    );
    renderCard();
    await runInitialEffect();
    const tree = materialize(renderCard());
    await buttons(tree)
      .find((button) => textOf(button) === "Generate documents")
      .props.onClick();

    let failed = materialize(renderCard());
    const alert = findByType(failed, "inline-alert")[0];
    expect(alert).toBeTruthy();
    expect(alert.props.message).toBe("Packet action failed");
    expect(alert.props.detail).toBe("Question capture is malformed");
    // The raw server string is never the primary on-screen text.
    expect(textOf(failed)).not.toContain("Question capture is malformed");

    api.generatePacketDocuments.mockResolvedValueOnce({ data: { status: "reviewable", gaps: [] } });
    await alert.props.action.onRetry();
    failed = materialize(renderCard());
    expect(findByType(failed, "inline-alert")).toHaveLength(0);
    expect(textOf(failed)).toContain("Packet reviewable: 0 gaps.");
  });

  it("routes an export failure through resolveErrorCopy the same way, with retry wired to Export specifically", async () => {
    api.exportPacketDocuments.mockRejectedValueOnce(new api.ApiError(422, { error: "boom" }));
    renderCard();
    await runInitialEffect();
    let tree = materialize(renderCard());
    await buttons(tree)
      .find((button) => textOf(button) === "Export")
      .props.onClick();

    tree = materialize(renderCard());
    const alert = findByType(tree, "inline-alert")[0];
    expect(alert.props.message).toBe("Packet action failed");
    expect(alert.props.detail).toBe("boom");
    expect(textOf(tree)).not.toContain("boom");

    api.exportPacketDocuments.mockResolvedValueOnce({
      data: { userFacing: { resume: [{ format: "pdf", path: "workspace/tailored/resume.pdf" }] } },
    });
    await alert.props.action.onRetry();
    expect(api.exportPacketDocuments).toHaveBeenCalledTimes(2);
  });
});
