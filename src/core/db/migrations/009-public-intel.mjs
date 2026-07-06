// migrations/009-public-intel.mjs - Publishable public company/board metadata.
//
// These tables intentionally sit beside, not inside, candidate/source/tracker
// state. Rows are JSON payloads with generated columns for query paths; scrub
// validation is enforced in verbs before data reaches these tables.
export const migration009 = {
  id: 9,
  name: "public-intel",
  up(db) {
    db.exec(`
CREATE TABLE public_company_intel (
  id TEXT PRIMARY KEY,
  data TEXT NOT NULL CHECK (json_valid(data)),
  company_key TEXT GENERATED ALWAYS AS (CASE WHEN json_valid(data) THEN coalesce(json_extract(data,'$.companyKey'), json_extract(data,'$.company_key')) END) STORED,
  company_domain TEXT GENERATED ALWAYS AS (CASE WHEN json_valid(data) THEN coalesce(json_extract(data,'$.companyDomain'), json_extract(data,'$.company_domain')) END) STORED,
  provider TEXT GENERATED ALWAYS AS (CASE WHEN json_valid(data) THEN coalesce(json_extract(data,'$.provider'), json_extract(data,'$.atsProvider'), json_extract(data,'$.ats_provider')) END) STORED,
  confidence TEXT GENERATED ALWAYS AS (CASE WHEN json_valid(data) THEN json_extract(data,'$.confidence') END) STORED,
  freshness_status TEXT GENERATED ALWAYS AS (CASE WHEN json_valid(data) THEN coalesce(json_extract(data,'$.freshnessStatus'), json_extract(data,'$.freshness_status')) END) STORED,
  updated_at TEXT GENERATED ALWAYS AS (CASE WHEN json_valid(data) THEN coalesce(json_extract(data,'$.updatedAt'), json_extract(data,'$.updated_at')) END) STORED
) WITHOUT ROWID;
CREATE INDEX idx_public_company_intel_domain
  ON public_company_intel(company_domain, updated_at DESC);
CREATE INDEX idx_public_company_intel_company_key
  ON public_company_intel(company_key, updated_at DESC);
CREATE INDEX idx_public_company_intel_provider
  ON public_company_intel(provider, confidence, updated_at DESC);

CREATE TABLE public_board_intel (
  id TEXT PRIMARY KEY,
  data TEXT NOT NULL CHECK (json_valid(data)),
  company_key TEXT GENERATED ALWAYS AS (CASE WHEN json_valid(data) THEN coalesce(json_extract(data,'$.companyKey'), json_extract(data,'$.company_key')) END) STORED,
  board_url TEXT GENERATED ALWAYS AS (CASE WHEN json_valid(data) THEN coalesce(json_extract(data,'$.boardUrl'), json_extract(data,'$.jobBoardUrl'), json_extract(data,'$.job_board_url')) END) STORED,
  ats_provider TEXT GENERATED ALWAYS AS (CASE WHEN json_valid(data) THEN coalesce(json_extract(data,'$.atsProvider'), json_extract(data,'$.ats_provider')) END) STORED,
  source_kind TEXT GENERATED ALWAYS AS (CASE WHEN json_valid(data) THEN coalesce(json_extract(data,'$.sourceKind'), json_extract(data,'$.source_kind')) END) STORED,
  confidence TEXT GENERATED ALWAYS AS (CASE WHEN json_valid(data) THEN json_extract(data,'$.confidence') END) STORED,
  updated_at TEXT GENERATED ALWAYS AS (CASE WHEN json_valid(data) THEN coalesce(json_extract(data,'$.updatedAt'), json_extract(data,'$.updated_at')) END) STORED
) WITHOUT ROWID;
CREATE INDEX idx_public_board_intel_provider
  ON public_board_intel(ats_provider, source_kind, updated_at DESC);
CREATE INDEX idx_public_board_intel_company
  ON public_board_intel(company_key, updated_at DESC);

CREATE TABLE public_careers_pages (
  id TEXT PRIMARY KEY,
  data TEXT NOT NULL CHECK (json_valid(data)),
  company_key TEXT GENERATED ALWAYS AS (CASE WHEN json_valid(data) THEN coalesce(json_extract(data,'$.companyKey'), json_extract(data,'$.company_key')) END) STORED,
  page_url TEXT GENERATED ALWAYS AS (CASE WHEN json_valid(data) THEN coalesce(json_extract(data,'$.url'), json_extract(data,'$.careersUrl'), json_extract(data,'$.careers_url')) END) STORED,
  extraction_status TEXT GENERATED ALWAYS AS (CASE WHEN json_valid(data) THEN coalesce(json_extract(data,'$.extractionStatus'), json_extract(data,'$.extraction_status')) END) STORED,
  input_hash TEXT GENERATED ALWAYS AS (CASE WHEN json_valid(data) THEN coalesce(json_extract(data,'$.inputHash'), json_extract(data,'$.input_hash')) END) STORED,
  confidence TEXT GENERATED ALWAYS AS (CASE WHEN json_valid(data) THEN json_extract(data,'$.confidence') END) STORED,
  updated_at TEXT GENERATED ALWAYS AS (CASE WHEN json_valid(data) THEN coalesce(json_extract(data,'$.updatedAt'), json_extract(data,'$.updated_at')) END) STORED
) WITHOUT ROWID;
CREATE INDEX idx_public_careers_pages_status
  ON public_careers_pages(extraction_status, updated_at DESC);
CREATE INDEX idx_public_careers_pages_company
  ON public_careers_pages(company_key, updated_at DESC);
CREATE INDEX idx_public_careers_pages_url
  ON public_careers_pages(page_url);

CREATE TABLE public_intel_review_items (
  id TEXT PRIMARY KEY,
  data TEXT NOT NULL CHECK (json_valid(data)),
  company_key TEXT GENERATED ALWAYS AS (CASE WHEN json_valid(data) THEN coalesce(json_extract(data,'$.companyKey'), json_extract(data,'$.company_key')) END) STORED,
  status TEXT GENERATED ALWAYS AS (CASE WHEN json_valid(data) THEN json_extract(data,'$.status') END) STORED,
  reason TEXT GENERATED ALWAYS AS (CASE WHEN json_valid(data) THEN json_extract(data,'$.reason') END) STORED,
  version INTEGER GENERATED ALWAYS AS (CASE WHEN json_valid(data) THEN coalesce(json_extract(data,'$.version'), 0) END) STORED,
  updated_at TEXT GENERATED ALWAYS AS (CASE WHEN json_valid(data) THEN coalesce(json_extract(data,'$.updatedAt'), json_extract(data,'$.updated_at')) END) STORED
) WITHOUT ROWID;
CREATE INDEX idx_public_intel_review_items_status
  ON public_intel_review_items(status, reason, updated_at DESC);
CREATE INDEX idx_public_intel_review_items_company
  ON public_intel_review_items(company_key, updated_at DESC);

CREATE TABLE public_sync_preferences (
  id TEXT PRIMARY KEY,
  data TEXT NOT NULL CHECK (json_valid(data)),
  enabled INTEGER GENERATED ALWAYS AS (CASE WHEN json_valid(data) THEN json_extract(data,'$.enabled') END) STORED,
  source TEXT GENERATED ALWAYS AS (CASE WHEN json_valid(data) THEN json_extract(data,'$.source') END) STORED,
  updated_at TEXT GENERATED ALWAYS AS (CASE WHEN json_valid(data) THEN coalesce(json_extract(data,'$.updatedAt'), json_extract(data,'$.updated_at')) END) STORED
) WITHOUT ROWID;
CREATE INDEX idx_public_sync_preferences_enabled
  ON public_sync_preferences(enabled, updated_at DESC);
`);
  },
};
