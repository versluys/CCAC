import { describe, expect, it } from 'vitest';
import {
  DEFAULT_GROWTH, DEFAULT_SCREEN, DEFAULT_WEIGHTS,
  availabilityFraction, capacityFraction, growthProjection, scoreCandidate, seatsForProjection, yearsTo80Pct,
} from '../src/scoring';

describe('capacity', () => {
  it('prefers a confirmed seat count over the estimated band', () => {
    const c = { capacity_est: 'unlikely', capacity_confirmed: 200 };
    const f = capacityFraction(c, DEFAULT_SCREEN);
    expect(f.value).toBe(1);
    expect(f.why).toMatch(/confirmed/);
  });

  it('scores the favoured 175-225 band above the wider screen band', () => {
    const favoured = capacityFraction({ capacity_confirmed: 200 }, DEFAULT_SCREEN).value;
    const wider = capacityFraction({ capacity_confirmed: 160 }, DEFAULT_SCREEN).value;
    expect(favoured).toBeGreaterThan(wider);
  });

  it('does not bury unknown capacity below known-too-small', () => {
    const unknown = capacityFraction({ capacity_est: 'unknown' }, DEFAULT_SCREEN).value;
    const unlikely = capacityFraction({ capacity_est: 'unlikely' }, DEFAULT_SCREEN).value;
    expect(unknown).toBeGreaterThan(unlikely);
  });

  it('treats an oversized building as a cost problem, not a disqualification', () => {
    const big = capacityFraction({ capacity_confirmed: 600 }, DEFAULT_SCREEN).value;
    const tiny = capacityFraction({ capacity_confirmed: 60 }, DEFAULT_SCREEN).value;
    expect(big).toBeGreaterThan(tiny);
    expect(big).toBeLessThan(1);
  });
});

describe('availability evidence', () => {
  it('is zero with nothing recorded and says so', () => {
    const a = availabilityFraction({});
    expect(a.value).toBe(0);
    expect(a.why).toMatch(/no availability evidence/);
  });

  it('accumulates independent signals and caps at 1', () => {
    const a = availabilityFraction({
      listed_for_lease: 1, listing_url: 'https://example.com/x', congregation_decline: 'merged 2024',
      shared_use_precedent: 1, service_schedule: 'Sun 9am', decision_maker: 'Session moderator',
    });
    expect(a.value).toBe(1);
    expect(a.why).toMatch(/listed for lease/);
  });
});

describe('fit_score', () => {
  it('normalises to 0-100 even when weights do not sum to 100', () => {
    const c = { capacity_est: 'likely_200+', share_hh_within_20min: 1, tenancy_possible: 'sole',
      listed_for_lease: 1, congregation_decline: 'closing', shared_use_precedent: 1,
      service_schedule: 'x', decision_maker: 'y', listing_url: 'z' };
    const weird = { drive_share_20min: 7, capacity_band: 7, availability_evidence: 7, tenancy_type: 7 };
    const s = scoreCandidate(c, weird, DEFAULT_SCREEN);
    expect(s.total).toBeCloseTo(100, 0);
  });

  it('returns one component per weighted factor, each with a reason', () => {
    const s = scoreCandidate({}, DEFAULT_WEIGHTS, DEFAULT_SCREEN);
    expect(s.components).toHaveLength(4);
    for (const c of s.components) expect(c.why.length).toBeGreaterThan(0);
  });

  it('ranks a sole-tenancy listed building above an identical shared, unlisted one', () => {
    const base = { capacity_est: 'possible', share_hh_within_20min: 0.5 };
    const good = scoreCandidate({ ...base, tenancy_possible: 'sole', listed_for_lease: 1 }, DEFAULT_WEIGHTS, DEFAULT_SCREEN);
    const meh = scoreCandidate({ ...base, tenancy_possible: 'shared' }, DEFAULT_WEIGHTS, DEFAULT_SCREEN);
    expect(good.total).toBeGreaterThan(meh.total);
  });

  it('never exceeds 100 or drops below 0', () => {
    const hi = scoreCandidate({ capacity_confirmed: 200, share_hh_within_20min: 5, tenancy_possible: 'sole',
      listed_for_lease: 1, congregation_decline: 'x', shared_use_precedent: 1, service_schedule: 'x',
      decision_maker: 'x', listing_url: 'x' }, DEFAULT_WEIGHTS, DEFAULT_SCREEN);
    const lo = scoreCandidate({ capacity_est: 'unlikely', share_hh_within_20min: -3, tenancy_possible: 'no' },
      DEFAULT_WEIGHTS, DEFAULT_SCREEN);
    expect(hi.total).toBeLessThanOrEqual(100);
    expect(lo.total).toBeGreaterThanOrEqual(0);
  });
});

describe('growth to 80% full', () => {
  it('matches the PRD formula n = ln(0.8 * seats / ASA) / ln(1 + g)', () => {
    const expected = Math.log((0.8 * 200) / 95) / Math.log(1.12);
    expect(yearsTo80Pct(200, 95, 0.12, 0.8)).toBeCloseTo(Math.round(expected * 10) / 10, 5);
  });

  it('returns 0 when the parish already exceeds the threshold', () => {
    expect(yearsTo80Pct(100, 95, 0.12, 0.8)).toBe(0);
  });

  it('returns null without a seat figure to project against', () => {
    expect(yearsTo80Pct(null, 95, 0.12, 0.8)).toBeNull();
    expect(seatsForProjection({ capacity_est: 'possible' }, DEFAULT_SCREEN)).toBeNull();
  });

  it('fills a 200-seat building sooner under surge than conservative growth', () => {
    const p = growthProjection(200, DEFAULT_GROWTH);
    expect(p.surge!).toBeLessThan(p.base!);
    expect(p.base!).toBeLessThan(p.conservative!);
  });

  it('projects a likely_200+ band against the favoured band midpoint', () => {
    expect(seatsForProjection({ capacity_est: 'likely_200+' }, DEFAULT_SCREEN)).toBe(200);
  });
});
