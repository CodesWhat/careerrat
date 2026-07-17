import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { ArtifactViewerModal } from "./ArtifactViewerModal.jsx";

describe("ArtifactViewerModal", () => {
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
});
