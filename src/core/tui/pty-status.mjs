import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

// Whether the native terminal helper (node-pty) loads. It is compiled at install
// time on Linux, so a machine without make and a C++ compiler can end up without it.
export function ptyStatus({ load = () => require("node-pty") } = {}) {
  try {
    load();
    return { ok: true, error: null };
  } catch (error) {
    return { ok: false, error: error?.message || String(error) };
  }
}
