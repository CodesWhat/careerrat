import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { normalizeSourceReviewArtifact } from "../../../../src/core/discovery/source-review-artifact.mjs";
import {
  handleSourceReviewKeyDown,
  SourceReview,
  SourceReviewSummaryCard,
  sourceReviewBatchDecisions,
  sourceReviewFromMessages,
  sourceReviewTextSelection,
  submitSourceReviewBatch,
} from "./source-review.jsx";

const review = normalizeSourceReviewArtifact({
  kind: "source_review",
  candidates: [
    {
      label: "LandEarly",
      url: "https://www.landearly.com/remote-jobs/platform-engineer",
      sourceType: "url-query",
      why: "Dated US platform roles, including senior and staff openings with pay data",
      status: "proposed",
      confidence: "high",
    },
    {
      label: "4 Day Week",
      url: "https://4dayweek.io/platform-engineering-jobs",
      sourceType: "url-query",
      why: "Fresh platform and backend listings from named employers, with US remote roles",
      status: "proposed",
      confidence: "high",
    },
    {
      label: "TrulyRemote Dev",
      url: "https://trulyremote.dev/remote-backend-engineer-jobs",
      sourceType: "url-query",
      why: "Updated backend board currently showing Staff Backend Engineer and distributed-systems roles",
      status: "proposed",
      confidence: "high",
    },
    {
      label: "Built In",
      url: "https://builtin.com/jobs/remote/dev-engineering/search/platform-engineer",
      sourceType: "url-query",
      why: "Dated US platform listings, including staff roles above the compensation floor",
      status: "proposed",
      confidence: "high",
    },
    {
      label: "RemotePilot",
      url: "https://remotepilot.dev/categories/backend-engineering/",
      sourceType: "url-query",
      why: "Staff backend, infrastructure, and distributed-systems listings",
      status: "proposed",
      confidence: "borderline",
    },
    {
      label: "DevJobsList",
      url: "https://www.devjobslist.com/",
      sourceType: "browser",
      why: "Dated remote software listings with employer and compensation details",
      status: "proposed",
      confidence: "borderline",
    },
    {
      label: "Anywhere Devs",
      url: "https://anywheredevs.com/",
      sourceType: "browser",
      why: "Landing page claims fresh remote engineering coverage but exposes no specific listings",
      status: "rejected",
      rejectionReason: "no visible dated listing",
    },
  ],
});

describe("source review", () => {
  it("resolves exact visible board names to the same stable batch ids", () => {
    expect(sourceReviewTextSelection(review, "Add LandEarly and Built In")).toEqual([
      review.candidates[0].id,
      review.candidates[3].id,
    ]);
    expect(sourceReviewTextSelection(review, "Add landearly, please.")).toEqual([
      review.candidates[0].id,
    ]);
    expect(sourceReviewTextSelection(review, "Add Built")).toBeNull();
    expect(sourceReviewTextSelection(review, "Add RemotePilot")).toBeNull();
  });

  it("only restores a pending source review from the active transcript", () => {
    expect(
      sourceReviewFromMessages([{ artifacts: [{ kind: "resume" }] }, { artifacts: [review] }])
    ).toMatchObject({ id: review.id });
    expect(
      sourceReviewFromMessages([
        {
          artifacts: [
            {
              ...review,
              candidates: review.candidates.map((candidate) =>
                candidate.status === "proposed"
                  ? { ...candidate, decision: { action: "discard", status: "completed" } }
                  : candidate
              ),
            },
          ],
        },
      ])
    ).toBeNull();
  });

  it("owns keyboard focus while its modal is open", () => {
    const onClose = vi.fn();
    const closeEvent = {
      key: "Escape",
      preventDefault: vi.fn(),
      stopPropagation: vi.fn(),
      stopImmediatePropagation: vi.fn(),
    };
    handleSourceReviewKeyDown({ event: closeEvent, onClose });
    expect(onClose).toHaveBeenCalledOnce();
    expect(closeEvent.preventDefault).toHaveBeenCalledOnce();

    const first = { focus: vi.fn() };
    const last = { focus: vi.fn() };
    const tabEvent = { key: "Tab", shiftKey: false, preventDefault: vi.fn() };
    handleSourceReviewKeyDown({
      event: tabEvent,
      dialog: {
        querySelectorAll: () => [first, last],
        contains: () => false,
      },
      activeElement: {},
    });
    expect(tabEvent.preventDefault).toHaveBeenCalledOnce();
    expect(first.focus).toHaveBeenCalledOnce();

    const html = renderToStaticMarkup(
      <SourceReview
        artifact={review}
        onDecision={() => undefined}
        onComplete={() => undefined}
        onClose={() => undefined}
      />
    );
    expect(html).toContain('role="dialog"');
    expect(html).toContain('aria-modal="true"');
    expect(html).toContain('tabindex="-1"');
  });

  it("uses the shared quiet card language without blue or glow selection chrome", () => {
    const css = readFileSync(fileURLToPath(new URL("./chat-first.css", import.meta.url)), "utf8");
    expect(css).toMatch(/\.source-review-summary\s*\{/);
    expect(css).toMatch(
      /\.source-review__card\s*\{[^}]*border:\s*1\.5px solid var\(--line-warm\)/s
    );
    expect(css).toMatch(/\.review-batch fieldset\s*\{[^}]*border:\s*0/s);
    expect(css).toMatch(
      /\.source-review__card:has\(input:checked\)\s*\{[^}]*background:\s*var\(--tint-cool-2\)/s
    );
    expect(css).not.toMatch(/\.source-review[^}]*box-shadow/s);
    expect(css).not.toMatch(
      /\.source-review[^}]*#(?:[0-9a-f]{2})?(?:00|33|66|99|cc|ff)[0-9a-f]{2}/i
    );
  });

  it("keeps the transcript summary to one compact card and the strongest four sources", () => {
    const html = renderToStaticMarkup(
      <SourceReviewSummaryCard artifact={review} onOpen={() => undefined} />
    );

    expect(html).toContain("6 sources found");
    expect(html).toContain("LandEarly");
    expect(html).toContain("type the board names you want to add");
    expect(html).toContain("others in this batch will be skipped");
    expect(html).toContain("4 Day Week");
    expect(html).toContain("TrulyRemote Dev");
    expect(html).toContain("Built In");
    expect(html).toContain("Review sources");
    expect(html).not.toContain("RemotePilot");
    expect(html).not.toContain("DevJobsList");
    expect(html).not.toContain("Anywhere Devs");
    expect(html.match(/class="source-review-summary__source"/g)).toHaveLength(4);
  });

  it("uses natural singular copy for one strong source", () => {
    const singleSourceReview = normalizeSourceReviewArtifact({
      kind: "source_review",
      candidates: [review.candidates[0]],
    });
    const html = renderToStaticMarkup(
      <SourceReviewSummaryCard artifact={singleSourceReview} onOpen={() => undefined} />
    );

    expect(html).toContain("1 strong match");
    expect(html).not.toContain("1 strong matches");
  });

  it("shows one small multi-select batch instead of an Add/Skip wall", () => {
    const html = renderToStaticMarkup(
      <SourceReview
        artifact={review}
        onDecision={() => undefined}
        onComplete={() => undefined}
        onClose={() => undefined}
      />
    );

    for (const label of ["LandEarly", "4 Day Week", "TrulyRemote Dev", "Built In"]) {
      expect(html).toContain(label);
    }
    expect(html).not.toContain("RemotePilot");
    expect(html).not.toContain("DevJobsList");
    expect(html).toContain("rejected during screening");
    expect(html).toContain("no visible dated listing");
    expect(html).toContain('<details class="source-review__rejected"');
    expect(html).toContain("Which sources should CareerRat add?");
    expect(html).toContain("Showing 4 of 6");
    expect(html.match(/type="checkbox"/g)).toHaveLength(4);
    expect(html.match(/>Save choices</g)).toHaveLength(1);
    expect(html).not.toContain(">Add source<");
    expect(html).not.toContain(">Skip<");
  });

  it("turns one batch selection into one version-stable decision per source", () => {
    expect(
      sourceReviewBatchDecisions(review, [review.candidates[0].id, review.candidates[2].id])
    ).toEqual([
      { candidate: expect.objectContaining({ id: review.candidates[0].id }), action: "save" },
      { candidate: expect.objectContaining({ id: review.candidates[1].id }), action: "discard" },
      { candidate: expect.objectContaining({ id: review.candidates[2].id }), action: "save" },
      { candidate: expect.objectContaining({ id: review.candidates[3].id }), action: "discard" },
    ]);
    expect(sourceReviewBatchDecisions(review, ["source-review-stale:source:missing"])).toBeNull();
  });

  it("submits batch decisions sequentially and completes from the final batch", async () => {
    const onDecision = vi.fn();
    const onComplete = vi.fn();
    const decided = {
      ...review,
      candidates: review.candidates.map((candidate, index) =>
        candidate.status === "proposed" && index < 4
          ? { ...candidate, decision: { action: "discard", status: "completed" } }
          : candidate
      ),
    };
    await submitSourceReviewBatch({
      artifact: decided,
      selectedOptionIds: [review.candidates[4].id],
      onDecision,
      onComplete,
    });
    expect(onDecision.mock.calls).toEqual([
      [expect.objectContaining({ id: review.candidates[4].id }), "save"],
      [expect.objectContaining({ id: review.candidates[5].id }), "discard"],
    ]);
    expect(onComplete).toHaveBeenCalledOnce();
    expect(onComplete).toHaveBeenCalledWith(expect.objectContaining(decided.completion));
    expect(onDecision.mock.invocationCallOrder[0]).toBeLessThan(
      onDecision.mock.invocationCallOrder[1]
    );
  });

  it("stops a batch after a failed durable decision and does not complete it", async () => {
    const onDecision = vi.fn().mockResolvedValueOnce(false);
    const onComplete = vi.fn();
    const result = await submitSourceReviewBatch({
      artifact: review,
      selectedOptionIds: [review.candidates[0].id],
      onDecision,
      onComplete,
    });
    expect(result).toBe(false);
    expect(onDecision).toHaveBeenCalledOnce();
    expect(onComplete).not.toHaveBeenCalled();
  });

  it("fails closed instead of rendering malformed artifact data", () => {
    const html = renderToStaticMarkup(
      <SourceReview
        artifact={{ kind: "source_review", candidates: [{ label: "Bad", url: "file:///x" }] }}
      />
    );
    expect(html).toBe("");
    expect(html).not.toContain("file://");
  });
});
