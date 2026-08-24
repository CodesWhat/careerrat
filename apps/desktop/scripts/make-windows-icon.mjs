#!/usr/bin/env node

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const desktopRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const sourcePath = join(desktopRoot, "build", "icon.png");
const outputPath = join(desktopRoot, "build", "icon.ico");

const png = await sharp(readFileSync(sourcePath)).resize(256, 256).png().toBuffer();
const header = Buffer.alloc(22);
header.writeUInt16LE(0, 0);
header.writeUInt16LE(1, 2);
header.writeUInt16LE(1, 4);
header.writeUInt8(0, 6);
header.writeUInt8(0, 7);
header.writeUInt8(0, 8);
header.writeUInt8(0, 9);
header.writeUInt16LE(1, 10);
header.writeUInt16LE(32, 12);
header.writeUInt32LE(png.length, 14);
header.writeUInt32LE(header.length, 18);
writeFileSync(outputPath, Buffer.concat([header, png]));
process.stdout.write(`wrote ${outputPath}\n`);
