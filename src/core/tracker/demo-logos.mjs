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
  "cyberdyne systems": { src: "../assets/logos/cyberdyne.png" },
  // interview
  "massive dynamic": { src: "../assets/logos/massive-dynamic.png" },
  // applied
  "tyrell corporation": { src: "../assets/logos/tyrell.png" },
  "black mesa": { src: "../assets/logos/black-mesa.png" },
  "abstergo industries": { src: "../assets/logos/abstergo.png" },
  "omni consumer products": { src: "../assets/logos/ocp.png" },
  "buy n large": { src: "../assets/logos/buy-n-large.png" },
  aviato: { src: "../assets/logos/aviato.png" },
  "nakatomi corporation": { src: "../assets/logos/nakatomi.png" },
  ingen: { src: "../assets/logos/ingen.png" },
  biosyn: { src: "../assets/logos/biosyn.png" },
  bachmanity: { src: "../assets/logos/bachmanity.png" },
  encom: { src: "../assets/logos/encom.png" },
  momcorp: { src: "../assets/logos/momcorp.png" },
  "monsters inc": { src: "../assets/logos/monsters-inc.png" },
  choam: { src: "../assets/logos/choam.png" },
  rekall: { src: "../assets/logos/rekall.png" },
  "blue sun": { src: "../assets/logos/blue-sun.png" },
  acme: { src: "../assets/logos/acme.png" },
  "los pollos hermanos": { src: "../assets/logos/los-pollos.png" },
  // rejected / withdrawn
  hooli: { src: "../assets/logos/hooli.png" },
  "weyland-yutani": { src: "../assets/logos/weyland-yutani.png" },
  "umbrella corporation": { src: "../assets/logos/umbrella.png" },
  initech: { src: "../assets/logos/initech.png" },
  "zorg industries": { src: "../assets/logos/zorg.png" },
  globex: { src: "../assets/logos/globex.png" },
  virtucon: { src: "../assets/logos/virtucon.png" },
  // sourced / decide
  "prestige worldwide": { src: "../assets/logos/prestige-worldwide.png" },
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
