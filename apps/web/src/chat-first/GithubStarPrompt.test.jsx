import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import * as githubStarPrompt from "./GithubStarPrompt.jsx";
import {
  GITHUB_STAR_URL,
  GithubStarPrompt,
  githubStarPromptWasHandled,
  markGithubStarPromptHandled,
} from "./GithubStarPrompt.jsx";

function markup(node) {
  return renderToStaticMarkup(node);
}

function memoryStorage(initial = {}) {
  const values = new Map(Object.entries(initial));
  return {
    getItem: vi.fn((key) => values.get(key) ?? null),
    setItem: vi.fn((key, value) => values.set(key, value)),
  };
}

function visit(node, callback) {
  if (!node || typeof node !== "object") return;
  if (Array.isArray(node)) {
    for (const child of node) visit(child, callback);
    return;
  }
  if (typeof node.type === "function") {
    visit(node.type(node.props), callback);
    return;
  }
  callback(node);
  visit(node.props?.children, callback);
}

describe("GitHub star prompt", () => {
  it("renders a one-time, non-modal GitHub action only when visible", () => {
    const onDismiss = vi.fn();
    const tree = <GithubStarPrompt visible onDismiss={onDismiss} />;
    const html = markup(tree);

    expect(html).toContain('role="dialog"');
    expect(html).not.toContain('aria-modal="true"');
    expect(html).toContain("CareerRat helping?");
    expect(html).toContain("A GitHub star helps other job seekers find it.");
    expect(html).toContain('data-icon="star"');
    expect(html).toContain(`href="${GITHUB_STAR_URL}"`);
    expect(html).toContain('target="_blank"');
    expect(html).toContain("Star on GitHub");
    expect(html).toContain("Not now");

    const controls = [];
    visit(tree, (node) => {
      if (node.type === "a" || node.type === "button") controls.push(node);
    });
    controls.find((node) => node.type === "a").props.onClick();
    controls.find((node) => node.type === "button").props.onClick();
    expect(onDismiss).toHaveBeenCalledTimes(2);

    expect(markup(<GithubStarPrompt visible={false} />)).toBe("");
  });

  it("persists one handled marker and fails closed when storage is unavailable", () => {
    const storage = memoryStorage();

    expect(githubStarPromptWasHandled(storage)).toBe(false);
    markGithubStarPromptHandled(storage);
    expect(githubStarPromptWasHandled(storage)).toBe(true);
    expect(storage.setItem).toHaveBeenCalledOnce();

    const unavailable = {
      getItem: vi.fn(() => {
        throw new Error("storage unavailable");
      }),
      setItem: vi.fn(() => {
        throw new Error("storage unavailable");
      }),
    };
    expect(githubStarPromptWasHandled(unavailable)).toBe(true);
    expect(() => markGithubStarPromptHandled(unavailable)).not.toThrow();
  });

  it("fails closed when the browser blocks access to local storage itself", () => {
    const original = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      get() {
        throw new Error("storage access blocked");
      },
    });
    try {
      expect(githubStarPromptWasHandled()).toBe(true);
      expect(() => markGithubStarPromptHandled()).not.toThrow();
    } finally {
      if (original) Object.defineProperty(globalThis, "localStorage", original);
      else delete globalThis.localStorage;
    }
  });

  it("waits for a completed search with real matches in the desktop app", () => {
    const shouldOffer = githubStarPrompt.shouldOfferGithubStarPrompt;

    expect(
      shouldOffer({ desktop: true, handled: false, searchStatus: "complete", matchCount: 3 })
    ).toBe(true);
    expect(
      shouldOffer({ desktop: false, handled: false, searchStatus: "complete", matchCount: 3 })
    ).toBe(false);
    expect(
      shouldOffer({ desktop: true, handled: true, searchStatus: "complete", matchCount: 3 })
    ).toBe(false);
    expect(
      shouldOffer({ desktop: true, handled: false, searchStatus: "running", matchCount: 3 })
    ).toBe(false);
    expect(
      shouldOffer({ desktop: true, handled: false, searchStatus: "complete", matchCount: 0 })
    ).toBe(false);
  });

  it("waits through partial searches and offers after a later clean completion", () => {
    const shouldOffer = githubStarPrompt.shouldOfferGithubStarPrompt;
    const shared = {
      desktop: true,
      handled: false,
      searchStatus: "complete",
      matchCount: 3,
    };

    expect(
      shouldOffer({
        ...shared,
        searchLanes: {
          deterministic: { status: "succeeded" },
          aiWeb: { status: "failed", partial: true },
        },
        searchRetry: { aiPromptIds: ["prompt-2"] },
      })
    ).toBe(false);
    expect(
      shouldOffer({
        ...shared,
        searchLanes: {
          deterministic: { status: "succeeded" },
          aiWeb: { status: "succeeded" },
        },
        searchRetry: null,
      })
    ).toBe(true);
  });

  it("stays compact, above the workspace, and clear of the native title bar", () => {
    const css = readFileSync(fileURLToPath(new URL("./chat-first.css", import.meta.url)), "utf8");
    const promptRule = css.match(/\.chat-first-star-prompt\s*\{([^}]*)\}/)?.[1] || "";

    expect(promptRule).toMatch(/position:\s*fixed/);
    expect(promptRule).toMatch(/right:\s*24px/);
    expect(promptRule).toMatch(/bottom:\s*24px/);
    expect(promptRule).toMatch(/width:\s*min\(320px, calc\(100% - 48px\)\)/);
    expect(promptRule).toMatch(/z-index:\s*80/);
    expect(promptRule).toMatch(/background:\s*var\(--white\)/);
    expect(promptRule).toMatch(/box-shadow:\s*var\(--shadow-popover\)/);
  });
});
