import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";

import { InlineAlert, Toast } from "./Toast.jsx";

function findElement(node, predicate) {
  if (Array.isArray(node)) {
    for (const child of node) {
      const match = findElement(child, predicate);
      if (match) return match;
    }
    return null;
  }
  if (!node || typeof node !== "object") return null;
  if (predicate(node)) return node;
  // InlineAlertAction is a nested function component (not yet resolved to
  // host elements) when InlineAlert is called as a plain function — invoke
  // it to walk into what it renders.
  if (typeof node.type === "function") {
    return findElement(node.type(node.props), predicate);
  }
  return findElement(node.props?.children, predicate);
}

describe("InlineAlert — backward compat", () => {
  it("renders a bare message exactly as before, with no action or detail markup", () => {
    const html = renderToStaticMarkup(<InlineAlert message="Plain error" />);

    expect(html).toContain('role="alert"');
    expect(html).toContain("Plain error");
    expect(html).not.toContain("<a");
    expect(html).not.toContain("<details");
  });

  it("returns null when message is falsy", () => {
    expect(InlineAlert({ message: "" })).toBeNull();
    expect(InlineAlert({ message: null })).toBeNull();
  });
});

describe("InlineAlert — action: link", () => {
  it("renders an in-app link with the label and href", () => {
    const html = renderToStaticMarkup(
      <MemoryRouter>
        <InlineAlert message="No AI key is connected yet." action={{ label: "Open Settings", to: "/settings" }} />
      </MemoryRouter>
    );

    expect(html).toContain('href="/settings"');
    expect(html).toContain("Open Settings");
    expect(html).toContain("inline-alert__action");
  });
});

describe("InlineAlert — action: retry", () => {
  it("renders a button with the label and wires onRetry through the click handler", () => {
    const onRetry = vi.fn();
    const tree = InlineAlert({
      message: "Something went wrong on the server. Try again in a moment.",
      action: { label: "Try again", retry: true, onRetry },
    });

    const button = findElement(tree, (node) => node.type === "button");
    expect(button).toBeDefined();
    expect(button.props.children).toBe("Try again");

    button.props.onClick();
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it("does not throw when a retry action has no onRetry supplied", () => {
    const tree = InlineAlert({
      message: "Something went wrong on the server. Try again in a moment.",
      action: { label: "Try again", retry: true },
    });
    const button = findElement(tree, (node) => node.type === "button");
    expect(button).toBeDefined();
    // No onRetry was supplied, so onClick is left unset (button.props.onClick
    // is action.onRetry, i.e. undefined) — clicking it in the real DOM is a
    // no-op rather than a throw, since React simply omits an unset handler.
    expect(() => {
      if (button.props.onClick) button.props.onClick();
    }).not.toThrow();
  });
});

describe("InlineAlert — detail", () => {
  it("renders detail inside a collapsed <details> element, not as top-level alert text", () => {
    const html = renderToStaticMarkup(
      <InlineAlert message="Something went wrong." detail="raw server string: db locked" />
    );

    expect(html).toContain("<details");
    expect(html).toContain("Technical details");
    expect(html).toContain("raw server string: db locked");

    const detailsIndex = html.indexOf("<details");
    const messageIndex = html.indexOf("Something went wrong.");
    expect(messageIndex).toBeLessThan(detailsIndex);
    // The detail text itself should only appear once, inside <details>, not
    // duplicated as a top-level sibling before it.
    expect(html.indexOf("raw server string: db locked")).toBeGreaterThan(detailsIndex);
  });
});

describe("Toast — smoke test (untouched export)", () => {
  it("still renders a message", () => {
    const html = renderToStaticMarkup(<Toast message="hi" />);
    expect(html).toContain("hi");
    expect(html).toContain('role="status"');
  });
});
