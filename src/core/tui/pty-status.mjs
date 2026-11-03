import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

// Whether the native terminal helper (node-pty) loads. It ships prebuilt for macOS, Linux (glibc and musl)
// and Windows; an unsupported platform falls back to compiling, which needs make and a C++ compiler.
export function ptyStatus({
  load = () => require("@homebridge/node-pty-prebuilt-multiarch"),
} = {}) {
  try {
    load();
    return { ok: true, error: null };
  } catch (error) {
    return { ok: false, error: error?.message || String(error) };
  }
}
