import DashboardPreview from "@/components/DashboardPreview";
import SiteInteractions from "@/components/SiteInteractions";

export default function Home() {
  return (
    <>
      {/* ─── NAV ─────────────────────────────────── */}
      <nav aria-label="Main navigation">
        <div className="wrap nav-inner">
          <a className="nav-logo" href="#" aria-label="CareerRat home">
            CareerRat<span className="nav-logo-dot">.</span>
          </a>
          <ul className="nav-links nav-mobile-hide" role="list">
            <li>
              <a href="#how-it-works">How it works</a>
            </li>
            <li>
              <a href="#pricing">Pricing</a>
            </li>
            <li>
              <a href="#privacy">Privacy</a>
            </li>
            <li>
              <a href="/docs">Docs</a>
            </li>
            <li>
              <a
                href="https://github.com/CodesWhat/careerrat"
                target="_blank"
                rel="noopener noreferrer"
              >
                GitHub
              </a>
            </li>
            <li>
              <a href="#get" className="nav-cta">
                Get CareerRat →
              </a>
            </li>
          </ul>
        </div>
      </nav>

      {/* ─── HERO ─────────────────────────────────── */}
      <section className="hero" aria-labelledby="hero-h1">
        <div className="wrap hero-inner">
          <div className="hero-copy">
            <div className="hero-eyebrow receipt reveal" aria-hidden="true">
              Free · Local · Runs on your own AI CLI
            </div>
            <h1 className="hero-h1 reveal reveal-delay-1" id="hero-h1">
              Your job hunt, run by a rat.
            </h1>
            <p className="hero-sub reveal reveal-delay-2">
              CareerRat rates the postings actually worth chasing, applies
              with honest artifacts drawn from your own evidence, and tracks
              every outcome. It runs on the AI CLI you already have — Claude
              Code, Codex, or anything else on your PATH.
            </p>
            <div className="hero-actions reveal reveal-delay-3">
              <a href="#get" className="btn-primary">
                Get started — free &amp; open source
                <svg
                  width="16"
                  height="16"
                  viewBox="0 0 16 16"
                  fill="currentColor"
                  aria-hidden="true"
                >
                  <path
                    d="M3 8h10M9 4l4 4-4 4"
                    stroke="currentColor"
                    strokeWidth="1.8"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    fill="none"
                  />
                </svg>
              </a>
              <a href="#how-it-works" className="btn-secondary">
                See how it works
              </a>
            </div>
            <div className="hero-actions reveal reveal-delay-4">
              <span className="hero-command receipt">
                npm i -g careerrat
              </span>
            </div>
            <div className="hero-cli-note receipt reveal reveal-delay-4">
              Works with Claude Code · Codex · Gemini · any text-in, text-out
              command
            </div>
          </div>
          <div className="hero-visual reveal reveal-delay-2">
            <DashboardPreview />
          </div>
        </div>
      </section>

      {/* ─── HOW IT WORKS ─────────────────────────── */}
      <section id="how-it-works" aria-labelledby="steps-h2">
        <div className="wrap">
          <div className="reveal">
            <div className="section-label">How it works</div>
            <h2 className="section-h2" id="steps-h2">
              Three steps, no forms up front.
            </h2>
            <p className="section-sub">
              Rate what&apos;s worth chasing, apply with real evidence, track
              what happens next. That&apos;s the whole loop — R, A, T.
            </p>
          </div>
          <div className="steps-grid">
            <div className="step-card reveal reveal-delay-1">
              <div className="step-index receipt">01</div>
              <h3 className="step-h3">Point it at your CLI</h3>
              <p className="step-p">
                On first launch it finds the AI CLIs already installed. Pick
                one — your subscription, your machine, nothing leaves it.
              </p>
              <span className="step-chip step-chip-success">
                CLAUDE CODE · DETECTED · V2.3
              </span>
            </div>

            <div className="step-card reveal reveal-delay-2">
              <div className="step-index receipt">02</div>
              <h3 className="step-h3">Talk to it</h3>
              <p className="step-p">
                Drop your résumé and answer a short interview. CareerRat
                fills its own file as you talk — roles, floors, dealbreakers —
                and you can edit any of it by hand.
              </p>
              <span className="step-chip">
                ROLES ✓ · GUARDRAILS ✓ · TARGETING.YML UPDATED
              </span>
            </div>

            <div className="step-card reveal reveal-delay-3">
              <div className="step-index receipt">03</div>
              <h3 className="step-h3">It hunts, you decide</h3>
              <p className="step-p">
                Sweeps run in the background: pull, dedupe, cut, rank, prep.
                Everything it does leaves a receipt, and nothing is sent
                without you.
              </p>
              <span className="step-chip">
                SWEEP 6:12 AM · 9 CUT · 12 RANKED · AI · CLAUDE CODE
              </span>
            </div>
          </div>
        </div>
      </section>

      {/* ─── HONESTY ───────────────────────────────── */}
      <section aria-labelledby="honesty-h2">
        <div className="wrap">
          <div className="honesty-section reveal">
            <div className="section-label">It won&apos;t lie for you</div>
            <h2 className="section-h2" id="honesty-h2">
              That&apos;s the point.
            </h2>
            <p className="section-sub">
              Honest tailoring isn&apos;t a limitation — it&apos;s a design
              choice. Applications that overclaim don&apos;t hold up in
              interviews. Artifacts built from your real evidence do.
            </p>
            <div className="honesty-grid">
              <div className="honesty-point">
                <div className="honesty-icon" aria-hidden="true">
                  🏦
                </div>
                <div className="honesty-point-text">
                  <h4>Evidence bank, not a word bank</h4>
                  <p>
                    You build a bank of real things you did — projects,
                    metrics, decisions. Every tailored artifact draws only
                    from that bank.
                  </p>
                </div>
              </div>
              <div className="honesty-point">
                <div className="honesty-icon" aria-hidden="true">
                  🚫
                </div>
                <div className="honesty-point-text">
                  <h4>Refuses to invent facts</h4>
                  <p>
                    If a claim isn&apos;t in your evidence, it won&apos;t
                    write it. No hallucinated roles. No inflated titles. No
                    fake metrics.
                  </p>
                </div>
              </div>
              <div className="honesty-point">
                <div className="honesty-icon" aria-hidden="true">
                  🎯
                </div>
                <div className="honesty-point-text">
                  <h4>Tailored, not fabricated</h4>
                  <p>
                    It reorders, reframes, and emphasises what genuinely fits
                    the role. That&apos;s tailoring. That&apos;s honest.
                  </p>
                </div>
              </div>
              <div className="honesty-point">
                <div className="honesty-icon" aria-hidden="true">
                  📋
                </div>
                <div className="honesty-point-text">
                  <h4>Rate before you apply</h4>
                  <p>
                    Every posting gets rated against your constraints before
                    tailoring starts. You never write a cover letter for a
                    job that doesn&apos;t fit.
                  </p>
                </div>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* ─── PRIVACY ───────────────────────────────── */}
      <section id="privacy" aria-labelledby="privacy-h2">
        <div className="wrap">
          <div className="privacy-inner">
            <div className="privacy-visual reveal">
              <div className="privacy-card">
                <div className="privacy-card-icon" aria-hidden="true">
                  🔒
                </div>
                <h3>Your stuff stays yours.</h3>
                <p>
                  Run CareerRat on your own machine and your résumé, comp
                  numbers, evidence bank, and full pipeline stay on your
                  laptop. No account to create, no telemetry, nothing syncing
                  in the background.
                </p>
                <div className="privacy-chips" role="list">
                  <span className="privacy-chip" role="listitem">
                    <svg
                      width="11"
                      height="11"
                      viewBox="0 0 11 11"
                      fill="currentColor"
                      aria-hidden="true"
                    >
                      <circle cx="5.5" cy="5.5" r="5.5" />
                    </svg>
                    runs locally
                  </span>
                  <span className="privacy-chip" role="listitem">
                    <svg
                      width="11"
                      height="11"
                      viewBox="0 0 11 11"
                      fill="currentColor"
                      aria-hidden="true"
                    >
                      <circle cx="5.5" cy="5.5" r="5.5" />
                    </svg>
                    no account
                  </span>
                  <span className="privacy-chip" role="listitem">
                    <svg
                      width="11"
                      height="11"
                      viewBox="0 0 11 11"
                      fill="currentColor"
                      aria-hidden="true"
                    >
                      <circle cx="5.5" cy="5.5" r="5.5" />
                    </svg>
                    no telemetry
                  </span>
                  <span className="privacy-chip" role="listitem">
                    <svg
                      width="11"
                      height="11"
                      viewBox="0 0 11 11"
                      fill="currentColor"
                      aria-hidden="true"
                    >
                      <circle cx="5.5" cy="5.5" r="5.5" />
                    </svg>
                    zero runtime deps
                  </span>
                  <span className="privacy-chip" role="listitem">
                    <svg
                      width="11"
                      height="11"
                      viewBox="0 0 11 11"
                      fill="currentColor"
                      aria-hidden="true"
                    >
                      <circle cx="5.5" cy="5.5" r="5.5" />
                    </svg>
                    free
                  </span>
                </div>
              </div>
            </div>
            <div className="privacy-copy reveal reveal-delay-2">
              <div className="section-label">Privacy as warmth</div>
              <h2 className="section-h2" id="privacy-h2">
                Self-host it, and your data stays your own.
              </h2>
              <p className="section-sub">
                Job searches are personal. Your comp floor, your reasons for
                leaving, your backup options — run CareerRat yourself and all
                of it stays on your machine, full stop.
              </p>
              <p className="section-sub" style={{ marginTop: "16px" }}>
                No signup, no telemetry, nothing phoned home. The self-host
                version runs on your machine and uses the AI CLI you already
                have. What you put in stays in.
              </p>
            </div>
          </div>
        </div>
      </section>

      {/* ─── AI AGNOSTIC ──────────────────────────── */}
      <section aria-labelledby="ai-h2">
        <div className="wrap">
          <div className="ai-section reveal">
            <div className="ai-section-inner">
              <div>
                <div className="section-label">Agent runtime</div>
                <h2 className="section-h2" id="ai-h2">
                  Works with your favorite AI.
                </h2>
                <p className="section-sub">
                  CareerRat is an agent runtime. It doesn&apos;t lock you
                  into a model or a subscription. Bring whatever AI CLI you
                  already use — Claude Code, Codex, or anything else on your
                  PATH.
                </p>
                <div className="ai-chip-group">
                  <div className="ai-chip-group-title">CLI launch options</div>
                  <div className="ai-chips" role="list">
                    <span className="ai-chip" role="listitem">
                      <svg
                        className="ai-chip-logo ai-chip-logo-claude"
                        role="img"
                        viewBox="0 0 24 24"
                        xmlns="http://www.w3.org/2000/svg"
                      >
                        <title>Claude Code</title>
                        <path
                          d="M20.998 10.949H24v3.102h-3v3.028h-1.487V20H18v-2.921h-1.487V20H15v-2.921H9V20H7.488v-2.921H6V20H4.487v-2.921H3V14.05H0V10.95h3V5h17.998v5.949zM6 10.949h1.488V8.102H6v2.847zm10.51 0H18V8.102h-1.49v2.847z"
                          fill="#D97757"
                        />
                      </svg>
                      Claude Code
                    </span>
                    <span className="ai-chip" role="listitem">
                      <svg
                        className="ai-chip-logo ai-chip-logo-codex"
                        role="img"
                        viewBox="0 0 24 24"
                        xmlns="http://www.w3.org/2000/svg"
                      >
                        <title>OpenAI Codex</title>
                        <path
                          d="M19.503 0H4.496A4.496 4.496 0 000 4.496v15.007A4.496 4.496 0 004.496 24h15.007A4.496 4.496 0 0024 19.503V4.496A4.496 4.496 0 0019.503 0z"
                          fill="#fff"
                        />
                        <path
                          d="M9.064 3.344a4.578 4.578 0 012.285-.312c1 .115 1.891.54 2.673 1.275.01.01.024.017.037.021a.09.09 0 00.043 0 4.55 4.55 0 013.046.275l.047.022.116.057a4.581 4.581 0 012.188 2.399c.209.51.313 1.041.315 1.595a4.24 4.24 0 01-.134 1.223.123.123 0 00.03.115c.594.607.988 1.33 1.183 2.17.289 1.425-.007 2.71-.887 3.854l-.136.166a4.548 4.548 0 01-2.201 1.388.123.123 0 00-.081.076c-.191.551-.383 1.023-.74 1.494-.9 1.187-2.222 1.846-3.711 1.838-1.187-.006-2.239-.44-3.157-1.302a.107.107 0 00-.105-.024c-.388.125-.78.143-1.204.138a4.441 4.441 0 01-1.945-.466 4.544 4.544 0 01-1.61-1.335c-.152-.202-.303-.392-.414-.617a5.81 5.81 0 01-.37-.961 4.582 4.582 0 01-.014-2.298.124.124 0 00.006-.056.085.085 0 00-.027-.048 4.467 4.467 0 01-1.034-1.651 3.896 3.896 0 01-.251-1.192 5.189 5.189 0 01.141-1.6c.337-1.112.982-1.985 1.933-2.618.212-.141.413-.251.601-.33.215-.089.43-.164.646-.227a.098.098 0 00.065-.066 4.51 4.51 0 01.829-1.615 4.535 4.535 0 011.837-1.388zm3.482 10.565a.637.637 0 000 1.272h3.636a.637.637 0 100-1.272h-3.636zM8.462 9.23a.637.637 0 00-1.106.631l1.272 2.224-1.266 2.136a.636.636 0 101.095.649l1.454-2.455a.636.636 0 00.005-.64L8.462 9.23z"
                          fill="url(#ai-logo-codex-gradient)"
                        />
                        <defs>
                          <linearGradient
                            id="ai-logo-codex-gradient"
                            x1="12"
                            x2="12"
                            y1="3"
                            y2="21"
                            gradientUnits="userSpaceOnUse"
                          >
                            <stop stopColor="#B1A7FF" />
                            <stop offset=".5" stopColor="#7A9DFF" />
                            <stop offset="1" stopColor="#3941FF" />
                          </linearGradient>
                        </defs>
                      </svg>
                      OpenAI Codex
                    </span>
                    <span className="ai-chip" role="listitem">
                      <svg
                        className="ai-chip-logo ai-chip-logo-path"
                        role="img"
                        viewBox="0 0 24 24"
                        xmlns="http://www.w3.org/2000/svg"
                      >
                        <title>any CLI on PATH</title>
                        <rect width="24" height="24" rx="7" fill="#17171A" />
                        <path
                          d="M6.5 8.4L9.9 12l-3.4 3.6M12.2 15.5h5.3"
                          fill="none"
                          stroke="#FBFBF9"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          strokeWidth="1.9"
                        />
                      </svg>
                      any CLI on PATH
                    </span>
                  </div>
                </div>
              </div>
              <div>
                <div
                  className="terminal-sticker"
                  role="region"
                  aria-label="Example start command"
                >
                  <div className="terminal-dots" aria-hidden="true">
                    <div className="terminal-dot terminal-dot-red" />
                    <div className="terminal-dot terminal-dot-yellow" />
                    <div className="terminal-dot terminal-dot-green" />
                  </div>
                  <div className="terminal-prompt">~ careerrat $</div>
                  <div className="terminal-command">
                    careerrat start claude
                    <span className="terminal-cursor" aria-hidden="true" />
                  </div>
                  <div className="terminal-comment">
                    # scaffold → skills → dashboard → agent handoff
                    <br /># one command, then the agent takes it from here
                  </div>
                </div>
                <p
                  style={{
                    marginTop: "16px",
                    fontSize: "0.85rem",
                    color: "var(--ink-soft)",
                    lineHeight: 1.5,
                  }}
                >
                  CareerRat scaffolds the workspace, installs skills, starts
                  the dashboard, and hands off to a supported agent CLI.
                  Model choice, cost, and local data stay under local
                  control.
                </p>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* ─── PRICING ───────────────────────────────── */}
      <section id="pricing" aria-labelledby="pricing-h2">
        <div className="wrap">
          <div className="reveal">
            <div className="section-label">Pricing</div>
            <h2 className="section-h2" id="pricing-h2">
              Free is the product.
            </h2>
            <p className="section-sub">
              With your own CLI you get all of it — the AI features
              included. No account, no sign-in, no trial clock.
            </p>
          </div>
          <div className="pricing-grid">
            <div className="pricing-card reveal reveal-delay-1">
              <div className="pricing-card-head">
                <h3 className="pricing-card-name">Free</h3>
                <span className="pricing-card-tag receipt">
                  $0 · bring your CLI
                </span>
              </div>
              <p className="pricing-card-p">
                The whole app. AI features run on your installed CLI — your
                subscription, your machine.
              </p>
              <ul className="pricing-list">
                <li>Board pulls, dedupe, tracking</li>
                <li>Fit scores + guardrail cuts</li>
                <li>Interview prep + tailored drafts</li>
                <li>Calendar, network, library</li>
                <li>Local files you own — plain YAML</li>
              </ul>
              <a href="#get" className="btn-primary pricing-cta">
                Get started free
              </a>
            </div>
            <div className="pricing-card reveal reveal-delay-2">
              <div className="pricing-card-head">
                <h3 className="pricing-card-name">Hosted AI</h3>
                <span className="pricing-card-tag pricing-card-tag-soon receipt">
                  Coming soon
                </span>
              </div>
              <p className="pricing-card-p">
                No CLI, no setup — we run the model. Same app, same
                receipts.
              </p>
              <ul className="pricing-list pricing-list-faint">
                <li>Everything in Free</li>
                <li>No CLI required — sign in and go</li>
                <li>Pricing announced at launch</li>
              </ul>
              <a
                href="https://github.com/CodesWhat/careerrat/discussions"
                target="_blank"
                rel="noopener noreferrer"
                className="btn-secondary pricing-cta"
              >
                Join the waitlist
              </a>
            </div>
          </div>
        </div>
      </section>

      {/* ─── WHAT YOU GET ──────────────────────────── */}
      <section id="what-you-get" aria-labelledby="checklist-h2">
        <div className="wrap">
          <div className="checklist-inner">
            <div className="checklist-copy reveal">
              <div className="section-label">What you get</div>
              <h2 className="section-h2" id="checklist-h2">
                The whole loop, end to end.
              </h2>
              <p className="section-sub">
                It all ships together, and none of it is built for one
                industry. A nurse, an engineer, and a driver each answer
                onboarding their own way and get the same loop.
              </p>
              <div className="maker-note" aria-label="Note from the maker">
                <strong>A note from the maker:</strong> I built this to solve
                my own job search — the spray-and-pray cycle felt
                disrespectful of everyone&apos;s time, including mine.
                CareerRat is what I wanted: something that rates first,
                applies honestly, and keeps my data to itself.
              </div>
            </div>
            <div className="reveal reveal-delay-2">
              <ul className="checklist" role="list">
                <li>Asks what you want, once — a guided onboarding</li>
                <li>Finds and rates real jobs from the boards you choose</li>
                <li>Reads the whole posting before it writes a word</li>
                <li>Measures every role against your actual constraints</li>
                <li>
                  Writes honest résumés and cover letters from your evidence
                </li>
                <li>Drafts and tracks recruiter messages and follow-ups</li>
                <li>Researches companies and checks what the job should pay</li>
                <li>
                  Builds interview story banks and preps you for live calls
                </li>
                <li>Coaches you through the comp conversation, out loud</li>
                <li>Remembers every outcome and gets sharper as you go</li>
                <li>A live dashboard — the agent works, you watch it happen</li>
                <li>Works the same for any role, in any field</li>
              </ul>
            </div>
          </div>
        </div>
      </section>

      {/* ─── GET IT ────────────────────────────────── */}
      <section id="get" aria-labelledby="get-h2">
        <div className="wrap">
          <div className="ai-section reveal">
            <div className="ai-section-inner">
              <div>
                <div className="section-label">Get CareerRat</div>
                <h2 className="section-h2" id="get-h2">
                  Install it. Run it. Own it.
                </h2>
                <p className="section-sub">
                  Free to self-host, open source (MIT). No wizard, no signup
                  — one command and the agent takes it from there.
                </p>
                <div style={{ marginTop: "28px" }}>
                  <div className="prereq-label">Prerequisites</div>
                  <ul className="prereq-list">
                    <li>Node.js 24 or newer</li>
                    <li style={{ marginTop: "8px" }}>
                      An AI coding CLI on your PATH:
                      <ul className="prereq-sublist">
                        <li>
                          <strong style={{ color: "var(--ink)" }}>
                            Claude Code
                          </strong>{" "}
                          <code className="inline-code">
                            npm install -g @anthropic-ai/claude-code
                          </code>{" "}
                          <a
                            href="https://claude.com/claude-code"
                            className="inline-link"
                          >
                            claude.com/claude-code
                          </a>
                        </li>
                        <li style={{ marginTop: "4px" }}>
                          <strong style={{ color: "var(--ink)" }}>
                            Codex
                          </strong>{" "}
                          <code className="inline-code">
                            npm install -g @openai/codex
                          </code>{" "}
                          <a
                            href="https://github.com/openai/codex"
                            className="inline-link"
                          >
                            github.com/openai/codex
                          </a>
                        </li>
                      </ul>
                    </li>
                  </ul>
                </div>
              </div>
              <div>
                <div className="prereq-label">Get it running</div>
                <div
                  className="terminal-sticker"
                  role="region"
                  aria-label="Getting started commands"
                >
                  <div className="terminal-dots" aria-hidden="true">
                    <div className="terminal-dot terminal-dot-red" />
                    <div className="terminal-dot terminal-dot-yellow" />
                    <div className="terminal-dot terminal-dot-green" />
                  </div>
                  <div className="terminal-prompt">~ $</div>
                  <div className="terminal-command">
                    npm install -g careerrat
                    <br />
                    careerrat start claude
                    <span className="terminal-cursor" aria-hidden="true" />
                  </div>
                  <div className="terminal-comment">
                    # or: careerrat start codex
                    <br /># scaffolds workspace, installs skills, opens the
                    dashboard at localhost:7777
                    <br /># then hands off to the agent
                  </div>
                </div>
                <p className="get-note">
                  Paste a job posting and say &ldquo;evaluate this&rdquo; to
                  kick off the loop. Or try the bundled sample under{" "}
                  <code className="inline-code">
                    examples/sample-jobs/
                  </code>
                  .
                </p>
                <div style={{ marginTop: "28px" }}>
                  <div className="prereq-label">Update later</div>
                  <div
                    className="terminal-sticker"
                    role="region"
                    aria-label="Update command"
                  >
                    <div className="terminal-dots" aria-hidden="true">
                      <div className="terminal-dot terminal-dot-red" />
                      <div className="terminal-dot terminal-dot-yellow" />
                      <div className="terminal-dot terminal-dot-green" />
                    </div>
                    <div className="terminal-prompt">~ careerrat $</div>
                    <div className="terminal-command">
                      careerrat update
                      <span className="terminal-cursor" aria-hidden="true" />
                    </div>
                    <div className="terminal-comment">
                      # fetches the latest published code, your data stays
                      untouched
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* ─── FINAL CTA ─────────────────────────────── */}
      <section className="final-cta" aria-labelledby="final-h2">
        <div className="wrap">
          <div className="final-cta-inner reveal">
            <div className="final-mark" aria-hidden="true">
              🐀
            </div>
            <h2 className="final-h2" id="final-h2">
              Ready when you are.
            </h2>
            <p className="final-sub">
              Free. Local. Honest. One command to get going. Run it yourself
              and your data stays put.
            </p>
            <div className="final-actions">
              <a href="#get" className="btn-primary">
                Get CareerRat
              </a>
              <a href="#how-it-works" className="btn-secondary">
                How it works
              </a>
            </div>
          </div>
        </div>
      </section>

      {/* ─── FOOTER ────────────────────────────────── */}
      <footer>
        <div className="wrap footer-inner">
          <div className="footer-top">
            {/* Brand */}
            <div className="footer-brand reveal">
              <div className="footer-logo">
                CareerRat<span className="footer-logo-dot">.</span>
              </div>
              <p className="footer-blurb">
                A chat-first, local-first job-search tracker. Rate the jobs
                worth chasing, apply with honest evidence, and track every
                outcome — from your own data, on your own machine.
              </p>
              <div className="footer-social">
                <a
                  href="https://github.com/CodesWhat/careerrat"
                  target="_blank"
                  rel="noopener noreferrer"
                  aria-label="GitHub"
                >
                  <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                    <path d="M12 .297c-6.63 0-12 5.373-12 12 0 5.303 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61-.546-1.385-1.333-1.754-1.333-1.754-1.087-.744.084-.729.084-.729 1.205.084 1.838 1.236 1.838 1.236 1.07 1.835 2.809 1.305 3.495.998.108-.776.417-1.305.76-1.605-2.665-.3-5.466-1.332-5.466-5.93 0-1.31.465-2.38 1.235-3.22-.135-.303-.54-1.523.105-3.176 0 0 1.005-.322 3.3 1.23a11.5 11.5 0 0 1 3-.405c1.02.005 2.045.138 3 .405 2.28-1.552 3.285-1.23 3.285-1.23.645 1.653.24 2.873.12 3.176.765.84 1.23 1.91 1.23 3.22 0 4.61-2.805 5.625-5.475 5.92.435.375.81 1.096.81 2.22 0 1.606-.015 2.896-.015 3.286 0 .315.21.69.825.57C20.565 22.092 24 17.592 24 12.297c0-6.627-5.373-12-12-12" />
                  </svg>
                </a>
                <a href="/docs" aria-label="Documentation">
                  <svg
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    aria-hidden="true"
                  >
                    <path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z" />
                    <path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z" />
                  </svg>
                </a>
              </div>
            </div>
            {/* Link columns */}
            <div className="footer-cols">
              <div className="footer-col reveal reveal-delay-1">
                <p className="footer-col-h">Product</p>
                <a href="/docs">Documentation</a>
                <a href="#how-it-works">How it works</a>
                <a href="#pricing">Pricing</a>
              </div>
              <div className="footer-col reveal reveal-delay-2">
                <p className="footer-col-h">Project</p>
                <a
                  href="https://github.com/CodesWhat/careerrat"
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  GitHub
                </a>
                <a
                  href="https://github.com/CodesWhat/careerrat/releases"
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  Releases
                </a>
                <a
                  href="https://github.com/CodesWhat/careerrat/blob/main/LICENSE"
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  License
                </a>
              </div>
            </div>
          </div>
          {/* Legal + CodesWhat sign-off */}
          <div className="footer-bottom reveal reveal-delay-3">
            <p className="footer-legal">
              © {new Date().getFullYear()} CodesWhat. Released under the{" "}
              <a
                href="https://github.com/CodesWhat/careerrat/blob/main/LICENSE"
                target="_blank"
                rel="noopener noreferrer"
              >
                MIT License
              </a>
              .
            </p>
            <a
              className="footer-pill"
              href="https://github.com/CodesWhat"
              target="_blank"
              rel="noopener noreferrer"
            >
              <img
                src="/codeswhat-logo.png"
                alt="CodesWhat"
                width={26}
                height={26}
              />
              <span>
                A <strong>CodesWhat</strong> project
              </span>
              <svg
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
              >
                <path d="M7 7h10v10" />
                <path d="M7 17 17 7" />
              </svg>
            </a>
          </div>
        </div>
      </footer>

      <SiteInteractions />
    </>
  );
}
