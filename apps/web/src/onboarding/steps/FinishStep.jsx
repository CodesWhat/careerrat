import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { Button } from "../../components/Button.jsx";
import { Card } from "../../components/Card.jsx";
import { InlineAlert } from "../../components/Toast.jsx";
import { addBoard, previewBoards, writeConfig } from "../../lib/api.js";

// Step 7 — Finish. Runs the existing POST /api/onboard/write-config
// (regenerates config/search-sources.yml wholesale from targeting+profile,
// same as the legacy /onboard page's step 8). The "add your LinkedIn saved
// search" affordance is deliberately HERE, after write-config, not on the
// Targeting step — write-config's regen would silently drop an
// earlier-added browser source (see boards-route.mjs's own header comment
// and the M8 design doc §6's flagged ordering hazard). Ends with the
// explicit /chat evidence-interview handoff the design doc calls for: the
// wizard and the deeper conversational interview are two independent entry
// points into the same candidate files, not one linear flow.
export function FinishStep({ state, goBack }) {
  const [writing, setWriting] = useState(false);
  const [written, setWritten] = useState(null);
  const [error, setError] = useState(null);

  const [preview, setPreview] = useState(null);
  const [adding, setAdding] = useState(false);
  const [added, setAdded] = useState(false);

  const configReady = !!written || !!state?.searchSourcesPresent;

  async function handleWriteConfig() {
    setWriting(true);
    setError(null);
    try {
      const result = await writeConfig();
      setWritten(result.written || []);
    } catch (err) {
      setError(err?.body?.error || (err instanceof Error ? err.message : "write-config failed"));
    } finally {
      setWriting(false);
    }
  }

  // Recompute once, right after write-config succeeds — configReady is the
  // deliberate trigger, not a live-typing field.
  // biome-ignore lint/correctness/useExhaustiveDependencies: fires once on configReady
  useEffect(() => {
    if (!configReady) return;
    const titles = state?.data?.targeting?.role_buckets?.[0]?.titles ?? [];
    if (!titles.length) return;
    const profile = state?.data?.profile ?? {};
    previewBoards({
      keywords: titles[0],
      location: profile.location?.home ?? null,
      remote: !!profile.location?.remote,
      minimumBase: profile.compensation?.minimum_base ?? null,
      windowHours: 24,
    })
      .then(setPreview)
      .catch(() => setPreview(null));
  }, [configReady]);

  async function handleAddLinkedIn() {
    if (!preview?.linkedin?.url) return;
    setAdding(true);
    setError(null);
    try {
      await addBoard({ url: preview.linkedin.url, label: "LinkedIn (from onboarding)" });
      setAdded(true);
    } catch (err) {
      setError(err?.body?.error || (err instanceof Error ? err.message : "Could not add source"));
    } finally {
      setAdding(false);
    }
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      {error ? <InlineAlert message={error} /> : null}

      <Card title="Finish setup">
        <p>
          Generates <code>config/search-sources.yml</code> and <code>candidate/AGENTS.md</code> from
          your profile and targeting.
        </p>
        <Button onClick={handleWriteConfig} disabled={writing}>
          {writing ? "Writing…" : "Write config"}
        </Button>
        {written ? (
          <p className="field__hint">Wrote: {written.join(", ")}</p>
        ) : configReady ? (
          <p className="field__hint">
            Already written in a previous session — run again to refresh it.
          </p>
        ) : null}
      </Card>

      {configReady && preview?.linkedin?.url ? (
        <Card title="Add your LinkedIn saved search">
          <p className="field__hint" style={{ margin: 0 }}>
            Enabling this still requires the usual authenticated-search consent (
            <code>rolester automation consent linkedin --write</code>) before it can run.
          </p>
          <div className="board-preview">
            <a
              className="board-preview__url"
              href={preview.linkedin.url}
              target="_blank"
              rel="noreferrer"
            >
              {preview.linkedin.url}
            </a>
          </div>
          {added ? (
            <p className="field__hint">Added to config/search-sources.yml (disabled by default).</p>
          ) : (
            <Button variant="secondary" onClick={handleAddLinkedIn} disabled={adding}>
              {adding ? "Adding…" : "Add to my search sources"}
            </Button>
          )}
        </Card>
      ) : null}

      <Card title="What's next">
        <p>
          Your workspace is live. For a deeper interview — evidence bank, honesty boundaries,
          writing samples — the kind that improves tailored resumes, start the full setup chat.
        </p>
        <div className="links" style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
          <a href="/chat">Start the deeper interview</a>
          <Link to="/">Go to Home</Link>
          <Link to="/settings">Go to Settings</Link>
        </div>
      </Card>

      <div className="wizard-actions">
        <Button variant="secondary" onClick={goBack}>
          Back
        </Button>
        <span />
      </div>
    </div>
  );
}
