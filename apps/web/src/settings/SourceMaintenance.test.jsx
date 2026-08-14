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
        pendingRemoval={null}
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
    expect(html).toContain("Provider adapter (optional)");
    expect(html).toContain("73 public adapters");
    expect(html).toContain("Disabled");
  });

  it("shows human-readable source metadata instead of internal identifiers", () => {
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
              provider: "remotevibecodingjobs",
              label: "Remote roles",
              target: "staff engineer",
              sourceType: "url-query",
              enabled: true,
              legitimacy: "supported",
            },
            {
              index: 1,
              provider: "workingnomads",
              label: "Working Nomads",
              target: "https://www.workingnomads.com/api/exposed_jobs/",
              sourceType: "board",
              enabled: true,
              legitimacy: "supported",
            },
          ],
          companies: [],
        }}
        pendingRemoval={null}
        onAddCompany={noop}
        onAddQuery={noop}
        onCompanyDraft={noop}
        onCompanyEdit={noop}
        onCompanyRemove={noop}
        onCompanySave={noop}
        onImportUrl={noop}
        onQueryDraft={noop}
        onRemovalCancel={noop}
        onSearchEdit={noop}
        onSearchRemove={noop}
        onSearchSave={noop}
        onUrlDraft={noop}
        queryDraft={{ label: "", query: "" }}
        urlDraft={{ label: "", url: "" }}
      />
    );

    expect(html).toContain("Remote Vibe Coding Jobs");
    expect(html).toContain("Working Nomads");
    expect(html).toContain("URL query");
    expect(html).not.toContain("<span>remotevibecodingjobs</span>");
    expect(html).not.toContain("<span>workingnomads</span>");
    expect(html).not.toContain("Url-Query");
  });

  it("requires an explicit second click before removing a source", () => {
    const html = renderToStaticMarkup(
      <SourceMaintenanceView
        busy={null}
        companyDraft={{ name: "", url: "" }}
        error={null}
        loading={false}
        model={{
          searches: [
            {
              index: 7,
              provider: "HiringCafe",
              label: "Staff platform",
              target: "staff platform engineer",
              sourceType: "url-query",
              enabled: true,
              legitimacy: "supported",
            },
          ],
          companies: [],
        }}
        pendingRemoval="search-7"
        onAddCompany={noop}
        onAddQuery={noop}
        onCompanyDraft={noop}
        onCompanyEdit={noop}
        onCompanyRemove={noop}
        onCompanySave={noop}
        onImportUrl={noop}
        onQueryDraft={noop}
        onRemovalCancel={noop}
        onSearchEdit={noop}
        onSearchRemove={noop}
        onSearchSave={noop}
        onUrlDraft={noop}
        queryDraft={{ label: "", query: "" }}
        urlDraft={{ label: "", url: "" }}
      />
    );

    expect(html).toContain("Confirm remove");
    expect(html).toContain("Cancel");
    expect(html).not.toContain(">Remove</button>");
  });

  it("renders a resolved error's message, retry action, and Technical details disclosure — never the raw string as the primary text", () => {
    const html = renderToStaticMarkup(
      <SourceMaintenanceView
        busy={null}
        companyDraft={{ name: "", url: "" }}
        error={{
          message: "Something went wrong on the server. Try again in a moment.",
          action: { label: "Try again", retry: true, onRetry: noop },
          detail: "SQLite table search_sources is locked at /Users/x/workspace",
        }}
        loading={false}
        model={{ searches: [], companies: [] }}
        pendingRemoval={null}
        onAddCompany={noop}
        onAddQuery={noop}
        onCompanyDraft={noop}
        onCompanyEdit={noop}
        onCompanyRemove={noop}
        onCompanySave={noop}
        onImportUrl={noop}
        onQueryDraft={noop}
        onRemovalCancel={noop}
        onSearchEdit={noop}
        onSearchRemove={noop}
        onSearchSave={noop}
        onUrlDraft={noop}
        queryDraft={{ label: "", query: "" }}
        urlDraft={{ label: "", url: "" }}
      />
    );

    expect(html).toContain("Something went wrong on the server. Try again in a moment.");
    expect(html).toContain("Try again");
    expect(html).toContain("<details");
    expect(html).toContain("Technical details");
    expect(html).toContain("SQLite table search_sources is locked at /Users/x/workspace");
    // The raw string must never be the alert's primary text — only inside the
    // collapsed disclosure.
    const messageIndex = html.indexOf("Something went wrong on the server");
    const detailsIndex = html.indexOf("<details");
    expect(html.indexOf("SQLite table search_sources")).toBeGreaterThan(detailsIndex);
    expect(messageIndex).toBeLessThan(detailsIndex);
  });
});
