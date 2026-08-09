import path from "node:path";
import { fileURLToPath } from "node:url";
import type { NextConfig } from "next";

// The workspace root is the careerrat repo root, one level up from website/.
// Pinning it keeps turbopack from inferring the wrong root in the monorepo.
const workspaceRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

const nextConfig: NextConfig = {
  // Static export — the site is fully pre-rendered HTML/CSS/JS, no server runtime.
  output: "export",
  images: { unoptimized: true },
  turbopack: {
    root: workspaceRoot,
  },
};

export default nextConfig;
