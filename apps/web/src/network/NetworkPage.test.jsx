// apps/web/src/network/NetworkPage.test.jsx — covers PeopleList's empty
// branch (ISSUE-016): zero contacts must render a click-through CTA that
// focuses the docked AskBar, not a dead sentence; a non-empty list must never
// render that CTA. PeopleList takes no hooks of its own, so it's rendered
// directly via renderToStaticMarkup with no react/router mocking needed —
// same renderToStaticMarkup mechanism LibraryPage.test.jsx uses, just without
// the hook harness this component doesn't require.
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { filterPeople, NetworkDrawer, PeopleList, SourcingSection } from "./NetworkPage.jsx";

const SAMPLE_PERSON = {
  id: "acme::jane-doe",
  name: "Jane Doe",
  type: "Recruiter",
  company: "Acme Corp",
  domain: "acme.example",
  warmth: 3,
  latestAt: "2026-08-01T00:00:00.000Z",
  nextTouch: "When specific",
  state: "safe",
  stateLabel: "Warm path",
};

describe("PeopleList", () => {
  it("renders a click-through CTA in the empty state instead of a dead sentence", () => {
    const html = renderToStaticMarkup(<PeopleList onOpen={() => {}} people={[]} />);

    expect(html).toContain("network__empty");
    expect(html).toContain("Paste a message to capture a contact");
    // The empty-state affordance is a real button, not inert text.
    expect(html).toMatch(/<button[^>]*>Paste a message to capture a contact<\/button>/);
  });

  it("omits the empty-state CTA once people are present", () => {
    const html = renderToStaticMarkup(<PeopleList onOpen={() => {}} people={[SAMPLE_PERSON]} />);

    expect(html).not.toContain("network__empty");
    expect(html).not.toContain("Paste a message to capture a contact");
    expect(html).toContain("Jane Doe");
  });
});

describe("Network filtering", () => {
  const people = [
    SAMPLE_PERSON,
    {
      ...SAMPLE_PERSON,
      id: "globex::alex-smith",
      name: "Alex Smith",
      company: "Globex Corporation",
      type: "Hiring manager",
      state: "caution",
      nextTouch: "Follow up today",
    },
  ];

  it("searches names, companies, roles, and contact types", () => {
    expect(filterPeople(people, { query: "globex", state: "all" })).toEqual([people[1]]);
    expect(filterPeople(people, { query: "hiring manager", state: "all" })).toEqual([people[1]]);
    expect(filterPeople(people, { query: "jane", state: "all" })).toEqual([people[0]]);
  });

  it("filters by relationship state and actionable next touch", () => {
    expect(filterPeople(people, { query: "", state: "caution" })).toEqual([people[1]]);
    expect(filterPeople(people, { query: "", state: "needs-touch" })).toEqual([people[1]]);
  });
});

describe("Network relationship actions", () => {
  it("renders real approve and reject controls for review leads", () => {
    const html = renderToStaticMarkup(
      <SourcingSection
        busyLeadId={null}
        leads={[
          {
            id: "lead-1",
            name: "Alex Smith",
            company: "Globex",
            title: "Talent partner",
            platform: "linkedin",
            note: "Likely recruiter for this role.",
          },
        ]}
        onDecide={() => {}}
        targets={[]}
      />
    );

    expect(html).toContain("Approve lead");
    expect(html).toContain("Reject lead");
    expect(html).toContain('type="button"');
  });

  it("links relationship context to its owning job and renders structured history", () => {
    const html = renderToStaticMarkup(
      <NetworkDrawer
        card={{
          ...SAMPLE_PERSON,
          applicationId: "app-123",
          history: [
            {
              id: "message-1",
              at: "2026-08-10T12:00:00.000Z",
              direction: "inbound",
              label: "Email from Jane Doe",
              summary: "Invited to a recruiter screen.",
            },
          ],
          companyRecord: {
            company: "Acme Corp",
            applicationId: "app-123",
            reuseTitle: "Safe reuse",
            reuseBody: "Use when specific.",
            reuseScope: "Same-company routing",
            nextTouch: "When specific",
            notes: [],
          },
        }}
        onClose={() => {}}
      />
    );

    expect(html).toContain('aria-modal="true"');
    expect(html).toContain('tabindex="-1"');
    expect(html).toContain('href="/app/jobs?open=app-123"');
    expect(html).toContain("Communication history");
    expect(html).toContain("Invited to a recruiter screen.");
  });
});
