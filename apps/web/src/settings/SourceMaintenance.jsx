import { useCallback, useEffect, useState } from "react";
import { Button } from "../components/Button.jsx";
import { Card } from "../components/Card.jsx";
import { Field, TextField, Toggle } from "../components/form.jsx";
import { InlineAlert } from "../components/Toast.jsx";
import {
  addBoard,
  addSearchQuery,
  getSourceMaintenance,
  removeCompanyBoard,
  removeSearchSource,
  saveCompanyBoard,
  updateSearchSource,
} from "../lib/api.js";
import { resolveErrorCopy } from "../lib/errorCopy.js";

const SOURCE_API = {
  addBoard,
  addSearchQuery,
  getSourceMaintenance,
  removeCompanyBoard,
  removeSearchSource,
  saveCompanyBoard,
  updateSearchSource,
};

// Threads a real retry callback through a resolveErrorCopy() result — the
// resolved `action` carries {label, retry: true} with no callback of its
// own, so every catch below that wants the "Try again" button to actually do
// something supplies the exact call that just failed.
function errorState(error, onRetry) {
  const resolved = resolveErrorCopy(error);
  return resolved.action?.retry
    ? { ...resolved, action: { ...resolved.action, onRetry } }
    : resolved;
}

function formatWatermark(value) {
  if (!value) return "Never scanned";
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return String(value);
  return `Last scanned ${parsed.toLocaleString()}`;
}

function legitimacyLabel(value) {
  return (
    {
      supported: "Supported",
      "verified-ats": "Verified ATS",
      "consent-required": "Needs browser consent",
      "review-needed": "Review needed",
      unsupported: "Unsupported",
    }[value] || "Unknown"
  );
}

function sourceProviderLabel(value) {
  const normalized = String(value || "").toLowerCase();
  return (
    {
      remotevibecodingjobs: "Remote Vibe Coding Jobs",
      remoteok: "RemoteOK",
      workingnomads: "Working Nomads",
    }[normalized] || value
  );
}

function sourceTypeLabel(value) {
  return (
    {
      "url-query": "URL query",
      board: "Board",
      browser: "Browser",
    }[value] || value
  );
}

function replaceAt(rows, index, patch) {
  return rows.map((row, rowIndex) => (rowIndex === index ? { ...row, ...patch } : row));
}

export function SourceMaintenance({ api = SOURCE_API } = {}) {
  const [model, setModel] = useState({ searches: [], companies: [] });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(null);
  const [queryDraft, setQueryDraft] = useState({ label: "", query: "" });
  const [urlDraft, setUrlDraft] = useState({ label: "", url: "" });
  const [companyDraft, setCompanyDraft] = useState({ name: "", url: "" });
  const [pendingRemoval, setPendingRemoval] = useState(null);

  const reload = useCallback(async () => {
    const next = await api.getSourceMaintenance();
    setModel({ searches: next.searches || [], companies: next.companies || [] });
  }, [api]);

  const loadSources = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      await reload();
    } catch (err) {
      setError(errorState(err, loadSources));
    } finally {
      setLoading(false);
    }
  }, [reload]);

  useEffect(() => {
    let cancelled = false;
    api
      .getSourceMaintenance()
      .then((next) => {
        if (!cancelled)
          setModel({ searches: next.searches || [], companies: next.companies || [] });
      })
      .catch((err) => {
        if (!cancelled) setError(errorState(err, loadSources));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [api, loadSources]);

  async function mutate(key, action, after) {
    setBusy(key);
    setError(null);
    try {
      const next = await action();
      if (Array.isArray(next?.searches) && Array.isArray(next?.companies)) {
        setModel({ searches: next.searches, companies: next.companies });
      } else {
        await reload();
      }
      after?.();
    } catch (err) {
      setError(errorState(err, () => mutate(key, action, after)));
    } finally {
      setBusy(null);
    }
  }

  return (
    <SourceMaintenanceView
      busy={busy}
      companyDraft={companyDraft}
      error={error}
      loading={loading}
      model={model}
      pendingRemoval={pendingRemoval}
      onAddCompany={() =>
        mutate(
          "company-add",
          () => api.saveCompanyBoard({ ...companyDraft, enabled: true }),
          () => setCompanyDraft({ name: "", url: "" })
        )
      }
      onAddQuery={() =>
        mutate(
          "query-add",
          () => api.addSearchQuery({ ...queryDraft, provider: "HiringCafe" }),
          () => setQueryDraft({ label: "", query: "" })
        )
      }
      onCompanyDraft={setCompanyDraft}
      onCompanyEdit={(index, patch) =>
        setModel((current) => ({
          ...current,
          companies: replaceAt(current.companies, index, patch),
        }))
      }
      onCompanyRemove={(row) => {
        const key = `company-${row.index}`;
        if (pendingRemoval !== key) return setPendingRemoval(key);
        return mutate(
          `company-remove-${row.index}`,
          () => api.removeCompanyBoard(row.name),
          () => setPendingRemoval(null)
        );
      }}
      onCompanySave={(row) =>
        mutate(`company-save-${row.index}`, () =>
          api.saveCompanyBoard({
            originalName: row.originalName || row.name,
            name: row.name,
            url: row.url,
            enabled: row.enabled,
          })
        )
      }
      onImportUrl={() =>
        mutate(
          "url-add",
          () => api.addBoard(urlDraft),
          () => setUrlDraft({ label: "", url: "" })
        )
      }
      onQueryDraft={setQueryDraft}
      onRemovalCancel={() => setPendingRemoval(null)}
      onSearchEdit={(index, patch) =>
        setModel((current) => ({
          ...current,
          searches: replaceAt(current.searches, index, patch),
        }))
      }
      onSearchRemove={(row) => {
        const key = `search-${row.index}`;
        if (pendingRemoval !== key) return setPendingRemoval(key);
        return mutate(
          `search-remove-${row.index}`,
          () => api.removeSearchSource(row.index),
          () => setPendingRemoval(null)
        );
      }}
      onSearchSave={(row) => mutate(`search-save-${row.index}`, () => api.updateSearchSource(row))}
      onUrlDraft={setUrlDraft}
      queryDraft={queryDraft}
      urlDraft={urlDraft}
    />
  );
}

export function SourceMaintenanceView({
  busy,
  companyDraft,
  error,
  loading,
  model,
  pendingRemoval,
  onAddCompany,
  onAddQuery,
  onCompanyDraft,
  onCompanyEdit,
  onCompanyRemove,
  onCompanySave,
  onImportUrl,
  onQueryDraft,
  onRemovalCancel,
  onSearchEdit,
  onSearchRemove,
  onSearchSave,
  onUrlDraft,
  queryDraft,
  urlDraft,
}) {
  const searches = model?.searches || [];
  const companies = model?.companies || [];
  return (
    <Card title="Search sources">
      <p className="field__hint settings-sources__intro">
        These are the exact broad searches and company ATS boards used by Electron and the
        <code> careerrat searches</code> / <code>careerrat companies</code> commands.
      </p>
      {error ? (
        <InlineAlert message={error.message} action={error.action} detail={error.detail} />
      ) : null}
      {loading ? <p>Loading source configuration…</p> : null}

      <section className="settings-sources__section" aria-labelledby="broad-sources-heading">
        <div className="settings-sources__heading">
          <div>
            <h3 id="broad-sources-heading">Broad searches</h3>
            <p>Saved queries, feeds, imported board URLs, and authenticated result pages.</p>
          </div>
          <span>{searches.length} configured</span>
        </div>
        <div className="settings-sources__list">
          {searches.length ? (
            searches.map((row, index) => (
              <article className="settings-sources__row" key={`${row.provider}-${row.index}`}>
                <div className="settings-sources__meta">
                  <span>{sourceProviderLabel(row.provider)}</span>
                  <span>{sourceTypeLabel(row.sourceType)}</span>
                  <span>{legitimacyLabel(row.legitimacy)}</span>
                  <span>{formatWatermark(row.lastRunAt)}</span>
                </div>
                <div className="settings-sources__fields">
                  <TextField
                    aria-label={`Source ${index + 1} label`}
                    value={row.label}
                    onChange={(label) => onSearchEdit(index, { label })}
                  />
                  <TextField
                    aria-label={`Source ${index + 1} target`}
                    value={row.target}
                    onChange={(target) => onSearchEdit(index, { target })}
                  />
                </div>
                <div className="settings-sources__actions">
                  <Toggle
                    checked={row.enabled}
                    onChange={(enabled) => onSearchEdit(index, { enabled })}
                    label={row.enabled ? "Enabled" : "Disabled"}
                  />
                  <Button
                    variant="secondary"
                    disabled={Boolean(busy)}
                    onClick={() => onSearchSave(row)}
                  >
                    {busy === `search-save-${row.index}` ? "Saving…" : "Save"}
                  </Button>
                  {pendingRemoval === `search-${row.index}` ? (
                    <>
                      <Button
                        variant="danger"
                        disabled={Boolean(busy)}
                        onClick={() => onSearchRemove(row)}
                      >
                        Confirm remove
                      </Button>
                      <Button variant="ghost" disabled={Boolean(busy)} onClick={onRemovalCancel}>
                        Cancel
                      </Button>
                    </>
                  ) : (
                    <Button
                      variant="ghost"
                      disabled={Boolean(busy)}
                      onClick={() => onSearchRemove(row)}
                    >
                      Remove
                    </Button>
                  )}
                </div>
              </article>
            ))
          ) : (
            <p className="settings-sources__empty">No broad searches configured yet.</p>
          )}
        </div>
        <div className="settings-sources__add-grid">
          <section>
            <h4>Add a saved query</h4>
            <Field label="Label" htmlFor="source-query-label">
              <TextField
                id="source-query-label"
                value={queryDraft.label}
                onChange={(label) => onQueryDraft({ ...queryDraft, label })}
              />
            </Field>
            <Field label="Query" htmlFor="source-query-value">
              <TextField
                id="source-query-value"
                value={queryDraft.query}
                onChange={(query) => onQueryDraft({ ...queryDraft, query })}
              />
            </Field>
            <Button disabled={!queryDraft.query.trim() || Boolean(busy)} onClick={onAddQuery}>
              Add query
            </Button>
          </section>
          <section>
            <h4>Import a board URL</h4>
            <Field label="Label" htmlFor="source-url-label">
              <TextField
                id="source-url-label"
                value={urlDraft.label}
                onChange={(label) => onUrlDraft({ ...urlDraft, label })}
              />
            </Field>
            <Field label="Full URL" htmlFor="source-url-value">
              <TextField
                id="source-url-value"
                value={urlDraft.url}
                onChange={(url) => onUrlDraft({ ...urlDraft, url })}
              />
            </Field>
            <Button disabled={!urlDraft.url.trim() || Boolean(busy)} onClick={onImportUrl}>
              Import URL
            </Button>
          </section>
        </div>
      </section>

      <section className="settings-sources__section" aria-labelledby="company-sources-heading">
        <div className="settings-sources__heading">
          <div>
            <h3 id="company-sources-heading">Company ATS boards</h3>
            <p>Direct scans are accepted only for supported ATS hosts.</p>
          </div>
          <span>{companies.length} tracked</span>
        </div>
        <div className="settings-sources__list">
          {companies.length ? (
            companies.map((row, index) => (
              <article className="settings-sources__row" key={`${row.name}-${row.index}`}>
                <div className="settings-sources__meta">
                  <span>{sourceProviderLabel(row.provider)}</span>
                  <span>{legitimacyLabel(row.legitimacy)}</span>
                  <span>{formatWatermark(row.lastRunAt)}</span>
                </div>
                <div className="settings-sources__fields">
                  <TextField
                    aria-label={`Company ${index + 1} name`}
                    value={row.name}
                    onChange={(name) =>
                      onCompanyEdit(index, { name, originalName: row.originalName || row.name })
                    }
                  />
                  <TextField
                    aria-label={`Company ${index + 1} board URL`}
                    value={row.url}
                    onChange={(url) => onCompanyEdit(index, { url })}
                  />
                </div>
                <div className="settings-sources__actions">
                  <Toggle
                    checked={row.enabled}
                    onChange={(enabled) => onCompanyEdit(index, { enabled })}
                    label={row.enabled ? "Enabled" : "Disabled"}
                  />
                  <Button
                    variant="secondary"
                    disabled={Boolean(busy)}
                    onClick={() => onCompanySave(row)}
                  >
                    {busy === `company-save-${row.index}` ? "Saving…" : "Save"}
                  </Button>
                  {pendingRemoval === `company-${row.index}` ? (
                    <>
                      <Button
                        variant="danger"
                        disabled={Boolean(busy)}
                        onClick={() => onCompanyRemove(row)}
                      >
                        Confirm remove
                      </Button>
                      <Button variant="ghost" disabled={Boolean(busy)} onClick={onRemovalCancel}>
                        Cancel
                      </Button>
                    </>
                  ) : (
                    <Button
                      variant="ghost"
                      disabled={Boolean(busy)}
                      onClick={() => onCompanyRemove(row)}
                    >
                      Remove
                    </Button>
                  )}
                </div>
              </article>
            ))
          ) : (
            <p className="settings-sources__empty">No company ATS boards configured yet.</p>
          )}
        </div>
        <div className="settings-sources__company-add">
          <Field label="Company" htmlFor="source-company-name">
            <TextField
              id="source-company-name"
              value={companyDraft.name}
              onChange={(name) => onCompanyDraft({ ...companyDraft, name })}
            />
          </Field>
          <Field label="Supported ATS board URL" htmlFor="source-company-url">
            <TextField
              id="source-company-url"
              value={companyDraft.url}
              onChange={(url) => onCompanyDraft({ ...companyDraft, url })}
            />
          </Field>
          <Button
            disabled={!companyDraft.name.trim() || !companyDraft.url.trim() || Boolean(busy)}
            onClick={onAddCompany}
          >
            Add company board
          </Button>
        </div>
      </section>
    </Card>
  );
}
