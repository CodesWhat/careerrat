const BASE_WINDOW_OPTIONS = {
  width: 1280,
  height: 860,
  minWidth: 1100,
  minHeight: 680,
  resizable: true,
  maximizable: true,
  fullscreenable: true,
  title: "CareerRat",
  backgroundColor: "#edf5fb",
};

export function buildBrowserWindowOptions({ platform = process.platform } = {}) {
  const base = { ...BASE_WINDOW_OPTIONS };
  if (platform !== "darwin") return base;

  return {
    ...base,
    titleBarStyle: "hiddenInset",
    trafficLightPosition: { x: 18, y: 18 },
  };
}
