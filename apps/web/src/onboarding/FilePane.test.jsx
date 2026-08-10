// apps/web/src/onboarding/FilePane.test.jsx
// vitest coverage for "THE RAT'S FILE" pane (design 3b/3c, commit c1d601e3).
// Same hook harness convention as JobDrawer.test.jsx (no dependency-diffing —
// FilePane's own useState(editingKey) and each inline editor's useState calls
// have no cleanup to worry about, so the simpler harness suffices here too).
//
// Form primitives (ChipInput/TextArea/TextField) and CheckIcon are mocked to
// bare host-tag strings, same technique JobDrawer.test.jsx uses for its own
// Field/Select/TextArea mocks — the mocked "element" carries the exact props
// FilePane.jsx passed in (value/onChange/etc.), so tests can drive them by
// calling `.props.onChange(...)` directly without needing jsdom.

import { beforeEach, describe, expect, it, vi } from "vitest";

const hooks = vi.hoisted(() => ({
  cursor: 0,
  state: [],
  reset() {
    this.cursor = 0;
  },
  clear() {
    this.cursor = 0;
    this.state = [];
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

vi.mock("../components/icons.jsx", () => ({ CheckIcon: "check-icon" }));
vi.mock("../components/form.jsx", () => ({
  ChipInput: "mock-chip-input",
  TextArea: "mock-textarea",
  TextField: "mock-textfield",
}));
vi.mock("../components/Toast.jsx", () => ({ InlineAlert: "inline-alert" }));
vi.mock("./steps/RoleLaneEditor.jsx", () => ({
  normalizeRoleBuckets: (buckets) => buckets,
  RoleLaneFields: "mock-role-lane-fields",
}));

const api = vi.hoisted(() => ({
  parseResumeText: vi.fn(),
  removeEvidenceClaim: vi.fn(),
  saveCandidateFile: vi.fn(),
}));
vi.mock("../lib/api.js", () => api);

import { FilePane } from "./FilePane.jsx";

// ---------------------------------------------------------------------------
// Render + tree-walking helpers
// ---------------------------------------------------------------------------

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

function hasClass(node, cls) {
  const className = node.props?.className;
  return typeof className === "string" && className.split(" ").includes(cls);
}

function byClass(tree, cls) {
  return visit(tree, (n) => hasClass(n, cls));
}

function byTag(tree, tag) {
  return visit(tree, (n) => n.type === tag)[0];
}

function rowByLabel(tree, label) {
  return byClass(tree, "file-pane__row").find((row) => textOf(row).includes(label));
}

function render(props) {
  hooks.reset();
  return expand(FilePane(props));
}

async function flush() {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const EMPTY_STATE = {
  setupProgress: {
    items: [
      { key: "engine", done: false },
      { key: "resume", done: false },
      { key: "roles", done: false },
      { key: "companies", done: false },
      { key: "evidence", done: false },
      { key: "guardrails", done: false },
      { key: "quickFacts", done: false },
      { key: "authorization", done: false },
      { key: "consent", done: false },
    ],
  },
  sourceResumePresent: false,
  data: {},
};

function stateWith(doneKeys, dataOverrides = {}) {
  return {
    setupProgress: {
      items: EMPTY_STATE.setupProgress.items.map((item) => ({
        ...item,
        done: doneKeys.includes(item.key),
      })),
    },
    sourceResumePresent: doneKeys.includes("resume"),
    data: dataOverrides,
  };
}

beforeEach(() => {
  hooks.clear();
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// 7 rows, dashed<->done, UP NEXT chip
// ---------------------------------------------------------------------------

describe("FilePane — rows", () => {
  it("renders exactly 9 rows in the fixed order with the pane heading", () => {
    const tree = render({ state: EMPTY_STATE });
    expect(textOf(byClass(tree, "file-pane__title")[0])).toBe("THE RAT'S FILE");
    expect(textOf(byClass(tree, "file-pane__subtitle")[0])).toBe("LIVE · ~/CANDIDATE");
    const rows = byClass(tree, "file-pane__row");
    expect(rows).toHaveLength(9);
    expect(rows.map((r) => textOf(byClass(r, "file-pane__row-title")[0]))).toEqual([
      "Engine",
      "Resume",
      "Roles",
      "Companies",
      "Evidence",
      "Guardrails",
      "Quick facts",
      "Work authorization",
      "Automation consent",
    ]);
  });

  it("flips a row from pending (dashed) to done, with a check icon, as state changes", () => {
    let tree = render({ state: EMPTY_STATE });
    let companies = rowByLabel(tree, "Companies");
    expect(hasClass(companies, "file-pane__row--pending")).toBe(true);
    expect(hasClass(companies, "file-pane__row--done")).toBe(false);
    expect(visit(companies, (n) => n.type === "check-icon")).toHaveLength(0);

    tree = render({
      state: stateWith(["companies"], { targeting: { tracked_companies: ["Stripe"] } }),
    });
    companies = rowByLabel(tree, "Companies");
    expect(hasClass(companies, "file-pane__row--done")).toBe(true);
    expect(hasClass(companies, "file-pane__row--pending")).toBe(false);
    expect(visit(companies, (n) => n.type === "check-icon")).toHaveLength(1);
  });

  it("marks only the first not-done row UP NEXT", () => {
    const tree = render({ state: stateWith(["engine", "resume"]) });
    const roles = rowByLabel(tree, "Roles");
    const companies = rowByLabel(tree, "Companies");
    expect(byClass(roles, "file-pane__row-next")).toHaveLength(1);
    expect(byClass(companies, "file-pane__row-next")).toHaveLength(0);
  });

  it("shows an EDIT hint only on a done, editable row (never on Engine)", () => {
    const tree = render({
      state: stateWith(["engine", "companies"], { targeting: { tracked_companies: ["A"] } }),
    });
    const engine = rowByLabel(tree, "Engine");
    const companies = rowByLabel(tree, "Companies");
    expect(byClass(engine, "file-pane__row-edit-hint")).toHaveLength(0);
    expect(byClass(companies, "file-pane__row-edit-hint")).toHaveLength(1);
  });

  it("the Engine row is not clickable/editable (disabled, no onClick)", () => {
    const tree = render({ state: EMPTY_STATE });
    const engine = rowByLabel(tree, "Engine");
    expect(engine.props.disabled).toBe(true);
    expect(engine.props.onClick).toBeUndefined();
  });

  it("clicking an editable row opens its inline editor with the EDITING tag (full border, dual drive)", () => {
    let tree = render({ state: EMPTY_STATE });
    const companies = rowByLabel(tree, "Companies");
    expect(companies.props.disabled).toBe(false);
    companies.props.onClick();

    tree = render({ state: EMPTY_STATE });
    const editingRow = byClass(tree, "file-pane__row--editing")[0];
    expect(editingRow).toBeTruthy();
    expect(textOf(byClass(editingRow, "file-pane__editing-tag")[0])).toBe("EDITING");
    expect(textOf(byClass(editingRow, "file-pane__row-title")[0])).toBe("Companies");
  });
});

// ---------------------------------------------------------------------------
// Editors — save-on-blur (form submit) wiring
// ---------------------------------------------------------------------------

describe("FilePane — inline editors commit through onFieldSaved", () => {
  it("Companies editor: submit saves targeting.tracked_companies and reports the summary pill", async () => {
    api.saveCandidateFile.mockResolvedValue({ ok: true });
    const onReload = vi.fn().mockResolvedValue();
    const onFieldSaved = vi.fn();
    let tree = render({ state: EMPTY_STATE, onReload, onFieldSaved });
    rowByLabel(tree, "Companies").props.onClick();
    tree = render({ state: EMPTY_STATE, onReload, onFieldSaved });

    const chipInput = byTag(tree, "mock-chip-input");
    chipInput.props.onChange(["Stripe", "Anthropic"]);
    tree = render({ state: EMPTY_STATE, onReload, onFieldSaved });

    const form = byClass(tree, "file-pane__editor")[0];
    await form.props.onSubmit({ preventDefault: vi.fn() });
    await flush();

    expect(api.saveCandidateFile).toHaveBeenCalledWith("targeting", {
      tracked_companies: ["Stripe", "Anthropic"],
    });
    expect(onReload).toHaveBeenCalledTimes(1);
    expect(onFieldSaved).toHaveBeenCalledWith({ key: "companies", summary: "2 tracked companies" });

    // editingKey resets after commit.
    tree = render({ state: EMPTY_STATE, onReload, onFieldSaved });
    expect(byClass(tree, "file-pane__row--editing")).toHaveLength(0);
  });

  it("Guardrails editor: submit saves targeting.cut_signals with a singular/plural summary", async () => {
    api.saveCandidateFile.mockResolvedValue({ ok: true });
    const onFieldSaved = vi.fn();
    let tree = render({ state: EMPTY_STATE, onReload: vi.fn(), onFieldSaved });
    rowByLabel(tree, "Guardrails").props.onClick();
    tree = render({ state: EMPTY_STATE, onReload: vi.fn(), onFieldSaved });

    const chipInput = byTag(tree, "mock-chip-input");
    chipInput.props.onChange(["Below $200K"]);
    tree = render({ state: EMPTY_STATE, onReload: vi.fn(), onFieldSaved });
    await byClass(tree, "file-pane__editor")[0].props.onSubmit({ preventDefault: vi.fn() });
    await flush();

    expect(api.saveCandidateFile).toHaveBeenCalledWith("targeting", {
      cut_signals: ["Below $200K"],
    });
    expect(onFieldSaved).toHaveBeenCalledWith({ key: "guardrails", summary: "1 dealbreaker" });
  });

  it("Quick facts editor: submit saves profile.location merged with the toggled modes", async () => {
    api.saveCandidateFile.mockResolvedValue({ ok: true });
    const onFieldSaved = vi.fn();
    const state = stateWith([], { profile: { location: { home: "Austin, TX" } } });
    let tree = render({ state, onReload: vi.fn(), onFieldSaved });
    rowByLabel(tree, "Quick facts").props.onClick();
    tree = render({ state, onReload: vi.fn(), onFieldSaved });

    const textField = byTag(tree, "mock-textfield");
    expect(textField.props.value).toBe("Austin, TX");
    const remoteToggle = visit(tree, (n) => n.type === "input" && n.props.type === "checkbox")[0];
    remoteToggle.props.onChange({ target: { checked: true } });
    tree = render({ state, onReload: vi.fn(), onFieldSaved });

    await byClass(tree, "file-pane__editor")[0].props.onSubmit({ preventDefault: vi.fn() });
    await flush();

    expect(api.saveCandidateFile).toHaveBeenCalledWith("profile", {
      location: { home: "Austin, TX", remote: true, hybrid: false, onsite: false },
    });
    expect(onFieldSaved).toHaveBeenCalledWith({ key: "quickFacts", summary: "quick facts" });
  });

  it("Resume editor: pasting text calls parseResumeText and still commits through onFieldSaved", async () => {
    api.parseResumeText.mockResolvedValue({ ok: true });
    api.saveCandidateFile.mockResolvedValue({ ok: true });
    const onFieldSaved = vi.fn();
    let tree = render({ state: EMPTY_STATE, onReload: vi.fn(), onFieldSaved });
    rowByLabel(tree, "Resume").props.onClick();
    tree = render({ state: EMPTY_STATE, onReload: vi.fn(), onFieldSaved });

    const textarea = byTag(tree, "mock-textarea");
    textarea.props.onChange("Pasted résumé body text.");
    tree = render({ state: EMPTY_STATE, onReload: vi.fn(), onFieldSaved });
    await byClass(tree, "file-pane__editor")[0].props.onSubmit({ preventDefault: vi.fn() });
    await flush();

    expect(api.parseResumeText).toHaveBeenCalledWith("Pasted résumé body text.", { save: true });
    expect(onFieldSaved).toHaveBeenCalledWith({ key: "resume", summary: "pasted résumé text" });
  });

  it("Evidence editor: removing a claim calls removeEvidenceClaim and commits through onFieldSaved", async () => {
    api.removeEvidenceClaim.mockResolvedValue({ ok: true });
    api.saveCandidateFile.mockResolvedValue({ ok: true });
    const onFieldSaved = vi.fn();
    const state = stateWith(["evidence"], {
      evidence: { claims: [{ id: "seed-001", claim: "Shipped a thing" }] },
    });
    let tree = render({ state, onReload: vi.fn(), onFieldSaved });
    rowByLabel(tree, "Evidence").props.onClick();
    tree = render({ state, onReload: vi.fn(), onFieldSaved });

    const removeBtn = visit(
      tree,
      (n) => n.type === "button" && n.props["aria-label"] === "Remove claim"
    )[0];
    await removeBtn.props.onClick();
    await flush();

    expect(api.removeEvidenceClaim).toHaveBeenCalledWith("seed-001");
    expect(onFieldSaved).toHaveBeenCalledWith({ key: "evidence", summary: "removed a claim" });
  });
});

// ---------------------------------------------------------------------------
// Roles editor — empty-title lane guard (ISSUE-006). The server
// (normalizeSearchTracks in src/core/db/verbs/candidate.mjs) silently drops
// any lane with no titles, so the client must reject it before it ever
// reaches saveCandidateFile — never a silent no-op.
// ---------------------------------------------------------------------------

describe("FilePane — Roles editor blocks empty-title lanes (ISSUE-006)", () => {
  it("blocks submit and shows the inline error when a lane has no titles", async () => {
    api.saveCandidateFile.mockResolvedValue({ ok: true });
    const onFieldSaved = vi.fn();
    let tree = render({ state: EMPTY_STATE, onReload: vi.fn(), onFieldSaved });
    rowByLabel(tree, "Roles").props.onClick();
    tree = render({ state: EMPTY_STATE, onReload: vi.fn(), onFieldSaved });

    // Default synthesized lane has no titles yet — the error shows up front,
    // not only after a failed submit attempt.
    expect(byTag(tree, "inline-alert").props.message).toBe(
      "Add at least one complete role lane with a job title."
    );

    const form = byClass(tree, "file-pane__editor")[0];
    await form.props.onSubmit({ preventDefault: vi.fn() });
    await flush();

    expect(api.saveCandidateFile).not.toHaveBeenCalled();
    expect(onFieldSaved).not.toHaveBeenCalled();
  });

  it("fixing the title clears the error and lets the save through", async () => {
    api.saveCandidateFile.mockResolvedValue({ ok: true });
    const onReload = vi.fn().mockResolvedValue();
    const onFieldSaved = vi.fn();
    let tree = render({ state: EMPTY_STATE, onReload, onFieldSaved });
    rowByLabel(tree, "Roles").props.onClick();
    tree = render({ state: EMPTY_STATE, onReload, onFieldSaved });
    expect(byTag(tree, "inline-alert")).toBeTruthy();

    const roleLaneFields = byTag(tree, "mock-role-lane-fields");
    roleLaneFields.props.onChange({ titles: ["Staff Platform Engineer"] });
    tree = render({ state: EMPTY_STATE, onReload, onFieldSaved });

    expect(byTag(tree, "inline-alert")).toBeUndefined();

    const form = byClass(tree, "file-pane__editor")[0];
    await form.props.onSubmit({ preventDefault: vi.fn() });
    await flush();

    expect(api.saveCandidateFile).toHaveBeenCalledWith("targeting", {
      role_buckets: [
        {
          name: "Primary",
          priority: "primary",
          titles: ["Staff Platform Engineer"],
          notes: "",
          fit_signals: [],
          down_signals: [],
        },
      ],
    });
    expect(onReload).toHaveBeenCalledTimes(1);
    expect(onFieldSaved).toHaveBeenCalledWith({ key: "roles", summary: "1 role lane" });

    // editingKey resets after commit.
    tree = render({ state: EMPTY_STATE, onReload, onFieldSaved });
    expect(byClass(tree, "file-pane__row--editing")).toHaveLength(0);
  });

  it("a valid multi-lane save round-trips through saveCandidateFile unchanged", async () => {
    api.saveCandidateFile.mockResolvedValue({ ok: true });
    const onFieldSaved = vi.fn();
    const bucketA = {
      name: "Primary",
      priority: "primary",
      titles: ["Staff Platform Engineer"],
      notes: "",
      fit_signals: [],
      down_signals: [],
    };
    const bucketB = {
      name: "Secondary",
      priority: "secondary",
      titles: ["Engineering Manager"],
      notes: "",
      fit_signals: [],
      down_signals: [],
    };
    const state = stateWith(["roles"], { targeting: { role_buckets: [bucketA, bucketB] } });
    let tree = render({ state, onReload: vi.fn(), onFieldSaved });
    rowByLabel(tree, "Roles").props.onClick();
    tree = render({ state, onReload: vi.fn(), onFieldSaved });

    expect(byTag(tree, "inline-alert")).toBeUndefined();

    const form = byClass(tree, "file-pane__editor")[0];
    await form.props.onSubmit({ preventDefault: vi.fn() });
    await flush();

    expect(api.saveCandidateFile).toHaveBeenCalledWith("targeting", {
      role_buckets: [bucketA, bucketB],
    });
    expect(onFieldSaved).toHaveBeenCalledWith({ key: "roles", summary: "2 role lanes" });
  });
});

// ---------------------------------------------------------------------------
// Lane A / R3, R6 — authorization row (declared-vs-answered split, decline)
// ---------------------------------------------------------------------------

describe("FilePane — Authorization editor (R3, R6)", () => {
  it("saving true/false writes only profile.authorization (no decline write)", async () => {
    api.saveCandidateFile.mockResolvedValue({ ok: true });
    const onFieldSaved = vi.fn();
    let tree = render({ state: EMPTY_STATE, onReload: vi.fn(), onFieldSaved });
    rowByLabel(tree, "Work authorization").props.onClick();
    tree = render({ state: EMPTY_STATE, onReload: vi.fn(), onFieldSaved });

    const authorizedToggle = visit(
      tree,
      (n) => n.type === "input" && n.props.type === "checkbox"
    )[0];
    authorizedToggle.props.onChange({ target: { checked: true } });
    tree = render({ state: EMPTY_STATE, onReload: vi.fn(), onFieldSaved });

    const form = byClass(tree, "file-pane__editor")[0];
    await form.props.onSubmit({ preventDefault: vi.fn() });
    await flush();

    expect(api.saveCandidateFile).toHaveBeenCalledTimes(1);
    expect(api.saveCandidateFile).toHaveBeenCalledWith("profile", {
      authorization: { work_authorized: true, requires_sponsorship: false },
    });
    expect(onFieldSaved).toHaveBeenCalledWith({ key: "authorization", summary: "authorized" });
  });

  it("saving false/false also records declined_fields.authorization (R3's procedural fix)", async () => {
    api.saveCandidateFile.mockResolvedValue({ ok: true });
    const onFieldSaved = vi.fn();
    let tree = render({ state: EMPTY_STATE, onReload: vi.fn(), onFieldSaved });
    rowByLabel(tree, "Work authorization").props.onClick();
    tree = render({ state: EMPTY_STATE, onReload: vi.fn(), onFieldSaved });

    const form = byClass(tree, "file-pane__editor")[0];
    await form.props.onSubmit({ preventDefault: vi.fn() });
    await flush();

    expect(api.saveCandidateFile).toHaveBeenCalledTimes(2);
    expect(api.saveCandidateFile).toHaveBeenNthCalledWith(1, "profile", {
      authorization: { work_authorized: false, requires_sponsorship: false },
    });
    expect(api.saveCandidateFile.mock.calls[1][0]).toBe("form-defaults");
    expect(
      api.saveCandidateFile.mock.calls[1][1].declined_fields.authorization.declined_at
    ).toEqual(expect.any(String));
    expect(onFieldSaved).toHaveBeenCalledWith({ key: "authorization", summary: "not authorized" });
  });

  it("Decline to answer records the decline with no profile write", async () => {
    api.saveCandidateFile.mockResolvedValue({ ok: true });
    const onFieldSaved = vi.fn();
    let tree = render({ state: EMPTY_STATE, onReload: vi.fn(), onFieldSaved });
    rowByLabel(tree, "Work authorization").props.onClick();
    tree = render({ state: EMPTY_STATE, onReload: vi.fn(), onFieldSaved });

    const declineButton = visit(
      tree,
      (n) => n.type === "button" && textOf(n) === "Decline to answer"
    )[0];
    await declineButton.props.onClick();
    await flush();

    expect(api.saveCandidateFile).toHaveBeenCalledTimes(1);
    expect(api.saveCandidateFile).toHaveBeenCalledWith("form-defaults", {
      declined_fields: { authorization: { declined_at: expect.any(String) } },
    });
    expect(onFieldSaved).toHaveBeenCalledWith({ key: "authorization", summary: "declined" });
  });

  it("a declined field renders the 'Declined — won't ask again' row instead of the normal button", () => {
    const state = stateWith([], {
      "form-defaults": { declined_fields: { authorization: { declined_at: "2026-01-01" } } },
    });
    const tree = render({ state });
    const declinedRow = byClass(tree, "file-pane__row--declined")[0];
    expect(declinedRow).toBeTruthy();
    expect(textOf(declinedRow)).toContain("Declined — won't ask again");
    expect(byClass(declinedRow, "file-pane__row-next")).toHaveLength(0);
  });

  it("'Answer now' clears the decline and opens the editor", async () => {
    api.saveCandidateFile.mockResolvedValue({ ok: true });
    const onReload = vi.fn().mockResolvedValue();
    const state = stateWith([], {
      "form-defaults": { declined_fields: { authorization: { declined_at: "2026-01-01" } } },
    });
    let tree = render({ state, onReload });
    const answerNow = visit(tree, (n) => n.type === "button" && textOf(n) === "Answer now")[0];
    await answerNow.props.onClick();
    await flush();

    expect(api.saveCandidateFile).toHaveBeenCalledWith("form-defaults", {
      declined_fields: { authorization: null },
    });
    expect(onReload).toHaveBeenCalledTimes(1);

    tree = render({ state, onReload });
    const editingRow = byClass(tree, "file-pane__row--editing")[0];
    expect(textOf(byClass(editingRow, "file-pane__row-title")[0])).toBe("Work authorization");
  });
});

// ---------------------------------------------------------------------------
// Lane A / R5, R6 — consent row
// ---------------------------------------------------------------------------

describe("FilePane — Consent editor (R5, R6)", () => {
  it("saving a mode writes automation.setup_mode through the normal commit path", async () => {
    api.saveCandidateFile.mockResolvedValue({ ok: true });
    const onFieldSaved = vi.fn();
    let tree = render({ state: EMPTY_STATE, onReload: vi.fn(), onFieldSaved });
    rowByLabel(tree, "Automation consent").props.onClick();
    tree = render({ state: EMPTY_STATE, onReload: vi.fn(), onFieldSaved });

    const advancedRadio = visit(
      tree,
      (n) => n.type === "input" && n.props.type === "radio" && !n.props.checked
    )[0];
    advancedRadio.props.onChange();
    tree = render({ state: EMPTY_STATE, onReload: vi.fn(), onFieldSaved });

    const form = byClass(tree, "file-pane__editor")[0];
    await form.props.onSubmit({ preventDefault: vi.fn() });
    await flush();

    expect(api.saveCandidateFile).toHaveBeenCalledWith("automation", { setup_mode: "advanced" });
    expect(onFieldSaved).toHaveBeenCalledWith({ key: "consent", summary: "advanced mode" });
  });

  it("Decline to answer records declined_fields.consent with no automation write", async () => {
    api.saveCandidateFile.mockResolvedValue({ ok: true });
    const onFieldSaved = vi.fn();
    let tree = render({ state: EMPTY_STATE, onReload: vi.fn(), onFieldSaved });
    rowByLabel(tree, "Automation consent").props.onClick();
    tree = render({ state: EMPTY_STATE, onReload: vi.fn(), onFieldSaved });

    const declineButton = visit(
      tree,
      (n) => n.type === "button" && textOf(n) === "Decline to answer"
    )[0];
    await declineButton.props.onClick();
    await flush();

    expect(api.saveCandidateFile).toHaveBeenCalledTimes(1);
    expect(api.saveCandidateFile).toHaveBeenCalledWith("form-defaults", {
      declined_fields: { consent: { declined_at: expect.any(String) } },
    });
    expect(onFieldSaved).toHaveBeenCalledWith({ key: "consent", summary: "declined" });
  });
});

// ---------------------------------------------------------------------------
// Lane A / R2 — pending company-proposal chips inside the Companies editor
// ---------------------------------------------------------------------------

describe("FilePane — company proposal chips (R2)", () => {
  const PROPOSAL = { proposalId: "p1", name: "Acme", version: 1 };

  it("renders a pending proposal as an accept/reject chip", () => {
    let tree = render({ state: EMPTY_STATE, companyProposals: [PROPOSAL] });
    rowByLabel(tree, "Companies").props.onClick();
    tree = render({ state: EMPTY_STATE, companyProposals: [PROPOSAL] });

    const row = byClass(tree, "file-pane__proposal-row")[0];
    expect(textOf(byClass(row, "file-pane__proposal-name")[0])).toBe("Acme");
  });

  it("Accept calls onDecideCompanyProposal with the proposal and 'approve-supported-ats'", async () => {
    const onDecideCompanyProposal = vi.fn().mockResolvedValue();
    let tree = render({
      state: EMPTY_STATE,
      companyProposals: [PROPOSAL],
      onDecideCompanyProposal,
    });
    rowByLabel(tree, "Companies").props.onClick();
    tree = render({ state: EMPTY_STATE, companyProposals: [PROPOSAL], onDecideCompanyProposal });

    const acceptButton = byClass(tree, "file-pane__proposal-accept")[0];
    await acceptButton.props.onClick();
    await flush();

    expect(onDecideCompanyProposal).toHaveBeenCalledWith(PROPOSAL, "approve-supported-ats");
  });

  it("Reject calls onDecideCompanyProposal with the proposal and 'reject'", async () => {
    const onDecideCompanyProposal = vi.fn().mockResolvedValue();
    let tree = render({
      state: EMPTY_STATE,
      companyProposals: [PROPOSAL],
      onDecideCompanyProposal,
    });
    rowByLabel(tree, "Companies").props.onClick();
    tree = render({ state: EMPTY_STATE, companyProposals: [PROPOSAL], onDecideCompanyProposal });

    const rejectButton = byClass(tree, "file-pane__proposal-reject")[0];
    await rejectButton.props.onClick();
    await flush();

    expect(onDecideCompanyProposal).toHaveBeenCalledWith(PROPOSAL, "reject");
  });

  it("renders no proposal list when there are no pending proposals", () => {
    let tree = render({ state: EMPTY_STATE });
    rowByLabel(tree, "Companies").props.onClick();
    tree = render({ state: EMPTY_STATE });
    expect(byClass(tree, "file-pane__proposal-list")).toHaveLength(0);
  });
});
