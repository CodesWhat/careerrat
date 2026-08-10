// apps/web/src/network/NetworkPage.test.jsx — covers PeopleList's empty
// branch (ISSUE-016): zero contacts must render a click-through CTA that
// focuses the docked AskBar, not a dead sentence; a non-empty list must never
// render that CTA. PeopleList takes no hooks of its own, so it's rendered
// directly via renderToStaticMarkup with no react/router mocking needed —
// same renderToStaticMarkup mechanism LibraryPage.test.jsx uses, just without
// the hook harness this component doesn't require.
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { PeopleList } from "./NetworkPage.jsx";

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
