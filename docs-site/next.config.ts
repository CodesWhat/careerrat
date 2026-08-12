import { createMDX } from "fumadocs-mdx/next";

const withMDX = createMDX();

// The docs app is a separate Next.js workspace mounted at /docs inside the
// marketing site. `output: "export"` produces static HTML that the website's
// `build:docs-content` script copies into `website/public/docs/`. `basePath:
// "/docs"` prefixes every internal link and asset so navigation keeps working
// when the website serves the export at careerrat.com/docs/...
export default withMDX({
  output: "export",
  basePath: "/docs",
  // Directory-style export (each page -> page/index.html) so the website serves
  // clean URLs for leaf pages as plain static files (without it, /docs works via
  // index.html but /docs/getting-started/install has no index to resolve to).
  trailingSlash: true,
  images: {
    unoptimized: true,
  },
});
