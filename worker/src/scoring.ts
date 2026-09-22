/**
 * Scoring and growth projections (PRD 7.4a, 7.6).
 *
 * `fit_score` is a sorting aid, not a decision. Every component is returned
 * alongside the total so the drawer can show exactly why a candidate sits
 * where it does, and so a number nobody can explain never drives a vote.
 */

export interface Weights {
  drive_share_20min: number;
  capacity_band: number;
  availability_evidence: number;
  tenancy_type: number;
}

export const DEFAULT_WEIGHTS: Weights = {
  drive_share_20min: 35,
  capacity_band: 25,
  availability_evidence: 25,
  tenancy_type: 15,
};

export interface Growth {
  asa_current: number;
  rates: { conservative: number; base: number; surge: number };
  target_fill: number;
}

export const DEFAULT_GROWTH: Growth = {
  asa_current: 95,
  rates: { conservative: 0.08, base: 0.12, surge: 0.2 },
  target_fill: 0.8,
};

export interface ScreenSettings {
  seats_min: number;
  seats_max: number;
  seats_favor_min: number;
  seats_favor_max: number;
  search_radius_mi: number;
}

export const DEFAULT_SCREEN: ScreenSettings = {
  seats_min: 150,
  seats_max: 250,
  seats_favor_min: 175,
  seats_favor_max: 225,
  search_radius_mi: 20,
};

// 'unknown' scores at the midpoint rather than zero. An unmapped building is
// an absence of evidence, and ranking it below a building we know is too
// small would quietly bury exactly the candidates that need a phone call.
const CAPACITY_POINTS: Record<string, number> = {
  'likely_200+': 1.0,
  possible: 0.65,
  unknown: 0.45,
  unlikely: 0.1,
};

const TENANCY_POINTS: Record<string, number> = {
  sole: 1.0,
  either: 0.8,
  shared: 0.55,
  unknown: 0.35,
  no: 0.0,
};

export interface CandidateForScoring {
  capacity_est?: string | null;
  capacity_confirmed?: number | null;
  share_hh_within_20min?: number | null;
  tenancy_possible?: string | null;
  listed_for_lease?: number | null;
  shared_use_precedent?: number | null;
  listing_url?: string | null;
  decision_maker?: string | null;
  congregation_decline?: string | null;
  service_schedule?: string | null;
  transfer_overlap?: string | null;
}

export interface ScoreBreakdown {
  total: number;
  components: { label: string; weight: number; fraction: number; points: number; why: string }[];
}

/** Evidence of availability, 0..1. Each signal is something a person found. */
export function availabilityFraction(c: CandidateForScoring): { value: number; why: string } {
  const signals: string[] = [];
  let score = 0;
  if (c.listed_for_lease) {
    score += 0.45;
    signals.push('listed for lease or sale');
  }
  if (c.listing_url) {
    score += 0.05;
    signals.push('listing link on file');
  }
  if (c.congregation_decline && c.congregation_decline.trim()) {
    score += 0.2;
    signals.push('congregation in decline, merged or closed');
  }
  if (c.shared_use_precedent) {
    score += 0.15;
    signals.push('already hosts another congregation');
  }
  if (c.service_schedule && c.service_schedule.trim()) {
    score += 0.1;
    signals.push('service schedule known');
  }
  if (c.decision_maker && c.decision_maker.trim()) {
    score += 0.1;
    signals.push('decision-maker identified');
  }
  return {
    value: Math.min(1, score),
    why: signals.length ? signals.join('; ') : 'no availability evidence recorded yet',
  };
}

/** Capacity fraction, preferring a confirmed seat count over the estimate. */
export function capacityFraction(
  c: CandidateForScoring,
  screen: ScreenSettings,
): { value: number; why: string } {
  const seats = c.capacity_confirmed;
  if (typeof seats === 'number' && seats > 0) {
    if (seats >= screen.seats_favor_min && seats <= screen.seats_favor_max) {
      return { value: 1.0, why: `${seats} seats confirmed, inside the favoured band` };
    }
    if (seats >= screen.seats_min && seats <= screen.seats_max) {
      return { value: 0.8, why: `${seats} seats confirmed, inside the screen band` };
    }
    if (seats > screen.seats_max) {
      // Too big is a cost problem, not a disqualification.
      return { value: 0.55, why: `${seats} seats confirmed, larger than needed` };
    }
    return { value: 0.15, why: `${seats} seats confirmed, below the ${screen.seats_min}-seat floor` };
  }
  const band = c.capacity_est ?? 'unknown';
  const value = CAPACITY_POINTS[band] ?? CAPACITY_POINTS.unknown;
  return { value, why: `estimated band "${band}" — not a seat count; confirm by phone or visit` };
}

export function scoreCandidate(
  c: CandidateForScoring,
  weights: Weights,
  screen: ScreenSettings,
): ScoreBreakdown {
  const drive = Math.max(0, Math.min(1, c.share_hh_within_20min ?? 0));
  const cap = capacityFraction(c, screen);
  const avail = availabilityFraction(c);
  const tenancyKey = c.tenancy_possible ?? 'unknown';
  const tenancy = TENANCY_POINTS[tenancyKey] ?? TENANCY_POINTS.unknown;

  const components = [
    {
      label: 'Drive-time share of households within 20 min',
      weight: weights.drive_share_20min,
      fraction: drive,
      points: drive * weights.drive_share_20min,
      why:
        c.share_hh_within_20min == null
          ? 'not computed yet — run the drive-time pass'
          : `${Math.round(drive * 100)}% of households within 20 minutes`,
    },
    {
      label: 'Capacity estimate band',
      weight: weights.capacity_band,
      fraction: cap.value,
      points: cap.value * weights.capacity_band,
      why: cap.why,
    },
    {
      label: 'Availability evidence',
      weight: weights.availability_evidence,
      fraction: avail.value,
      points: avail.value * weights.availability_evidence,
      why: avail.why,
    },
    {
      label: 'Tenancy type possible',
      weight: weights.tenancy_type,
      fraction: tenancy,
      points: tenancy * weights.tenancy_type,
      why: `tenancy recorded as "${tenancyKey}" (sole preferred, shared acceptable)`,
    },
  ];

  const weightSum = components.reduce((a, b) => a + b.weight, 0);
  const raw = components.reduce((a, b) => a + b.points, 0);
  // Normalise so edited weights that do not add to 100 still yield 0-100.
  const total = weightSum > 0 ? (raw / weightSum) * 100 : 0;
  return { total: Math.round(total * 10) / 10, components };
}

/**
 * Years until the congregation fills `target_fill` of a building's seats.
 *   n = ln(target * seats / ASA) / ln(1 + g)
 * Returns null when there is no seat figure to project against, and 0 when
 * the parish is already at or past that threshold on day one.
 */
export function yearsTo80Pct(seats: number | null | undefined, asa: number, g: number, targetFill: number): number | null {
  if (!seats || seats <= 0 || asa <= 0 || g <= 0) return null;
  const ratio = (targetFill * seats) / asa;
  if (ratio <= 1) return 0;
  return Math.round((Math.log(ratio) / Math.log(1 + g)) * 10) / 10;
}

export function growthProjection(
  seats: number | null | undefined,
  growth: Growth,
): { conservative: number | null; base: number | null; surge: number | null } {
  return {
    conservative: yearsTo80Pct(seats, growth.asa_current, growth.rates.conservative, growth.target_fill),
    base: yearsTo80Pct(seats, growth.asa_current, growth.rates.base, growth.target_fill),
    surge: yearsTo80Pct(seats, growth.asa_current, growth.rates.surge, growth.target_fill),
  };
}

/** Seats a candidate should be projected against: confirmed, else band midpoint. */
export function seatsForProjection(c: CandidateForScoring, screen: ScreenSettings): number | null {
  if (typeof c.capacity_confirmed === 'number' && c.capacity_confirmed > 0) return c.capacity_confirmed;
  if (c.capacity_est === 'likely_200+') return Math.round((screen.seats_favor_min + screen.seats_favor_max) / 2);
  return null;
}
