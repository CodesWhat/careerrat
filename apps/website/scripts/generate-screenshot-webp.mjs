// Writes WebP copies of the home-page terminal screenshots next to the PNGs
// (the PNGs stay for the README and docs). Run: npm run screenshots:webp
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const dir = fileURLToPath(new URL("../public/screenshots/", import.meta.url));
for (const name of ["tui-main", "tui-fit", "tui-activity"]) {
  for (const width of [800, 1600]) {
    await sharp(`${dir}${name}.png`)
      .resize({ width })
      .webp({ quality: 80, effort: 6 })
      .toFile(`${dir}${name}-${width}.webp`);
  }
}
