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

const mono = localFont({
  src: "./fonts/GeistMonoVF.woff2",
  variable: "--font-mono",
  display: "swap",
});

const siteDescription =
  "CareerRat turns the AI CLI you already have into a personal recruiter. It rates jobs, applies with your real experience, and tracks outcomes. Free, MIT.";

export const metadata: Metadata = {
  metadataBase: new URL("https://careerrat.com"),
  title: "CareerRat: AI job search in your terminal",
  description: siteDescription,
  applicationName: "CareerRat",
  alternates: { canonical: "/" },
  openGraph: {
    title: "CareerRat: AI job search in your terminal",
    description: siteDescription,
    url: "/",
    siteName: "CareerRat",
    type: "website",
    images: [
      {
        url: "/opengraph-image.png",
        width: 1200,
        height: 630,
        alt: "CareerRat: Your AI CLI, working your job search.",
      },
    ],
  },
  twitter: {
    card: "summary_large_image",
    title: "CareerRat: AI job search in your terminal",
    description: siteDescription,
    images: [
      {
        url: "/opengraph-image.png",
        width: 1200,
        height: 630,
        alt: "CareerRat: Your AI CLI, working your job search.",
      },
    ],
  },
};

export const viewport: Viewport = {
  themeColor: "#242933",
  width: "device-width",
  initialScale: 1,
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${figtree.variable} ${mono.variable}`}>
      <body>{children}</body>
    </html>
  );
}
