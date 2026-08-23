// apps/desktop/scripts/make-icon.mjs — generate the macOS app icon from the
// CareerRat mascot on the brand cream background.
//
//   node apps/desktop/scripts/make-icon.mjs
//
// Produces apps/desktop/build/icon.png (1024) and apps/desktop/build/icon.icns.
// electron-builder.yml points mac.icon at the .icns; main.mjs uses the .png for
// the dev dock icon. Re-run after changing the logo or brand color.
//
// Design: Apple "Big Sur" grid — 1024 canvas, 824 rounded-rect body (corner
// radius 185, 100px margin), filled with a soft cream gradient, mascot centred
// with breathing room. The mascot PNG already carries its own die-cut outline
// and shadow, so it reads as a sticker on paper.

import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, "..", "..", "..");
const BUILD_DIR = join(HERE, "..", "build");
const LOGO = join(REPO_ROOT, "assets", "logo.png");

const CANVAS = 1024;
const BODY = 824; // Big Sur icon body
const MARGIN = (CANVAS - BODY) / 2; // 100
const RADIUS = 185; // ~22.5% of body
const LOGO_BOX = 800; // mascot bounding box, centred (boldest — fills the body edge to edge)

// Cream brand ramp for the existing desktop icon artwork.
const CREAM_TOP = "#fffaf2"; // --paper-surface
const CREAM_BOTTOM = "#f4eee1"; // a touch deeper than --paper-bg (#faf6ef)
const EDGE = "#e7dcca"; // --paper-edge-ish hairline for definition on white

const bgSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="${CANVAS}" height="${CANVAS}" viewBox="0 0 ${CANVAS} ${CANVAS}">
  <defs>
    <linearGradient id="cream" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="${CREAM_TOP}"/>
      <stop offset="1" stop-color="${CREAM_BOTTOM}"/>
    </linearGradient>
  </defs>
  <rect x="${MARGIN}" y="${MARGIN}" width="${BODY}" height="${BODY}" rx="${RADIUS}" ry="${RADIUS}"
        fill="url(#cream)" stroke="${EDGE}" stroke-width="2"/>
</svg>`;

async function main() {
  mkdirSync(BUILD_DIR, { recursive: true });

  const background = await sharp(Buffer.from(bgSvg)).png().toBuffer();
  const mascot = await sharp(LOGO)
    .resize(LOGO_BOX, LOGO_BOX, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .toBuffer();

  const icon1024 = await sharp(background)
    .composite([{ input: mascot, gravity: "center" }])
    .png()
    .toBuffer();

  const pngPath = join(BUILD_DIR, "icon.png");
  await sharp(icon1024).toFile(pngPath);
  console.log(`wrote ${pngPath}`);

  // Build a .icns via macOS iconutil (reliable, native). Generate the standard
  // iconset sizes from the 1024 source, then pack.
  const iconset = join(BUILD_DIR, "icon.iconset");
  rmSync(iconset, { recursive: true, force: true });
  mkdirSync(iconset, { recursive: true });
  const sizes = [
    ["icon_16x16.png", 16],
    ["icon_16x16@2x.png", 32],
    ["icon_32x32.png", 32],
    ["icon_32x32@2x.png", 64],
    ["icon_128x128.png", 128],
    ["icon_128x128@2x.png", 256],
    ["icon_256x256.png", 256],
    ["icon_256x256@2x.png", 512],
    ["icon_512x512.png", 512],
    ["icon_512x512@2x.png", 1024],
  ];
  for (const [name, size] of sizes) {
    await sharp(icon1024).resize(size, size).png().toFile(join(iconset, name));
  }
  const icnsPath = join(BUILD_DIR, "icon.icns");
  execFileSync("iconutil", ["-c", "icns", iconset, "-o", icnsPath]);
  rmSync(iconset, { recursive: true, force: true });
  console.log(`wrote ${icnsPath}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
