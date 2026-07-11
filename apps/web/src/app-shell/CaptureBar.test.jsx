import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";

vi.mock("../lib/api.js", () => ({
  ApiError: class ApiError extends Error {},
  createIntake: vi.fn(),
  uploadIntakeFile: vi.fn(),
}));

vi.mock("../lib/intake-events.js", () => ({
  emitIntakeChanged: vi.fn(),
}));

import { CaptureBar, CaptureBarView } from "./CaptureBar.jsx";

function renderCapture(node = <CaptureBar />) {
  return renderToStaticMarkup(<MemoryRouter>{node}</MemoryRouter>);
}

describe("CaptureBar", () => {
  it("starts as a bottom-right Roland launcher instead of a docked paste bar", () => {
    const html = renderCapture();

    expect(html).toContain('class="capture-assistant"');
    expect(html).toContain('class="capture-assistant__launcher"');
    expect(html).toContain('aria-label="Open Roland intake"');
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain('src="/assets/logo.png"');
    expect(html).toContain("Talk to Roland");
    expect(html).toContain("Drop jobs, emails, docs");
    expect(html).not.toContain("Ask Roland");
    expect(html).not.toContain("Paste intake");
    expect(html).not.toContain('class="capture-bar__row"');
    expect(html).not.toContain("Paste a job posting, recruiter email, status update");
  });

  it("uses a clean composer header and a real footer upload control", () => {
    const html = renderCapture(<CaptureBarView initiallyOpen />);

    expect(html).toContain('role="dialog"');
    expect(html).not.toContain("Drop jobs, emails, updates, docs, or links.");
    expect(html).toContain('type="file"');
    expect(html).toContain('aria-label="Attach a file to Roland"');
    expect(html).toContain('class="capture-assistant__upload"');
    expect(html).toContain("Attach");
    expect(html).not.toContain("Upload");
    expect(html).toContain('aria-keyshortcuts="Enter Shift+Enter"');
    expect(html).toContain('aria-label="Send to Roland"');
    expect(html).not.toContain("Enter sends");
    expect(html).not.toContain("Cmd/Ctrl+Enter sends");
    expect(html).not.toContain('class="capture-assistant__input-icon"');
  });
});
