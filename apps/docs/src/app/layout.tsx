import { DocsLayout } from "fumadocs-ui/layouts/docs";
import { RootProvider } from "fumadocs-ui/provider/next";
import type { Metadata, Viewport } from "next";
import localFont from "next/font/local";
import { source } from "@/lib/source";
import "./globals.css";

const ibmPlexSans = localFont({
  src: [
    {
      path: "../../../../node_modules/@fontsource/ibm-plex-sans/files/ibm-plex-sans-latin-400-normal.woff2",
      weight: "400",
      style: "normal",
    },
    {
      path: "../../../../node_modules/@fontsource/ibm-plex-sans/files/ibm-plex-sans-latin-500-normal.woff2",
      weight: "500",
      style: "normal",
    },
    {
      path: "../../../../node_modules/@fontsource/ibm-plex-sans/files/ibm-plex-sans-latin-600-normal.woff2",
      weight: "600",
      style: "normal",
    },
    {
      path: "../../../../node_modules/@fontsource/ibm-plex-sans/files/ibm-plex-sans-latin-700-normal.woff2",
      weight: "700",
      style: "normal",
    },
  ],
  display: "swap",
});

const ibmPlexMono = localFont({
  src: [
    {
      path: "../../../../node_modules/@fontsource/ibm-plex-mono/files/ibm-plex-mono-latin-400-normal.woff2",
      weight: "400",
      style: "normal",
    },
    {
      path: "../../../../node_modules/@fontsource/ibm-plex-mono/files/ibm-plex-mono-latin-500-normal.woff2",
      weight: "500",
      style: "normal",
    },
  ],
  variable: "--font-mono",
  display: "swap",
});

const archivo = localFont({
  src: [
    {
      path: "../../../../node_modules/@fontsource/archivo/files/archivo-latin-700-normal.woff2",
      weight: "700",
      style: "normal",
    },
    {
      path: "../../../../node_modules/@fontsource/archivo/files/archivo-latin-800-normal.woff2",
      weight: "800",
      style: "normal",
    },
  ],
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
