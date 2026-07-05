import { useEffect, useState } from "react";
import { Button } from "../../components/Button.jsx";
import { Card } from "../../components/Card.jsx";
import { CompanyAvatar } from "../../components/CompanyAvatar.jsx";
import { Field, TextField } from "../../components/form.jsx";
import { InlineAlert } from "../../components/Toast.jsx";
import {
  createCompanyProposals,
  getCompanyProposals,
  saveCandidateFile,
  searchLogos,
} from "../../lib/api.js";
import { ChatPanel } from "../ChatPanel.jsx";

const SEARCH_DEBOUNCE_MS = 350;

function errorMessage(err, fallback) {
  return (
    err?.body?.error?.message ||
    err?.body?.message ||
    (err instanceof Error ? err.message : null) ||
    fallback
  );
}

function proposalBatchFromResponse(response) {
  if (response?.data && "batch" in response.data) return response.data.batch;
  return response?.data || null;
}

function proposalCounts(batch) {
  return {
    proposals: batch?.counts?.proposals ?? batch?.proposals?.length ?? 0,
    rejected: batch?.counts?.rejected ?? batch?.rejected?.length ?? 0,
  };
}

function proposalCompanyName(proposal) {
  return proposal?.company?.name || proposal?.name || "Company";
}

function proposalConfidenceLabel(proposal) {
  return proposal?.confidenceTier || "review";
}

function rejectedProposalLabel() {
  return "rejected";
}

function ProposalChipRow({ proposals, labelForProposal }) {
  const list = Array.isArray(proposals) ? proposals : [];
  if (!list.length) return null;
  return (
    <div className="chip-row">
      {list.map((proposal) => {
        const name = proposalCompanyName(proposal);
        const label = labelForProposal(proposal);
        return (
          <span className="chip" key={proposal.proposalId || `${name}-${label}`}>
            <CompanyAvatar name={name} domain={proposal?.company?.domain} />
            <span className="chip__label">
              {name} · {label}
            </span>
          </span>
        );
      })}
    </div>
  );
}

export function proposalSeedsFromCompanies(companies = []) {
  return (Array.isArray(companies) ? companies : [])
    .map((company) => {
      const name =
        typeof company === "string" ? company.trim() : String(company?.name || "").trim();
      const domain =
        typeof company === "string"
          ? ""
          : String(company?.domain || company?.domain_hint || "").trim();
      if (!name) return null;
      return {
        name,
        ...(domain ? { domain_hint: domain } : {}),
      };
    })
    .filter(Boolean);
}

export function runCompanyProposalRead({ readProposals = getCompanyProposals } = {}) {
  return readProposals({ status: "pending" });
}

export async function runCompanyProposalCreate({
  manualSeeds,
  createProposals = createCompanyProposals,
  readProposals = getCompanyProposals,
} = {}) {
  const created = await createProposals({
    manualSeeds: Array.isArray(manualSeeds) ? manualSeeds : [],
  });
  const pending = await runCompanyProposalRead({ readProposals });
  return { created, pending };
}

// Step 5 — Companies. Type-ahead (logo.dev Brand Search proxy, GET
// /api/logos/search) + initials fallback, a collapsed logo.dev-credentials
// panel (writes automation integrations through the candidate setup API — see
// onboard-route.mjs's AUTOMATION_ROUTE_ENTRY comment for why that route
// exists), and local company proposals backed by Phase 3 discovery APIs.
// Saved company names
// persist to targeting.yml#tracked_companies — the candidate's own shortlist
// (distinct from config/sourced-scan.json's tracked_companies, which
// discover-companies/`rolester companies` manage for the sweep itself).
export function CompaniesStep({
  state,
  draftSeeds,
  runtimeCapabilities = {},
  reload,
  goNext,
  goBack,
  showToast,
}) {
  const [query, setQuery] = useState("");
  const [suggestions, setSuggestions] = useState([]);
  const [searching, setSearching] = useState(false);
  const [noToken, setNoToken] = useState(false);

  const savedCompanies = state?.data?.targeting?.tracked_companies ?? [];
  const draftCompanies = draftSeeds?.targeting?.tracked_companies ?? [];
  const [companies, setCompanies] = useState(
    (savedCompanies.length ? savedCompanies : draftCompanies).map((name) => ({
      name,
      domain: null,
    }))
  );

  const [showCredentials, setShowCredentials] = useState(false);
  const [imageToken, setImageToken] = useState("");
  const [secretKey, setSecretKey] = useState("");
  const [savingCreds, setSavingCreds] = useState(false);

  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const [proposalBatch, setProposalBatch] = useState(null);
  const [proposalLoading, setProposalLoading] = useState(false);
  const [proposalCreating, setProposalCreating] = useState(false);
  const [proposalError, setProposalError] = useState(null);

  const canUseCompanyProposals = runtimeCapabilities.companyProposals !== false;
  const canUseManualSeeds = runtimeCapabilities.manualCompanySeeds !== false;
  const showDiscoveryChat = runtimeCapabilities.discoveryChatHandoffs === true;
  const manualSeeds = proposalSeedsFromCompanies(companies);
  const counts = proposalCounts(proposalBatch);

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

  async function handleLoadCompanyProposals() {
    setProposalLoading(true);
    setProposalError(null);
    try {
      const response = await runCompanyProposalRead();
      setProposalBatch(proposalBatchFromResponse(response));
    } catch (err) {
      setProposalError(errorMessage(err, "Could not load company proposals"));
    } finally {
      setProposalLoading(false);
    }
  }

  async function handleCreateCompanyProposals() {
    setProposalCreating(true);
    setProposalError(null);
    try {
      const { created, pending } = await runCompanyProposalCreate({ manualSeeds });
      setProposalBatch(proposalBatchFromResponse(pending) || proposalBatchFromResponse(created));
    } catch (err) {
      setProposalError(errorMessage(err, "Could not create company proposals"));
    } finally {
      setProposalCreating(false);
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
          Company proposals
        </p>
        {proposalError ? <InlineAlert message={proposalError} /> : null}
        <div className="wizard-actions" style={{ justifyContent: "flex-start" }}>
          <Button
            variant="secondary"
            onClick={handleLoadCompanyProposals}
            disabled={proposalLoading || !canUseCompanyProposals}
          >
            {proposalLoading ? "Loading…" : "Load pending proposals"}
          </Button>
          <Button
            onClick={handleCreateCompanyProposals}
            disabled={
              proposalCreating ||
              !canUseCompanyProposals ||
              !canUseManualSeeds ||
              manualSeeds.length === 0
            }
          >
            {proposalCreating ? "Finding…" : "Find boards from shortlist"}
          </Button>
        </div>
        {!canUseCompanyProposals ? (
          <p className="field__hint">Local company proposals are unavailable in this runtime.</p>
        ) : null}
        {canUseCompanyProposals && !manualSeeds.length ? (
          <p className="field__hint">Add at least one company to create local proposals.</p>
        ) : null}
        {proposalBatch ? (
          <div style={{ marginTop: 12 }}>
            <p className="field__hint" style={{ margin: "0 0 8px" }}>
              {counts.proposals} proposed · {counts.rejected} rejected
            </p>
            <ProposalChipRow
              proposals={proposalBatch.proposals}
              labelForProposal={proposalConfidenceLabel}
            />
            <ProposalChipRow
              proposals={proposalBatch.rejected}
              labelForProposal={rejectedProposalLabel}
            />
          </div>
        ) : null}
      </div>

      {showDiscoveryChat ? (
        <div>
          <p className="field__label" style={{ margin: "0 0 6px" }}>
            Agent-led discovery
          </p>
          <ChatPanel skill="discover-companies" kickoffLabel="Ask Roland to find companies" />
        </div>
      ) : null}

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
