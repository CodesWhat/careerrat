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
  applyOnSite: vi.fn(),
  appendCommMessage: vi.fn(),
  getApplication: vi.fn(),
  getCommunications: vi.fn(),
  getPacket: vi.fn(),
  markCommSent: vi.fn(),
  mergeNestedField: vi.fn((base, field, patch) => ({ ...(base?.[field] || {}), ...patch })),
  promoteSourced: vi.fn(),
  recordExternalApplication: vi.fn(),
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
    useRef: (initial) => ({ current: initial }),
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

import * as jobDrawerModule from "./JobDrawer.jsx";
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
  api.applyOnSite.mockResolvedValue({});
  api.recordExternalApplication.mockResolvedValue({});
  api.setSourcedStatus.mockResolvedValue({});
  api.setAppStatus.mockResolvedValue({});
  api.setAppFields.mockResolvedValue({});
});

describe("JobDrawer", () => {
  it("wraps Tab focus inside the drawer", () => {
    expect(typeof jobDrawerModule.trapDrawerTab).toBe("function");
    const first = { focus: vi.fn() };
    const last = { focus: vi.fn() };
    const dialog = { querySelectorAll: () => [first, last] };
    const forward = { key: "Tab", shiftKey: false, preventDefault: vi.fn() };
    const backward = { key: "Tab", shiftKey: true, preventDefault: vi.fn() };

    jobDrawerModule.trapDrawerTab({ dialog, event: forward, activeElement: last });
    expect(forward.preventDefault).toHaveBeenCalledOnce();
    expect(first.focus).toHaveBeenCalledOnce();

    jobDrawerModule.trapDrawerTab({ dialog, event: backward, activeElement: first });
    expect(backward.preventDefault).toHaveBeenCalledOnce();
    expect(last.focus).toHaveBeenCalledOnce();
  });

  it("marks the drawer modal and makes it programmatically focusable", async () => {
    renderDrawer(applicationRow);
    await runEffects();
    const tree = renderDrawer(applicationRow);
    const dialog = visit(tree, (node) => node.props?.role === "dialog")[0];

    expect(dialog.props["aria-modal"]).toBe("true");
    expect(dialog.props.tabIndex).toBe(-1);
  });

  it("shows Promote to pipeline and Skip for sourced rows", async () => {
    let tree = renderDrawer(sourcedRow);
    await runEffects();
    tree = renderDrawer(sourcedRow);

    expect(button(tree, "Promote to pipeline")).toBeTruthy();
    expect(button(tree, "Skip")).toBeTruthy();
    await button(tree, "Promote to pipeline").props.onClick();
    expect(api.promoteSourced).toHaveBeenCalledWith({ id: "source-1" });

    hooks.reset();
    tree = renderDrawer(sourcedRow);
    await runEffects();
    tree = renderDrawer(sourcedRow);
    await button(tree, "Skip").props.onClick();
    expect(api.setSourcedStatus).toHaveBeenCalledWith({ id: "source-1", to: "cut" });
  });

  it("derives sourced actions from status so a skipped row cannot resurrect stale CTAs", async () => {
    const skipped = { ...sourcedRow, status: "cut", terminal: true };
    let tree = renderDrawer(skipped);
    await runEffects();
    tree = renderDrawer(skipped);

    expect(button(tree, "Promote to pipeline")).toBeFalsy();
    expect(button(tree, "Skip")).toBeFalsy();
    expect(JSON.stringify(tree)).toContain("already skipped");
  });

  it("splits user-reported applications from verified Apply on site work", async () => {
    renderDrawer(applicationRow);
    await runEffects();
    let tree = renderDrawer(applicationRow);
    const reported = button(tree, "I applied elsewhere");
    const apply = button(tree, "Apply on site");
    expect(reported).toBeTruthy();
    expect(apply).toBeTruthy();
    await reported.props.onClick();
    expect(api.recordExternalApplication).toHaveBeenCalledWith({ id: "app-1" });
    expect(api.setAppStatus).not.toHaveBeenCalledWith({ id: "app-1", to: "applied" });
    await apply.props.onClick();
    expect(api.applyOnSite).toHaveBeenCalledWith({ id: "app-1" });

    hooks.reset();
    api.getApplication.mockResolvedValue({ data: { id: "app-1", status: "applied" } });
    renderDrawer({ ...applicationRow, status: "applied" });
    await runEffects();
    tree = renderDrawer({ ...applicationRow, status: "applied" });
    expect(button(tree, "I applied elsewhere")).toBeFalsy();
    expect(button(tree, "Apply on site")).toBeFalsy();
  });

  it("uses the server-persisted typed evaluation without a second client write", async () => {
    api.runPacketGate.mockResolvedValueOnce({
      data: {
        gate: "keep",
        fitScore: 91,
        fitBucket: "high",
        fitSummary: "Strong match",
        compensation: { status: "clears-floor", summary: "$212k–$286k clears floor" },
        fitReasons: ["Relevant scope"],
        fitRisks: [],
      },
    });
    renderDrawer(applicationRow);
    await runEffects();
    const tree = renderDrawer(applicationRow);
    const gateCard = visit(tree, (node) => node.type === "packet-gate-card")[0];
    await gateCard.props.onEvaluate();

    expect(api.runPacketGate).toHaveBeenCalledWith({ applicationId: "app-1" });
    expect(api.setAppFields).not.toHaveBeenCalled();
    expect(dashboard.refetch).toHaveBeenCalled();
  });

  it("renders the derived next-step CTA in the header", async () => {
    renderDrawer(applicationRow);
    await runEffects();
    expect(button(renderDrawer(applicationRow), "Evaluate")).toBeTruthy();
  });

  it("passes the persisted gate verdict into document generation", async () => {
    api.getApplication.mockResolvedValue({
      data: { id: "app-1", status: "reviewed-hold", artifacts: {}, evaluation: { gate: "review" } },
    });
    renderDrawer(applicationRow);
    await runEffects();
    const tree = renderDrawer(applicationRow);
    const documents = visit(tree, (node) => node.type === "packet-documents-card")[0];

    expect(documents.props.gate).toBe("review");
  });
});
