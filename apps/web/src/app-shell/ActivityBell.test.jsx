import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

// ActivityBell keeps its popover collapsed (`open` starts false) until a
// pointer click flips it — renderToStaticMarkup never fires that handler, so
// force `open` true via the only useState call in the component to exercise
// the popover's row markup.
vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    useState: () => [true, () => {}],
  };
});

const dashboard = vi.hoisted(() => ({ data: { activity: [] } }));
vi.mock("./DashboardContext.jsx", () => ({
  useDashboardSnapshot: () => dashboard,
}));

import { ActivityBell } from "./ActivityBell.jsx";

describe("ActivityBell", () => {
  it("keeps the default row human-readable and puts raw tags behind a collapsed Details disclosure", () => {
    dashboard.data = {
      activity: [
        {
          id: "evt-1",
          type: "status_change",
          title: "Application status changed",
          summary: "Moved to Interviewing",
          relTime: "2h ago",
          tags: ["operation:application:status-update", "status:interviewing"],
        },
      ],
    };

    const html = renderToStaticMarkup(<ActivityBell />);

    expect(html).toContain("Application status changed");
    expect(html).toContain("Moved to Interviewing");
    expect(html).toContain("<details");
    expect(html).toContain("<summary>Details</summary>");
    expect(html).toContain("operation:application:status-update");
    expect(html).toContain("status:interviewing");

    // The raw tag strings must live inside the details block, not the
    // always-visible row text ahead of it.
    const beforeDetails = html.split("<details")[0];
    expect(beforeDetails).not.toContain("operation:application:status-update");
    expect(beforeDetails).not.toContain("status:interviewing");
  });

  it("omits the Details disclosure entirely for events without tags", () => {
    dashboard.data = {
      activity: [
        {
          id: "evt-2",
          type: "system",
          title: "Tracker synced",
          summary: "",
          relTime: "1h ago",
          tags: [],
        },
      ],
    };

    const html = renderToStaticMarkup(<ActivityBell />);

    expect(html).toContain("Tracker synced");
    expect(html).not.toContain("<details");
  });
});
