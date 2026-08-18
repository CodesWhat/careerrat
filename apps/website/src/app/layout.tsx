import type { Metadata, Viewport } from "next";
import localFont from "next/font/local";
import "./globals.css";

// Self-hosted variable fonts — no external font CDN at runtime.
const geist = localFont({
  src: "./fonts/GeistVF.woff2",
  weight: "100 900",
  variable: "--font-sans",
  display: "swap",
});

const geistMono = localFont({
  src: "./fonts/GeistMonoVF.woff2",
  weight: "100 900",
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

const siteDescription =
  "CareerRat is a chat-first job-search tracker. Rate the jobs worth chasing, apply with honest evidence-backed artifacts, and track every outcome. Free, local-first, and run by the AI CLI you already have.";

export const metadata: Metadata = {
  title: "CareerRat: Rate. Apply. Track.",
  description: siteDescription,
  applicationName: "CareerRat",
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
    siteName: "CareerRat",
    type: "website",
  },
  twitter: {
    card: "summary_large_image",
    title: "CareerRat: Rate. Apply. Track.",
    description: siteDescription,
  },
};

export const viewport: Viewport = {
  themeColor: "#ececea",
  width: "device-width",
  initialScale: 1,
};

// Inline bootstrap script: sets the `js` class on <html> before paint (the gate
// that hides .reveal content so it can animate in) and installs a POST-LOAD
// failsafe. It deliberately does NOT add the `visible` class itself — the reveal
// IntersectionObserver runs after hydration in SiteInteractions, so the inline
// script never mutates a React-rendered .reveal node before React hydrates (which
// is what caused the hydration mismatch). The failsafe only fires if the app
// bundle never armed the observer (blocked by an ad-blocker / CSP / network), and
// it runs after `load` — well after hydration — so it's mutation-safe. Reduced
// motion is handled purely in CSS (see the prefers-reduced-motion block).
const REVEAL_BOOTSTRAP =
  "(function(){var d=document,de=d.documentElement;de.classList.add('js');function revealAll(){var e=d.querySelectorAll('.reveal');for(var i=0;i<e.length;i++)e[i].classList.add('visible');}function failsafe(){if(!window.__careerratRevealArmed)revealAll();}function schedule(){setTimeout(failsafe,1200);}if(d.readyState==='complete'){schedule();}else{window.addEventListener('load',schedule);}})();";

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html
      lang="en"
      className={`${geist.variable} ${geistMono.variable} ${archivo.variable}`}
      suppressHydrationWarning
    >
      <body>
        {/* Sets the `js` class and arms the reveal IntersectionObserver inline
            so both the gate and the revealer share fate. If the JS bundle is
            blocked but this inline script still runs, .reveal content is still
            revealed. Runs before the sections below it paint. */}
        <script
          dangerouslySetInnerHTML={{
            __html: REVEAL_BOOTSTRAP,
          }}
        />
        {children}
      </body>
    </html>
  );
}
