import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { SettingsIcon } from "./icons.jsx";

describe("SettingsIcon", () => {
  it("renders as a gear instead of a sun or light-mode glyph", () => {
    const html = renderToStaticMarkup(<SettingsIcon />);

    expect(html).toContain('data-icon="settings"');
    expect(html).toContain("M19.4 15");
    expect(html).not.toContain(
      "M12 3.5v2M12 18.5v2M4.8 6.3l1.4 1.4M17.8 16.3l1.4 1.4M3.5 12h2M18.5 12h2M4.8 17.7l1.4-1.4M17.8 7.7l1.4-1.4"
    );
  });
});
