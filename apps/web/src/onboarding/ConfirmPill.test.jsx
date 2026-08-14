// apps/web/src/onboarding/ConfirmPill.test.jsx
// vitest coverage for Lane A / R1 & R4's confirm-block pill. Same hand-rolled
// hook harness convention as FilePane.test.jsx/InterviewSurface.test.jsx (no
// jsdom) — ConfirmPill is invoked as a plain function and its returned
// element tree is walked directly. Its own useState(dialogOpen) is the only
// hook this component uses.

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
  return { ...actual, useState: (initial) => hooks.useState(initial) };
});

import { ConfirmPill } from "./ConfirmPill.jsx";

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

function render(props) {
  hooks.reset();
  return expand(ConfirmPill(props));
}

beforeEach(() => {
  hooks.clear();
});

// ---------------------------------------------------------------------------
// Single-click kinds — authorization, company_add, companies_suggest
// ---------------------------------------------------------------------------

describe("ConfirmPill — single-click kinds", () => {
  it("authorization: code-owned label reflects the patch, model summary renders alongside it", () => {
    const onConfirm = vi.fn();
    const tree = render({
      block: {
        kind: "authorization",
        summary: "Sounds right based on what you said",
        patch: { work_authorized: true, requires_sponsorship: false },
        status: "pending",
      },
      onConfirm,
    });
    expect(textOf(byClass(tree, "confirm-pill__label")[0])).toBe("Authorized to work");
    expect(textOf(byClass(tree, "confirm-pill__summary")[0])).toBe(
      "Sounds right based on what you said"
    );
    byClass(tree, "confirm-pill")[0].props.onClick();
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it("authorization: notes 'needs sponsorship' alongside either answer", () => {
    const authorizedNeedsSponsorship = render({
      block: {
        kind: "authorization",
        patch: { work_authorized: true, requires_sponsorship: true },
        status: "pending",
      },
      onConfirm: vi.fn(),
    });
    expect(textOf(byClass(authorizedNeedsSponsorship, "confirm-pill__label")[0])).toBe(
      "Authorized to work · needs sponsorship"
    );

    const notAuthorized = render({
      block: {
        kind: "authorization",
        patch: { work_authorized: false, requires_sponsorship: false },
        status: "pending",
      },
      onConfirm: vi.fn(),
    });
    expect(textOf(byClass(notAuthorized, "confirm-pill__label")[0])).toBe("Not authorized");
  });

  it("company_add: label is code-owned ('Track company') plus the proposed name", () => {
    const tree = render({
      block: { kind: "company_add", payload: { name: "Anthropic" }, status: "pending" },
      onConfirm: vi.fn(),
    });
    expect(textOf(byClass(tree, "confirm-pill__label")[0])).toBe("Track company · Anthropic");
  });

  it("companies_suggest: fixed code-owned label, no payload needed", () => {
    const tree = render({
      block: { kind: "companies_suggest", status: "pending" },
      onConfirm: vi.fn(),
    });
    expect(textOf(byClass(tree, "confirm-pill__label")[0])).toBe("Suggest companies");
  });

  it("candidate_patch: code-owned 'Update <doc>' label plus the patch's leaf fields, model summary alongside", () => {
    const tree = render({
      block: {
        kind: "candidate_patch",
        summary: "Told me their name and email",
        payload: {
          doc: "profile",
          patch: { candidate: { full_name: "Ada Lovelace", email: "ada@example.com" } },
        },
        status: "pending",
      },
      onConfirm: vi.fn(),
    });
    expect(textOf(byClass(tree, "confirm-pill__label")[0])).toBe(
      "Save personal details · Full name: Ada Lovelace · Email: ada@example.com"
    );
    expect(textOf(byClass(tree, "confirm-pill__summary")[0])).toBe("Told me their name and email");
  });

  it("candidate_patch: labels each of the four docs distinctly", () => {
    const labelFor = (doc) =>
      textOf(
        byClass(
          render({
            block: {
              kind: "candidate_patch",
              payload: { doc, patch: { x: "y" } },
              status: "pending",
            },
            onConfirm: vi.fn(),
          }),
          "confirm-pill__label"
        )[0]
      );
    expect(labelFor("profile")).toBe("Save personal details · X: y");
    expect(labelFor("targeting")).toBe("Save job preferences · X: y");
    expect(labelFor("honesty")).toBe("Save boundaries · X: y");
    expect(labelFor("form-defaults")).toBe("Save application answers · X: y");
  });

  it("evidence_claim: fixed code-owned label, model summary renders alongside it", () => {
    const tree = render({
      block: {
        kind: "evidence_claim",
        summary: "Ran a 12-person kitchen",
        payload: { claim: "Ran a 12-person kitchen", evidence: "Candidate-stated" },
        status: "pending",
      },
      onConfirm: vi.fn(),
    });
    expect(textOf(byClass(tree, "confirm-pill__label")[0])).toBe("Save evidence");
    expect(textOf(byClass(tree, "confirm-pill__summary")[0])).toBe("Ran a 12-person kitchen");
  });

  it("saving status disables the button and shows 'Saving…'", () => {
    const tree = render({
      block: { kind: "companies_suggest", status: "saving" },
      onConfirm: vi.fn(),
    });
    const button = byClass(tree, "confirm-pill")[0];
    expect(button.props.disabled).toBe(true);
    expect(textOf(byClass(tree, "confirm-pill__action")[0])).toBe("Saving…");
  });

  it("error status shows a Retry action and the error text, and stays clickable", () => {
    const onConfirm = vi.fn();
    const tree = render({
      block: { kind: "companies_suggest", status: "error", error: "Network error" },
      onConfirm,
    });
    const button = byClass(tree, "confirm-pill")[0];
    expect(button.props.disabled).toBe(false);
    expect(textOf(byClass(tree, "confirm-pill__action")[0])).toBe("Retry");
    expect(textOf(byClass(tree, "confirm-pill__error-text")[0])).toBe("Network error");
    button.props.onClick();
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it("resolved status renders a passive resultSummary chip, not a clickable button", () => {
    const tree = render({
      block: { kind: "company_add", status: "resolved", resultSummary: "Added Anthropic" },
      onConfirm: vi.fn(),
    });
    expect(visit(tree, (n) => n.type === "button")).toHaveLength(0);
    expect(textOf(byClass(tree, "confirm-pill--resolved")[0])).toBe("Added Anthropic");
  });
});

// ---------------------------------------------------------------------------
// Confirm-pill rendering bugs found by live QA — [object Object] leaves,
// bookkeeping fields shown as user answers, and label overflow.
// ---------------------------------------------------------------------------

describe("ConfirmPill — candidate_patch leaf-field rendering fixes", () => {
  it("never renders '[object Object]' for an array-of-objects leaf", () => {
    const tree = render({
      block: {
        kind: "candidate_patch",
        payload: {
          doc: "targeting",
          patch: {
            targeting: {
              role_buckets: [
                { name: "Backend engineering", priority: 1 },
                { name: "Platform", priority: 2 },
              ],
            },
          },
        },
        status: "pending",
      },
      onConfirm: vi.fn(),
    });
    const label = textOf(byClass(tree, "confirm-pill__label")[0]);
    expect(label).not.toContain("[object Object]");
    expect(label).toBe("Save job preferences · Role buckets: Backend engineering, Platform");
  });

  it("a declined_fields-only patch falls back to the plain code-owned label", () => {
    const tree = render({
      block: {
        kind: "candidate_patch",
        payload: {
          doc: "form-defaults",
          patch: { declined_fields: { resume: { declined_at: "2026-08-10T00:00:00-04:00" } } },
        },
        status: "pending",
      },
      onConfirm: vi.fn(),
    });
    expect(textOf(byClass(tree, "confirm-pill__label")[0])).toBe("Save application answers");
  });

  it("caps the visible leaf field list and appends a '+N more' count", () => {
    const tree = render({
      block: {
        kind: "candidate_patch",
        payload: {
          doc: "profile",
          patch: { a: "1", b: "2", c: "3", d: "4", e: "5" },
        },
        status: "pending",
      },
      onConfirm: vi.fn(),
    });
    expect(textOf(byClass(tree, "confirm-pill__label")[0])).toBe(
      "Save personal details · A: 1 · B: 2 · C: 3 · +2 more"
    );
  });

  it("does not append a '+N more' segment when every leaf fits under the cap", () => {
    const tree = render({
      block: {
        kind: "candidate_patch",
        payload: { doc: "profile", patch: { a: "1", b: "2" } },
        status: "pending",
      },
      onConfirm: vi.fn(),
    });
    expect(textOf(byClass(tree, "confirm-pill__label")[0])).toBe(
      "Save personal details · A: 1 · B: 2"
    );
  });

  // Bug fix round 2 — a long label left the model summary so little room
  // that flex-shrink crushed it down to an unreadable stub ("A."). A
  // summary that can't render as a real fragment must not render at all.
  it("drops the model summary entirely once a long label hasn't left it room, instead of rendering a stub", () => {
    const tree = render({
      block: {
        kind: "candidate_patch",
        summary: "Applied AI engineering targets with customer-facing work",
        payload: {
          doc: "targeting",
          patch: {
            targeting: { role_buckets: [{ priority: 1 }] },
            keep_signals: "Customer-facing responsibilities",
          },
        },
        status: "pending",
      },
      onConfirm: vi.fn(),
    });
    expect(byClass(tree, "confirm-pill__summary")).toHaveLength(0);
    expect(textOf(tree)).not.toContain("Applied AI engineering targets");
  });

  it("still renders the model summary alongside a short label", () => {
    const tree = render({
      block: {
        kind: "candidate_patch",
        summary: "Told me their name and email",
        payload: {
          doc: "profile",
          patch: { candidate: { full_name: "Ada Lovelace", email: "ada@example.com" } },
        },
        status: "pending",
      },
      onConfirm: vi.fn(),
    });
    expect(textOf(byClass(tree, "confirm-pill__summary")[0])).toBe("Told me their name and email");
  });
});

// ---------------------------------------------------------------------------
// Decline UX — "I'd rather not say" on authorization/consent_mode only
// (coordinator-mandated close: without this, a decline said INSIDE the chat
// has no way to become a real declined_fields write — the agent has no
// write tools of its own).
// ---------------------------------------------------------------------------

describe("ConfirmPill — decline and dismiss affordances", () => {
  it("authorization: renders a decline button beside the primary pill and calls onDecline directly", () => {
    const onConfirm = vi.fn();
    const onDecline = vi.fn();
    const tree = render({
      block: {
        kind: "authorization",
        patch: { work_authorized: true, requires_sponsorship: false },
        status: "pending",
      },
      onConfirm,
      onDecline,
    });
    const declineButton = byClass(tree, "confirm-pill__decline")[0];
    expect(textOf(declineButton)).toBe("I'd rather not say");
    declineButton.props.onClick();
    expect(onDecline).toHaveBeenCalledTimes(1);
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it("company and candidate proposals render a Dismiss action", () => {
    const companyAdd = render({
      block: { kind: "company_add", payload: { name: "Anthropic" }, status: "pending" },
      onConfirm: vi.fn(),
      onDecline: vi.fn(),
    });
    expect(textOf(byClass(companyAdd, "confirm-pill__decline")[0])).toBe("Dismiss");

    const suggest = render({
      block: { kind: "companies_suggest", status: "pending" },
      onConfirm: vi.fn(),
      onDecline: vi.fn(),
    });
    expect(textOf(byClass(suggest, "confirm-pill__decline")[0])).toBe("Dismiss");

    const patch = render({
      block: {
        kind: "candidate_patch",
        payload: { doc: "targeting", patch: { cut_signals: ["Wrong amount"] } },
        status: "pending",
      },
      onConfirm: vi.fn(),
      onDecline: vi.fn(),
    });
    expect(textOf(byClass(patch, "confirm-pill__decline")[0])).toBe("Dismiss");
  });

  it("consent_mode: renders a decline button that calls onDecline WITHOUT opening the dialog", () => {
    const onConfirm = vi.fn();
    const onDecline = vi.fn();
    const tree = render({
      block: { kind: "consent_mode", payload: "advanced", status: "pending" },
      onConfirm,
      onDecline,
    });
    const declineButton = byClass(tree, "confirm-pill__decline")[0];
    expect(textOf(declineButton)).toBe("I'd rather not say");
    declineButton.props.onClick();
    expect(onDecline).toHaveBeenCalledTimes(1);
    expect(byClass(tree, "confirm-dialog-overlay")).toHaveLength(0);
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it("consent_mode: decline button disables while saving", () => {
    const tree = render({
      block: { kind: "consent_mode", payload: "basic", status: "saving" },
      onConfirm: vi.fn(),
      onDecline: vi.fn(),
    });
    expect(byClass(tree, "confirm-pill__decline")[0].props.disabled).toBe(true);
  });

  it("consent_capability renders a Not now action", () => {
    const tree = render({
      block: {
        kind: "consent_capability",
        payload: { capability: "messaging", platform: "linkedin" },
        status: "pending",
      },
      automationStatus: { mode: "advanced", capabilities: [] },
      onConfirm: vi.fn(),
      onDecline: vi.fn(),
    });
    expect(textOf(byClass(tree, "confirm-pill__decline")[0])).toBe("Not now");
  });
});

// ---------------------------------------------------------------------------
// Two-step kinds — consent_mode, consent_capability (R4: code-owned copy,
// second confirmation dialog, model summary never shown)
// ---------------------------------------------------------------------------

describe("ConfirmPill — consent_mode (two-step dialog)", () => {
  it("clicking the pill opens a dialog instead of calling onConfirm directly", () => {
    const onConfirm = vi.fn();
    let tree = render({
      block: { kind: "consent_mode", payload: "advanced", status: "pending" },
      onConfirm,
    });
    expect(byClass(tree, "confirm-dialog-overlay")).toHaveLength(0);

    byClass(tree, "confirm-pill")[0].props.onClick();
    tree = render({
      block: { kind: "consent_mode", payload: "advanced", status: "pending" },
      onConfirm,
    });
    expect(onConfirm).not.toHaveBeenCalled();
    expect(byClass(tree, "confirm-dialog-overlay")).toHaveLength(1);
    expect(textOf(byClass(tree, "confirm-dialog__title")[0])).toBe("Turn on advanced permissions?");
  });

  it("the dialog's own Confirm button calls onConfirm; Cancel never does", async () => {
    const onConfirm = vi.fn().mockResolvedValue();
    let tree = render({
      block: { kind: "consent_mode", payload: "basic", status: "pending" },
      onConfirm,
    });
    byClass(tree, "confirm-pill")[0].props.onClick();
    tree = render({
      block: { kind: "consent_mode", payload: "basic", status: "pending" },
      onConfirm,
    });
    expect(textOf(byClass(tree, "confirm-dialog__title")[0])).toBe("Keep automation basic?");

    const cancelButton = visit(tree, (n) => n.type === "button" && textOf(n) === "Cancel")[0];
    cancelButton.props.onClick();
    tree = render({
      block: { kind: "consent_mode", payload: "basic", status: "pending" },
      onConfirm,
    });
    expect(byClass(tree, "confirm-dialog-overlay")).toHaveLength(0);
    expect(onConfirm).not.toHaveBeenCalled();

    byClass(tree, "confirm-pill")[0].props.onClick();
    tree = render({
      block: { kind: "consent_mode", payload: "basic", status: "pending" },
      onConfirm,
    });
    const confirmButton = visit(tree, (n) => n.type === "button" && textOf(n) === "Confirm")[0];
    await confirmButton.props.onClick();
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it("never renders the model's summary text for consent_mode", () => {
    const tree = render({
      block: {
        kind: "consent_mode",
        payload: "advanced",
        summary: "You said you wanted more automation",
        status: "pending",
      },
      onConfirm: vi.fn(),
    });
    expect(textOf(tree)).not.toContain("You said you wanted more automation");
  });
});

describe("ConfirmPill — consent_capability (two-step, capability-on-demand)", () => {
  const AUTOMATION_STATUS_ADVANCED = {
    mode: "advanced",
    capabilities: [
      {
        capability: "messaging",
        label: "In-platform messaging",
        summary: "read in-platform DMs into communications[]",
        platforms: [{ platform: "linkedin" }],
      },
    ],
  };
  const BLOCK = {
    kind: "consent_capability",
    payload: { capability: "messaging", platform: "linkedin" },
    summary: "You mentioned wanting DM tracking",
    status: "pending",
  };

  it("stays actionable when the internal automation mode has not been enabled yet", () => {
    const onConfirm = vi.fn();
    const tree = render({
      block: BLOCK,
      automationStatus: { ...AUTOMATION_STATUS_ADVANCED, mode: "basic" },
      onConfirm,
    });
    const button = byClass(tree, "confirm-pill")[0];
    expect(button.props.disabled).toBe(false);
    expect(textOf(byClass(tree, "confirm-pill__action")[0])).toBe("Confirm");
  });

  it("opens a dialog with code-owned capability/platform copy once advanced mode is on", () => {
    const onConfirm = vi.fn();
    let tree = render({ block: BLOCK, automationStatus: AUTOMATION_STATUS_ADVANCED, onConfirm });
    const button = byClass(tree, "confirm-pill")[0];
    expect(button.props.disabled).toBe(false);

    button.props.onClick();
    tree = render({ block: BLOCK, automationStatus: AUTOMATION_STATUS_ADVANCED, onConfirm });
    expect(textOf(byClass(tree, "confirm-dialog__title")[0])).toBe(
      "Allow In-platform messaging on Linkedin?"
    );
    expect(textOf(byClass(tree, "confirm-dialog__body")[0])).toContain(
      "read in-platform DMs into communications[]"
    );
    // R4 — the model's own summary is never shown for this kind, only the
    // code-owned capability.summary from automationStatus.
    expect(textOf(tree)).not.toContain("You mentioned wanting DM tracking");
  });

  it("the dialog's Confirm button calls onConfirm", async () => {
    const onConfirm = vi.fn().mockResolvedValue();
    let tree = render({ block: BLOCK, automationStatus: AUTOMATION_STATUS_ADVANCED, onConfirm });
    byClass(tree, "confirm-pill")[0].props.onClick();
    tree = render({ block: BLOCK, automationStatus: AUTOMATION_STATUS_ADVANCED, onConfirm });
    const confirmButton = visit(tree, (n) => n.type === "button" && textOf(n) === "Confirm")[0];
    await confirmButton.props.onClick();
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });
});
