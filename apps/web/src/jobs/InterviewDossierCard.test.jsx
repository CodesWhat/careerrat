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

const api = vi.hoisted(() => ({
  buildInterviewDossier: vi.fn(),
  getInterviewDossier: vi.fn(),
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
vi.mock("../components/Button.jsx", () => ({ Button: "button" }));
vi.mock("../components/Card.jsx", () => ({ Card: "section" }));
vi.mock("../components/Toast.jsx", () => ({ InlineAlert: "inline-alert" }));

import { InterviewDossierCard } from "./InterviewDossierCard.jsx";

function renderCard(props) {
  hooks.begin();
  return InterviewDossierCard(props);
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

function button(tree, label) {
  return visit(tree, (node) => node.type === "button" && textOf(node) === label)[0];
}

async function runEffects() {
  for (const effect of hooks.effects) effect();
  await Promise.resolve();
  await Promise.resolve();
}

beforeEach(() => {
  hooks.reset();
  vi.clearAllMocks();
});

describe("InterviewDossierCard", () => {
  it("renders Build prep dossier and calls buildInterviewDossier on click when no dossier exists", async () => {
    api.getInterviewDossier.mockRejectedValue({
      status: 404,
      body: { code: "DOSSIER_NOT_FOUND", error: { message: "not built" } },
    });
    api.buildInterviewDossier.mockResolvedValue({
      data: {
        dossier: {
          title: "Northstar",
          round: "Screen",
          generatedAt: "2026-06-10T12:00:00.000Z",
          markdown: "# Prep",
        },
      },
    });

    renderCard({ applicationId: "app-1" });
    await runEffects();
    let tree = renderCard({ applicationId: "app-1" });

    const buildButton = button(tree, "Build prep dossier");
    expect(buildButton).toBeTruthy();
    expect(visit(tree, (node) => node.type === "inline-alert")).toHaveLength(0);

    await buildButton.props.onClick();
    expect(api.buildInterviewDossier).toHaveBeenCalledWith({ applicationId: "app-1" });

    tree = renderCard({ applicationId: "app-1" });
    expect(JSON.stringify(tree)).toContain("# Prep");
    expect(button(tree, "Rebuild")).toBeTruthy();
  });

  it("renders the dossier markdown/title/round when getInterviewDossier resolves with data", async () => {
    api.getInterviewDossier.mockResolvedValue({
      data: {
        dossier: {
          title: "Northstar — Solutions Engineer",
          round: "Hiring manager",
          generatedAt: "2026-06-10T12:00:00.000Z",
          markdown: "## Likely questions\n- Why this role?",
        },
      },
    });

    renderCard({ applicationId: "app-2" });
    await runEffects();
    const tree = renderCard({ applicationId: "app-2" });

    expect(JSON.stringify(tree)).toContain("Likely questions");
    expect(JSON.stringify(tree)).toContain("Hiring manager");
    expect(button(tree, "Rebuild")).toBeTruthy();
    expect(button(tree, "Build prep dossier")).toBeFalsy();
  });

  it("treats a DOSSIER_NOT_FOUND 404 as the expected not-built-yet state, not an error banner", async () => {
    api.getInterviewDossier.mockRejectedValue({
      status: 404,
      body: {
        code: "DOSSIER_NOT_FOUND",
        error: { message: "interview dossier has not been prepared yet" },
      },
    });

    renderCard({ applicationId: "app-3" });
    await runEffects();
    const tree = renderCard({ applicationId: "app-3" });

    expect(button(tree, "Build prep dossier")).toBeTruthy();
    expect(visit(tree, (node) => node.type === "inline-alert")).toHaveLength(0);
  });

  it("shows the error banner for a genuine failure other than DOSSIER_NOT_FOUND", async () => {
    api.getInterviewDossier.mockRejectedValue({
      status: 409,
      body: { code: "NO_DATABASE", error: { message: "no database" } },
    });

    renderCard({ applicationId: "app-4" });
    await runEffects();
    const tree = renderCard({ applicationId: "app-4" });

    expect(visit(tree, (node) => node.type === "inline-alert").length).toBeGreaterThan(0);
    expect(button(tree, "Build prep dossier")).toBeTruthy();
  });
});
