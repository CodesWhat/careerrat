import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  ArrowLeftIcon,
  CalendarIcon,
  ChevronDownIcon,
  FolderIcon,
  KanbanIcon,
  PeopleIcon,
  PickaxeIcon,
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
        <FolderIcon />
        <PeopleIcon />
        <KanbanIcon />
        <PickaxeIcon />
      </>
    );

    expect(html.match(/<svg/g)).toHaveLength(11);
    expect(html).toContain('data-icon="settings-2"');
    expect(html).toContain('data-icon="calendar-days"');
    expect(html).toContain('data-icon="activity"');
    expect(html).toContain('data-icon="chevron-down"');
    expect(html).toContain('data-icon="search"');
    expect(html).toContain('data-icon="arrow-left"');
    expect(html).toContain('data-icon="file-up"');
    expect(html).toContain('data-icon="folder-open"');
    expect(html).toContain('data-icon="smile"');
    expect(html).toContain('data-icon="kanban"');
    expect(html).toContain('data-icon="pickaxe"');
    expect(html).toContain('stroke-width="2"');
  });
});
