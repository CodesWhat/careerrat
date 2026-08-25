import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

async function loadMenuBuilder() {
  return import("../apps/desktop/menu-template.mjs").catch(() => ({}));
}

function item(menu, label) {
  return menu.find((entry) => entry.label === label);
}

describe("CareerRat desktop menu", () => {
  it("builds a focused macOS menu with app-specific actions and native roles", async () => {
    const module = await loadMenuBuilder();
    assert.equal(typeof module.buildCareerRatMenuTemplate, "function");

    const calls = [];
    const menu = module.buildCareerRatMenuTemplate({
      appName: "CareerRat",
      platform: "darwin",
      isDevelopment: false,
      actions: {
        openSettings: () => calls.push("settings"),
        checkForUpdates: () => calls.push("updates"),
        openWebsite: () => calls.push("website"),
        openDocumentation: () => calls.push("docs"),
        reportIssue: () => calls.push("issue"),
      },
    });

    assert.deepEqual(
      menu.map((entry) => entry.label),
      ["CareerRat", "File", "Edit", "View", "Window", "Help"]
    );

    const appMenu = item(menu, "CareerRat").submenu;
    assert.equal(appMenu[0].role, "about");
    assert.equal(item(appMenu, "Settings…").accelerator, "CmdOrCtrl+,");
    assert.equal(item(appMenu, "Check for Updates…").accelerator, undefined);
    assert.ok(appMenu.some((entry) => entry.role === "services"));
    assert.ok(appMenu.some((entry) => entry.role === "quit"));
    item(appMenu, "Settings…").click();
    item(appMenu, "Check for Updates…").click();

    const editRoles = item(menu, "Edit")
      .submenu.map((entry) => entry.role)
      .filter(Boolean);
    assert.deepEqual(editRoles, [
      "undo",
      "redo",
      "cut",
      "copy",
      "paste",
      "pasteAndMatchStyle",
      "delete",
      "selectAll",
    ]);

    const viewRoles = item(menu, "View")
      .submenu.map((entry) => entry.role)
      .filter(Boolean);
    assert.deepEqual(viewRoles, ["resetZoom", "zoomIn", "zoomOut", "togglefullscreen"]);
    assert.ok(!viewRoles.includes("reload"));
    assert.ok(!viewRoles.includes("toggleDevTools"));

    const helpMenu = item(menu, "Help").submenu;
    item(helpMenu, "CareerRat Website").click();
    item(helpMenu, "Documentation").click();
    item(helpMenu, "Report an Issue…").click();
    assert.deepEqual(calls, ["settings", "updates", "website", "docs", "issue"]);
  });

  it("keeps reload and developer tools development-only", async () => {
    const { buildCareerRatMenuTemplate } = await loadMenuBuilder();
    assert.equal(typeof buildCareerRatMenuTemplate, "function");

    const menu = buildCareerRatMenuTemplate({
      platform: "darwin",
      isDevelopment: true,
      actions: {},
    });
    const roles = item(menu, "View")
      .submenu.map((entry) => entry.role)
      .filter(Boolean);

    assert.ok(roles.includes("reload"));
    assert.ok(roles.includes("toggleDevTools"));
  });

  it("keeps Settings and update checks reachable on Windows and Linux", async () => {
    const { buildCareerRatMenuTemplate } = await loadMenuBuilder();
    const calls = [];
    for (const platform of ["win32", "linux"]) {
      const menu = buildCareerRatMenuTemplate({
        platform,
        actions: {
          openSettings: () => calls.push(`${platform}:settings`),
          checkForUpdates: () => calls.push(`${platform}:updates`),
        },
      });

      assert.deepEqual(
        menu.map((entry) => entry.label),
        ["File", "Edit", "View", "Window", "Help"]
      );
      item(item(menu, "File").submenu, "Settings…").click();
      item(item(menu, "Help").submenu, "Check for Updates…").click();
    }
    assert.deepEqual(calls, ["win32:settings", "win32:updates", "linux:settings", "linux:updates"]);
  });

  it("creates or focuses a window before a menu-triggered update check", async () => {
    const { runMenuUpdateCheck } = await loadMenuBuilder();
    assert.equal(typeof runMenuUpdateCheck, "function");
    const calls = [];

    await runMenuUpdateCheck({
      ensureWindow: async () => calls.push("window-ready"),
      checkNow: async () => calls.push("check"),
    });

    assert.deepEqual(calls, ["window-ready", "check"]);
  });

  it("navigates an existing renderer without reloading its document", () => {
    const main = readFileSync("apps/desktop/main.mjs", "utf8");
    const body = main.match(/function openDesktopRoute\(route\) \{([\s\S]*?)\n\}/)?.[1] || "";

    assert.match(body, /webContents\.send/);
    assert.doesNotMatch(body, /win\.loadURL/);
  });
});
