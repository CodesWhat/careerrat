import Image from "next/image";

// Locked: Footer = brand-peer band — product left, CodesWhat pill right.
// Pattern: codeswhat-components/templates/web-shell/src/components/footer.tsx,
// recreated in this site's plain-CSS idiom (no Tailwind here).

const CODESWHAT = "https://github.com/CodesWhat";
const YEAR = new Date().getFullYear();
const BLURB =
  "CareerRat is a Mac app that turns your AI CLI into a personal recruiter. Rate jobs before you apply, use your real experience, and track every outcome.";
const LICENSE_URL = "https://github.com/CodesWhat/careerrat/blob/main/LICENSE";

type FooterLink = { label: string; href: string; external?: boolean };

const productLinks: FooterLink[] = [
  { label: "Docs", href: "/docs" },
  {
    label: "Code signing policy",
    href: "https://github.com/CodesWhat/careerrat/blob/main/docs/CODE_SIGNING_POLICY.md",
    external: true,
  },
];

const projectLinks: FooterLink[] = [
  { label: "GitHub", href: "https://github.com/CodesWhat/careerrat", external: true },
  { label: "Releases", href: "https://github.com/CodesWhat/careerrat/releases", external: true },
  { label: "License", href: LICENSE_URL, external: true },
];

function FooterLinkEl({ link }: { link: FooterLink }) {
  return (
    <a
      href={link.href}
      target={link.external ? "_blank" : undefined}
      rel={link.external ? "noopener noreferrer" : undefined}
    >
      {link.label}
    </a>
  );
}

function FooterColumn({ heading, links }: { heading: string; links: FooterLink[] }) {
  return (
    <div className="footer__column">
      <p className="footer__column-heading">{heading}</p>
      {links.map((link) => (
        <FooterLinkEl key={link.label} link={link} />
      ))}
    </div>
  );
}

export function Footer() {
  return (
    <footer className="footer">
      {/* Brand band + columns share one row — brand on the left, links on the right */}
      <div className="footer__top">
        <div className="footer__brand-block">
          <span className="footer__brand">CareerRat</span>
          <p className="footer__blurb">{BLURB}</p>
        </div>
        <div className="footer__columns">
          <FooterColumn heading="Product" links={productLinks} />
          <FooterColumn heading="Project" links={projectLinks} />
        </div>
      </div>

      {/* Legal — CodesWhat pill signs off on the right */}
      <div className="footer__legal">
        <span className="footer__copyright">
          &copy; {YEAR} CodesWhat. Released under the{" "}
          <a href={LICENSE_URL} target="_blank" rel="noopener noreferrer">
            MIT License
          </a>
          .
        </span>
        <a
          className="codeswhat-badge"
          href={CODESWHAT}
          target="_blank"
          rel="noopener noreferrer"
          aria-label="A CodesWhat project"
        >
          <Image src="/codeswhat-logo.png" alt="" width={20} height={20} />
          <span>A CodesWhat project</span>
        </a>
      </div>
    </footer>
  );
}
