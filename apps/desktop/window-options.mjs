const BASE_WINDOW_OPTIONS = {
  width: 1280,
  height: 860,
  minWidth: 960,
  minHeight: 700,
  title: "Rolester",
  backgroundColor: "#fffaf2",
};

export function buildBrowserWindowOptions({ platform = process.platform, dark = false } = {}) {
  const base = dark
    ? { ...BASE_WINDOW_OPTIONS, backgroundColor: "#000000" }
    : { ...BASE_WINDOW_OPTIONS };
  if (platform !== "darwin") return base;

  return {
    ...base,
    titleBarStyle: "hiddenInset",
    trafficLightPosition: { x: 18, y: 18 },
  };
}
