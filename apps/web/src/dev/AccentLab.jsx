import { useEffect, useState } from "react";
import { Button } from "../components/Button.jsx";
import "./AccentLab.css";

// AccentLab — dev-only floating widget for trying replacement --mustard
// accent values live in the real app before baking a new value into
// tokens.css. Mounted only when import.meta.env.DEV is true (see
// ../App.jsx); this file never ships in a production build.
//
// The baked defaults below match tokens.css's current --mustard /
// --mustard-light pair (light theme) and its dark-theme counterpart — they're
// what the widget falls back to on first load and after Reset, so the swatch
// always reflects what's actually on screen.
const STORAGE_KEY = "rolester-accent-lab";
const STYLE_ID = "accent-lab-overrides";

const DEFAULT_LIGHT = "#e0a93b";
const DEFAULT_DARK = "#e9b653";

const PRESETS = [
  "#e8a13d",
  "#f0b429",
  "#d4a017",
  "#c98f1f",
  "#e8963c",
  "#d9772f",
  "#a89b2e",
  "#c65d32",
];

function clampChannel(value) {
  return Math.max(0, Math.min(255, Math.round(value)));
}

function hexToRgb(hex) {
  const normalized = hex.replace("#", "");
  return [
    Number.parseInt(normalized.slice(0, 2), 16),
    Number.parseInt(normalized.slice(2, 4), 16),
    Number.parseInt(normalized.slice(4, 6), 16),
  ];
}

function rgbToHex([r, g, b]) {
  return `#${[r, g, b].map((c) => clampChannel(c).toString(16).padStart(2, "0")).join("")}`;
}

// Auto-dark derivation: lighten the light pick by mixing in 18% white,
// per channel, so a single light pick gets a usable dark-theme companion
// with no second manual pick required.
function deriveDark(lightHex) {
  const [r, g, b] = hexToRgb(lightHex);
  return rgbToHex([r + (255 - r) * 0.18, g + (255 - g) * 0.18, b + (255 - b) * 0.18]);
}

function readStored() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed.light !== "string" || typeof parsed.dark !== "string") {
      return null;
    }
    return { light: parsed.light, dark: parsed.dark, autoDark: parsed.autoDark !== false };
  } catch {
    return null;
  }
}

function writeStored(value) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(value));
  } catch {
    /* best-effort persistence only */
  }
}

function clearStored() {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    /* best-effort persistence only */
  }
}

// A style element (not an inline style on <html>) so light and dark themes
// keep independent overrides — an inline custom property on the root would
// apply to both themes at once and stomp the [data-theme="dark"] value.
function applyOverride(light, dark) {
  let style = document.getElementById(STYLE_ID);
  if (!style) {
    style = document.createElement("style");
    style.id = STYLE_ID;
    document.head.appendChild(style);
  }
  style.textContent = [
    `:root { --mustard: ${light}; --mustard-light: color-mix(in srgb, ${light} 18%, #fffaf2); }`,
    `[data-theme="dark"] { --mustard: ${dark}; --mustard-light: color-mix(in srgb, ${dark} 26%, #000000); }`,
  ].join("\n");
}

function removeOverride() {
  document.getElementById(STYLE_ID)?.remove();
}

export function AccentLab() {
  const [open, setOpen] = useState(false);
  const [light, setLight] = useState(DEFAULT_LIGHT);
  const [dark, setDark] = useState(DEFAULT_DARK);
  const [autoDark, setAutoDark] = useState(true);

  // Re-apply a saved override on mount only — every later change goes
  // through commit() below, which applies and persists in the same step.
  useEffect(() => {
    const stored = readStored();
    if (stored) {
      setLight(stored.light);
      setDark(stored.dark);
      setAutoDark(stored.autoDark);
      applyOverride(stored.light, stored.dark);
    }
  }, []);

  function commit(nextLight, nextDark, nextAutoDark) {
    setLight(nextLight);
    setDark(nextDark);
    setAutoDark(nextAutoDark);
    applyOverride(nextLight, nextDark);
    writeStored({ light: nextLight, dark: nextDark, autoDark: nextAutoDark });
  }

  function handleLightChange(value) {
    commit(value, autoDark ? deriveDark(value) : dark, autoDark);
  }

  function handleDarkChange(value) {
    commit(light, value, autoDark);
  }

  function handleAutoDarkChange(checked) {
    commit(light, checked ? deriveDark(light) : dark, checked);
  }

  function handleReset() {
    removeOverride();
    clearStored();
    setLight(DEFAULT_LIGHT);
    setDark(DEFAULT_DARK);
    setAutoDark(true);
  }

  return (
    <div className="accent-lab">
      {open ? (
        <div className="accent-lab__panel" role="dialog" aria-label="Accent lab">
          <div className="accent-lab__row">
            <label className="accent-lab__field" htmlFor="accent-lab-light">
              <span>Light</span>
              <input
                id="accent-lab-light"
                type="color"
                value={light}
                onChange={(e) => handleLightChange(e.target.value)}
              />
            </label>
            <label className="accent-lab__field" htmlFor="accent-lab-dark">
              <span>Dark</span>
              <input
                id="accent-lab-dark"
                type="color"
                value={dark}
                disabled={autoDark}
                onChange={(e) => handleDarkChange(e.target.value)}
              />
            </label>
          </div>

          <label className="accent-lab__auto-dark">
            <input
              type="checkbox"
              checked={autoDark}
              onChange={(e) => handleAutoDarkChange(e.target.checked)}
            />
            <span>Auto dark</span>
          </label>

          <div className="accent-lab__presets">
            {PRESETS.map((hex) => (
              <button
                key={hex}
                type="button"
                className="accent-lab__preset"
                style={{ backgroundColor: hex }}
                title={hex}
                aria-label={hex}
                onClick={() => handleLightChange(hex)}
              />
            ))}
          </div>

          <div className="accent-lab__hexes">
            <code>{light}</code>
            <code>{dark}</code>
          </div>

          <Button variant="secondary" className="accent-lab__reset" onClick={handleReset}>
            Reset
          </Button>
        </div>
      ) : null}

      <button
        type="button"
        className="accent-lab__chip"
        aria-label="Toggle accent lab"
        aria-expanded={open}
        aria-haspopup="dialog"
        onClick={() => setOpen((value) => !value)}
      >
        <span
          className="accent-lab__swatch"
          style={{ backgroundColor: light }}
          aria-hidden="true"
        />
        <span>Accent</span>
      </button>
    </div>
  );
}
