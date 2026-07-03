import { useEffect, useState } from "react";
import { Button } from "../../components/Button.jsx";
import { Card } from "../../components/Card.jsx";
import { Field, TextField } from "../../components/form.jsx";
import { InlineAlert } from "../../components/Toast.jsx";
import { logoImageUrl, saveCandidateFile, searchLogos } from "../../lib/api.js";
import { ChatPanel } from "../ChatPanel.jsx";

const SEARCH_DEBOUNCE_MS = 350;

function initials(name) {
  return String(name || "")
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((w) => w[0]?.toUpperCase() ?? "")
    .join("");
}

function CompanyAvatar({ name, domain }) {
  const [failed, setFailed] = useState(false);
  if (domain && !failed) {
    return (
      <span className="avatar">
        <img src={logoImageUrl(domain)} alt="" onError={() => setFailed(true)} />
      </span>
    );
  }
  return <span className="avatar">{initials(name)}</span>;
}

// Step 5 — Companies. Type-ahead (logo.dev Brand Search proxy, GET
// /api/logos/search) + initials fallback, a collapsed logo.dev-credentials
// panel (writes to candidate/automation.yml#integrations — see
// onboard-route.mjs's AUTOMATION_ROUTE_ENTRY comment for why that route
// exists), and Roland's discover-companies chat panel. Saved company names
// persist to targeting.yml#tracked_companies — the candidate's own shortlist
// (distinct from config/sourced-scan.json's tracked_companies, which
// discover-companies/`rolester companies` manage for the sweep itself).
export function CompaniesStep({ state, aiEnabled, reload, goNext, goBack, showToast }) {
  const [query, setQuery] = useState("");
  const [suggestions, setSuggestions] = useState([]);
  const [searching, setSearching] = useState(false);
  const [noToken, setNoToken] = useState(false);

  const [companies, setCompanies] = useState(
    (state?.data?.targeting?.tracked_companies ?? []).map((name) => ({ name, domain: null }))
  );

  const [showCredentials, setShowCredentials] = useState(false);
  const [imageToken, setImageToken] = useState("");
  const [secretKey, setSecretKey] = useState("");
  const [savingCreds, setSavingCreds] = useState(false);

  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    const trimmed = query.trim();
    if (trimmed.length < 2) {
      setSuggestions([]);
      return undefined;
    }
    const timer = setTimeout(async () => {
      setSearching(true);
      try {
        const res = await searchLogos(trimmed);
        if (res.ok) {
          setNoToken(false);
          setSuggestions(res.results || []);
        } else {
          setNoToken(res.reason === "no-token");
          setSuggestions([]);
        }
      } catch {
        setSuggestions([]);
      } finally {
        setSearching(false);
      }
    }, SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [query]);

  function addCompany(name, domain) {
    const trimmed = String(name || "").trim();
    if (!trimmed) return;
    setCompanies((list) =>
      list.some((c) => c.name.toLowerCase() === trimmed.toLowerCase())
        ? list
        : [...list, { name: trimmed, domain: domain || null }]
    );
    setQuery("");
    setSuggestions([]);
  }

  function removeCompany(index) {
    setCompanies((list) => list.filter((_, i) => i !== index));
  }

  async function handleSaveCredentials() {
    const patch = {};
    if (imageToken.trim()) patch.logo_dev_token = imageToken.trim();
    if (secretKey.trim()) patch.logo_dev_secret_key = secretKey.trim();
    if (!Object.keys(patch).length) return;
    setSavingCreds(true);
    try {
      await saveCandidateFile("automation", { integrations: patch });
      setImageToken("");
      setSecretKey("");
      showToast("Logo.dev credentials saved.");
      await reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Save failed");
    } finally {
      setSavingCreds(false);
    }
  }

  async function handleSaveAndNext() {
    setSaving(true);
    setError(null);
    try {
      await saveCandidateFile("targeting", { tracked_companies: companies.map((c) => c.name) });
      showToast("Saved.");
      goNext();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Save failed");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Card title="Companies">
      {error ? <InlineAlert message={error} /> : null}

      <Field
        label="Add a company"
        htmlFor="companies-search"
        hint="Type a name, pick a match, or press Enter to add it as typed"
      >
        <TextField
          id="companies-search"
          value={query}
          onChange={setQuery}
          placeholder="e.g. Sweetgreen"
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              addCompany(query, null);
            }
          }}
        />
      </Field>
      {searching ? <p className="field__hint">Searching…</p> : null}
      {noToken ? (
        <p className="field__hint">
          No logo.dev search key configured — add one below to enable autocomplete, or just press
          Enter to add companies by name.
        </p>
      ) : null}
      {suggestions.length ? (
        <div>
          {suggestions.map((s) => (
            <div className="company-row" key={`${s.name}-${s.domain}`}>
              <CompanyAvatar name={s.name || s.domain} domain={s.domain} />
              <span className="company-row__name">{s.name || s.domain}</span>
              <Button variant="secondary" onClick={() => addCompany(s.name || s.domain, s.domain)}>
                Add
              </Button>
            </div>
          ))}
        </div>
      ) : null}

      {companies.length ? (
        <div className="chip-row">
          {companies.map((c, i) => (
            // company entries have no stable id (a plain name+domain pair the
            // user can freely reorder/dedupe); index-suffixed keys are fine.
            // biome-ignore lint/suspicious/noArrayIndexKey: no stable id available
            <span className="chip" key={`${c.name}-${i}`}>
              <CompanyAvatar name={c.name} domain={c.domain} />
              <span className="chip__label">{c.name}</span>
              <button
                type="button"
                className="chip__remove"
                onClick={() => removeCompany(i)}
                aria-label="Remove"
              >
                ×
              </button>
            </span>
          ))}
        </div>
      ) : null}

      <div>
        <button
          type="button"
          className="btn btn--secondary"
          onClick={() => setShowCredentials((s) => !s)}
        >
          {showCredentials ? "Hide" : "Add"} logo.dev credentials (optional)
        </button>
        {showCredentials ? (
          <div style={{ marginTop: 10 }}>
            <p className="field__hint" style={{ margin: "0 0 8px" }}>
              Two separate free logo.dev keys: a publishable token for images, a secret key for
              search. Neither is echoed back after saving. Images:{" "}
              <span
                className={`badge ${state?.logoImageTokenConfigured ? "badge--ok" : "badge--muted"}`}
              >
                {state?.logoImageTokenConfigured ? "configured" : "not configured"}
              </span>{" "}
              Search:{" "}
              <span
                className={`badge ${state?.logoSearchTokenConfigured ? "badge--ok" : "badge--muted"}`}
              >
                {state?.logoSearchTokenConfigured ? "configured" : "not configured"}
              </span>
            </p>
            <div className="field-row">
              <Field label="Image token (publishable)" htmlFor="logo-image-token">
                <TextField
                  id="logo-image-token"
                  type="password"
                  value={imageToken}
                  onChange={setImageToken}
                  autoComplete="off"
                />
              </Field>
              <Field label="Search key (secret)" htmlFor="logo-secret-key">
                <TextField
                  id="logo-secret-key"
                  type="password"
                  value={secretKey}
                  onChange={setSecretKey}
                  autoComplete="off"
                />
              </Field>
            </div>
            <Button
              variant="secondary"
              onClick={handleSaveCredentials}
              disabled={savingCreds || (!imageToken.trim() && !secretKey.trim())}
            >
              {savingCreds ? "Saving…" : "Save credentials"}
            </Button>
          </div>
        ) : null}
      </div>

      <div>
        <p className="field__label" style={{ margin: "0 0 6px" }}>
          Roland — find companies for you
        </p>
        {aiEnabled ? (
          <ChatPanel skill="discover-companies" kickoffLabel="Ask Roland to find companies" />
        ) : (
          <p className="field__hint">Add an AI key in the earlier step to use Roland's search.</p>
        )}
        <p className="field__hint">
          Roland proposes companies confirm-first in the panel above and adds accepted ones to your
          scan list separately — company chips added here are just your own shortlist.
        </p>
      </div>

      <div className="wizard-actions">
        <Button variant="secondary" onClick={goBack}>
          Back
        </Button>
        <Button onClick={handleSaveAndNext} disabled={saving}>
          {saving ? "Saving…" : "Save & continue"}
        </Button>
      </div>
    </Card>
  );
}
