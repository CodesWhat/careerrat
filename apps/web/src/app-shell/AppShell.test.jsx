import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";

vi.mock("./ActivityBell.jsx", () => ({
  ActivityBell: () => <button type="button" aria-label="Activity" />,
}));

import { AppShell } from "./AppShell.jsx";

function renderShell(path = "/") {
  return renderToStaticMarkup(
    <MemoryRouter initialEntries={[path]}>
      <AppShell>
        <section data-testid="mounted-dashboard">Mounted dashboard</section>
      </AppShell>
    </MemoryRouter>
  );
}

describe("AppShell", () => {
  it("uses product top navigation instead of the legacy left sidebar", () => {
    const html = renderShell("/jobs");

    expect(html).toContain('class="app-shell__header"');
    expect(html).toContain('class="app-shell__brand-lockup"');
    expect(html).toContain('class="app-shell__brand">CareerRat</div>');
    expect(html).not.toContain('class="app-shell__brand-logo"');
    expect(html).toContain('aria-label="Primary navigation"');
    expect(html).not.toContain('class="app-shell__nav"');
    expect(html).not.toContain('aria-label="Primary"');
  });

  it("keeps real dashboard content mounted under the new shell without the v2 Roland assistant", () => {
    const html = renderShell("/");

    expect(html).toContain('<main class="app-shell__content">');
    expect(html).toContain("Mounted dashboard");
    expect(html).not.toContain('class="capture-assistant"');
    expect(html).not.toContain("Roland capture");
    expect(html).not.toContain("Talk to Roland");
    expect(html).not.toContain('class="capture-bar"');
  });

  it("moves utilities to the right side of the header", () => {
    const html = renderShell("/");

    expect(html).toContain('class="app-shell__right"');
    expect(html).toContain('aria-label="Activity"');
    expect(html).toContain('aria-label="Settings"');
    expect(html).toContain('href="/settings"');
    expect(html).toContain('aria-label="Switch to dark mode"');
  });
});
