import { useState } from "react";
import { Button } from "../../components/Button.jsx";
import { InlineAlert } from "../../components/Toast.jsx";
import { initOnboard } from "../../lib/api.js";
import { OnboardingShell } from "../OnboardingShell.jsx";

// Step 1 — Welcome. Runs POST /api/onboard/init, which initializes the
// SQLite-backed candidate setup rows used by every later step.
export function WelcomeStep({ goNext, loading = false }) {
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState(null);

  async function handleStart() {
    setStarting(true);
    setError(null);
    try {
      await initOnboard();
      goNext();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not start setup");
    } finally {
      setStarting(false);
    }
  }

  return (
    <OnboardingShell activeIndex={0} className="onboarding-shell--welcome">
      <section
        className="onboarding-hero onboarding-hero--wash"
        aria-labelledby="onboarding-hero-title"
      >
        <div className="onboarding-hero__mark-stage" aria-hidden="true">
          <img className="onboarding-hero__mark" src="/assets/logo.png" alt="" />
        </div>
        <section className="onboarding-hero__copy">
          <h1 id="onboarding-hero-title" aria-label="A sidekick for your job search.">
            <span className="onboarding-hero__line">
              A{" "}
              <span className="onboarding-hero__underline-word">
                sidekick
                <svg
                  className="onboarding-hero__underline"
                  viewBox="0 0 120 14"
                  aria-hidden="true"
                  focusable="false"
                >
                  <path d="M4,10 Q30,4 60,8 Q90,12 116,6" />
                </svg>
              </span>
            </span>
            <span className="onboarding-hero__line">for your job</span>
            <span className="onboarding-hero__line">search.</span>
          </h1>
          {error ? <InlineAlert message={error} /> : null}
          <Button
            className="onboarding-hero__cta"
            onClick={handleStart}
            disabled={starting || loading}
          >
            {loading ? "Loading..." : starting ? "Starting..." : "Get Started"}
          </Button>
        </section>
      </section>
    </OnboardingShell>
  );
}
