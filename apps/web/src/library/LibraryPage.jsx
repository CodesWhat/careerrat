import { useMemo, useState } from "react";
import { useDashboardSnapshot } from "../app-shell/DashboardContext.jsx";
import { Button } from "../components/Button.jsx";
import { Card } from "../components/Card.jsx";
import { Chip } from "../components/Chip.jsx";
import { AlertIcon, LibraryIcon, SearchIcon } from "../components/icons.jsx";
import { PageScaffold } from "../components/PageScaffold.jsx";
import { InlineAlert } from "../components/Toast.jsx";
import "./LibraryPage.css";

const TYPE_FILTERS = [
  { key: "all", label: "All" },
  { key: "evidence", label: "Evidence" },
  { key: "story", label: "Stories" },
  { key: "voice", label: "Voice" },
];

const EMPTY_LIBRARY = {
  metrics: { claims: 0, stories: 0, gaps: 0 },
  index: [],
  filters: [],
  cards: [],
  readiness: { proof: 0, stories: 0, voice: 0 },
  gaps: [],
  storyLanes: [],
};

const TONE_NAMES = new Set(["teal", "sky", "gold", "plum", "coral"]);

function objectList(value) {
  return Array.isArray(value) ? value.filter((item) => item && typeof item === "object") : [];
}

function normalize(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

function tagLabels(card) {
  return objectList(card?.tags)
    .map((tag) => String(tag.label || "").trim())
    .filter(Boolean);
}

function laneNeedles(lane) {
  const body = String(lane || "").trim();
  if (!body) return [];
  const [label, detail] = body.split(/:\s+/, 2);
  return [label, detail, body].map(normalize).filter(Boolean);
}

function cardHaystack(card) {
  return normalize(
    [card?.kind, card?.label, card?.title, card?.summary, card?.note, ...tagLabels(card)].join(" ")
  );
}

export function filterLibraryCards(cards, filters = {}) {
  const type = normalize(filters.type || "all");
  const family = normalize(filters.family);
  const lane = laneNeedles(filters.lane);
  const query = normalize(filters.query);

  return objectList(cards).filter((card) => {
    const kind = normalize(card.kind || "evidence");
    const tags = normalize(tagLabels(card).join(" "));
    const haystack = cardHaystack(card);

    if (type && type !== "all" && kind !== type) return false;
    if (family && !tags.includes(family) && !haystack.includes(family)) return false;
    if (lane.length && !lane.some((needle) => tags.includes(needle) || haystack.includes(needle))) {
      return false;
    }
    if (query && !haystack.includes(query)) return false;
    return true;
  });
}

function normalizeLibrary(library) {
  if (!library || typeof library !== "object") return EMPTY_LIBRARY;
  return {
    metrics: library.metrics || EMPTY_LIBRARY.metrics,
    index: objectList(library.index),
    filters: objectList(library.filters),
    cards: objectList(library.cards),
    readiness: library.readiness || EMPTY_LIBRARY.readiness,
    gaps: objectList(library.gaps),
    storyLanes: objectList(library.storyLanes),
  };
}

function safeTone(tone) {
  return TONE_NAMES.has(tone) ? tone : "teal";
}

function formatReadinessValue(key, value) {
  if (key === "voice") return Number(value || 0) > 0 ? "Ready" : "Missing";
  return String(Number(value || 0));
}

function SummaryTile({ label, value }) {
  return (
    <div className="library-summary-tile">
      <strong>{value}</strong>
      <span>{label}</span>
    </div>
  );
}

function FilterButton({ active, children, className = "", ...props }) {
  return (
    <button
      type="button"
      className={`library-filter-button${active ? " library-filter-button--active" : ""} ${className}`.trim()}
      aria-pressed={active}
      {...props}
    >
      {children}
    </button>
  );
}

function LibraryTag({ tag }) {
  const label = String(tag?.label || "").trim();
  if (!label) return null;
  return (
    <span className="library-tag" data-tone={safeTone(tag?.tone)}>
      {label}
    </span>
  );
}

function EvidenceCard({ card }) {
  const kind = card.kind || "evidence";
  const tags = objectList(card.tags);

  return (
    <article
      className="card library-evidence-card"
      data-library-card={kind}
      data-claim-type={kind}
      data-claim-title={card.title || ""}
      data-claim-summary={card.summary || ""}
      data-claim-note={card.note || ""}
      data-claim-tags={tagLabels(card).join(", ")}
    >
      <div className="library-card-heading">
        <span className="library-card-label">{card.label || "Evidence Library"}</span>
        <h3>{card.title || "Reusable material"}</h3>
      </div>
      {card.summary ? <p className="library-card-summary">{card.summary}</p> : null}
      {tags.length ? (
        <div className="library-tag-row">
          {tags.map((tag, index) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: tag labels can repeat; no stable id available
            <LibraryTag key={`${tag.label || "tag"}-${index}`} tag={tag} />
          ))}
        </div>
      ) : null}
      {card.note ? <p className="library-card-note">{card.note}</p> : null}
    </article>
  );
}

function EmptyLibraryState() {
  return (
    <Card className="library-empty-state">
      <div className="library-empty-state__icon" aria-hidden="true">
        <LibraryIcon />
      </div>
      <div>
        <h2>No reusable material yet</h2>
        <p>
          Run ingest-profile or capture evidence, STAR stories, and writing voice so Rolester has a
          durable bank to browse here.
        </p>
      </div>
    </Card>
  );
}

function NoResultsState({ onReset }) {
  return (
    <div className="library-no-results">
      <p>No matches. Clear search or filters to see the full bank.</p>
      <Button variant="secondary" onClick={onReset}>
        Clear filters
      </Button>
    </div>
  );
}

export function LibraryPage() {
  const { data, loading, error, noDatabase } = useDashboardSnapshot();
  const [type, setType] = useState("all");
  const [family, setFamily] = useState("");
  const [lane, setLane] = useState("");
  const [query, setQuery] = useState("");

  const library = normalizeLibrary(data?.library);
  const filteredCards = useMemo(
    () => filterLibraryCards(library.cards, { type, family, lane, query }),
    [library.cards, type, family, lane, query]
  );

  function resetFilters() {
    setType("all");
    setFamily("");
    setLane("");
    setQuery("");
  }

  if (noDatabase) {
    return (
      <PageScaffold title="Library">
        <InlineAlert message="No database workspace detected. Run `rolester data import` or `rolester data init`, then reload." />
      </PageScaffold>
    );
  }

  return (
    <PageScaffold
      title="Library"
      subtitle="The full reusable evidence, story, and writing-voice bank from the shared dashboard snapshot."
      wide
    >
      {error ? <InlineAlert message={error} /> : null}
      {loading && !data ? <p>Loading...</p> : null}

      {data ? (
        <>
          <section className="library-summary" aria-label="Library summary">
            <Card title="Bank status" className="library-summary-card">
              <div className="library-summary-grid">
                {(library.index.length
                  ? library.index
                  : [
                      { label: "Claims", value: library.metrics.claims },
                      { label: "Stories", value: library.metrics.stories },
                      { label: "Gaps", value: library.metrics.gaps },
                    ]
                ).map((item) => (
                  <SummaryTile
                    key={item.label || item.value}
                    label={item.label || "Metric"}
                    value={item.value ?? "0"}
                  />
                ))}
              </div>
            </Card>

            <Card title="Readiness" className="library-summary-card">
              <div className="library-readiness-row">
                {Object.entries(library.readiness || EMPTY_LIBRARY.readiness).map(
                  ([key, value]) => (
                    <Chip key={key}>
                      {key}: {formatReadinessValue(key, value)}
                    </Chip>
                  )
                )}
              </div>
              <p className="library-muted">
                Proof, stories, and voice are shown as reusable inputs, not one-off dashboard
                teasers.
              </p>
            </Card>

            <Card title="Claim guardrails" className="library-summary-card">
              <div className="library-gap-list">
                {library.gaps.length ? (
                  library.gaps.map((gap, index) => (
                    <div
                      // biome-ignore lint/suspicious/noArrayIndexKey: gap titles can repeat; no stable id available
                      key={`${gap.title || "gap"}-${index}`}
                      className="library-gap-row"
                      data-tone={safeTone(gap.tone)}
                    >
                      <AlertIcon />
                      <span>
                        <strong>{gap.title || "Claim gap"}</strong>
                        {gap.body ? ` - ${gap.body}` : null}
                      </span>
                    </div>
                  ))
                ) : (
                  <p className="library-muted">No guardrails are open in the current snapshot.</p>
                )}
              </div>
            </Card>
          </section>

          {library.cards.length ? (
            <>
              <section className="library-lanes" aria-label="Story lanes">
                <div>
                  <h2>Story lanes</h2>
                  <p>Use a lane to narrow the bank around a reusable interview theme.</p>
                </div>
                <div className="library-lane-row">
                  {library.storyLanes.length ? (
                    library.storyLanes.map((item, index) => {
                      const body = String(item.body || "").trim();
                      return (
                        <FilterButton
                          // biome-ignore lint/suspicious/noArrayIndexKey: lane bodies can repeat; no stable id available
                          key={`${body || "lane"}-${index}`}
                          active={lane === body}
                          className="library-lane-button"
                          data-tone={safeTone(item.tone)}
                          onClick={() => setLane(lane === body ? "" : body)}
                        >
                          {body || "Story lane"}
                        </FilterButton>
                      );
                    })
                  ) : (
                    <span className="library-muted">No story lanes in this snapshot yet.</span>
                  )}
                </div>
              </section>

              <section className="library-toolbar" aria-label="Library filters">
                <label className="library-searchbox">
                  <SearchIcon />
                  <input
                    type="search"
                    value={query}
                    onChange={(event) => setQuery(event.target.value)}
                    placeholder="Search proof, stories, voice..."
                    aria-label="Search library"
                  />
                </label>

                <div className="library-filter-group">
                  {TYPE_FILTERS.map((item) => (
                    <FilterButton
                      key={item.key}
                      active={type === item.key}
                      onClick={() => setType(item.key)}
                    >
                      {item.label}
                    </FilterButton>
                  ))}
                </div>

                <div className="library-filter-group">
                  {library.filters.length ? (
                    library.filters.map((item) => {
                      const label = String(item.label || "").trim();
                      return (
                        <FilterButton
                          key={label || item.count}
                          active={family === label}
                          onClick={() => setFamily(family === label ? "" : label)}
                        >
                          <span>{label || "Tag"}</span>
                          <b>{item.count ?? 0}</b>
                        </FilterButton>
                      );
                    })
                  ) : (
                    <span className="library-muted">No family tags yet.</span>
                  )}
                </div>

                {type !== "all" || family || lane || query ? (
                  <Button variant="secondary" onClick={resetFilters}>
                    Clear filters
                  </Button>
                ) : null}
              </section>

              <div className="library-result-count" aria-live="polite">
                Showing {filteredCards.length} of {library.cards.length}
              </div>

              {filteredCards.length ? (
                <section className="library-card-grid" aria-label="Library cards">
                  {filteredCards.map((card, index) => (
                    <EvidenceCard
                      key={`${card.kind || "card"}-${card.title || card.summary || index}`}
                      card={card}
                    />
                  ))}
                </section>
              ) : (
                <NoResultsState onReset={resetFilters} />
              )}
            </>
          ) : (
            <EmptyLibraryState />
          )}
        </>
      ) : null}
    </PageScaffold>
  );
}
