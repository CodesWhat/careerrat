// Demo-only fictional-corp logos for the seeded evil-corp fixtures. Referenced
// by path (relative to the generated workspace/tracker.html) — the real files
// live in assets/logos/, normalized to a uniform 256x256 white-padded square PNG.
// Keyed by lowercased company name; only the demo seed matches. Real workspaces
// resolve logos the standard way (see AGENTS.md "Company logos"): an explicit
// app.logo, else logo.dev (opt-in), else a monogram avatar.
//
// These are placeholders: stripDemo() drops every demo:true row the moment a
// real application/sourced entry arrives from the skills, so the fixtures — and their
// logos — disappear automatically. See dashboard.mjs.
//
// Companies without a file here fall back to a monogram avatar.

import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
export const DEMO_LOGOS = {
  // accepted / offers / finals
  "e corp": { src: "../assets/logos/e-corp.png" },
  "aperture science": { src: "../assets/logos/aperture-science.png" },
  hooli: { src: "../assets/logos/hooli.png" },
  "weyland-yutani": { src: "../assets/logos/weyland-yutani.png" },
  "cyberdyne systems": { src: "../assets/logos/cyberdyne.png" },
  "pied piper": { src: "../assets/logos/pied-piper.png" },
  // interview
  "tyrell corporation": { src: "../assets/logos/tyrell.png" },
  "black mesa": { src: "../assets/logos/black-mesa.png" },
  "massive dynamic": { src: "../assets/logos/massive-dynamic.png" },
  "abstergo industries": { src: "../assets/logos/abstergo.png" },
  // screen
  "omni consumer products": { src: "../assets/logos/ocp.png" },
  "umbrella corporation": { src: "../assets/logos/umbrella.png" },
  "buy n large": { src: "../assets/logos/buy-n-large.png" },
  "vault-tec": { src: "../assets/logos/vault-tec.png" },
  aviato: { src: "../assets/logos/aviato.png" },
  // applied
  "nakatomi corporation": { src: "../assets/logos/nakatomi.png" },
  "veridian dynamics": { src: "../assets/logos/veridian.png" },
  "dharma initiative": { src: "../assets/logos/dharma.png" },
  ingen: { src: "../assets/logos/ingen.png" },
  biosyn: { src: "../assets/logos/biosyn.png" },
  initech: { src: "../assets/logos/initech.png" },
  bachmanity: { src: "../assets/logos/bachmanity.png" },
  encom: { src: "../assets/logos/encom.png" },
  momcorp: { src: "../assets/logos/momcorp.png" },
  // rejected / withdrawn
  spectre: { src: "../assets/logos/spectre.png" },
  "spacely sprockets": { src: "../assets/logos/spacely.png" },
  "zorg industries": { src: "../assets/logos/zorg.png" },
  cobra: { src: "../assets/logos/cobra.png" },
  "monsters inc": { src: "../assets/logos/monsters-inc.png" },
};

// Absolute filesystem path to the bundled logo PNG for a demo company name, or
// null when the company isn't a known fictional-corp fixture. The logo route
// serves this ahead of logo.dev so the seeded roster shows its franchise mark
// instead of a wrong real-company guess (e.g. "Buy n Large" → Disney). The map's
// `src` is a web path relative to the rendered page; the real files live in
// <repoRoot>/assets/logos/, so we resolve by basename off this module's location.
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

export function demoLogoFilePath(company) {
  const entry =
    DEMO_LOGOS[
      String(company || "")
        .trim()
        .toLowerCase()
    ];
  if (!entry) return null;
  return join(REPO_ROOT, "assets", "logos", basename(entry.src));
}
