const BASE_WINDOW_OPTIONS = {
  width: 1280,
  height: 860,
  minWidth: 960,
  minHeight: 700,
  title: "Rolester",
  backgroundColor: "#fffaf2",
};

export function buildBrowserWindowOptions({ platform = process.platform } = {}) {
  if (platform !== "darwin") return { ...BASE_WINDOW_OPTIONS };

  return {
    ...BASE_WINDOW_OPTIONS,
    titleBarStyle: "hiddenInset",
    trafficLightPosition: { x: 18, y: 18 },
  };
}
