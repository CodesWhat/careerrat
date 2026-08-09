import { useEffect, useState } from "react";
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
import { resolveCompanySuggestions } from "../companyCatalog.js";
import { OnboardingNavButton, OnboardingShell } from "../OnboardingShell.jsx";

const SEARCH_DEBOUNCE_MS = 350;
const PROPOSAL_CONFLICT_MESSAGE =
  "Proposal changed. Review the refreshed proposal before deciding.";

// Mirrors the server's COMPANY_DISCOVERY_BATCH_MAX
// (src/core/discovery/company-board-resolver.mjs) — a single manualSeeds
// create 422s past this. Kept as a local constant rather than an import:
// that server module pulls in Node's dns/net built-ins and can't be bundled
// into this browser app. See reconcileCompanyProposalDecisions below for why
// chunking at this size doesn't lose any seed's mint result.
const MANUAL_SEED_BATCH_MAX = 12;

function chunkArray(list, size) {
  const chunks = [];
  for (let i = 0; i < list.length; i += size) {
    chunks.push(list.slice(i, i + size));
  }
  return chunks;
}

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
  const isObject = typeof company === "object" && company !== null;
  const proposalId = isObject ? String(company?.proposalId || "").trim() : "";
  const batchId = isObject ? String(company?.batchId || "").trim() : "";
  const classification = isObject ? String(company?.classification || "").trim() : "";
  const version = isObject ? company?.version : undefined;
  return {
    name,
    domain: domain || null,
    source,
    roleSeen: typeof company === "string" ? "" : String(company?.roleSeen || "").trim(),
    confidence:
      typeof company === "string"
        ? ""
        : String(company?.confidence || company?.confidenceTier || "").trim(),
    ...(proposalId ? { proposalId } : {}),
    ...(batchId ? { batchId } : {}),
    ...(classification ? { classification } : {}),
    ...(version != null ? { version } : {}),
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
          proposalId: proposal?.proposalId,
          batchId: batch?.batchId,
          classification: proposal?.classification,
          version: proposal?.version,
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
  const details = Array.isArray(err?.body?.error?.details)
    ? err.body.error.details
        .slice(0, 3)
        .map((detail) => [detail?.path, detail?.message].filter(Boolean).join(" "))
        .filter(Boolean)
    : [];
  if (err?.body?.code === "AI_SCHEMA_INVALID" && details.length) {
    return `Company suggestions were invalid${err?.body?.ai?.retried ? " after one repair attempt" : ""}: ${details.join("; ")}. Retry, or add company names/homepages manually.`;
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
  userConfirmed = false,
  decideProposal = decideCompanyProposal,
  readProposals = getCompanyProposals,
} = {}) {
  const payload = {
    batchId,
    proposalId: proposal?.proposalId,
    action,
    expectedVersion: proposal?.version,
    ...(userConfirmed ? { userConfirmed: true } : {}),
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

// Save & Next converts kept/removed chips into real decisions so the
// onboarding Companies step actually resolves supported-ATS boards into
// sourced-scan.tracked_companies (the deterministic first-search source
// count reads that table, not targeting.tracked_companies names). Kept chips
// with no proposalId — manually typed, autocomplete picks, resume-extraction
// seeds — are minted into proposals first via a manualSeeds create call, so
// every kept company gets a shot at resolution, not just AI-proposed ones.
// Minting is best-effort: a failed or partial mint just leaves those chips
// without a proposalId, which drops them out of the approval loop below
// rather than blocking Save & Next — a server-side backfill covers them
// later. Decisions run sequentially — parallel calls on the same batch race
// each other's expectedVersion. Never throws: a partial failure surfaces as
// a soft toast, it never blocks the wizard from advancing.
export async function reconcileCompanyProposalDecisions({
  companies = [],
  removedProposals = [],
  decideProposal = runCompanyProposalDecision,
  createProposals = runCompanyProposalCreate,
} = {}) {
  const currentNames = new Set(
    (Array.isArray(companies) ? companies : []).map((company) => company.name.toLowerCase())
  );

  let hadFailure = false;
  let resolvedCompanies = Array.isArray(companies) ? companies : [];

  const unresolved = resolvedCompanies.filter((company) => !company.proposalId);
  if (unresolved.length) {
    // A default fresh-user run pre-seeds ~17 companies — well over the
    // server's per-create cap (MANUAL_SEED_BATCH_MAX above). Mint
    // sequentially in chunks instead of one oversized call that 422s
    // outright. Each createProposals() call both POSTs its chunk and
    // re-reads the now-latest pending batch (see runCompanyProposalCreate);
    // the server never deletes or merges older batch rows — each chunk
    // gets its own batchId — it just stops being "latest" once a newer one
    // exists. Awaiting each chunk before starting the next means every
    // chunk's minted proposalIds are captured off its OWN response before
    // the next chunk's create supersedes it as the visible pending batch,
    // so no seed's mint result is lost.
    const seedChunks = chunkArray(unresolved, MANUAL_SEED_BATCH_MAX);
    const mintedByName = new Map();
    for (const chunk of seedChunks) {
      try {
        const created = await createProposals({
          manualSeeds: proposalSeedsFromCompanies(chunk),
        });
        const batch =
          proposalBatchFromResponse(created?.pending) ||
          proposalBatchFromResponse(created?.created) ||
          null;
        for (const target of targetsFromProposalBatch(batch)) {
          mintedByName.set(target.name.toLowerCase(), target);
        }
      } catch {
        hadFailure = true;
      }
    }
    resolvedCompanies = resolvedCompanies.map((company) => {
      const minted = !company.proposalId && mintedByName.get(company.name.toLowerCase());
      if (!minted) return company;
      return {
        ...company,
        proposalId: minted.proposalId,
        batchId: minted.batchId,
        classification: minted.classification,
        version: minted.version,
      };
    });
    // A partial mint (some unresolved chips got a proposalId back, others
    // didn't — e.g. no supported-ATS board found for one of them) still
    // leaves those chips silently unresolved from here down. That's a
    // real failure, not a fully successful save: surface the same soft
    // warning a thrown/rejected mint would.
    if (resolvedCompanies.some((company) => !company.proposalId)) hadFailure = true;
  }

  const keptSupported = resolvedCompanies.filter(
    (company) => company.proposalId && company.classification === "supported_ats"
  );
  const stillRemoved = (Array.isArray(removedProposals) ? removedProposals : []).filter(
    (company) => company.proposalId && !currentNames.has(company.name.toLowerCase())
  );

  for (const chip of keptSupported) {
    try {
      const outcome = await decideProposal({
        batchId: chip.batchId,
        proposal: chip,
        action: "approve-supported-ats",
        userConfirmed: true,
      });
      if (outcome?.conflict) hadFailure = true;
    } catch {
      hadFailure = true;
    }
  }

  for (const chip of stillRemoved) {
    try {
      const outcome = await decideProposal({
        batchId: chip.batchId,
        proposal: chip,
        action: "reject",
      });
      if (outcome?.conflict) hadFailure = true;
    } catch {
      hadFailure = true;
    }
  }

  return { hadFailure };
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
  const [removedProposals, setRemovedProposals] = useState([]);
  const [proposalBatch, setProposalBatch] = useState(initialProposalBatch);
  const [seedStatus, setSeedStatus] = useState(initialProposalBatch ? "ready" : "idle");
  const [seedError, setSeedError] = useState(null);
  const [seedAttempt, setSeedAttempt] = useState(0);

  const canUseCompanyProposals = runtimeCapabilities.companyProposals !== false;

  useEffect(() => {
    const trimmed = query.trim();
    if (trimmed.length < 2) {
      setSuggestions([]);
      return undefined;
    }
    let cancelled = false;
    const localSuggestions = resolveCompanySuggestions({
      query: trimmed,
      selectedCompanies: companies,
    });
    setSuggestions(localSuggestions);
    const timer = setTimeout(async () => {
      setSearching(true);
      try {
        const res = await searchLogos(trimmed);
        if (cancelled) return;
        setSuggestions(
          resolveCompanySuggestions({
            query: trimmed,
            selectedCompanies: companies,
            logoResults: res.ok ? res.results || [] : [],
          })
        );
      } catch {
        if (!cancelled) setSuggestions(localSuggestions);
      } finally {
        if (!cancelled) setSearching(false);
      }
    }, SEARCH_DEBOUNCE_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [query, companies]);

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
  }, [canUseCompanyProposals, companies.length, proposalBatch, seedAttempt]);

  function addCompany(name, domain) {
    const trimmed = String(name || "").trim();
    if (!trimmed) return;
    setCompanies((list) =>
      mergeCompanyTargets(list, [{ name: trimmed, domain, source: "manual" }])
    );
    setQuery("");
    setSuggestions([]);
  }

  function addBestCompanyMatch() {
    const resolved = resolveCompanySuggestions({
      query,
      selectedCompanies: companies,
      logoResults: suggestions,
    });
    const match = resolved[0];
    if (match) {
      addCompany(match.name || match.domain, match.domain);
      return;
    }
    addCompany(query, null);
  }

  function removeCompany(name) {
    const removed = companies.find((company) => company.name === name);
    if (removed?.source === "ai" && removed?.proposalId) {
      setRemovedProposals((current) => [...current, removed]);
    }
    setCompanies((list) => list.filter((company) => company.name !== name));
  }

  async function handleSaveAndNext() {
    setSaving(true);
    setError(null);
    try {
      const { hadFailure } = await reconcileCompanyProposalDecisions({
        companies,
        removedProposals,
      });
      await saveCandidateFile("targeting", { tracked_companies: companies.map((c) => c.name) });
      if (hadFailure) {
        showToast(
          "Some company boards couldn't be confirmed — CareerRat will retry later.",
          "warning"
        );
      } else {
        showToast("Saved.");
      }
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
            loading={saving}
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
              {saving && <span className="onboarding-step-status">Saving your companies…</span>}

              {seedStatus === "loading" ? (
                <div className="onboarding-companies__header">
                  <span className="onboarding-companies__status">Finding matches…</span>
                </div>
              ) : null}

              {error ? <InlineAlert message={error} /> : null}
              {seedError ? (
                <div className="onboarding-companies__seed-recovery">
                  <InlineAlert tone="warning" message={seedError} />
                  <button
                    type="button"
                    className="onboarding-companies__retry"
                    onClick={() => {
                      setProposalBatch(null);
                      setSeedAttempt((attempt) => attempt + 1);
                    }}
                  >
                    Retry suggestions
                  </button>
                </div>
              ) : null}

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

              <div className="onboarding-companies__combobox">
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
                        addBestCompanyMatch();
                      }
                    }}
                  />
                </Field>
                {suggestions.length ? (
                  // biome-ignore lint/a11y/useAriaPropsSupportedByRole: labelled container for a keyboard-reachable list of match buttons
                  <div className="onboarding-companies__suggestions" aria-label="Company matches">
                    {suggestions.map((s) => (
                      <button
                        type="button"
                        className="company-row company-row--suggestion"
                        key={`${s.name}-${s.domain}`}
                        onMouseDown={(event) => event.preventDefault()}
                        onClick={() => addCompany(s.name || s.domain, s.domain)}
                      >
                        <CompanyAvatar name={s.name || s.domain} domain={s.domain} />
                        <span className="company-row__main">
                          <span className="company-row__name">{s.name || s.domain}</span>
                          {s.domain ? (
                            <span className="company-row__domain">{s.domain}</span>
                          ) : null}
                        </span>
                        <span className="company-row__add">Add</span>
                      </button>
                    ))}
                  </div>
                ) : null}
              </div>
              {searching ? <p className="field__hint">Resolving…</p> : null}
            </section>
          </div>
        </section>
      </div>
    </OnboardingShell>
  );
}
