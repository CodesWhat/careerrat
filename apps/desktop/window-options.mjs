const BASE_WINDOW_OPTIONS = {
  width: 1280,
  height: 860,
  minWidth: 1280,
  maxWidth: 1280,
  minHeight: 860,
  maxHeight: 860,
  resizable: false,
  maximizable: false,
  fullscreenable: false,
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
