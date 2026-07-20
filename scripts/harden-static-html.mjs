#!/usr/bin/env node
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { hardenStaticHtml } from "../src/core/security/browser-policy.mjs";

export function hardenStaticDirectory(directory, { allowTailwindCdn = false } = {}) {
  let hardened = 0;
  for (const path of htmlFiles(resolve(directory))) {
    const source = readFileSync(path, "utf8");
    const output = hardenStaticHtml(source, { allowTailwindCdn });
    if (output !== source) writeFileSync(path, output, "utf8");
    hardened += 1;
  }
  return hardened;
}

function* htmlFiles(directory) {
  if (!statSync(directory).isDirectory()) return;
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) yield* htmlFiles(path);
    else if (entry.isFile() && entry.name.toLowerCase().endsWith(".html")) yield path;
  }
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const directory = process.argv[2];
  if (!directory) throw new Error("usage: harden-static-html <directory> [--allow-tailwind-cdn]");
  const hardened = hardenStaticDirectory(directory, {
    allowTailwindCdn: process.argv.includes("--allow-tailwind-cdn"),
  });
  process.stdout.write(`Hardened ${hardened} static HTML file(s).\n`);
}
