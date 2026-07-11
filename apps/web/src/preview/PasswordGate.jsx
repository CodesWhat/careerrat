import { useMemo, useState } from "react";

const STORAGE_KEY = "rolester-preview-unlocked";
const DEFAULT_PASSWORD = "rolester";

export function PasswordGate({ children }) {
  const config = useMemo(() => getPreviewPasswordConfig(), []);
  const [unlocked, setUnlocked] = useState(() => isPreviewUnlocked(config));
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");

  if (!config.required || unlocked) return children;

  function submit(event) {
    event.preventDefault();
    if (password === config.password) {
      try {
        window.localStorage.setItem(STORAGE_KEY, "true");
      } catch {
        // Local storage can be unavailable in private sessions; unlock in memory.
      }
      setUnlocked(true);
      setError("");
      return;
    }
    setError("Wrong password.");
  }

  return (
    <main className="preview-gate" aria-labelledby="preview-gate-title">
      <form className="preview-gate__panel" onSubmit={submit}>
        <span className="preview-gate__eyebrow">Rolester Preview</span>
        <h1 id="preview-gate-title">Enter password</h1>
        <input
          aria-label="Preview password"
          autoComplete="current-password"
          // biome-ignore lint/a11y/noAutofocus: single-purpose password gate, focus belongs on the only field
          autoFocus
          onChange={(event) => setPassword(event.target.value)}
          placeholder="Password"
          type="password"
          value={password}
        />
        {error ? <p className="preview-gate__error">{error}</p> : null}
        <button type="submit">Open preview</button>
      </form>
    </main>
  );
}

function getPreviewPasswordConfig() {
  const password = import.meta.env.VITE_PREVIEW_PASSWORD || DEFAULT_PASSWORD;
  const requiredByEnv = import.meta.env.VITE_REQUIRE_PREVIEW_PASSWORD === "true";
  const hostname = getHostname();
  const requiredByHost =
    hostname.endsWith(".vercel.app") ||
    hostname.includes("codeswhat") ||
    hostname.includes("rolester");

  return {
    password,
    required: requiredByEnv || requiredByHost,
  };
}

function getHostname() {
  if (typeof window === "undefined") return "";
  return window.location.hostname.toLowerCase();
}

function isPreviewUnlocked(config) {
  if (!config.required || typeof window === "undefined") return true;
  try {
    return window.localStorage.getItem(STORAGE_KEY) === "true";
  } catch {
    return false;
  }
}
