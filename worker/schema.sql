-- Christ's Chapel Site Finder — D1 schema (PRD §8)
-- Applied with:  wrangler d1 execute ccac-sitefinder --file=worker/schema.sql

PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS candidates (
  id TEXT PRIMARY KEY,               -- osm:<type>/<id> | gplace:<id> | manual:<uuid>
  name TEXT NOT NULL,
  denomination TEXT,
  address TEXT,
  lat REAL NOT NULL, lon REAL NOT NULL,
  website TEXT, phone TEXT,
  footprint_ft2 REAL, parking_m2 REAL,
  capacity_est TEXT CHECK (capacity_est IN ('likely_200+','possible','unlikely','unknown')) DEFAULT 'unknown',
  capacity_confirmed INTEGER,        -- seats, once verified by phone or visit
  drive_min_from_center REAL,
  share_hh_within_20min REAL,
  tenancy_possible TEXT CHECK (tenancy_possible IN ('sole','shared','either','no','unknown')) DEFAULT 'unknown',
  lease_term_months INTEGER,
  renewal_option INTEGER,            -- 0/1
  expansion_rights TEXT,             -- fellowship hall, second service slot, office
  transfer_overlap TEXT CHECK (transfer_overlap IN ('yes','no','unknown')) DEFAULT 'unknown',
  transfer_overlap_note TEXT,
  years_to_80pct_base REAL,
  status TEXT CHECK (status IN ('identified','screened_out','shortlisted','researching','contacted','visited','negotiating','declined','dead')) DEFAULT 'identified',
  listing_url TEXT,
  decision_maker TEXT,
  -- availability evidence (PRD 7.5)
  listed_for_lease INTEGER,          -- 0/1
  congregation_decline TEXT,
  shared_use_precedent INTEGER,      -- 0/1
  service_schedule TEXT,
  denomination_notes TEXT,
  fit_score REAL,
  source TEXT NOT NULL,
  distance_mi_from_center REAL,
  parking_spaces_est INTEGER,
  -- How many parking polygons were attributed, and whether the total is large
  -- enough that the lot almost certainly belongs to a neighbouring mall or
  -- school. A flagged lot never raises the capacity band.
  parking_lots_counted INTEGER,
  parking_shared_suspect INTEGER,
  updated_by TEXT, updated_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_candidates_status ON candidates(status);
CREATE INDEX IF NOT EXISTS idx_candidates_capacity ON candidates(capacity_est);

CREATE TABLE IF NOT EXISTS notes (
  id TEXT PRIMARY KEY,
  candidate_id TEXT NOT NULL REFERENCES candidates(id) ON DELETE CASCADE,
  author_email TEXT NOT NULL,        -- from the verified Access JWT, never client-supplied
  body TEXT NOT NULL,
  kind TEXT CHECK (kind IN ('note','call','email','visit','research')) DEFAULT 'note',
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_notes_candidate ON notes(candidate_id, created_at DESC);

-- Church-side contacts only. Donor and parishioner contact details never
-- enter this database (PRD §2, §4).
CREATE TABLE IF NOT EXISTS contacts (
  id TEXT PRIMARY KEY,
  candidate_id TEXT NOT NULL REFERENCES candidates(id) ON DELETE CASCADE,
  name TEXT, role TEXT, email TEXT, phone TEXT
);
CREATE INDEX IF NOT EXISTS idx_contacts_candidate ON contacts(candidate_id);

-- Anonymous household points only: {id, lat, lon, zip, flags}, lat/lon
-- rounded to 3 decimals upstream (R-P3). No names, ever.
CREATE TABLE IF NOT EXISTS households_anon (
  id TEXT PRIMARY KEY, lat REAL, lon REAL, zip TEXT,
  in_state INTEGER, outlier INTEGER, match_quality TEXT, corrected INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS attenders_anon (
  id TEXT PRIMARY KEY, zip TEXT, lat REAL, lon REAL,
  household_size INTEGER, joined_within_12mo INTEGER
);

CREATE TABLE IF NOT EXISTS centroids (method TEXT PRIMARY KEY, lat REAL, lon REAL, meta_json TEXT);

-- Routed drive-time isochrones from the chosen centre, one row per minute
-- band, each holding a GeoJSON geometry. These come from scripts/isochrones.py
-- and are the real reachable areas; the map used to draw circles instead,
-- which is a different and much friendlier claim than the roads support.
CREATE TABLE IF NOT EXISTS isochrones (
  minutes INTEGER PRIMARY KEY,
  center_lat REAL, center_lon REAL, method TEXT,
  geojson TEXT NOT NULL,
  cells INTEGER,
  grid_spacing_km REAL,
  generated_at TEXT
);

-- Routed drive times from one candidate church to every placed household.
--
-- This is the question the committee actually asks of a building: if we lease
-- this one, how far does the congregation drive? With a few dozen households a
-- single OSRM table request answers it exactly, so this is cheap to compute and
-- worth caching rather than approximating from a contour.
CREATE TABLE IF NOT EXISTS candidate_drive (
  candidate_id TEXT PRIMARY KEY REFERENCES candidates(id) ON DELETE CASCADE,
  computed_at TEXT NOT NULL,
  source TEXT NOT NULL,            -- 'osrm' or 'proxy'
  households INTEGER,
  minutes_json TEXT NOT NULL,      -- { household_id: minutes }
  bands_json TEXT NOT NULL,        -- { "15": {share, count}, ... }
  median_min REAL,
  mean_min REAL
);

CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT);

CREATE TABLE IF NOT EXISTS audit_log (
  id TEXT PRIMARY KEY, actor TEXT, action TEXT, entity TEXT, at TEXT, detail TEXT
);
CREATE INDEX IF NOT EXISTS idx_audit_at ON audit_log(at DESC);
