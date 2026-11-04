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
      <rect width="1200" height="630" fill="#242933" />
      <rect x="40" y="40" width="1120" height="550" rx="6" fill="#2e3440" stroke="#485466" stroke-width="2" />
      <path d="M40 106H1160" stroke="#485466" stroke-width="2" />
      <text x="76" y="84" font-size="22" letter-spacing="0" fill="#88c0d0">&gt; CareerRat</text>
      <text x="1118" y="82" text-anchor="end" font-size="17" letter-spacing="0.04em" fill="#b9a1bf">TERMINAL WORKSPACE</text>
      <text x="80" y="225" font-size="78" fill="#eceff4">Your job hunt.</text>
      <text x="80" y="322" font-size="78" fill="#88c0d0">In your terminal.</text>
      <text x="84" y="386" font-size="25" letter-spacing="0" fill="#b2bdce">Find jobs. Apply with your real experience. Track what happens.</text>
      <rect x="80" y="439" width="1040" height="64" rx="4" fill="#242933" stroke="#485466" />
      <text x="102" y="481" font-size="24" letter-spacing="0" fill="#a3be8c">$</text>
      <text x="132" y="481" font-size="24" letter-spacing="0" fill="#eceff4">npm i -g careerrat</text>
      <text x="84" y="551" font-size="18" letter-spacing="0" fill="#b2bdce">CLAUDE CODE / CODEX</text>
      <text x="1118" y="551" text-anchor="end" font-size="18" letter-spacing="0" fill="#b2bdce">careerrat.com</text>
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
