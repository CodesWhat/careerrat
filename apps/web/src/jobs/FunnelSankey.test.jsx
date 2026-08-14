import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { FunnelSankey } from "./FunnelSankey.jsx";

const sankey = {
  total: 8,
  nodes: [
    {
      id: "src-cold",
      label: "Direct apply",
      color: "#8E8B84",
      count: 5,
      col: 0,
      order: 1,
      filter: "all",
    },
    {
      id: "src-recruiter",
      label: "Recruiter sourced",
      color: "#4EA4A8",
      count: 3,
      col: 0,
      order: 2,
      filter: "all",
    },
    {
      id: "awaiting",
      label: "Awaiting response",
      color: "#B8B2AA",
      count: 3,
      col: 1,
      order: 1,
      filter: "awaiting",
    },
    {
      id: "heardback",
      label: "Heard back",
      color: "#2B2724",
      count: 5,
      col: 1,
      order: 2,
      filter: "heardback",
    },
    {
      id: "stale",
      label: "Going stale",
      color: "#A7A098",
      count: 1,
      col: 1.5,
      order: 1.5,
      filter: "stale",
    },
    {
      id: "technical",
      label: "Technical",
      color: "#7FCBA6",
      count: 3,
      col: 2,
      order: 1,
      filter: "reached-technical",
    },
    {
      id: "hiring-manager",
      label: "Hiring manager",
      color: "#5BC4A0",
      count: 1,
      col: 3,
      order: 2,
      filter: "reached-hiring-manager",
    },
    {
      id: "rejected",
      label: "Rejected",
      color: "#CB5340",
      count: 2,
      col: 2.5,
      order: 99,
      filter: "terminal",
    },
    {
      id: "accepted",
      label: "Accepted 🎉",
      color: "#2F9E55",
      count: 1,
      col: 3.7,
      order: 98,
      filter: "accepted",
    },
  ],
  links: [
    {
      from: "src-cold",
      to: "awaiting",
      count: 2,
      color: "#8E8B84",
      filter: "awaiting",
      examples: ["Alpha Labs · Applied"],
    },
    {
      from: "src-cold",
      to: "heardback",
      count: 3,
      color: "#8E8B84",
      filter: "heardback",
      examples: ["Beta Systems · Screen"],
    },
    {
      from: "src-recruiter",
      to: "heardback",
      count: 3,
      color: "#4EA4A8",
      filter: "heardback",
      examples: ["Gamma AI · Technical"],
    },
    {
      from: "heardback",
      to: "technical",
      count: 3,
      color: "#7FCBA6",
      filter: "reached-technical",
    },
    {
      from: "heardback",
      to: "hiring-manager",
      count: 1,
      color: "#5BC4A0",
      filter: "reached-hiring-manager",
    },
    {
      from: "technical",
      to: "rejected",
      count: 2,
      color: "#CB5340",
      filter: "terminal",
      examples: ["Delta Cloud · Technical"],
    },
    {
      from: "hiring-manager",
      to: "accepted",
      count: 1,
      color: "#2F9E55",
      filter: "accepted",
      examples: ["Echo Works · Offer"],
    },
    {
      from: "awaiting",
      to: "stale",
      count: 1,
      color: "#A7A098",
      filter: "stale",
      examples: ["Foxtrot Data · Applied"],
    },
  ],
};

describe("FunnelSankey", () => {
  it("renders canonical semantic stages without numbered rounds", () => {
    const html = renderToStaticMarkup(<FunnelSankey sankey={sankey} />);

    expect(html).toContain("Jobs funnel");
    expect(html).toContain("Direct apply");
    expect(html).toContain("Recruiter sourced");
    expect(html).toContain("Awaiting response");
    expect(html).toContain("Heard back");
    expect(html).toContain("Going stale");
    expect(html).toContain("Technical");
    expect(html).toContain("Hiring manager");
    expect(html).not.toMatch(/\b(?:1st|2nd|3rd|4th) round\b/);
    expect(html).toContain("Rejected");
    expect(html).toContain("Accepted");
    expect(html).toContain('data-sankey-link="heardback-technical"');
    expect(html).toContain('data-sankey-link="technical-rejected"');
    expect(html).toContain("Beta Systems · Screen");
    expect(html).toContain("(3)");
    expect(html).toContain("(1)");
  });

  it("renders a quiet empty state when no Sankey data exists", () => {
    const html = renderToStaticMarkup(<FunnelSankey sankey={{ nodes: [], links: [], total: 0 }} />);

    expect(html).toContain("No application funnel data yet");
    expect(html).not.toContain("<svg");
  });

  it("marks the active stage as selected and dims the rest when interactive", () => {
    const onSelectStage = vi.fn();
    const html = renderToStaticMarkup(
      <FunnelSankey
        sankey={sankey}
        activeFilter="reached-technical"
        onSelectStage={onSelectStage}
      />
    );

    const technicalNode = html.match(/<g[^>]*data-sankey-node="technical"[^>]*>/)?.[0];
    const coldNode = html.match(/<g[^>]*data-sankey-node="src-cold"[^>]*>/)?.[0];
    const technicalLink = html.match(/<path[^>]*data-sankey-link="heardback-technical"[^>]*>/)?.[0];

    expect(technicalNode).toContain("is-active");
    expect(coldNode).toContain("is-dimmed");
    expect(technicalLink).toContain("is-active");
    expect(html).toContain('role="button"');
    expect(html).toContain('tabindex="0"');
  });
});
