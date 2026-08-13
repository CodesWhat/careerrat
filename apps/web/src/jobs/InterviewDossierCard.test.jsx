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

  it("routes a genuine load failure (other than DOSSIER_NOT_FOUND) through resolveErrorCopy — the fallback message renders, the raw server string only ever lives in `detail` — and wires a working retry", async () => {
    // 409/NO_DATABASE deliberately isn't one of resolveErrorCopy's mapped
    // statuses/strings, so this exercises the true generic bucket, where the
    // bespoke "Interview prep failed" fallback (not resolveErrorCopy's own
    // GENERIC_ERROR_MESSAGE) applies.
    api.getInterviewDossier.mockRejectedValue(
      new api.ApiError(409, { code: "NO_DATABASE", error: { message: "no database" } })
    );

    renderCard({ applicationId: "app-4" });
    await runEffects();
    let tree = renderCard({ applicationId: "app-4" });

    const alert = visit(tree, (node) => node.type === "inline-alert")[0];
    expect(alert).toBeTruthy();
    expect(alert.props.message).toBe("Interview prep failed");
    expect(alert.props.detail).toBe("no database");
    expect(button(tree, "Build prep dossier")).toBeTruthy();

    api.getInterviewDossier.mockResolvedValueOnce({
      data: { dossier: { round: "Screen", markdown: "# Prep" } },
    });
    await alert.props.action.onRetry();
    tree = renderCard({ applicationId: "app-4" });
    expect(visit(tree, (node) => node.type === "inline-alert")).toHaveLength(0);
    expect(JSON.stringify(tree)).toContain("# Prep");
  });

  it("routes a build (Rebuild) failure through resolveErrorCopy the same way, with retry wired to Build specifically", async () => {
    api.getInterviewDossier.mockRejectedValue({
      status: 404,
      body: { code: "DOSSIER_NOT_FOUND", error: { message: "not built" } },
    });
    api.buildInterviewDossier.mockRejectedValueOnce(new api.ApiError(422, { error: "boom" }));

    renderCard({ applicationId: "app-5" });
    await runEffects();
    let tree = renderCard({ applicationId: "app-5" });
    await button(tree, "Build prep dossier").props.onClick();

    tree = renderCard({ applicationId: "app-5" });
    const alert = visit(tree, (node) => node.type === "inline-alert")[0];
    expect(alert.props.message).toBe("Interview prep failed");
    expect(alert.props.detail).toBe("boom");
    expect(alert.props.message).not.toBe(alert.props.detail);

    api.buildInterviewDossier.mockResolvedValueOnce({
      data: { dossier: { round: "Screen", markdown: "# Prep" } },
    });
    await alert.props.action.onRetry();
    expect(api.buildInterviewDossier).toHaveBeenCalledTimes(2);
  });
});
