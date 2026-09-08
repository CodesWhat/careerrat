import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { mapActivityItems } from "./chat-first-app-controller.js";
import { buildChatFirstView } from "./chat-first-model.js";
import { PeoplePanel } from "./WorkspaceBrowser.jsx";
import { TopBar } from "./workspace-shell.jsx";

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

function findAll(node, predicate, out = []) {
  if (!node || typeof node !== "object") return out;
  if (Array.isArray(node)) {
    for (const child of node) findAll(child, predicate, out);
    return out;
  }
  if (predicate(node)) out.push(node);
  findAll(node.props?.children, predicate, out);
  return out;
}

function hasClass(node, className) {
  return String(node.props?.className || "")
    .split(/\s+/)
    .includes(className);
}

const runtime = {};

describe("flattenPeople sourcing targets and lead platform", () => {
  it("carries relationship-sourcing targets through to the People browser view", () => {
    const view = buildChatFirstView(
      {
        network: {
          companies: [],
          sourcing: {
            targets: [{ id: "t1", company: "Massive Dynamic", role: "Staff Engineer", fit: 82 }],
          },
        },
      },
      runtime
    );

    expect(view.browser.peopleTargets).toEqual([
      {
        id: "t1",
        company: "Massive Dynamic",
        role: "Staff Engineer",
        fit: 82,
        label: "Search contact path",
      },
    ]);
  });

  it("returns no targets when none are sourced", () => {
    const view = buildChatFirstView({ network: { companies: [] } }, runtime);
    expect(view.browser.peopleTargets).toEqual([]);
  });

  it("keeps a lead's source platform on the flattened contact", () => {
    const view = buildChatFirstView(
      {
        network: {
          companies: [
            {
              applicationId: "app-1",
              company: "E Corp",
              contacts: [{ id: "c1", name: "Angela Moss", platform: "linkedin" }],
            },
          ],
        },
      },
      runtime
    );

    expect(view.browser.people[0].platform).toBe("LinkedIn");
  });

  it("leaves platform blank when the contact has none", () => {
    const view = buildChatFirstView(
      {
        network: {
          companies: [
            {
              applicationId: "app-1",
              company: "E Corp",
              contacts: [{ id: "c1", name: "Angela Moss" }],
            },
          ],
        },
      },
      runtime
    );

    expect(view.browser.people[0].platform).toBe("");
  });
});

describe("PeoplePanel sourcing targets and platform rendering", () => {
  it("renders a 'Worth reaching out to' group with company, role, and fit", () => {
    const html = renderToStaticMarkup(
      <PeoplePanel
        people={[{ id: "p1", name: "Angela Moss", role: "Recruiter" }]}
        targets={[{ id: "t1", company: "Massive Dynamic", role: "Staff Engineer", fit: 82 }]}
      />
    );

    expect(html).toContain("Worth reaching out to");
    expect(html).toContain("Massive Dynamic");
    expect(html).toContain("Staff Engineer");
    expect(html).toContain("Fit 82");
  });

  it("omits the targets group entirely when there are none", () => {
    const html = renderToStaticMarkup(
      <PeoplePanel people={[{ id: "p1", name: "Angela Moss", role: "Recruiter" }]} targets={[]} />
    );

    expect(html).not.toContain("Worth reaching out to");
  });

  it("shows the empty-contacts state and the targets group together when there are no real contacts", () => {
    const html = renderToStaticMarkup(
      <PeoplePanel
        people={[]}
        targets={[{ id: "t1", company: "Massive Dynamic", role: "Staff Engineer", fit: 82 }]}
      />
    );

    expect(html).toContain("No real conversations are tracked yet.");
    expect(html).toContain("Worth reaching out to");
    expect(html).toContain("Massive Dynamic");
  });

  it("keeps the footnote and empty-state copy unchanged", () => {
    const html = renderToStaticMarkup(<PeoplePanel people={[]} targets={[]} />);

    expect(html).toContain("No real conversations are tracked yet.");
    expect(html).toContain(
      "people you&#x27;ve actually talked to. Application-portal noise is excluded."
    );
  });

  it("renders a platform label only when the contact carries one", () => {
    const withPlatform = renderToStaticMarkup(
      <PeoplePanel
        people={[{ id: "p1", name: "Angela Moss", role: "Recruiter", platform: "LinkedIn" }]}
      />
    );
    const withoutPlatform = renderToStaticMarkup(
      <PeoplePanel people={[{ id: "p1", name: "Angela Moss", role: "Recruiter" }]} />
    );

    expect(withPlatform).toContain("cf-person__platform");
    expect(withPlatform).toContain("LinkedIn");
    expect(withoutPlatform).not.toContain("cf-person__platform");
  });
});

describe("activity pulse rows carry appId through to the top bar", () => {
  it("keeps appId on mapped activity items", () => {
    expect(
      mapActivityItems([
        { id: "a1", relTime: "8:14", title: "Sweep complete", appId: "app-1" },
        { id: "a2", relTime: "8:15", title: "Note added" },
      ])
    ).toEqual([
      {
        id: "a1",
        time: "8:14",
        label: "Sweep complete",
        mark: "✓",
        tone: "done",
        appId: "app-1",
      },
      {
        id: "a2",
        time: "8:15",
        label: "Note added",
        mark: "✓",
        tone: "done",
        appId: "",
      },
    ]);
  });

  it("renders an activity row with an appId as a clickable button that opens that job", () => {
    const onOpenJob = vi.fn();
    const onToggleActivity = vi.fn();
    const tree = TopBar({
      agentName: "Mina",
      activityOpen: true,
      onToggleActivity,
      onOpenJob,
      activityItems: [
        { id: "sweep", time: "7:02", mark: "✓", label: "Sweep complete", appId: "app-1" },
      ],
    });

    const button = findElement(
      tree,
      (node) => node.type === "button" && hasClass(node, "chat-first-activity__row")
    );
    expect(button).toBeTruthy();
    expect(textOf(button)).toContain("Sweep complete");
    button.props.onClick();
    expect(onOpenJob).toHaveBeenCalledWith("app-1");
    expect(onToggleActivity).toHaveBeenCalledOnce();
  });

  it("renders an activity row without an appId as an inert row, not a button", () => {
    const onOpenJob = vi.fn();
    const tree = TopBar({
      agentName: "Mina",
      activityOpen: true,
      onToggleActivity: () => {},
      onOpenJob,
      activityItems: [{ id: "note", time: "7:05", mark: "✓", label: "Note added" }],
    });

    const rows = findAll(
      tree,
      (node) =>
        (node.type === "div" || node.type === "button") &&
        hasClass(node, "chat-first-activity__row")
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].type).toBe("div");
    expect(textOf(rows[0])).toContain("Note added");
  });
});
