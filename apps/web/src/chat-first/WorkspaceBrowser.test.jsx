import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

async function loadBrowser() {
  return import("./WorkspaceBrowser.jsx");
}

function textOf(node) {
  if (node == null || typeof node === "boolean") return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textOf).join("");
  return textOf(node.props?.children);
}

function findElement(node, predicate) {
  if (!node || typeof node !== "object") return null;
  if (Array.isArray(node)) {
    for (const child of node) {
      const found = findElement(child, predicate);
      if (found) return found;
    }
    return null;
  }
  if (typeof node.type === "function") return findElement(node.type(node.props), predicate);
  if (predicate(node)) return node;
  return findElement(node.props?.children, predicate);
}

const JOBS = [
  {
    id: "tyrell",
    company: "Tyrell Corp",
    role: "Staff ML Platform Engineer",
    stage: "Staff",
    modeLabel: "Remote",
    location: "United States (Remote)",
    fit: 88,
    compStatus: "comp ✓",
    sourceHistory: ["sourced Tuesday · greenhouse", "gate cleared · comp above floor"],
  },
  {
    id: "aperture",
    company: "Aperture Science",
    role: "Principal Software Engineer",
    stage: "Principal",
    modeLabel: "Hybrid",
    location: "New York, NY",
    fit: 84,
    evaluationRequired: true,
  },
];

const PIPELINE = {
  applicationCount: 29,
  rows: [
    { id: "applied", label: "Applied", count: 29 },
    { id: "heard-back", label: "Heard back", count: 10 },
    { id: "onsite", label: "Onsite", count: 3 },
    { id: "final", label: "Final", count: 2 },
    { id: "offer", label: "Offer", count: 2, highlight: true },
  ],
  leaks: [
    { id: "stale", label: "Going stale", count: 15 },
    { id: "ghosted", label: "Ghosted", count: 8 },
  ],
  jobs: [{ id: "e-corp", company: "E Corp", role: "Staff SWE", stage: "Offer", fit: 91 }],
};

function baseProps(overrides = {}) {
  return {
    activeTab: "search",
    counts: { search: 11, pipeline: 22, files: 24, people: 17 },
    jobs: JOBS,
    selection: new Set(["tyrell"]),
    sourceSweep: {
      status: "idle",
      summary: "last sweep today 7:02am · 4 boards · 11 found",
    },
    locationPolicy: {
      home: "NYC",
      remoteRegion: "United States",
      summary: "NYC local + US remote",
      boundary: "On-site limited to NYC",
    },
    pipeline: PIPELINE,
    files: [],
    people: [],
    schedule: [],
    onClose: vi.fn(),
    onTabChange: vi.fn(),
    onToggleSelection: vi.fn(),
    onRunSweep: vi.fn(),
    onPipelineViewChange: vi.fn(),
    onDraftPackets: vi.fn(),
    onDraftAndApply: vi.fn(),
    onChatAbout: vi.fn(),
    onDismissSelection: vi.fn(),
    ...overrides,
  };
}

describe("WorkspaceBrowser", () => {
  it("keeps missing-source recovery inside the new Settings source surface", async () => {
    const { SearchToolbar } = await loadBrowser();
    const onOpenSourceHealth = vi.fn();
    const tree = SearchToolbar({
      sourceSweep: { status: "error", summary: "No enabled search sources are configured yet." },
      onOpenSourceHealth,
    });
    const buttons = Array.isArray(tree.props.children)
      ? tree.props.children
      : [tree.props.children];
    const sourceHealth = buttons.find(
      (child) => child?.type === "button" && child.props.children === "Check job sites"
    );

    sourceHealth.props.onClick();
    expect(onOpenSourceHealth).toHaveBeenCalledOnce();
    expect(renderToStaticMarkup(tree)).not.toMatch(/\/onboard|write-config|\/jobs/);
  });

  it("collapses cart actions into one primary apply control", () => {
    const css = readFileSync(
      fileURLToPath(new URL("./workspace-browser.css", import.meta.url)),
      "utf8"
    );

    expect(css).toMatch(
      /\.cf-cart__actions--collapsed\s*\{[^}]*flex-direction:\s*row[^}]*padding:\s*0[^}]*background:\s*transparent/s
    );
    expect(css).toMatch(/\.cf-cart__actions--collapsed \.cf-button--lime\s*\{[^}]*flex:\s*1/s);
  });

  it("does not apply the light hover surface to selected job rows", () => {
    const css = readFileSync(
      fileURLToPath(new URL("./workspace-browser.css", import.meta.url)),
      "utf8"
    );

    expect(css).toMatch(/\.cf-job-row:not\(\.cf-job-row--selected\):hover\s*\{/);
    expect(css).not.toMatch(/\.cf-job-row:hover\s*\{/);
  });

  it("keeps browser filters on the handoff pill radius", () => {
    const css = readFileSync(
      fileURLToPath(new URL("./workspace-browser.css", import.meta.url)),
      "utf8"
    );
    const filterRule = css.match(/\.cf-browser \.cf-filter\s*\{([^}]*)\}/)?.[1] || "";

    expect(filterRule).toMatch(/border-radius:\s*var\(--r-pill\)/);
  });

  it("renders the desktop slide-in shell and controlled cart selection", async () => {
    const { WorkspaceBrowser } = await loadBrowser();
    const html = renderToStaticMarkup(<WorkspaceBrowser {...baseProps()} />);

    expect(html).toContain("THREADS · 1 EXPIRING");
    expect(html).toContain("Search · 11");
    expect(html).toContain("Pipeline · 22");
    expect(html).toContain("SELECTED · 1");
    expect(html).toContain("Tyrell Corp");
    expect(html).toContain("NYC local + US remote");
    expect(html).toContain("On-site limited to NYC");
    expect(html).toContain("United States (Remote)");
    expect(html).not.toContain("location ~");
    expect(html).toContain("Apply to 1 job");
    expect(html).not.toContain("Draft packet");
    expect(html).not.toContain("Chat about this");
    expect(html).toContain("brings every final submit back to you");
    expect(html).toContain('type="checkbox"');
    expect(html).toContain('checked=""');
  });

  it("dispatches search and cart actions with the externally-owned ids", async () => {
    const { SearchPanel, SelectionCart } = await loadBrowser();
    const onToggleSelection = vi.fn();
    const onRunSweep = vi.fn();
    const onFilter = vi.fn();
    const onDraftAndApply = vi.fn();
    const search = SearchPanel({
      jobs: JOBS,
      selection: new Set(["tyrell"]),
      sourceSweep: { status: "idle", summary: "today · 11 found" },
      onToggleSelection,
      onRunSweep,
      onFilter,
    });
    const cart = SelectionCart({
      jobs: JOBS,
      selection: ["tyrell", "aperture"],
      agentName: "Paul",
      onDraftAndApply,
    });

    const searchButtons = Array.isArray(search.props.children)
      ? search.props.children
      : [search.props.children];
    const toolbar = searchButtons[0].type(searchButtons[0].props);
    const toolbarButton = toolbar.props.children[0];
    toolbarButton.props.onClick();
    expect(onRunSweep).toHaveBeenCalledOnce();

    const resultList = searchButtons.at(-1);
    const firstRow = resultList.props.children[0].type(resultList.props.children[0].props);
    firstRow.props.children[0].props.onChange();
    expect(onToggleSelection).toHaveBeenCalledWith("tyrell");

    const sourceSelect = findElement(
      search,
      (node) => node.type === "select" && node.props["aria-label"] === "Filter by source"
    );
    sourceSelect.props.onChange({ target: { value: "greenhouse" } });
    expect(onFilter).toHaveBeenCalledWith("source", "greenhouse");

    const actions = cart.props.children[2];
    actions.props.children[0].props.onClick();
    expect(onDraftAndApply).toHaveBeenCalledWith(["tyrell", "aperture"]);
    const actionMarkup = renderToStaticMarkup(actions);
    expect(actionMarkup).toContain("Apply to 2 jobs");
    expect(actionMarkup).not.toContain("Draft 2 packets");
    expect(actionMarkup).not.toContain("Chat about these 2");
  });

  it("offers one provider-neutral job search action", async () => {
    const { SearchToolbar } = await loadBrowser();
    const html = renderToStaticMarkup(
      <SearchToolbar sourceSweep={{ status: "idle", summary: "Ready to search" }} />
    );

    expect(html).toContain("Search for jobs");
    expect(html).not.toContain("Sweep boards");
  });

  it("makes the whole search row one native keyboard-capable selection target", async () => {
    const { SearchJobRow } = await loadBrowser();
    const onToggleSelection = vi.fn();
    const row = SearchJobRow({
      job: JOBS[0],
      selected: false,
      onToggleSelection,
    });

    expect(row.type).toBe("label");
    expect(row.props.onClick).toBeUndefined();
    expect(row.props.onKeyDown).toBeUndefined();
    expect(row.props.children[0]).toMatchObject({
      type: "input",
      props: {
        type: "checkbox",
        checked: false,
        "aria-label": "Select Tyrell Corp, Staff ML Platform Engineer",
      },
    });
    row.props.children[0].props.onChange();
    expect(onToggleSelection).toHaveBeenCalledOnce();
  });

  it("identifies a partial job description on its own search card", async () => {
    const { SearchJobRow } = await loadBrowser();
    const partial = renderToStaticMarkup(
      <SearchJobRow job={{ ...JOBS[0], descriptionPartial: true }} selected={false} />
    );
    const complete = renderToStaticMarkup(
      <SearchJobRow job={{ ...JOBS[0], descriptionPartial: false }} selected={false} />
    );

    expect(partial).toContain("Partial description");
    expect(partial).toContain("CareerRat only captured part of this job description.");
    expect(partial).not.toContain("bodyPartial");
    expect(complete).not.toContain("Partial description");
  });

  it("renders coordinated lane progress from typed state and never invents a timer", async () => {
    const { WorkspaceBrowser } = await loadBrowser();
    const html = renderToStaticMarkup(
      <WorkspaceBrowser
        {...baseProps({
          sourceSweep: {
            status: "running",
            detail: "Searching configured sources and the web",
            lanes: {
              deterministic: {
                label: "Configured sources",
                configured: true,
                executable: true,
                status: "running",
              },
              aiWeb: {
                label: "AI web search",
                configured: true,
                executable: true,
                consented: true,
                status: "running",
              },
            },
          },
        })}
      />
    );
    const source = readFileSync(
      fileURLToPath(new URL("./WorkspaceBrowser.jsx", import.meta.url)),
      "utf8"
    );

    expect(html).toContain("Searching for jobs…");
    expect(html).toContain("Searching your saved job sites and the web");
    expect(html).toContain('role="status" aria-label="Search lane status"');
    expect(html).toContain("Saved job sites: searching");
    expect(html).toContain("AI search: searching");
    expect(html).not.toContain("Sweep boards");
    expect(source).not.toContain("setTimeout");
  });

  it("turns a search timeout into a clear retry state", async () => {
    const { SearchToolbar } = await loadBrowser();
    const onRunSweep = vi.fn();
    const sourceSweep = {
      status: "complete",
      summary: "1 search lane finished · 1 failed",
      lanes: {
        deterministic: { label: "Configured sources", status: "succeeded" },
        aiWeb: {
          label: "AI web search",
          status: "failed",
          error: "AI search timed out",
        },
      },
    };
    const tree = SearchToolbar({ sourceSweep, onRunSweep });
    const html = renderToStaticMarkup(tree);
    const children = Array.isArray(tree.props.children)
      ? tree.props.children
      : [tree.props.children];
    const retry = children.find(
      (child) => child?.type === "button" && child.props.children?.at?.(-1) === "Retry search"
    );

    expect(html).toContain("AI search: The AI search took too long. Try again.");
    expect(html).not.toContain("AI search: failed");
    expect(retry).toBeTruthy();
    retry.props.onClick();
    expect(onRunSweep).toHaveBeenCalledOnce();
  });

  it("treats a top-level search error without lane data as a retry state", async () => {
    const { SearchPanel } = await loadBrowser();
    const html = renderToStaticMarkup(
      <SearchPanel
        jobs={[]}
        filterJobs={[]}
        onboardingHandoff
        sourceSweep={{ status: "error", summary: "Saved search state could not be loaded." }}
      />
    );

    expect(html).toContain("Retry search");
    expect(html).toContain("Search needs attention");
    expect(html).toContain("Search didn&#x27;t finish. Review the error above, then retry.");
    expect(html).not.toContain("Start your first job search");
    expect(html).not.toContain("Search for jobs to start building your list.");
  });

  it("keeps technical top-level search status out of no-lane recovery copy", async () => {
    const { SearchToolbar } = await loadBrowser();
    const onRunSweep = vi.fn();
    const failed = SearchToolbar({
      sourceSweep: {
        status: "error",
        summary:
          "SQLITE_BUSY while reading /Users/person/code/careerrat/.careerrat/db/careerrat.db",
      },
      onRunSweep,
    });
    const retry = findElement(
      failed,
      (node) => node.type === "button" && textOf(node) === "Retry search"
    );
    const failedHtml = renderToStaticMarkup(failed);
    const runningHtml = renderToStaticMarkup(
      <SearchToolbar
        sourceSweep={{
          status: "running",
          detail: "provider_route=ai_web /Users/person/code/careerrat/src/core/search/run.mjs:74",
          lanes: {
            deterministic: {
              label: "Configured sources",
              status: "running",
            },
          },
        }}
      />
    );

    expect(failedHtml).toContain("Search couldn&#x27;t finish. Try again.");
    expect(failedHtml).not.toContain("SQLITE_BUSY");
    expect(failedHtml).not.toContain("/Users/person");
    expect(retry).toBeTruthy();
    retry.props.onClick();
    expect(onRunSweep).toHaveBeenCalledOnce();
    expect(runningHtml).toContain("Searching your saved job sites");
    expect(runningHtml).not.toContain("provider_route");
    expect(runningHtml).not.toContain("/Users/person");
  });

  it("turns skipped lane reasons into plain-English status and omits unknown reasons", async () => {
    const { SearchToolbar } = await loadBrowser();
    const html = renderToStaticMarkup(
      <SearchToolbar
        sourceSweep={{
          status: "error",
          reason: "no-configured-lane",
          summary: "CareerRat needs at least one job site or a connected AI before it can search.",
          lanes: {
            deterministic: {
              label: "Configured sources",
              status: "skipped",
              reason: "not-configured",
            },
            aiWeb: {
              label: "AI web search",
              status: "skipped",
              reason: "not-consented",
            },
            backup: {
              label: "Backup search",
              status: "skipped",
              reason: "unavailable",
            },
            cancelled: {
              label: "Paused search",
              status: "skipped",
              reason: "cancelled",
            },
            internal: {
              label: "Internal lane",
              status: "skipped",
              reason: "provider_route_disabled",
            },
          },
        }}
      />
    );

    expect(html).toContain("Saved job sites: not set up");
    expect(html).toContain("AI search: permission needed");
    expect(html).toContain("Backup search: not available");
    expect(html).toContain("Paused search: stopped");
    expect(html).not.toContain("Internal lane");
    expect(html).not.toContain("skipped");
    expect(html).not.toContain("not-configured");
    expect(html).not.toContain("not-consented");
    expect(html).not.toContain("provider_route_disabled");
  });

  it("replaces technical lane errors with candidate-safe retry copy", async () => {
    const { SearchToolbar } = await loadBrowser();
    const html = renderToStaticMarkup(
      <SearchToolbar
        sourceSweep={{
          status: "error",
          summary: "0 search lanes finished · 1 failed",
          lanes: {
            aiWeb: {
              label: "AI web search",
              status: "failed",
              error:
                "Error: ECONNREFUSED at /Users/person/code/careerrat/src/core/search/run.mjs:74",
            },
          },
        }}
      />
    );

    expect(html).toContain("AI search: AI search couldn&#x27;t finish. Try again.");
    expect(html).toContain("Retry search");
    expect(html).not.toContain("ECONNREFUSED");
    expect(html).not.toContain("/Users/person");
  });

  it("turns schema failures and lane bookkeeping into plain-English search recovery", async () => {
    const { SearchToolbar } = await loadBrowser();
    const html = renderToStaticMarkup(
      <SearchToolbar
        sourceSweep={{
          status: "complete",
          summary: "0 search lanes finished · 1 lane needs retry",
          lanes: {
            deterministic: { label: "Configured sources", status: "succeeded" },
            aiWeb: {
              label: "AI web search",
              status: "failed",
              error: "Model output did not match the route schema.",
            },
          },
        }}
      />
    );

    expect(html).toContain("Your saved job sites finished. The AI search needs another try.");
    expect(html).toContain("Saved job sites: finished");
    expect(html).toContain(
      "AI search: The AI search returned something CareerRat couldn&#x27;t use. Try again."
    );
    expect(html).toContain("Retry search");
    expect(html).not.toContain("route schema");
    expect(html).not.toContain("search lanes");
    expect(html).not.toContain("succeeded");
  });

  it("keeps the reverse mixed-result search out of lane bookkeeping copy", async () => {
    const { SearchToolbar } = await loadBrowser();
    const html = renderToStaticMarkup(
      <SearchToolbar
        sourceSweep={{
          status: "complete",
          summary: "1 search lane finished · 1 lane needs retry",
          lanes: {
            deterministic: {
              label: "Configured sources",
              status: "failed",
              error: "source worker failed",
            },
            aiWeb: { label: "AI web search", status: "succeeded" },
          },
        }}
      />
    );

    expect(html).toContain("The AI search finished. Your saved job sites need another try.");
    expect(html).not.toContain("search lane");
    expect(html).not.toContain("succeeded");
  });

  it("does not claim an empty failed search has nothing to triage", async () => {
    const { SearchPanel } = await loadBrowser();
    const html = renderToStaticMarkup(
      <SearchPanel
        jobs={[]}
        sourceSweep={{
          status: "error",
          summary: "0 search lanes finished · 1 failed",
          lanes: {
            deterministic: {
              label: "Configured sources",
              status: "failed",
              error: "Greenhouse could not be reached",
            },
          },
        }}
      />
    );

    expect(html).toContain("Your saved job sites need another try.");
    expect(html).toContain(
      "Saved job sites: CareerRat couldn&#x27;t reach one of your saved job sites. Try again."
    );
    expect(html).toContain("Retry search");
    expect(html).not.toContain("No jobs need triage right now.");
  });

  it("never exposes an unknown short provider error", async () => {
    const { SearchToolbar } = await loadBrowser();
    const html = renderToStaticMarkup(
      <SearchToolbar
        sourceSweep={{
          status: "error",
          summary: "provider failed",
          lanes: {
            aiWeb: {
              label: "AI web search",
              status: "failed",
              error: "Provider route returned invalid output",
            },
          },
        }}
      />
    );

    expect(html).toContain("AI search: AI search couldn&#x27;t finish. Try again.");
    expect(html).not.toContain("Provider route");
    expect(html).not.toContain("provider failed");
  });

  it("distinguishes initial idle, clean zero, cancelled, and missing-source searches", async () => {
    const { SearchPanel } = await loadBrowser();
    const renderEmptySearch = (sourceSweep, props = {}) =>
      renderToStaticMarkup(
        <SearchPanel jobs={[]} filterJobs={[]} sourceSweep={sourceSweep} {...props} />
      );

    expect(renderEmptySearch({ status: "idle", summary: "Ready to search" })).toContain(
      "Search for jobs to start building your list."
    );
    expect(
      renderEmptySearch({ status: "complete", summary: "0 new · 0 qualified · 8 scanned" })
    ).toContain("No new matches this time.");
    expect(
      renderEmptySearch({
        status: "idle",
        reason: "cancelled",
        summary: "Stopped before completion.",
        lanes: {
          deterministic: {
            label: "Configured sources",
            status: "skipped",
            reason: "cancelled",
          },
        },
      })
    ).toContain("Search cancelled. Run it again whenever you&#x27;re ready.");

    const onOpenSourceHealth = vi.fn();
    const noSources = SearchPanel({
      jobs: [],
      filterJobs: [],
      sourceSweep: {
        status: "error",
        reason: "no-configured-lane",
        summary: "Nothing can run yet.",
      },
      onOpenSourceHealth,
    });
    const setupButton = findElement(
      noSources,
      (node) => node.type === "button" && textOf(node) === "Check job sites"
    );

    expect(renderToStaticMarkup(noSources)).toContain("No search sources are ready yet.");
    expect(setupButton).toBeTruthy();
    setupButton.props.onClick();
    expect(onOpenSourceHealth).toHaveBeenCalledOnce();
  });

  it.each([
    [{ status: "hydrating" }, "LOADING SAVED SEARCH"],
    [{ status: "idle", summary: "Ready to search" }, "READY TO SEARCH"],
    [{ status: "running" }, "SEARCHING"],
    [{ status: "complete" }, "NO NEW MATCHES"],
    [
      {
        status: "idle",
        summary: "Search cancelled.",
        lanes: { deterministic: { status: "skipped", reason: "cancelled" } },
      },
      "SEARCH CANCELLED",
    ],
    [{ status: "error", summary: "Search could not be loaded." }, "SEARCH NEEDS ATTENTION"],
  ])("labels an empty Search list honestly for %#", async (sourceSweep, expected) => {
    const { SearchPanel } = await loadBrowser();
    const html = renderToStaticMarkup(
      <SearchPanel jobs={[]} filterJobs={[]} sourceSweep={sourceSweep} />
    );

    expect(html).toContain(expected);
    expect(html).not.toContain("FOUND · NEEDS TRIAGE");
  });

  it("keeps the triage eyebrow only when jobs are actually present", async () => {
    const { SearchPanel } = await loadBrowser();
    const html = renderToStaticMarkup(
      <SearchPanel jobs={JOBS} filterJobs={JOBS} sourceSweep={{ status: "complete" }} />
    );

    expect(html).toContain("FOUND · NEEDS TRIAGE");
  });

  it("explains the first-search handoff in plain English for every initial state", async () => {
    const { SearchPanel } = await loadBrowser();
    const renderHandoff = (sourceSweep, jobs = [], selection = jobs.map((job) => job.id)) =>
      renderToStaticMarkup(
        <SearchPanel
          jobs={jobs}
          filterJobs={jobs}
          selection={selection}
          sourceSweep={sourceSweep}
          onboardingHandoff
        />
      );

    expect(renderHandoff({ status: "running" })).toContain(
      "You&#x27;re all set. Your first job search is running now. Matches will appear here as they&#x27;re found."
    );
    expect(renderHandoff({ status: "running" })).toContain("Search is running");
    expect(renderHandoff({ status: "idle" })).toContain(
      "You&#x27;re all set. Start your first job search with Search for jobs above."
    );
    expect(
      renderHandoff({ status: "complete" }, [
        { id: "acme", company: "Acme", role: "Staff Engineer", fit: 88 },
      ])
    ).toContain(
      "Your first match is ready. Review the selected job, then use Apply to 1 job on the right."
    );
    expect(
      renderHandoff({
        status: "error",
        lanes: {
          deterministic: { label: "Configured sources", status: "failed", error: "Timed out" },
        },
      })
    ).toContain("Your setup is saved. The first search needs another try. Use Retry search above.");
  });

  it("surfaces hidden first-search results and an immediate show-matches action", async () => {
    const { SearchPanel } = await loadBrowser();
    const onClearFilters = vi.fn();
    const tree = SearchPanel({
      jobs: [],
      filterJobs: JOBS,
      selection: JOBS.map((job) => job.id),
      sourceSweep: { status: "complete", summary: "2 matches ready · 0 new" },
      onboardingHandoff: true,
      onClearFilters,
    });
    const showMatches = findElement(
      tree,
      (node) => node.type === "button" && textOf(node) === "Show matches"
    );

    expect(renderToStaticMarkup(tree)).toContain(
      "Your first 2 matches are ready. Review the selected jobs, then use Apply to 2 jobs on the right."
    );
    expect(showMatches).toBeTruthy();
    showMatches.props.onClick();
    expect(onClearFilters).toHaveBeenCalledOnce();
  });

  it("uses the selected cart count for the onboarding Apply label", async () => {
    const { SearchPanel } = await loadBrowser();
    const jobs = Array.from({ length: 5 }, (_, index) => ({
      id: `job-${index + 1}`,
      company: `Company ${index + 1}`,
      role: "Staff Engineer",
      fit: 85,
    }));
    const html = renderToStaticMarkup(
      <SearchPanel
        jobs={jobs}
        filterJobs={jobs}
        selection={jobs.slice(0, 4).map((job) => job.id)}
        sourceSweep={{ status: "complete", summary: "5 matches ready" }}
        onboardingHandoff
      />
    );

    expect(html).toContain("Your first 5 matches are ready.");
    expect(html).toContain("Apply to 4 jobs");
    expect(html).not.toContain("Apply to 5 jobs");
  });

  it("offers a real clear action when filters hide existing jobs", async () => {
    const { SearchPanel } = await loadBrowser();
    const onClearFilters = vi.fn();
    const tree = SearchPanel({
      jobs: [],
      filterJobs: JOBS,
      query: "no matching company",
      filters: { fit80: true, stage: "staff", source: "lever" },
      sourceSweep: { status: "complete", summary: "0 new · 8 scanned" },
      onClearFilters,
    });
    const clearButton = findElement(
      tree,
      (node) => node.type === "button" && textOf(node) === "Clear filters"
    );

    expect(renderToStaticMarkup(tree)).toContain("No jobs match these filters.");
    expect(clearButton).toBeTruthy();
    clearButton.props.onClick();
    expect(onClearFilters).toHaveBeenCalledOnce();
  });

  it("keeps partial-search failure context and a clear-filters action together", async () => {
    const { SearchPanel } = await loadBrowser();
    const onClearFilters = vi.fn();
    const tree = SearchPanel({
      jobs: [],
      filterJobs: JOBS,
      filters: { fit80: true },
      sourceSweep: {
        status: "complete",
        summary: "2 search lanes finished · 1 lane needs retry",
        lanes: {
          deterministic: { label: "Configured sources", status: "succeeded" },
          aiWeb: {
            label: "AI web search",
            status: "failed",
            partial: true,
            error: "second query timed out",
          },
        },
      },
      onClearFilters,
    });
    const clearButton = findElement(
      tree,
      (node) => node.type === "button" && textOf(node) === "Clear filters"
    );
    const html = renderToStaticMarkup(tree);

    expect(html).toContain("Search didn&#x27;t finish. Review the error above, then retry.");
    expect(html).toContain("Jobs were found, but these filters hide them.");
    expect(clearButton).toBeTruthy();
    clearButton.props.onClick();
    expect(onClearFilters).toHaveBeenCalledOnce();
  });

  it("toggles the horizontal pipeline between funnel and list contracts", async () => {
    const { WorkspaceBrowser } = await loadBrowser();
    const funnel = renderToStaticMarkup(
      <WorkspaceBrowser {...baseProps({ activeTab: "pipeline", pipelineView: "funnel" })} />
    );
    const list = renderToStaticMarkup(
      <WorkspaceBrowser {...baseProps({ activeTab: "pipeline", pipelineView: "list" })} />
    );

    expect(funnel).toContain("29 applications · where they stand");
    expect(funnel).toContain("Going stale");
    expect(funnel).toContain("List view");
    expect(funnel).toContain('aria-label="Applied: 29"');
    expect(list).toContain("Funnel view");
    expect(list).toContain("E Corp");
  });

  it("uses singular application copy for one tracked role", async () => {
    const { WorkspaceBrowser } = await loadBrowser();
    const html = renderToStaticMarkup(
      <WorkspaceBrowser
        {...baseProps({
          activeTab: "pipeline",
          pipelineView: "funnel",
          pipeline: { ...PIPELINE, applicationCount: 1 },
        })}
      />
    );

    expect(html).toContain("1 application · where it stands");
    expect(html).not.toContain("1 applications");
  });

  it("renders real Files, People, and Schedule data with handoff copy", async () => {
    const { WorkspaceBrowser } = await loadBrowser();
    const files = renderToStaticMarkup(
      <WorkspaceBrowser
        {...baseProps({
          activeTab: "files",
          files: [{ id: "f1", name: "Tyrell resume.pdf", meta: "built today", kind: "Resume" }],
        })}
      />
    );
    const people = renderToStaticMarkup(
      <WorkspaceBrowser
        {...baseProps({
          activeTab: "people",
          people: [
            {
              id: "p1",
              name: "William Bell",
              role: "Massive Dynamic · referral",
              needsTouch: true,
              next: "Aug 26",
            },
          ],
        })}
      />
    );
    const schedule = renderToStaticMarkup(
      <WorkspaceBrowser
        {...baseProps({
          activeTab: "schedule",
          schedule: [
            {
              day: "THURSDAY",
              items: [
                {
                  id: "s1",
                  time: "2:00 PM",
                  title: "Cyberdyne panel",
                  meta: "Onsite",
                  kind: "interview",
                  actionLabel: "Open prep",
                  export: {
                    googleUrl: "https://calendar.google.com/calendar/render?action=TEMPLATE",
                    outlookUrl:
                      "https://outlook.live.com/calendar/0/deeplink/compose?subject=Interview",
                    filename: "interview.ics",
                    ics: "BEGIN:VCALENDAR\r\nEND:VCALENDAR",
                  },
                },
              ],
            },
          ],
        })}
      />
    );

    expect(files).toContain("every claim in these traces to your evidence bank");
    expect(files).toContain("Tyrell resume.pdf");
    expect(people).toContain("people you&#x27;ve actually talked to");
    expect(people).toContain("Needs a touch · 1");
    expect(schedule).toContain("Download file");
    expect(schedule).not.toContain(".ics");
    expect(schedule).toContain("Nothing stays in sync.");
  });

  it("disables calendar exports when nothing is scheduled", async () => {
    const { WorkspaceBrowser } = await loadBrowser();
    const html = renderToStaticMarkup(
      <WorkspaceBrowser {...baseProps({ activeTab: "schedule", schedule: [] })} />
    );

    expect(html).toContain("Calendar exports appear when something is scheduled.");
    expect(html.match(/disabled=""/g)).toHaveLength(3);
  });

  it("keeps selected jobs in the cart when search filters hide their rows", async () => {
    const { WorkspaceBrowser } = await loadBrowser();
    const html = renderToStaticMarkup(
      <WorkspaceBrowser
        {...baseProps({
          jobs: [JOBS[0]],
          cartJobs: JOBS,
          selection: ["aperture"],
        })}
      />
    );

    expect(html).toContain("Aperture Science");
    expect(html).toContain("comp pending");
  });

  it("personalizes empty artifact copy with the configured agent name", async () => {
    const { WorkspaceBrowser } = await loadBrowser();
    const html = renderToStaticMarkup(
      <WorkspaceBrowser {...baseProps({ activeTab: "files", files: [], agentName: "Scout" })} />
    );

    expect(html).toContain("Artifacts appear here as Scout builds them.");
    expect(html).not.toContain("Paul builds them");
  });

  it("only calls an all-sourced cart dismissal Dismiss all", async () => {
    const { WorkspaceBrowser } = await loadBrowser();
    const sourced = renderToStaticMarkup(
      <WorkspaceBrowser
        {...baseProps({
          jobs: [{ ...JOBS[0], source: "sourced" }],
          cartJobs: [{ ...JOBS[0], source: "sourced" }],
          selection: [JOBS[0].id],
        })}
      />
    );
    const mixed = renderToStaticMarkup(
      <WorkspaceBrowser
        {...baseProps({
          jobs: [{ ...JOBS[0], source: "application" }],
          cartJobs: [{ ...JOBS[0], source: "application" }],
          selection: [JOBS[0].id],
        })}
      />
    );

    expect(sourced).toContain("Dismiss all");
    expect(mixed).toContain("Clear selection");
    expect(mixed).not.toContain("Dismiss all");
  });

  it("renders stage, source, and posted filters as controlled accessible selects", async () => {
    const { WorkspaceBrowser } = await loadBrowser();
    const html = renderToStaticMarkup(
      <WorkspaceBrowser
        {...baseProps({
          jobs: [
            { ...JOBS[0], sourceLabel: "Greenhouse", postedAt: "2026-08-22T12:00:00Z" },
            { ...JOBS[1], sourceLabel: "Lever", postedAt: "2026-08-20T12:00:00Z" },
          ],
          filters: {
            fit80: false,
            comp: true,
            remote: false,
            stage: "staff",
            source: "greenhouse",
            posted: "7d",
            files: "Evidence",
            people: "all",
          },
        })}
      />
    );

    expect(html).toContain('aria-pressed="false">Fit 80+');
    expect(html).toContain('aria-pressed="true">Comp ✓');
    expect(html).toContain('aria-label="Filter by stage"');
    expect(html).toContain('aria-label="Filter by source"');
    expect(html).toContain('aria-label="Filter by posted date"');
    expect(html).toContain('<option value="greenhouse" selected="">Greenhouse</option>');
    expect(html).toContain('<option value="7d" selected="">Posted · 7 days</option>');
    expect(html).not.toContain('disabled=""');
  });

  it("keeps unfiltered stage and source domains available when crossed filters return no rows", async () => {
    const { WorkspaceBrowser } = await loadBrowser();
    const html = renderToStaticMarkup(
      <WorkspaceBrowser
        {...baseProps({
          jobs: [],
          cartJobs: [
            { ...JOBS[0], stage: "New", sourceLabel: "Greenhouse" },
            { ...JOBS[1], stage: "Reviewed", sourceLabel: "Lever" },
          ],
          selection: [],
          filters: {
            stage: "new",
            source: "lever",
          },
        })}
      />
    );

    expect(html).toContain("No jobs match these filters.");
    expect(html).toContain("Clear filters");
    expect(html).toContain('<option value="new" selected="">New</option>');
    expect(html).toContain('<option value="reviewed">Reviewed</option>');
    expect(html).toContain('<option value="greenhouse">Greenhouse</option>');
    expect(html).toContain('<option value="lever" selected="">Lever</option>');
  });

  it("consumes the final handoff palette from the shared foundation", () => {
    const css = readFileSync(
      fileURLToPath(new URL("./workspace-browser.css", import.meta.url)),
      "utf8"
    );

    expect(css).not.toMatch(/--cf-(?:bg|ink|lime|lavender|red)\s*:/);
    expect(css).toContain("var(--ink)");
    expect(css).toContain("var(--lime)");
    expect(css).toContain("var(--lilac)");
    expect(css).toContain("var(--red)");
    expect(css).toContain("grid-template-columns: 46px minmax(0, 1fr) 280px");
  });
});
