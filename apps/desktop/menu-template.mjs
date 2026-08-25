const DEFAULT_ACTION = () => {};

function action(actions, name) {
  return typeof actions?.[name] === "function" ? actions[name] : DEFAULT_ACTION;
}

function appMenu(appName, actions) {
  return {
    label: appName,
    submenu: [
      { role: "about" },
      { type: "separator" },
      {
        label: "Settings…",
        accelerator: "CmdOrCtrl+,",
        click: action(actions, "openSettings"),
      },
      {
        label: "Check for Updates…",
        click: action(actions, "checkForUpdates"),
      },
      { type: "separator" },
      { role: "services" },
      { type: "separator" },
      { role: "hide" },
      { role: "hideOthers" },
      { role: "unhide" },
      { type: "separator" },
      { role: "quit" },
    ],
  };
}

function fileMenu(platform, actions) {
  return {
    label: "File",
    submenu: [
      ...(platform === "darwin"
        ? []
        : [
            {
              label: "Settings…",
              accelerator: "CmdOrCtrl+,",
              click: action(actions, "openSettings"),
            },
            { type: "separator" },
          ]),
      { role: "close" },
    ],
  };
}

function editMenu() {
  return {
    label: "Edit",
    submenu: [
      { role: "undo" },
      { role: "redo" },
      { type: "separator" },
      { role: "cut" },
      { role: "copy" },
      { role: "paste" },
      { role: "pasteAndMatchStyle" },
      { role: "delete" },
      { role: "selectAll" },
    ],
  };
}

function viewMenu(isDevelopment) {
  const developerItems = isDevelopment
    ? [{ type: "separator" }, { role: "reload" }, { role: "toggleDevTools" }]
    : [];
  return {
    label: "View",
    submenu: [
      { role: "resetZoom" },
      { role: "zoomIn" },
      { role: "zoomOut" },
      { type: "separator" },
      { role: "togglefullscreen" },
      ...developerItems,
    ],
  };
}

function windowMenu(platform) {
  return {
    label: "Window",
    submenu: [
      { role: "minimize" },
      { role: "zoom" },
      ...(platform === "darwin"
        ? [{ type: "separator" }, { role: "front" }]
        : [{ role: "close" }]),
    ],
  };
}

function helpMenu(platform, actions) {
  return {
    label: "Help",
    submenu: [
      ...(platform === "darwin"
        ? []
        : [
            {
              label: "Check for Updates…",
              click: action(actions, "checkForUpdates"),
            },
            { type: "separator" },
          ]),
      { label: "CareerRat Website", click: action(actions, "openWebsite") },
      { label: "Documentation", click: action(actions, "openDocumentation") },
      { label: "Report an Issue…", click: action(actions, "reportIssue") },
    ],
  };
}

export function buildCareerRatMenuTemplate({
  appName = "CareerRat",
  platform = process.platform,
  isDevelopment = false,
  actions = {},
} = {}) {
  return [
    ...(platform === "darwin" ? [appMenu(appName, actions)] : []),
    fileMenu(platform, actions),
    editMenu(),
    viewMenu(isDevelopment),
    windowMenu(platform),
    helpMenu(platform, actions),
  ];
}

export async function runMenuUpdateCheck({ ensureWindow, checkNow } = {}) {
  await ensureWindow?.();
  return checkNow?.();
}
