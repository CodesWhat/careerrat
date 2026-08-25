import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { normalizeSourceReviewArtifact } from "../../../../src/core/discovery/source-review-artifact.mjs";
import {
  handleSourceReviewKeyDown,
  SourceReview,
  SourceReviewContent,
  SourceReviewSummaryCard,
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
    expect(css).toMatch(/\.source-review__actions\s*\{[^}]*justify-content:\s*flex-end/s);
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

  it("shows every proposal and rejection only in the dedicated review surface", () => {
    const html = renderToStaticMarkup(
      <SourceReview
        artifact={review}
        onDecision={() => undefined}
        onComplete={() => undefined}
        onClose={() => undefined}
      />
    );

    for (const label of [
      "LandEarly",
      "4 Day Week",
      "TrulyRemote Dev",
      "Built In",
      "RemotePilot",
      "DevJobsList",
      "Anywhere Devs",
    ]) {
      expect(html).toContain(label);
    }
    expect(html).toContain("Needs a closer look");
    expect(html).toContain("Rejected during screening");
    expect(html).toContain("no visible dated listing");
    expect(html.match(/>Add source</g)).toHaveLength(6);
    expect(html.match(/>Skip</g)).toHaveLength(6);
    expect(html).not.toContain("Finish board discovery");
  });

  it("routes confirm-first decisions and only offers completion after every proposal is decided", () => {
    const onDecision = vi.fn();
    const onComplete = vi.fn();
    const decided = {
      ...review,
      candidates: review.candidates.map((candidate) =>
        candidate.status === "proposed"
          ? { ...candidate, decision: { action: "discard", status: "completed" } }
          : candidate
      ),
    };
    const tree = SourceReviewContent({
      artifact: decided,
      onDecision,
      onComplete,
      onClose: () => undefined,
    });
    const buttons = [];
    function visit(node) {
      if (!node || typeof node !== "object") return;
      if (Array.isArray(node)) return node.forEach(visit);
      if (typeof node.type === "function") return visit(node.type(node.props));
      if (node.type === "button") buttons.push(node);
      visit(node.props?.children);
    }
    visit(tree);
    expect(buttons.map((button) => button.props.children)).toContain("Finish board discovery");
    buttons.find((button) => button.props.children === "Finish board discovery").props.onClick();
    expect(onComplete).toHaveBeenCalledWith(expect.objectContaining(decided.completion));
    expect(onDecision).not.toHaveBeenCalled();
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
