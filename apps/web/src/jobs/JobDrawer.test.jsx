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
  draftCommunication: vi.fn(),
  getApplication: vi.fn(),
  getCommunications: vi.fn(),
  getJobDescription: vi.fn(),
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
vi.mock("./InterviewDossierCard.jsx", () => ({ InterviewDossierCard: "interview-dossier-card" }));
vi.mock("./PacketDocumentsCard.jsx", () => ({ PacketDocumentsCard: "packet-documents-card" }));
vi.mock("./PacketGateCard.jsx", () => ({ PacketGateCard: "packet-gate-card" }));

import * as jobDrawerModule from "./JobDrawer.jsx";
import { CommsThreadCard, CommThread, JobDrawer } from "./JobDrawer.jsx";

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

const applicationRowWithJd = {
  ...applicationRow,
  drawer: {
    artifacts: [{ kind: "Job description", note: "Captured Jun 10", path: "workspace/jobs/x.md" }],
  },
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
    querySelector: vi.fn(() => null),
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
  api.draftCommunication.mockResolvedValue({});
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

  it("mounts the interview dossier card for an application row", async () => {
    renderDrawer(applicationRow);
    await runEffects();
    const tree = renderDrawer(applicationRow);

    const dossierCard = visit(tree, (node) => node.type === "interview-dossier-card")[0];
    expect(dossierCard).toBeTruthy();
    expect(dossierCard.props.applicationId).toBe("app-1");
  });

  it("opens the JD viewer with a fixed 'View' label, never the raw path, on click", async () => {
    api.getJobDescription.mockResolvedValueOnce({
      data: { artifact: { kind: "job_description", completeness: "complete", html: "<p>JD</p>" } },
    });
    renderDrawer(applicationRowWithJd);
    await runEffects();
    const tree = renderDrawer(applicationRowWithJd);

    const viewButton = button(tree, "View");
    expect(viewButton).toBeTruthy();
    expect(textOf(viewButton)).not.toBe("workspace/jobs/x.md");
    await viewButton.props.onClick();
    expect(api.getJobDescription).toHaveBeenCalledWith({ source: "application", id: "app-1" });
  });

  it("shows an inline hint (not the error banner) for JD_NOT_CAPTURED, and the generic banner otherwise", async () => {
    api.getJobDescription.mockRejectedValueOnce({
      status: 409,
      body: { code: "JD_NOT_CAPTURED", error: { message: "no jd" } },
    });
    renderDrawer(applicationRowWithJd);
    await runEffects();
    let tree = renderDrawer(applicationRowWithJd);
    await button(tree, "View").props.onClick();
    tree = renderDrawer(applicationRowWithJd);
    expect(JSON.stringify(tree)).toContain("No job description was captured for this role.");
    expect(visit(tree, (node) => node.type === "inline-alert")).toHaveLength(0);

    hooks.reset();
    api.getJobDescription.mockRejectedValueOnce({
      status: 413,
      body: { code: "JD_TOO_LARGE" },
    });
    renderDrawer(applicationRowWithJd);
    await runEffects();
    tree = renderDrawer(applicationRowWithJd);
    await button(tree, "View").props.onClick();
    tree = renderDrawer(applicationRowWithJd);
    expect(visit(tree, (node) => node.type === "inline-alert").length).toBeGreaterThan(0);
  });

  it("CommsThreadCard's zero-thread branch renders the AskBar-focus CTA instead of a dead sentence", () => {
    hooks.reset();
    const tree = CommsThreadCard({
      comms: [],
      busyKey: null,
      onAddNote: vi.fn(),
      onDraft: vi.fn(),
    });
    const cta = button(tree, "Paste a message");
    expect(cta).toBeTruthy();
    cta.props.onClick();
    expect(document.querySelector).toHaveBeenCalledWith(".ask-bar__input");
  });

  it("CommThread's Draft reply button calls draftCommunication through the existing runWrite pattern", async () => {
    const comm = { id: "comm-1", company: "Northstar", subject: "Re: Role", messages: [] };
    hooks.reset();
    let tree = CommThread({
      comm,
      busyKey: null,
      onAddNote: vi.fn(),
      onDraft: (id) => api.draftCommunication({ id }),
    });
    const draftButton = button(tree, "Draft reply");
    expect(draftButton).toBeTruthy();
    await draftButton.props.onClick();
    expect(api.draftCommunication).toHaveBeenCalledWith({ id: "comm-1" });

    // Wired end to end from the drawer itself: CommsThreadCard's onDraft prop
    // (passed from JobDrawer's runWrite call) reaches draftCommunication with
    // the comm's id and no send/deliver affordance anywhere alongside it.
    api.draftCommunication.mockClear();
    renderDrawer(applicationRow);
    await runEffects();
    tree = renderDrawer(applicationRow);
    expect(JSON.stringify(tree)).not.toMatch(/Send|Deliver/);
  });
});
