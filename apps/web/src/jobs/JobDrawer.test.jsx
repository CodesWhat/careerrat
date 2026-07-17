import { beforeEach, describe, expect, it, vi } from "vitest";

const hooks = vi.hoisted(() => ({
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
    if (!(index in this.state))
      this.state[index] = typeof initial === "function" ? initial() : initial;
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
}));

const dashboard = vi.hoisted(() => ({ refetch: vi.fn() }));
const api = vi.hoisted(() => ({
  appendCommMessage: vi.fn(),
  getApplication: vi.fn(),
  getCommunications: vi.fn(),
  getPacket: vi.fn(),
  markCommSent: vi.fn(),
  mergeNestedField: vi.fn((base, field, patch) => ({ ...(base?.[field] || {}), ...patch })),
  promoteSourced: vi.fn(),
  runPacketGate: vi.fn(),
  scheduleInterview: vi.fn(),
  setAppFields: vi.fn(),
  setAppStatus: vi.fn(),
  setSourcedStatus: vi.fn(),
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
vi.mock("../app-shell/DashboardContext.jsx", () => ({
  useDashboardSnapshot: () => ({ refetch: dashboard.refetch }),
}));
vi.mock("../lib/api.js", () => api);
vi.mock("../lib/dashboard-events.js", () => ({ emitDashboardChanged: vi.fn() }));
vi.mock("../components/Button.jsx", () => ({ Button: "button", IconButton: "button" }));
vi.mock("../components/Card.jsx", () => ({ Card: "section" }));
vi.mock("../components/CompanyAvatar.jsx", () => ({ CompanyAvatar: "company-avatar" }));
vi.mock("../components/form.jsx", () => ({
  Field: "field",
  Select: "select",
  TextArea: "textarea",
  TextField: "input",
}));
vi.mock("../components/icons.jsx", () => ({ KeyIcon: "key-icon" }));
vi.mock("../components/Toast.jsx", () => ({ InlineAlert: "inline-alert" }));
vi.mock("./ArtifactViewerModal.jsx", () => ({ ArtifactViewerModal: "artifact-viewer" }));
vi.mock("./PacketDocumentsCard.jsx", () => ({ PacketDocumentsCard: "packet-documents-card" }));
vi.mock("./PacketGateCard.jsx", () => ({ PacketGateCard: "packet-gate-card" }));

import { JobDrawer } from "./JobDrawer.jsx";

const applicationRow = {
  id: "app-1",
  source: "application",
  company: "Northstar",
  role: "Solutions Engineer",
  status: "reviewed-hold",
  terminal: false,
  stageLabel: "Review",
  drawer: { artifacts: [] },
};

const sourcedRow = {
  id: "source-1",
  source: "sourced",
  company: "Northstar",
  role: "Solutions Engineer",
  status: "sourced",
  terminal: false,
  stageLabel: "Review",
  drawer: {},
};

function renderDrawer(row) {
  hooks.begin();
  return JobDrawer({ row, onClose: vi.fn() });
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

async function runEffects() {
  for (const effect of hooks.effects) effect();
  await Promise.resolve();
  await Promise.resolve();
}

function button(tree, label) {
  return visit(tree, (node) => node.type === "button" && textOf(node) === label)[0];
}

beforeEach(() => {
  hooks.reset();
  vi.clearAllMocks();
  globalThis.document = {
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    getElementById: vi.fn(() => null),
  };
  dashboard.refetch.mockResolvedValue({});
  api.getCommunications.mockResolvedValue({ data: [] });
  api.getApplication.mockResolvedValue({
    data: { id: "app-1", status: "reviewed-hold", artifacts: {} },
  });
  api.promoteSourced.mockResolvedValue({});
  api.setSourcedStatus.mockResolvedValue({});
  api.setAppStatus.mockResolvedValue({});
  api.setAppFields.mockResolvedValue({});
});

describe("JobDrawer", () => {
  it("shows Promote to pipeline and Skip for sourced rows", async () => {
    let tree = renderDrawer(sourcedRow);
    await runEffects();
    tree = renderDrawer(sourcedRow);

    expect(button(tree, "Promote to pipeline")).toBeTruthy();
    expect(button(tree, "Skip")).toBeTruthy();
    await button(tree, "Promote to pipeline").props.onClick();
    expect(api.promoteSourced).toHaveBeenCalledWith({ id: "source-1" });
    await button(renderDrawer(sourcedRow), "Skip").props.onClick();
    expect(api.setSourcedStatus).toHaveBeenCalledWith({ id: "source-1", to: "cut" });
  });

  it("offers one-click Mark applied only for pre-applied applications", async () => {
    renderDrawer(applicationRow);
    await runEffects();
    let tree = renderDrawer(applicationRow);
    const markApplied = button(tree, "Mark applied");
    expect(markApplied).toBeTruthy();
    await markApplied.props.onClick();
    expect(api.setAppStatus).toHaveBeenCalledWith({ id: "app-1", to: "applied" });

    hooks.reset();
    api.getApplication.mockResolvedValue({ data: { id: "app-1", status: "applied" } });
    renderDrawer({ ...applicationRow, status: "applied" });
    await runEffects();
    tree = renderDrawer({ ...applicationRow, status: "applied" });
    expect(button(tree, "Mark applied")).toBeFalsy();
  });

  it("persists packetGate and evaluated fit basis after evaluation", async () => {
    api.runPacketGate.mockResolvedValueOnce({
      data: { gate: "keep", fit: "strong match", comp: "clear", reasons: ["Relevant scope"] },
    });
    renderDrawer(applicationRow);
    await runEffects();
    const tree = renderDrawer(applicationRow);
    const gateCard = visit(tree, (node) => node.type === "packet-gate-card")[0];
    await gateCard.props.onEvaluate();

    expect(api.runPacketGate).toHaveBeenCalledWith({ applicationId: "app-1" });
    expect(api.setAppFields).toHaveBeenCalledWith({
      id: "app-1",
      patch: {
        packetGate: {
          gate: "keep",
          fit: "strong match",
          comp: "clear",
          reasons: ["Relevant scope"],
          evaluatedAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
        },
        fitBasis: "evaluated",
      },
    });
  });

  it("renders the derived next-step CTA in the header", async () => {
    renderDrawer(applicationRow);
    await runEffects();
    expect(button(renderDrawer(applicationRow), "Evaluate")).toBeTruthy();
  });
});
