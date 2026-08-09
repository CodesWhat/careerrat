import { DocsLayout } from "fumadocs-ui/layouts/docs";
import { RootProvider } from "fumadocs-ui/provider/next";
import type { Metadata, Viewport } from "next";
import { Archivo, IBM_Plex_Mono, IBM_Plex_Sans } from "next/font/google";
import { source } from "@/lib/source";
import "./globals.css";

const ibmPlexSans = IBM_Plex_Sans({
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
});

const ibmPlexMono = IBM_Plex_Mono({
  subsets: ["latin"],
  weight: ["400", "500"],
  variable: "--font-mono",
});

// next/font/google self-hosts Archivo at build time (downloaded once, served
// from our own domain) — nothing hits Google at runtime. Same approach as
// website/src/app/layout.tsx; used for display/headings only, body stays
// IBM Plex Sans above.
const archivo = Archivo({
  subsets: ["latin"],
  weight: ["700", "800"],
  style: ["normal"],
  variable: "--font-display",
  display: "swap",
});

export const metadata: Metadata = {
  title: {
    template: "%s — CareerRat Docs",
    default: "CareerRat Docs",
  },
  description:
    "Documentation for CareerRat — an agentic job-search workspace for finding, vetting, tailoring, tracking, and preparing for roles.",
  // Docs are served at careerrat.com/docs/... (basePath: "/docs" — see
  // next.config.ts). metadataBase is the site origin; Next resolves each
  // page's already-basePath-prefixed relative URLs against it, so this
  // stays the bare domain, not "https://careerrat.com/docs".
  metadataBase: new URL(process.env.NEXT_PUBLIC_SITE_URL || "https://careerrat.com"),
};

export const viewport: Viewport = {
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#ececea" },
    { media: "(prefers-color-scheme: dark)", color: "#131316" },
  ],
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body
        className={`${ibmPlexSans.className} ${ibmPlexMono.variable} ${archivo.variable}`}
      >
        <RootProvider>
          <DocsLayout
            tree={source.pageTree}
            nav={{
              title: (
                <span className="font-semibold tracking-tight">CareerRat</span>
              ),
              url: "/",
            }}
            links={[
              {
                text: "GitHub",
                url: "https://github.com/CodesWhat/careerrat",
                external: true,
              },
            ]}
          >
            {children}
          </DocsLayout>
        </RootProvider>
      </body>
    </html>
  );
}
