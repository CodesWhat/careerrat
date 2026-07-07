import { useEffect, useState } from "react";
import { Button } from "../../components/Button.jsx";
import { CompanyAvatar } from "../../components/CompanyAvatar.jsx";
import { Field, TextField } from "../../components/form.jsx";
import { InlineAlert } from "../../components/Toast.jsx";
import {
  createCompanyProposals,
  decideCompanyProposal,
  getCompanyProposals,
  saveCandidateFile,
  searchLogos,
} from "../../lib/api.js";
import { OnboardingNavButton, OnboardingShell } from "../OnboardingShell.jsx";

const SEARCH_DEBOUNCE_MS = 350;
const PROPOSAL_CONFLICT_MESSAGE =
  "Proposal changed. Review the refreshed proposal before deciding.";

function isConflictError(err) {
  return (
    err?.status === 409 || err?.body?.code === "CONFLICT" || err?.body?.error?.code === "CONFLICT"
  );
}

function proposalBatchFromResponse(response) {
  if (response?.data && "batch" in response.data) return response.data.batch;
  return response?.data || null;
}

function proposalCompanyName(proposal) {
  return proposal?.company?.name || proposal?.name || "Company";
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

function normalizeCompanyTarget(company, source = "manual") {
  const name = typeof company === "string" ? company.trim() : String(company?.name || "").trim();
  const domain =
    typeof company === "string"
      ? ""
      : String(company?.domain || company?.domain_hint || company?.domainHint || "").trim();
  if (!name) return null;
  return {
    name,
    domain: domain || null,
    source,
    roleSeen: typeof company === "string" ? "" : String(company?.roleSeen || "").trim(),
    confidence:
      typeof company === "string"
        ? ""
        : String(company?.confidence || company?.confidenceTier || "").trim(),
  };
}

function mergeCompanyTargets(...groups) {
  const out = [];
  const seen = new Set();
  for (const group of groups) {
    for (const item of Array.isArray(group) ? group : []) {
      const target = normalizeCompanyTarget(item, item?.source || "manual");
      const key = target?.name.toLowerCase();
      if (!target || seen.has(key)) continue;
      seen.add(key);
      out.push(target);
    }
  }
  return out;
}

function targetsFromProposalBatch(batch) {
  return (Array.isArray(batch?.proposals) ? batch.proposals : [])
    .map((proposal) =>
      normalizeCompanyTarget(
        {
          name: proposalCompanyName(proposal),
          domain: proposal?.company?.domain,
          roleSeen: proposal?.roleSeen,
          confidenceTier: proposal?.confidenceTier,
        },
        "ai"
      )
    )
    .filter(Boolean);
}

function seedCompanies({ savedCompanies, draftCompanies, proposalBatch }) {
  return mergeCompanyTargets(
    savedCompanies.map((name) => normalizeCompanyTarget(name, "saved")),
    draftCompanies.map((name) => normalizeCompanyTarget(name, "draft")),
    targetsFromProposalBatch(proposalBatch)
  );
}

export function companySeedErrorMessage(err) {
  if (err?.status === 501 || err?.body?.code === "NO_AI_ROUTE") {
    return "AI company picks are unavailable right now. Add companies manually for now.";
  }
  return "Company suggestions are unavailable. Add any companies you want scanned.";
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

export async function runCompanyProposalDecision({
  batchId,
  proposal,
  action,
  decideProposal = decideCompanyProposal,
  readProposals = getCompanyProposals,
} = {}) {
  const payload = {
    batchId,
    proposalId: proposal?.proposalId,
    action,
    expectedVersion: proposal?.version,
  };
  try {
    const result = await decideProposal(payload);
    const pending = await runCompanyProposalRead({ readProposals });
    const data = result?.data || {};
    return {
      result,
      pending,
      decision: data.decision || null,
      proposal: data.proposal || null,
      refreshedProposal: data.refreshedProposal || null,
      rejected: data.rejected || null,
      conflict: false,
    };
  } catch (err) {
    if (!isConflictError(err)) throw err;
    const pending = await runCompanyProposalRead({ readProposals });
    return {
      result: null,
      pending,
      decision: null,
      proposal: null,
      refreshedProposal: null,
      rejected: null,
      conflict: true,
      message: PROPOSAL_CONFLICT_MESSAGE,
      error: err,
    };
  }
}

// Step 4 — Companies. AI-seeded company board targets plus manual company
// add/search. Saved company names persist to targeting.yml#tracked_companies
// — the candidate's own shortlist
// (distinct from config/sourced-scan.json's tracked_companies, which
// discover-companies/`rolester companies` manage for the sweep itself).
export function CompaniesStep({
  state,
  draftSeeds,
  runtimeCapabilities = {},
  goNext,
  goBack,
  onProgressSelect,
  showToast,
  initialProposalBatch = null,
}) {
  const [query, setQuery] = useState("");
  const [suggestions, setSuggestions] = useState([]);
  const [searching, setSearching] = useState(false);

  const savedCompanies = state?.data?.targeting?.tracked_companies ?? [];
  const draftCompanies = draftSeeds?.targeting?.tracked_companies ?? [];
  const [companies, setCompanies] = useState(() =>
    seedCompanies({ savedCompanies, draftCompanies, proposalBatch: initialProposalBatch })
  );

  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const [proposalBatch, setProposalBatch] = useState(initialProposalBatch);
  const [seedStatus, setSeedStatus] = useState(initialProposalBatch ? "ready" : "idle");
  const [seedError, setSeedError] = useState(null);

  const canUseCompanyProposals = runtimeCapabilities.companyProposals !== false;

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
          setSuggestions(res.results || []);
        } else {
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

  useEffect(() => {
    if (!canUseCompanyProposals || proposalBatch || companies.length) return undefined;
    let cancelled = false;
    async function seedCompanyTargets() {
      setSeedStatus("loading");
      setSeedError(null);
      try {
        const pending = await runCompanyProposalRead();
        let batch = proposalBatchFromResponse(pending);
        if (!targetsFromProposalBatch(batch).length) {
          const created = await runCompanyProposalCreate({ manualSeeds: [] });
          batch =
            proposalBatchFromResponse(created.pending) ||
            proposalBatchFromResponse(created.created) ||
            null;
        }
        if (cancelled) return;
        setProposalBatch(batch);
        const seededTargets = targetsFromProposalBatch(batch);
        setCompanies((current) => mergeCompanyTargets(current, seededTargets));
        setSeedStatus(seededTargets.length ? "ready" : "empty");
      } catch (err) {
        if (cancelled) return;
        setSeedError(companySeedErrorMessage(err));
        setSeedStatus("error");
      }
    }
    void seedCompanyTargets();
    return () => {
      cancelled = true;
    };
  }, [canUseCompanyProposals, companies.length, proposalBatch]);

  function addCompany(name, domain) {
    const trimmed = String(name || "").trim();
    if (!trimmed) return;
    setCompanies((list) =>
      mergeCompanyTargets(list, [{ name: trimmed, domain, source: "manual" }])
    );
    setQuery("");
    setSuggestions([]);
  }

  function removeCompany(name) {
    setCompanies((list) => list.filter((company) => company.name !== name));
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
    <OnboardingShell
      activeIndex={4}
      className="onboarding-shell--targeting"
      onProgressSelect={onProgressSelect}
      actions={
        <>
          <OnboardingNavButton direction="back" label="Back" onClick={goBack} />
          <OnboardingNavButton
            direction="next"
            label="Continue"
            onClick={handleSaveAndNext}
            disabled={saving}
          />
        </>
      }
    >
      <div className="onboarding-step-stack onboarding-step-stack--targeting">
        <div className="onboarding-step-label">Step 4</div>
        <section
          className="onboarding-step-card onboarding-targeting onboarding-companies"
          aria-labelledby="onboarding-companies-title"
        >
          <section
            className="onboarding-step-card__media onboarding-targeting__media"
            aria-label="Company board targeting"
          >
            <div className="onboarding-targeting__mark" aria-hidden="true">
              🏢
            </div>
            <div className="onboarding-targeting__media-copy">
              <h1 id="onboarding-companies-title">Companies</h1>
              <p>
                Pick company boards worth scanning directly. Broad search still runs either way.
              </p>
            </div>
          </section>

          <div className="onboarding-step-card__content onboarding-step-card__content--dense onboarding-step-card__content--scroll onboarding-targeting__content onboarding-companies__content">
            <section className="onboarding-targeting__signal-panel onboarding-targeting__signal-panel--quiet onboarding-companies__panel">
              {seedStatus === "loading" ? (
                <div className="onboarding-companies__header">
                  <span className="onboarding-companies__status">Finding matches…</span>
                </div>
              ) : null}

              {error ? <InlineAlert message={error} /> : null}
              {seedError ? <InlineAlert tone="warning" message={seedError} /> : null}

              {companies.length ? (
                <ul
                  className="onboarding-companies__company-list"
                  aria-label="Selected company scan targets"
                >
                  {companies.map((company) => {
                    const detail =
                      [company.roleSeen, company.confidence || company.source]
                        .filter(Boolean)
                        .join(" · ") || "Company board";
                    return (
                      <li
                        key={company.name}
                        className="onboarding-companies__company-pill"
                        title={`${company.name} · ${detail}`}
                      >
                        <CompanyAvatar name={company.name} domain={company.domain} size={24} />
                        <span className="onboarding-companies__company-main">{company.name}</span>
                        <button
                          type="button"
                          className="onboarding-companies__remove"
                          onClick={() => removeCompany(company.name)}
                          aria-label={`Remove ${company.name}`}
                        >
                          ×
                        </button>
                      </li>
                    );
                  })}
                </ul>
              ) : (
                <div className="onboarding-companies__empty">
                  {seedStatus === "loading"
                    ? "Looking for company boards…"
                    : "No company targets yet."}
                </div>
              )}

              <Field
                label="Add a company"
                htmlFor="companies-search"
                hint="Press Enter to include a specific company board."
                className="onboarding-custom-entry onboarding-companies__add-field"
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
              {suggestions.length ? (
                <div className="onboarding-companies__suggestions">
                  {suggestions.map((s) => (
                    <div className="company-row" key={`${s.name}-${s.domain}`}>
                      <CompanyAvatar name={s.name || s.domain} domain={s.domain} />
                      <span className="company-row__name">{s.name || s.domain}</span>
                      <Button
                        variant="secondary"
                        onClick={() => addCompany(s.name || s.domain, s.domain)}
                      >
                        Add
                      </Button>
                    </div>
                  ))}
                </div>
              ) : null}
            </section>
          </div>
        </section>
      </div>
    </OnboardingShell>
  );
}
