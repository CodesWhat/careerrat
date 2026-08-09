import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { SourceMaintenanceView } from "./SourceMaintenance.jsx";

const noop = vi.fn();

describe("SourceMaintenanceView", () => {
  it("shows editable broad and company sources with provider, legitimacy, and watermarks", () => {
    const html = renderToStaticMarkup(
      <SourceMaintenanceView
        busy={null}
        companyDraft={{ name: "", url: "" }}
        error={null}
        loading={false}
        model={{
          searches: [
            {
              index: 0,
              provider: "HiringCafe",
              label: "Staff platform",
              target: "staff platform engineer",
              sourceType: "url-query",
              enabled: true,
              lastRunAt: "2026-08-09T10:00:00.000Z",
              legitimacy: "supported",
            },
          ],
          companies: [
            {
              index: 0,
              name: "Acme",
              url: "https://jobs.lever.co/acme",
              provider: "lever",
              enabled: false,
              lastRunAt: null,
              legitimacy: "verified-ats",
            },
          ],
        }}
        onAddCompany={noop}
        onAddQuery={noop}
        onCompanyDraft={noop}
        onCompanyEdit={noop}
        onCompanyRemove={noop}
        onCompanySave={noop}
        onImportUrl={noop}
        onQueryDraft={noop}
        onSearchEdit={noop}
        onSearchRemove={noop}
        onSearchSave={noop}
        onUrlDraft={noop}
        queryDraft={{ label: "", query: "" }}
        urlDraft={{ label: "", url: "" }}
      />
    );

    expect(html).toContain("Search sources");
    expect(html).toContain("Broad searches");
    expect(html).toContain("Company ATS boards");
    expect(html).toContain("HiringCafe");
    expect(html).toContain("Supported");
    expect(html).toContain("Verified ATS");
    expect(html).toContain("Last scanned");
    expect(html).toContain("Never scanned");
    expect(html).toContain("Import URL");
    expect(html).toContain("Add company board");
    expect(html).toContain("Disabled");
  });
});
