import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

async function loadBrowser() {
  return import("./WorkspaceBrowser.jsx");
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
      (child) => child?.type === "button" && child.props.children === "source health"
    );

    sourceHealth.props.onClick();
    expect(onOpenSourceHealth).toHaveBeenCalledOnce();
    expect(renderToStaticMarkup(tree)).not.toMatch(/\/onboard|write-config|\/jobs/);
  });

  it("uses the exact full-width cart action geometry from the handoff", () => {
    const css = readFileSync(
      fileURLToPath(new URL("./workspace-browser.css", import.meta.url)),
      "utf8"
    );

    expect(css).toMatch(
      /\.cf-cart__actions \.cf-button--ink,[^{]*\.cf-cart__actions \.cf-button--lime\s*\{[^}]*padding:\s*9px[^}]*font-size:\s*13px/s
    );
    expect(css).toMatch(
      /\.cf-cart__actions \.cf-button--outline\s*\{[^}]*padding:\s*8px[^}]*font-size:\s*13px/s
    );
    expect(css).toMatch(
      /\.cf-cart__actions \.cf-button--ghost\s*\{[^}]*padding:\s*6px[^}]*font-size:\s*12px/s
    );
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
    expect(html).toContain("Draft, then gate each apply");
    expect(html).toContain("each submit gates back to you in Today");
    expect(html).toContain('type="checkbox"');
    expect(html).toContain('checked=""');
  });

  it("dispatches search and cart actions with the externally-owned ids", async () => {
    const { SearchPanel, SelectionCart } = await loadBrowser();
    const onToggleSelection = vi.fn();
    const onRunSweep = vi.fn();
    const onFilter = vi.fn();
    const onChatAbout = vi.fn();
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
      onChatAbout,
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

    const filterBar = searchButtons[2].type(searchButtons[2].props);
    const sourceControl = filterBar.props.children.find(
      (child) => child?.props?.label === "Source"
    );
    const sourceSelect = sourceControl.type(sourceControl.props);
    sourceSelect.props.onChange({ target: { value: "greenhouse" } });
    expect(onFilter).toHaveBeenCalledWith("source", "greenhouse");

    const actions = cart.props.children[2];
    actions.props.children[1].props.onClick();
    actions.props.children[2].props.onClick();
    expect(onDraftAndApply).toHaveBeenCalledWith(["tyrell", "aperture"]);
    expect(onChatAbout).toHaveBeenCalledWith(["tyrell", "aperture"]);
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

  it("renders sweep progress from run state and never invents a timer", async () => {
    const { WorkspaceBrowser } = await loadBrowser();
    const html = renderToStaticMarkup(
      <WorkspaceBrowser
        {...baseProps({
          sourceSweep: {
            status: "running",
            providers: ["Greenhouse", "Lever", "Ashby", "HN"],
            detail: "reading postings against your rules",
          },
        })}
      />
    );
    const source = readFileSync(
      fileURLToPath(new URL("./WorkspaceBrowser.jsx", import.meta.url)),
      "utf8"
    );

    expect(html).toContain("Sweeping Greenhouse · Lever · Ashby · HN…");
    expect(html).toContain("reading postings against your rules");
    expect(html).not.toContain("Sweep boards now");
    expect(source).not.toContain("setTimeout");
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

    expect(html).toContain("No jobs need triage right now.");
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
