#!/usr/bin/env node
// Picks the npm dist-tag for a publish. Usage: npm-dist-tag.mjs <version> [currentLatest]
//
// Publishes run per tag and can finish out of order, so `latest` may only move
// forward. A prerelease goes to `rc` (as before). A stable version goes to
// `latest` unless the registry's current `latest` is already higher, in which
// case it goes to `backport` so an older tag finishing late cannot overwrite it.
import { pathToFileURL } from "node:url";

const SEMVER = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;

function parse(version) {
  const match = SEMVER.exec(String(version ?? "").trim());
  if (!match) throw new Error(`Not a semver version: '${version}'`);
  return {
    core: [Number(match[1]), Number(match[2]), Number(match[3])],
    pre: match[4] === undefined ? null : match[4].split("."),
  };
}

function comparePre(a, b) {
  if (a === null && b === null) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
    if (a[i] === undefined) return -1;
    if (b[i] === undefined) return 1;
    const aNum = /^\d+$/.test(a[i]);
    const bNum = /^\d+$/.test(b[i]);
    if (aNum && bNum) {
      const diff = Number(a[i]) - Number(b[i]);
      if (diff !== 0) return Math.sign(diff);
    } else if (aNum !== bNum) {
      return aNum ? -1 : 1;
    } else if (a[i] !== b[i]) {
      return a[i] < b[i] ? -1 : 1;
    }
  }
  return 0;
}

export function compareSemver(a, b) {
  const left = parse(a);
  const right = parse(b);
  for (let i = 0; i < 3; i += 1) {
    if (left.core[i] !== right.core[i]) return left.core[i] < right.core[i] ? -1 : 1;
  }
  return comparePre(left.pre, right.pre);
}

export function npmDistTag(version, currentLatest) {
  if (parse(version).pre !== null) return "rc";
  const latest = String(currentLatest ?? "").trim();
  if (latest === "") return "latest";
  return compareSemver(version, latest) >= 0 ? "latest" : "backport";
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  try {
    process.stdout.write(`${npmDistTag(process.argv[2], process.argv[3])}\n`);
  } catch (error) {
    console.error(`::error::${error.message}`);
    process.exit(1);
  }
}
