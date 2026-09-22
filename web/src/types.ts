export type Status =
  | 'identified' | 'screened_out' | 'shortlisted' | 'researching'
  | 'contacted' | 'visited' | 'negotiating' | 'declined' | 'dead';

export type CapacityBand = 'likely_200+' | 'possible' | 'unlikely' | 'unknown';
export type Tenancy = 'sole' | 'shared' | 'either' | 'no' | 'unknown';
export type Overlap = 'yes' | 'no' | 'unknown';

export interface ScoreComponent {
  label: string;
  weight: number;
  fraction: number;
  points: number;
  why: string;
}

export interface Candidate {
  id: string;
  name: string;
  denomination: string | null;
  address: string | null;
  lat: number;
  lon: number;
  website: string | null;
  phone: string | null;
  footprint_ft2: number | null;
  parking_m2: number | null;
  parking_spaces_est: number | null;
  capacity_est: CapacityBand;
  capacity_confirmed: number | null;
  drive_min_from_center: number | null;
  distance_mi_from_center: number | null;
  share_hh_within_20min: number | null;
  tenancy_possible: Tenancy;
  lease_term_months: number | null;
  renewal_option: number | null;
  expansion_rights: string | null;
  transfer_overlap: Overlap;
  transfer_overlap_note: string | null;
  status: Status;
  listing_url: string | null;
  decision_maker: string | null;
  listed_for_lease: number | null;
  congregation_decline: string | null;
  shared_use_precedent: number | null;
  service_schedule: string | null;
  denomination_notes: string | null;
  source: string;
  updated_by: string | null;
  updated_at: string | null;
  fit_score: number;
  /** Present on the detail route only; the list route omits it to save payload. */
  score_breakdown?: ScoreComponent[];
  years_to_80pct: { conservative: number | null; base: number | null; surge: number | null };
  years_to_80pct_base: number | null;
  seats_basis: string;
  outgrows_lease: boolean;
}

export interface Note {
  id: string;
  candidate_id: string;
  author_email: string;
  body: string;
  kind: 'note' | 'call' | 'email' | 'visit' | 'research';
  created_at: string;
}

export interface Contact {
  id: string;
  candidate_id: string;
  name: string | null;
  role: string | null;
  email: string | null;
  phone: string | null;
}

export interface Household {
  id: string;
  lat: number | null;
  lon: number | null;
  zip: string | null;
  in_state: number;
  outlier: number;
  match_quality: string;
  corrected: number;
}

export interface Attender {
  id: string;
  zip: string;
  lat: number | null;
  lon: number | null;
  household_size: number;
  joined_within_12mo: number;
}

export interface Centroid {
  method: string;
  lat: number;
  lon: number;
  view?: string;
  n?: number;
  note?: string;
  dropped?: number;
  is_default?: boolean;
  drive_stats?: Record<string, number>;
  drive_stats_source?: string;
}

export interface DataQuality {
  totals: Record<string, number>;
  match_quality: Record<string, number>;
  capacity_bands: Record<string, number>;
  caveats: string[];
}

export interface Weights {
  drive_share_20min: number;
  capacity_band: number;
  availability_evidence: number;
  tenancy_type: number;
}

export interface Growth {
  asa_current: number;
  rates: { conservative: number; base: number; surge: number };
  target_fill: number;
}

export const STATUS_ORDER: Status[] = [
  'identified', 'researching', 'shortlisted', 'contacted',
  'visited', 'negotiating', 'declined', 'screened_out', 'dead',
];

export const STATUS_LABEL: Record<Status, string> = {
  identified: 'Identified',
  researching: 'Researching',
  shortlisted: 'Shortlisted',
  contacted: 'Contacted',
  visited: 'Visited',
  negotiating: 'Negotiating',
  declined: 'Declined',
  screened_out: 'Screened out',
  dead: 'Dead',
};

export const STATUS_COLOR: Record<Status, string> = {
  identified: '#8c8c8c',
  researching: '#4a7fb5',
  shortlisted: '#2f8f5b',
  contacted: '#c08a2e',
  visited: '#7a5cb8',
  negotiating: '#1f6f8f',
  declined: '#a84d4d',
  screened_out: '#6b6b6b',
  dead: '#4a4a4a',
};

export const CAPACITY_LABEL: Record<CapacityBand, string> = {
  'likely_200+': 'Likely 200+',
  possible: 'Possible',
  unlikely: 'Unlikely',
  unknown: 'Unknown',
};
