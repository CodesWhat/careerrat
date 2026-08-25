import type { Metadata, Viewport } from "next";
import localFont from "next/font/local";
import "./globals.css";

// @fontsource/figtree keeps the approved type family local at build and runtime.
const figtree = localFont({
  src: [
    {
      path: "../../../../node_modules/@fontsource/figtree/files/figtree-latin-400-normal.woff2",
      weight: "400",
      style: "normal",
    },
    {
      path: "../../../../node_modules/@fontsource/figtree/files/figtree-latin-500-normal.woff2",
      weight: "500",
      style: "normal",
    },
    {
      path: "../../../../node_modules/@fontsource/figtree/files/figtree-latin-600-normal.woff2",
      weight: "600",
      style: "normal",
    },
    {
      path: "../../../../node_modules/@fontsource/figtree/files/figtree-latin-700-normal.woff2",
      weight: "700",
      style: "normal",
    },
    {
      path: "../../../../node_modules/@fontsource/figtree/files/figtree-latin-800-normal.woff2",
      weight: "800",
      style: "normal",
    },
  ],
  variable: "--font-sans",
  display: "swap",
});

const siteDescription =
  "CareerRat is a Mac app that turns your AI CLI into a personal recruiter. Rate jobs before you apply, use your real experience, and track every outcome.";

export const metadata: Metadata = {
  metadataBase: new URL("https://careerrat.com"),
  title: "CareerRat: Rate. Apply. Track.",
  description: siteDescription,
  applicationName: "CareerRat",
  alternates: { canonical: "/" },
  keywords: [
    "job search",
    "local-first",
    "agentic",
    "resume",
    "career",
    "privacy",
  ],
  openGraph: {
    title: "CareerRat: Rate. Apply. Track.",
    description: siteDescription,
    url: "/",
    siteName: "CareerRat",
    type: "website",
    images: [
      {
        url: "/icon.png",
        width: 512,
        height: 512,
        alt: "CareerRat CR. logo",
      },
    ],
  },
  twitter: {
    card: "summary",
    title: "CareerRat: Rate. Apply. Track.",
    description: siteDescription,
    images: [
      {
        url: "/icon.png",
        width: 512,
        height: 512,
        alt: "CareerRat CR. logo",
      },
    ],
  },
};

export const viewport: Viewport = {
  themeColor: "#edf5fb",
  width: "device-width",
  initialScale: 1,
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" className={figtree.variable}>
      <body>{children}</body>
    </html>
  );
}
