import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  ArrowLeftIcon,
  CalendarIcon,
  ChevronDownIcon,
  PulseIcon,
  SearchIcon,
  SettingsIcon,
  UploadIcon,
} from "./chat-first-icons.jsx";

describe("chat-first icon set", () => {
  it("owns every icon used by the workspace without the retired catalog", () => {
    const html = renderToStaticMarkup(
      <>
        <SettingsIcon />
        <CalendarIcon />
        <PulseIcon />
        <ChevronDownIcon />
        <SearchIcon />
        <ArrowLeftIcon />
        <UploadIcon />
      </>
    );

    expect(html.match(/<svg/g)).toHaveLength(7);
    expect(html).toContain('data-icon="settings"');
    expect(html).toContain("M19.4 15");
    expect(html).toContain("M12 15.5V4.5");
  });
});
