import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";

const apiMock = vi.hoisted(() => ({
  state: null,
  submitCalls: [],
}));

vi.mock("../lib/api.js", () => ({
  decideDeepIngestProposal: vi.fn(async (payload) => ({ ok: true, payload })),
  getDeepIngestState: vi.fn(async () => apiMock.state),
  submitDeepIngestSource: vi.fn(async (payload) => {
    apiMock.submitCalls.push(payload);
    return { ok: true, status: "proposal_ready", proposals: [] };
  }),
  updateDeepIngestLaneState: vi.fn(async (payload) => ({ ok: true, payload })),
  uploadDeepIngestFile: vi.fn(async (payload) => ({ ok: true, payload })),
}));

const FORBIDDEN_DEEP_INGEST_TEXT = [
  "AI interview",
  "guided interview",
  "full interview",
  "interview transcript",
  "/api/chat",
  "POST /api/skill/run",
  "/api/skill/run",
];

function deepIngestState(overrides = {}) {
  return {
    lanes: [
      { key: "source_coverage", label: "Source coverage", status: "completed" },
      { key: "evidence_claims", label: "Evidence", status: "review_needed" },
      { key: "story_bank", label: "Story", status: "gap" },
      { key: "honesty_boundaries", label: "Honesty", status: "completed" },
      {
        key: "writing_voice",
        label: "Writing voice",
        status: "deferred",
        reason: "No samples yet",
      },
      { key: "role_signals", label: "Role signal", status: "needs_source" },
      { key: "open_gaps", label: "Open gaps", status: "not_available", reason: "No gaps known" },
    ],
    readiness: {
      ready: false,
      terminalCount: 4,
      requiredCount: 7,
      missing: ["Evidence needs review", "Role signal needs source"],
    },
    sources: [
      {
        id: "src-1",
        title: "Portfolio paste",
        kind: "paste",
        targetShape: "evidence",
        status: "proposal_ready",
        preview: "Built incident automation and led billing migration.",
      },
      {
        id: "src-2",
        title: "Private repo",
        kind: "url",
        targetShape: "story",
        status: "manual_fallback",
        preview: "Private or login-gated source. Enter manually or defer this lane.",
      },
    ],
    proposals: [
      {
        id: "proposal-1",
        lane: "evidence",
        sourceId: "src-1",
        status: "review_needed",
        title: "Incident automation",
        summary: "Cut triage time from 45 minutes to 8.",
        supportingQuote: "cut manual triage from 45 minutes to 8",
      },
      {
        id: "proposal-2",
        lane: "story",
        sourceId: "src-2",
        status: "blocked",
        title: "Manual fallback needed",
        summary: "Login-gated source needs a manual note.",
      },
    ],
    selectedSourceId: "src-1",
    selectedProposalId: "proposal-1",
    ...overrides,
  };
}

async function renderPage(state = deepIngestState()) {
  const { DeepIngestPage } = await import("./DeepIngestPage.jsx");
  apiMock.state = state;
  return renderToStaticMarkup(
    <MemoryRouter initialEntries={["/deep-ingest"]}>
      <DeepIngestPage initialState={state} />
    </MemoryRouter>
  );
}

function expectNoDeepIngestRuntimeTokens(html) {
  for (const token of FORBIDDEN_DEEP_INGEST_TEXT) {
    expect(html, `Deep ingest UI leaked ${token}`).not.toContain(token);
  }
}

describe("DeepIngestPage route contract", () => {
  it("registers /deep-ingest in the app route map", () => {
    const source = readFileSync(new URL("../App.jsx", import.meta.url), "utf8");

    expect(source).toContain('path="/deep-ingest"');
    expect(source).toContain("DeepIngestPage");
  });
});

describe("DeepIngestPage workbench", () => {
  it("renders the target selector, empty-state copy, and disabled ingest action until input is valid", async () => {
    const html = await renderPage(
      deepIngestState({
        sources: [],
        proposals: [],
        selectedSourceId: null,
        selectedProposalId: null,
      })
    );

    expect(html).toContain("No deep ingest sources yet");
    expect(html).toContain(
      "Paste, drop, or link profile material to create reviewable proposals for evidence, stories, honesty, voice, and role signals."
    );
    for (const label of [
      "Auto",
      "Evidence",
      "Story",
      "Writing voice",
      "Honesty",
      "Role signal",
      "Paste",
      "Link",
    ]) {
      expect(html).toContain(label);
    }
    expect(html).toMatch(/<button[^>]*disabled[^>]*>Ingest source<\/button>/);
    expectNoDeepIngestRuntimeTokens(html);
  });

  it("renders lane progress, review filters, source preview, and editable proposal actions", async () => {
    const html = await renderPage();

    expect(html).toContain("4 of 7 lanes terminal");
    expect(html).toContain("Source preview");
    expect(html).toContain("Portfolio paste");
    expect(html).toContain("Review queue");
    expect(html).toContain("All");
    expect(html).toContain("Needs review");
    expect(html).toContain("Blocked");
    expect(html).toContain("Confirmed");
    expect(html).toContain("Proposal editor");
    expect(html).toContain("Save edits");
    expect(html).toContain("Confirm proposal");
    expect(html).toContain("Review proposals");
    expectNoDeepIngestRuntimeTokens(html);
  });

  it("shows explicit manual fallback and terminal lane actions for unreadable, deferred, and unavailable sources", async () => {
    const html = await renderPage();

    expect(html).toContain("manual_fallback");
    expect(html).toContain("Enter manually");
    expect(html).toContain("Retry ingest");
    expect(html).toContain("Defer lane");
    expect(html).toContain("Mark not available");
    expectNoDeepIngestRuntimeTokens(html);
  });
});
