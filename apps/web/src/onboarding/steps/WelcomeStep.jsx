import { useState } from "react";
import { Button } from "../../components/Button.jsx";
import { Card } from "../../components/Card.jsx";
import { InlineAlert } from "../../components/Toast.jsx";
import { initOnboard } from "../../lib/api.js";

// Step 1 — Welcome. Runs POST /api/onboard/init, which initializes the
// SQLite-backed candidate setup rows used by every later step.
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
        Seven quick steps build your profile, capture a resume, and connect an optional AI key.
        Rolester stores setup in SQLite and can export compatibility files when you finish. Every
        AI-assisted step degrades to a manual path when no key is configured.
      </p>
      {files.length ? (
        <p className="field__hint">Current workspace — {summaryParts.join(", ")}</p>
      ) : null}
      {error ? <InlineAlert message={error} /> : null}
      <div className="wizard-actions">
        <Button onClick={handleStart} disabled={starting}>
          {starting ? "Starting…" : "Get started"}
        </Button>
      </div>
    </Card>
  );
}
