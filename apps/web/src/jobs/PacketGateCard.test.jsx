import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { PacketGateCard } from "./PacketGateCard.jsx";

const api = vi.hoisted(() => ({ runPacketGate: vi.fn() }));
vi.mock("../lib/api.js", () => api);

function renderCard(props = {}) {
  return renderToStaticMarkup(
    <PacketGateCard verdict={null} busy={false} onEvaluate={() => {}} {...props} />
  );
}

describe("PacketGateCard", () => {
  it("renders gate, fit, comp, and reasons from a successful response", async () => {
    api.runPacketGate.mockResolvedValueOnce({
      data: {
        gate: "keep",
        fit: "strong workflow-delivery match",
        comp: "clear",
        reasons: ["Customer-facing implementation is central"],
      },
    });
    const response = await api.runPacketGate({ applicationId: "app-1" });
    const html = renderCard({ verdict: response.data });

    expect(api.runPacketGate).toHaveBeenCalledWith({ applicationId: "app-1" });
    expect(html).toContain("Keep");
    expect(html).toContain("strong workflow-delivery match");
    expect(html).toContain("clear");
    expect(html).toContain("Customer-facing implementation is central");
  });

  it("renders a disabled busy state while evaluation is pending", () => {
    const html = renderCard({ busy: true });
    expect(html).toContain("Evaluating…");
    expect(html).toContain("disabled");
  });

  it("owns no error surface — evaluation errors render via JobDrawer's shared InlineAlert", () => {
    // The drawer's runWrite wrapper catches every action error and renders it
    // through one drawer-wide InlineAlert (JobDrawer.jsx `actionError`), the
    // same contract as promote/status/comms writes — the card itself stays
    // presentation-only and ignores unknown props.
    const html = renderCard({ error: "Gate service unavailable" });
    expect(html).not.toContain('role="alert"');
    expect(html).not.toContain("Gate service unavailable");
  });
});
