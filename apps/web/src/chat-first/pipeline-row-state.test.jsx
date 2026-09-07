import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

async function loadBrowser() {
  return import("./WorkspaceBrowser.jsx");
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

const PIPELINE_JOBS = [
  { id: "on-track", company: "Tyrell Corp", role: "Staff Engineer", stage: "Screen", fit: 82 },
  {
    id: "gone-quiet",
    company: "Aperture Science",
    role: "Principal Engineer",
    stage: "Applied",
    fit: 74,
    stale: true,
  },
  {
    id: "no-response",
    company: "Initech",
    role: "Lead Engineer",
    stage: "Applied",
    fit: 68,
    ghosted: true,
  },
];

describe("pipeline list row state", () => {
  it("marks stale and ghosted rows muted with a short label, and leaves healthy rows alone", async () => {
    const { PipelinePanel } = await loadBrowser();
    const html = renderToStaticMarkup(
      <PipelinePanel pipeline={{ jobs: PIPELINE_JOBS }} view="list" />
    );

    expect(html).toContain("Stale");
    expect(html).toContain("Ghosted");
    expect(html).toContain("cf-pipeline__job--muted");

    const rowFor = (needle) => {
      const start = html.indexOf(needle);
      const rowStart = html.lastIndexOf("<button", start);
      const rowEnd = html.indexOf("</button>", start);
      return html.slice(rowStart, rowEnd);
    };

    expect(rowFor("Tyrell Corp")).not.toContain("cf-pipeline__job--muted");
    expect(rowFor("Aperture Science")).toContain("cf-pipeline__job--muted");
    expect(rowFor("Initech")).toContain("cf-pipeline__job--muted");
  });

  it("does not flag a row that is neither stale nor ghosted", async () => {
    const { PipelinePanel } = await loadBrowser();
    const html = renderToStaticMarkup(
      <PipelinePanel pipeline={{ jobs: [PIPELINE_JOBS[0]] }} view="list" />
    );

    expect(html).not.toContain("Stale");
    expect(html).not.toContain("Ghosted");
    expect(html).not.toContain("cf-pipeline__job--muted");
  });

  it("shows a tilde-prefixed fit for a triage guess and a bare number once evaluated", async () => {
    const { PipelinePanel, SearchJobRow } = await loadBrowser();
    const listHtml = renderToStaticMarkup(
      <PipelinePanel
        pipeline={{
          jobs: [
            { id: "guess", company: "Tyrell Corp", role: "Staff", fit: 72, fitBasis: "triage" },
            { id: "real", company: "Aperture", role: "Principal", fit: 72, fitBasis: "evaluated" },
          ],
        }}
        view="list"
      />
    );
    expect(listHtml).toContain(">~72<");
    expect(listHtml).toContain(">72<");

    const triageRow = renderToStaticMarkup(
      <SearchJobRow
        job={{ id: "guess", company: "Tyrell Corp", role: "Staff", fit: 72, fitBasis: "triage" }}
        selected={false}
      />
    );
    const evaluatedRow = renderToStaticMarkup(
      <SearchJobRow
        job={{ id: "real", company: "Aperture", role: "Principal", fit: 72, fitBasis: "evaluated" }}
        selected={false}
      />
    );
    expect(triageRow).toContain("Fit ~72");
    expect(evaluatedRow).toContain("Fit 72");
    expect(evaluatedRow).not.toContain("Fit ~72");
  });

  it("offers a sort picker on the pipeline list that reorders the rows by fit", async () => {
    const { PipelinePanel } = await loadBrowser();
    const unsortedByFit = [
      { id: "initech", company: "Initech", role: "Lead Engineer", stage: "Applied", fit: 68 },
      { id: "tyrell", company: "Tyrell Corp", role: "Staff Engineer", stage: "Screen", fit: 82 },
      {
        id: "aperture",
        company: "Aperture Science",
        role: "Principal Engineer",
        stage: "Applied",
        fit: 74,
      },
    ];
    const onFilter = vi.fn();
    const panel = PipelinePanel({
      pipeline: { jobs: unsortedByFit },
      view: "list",
      filters: { sort: "fit" },
      onFilter,
    });

    const select = findElement(panel, (node) => node.type === "select");
    expect(select.props["aria-label"]).toBe("Sort jobs");
    expect(select.props.value).toBe("fit");
    select.props.onChange({ target: { value: "updated" } });
    expect(onFilter).toHaveBeenCalledWith("sort", "updated");

    const html = renderToStaticMarkup(
      <PipelinePanel pipeline={{ jobs: unsortedByFit }} view="list" filters={{ sort: "fit" }} />
    );
    expect(html).toContain('aria-label="Sort jobs"');
    const order = ["Tyrell Corp", "Aperture Science", "Initech"].map((name) => html.indexOf(name));
    expect(order).toEqual([...order].sort((a, b) => a - b));
  });

  it("offers a sort picker on the search tab filter bar", async () => {
    const { SearchPanel } = await loadBrowser();
    const onFilter = vi.fn();
    const panel = SearchPanel({
      jobs: [
        { id: "a", company: "Tyrell Corp", role: "Staff", fit: 60 },
        { id: "b", company: "Aperture", role: "Principal", fit: 90 },
      ],
      sourceSweep: { status: "idle" },
      filters: { sort: "all" },
      onFilter,
    });

    const select = findElement(
      panel,
      (node) => node.type === "select" && node.props["aria-label"] === "Sort jobs"
    );
    expect(select).not.toBeNull();
    select.props.onChange({ target: { value: "fit" } });
    expect(onFilter).toHaveBeenCalledWith("sort", "fit");
  });
});
