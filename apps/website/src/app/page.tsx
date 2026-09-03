import { ArrowRight, ClipboardList, FileUp, LoaderCircle, Lock, Radar, Target } from "lucide-react";
import { Footer } from "@/components/Footer";
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
    copy: "Every full posting gets checked against your location, pay, and other must-haves before you write a word. No cover letters for jobs that don't fit.",
    Icon: ClipboardList,
  },
  {
    title: "Aligned, not fabricated",
    copy: "It shapes your real experience to fit the role, and it never invents anything that isn't yours.",
    Icon: Target,
  },
  {
    title: "Search broadly, verify honestly",
    copy: "Built-in job-board sources search for the roles you set. CareerRat also searches the open web to catch postings other tools miss, and finds specialist boards and employer pages as it learns your search. Every open-web lead stays unverified until Evaluate actually reads the posting.",
    Icon: Radar,
  },
  {
    title: "On your machine",
    copy: "Your data stays local. It keeps working in the background as you move between views, and if something gets interrupted, you get a clear retry instead of losing your place.",
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
            <TrackedCtaLink
              className="button button--lime site-nav__cta"
              href="#get"
              placement="header"
            >
              Get CareerRat <ArrowRight aria-hidden="true" size={14} strokeWidth={2.2} />
            </TrackedCtaLink>
          </div>
        </div>
      </nav>

      <main id="main-content">
        <section className="hero" id="top" aria-labelledby="hero-title">
          <BrandMark />
          <h1 id="hero-title">Your job hunt, run by a rat.</h1>
          <p className="hero__copy">
            CareerRat is a Mac app that turns the AI CLI you already have into a personal recruiter.
            It rates the jobs worth chasing, applies with your real experience, and tracks what
            happens.
          </p>
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
              {/* biome-ignore format: keep on one line so test-pinned phrases stay contiguous */}
              <p>
                Drop your résumé, then answer short questions in plain English, like what would make one job worth applying to before another.
              </p>
              <span className="status-pill">ROLES ✓ · GUARDRAILS ✓</span>
            </article>
            <article className="step-card">
              <span className="step-card__number">03</span>
              <h3>It hunts, you decide</h3>
              {/* biome-ignore format: keep on one line so test-pinned phrases stay contiguous */}
              <p>
                Search opens when setup is ready. It looks in built-in job boards, and finds specialist boards and employer pages on its own as it learns. Nothing counts until Evaluate reads the full posting. You review any missing answers before it fills anything, and CAPTCHAs and Submit stay with you.
              </p>
              <span className="status-pill">SWEEP · 9 CUT · 12 RANKED</span>
            </article>
          </div>

          {/* biome-ignore lint/a11y/useAriaPropsSupportedByRole: existing pattern, out of scope for this copy pass */}
          <div className="chat-demo" aria-label="Example CareerRat conversation">
            <div className="chat-demo__user">what should the Cyberdyne staff role pay?</div>
            <div className="chat-demo__agent-row">
              <span className="chat-demo__avatar" aria-hidden="true">
                CR
              </span>
              <div className="chat-demo__agent">
                Checking now. I&apos;ll compare the posting against your floor of $210k.
                {/* biome-ignore lint/a11y/useAriaPropsSupportedByRole: existing pattern, out of scope for this copy pass */}
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

          <div className="guardrails-card">
            <p className="eyebrow">What stays in your hands</p>
            <ul className="guardrails-list">
              {/* biome-ignore format: keep on one line so test-pinned phrases stay contiguous */}
              <li>
                When a saved job site is added or first used and a login is needed, CareerRat asks “Do you want to log into LinkedIn so I can use it?” Yes opens that exact search in the visible app browser; No skips it and keeps searching elsewhere.
              </li>
              {/* biome-ignore format: keep on one line so test-pinned phrases stay contiguous */}
              <li>
                It fills safe application fields for you, but only after you review any missing answers.
              </li>
              {/* biome-ignore format: keep on one line so test-pinned phrases stay contiguous */}
              <li>
                Voluntary questions stay blank by default; local Application defaults can choose a decline option when available.
              </li>
              <li>
                Anything found this way stays unverified until Evaluate reads the full posting for
                location, office days, pay, and fit.
              </li>
            </ul>
          </div>
        </section>

        <section className="section" aria-labelledby="features-title">
          <p className="eyebrow">Their side has agents. Now yours does.</p>
          <h2 id="features-title">An agent for your side of the table.</h2>
          <p className="section__intro">
            Companies screen you with software. CareerRat aligns your experience to the role, gets
            you past the ATS, and only spends your time on jobs you could actually get.
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
                Download the app, open it, say hi. Setup is a conversation, not a form. Open source
                under MIT.
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
              <p className="download-card__note">
                Signed and notarized, for Apple Silicon Macs on macOS 12 or newer.
              </p>
            </div>
            <div className="engine-card">
              <p className="eyebrow">You&apos;ll need an AI CLI</p>
              {/* biome-ignore format: keep on one line so test-pinned phrases stay contiguous */}
              <p>
                Pick Claude Code (2.1.241 or newer) or OpenAI Codex. Either one runs the same CareerRat-owned workflows and skills. CareerRat invokes it directly and never falls back to another provider.
              </p>
              <p>
                Automatic picks the right level for each task: complex judgment stays strong, while
                web searches and small helpers stay efficient. You can instead choose Faster,
                Balanced, or Best, and set Thinking depth to Automatic, Low, Medium, or High. Those
                controls work the same with Claude Code or OpenAI Codex.
              </p>
              {/* biome-ignore lint/a11y/useSemanticElements: existing role="list" pattern, out of scope for this copy pass */}
              <div className="engine-pills" role="list" aria-label="Detected AI CLI support">
                {/* biome-ignore lint/a11y/useSemanticElements: existing role="listitem" pattern, out of scope for this copy pass */}
                <span className="engine-pill" role="listitem">
                  Claude Code
                </span>
                {/* biome-ignore lint/a11y/useSemanticElements: existing role="listitem" pattern, out of scope for this copy pass */}
                <span className="engine-pill" role="listitem">
                  OpenAI Codex
                </span>
                {/* biome-ignore lint/a11y/useSemanticElements: existing role="listitem" pattern, out of scope for this copy pass */}
                <span className="engine-pill" role="listitem">
                  Same CareerRat workflow
                </span>
              </div>
              {/* biome-ignore format: keep on one line so test-pinned phrases stay contiguous */}
              <p className="engine-card__note">
                A runtime appears ready only when it is available, signed in, and passes its readiness check. CareerRat itself costs nothing; your AI provider may have its own plan or usage costs. Signed Mac updates download in the app and wait for you to choose Restart and install.
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
              <TrackedCtaLink
                className="button button--ink button--large"
                href={RELEASE_URL}
                placement="final"
              >
                Get CareerRat
              </TrackedCtaLink>
              <a className="button button--outline button--large" href="#how-it-works">
                How it works
              </a>
            </div>
          </div>
        </section>
      </main>

      <Footer />
    </div>
  );
}
