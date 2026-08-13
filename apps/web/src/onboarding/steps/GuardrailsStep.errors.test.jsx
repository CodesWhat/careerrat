// apps/web/src/onboarding/steps/GuardrailsStep.errors.test.jsx — covers
// handleSaveAndNext's converted error-copy site (GuardrailsStep.jsx:481-493).
// GuardrailsStep.test.jsx renders via renderToStaticMarkup, which has no event
// system and re-seeds hook state on every call — it can assert markup shape
// but can't drive an onClick, await its catch, and observe the resulting
// re-render. This file uses the same hook-cursor harness as
// InterviewDossierCard.test.jsx/EngineScreen.test.jsx instead, so the retry
// path (a real async failure -> friendly banner -> working retry) can
// actually be exercised.
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
  saveCandidateFile: vi.fn(),
}));

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    useState: (initial) => hooks.useState(initial),
  };
});
vi.mock("../../lib/api.js", () => api);
vi.mock("../../components/form.jsx", () => ({
  ChipInput: "chip-input",
  Field: "field",
  filterChipSuggestions: () => [],
}));
vi.mock("../../components/icons.jsx", () => ({ InfoIcon: "info-icon" }));
vi.mock("../../components/Toast.jsx", () => ({ InlineAlert: "inline-alert" }));
vi.mock("../OnboardingShell.jsx", () => ({
  OnboardingNavButton: "nav-button",
  OnboardingShell: "onboarding-shell",
}));

import { GuardrailsStep } from "./GuardrailsStep.jsx";

const BASE_STATE = {
  data: { targeting: { cut_signals: ["heavy travel"] } },
};

function renderStep(props) {
  hooks.begin();
  return GuardrailsStep({
    state: BASE_STATE,
    draftSeeds: {},
    goNext: () => {},
    goBack: () => {},
    showToast: () => {},
    ...props,
  });
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

function continueButton(tree) {
  return visit(
    tree.props.actions,
    (node) => node.type === "nav-button" && node.props.label === "Continue"
  )[0];
}

function alert(tree) {
  return visit(tree, (node) => node.type === "inline-alert")[0];
}

beforeEach(() => {
  hooks.reset();
  vi.clearAllMocks();
});

describe("GuardrailsStep save failure", () => {
  it("routes a real save failure through resolveErrorCopy — the fallback message renders, the raw server string only ever lives in `detail` — and wires a working retry", async () => {
    // 422 deliberately isn't one of resolveErrorCopy's mapped statuses/strings,
    // so this exercises the true generic bucket, where the bespoke "Save
    // failed" fallback (not resolveErrorCopy's own GENERIC_ERROR_MESSAGE)
    // applies.
    api.saveCandidateFile.mockRejectedValueOnce(
      new api.ApiError(422, { error: "cut_signals is malformed" })
    );
    const goNext = vi.fn();
    const showToast = vi.fn();

    let tree = renderStep({ goNext, showToast });
    expect(alert(tree)).toBeFalsy();

    await continueButton(tree).props.onClick();
    tree = renderStep({ goNext, showToast });

    const banner = alert(tree);
    expect(banner).toBeTruthy();
    expect(banner.props.message).toBe("Save failed");
    expect(banner.props.detail).toBe("cut_signals is malformed");
    expect(banner.props.message).not.toBe(banner.props.detail);
    expect(goNext).not.toHaveBeenCalled();

    api.saveCandidateFile.mockResolvedValueOnce({ ok: true });
    await banner.props.action.onRetry();
    tree = renderStep({ goNext, showToast });

    expect(alert(tree)).toBeFalsy();
    expect(goNext).toHaveBeenCalledTimes(1);
    expect(showToast).toHaveBeenCalledWith("Saved.");
    expect(api.saveCandidateFile).toHaveBeenCalledTimes(2);
  });
});
