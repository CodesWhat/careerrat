// Generate the selected CareerRat text mark for macOS and Windows packaging.
//
//   node apps/desktop/scripts/make-icon.mjs
//
// Option 08: a large centered Career / Rat. stack on the sky square.

import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const HERE = dirname(fileURLToPath(import.meta.url));
const BUILD_DIR = join(HERE, "..", "build");
const FONT_PATH = join(
  HERE,
  "..",
  "..",
  "..",
  "node_modules",
  "@fontsource",
  "figtree",
  "files",
  "figtree-latin-800-normal.woff2",
);

const CANVAS = 1024;
const BODY = 824;
const MARGIN = (CANVAS - BODY) / 2;
const RADIUS = Math.round(BODY * 0.24);
const SKY = "#8fd0f8";
const INK = "#17171a";
const fontData = readFileSync(FONT_PATH).toString("base64");

function iconSvg() {
  const opticalCenter = Math.round(CANVAS / 2 - BODY * 0.01);
  const firstBaseline = Math.round(CANVAS * 0.487);
  const secondBaseline = Math.round(CANVAS * 0.705);
  const fontSize = Math.round(BODY * 0.33);

  return Buffer.from(`
    <svg xmlns="http://www.w3.org/2000/svg" width="${CANVAS}" height="${CANVAS}" viewBox="0 0 ${CANVAS} ${CANVAS}">
      <style>
        @font-face {
          font-family: "FigtreeIcon";
          src: url("data:font/woff2;base64,${fontData}") format("woff2");
          font-weight: 800;
        }
        text { font-family: "FigtreeIcon", Figtree, Arial, sans-serif; font-weight: 800; letter-spacing: -0.07em; }
      </style>
      <rect x="${MARGIN}" y="${MARGIN}" width="${BODY}" height="${BODY}" rx="${RADIUS}" fill="${SKY}" />
      <text x="${opticalCenter}" y="${firstBaseline}" text-anchor="middle" font-size="${fontSize}" fill="${INK}">Career</text>
      <text x="${opticalCenter}" y="${secondBaseline}" text-anchor="middle" font-size="${fontSize}" fill="${INK}">Rat.</text>
    </svg>
  `);
}

function icoFromPngs(images) {
  const directory = Buffer.alloc(6 + images.length * 16);
  directory.writeUInt16LE(0, 0);
  directory.writeUInt16LE(1, 2);
  directory.writeUInt16LE(images.length, 4);

  let offset = directory.length;
  images.forEach(({ png, size }, index) => {
    const entry = 6 + index * 16;
    directory[entry] = size === 256 ? 0 : size;
    directory[entry + 1] = size === 256 ? 0 : size;
    directory.writeUInt16LE(1, entry + 4);
    directory.writeUInt16LE(32, entry + 6);
    directory.writeUInt32LE(png.length, entry + 8);
    directory.writeUInt32LE(offset, entry + 12);
    offset += png.length;
  });

  return Buffer.concat([directory, ...images.map(({ png }) => png)]);
}

async function main() {
  mkdirSync(BUILD_DIR, { recursive: true });
  const icon1024 = await sharp(iconSvg()).png().toBuffer();
  const pngPath = join(BUILD_DIR, "icon.png");
  await sharp(icon1024).toFile(pngPath);

  const iconset = join(BUILD_DIR, "icon.iconset");
  rmSync(iconset, { recursive: true, force: true });
  mkdirSync(iconset, { recursive: true });
  const macSizes = [
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
  for (const [name, size] of macSizes) {
    await sharp(icon1024).resize(size, size).png().toFile(join(iconset, name));
  }
  execFileSync("iconutil", ["-c", "icns", iconset, "-o", join(BUILD_DIR, "icon.icns")]);
  rmSync(iconset, { recursive: true, force: true });

  const windowsImages = await Promise.all(
    [16, 24, 32, 48, 64, 128, 256].map(async (size) => ({
      size,
      png: await sharp(icon1024).resize(size, size).png().toBuffer(),
    })),
  );
  writeFileSync(join(BUILD_DIR, "icon.ico"), icoFromPngs(windowsImages));

  process.stdout.write(`wrote ${pngPath}, icon.icns, and icon.ico\n`);
}

main().catch((error) => {
  process.stderr.write(`${error?.stack || error}\n`);
  process.exitCode = 1;
});
