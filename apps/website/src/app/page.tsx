import Image from "next/image";
import {
  ArrowRight,
  ClipboardList,
  FileUp,
  LoaderCircle,
  Lock,
  Radar,
  Target,
} from "lucide-react";
import { TrackedCtaLink } from "@/components/TrackedCtaLink";

const RELEASE_URL = "https://github.com/CodesWhat/careerrat/releases/latest";

function BrandMark({ compact = false }: { compact?: boolean }) {
  if (compact) {
    return (
      <span className="brand-mark brand-mark--compact" aria-hidden="true">
        <span>Career</span>
        <span>Rat.</span>
      </span>
    );
  }

  return (
    <span className="brand-mark" aria-hidden="true">
      <span>Career</span>
      <span>Rat.</span>
    </span>
  );
}

const features = [
  {
    title: "Rate before you apply",
    copy: "Every posting is scored against your constraints first. No cover letters for jobs that don't fit.",
    Icon: ClipboardList,
  },
  {
    title: "Aligned, not fabricated",
    copy: "It reframes your real experience to match the role and refuses to invent anything that isn't yours.",
    Icon: Target,
  },
  {
    title: "Runs the whole pipeline",
    copy: "Sweeps, follow-ups, comp research, interview prep, and outcomes. One agent, end to end.",
    Icon: Radar,
  },
  {
    title: "On your machine",
    copy: "Your résumé, comp numbers, and pipeline live in a local workspace you can inspect and own.",
    Icon: Lock,
  },
];

export default function Home() {
  return (
    <div className="site-shell">
      <a className="skip-link" href="#main-content">
        Skip to content
      </a>
      <nav className="site-nav" aria-label="Main navigation">
        <div className="site-nav__inner">
          <a className="wordmark" href="#top" aria-label="CareerRat home">
            CareerRat
          </a>
          <div className="site-nav__links">
            <a className="site-nav__optional" href="#how-it-works">
              How it works
            </a>
            <a href="/docs">Docs</a>
            <a
              className="site-nav__optional"
              href="https://github.com/CodesWhat/careerrat"
              target="_blank"
              rel="noopener noreferrer"
            >
              GitHub
            </a>
            <TrackedCtaLink className="button button--lime site-nav__cta" href="#get" placement="header">
              Get CareerRat <ArrowRight aria-hidden="true" size={14} strokeWidth={2.2} />
            </TrackedCtaLink>
          </div>
        </div>
      </nav>

      <main id="main-content">
        <section className="hero" id="top" aria-labelledby="hero-title">
          <BrandMark />
          <h1 id="hero-title">Your job hunt, run by a rat.</h1>
          <p className="hero__copy">CareerRat is a Mac app that turns the AI CLI you already have into a personal recruiter. It rates the jobs worth chasing, applies with your real experience, and tracks what happens.</p>
          <div className="button-row">
            <TrackedCtaLink
              className="button button--lime button--large"
              href={RELEASE_URL}
              target="_blank"
              rel="noopener noreferrer"
              placement="hero"
            >
              Download for Mac <ArrowRight aria-hidden="true" size={17} strokeWidth={2.2} />
            </TrackedCtaLink>
            <a className="button button--white button--large" href="#how-it-works">
              See how it works
            </a>
          </div>
        </section>

        <section className="section" id="how-it-works" aria-labelledby="how-title">
          <p className="eyebrow">How it works</p>
          <h2 id="how-title">Rate. Apply. Track.</h2>
          <div className="steps-grid">
            <article className="step-card">
              <span className="step-card__number">01</span>
              <h3>Open it</h3>
              <p>It finds the AI CLI on your machine and sets itself up. No account, no forms.</p>
              <span className="status-pill status-pill--active">LOCAL AI CLI · READY</span>
            </article>
            <article className="step-card">
              <span className="step-card__number">02</span>
              <h3>Tell it what you want</h3>
              <p>Drop your résumé, then answer a short interview about roles, comp floor, and dealbreakers.</p>
              <span className="status-pill">ROLES ✓ · GUARDRAILS ✓</span>
            </article>
            <article className="step-card">
              <span className="step-card__number">03</span>
              <h3>It hunts, you decide</h3>
              <p>It sweeps boards, cuts the misses, ranks the rest, and preps applications. Nothing is sent without you.</p>
              <span className="status-pill">SWEEP · 9 CUT · 12 RANKED</span>
            </article>
          </div>

          <div className="chat-demo" aria-label="Example CareerRat conversation">
            <div className="chat-demo__user">what should the Cyberdyne staff role pay?</div>
            <div className="chat-demo__agent-row">
              <span className="chat-demo__avatar" aria-hidden="true">
                CR
              </span>
              <div className="chat-demo__agent">
                Checking now. I&apos;ll compare the posting against your floor of $210k.
                <div className="activity-list" aria-label="Agent activity">
                  <span className="activity-pill activity-pill--running">
                    <LoaderCircle className="activity-spinner" aria-hidden="true" size={13} />
                    Searching the web
                  </span>
                  <span className="activity-pill">
                    <FileUp aria-hidden="true" size={13} />
                    Read evidence-bank.md
                  </span>
                  <span className="activity-pill">
                    <Radar aria-hidden="true" size={13} />
                    Compared 4 sources
                  </span>
                </div>
              </div>
            </div>
            <p className="chat-demo__caption">You watch it read, search, and write as it works.</p>
          </div>
        </section>

        <section className="section" aria-labelledby="features-title">
          <p className="eyebrow">Their side has agents. Now yours does.</p>
          <h2 id="features-title">An agent for your side of the table.</h2>
          <p className="section__intro">
            Companies screen you with software. CareerRat aligns your experience to the role, gets you past the ATS, and only spends your time on jobs you could actually get.
          </p>
          <div className="feature-grid">
            {features.map(({ title, copy, Icon }) => (
              <article className="feature-card" key={title}>
                <span className="feature-card__icon" aria-hidden="true">
                  <Icon size={19} strokeWidth={2} />
                </span>
                <div>
                  <h3>{title}</h3>
                  <p>{copy}</p>
                </div>
              </article>
            ))}
          </div>
        </section>

        <section className="section" id="get" aria-labelledby="get-title">
          <div className="download-card">
            <div>
              <p className="eyebrow">Get CareerRat</p>
              <h2 id="get-title">One download, and you&apos;re talking.</h2>
              <p className="download-card__copy">
                Download the app, open it, say hi. Setup is a conversation, not a form. Open source under MIT.
              </p>
              <TrackedCtaLink
                className="button button--lime"
                href={RELEASE_URL}
                target="_blank"
                rel="noopener noreferrer"
                placement="get"
              >
                Download for Mac
              </TrackedCtaLink>
              <p className="download-card__note">Signed and notarized, for Apple Silicon Macs on macOS 12 or newer.</p>
            </div>
            <div className="engine-card">
              <p className="eyebrow">You&apos;ll need an AI CLI</p>
              <p>
                Pick Claude Code or OpenAI Codex. Either one runs the same CareerRat-owned workflows and skills. CareerRat invokes it directly and never falls back to another provider.
              </p>
              <div className="engine-pills" role="list" aria-label="Detected AI CLI support">
                <span className="engine-pill" role="listitem">
                  Claude Code
                </span>
                <span className="engine-pill" role="listitem">
                  OpenAI Codex
                </span>
                <span className="engine-pill" role="listitem">
                  Same CareerRat workflow
                </span>
              </div>
              <p className="engine-card__note">
                A runtime appears ready only when it is available, signed in, and passes its readiness check. CareerRat itself costs nothing, and the app never silently installs an update.
              </p>
            </div>
          </div>
        </section>

        <section className="section" aria-labelledby="final-title">
          <div className="final-cta">
            <BrandMark compact />
            <h2 id="final-title">Ready when you are.</h2>
            <p>Download it and start talking.</p>
            <div className="button-row">
              <TrackedCtaLink className="button button--ink button--large" href={RELEASE_URL} placement="final">
                Get CareerRat
              </TrackedCtaLink>
              <a className="button button--outline button--large" href="#how-it-works">
                How it works
              </a>
            </div>
          </div>
        </section>
      </main>

      <footer className="footer">
        <div className="footer__links">
          <span className="footer__brand">CareerRat</span>
          <a href="/docs">Docs</a>
          <a href="https://github.com/CodesWhat/careerrat">GitHub</a>
          <a href="https://github.com/CodesWhat/careerrat/releases">Releases</a>
          <a href="https://github.com/CodesWhat/careerrat/blob/main/docs/CODE_SIGNING_POLICY.md">
            Code signing policy
          </a>
          <a href="https://github.com/CodesWhat/careerrat/blob/main/LICENSE">MIT License</a>
        </div>
        <a
          className="codeswhat-badge"
          href="https://codeswhat.com"
          target="_blank"
          rel="noopener noreferrer"
          aria-label="A CodesWhat project"
        >
          <Image src="/codeswhat-logo.png" alt="" width={20} height={20} />
          <span>A CodesWhat project</span>
        </a>
        <span className="footer__copyright">© 2026 CodesWhat</span>
      </footer>
    </div>
  );
}
