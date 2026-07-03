import { useState } from "react";
import { Button } from "../../components/Button.jsx";
import { Card } from "../../components/Card.jsx";
import { InlineAlert } from "../../components/Toast.jsx";
import { initOnboard } from "../../lib/api.js";

// Step 1 — Welcome. Runs POST /api/onboard/init (ensureCandidateFiles: seeds
// candidate/ from templates, NEVER overwrites an existing file — see
// onboard-route.mjs's own header comment) so every later step always has a
// valid template-default base to prefill from and deep-merge onto, exactly
// like the legacy /onboard page's step 1.
export function WelcomeStep({ state, goNext }) {
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

  const files = state?.files ?? [];
  const summaryParts = files.map(
    (f) => `${f.name}: ${f.valid ? "ok" : f.exists ? "invalid" : "missing"}`
  );

  return (
    <Card title="Set up your workspace">
      <p>
        Seven quick steps seed your candidate files, capture a resume, and connect an optional AI
        key — the same <code>candidate/*.yml</code> files the classic setup page and the rolester
        CLI already read and write. Every AI-assisted step (resume extraction, suggestion chips,
        Roland's company search) degrades to a manual path when no key is configured — nothing here
        ever hard-blocks on AI.
      </p>
      {files.length ? (
        <p className="field__hint">Current workspace — {summaryParts.join(", ")}</p>
      ) : null}
      {error ? <InlineAlert message={error} /> : null}
      <div className="wizard-actions">
        <a href="/onboard">Prefer the classic step-by-step page?</a>
        <Button onClick={handleStart} disabled={starting}>
          {starting ? "Starting…" : "Get started"}
        </Button>
      </div>
    </Card>
  );
}
