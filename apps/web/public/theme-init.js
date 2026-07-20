// Apply the saved/preferred theme before paint without requiring an inline
// script exception in Content Security Policy.
(function applyInitialTheme() {
  try {
    let theme = localStorage.getItem("rolester-theme");
    if (theme !== "dark" && theme !== "light") {
      theme =
        window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches
          ? "dark"
          : "light";
    }
    document.documentElement.setAttribute("data-theme", theme);
  } catch {
    // Storage can be unavailable in private contexts; runtime theme handling remains available.
  }
})();
