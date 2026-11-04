import { ArrowRight, ClipboardList, Lock, Radar, Target } from "lucide-react";
import { Footer } from "@/components/Footer";
import { TrackedCtaLink } from "@/components/TrackedCtaLink";

const INSTALL_URL = "/docs/getting-started/install";
const STAR_HISTORY_URL =
  "https://www.star-history.com/?repos=codeswhat%2Fcareerrat&type=date&legend=top-left";
const STAR_HISTORY_CHART =
  "https://api.star-history.com/chart?repos=codeswhat/careerrat&type=date&legend=top-left&theme=dark";

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
    copy: "Your workspace lives on your machine. Only the context a task needs goes to the AI provider you picked, under its terms. Searches keep running in the background while you move between tabs, and if something gets interrupted, you get a clear retry instead of losing your place.",
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
              className="button button--primary site-nav__cta"
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
          <div className="hero__intro">
            <div className="hero__heading">
              <p className="eyebrow">CareerRat / Terminal workspace</p>
              <h1 id="hero-title">
                Your job hunt.
                <br />
                <span>In your terminal.</span>
              </h1>
              <p className="hero__copy">
                CareerRat turns the AI CLI you already have into a personal recruiter. It rates the
                jobs worth chasing, applies with your real experience, and tracks what happens. Your
                saved jobs on one side. Your agent on the other.
              </p>
              <div className="button-row">
                <TrackedCtaLink
                  className="button button--primary button--large"
                  href={INSTALL_URL}
                  placement="hero"
                >
                  Install with npm <ArrowRight aria-hidden="true" size={17} strokeWidth={2.2} />
                </TrackedCtaLink>
                <a className="button button--secondary button--large" href="#how-it-works">
                  See how it works
                </a>
              </div>
            </div>
            <div className="quick-start">
              <p className="panel-label">Start here</p>
              <pre>
                <code>
                  <span aria-hidden="true">$ </span>npm i -g careerrat{"\n"}
                  <span aria-hidden="true">$ </span>careerrat start
                </code>
              </pre>
              <p>
                Bring Claude Code or Codex.
                <br />
                Your workspace stays on your machine.
              </p>
              <div className="quick-start__meta">
                <span>MIT licensed</span>
                <span>Local SQLite</span>
              </div>
            </div>
          </div>
          <figure className="terminal-shot">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src="/screenshots/tui-main.png"
              alt="The CareerRat terminal workspace: a table of saved jobs with fit and pay on the left, details for the selected job below it, and the agent chat on the right."
              width={1600}
              height={1031}
              decoding="async"
            />
            <figcaption className="terminal-shot__caption">
              The terminal workspace, shown with demo jobs. Run careerrat start to open yours.
            </figcaption>
          </figure>
        </section>

        <section className="section" id="how-it-works" aria-labelledby="how-title">
          <p className="eyebrow">01 / How it works</p>
          <h2 id="how-title">Rate. Apply. Track.</h2>
          <div className="steps-grid">
            <article className="step-card">
              <span className="step-card__number">01</span>
              <h3>Open it</h3>
              <p>
                Run careerrat start. It finds the AI CLI on your machine and sets itself up. No
                account, no forms.
              </p>
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
                Search opens when setup is ready. It looks in built-in job boards, and finds specialist boards and employer pages on its own as it learns. Nothing counts until Evaluate reads the full posting. You review any missing answers before it fills anything, and CAPTCHAs stay with you. CareerRat submits only after its checks pass; choose manual mode to press Submit yourself.
              </p>
              <span className="status-pill">SWEEP · 9 CUT · 12 RANKED</span>
            </article>
          </div>

          <div className="terminal-shots">
            <figure className="terminal-shot terminal-shot--small">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src="/screenshots/tui-fit.png"
                alt="The Fit report tab listing each requirement from a posting with the evidence from your record and a strong, partial, or gap match."
                width={1600}
                height={1031}
                loading="lazy"
                decoding="async"
              />
              <figcaption className="terminal-shot__caption">
                The Fit report checks the posting against your must-haves, one requirement at a
                time.
              </figcaption>
            </figure>
            <figure className="terminal-shot terminal-shot--small">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src="/screenshots/tui-activity.png"
                alt="The Activity tab showing a search running in the background with sources checked and jobs found so far, above a finished search with a Review new matches button."
                width={1600}
                height={1031}
                loading="lazy"
                decoding="async"
              />
              <figcaption className="terminal-shot__caption">
                Search jobs runs in the background. Keep working while Activity shows its progress.
              </figcaption>
            </figure>
          </div>

          <div className="guardrails-card">
            <p className="eyebrow">What stays in your hands</p>
            <ul className="guardrails-list">
              {/* biome-ignore format: keep on one line so test-pinned phrases stay contiguous */}
              <li>
                When a saved job site is added or first used and a login is needed, CareerRat asks “Do you want to log into LinkedIn so I can use it?” Yes opens that exact search in a visible browser window; No skips it and keeps searching elsewhere.
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
          <p className="eyebrow">02 / Your side of the table</p>
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
              <p className="eyebrow">03 / Get CareerRat</p>
              <h2 id="get-title">One install, and you&apos;re talking.</h2>
              <p className="download-card__copy">
                Run npm i -g careerrat, then careerrat start. The workspace opens in your terminal
                with your agent beside your jobs, and you say hi. Setup is a conversation, not a
                form. Open source under MIT.
              </p>
              <TrackedCtaLink className="button button--primary" href={INSTALL_URL} placement="get">
                Install with npm
              </TrackedCtaLink>
              <p className="download-card__note">
                Needs Node.js 24.22.1 or newer. Also needs Python 3.11 or newer; the first run takes
                about a minute to set up.
              </p>
            </div>
            <div className="engine-card">
              <p className="eyebrow">You&apos;ll need an AI CLI</p>
              <p>
                Pick Claude Code (2.1.241 or newer) or OpenAI Codex. Either one runs the same
                CareerRat-owned workflows and skills. CareerRat invokes it directly and never falls
                back to another provider.
              </p>
              <p>
                Automatic picks the right level for each task: complex judgment stays strong, while
                web searches and small helpers stay efficient. You can instead choose Faster,
                Balanced, or Best, and set Thinking depth to Automatic, Low, Medium, or High. Those
                controls work the same with Claude Code or OpenAI Codex.
              </p>
              <ul className="engine-pills" aria-label="Detected AI CLI support">
                <li className="engine-pill">Claude Code</li>
                <li className="engine-pill">OpenAI Codex</li>
                <li className="engine-pill">Same CareerRat workflow</li>
              </ul>
              <p className="engine-card__note">
                A runtime appears ready only when it is available, signed in, and passes its
                readiness check. CareerRat itself costs nothing; your AI provider may have its own
                plan or usage costs. Update any time with careerrat update.
              </p>
            </div>
          </div>
        </section>

        <section className="section" id="star-history" aria-labelledby="star-history-title">
          <p className="eyebrow">04 / Open source</p>
          <h2 id="star-history-title">Star history</h2>
          <a
            className="star-history"
            href={STAR_HISTORY_URL}
            target="_blank"
            rel="noopener noreferrer"
          >
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={STAR_HISTORY_CHART}
              alt="Star history chart for CodesWhat/careerrat"
              width={800}
              height={533}
              loading="lazy"
              decoding="async"
            />
          </a>
        </section>

        <section className="section" aria-labelledby="final-title">
          <div className="final-cta">
            <BrandMark compact />
            <h2 id="final-title">Ready when you are.</h2>
            <p>Install it and start talking.</p>
            <div className="button-row">
              <TrackedCtaLink
                className="button button--primary button--large"
                href={INSTALL_URL}
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
