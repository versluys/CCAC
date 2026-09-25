/** Read-only routes: identity, households, centroids, settings, export. */

import { audit, driveShareWithin, getGrowth, getScreen, getSetting, getWeights, putSetting } from '../db';
import { error, json, readJson, type RouteContext } from '../http';
import { DEFAULT_WEIGHTS, growthProjection, scoreCandidate, seatsForProjection } from '../scoring';

export async function me({ identity, env }: RouteContext): Promise<Response> {
  return json({
    email: identity.email,
    sub: identity.sub,
    team: env.CF_ACCESS_TEAM_DOMAIN ?? null,
    environment: env.ENVIRONMENT ?? 'production',
  });
}

/**
 * Anonymous household points (R-P3, R-P4).
 *
 * This is the whole household surface the browser ever sees: id, coordinates
 * already rounded to 3 decimals upstream, ZIP, and flags. There is no route,
 * parameter or admin flag that returns a name, an address or an amount,
 * because no such column exists in this database.
 */
export async function households({ env }: RouteContext): Promise<Response> {
  const [hh, att] = await Promise.all([
    env.DB.prepare(
      'SELECT id, lat, lon, zip, in_state, outlier, match_quality, corrected FROM households_anon',
    ).all(),
    env.DB.prepare(
      'SELECT id, zip, lat, lon, household_size, joined_within_12mo FROM attenders_anon',
    ).all(),
  ]);
  const placed = hh.results.filter((h) => (h as { lat: number | null }).lat !== null);
  return json({
    households: hh.results,
    attenders: att.results,
    summary: {
      total: hh.results.length,
      placed: placed.length,
      unplaced: hh.results.length - placed.length,
      outliers: hh.results.filter((h) => (h as { outlier: number }).outlier === 1).length,
      attenders: att.results.length,
    },
    privacy_note:
      'Coordinates are rounded to roughly 110 m and carry no name, address or giving amount.',
  });
}

export async function centroids({ env }: RouteContext): Promise<Response> {
  const { results } = await env.DB.prepare('SELECT method, lat, lon, meta_json FROM centroids').all<{
    method: string;
    lat: number;
    lon: number;
    meta_json: string;
  }>();
  const out: Array<{ method: string; lat: number; lon: number } & Record<string, unknown>> = results.map((r) => {
    let meta: Record<string, unknown> = {};
    try {
      meta = JSON.parse(r.meta_json ?? '{}');
    } catch {
      meta = {};
    }
    return { method: r.method, lat: r.lat, lon: r.lon, ...meta };
  });
  const chosen = out.find((c) => c.is_default) ?? out[0] ?? null;
  return json({ default_method: chosen?.method ?? null, centroids: out });
}

/**
 * Routed drive-time isochrones as a GeoJSON FeatureCollection.
 *
 * Empty until scripts/isochrones.py has run, and the map falls back to plainly
 * labelled distance rings in that case rather than passing circles off as
 * drive times.
 */
export async function isochrones({ env }: RouteContext): Promise<Response> {
  const { results } = await env.DB.prepare(
    'SELECT minutes, center_lat, center_lon, method, geojson, cells, grid_spacing_km, generated_at '
    + 'FROM isochrones ORDER BY minutes',
  ).all<{
    minutes: number; center_lat: number; center_lon: number; method: string;
    geojson: string; cells: number; grid_spacing_km: number; generated_at: string;
  }>();

  const features = [];
  for (const r of results) {
    let geometry: unknown;
    try {
      geometry = JSON.parse(r.geojson);
    } catch {
      continue;
    }
    features.push({
      type: 'Feature' as const,
      properties: { minutes: r.minutes, cells: r.cells },
      geometry,
    });
  }
  const first = results[0];
  return json({
    type: 'FeatureCollection',
    features,
    center: first ? { lat: first.center_lat, lon: first.center_lon, method: first.method } : null,
    grid_spacing_km: first?.grid_spacing_km ?? null,
    generated_at: first?.generated_at ?? null,
    source: features.length ? 'OSRM driving profile over a sampled grid' : null,
    caveat: features.length
      ? 'Blocky at the grid spacing by design: each cell means a road there was reachable '
        + 'within the band. Free-flow times, so a Sunday morning drive is usually a little faster.'
      : 'Not computed yet. Run scripts/isochrones.py and re-seed.',
  });
}

/** Drive-share for an arbitrary point, used when the centre selector moves. */
export async function driveShare({ env, url }: RouteContext): Promise<Response> {
  const lat = Number(url.searchParams.get('lat'));
  const lon = Number(url.searchParams.get('lon'));
  const minutes = Number(url.searchParams.get('minutes') ?? '20');
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return error('lat and lon are required', 422);
  const bands = await Promise.all(
    [10, 15, 20, 30].map(async (m) => [m, await driveShareWithin(env.DB, lat, lon, m)] as const),
  );
  return json({
    lat,
    lon,
    requested_minutes: Number.isFinite(minutes) ? minutes : 20,
    bands: Object.fromEntries(bands.map(([m, v]) => [m, v])),
    source: 'straight-line proxy at 27 mph — not a routed drive time',
  });
}

export async function getSettings({ env, url }: RouteContext): Promise<Response> {
  const key = url.pathname.split('/').pop();
  if (key === 'weights') return json(await getWeights(env.DB));
  if (key === 'growth') return json(await getGrowth(env.DB));
  if (key === 'screen') return json(await getScreen(env.DB));
  const [weights, growth, screen] = await Promise.all([
    getWeights(env.DB),
    getGrowth(env.DB),
    getScreen(env.DB),
  ]);
  return json({ weights, growth, screen });
}

export async function putWeights({ env, request, identity }: RouteContext): Promise<Response> {
  let body: Record<string, unknown>;
  try {
    body = await readJson<Record<string, unknown>>(request);
  } catch (e) {
    return error((e as Error).message, 400);
  }
  const next: Record<string, number> = {};
  for (const key of Object.keys(DEFAULT_WEIGHTS)) {
    const v = Number(body[key]);
    if (!Number.isFinite(v) || v < 0 || v > 100) {
      return error(`weight "${key}" must be a number between 0 and 100`, 422);
    }
    next[key] = v;
  }
  if (Object.values(next).reduce((a, b) => a + b, 0) === 0) {
    return error('weights cannot all be zero', 422);
  }
  await putSetting(env.DB, 'weights', next);
  await audit(env.DB, identity.email, 'settings', 'weights', next);
  return json(next);
}

export async function putGrowth({ env, request, identity }: RouteContext): Promise<Response> {
  let body: { asa_current?: unknown; rates?: Record<string, unknown>; target_fill?: unknown };
  try {
    body = await readJson(request);
  } catch (e) {
    return error((e as Error).message, 400);
  }
  const current = await getGrowth(env.DB);
  const asa = Number(body.asa_current ?? current.asa_current);
  if (!Number.isFinite(asa) || asa <= 0 || asa > 10000) return error('asa_current must be a positive number', 422);
  const rates = { ...current.rates };
  for (const k of ['conservative', 'base', 'surge'] as const) {
    if (body.rates && body.rates[k] !== undefined) {
      const v = Number(body.rates[k]);
      if (!Number.isFinite(v) || v < 0 || v > 2) return error(`growth rate "${k}" must be between 0 and 2`, 422);
      rates[k] = v;
    }
  }
  const fill = Number(body.target_fill ?? current.target_fill);
  if (!Number.isFinite(fill) || fill <= 0 || fill > 1) return error('target_fill must be between 0 and 1', 422);
  const next = { asa_current: asa, rates, target_fill: fill };
  await putSetting(env.DB, 'growth', next);
  await audit(env.DB, identity.email, 'settings', 'growth', next);
  return json(next);
}

function csvCell(v: unknown): string {
  if (v === null || v === undefined) return '';
  const s = String(v);
  // Excel treats a leading =, +, - or @ as a formula. Prefix with an
  // apostrophe so a church name starting with one cannot execute anything.
  const safe = /^[=+\-@]/.test(s) ? `'${s}` : s;
  return /[",\r\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

/** Candidate export for vestry packets. Opens cleanly in Excel. */
export async function exportCsv({ env, identity }: RouteContext): Promise<Response> {
  const [{ results }, weights, screen, growth] = await Promise.all([
    env.DB.prepare('SELECT * FROM candidates').all<Record<string, unknown>>(),
    getWeights(env.DB),
    getScreen(env.DB),
    getGrowth(env.DB),
  ]);

  const columns = [
    ['name', 'Church'],
    ['denomination', 'Denomination'],
    ['address', 'Address'],
    ['status', 'Status'],
    ['fit_score', 'Fit score'],
    ['capacity_est', 'Capacity (estimated band)'],
    ['capacity_confirmed', 'Seats (confirmed)'],
    ['footprint_ft2', 'Footprint ft2'],
    ['parking_m2', 'Parking m2'],
    ['parking_spaces_est', 'Parking spaces (est)'],
    ['distance_mi_from_center', 'Miles from centre'],
    ['drive_min_from_center', 'Drive minutes from centre'],
    ['share_hh_within_20min', 'Share of households within 20 min'],
    ['tenancy_possible', 'Tenancy possible'],
    ['lease_term_months', 'Lease term (months)'],
    ['renewal_option', 'Renewal option'],
    ['expansion_rights', 'Expansion rights'],
    ['years_to_80pct_base', 'Years to 80% full (base case)'],
    ['outgrows_lease', 'Outgrows lease before term ends'],
    ['transfer_overlap', 'Transfer-source overlap'],
    ['transfer_overlap_note', 'Transfer overlap note'],
    ['listed_for_lease', 'Listed for lease'],
    ['listing_url', 'Listing URL'],
    ['congregation_decline', 'Congregation decline evidence'],
    ['shared_use_precedent', 'Shared-use precedent'],
    ['service_schedule', 'Service schedule'],
    ['decision_maker', 'Decision maker'],
    ['denomination_notes', 'Denomination notes'],
    ['website', 'Website'],
    ['phone', 'Phone'],
    ['lat', 'Latitude'],
    ['lon', 'Longitude'],
    ['source', 'Source'],
    ['updated_by', 'Last updated by'],
    ['updated_at', 'Last updated at'],
  ] as const;

  const rows = results.map((r) => {
    const score = scoreCandidate(r, weights, screen);
    const years = growthProjection(seatsForProjection(r, screen), growth);
    const leaseYears = typeof r.lease_term_months === 'number' ? (r.lease_term_months as number) / 12 : null;
    const enriched: Record<string, unknown> = {
      ...r,
      fit_score: score.total,
      years_to_80pct_base: years.base,
      outgrows_lease: years.base != null && leaseYears ? (years.base < leaseYears ? 'YES' : 'no') : '',
    };
    return columns.map(([key]) => csvCell(enriched[key])).join(',');
  });

  const header = columns.map(([, label]) => csvCell(label)).join(',');
  const note =
    `"Christ's Chapel site finder export. Capacity bands are ESTIMATES from building footprint and parking, not seat counts. ` +
    `Exported ${new Date().toISOString()} by ${identity.email}."`;
  // A UTF-8 BOM makes Excel read accented names correctly on Windows.
  const body = '﻿' + [note, '', header, ...rows].join('\r\n') + '\r\n';

  await audit(env.DB, identity.email, 'export', 'candidates.csv', { rows: rows.length });
  return new Response(body, {
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="ccac-candidates-${new Date().toISOString().slice(0, 10)}.csv"`,
      'Cache-Control': 'no-store',
    },
  });
}

/**
 * Geocode a free-text US address, for entering a candidate by address.
 *
 * Uses the Census geocoder, which is free, needs no key and is built for US
 * addresses. Nothing about the parish is sent: only the address string the
 * person typed, which is a commercial property, not a household.
 */
export async function geocode({ url }: RouteContext): Promise<Response> {
  const address = (url.searchParams.get('address') ?? '').trim();
  if (address.length < 5) return error('address is too short to geocode', 422);
  if (address.length > 300) return error('address is too long', 422);

  const target = new URL('https://geocoding.geo.census.gov/geocoder/locations/onelineaddress');
  target.searchParams.set('address', address);
  target.searchParams.set('benchmark', 'Public_AR_Current');
  target.searchParams.set('format', 'json');

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);
  try {
    const resp = await fetch(target, { signal: controller.signal });
    if (!resp.ok) return error(`geocoder returned ${resp.status}`, 502);
    const payload = (await resp.json()) as {
      result?: { addressMatches?: { matchedAddress?: string; coordinates?: { x: number; y: number } }[] };
    };
    const matches = payload.result?.addressMatches ?? [];
    if (matches.length === 0) {
      return json({ matches: [], note: 'No match. Enter the coordinates directly, or click the map.' });
    }
    return json({
      matches: matches.slice(0, 5).map((m) => ({
        address: m.matchedAddress ?? null,
        lat: m.coordinates?.y ?? null,
        lon: m.coordinates?.x ?? null,
      })).filter((m) => m.lat != null),
    });
  } catch {
    return error('the geocoder could not be reached; enter coordinates directly', 502);
  } finally {
    clearTimeout(timer);
  }
}

export async function dataQuality({ env }: RouteContext): Promise<Response> {
  // The ingest summary is carried in settings, not counted from rows, because
  // the donors it counts are precisely the ones that have no row: a household
  // with no address on file never enters households_anon. Counting rows would
  // report "43 of 43" and hide the 30 people nobody can place.
  const ingest = await getSetting<Record<string, unknown>>(env.DB, 'ingest', {});
  const [hh, cand] = await Promise.all([
    env.DB.prepare(
      `SELECT match_quality, COUNT(*) AS n FROM households_anon GROUP BY match_quality`,
    ).all<{ match_quality: string; n: number }>(),
    env.DB.prepare(
      `SELECT capacity_est, COUNT(*) AS n FROM candidates GROUP BY capacity_est`,
    ).all<{ capacity_est: string; n: number }>(),
  ]);
  const totals = await env.DB.prepare(
    `SELECT
       (SELECT COUNT(*) FROM households_anon) AS households,
       (SELECT COUNT(*) FROM households_anon WHERE lat IS NOT NULL) AS placed,
       (SELECT COUNT(*) FROM households_anon WHERE outlier = 1) AS outliers,
       (SELECT COUNT(*) FROM households_anon WHERE corrected = 1) AS corrected,
       (SELECT COUNT(*) FROM attenders_anon) AS attenders,
       (SELECT COUNT(*) FROM candidates) AS candidates,
       (SELECT COUNT(*) FROM candidates WHERE is_example = 1) AS examples,
       (SELECT COUNT(*) FROM candidates WHERE listed_for_lease = 1) AS listed,
       (SELECT COUNT(*) FROM candidates WHERE capacity_est = 'likely_200+') AS likely_200,
       (SELECT COUNT(*) FROM candidates WHERE status = 'shortlisted') AS shortlisted,
       (SELECT COUNT(*) FROM candidates WHERE status = 'contacted') AS contacted`,
  ).first<Record<string, number>>();

  const donorRowsTotal = typeof ingest.donor_rows_total === 'number'
    ? ingest.donor_rows_total
    : (totals?.households ?? 0);
  const placed = totals?.placed ?? 0;

  return json({
    totals: {
      ...totals,
      // Every donor row on file, including the ones with no address at all.
      donor_rows_total: donorRowsTotal,
      // Donors who cannot be put on a map, which is the number that matters.
      unplaced: Math.max(0, donorRowsTotal - placed),
      unplaced_no_address: ingest.unplaced_rows ?? null,
      ship_only_rows: ingest.ship_only_rows ?? null,
      overrides_applied: ingest.overrides_applied ?? null,
      outlier_threshold_mi: ingest.outlier_threshold_mi ?? null,
    },
    ingest,
    match_quality: Object.fromEntries(hh.results.map((r) => [r.match_quality, r.n])),
    capacity_bands: Object.fromEntries(cand.results.map((r) => [r.capacity_est, r.n])),
    caveats: [
      'The donor list is a proxy for the congregation, not the congregation. Households with no address on file cannot be placed at all.',
      'Some addressed donors are remote supporters rather than attenders; out-of-state households are excluded from every centroid.',
      'OpenStreetMap church coverage is incomplete and building polygons are often missing, so "unknown" capacity means unmapped, not small.',
      'Capacity bands are estimates from footprint and parking. Only a phone call or a visit produces a seat count.',
    ],
  });
}
