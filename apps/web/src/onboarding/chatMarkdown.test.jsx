import { describe, expect, it } from "vitest";
import { renderChatMarkdown } from "./chatMarkdown.jsx";

function visit(node, predicate, found = []) {
  if (node == null || typeof node === "boolean") return found;
  if (Array.isArray(node)) {
    for (const child of node) visit(child, predicate, found);
    return found;
  }
  if (typeof node !== "object") return found;
  if (predicate(node)) found.push(node);
  visit(node.props?.children, predicate, found);
  return found;
}

function textOf(node) {
  if (node == null || typeof node === "boolean") return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textOf).join("");
  return textOf(node.props?.children);
}

describe("renderChatMarkdown", () => {
  it("renders discovery headings, tables, lists, and safe links without literal markup", () => {
    const tree = renderChatMarkdown(
      [
        "## Boards reviewed: 2",
        "",
        "| Board | Status |",
        "|---|---|",
        "| [FD Roles](https://fdroles.com/) | NEW |",
        "| Unsafe | [click](javascript:alert(1)) |",
        "",
        "- One rejected board",
      ].join("\n")
    );

    expect(textOf(visit(tree, (node) => node.type === "h3")[0])).toBe("Boards reviewed: 2");
    expect(visit(tree, (node) => node.type === "table")).toHaveLength(1);
    expect(visit(tree, (node) => node.type === "th").map(textOf)).toEqual(["Board", "Status"]);
    const links = visit(tree, (node) => node.type === "a");
    expect(links).toHaveLength(1);
    expect(links[0].props.href).toBe("https://fdroles.com/");
    expect(textOf(tree)).toContain("[click](javascript:alert(1))");
    expect(textOf(tree)).not.toContain("##");
    expect(visit(tree, (node) => node.type === "li").map(textOf)).toEqual(["One rejected board"]);
  });
});
