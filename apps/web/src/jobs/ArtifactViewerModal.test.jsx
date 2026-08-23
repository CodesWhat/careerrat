import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { ArtifactViewerModal, handleArtifactViewerKeyDown } from "./ArtifactViewerModal.jsx";

describe("ArtifactViewerModal", () => {
  it("previews plain-text evidence without injecting it as HTML", () => {
    const html = renderToStaticMarkup(
      <ArtifactViewerModal
        title="Nexus story"
        artifact={{ text: "Reduced <script> launch time by 30%." }}
        onClose={() => {}}
      />
    );

    expect(html).toContain("Reduced &lt;script&gt; launch time by 30%.");
    expect(html).not.toContain("<script>");
  });

  it("renders server-provided HTML through the markdown branch", () => {
    const html = renderToStaticMarkup(
      <ArtifactViewerModal
        title="Resume preview"
        artifact={{ html: "<h1>Resume</h1><p>Evidence-backed work.</p>" }}
        onClose={vi.fn()}
      />
    );
    expect(html).toContain('class="packet-viewer__markdown"');
    expect(html).toContain("<h1>Resume</h1>");
    expect(html).not.toContain('class="packet-viewer__object"');
  });

  it("renders binary PDFs through the object/embed branch", () => {
    const html = renderToStaticMarkup(
      <ArtifactViewerModal
        title="Resume PDF"
        artifact={{ binary: true, url: "/api/packet/artifact?id=app-1&amp;kind=resume" }}
        onClose={vi.fn()}
      />
    );
    expect(html).toContain('class="packet-viewer__object"');
    expect(html).toContain('type="application/pdf"');
    expect(html).toContain("<iframe");
  });

  it("marks the close control with the Electron no-drag class", () => {
    const html = renderToStaticMarkup(
      <ArtifactViewerModal
        title="Resume preview"
        artifact={{ html: "<p>Resume</p>" }}
        onClose={vi.fn()}
      />
    );
    expect(html).toMatch(/class="[^"]*packet-viewer__close[^"]*"/);
  });

  it("owns Escape while open and exposes modal semantics", () => {
    const onClose = vi.fn();
    const event = {
      key: "Escape",
      preventDefault: vi.fn(),
      stopPropagation: vi.fn(),
      stopImmediatePropagation: vi.fn(),
    };

    handleArtifactViewerKeyDown({ event, onClose });

    expect(onClose).toHaveBeenCalledOnce();
    expect(event.preventDefault).toHaveBeenCalledOnce();
    expect(event.stopImmediatePropagation).toHaveBeenCalledOnce();
    const html = renderToStaticMarkup(
      <ArtifactViewerModal
        title="Resume preview"
        artifact={{ html: "<p>Resume</p>" }}
        onClose={onClose}
      />
    );
    expect(html).toContain('aria-modal="true"');
  });
});
