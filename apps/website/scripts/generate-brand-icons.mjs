import { readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const websiteDir = join(scriptDir, "..");
const repoRoot = join(websiteDir, "..", "..");
const fontPath = join(
  websiteDir,
  "..",
  "..",
  "node_modules",
  "@fontsource",
  "figtree",
  "files",
  "figtree-latin-800-normal.woff2",
);
const fontData = (await readFile(fontPath)).toString("base64");
const SKY = "#8fd0f8";
const INK = "#17171a";

function typeStyle(letterSpacing) {
  return `
    <style>
      @font-face {
        font-family: "FigtreeIcon";
        src: url("data:font/woff2;base64,${fontData}") format("woff2");
        font-weight: 800;
      }
      text { font-family: "FigtreeIcon", Figtree, Arial, sans-serif; font-weight: 800; letter-spacing: ${letterSpacing}; }
    </style>
  `;
}

// MONOGRAM FAVICON: selected option 10, enlarged to fill the square.
function faviconSvg(size) {
  const corner = Math.round(size * 0.2);
  const fontSize = Math.round(size * 0.64);

  return Buffer.from(`
    <svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
      ${typeStyle("-0.11em")}
      <rect width="${size}" height="${size}" rx="${corner}" fill="${SKY}" />
      <text x="${Math.round(size * 0.035)}" y="${Math.round(size * 0.735)}" font-size="${fontSize}" textLength="${Math.round(size * 0.8)}" lengthAdjust="spacingAndGlyphs" fill="${INK}">CR</text>
      <circle cx="${Math.round(size * 0.9)}" cy="${Math.round(size * 0.695)}" r="${Math.max(1, Math.round(size * 0.038))}" fill="${INK}" />
    </svg>
  `);
}

function socialCardSvg() {
  return Buffer.from(`
    <svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630">
      ${typeStyle("-0.04em")}
      <rect width="1200" height="630" fill="#edf5fb" />
      <rect x="36" y="36" width="1128" height="558" rx="46" fill="#fdfcf7" />
      <rect x="76" y="76" width="360" height="478" rx="42" fill="${SKY}" />
      <text x="108" y="292" font-size="102" textLength="296" lengthAdjust="spacingAndGlyphs" fill="${INK}">Career</text>
      <text x="108" y="415" font-size="124" textLength="270" lengthAdjust="spacingAndGlyphs" fill="${INK}">Rat.</text>

      <rect x="500" y="91" width="172" height="43" rx="22" fill="#e6fa8d" />
      <text x="524" y="121" font-size="18" letter-spacing="0.08em" fill="${INK}">LOCAL-FIRST</text>
      <text x="500" y="223" font-size="66" fill="${INK}">Your AI CLI,</text>
      <text x="500" y="296" font-size="66" fill="${INK}">working your</text>
      <text x="500" y="369" font-size="66" fill="${INK}">job search.</text>
      <text x="500" y="432" font-size="25" letter-spacing="-0.01em" fill="#55584a">Rate jobs. Build honest applications.</text>
      <text x="500" y="466" font-size="25" letter-spacing="-0.01em" fill="#55584a">Track every outcome.</text>

      <rect x="500" y="505" width="166" height="45" rx="23" fill="#edf5fb" stroke="#d7dee4" stroke-width="2" />
      <text x="526" y="535" font-size="18" letter-spacing="0.02em" fill="${INK}">CLAUDE CODE</text>
      <rect x="680" y="505" width="105" height="45" rx="23" fill="#edf5fb" stroke="#d7dee4" stroke-width="2" />
      <text x="704" y="535" font-size="18" letter-spacing="0.02em" fill="${INK}">CODEX</text>
      <text x="1030" y="537" font-size="19" text-anchor="end" letter-spacing="0" fill="#55584a">careerrat.com</text>
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

const faviconImages = await Promise.all(
  [16, 32, 48, 64].map(async (size) => ({
    size,
    png: await sharp(faviconSvg(size)).png().toBuffer(),
  })),
);
const favicon = icoFromPngs(faviconImages);

await Promise.all([
  sharp(faviconSvg(512)).png().toFile(join(websiteDir, "src", "app", "icon.png")),
  sharp(faviconSvg(180)).png().toFile(join(websiteDir, "src", "app", "apple-icon.png")),
  sharp(socialCardSvg()).png().toFile(join(websiteDir, "src", "app", "opengraph-image.png")),
  writeFile(join(websiteDir, "src", "app", "favicon.ico"), favicon),
  writeFile(join(repoRoot, "assets", "favicon.ico"), favicon),
]);
