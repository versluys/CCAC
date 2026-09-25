/** /api/candidates — the outreach pipeline itself. */

import { audit, driveShareWithin, getGrowth, getScreen, getWeights, haversineMi, PROXY_MPH } from '../db';
import { error, json, readJson, type RouteContext } from '../http';
import { DRIVE_BANDS, driveMinutesFrom, summarise } from '../osrm';
import { growthProjection, scoreCandidate, seatsForProjection } from '../scoring';

const STATUSES = [
  'identified', 'screened_out', 'shortlisted', 'researching',
  'contacted', 'visited', 'negotiating', 'declined', 'dead',
] as const;
const CAPACITIES = ['likely_200+', 'possible', 'unlikely', 'unknown'] as const;
const TENANCIES = ['sole', 'shared', 'either', 'no', 'unknown'] as const;
const OVERLAPS = ['yes', 'no', 'unknown'] as const;
const NOTE_KINDS = ['note', 'call', 'email', 'visit', 'research'] as const;

/** Fields a signed-in committee member may set. Anything else is ignored. */
const WRITABLE: Record<string, 'text' | 'number' | 'bool' | readonly string[]> = {
  name: 'text',
  denomination: 'text',
  address: 'text',
  website: 'text',
  phone: 'text',
  capacity_confirmed: 'number',
  capacity_est: CAPACITIES,
  tenancy_possible: TENANCIES,
  lease_term_months: 'number',
  renewal_option: 'bool',
  expansion_rights: 'text',
  transfer_overlap: OVERLAPS,
  transfer_overlap_note: 'text',
  status: STATUSES,
  listing_url: 'text',
  decision_maker: 'text',
  listed_for_lease: 'bool',
  congregation_decline: 'text',
  shared_use_precedent: 'bool',
  service_schedule: 'text',
  denomination_notes: 'text',
  footprint_ft2: 'number',
  parking_m2: 'number',
  lat: 'number',
  lon: 'number',
};

function coerce(field: string, value: unknown): unknown | undefined {
  const spec = WRITABLE[field];
  if (!spec) return undefined;
  if (value === null) return null;
  if (Array.isArray(spec)) {
    return typeof value === 'string' && (spec as readonly string[]).includes(value) ? value : undefined;
  }
  if (spec === 'number') {
    const n = typeof value === 'number' ? value : Number(value);
    return Number.isFinite(n) ? n : undefined;
  }
  if (spec === 'bool') return value ? 1 : 0;
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  // A 20k-character paste into a text field is a mistake, not a note.
  return trimmed.length > 4000 ? trimmed.slice(0, 4000) : trimmed;
}

interface CandidateRow {
  id: string;
  name: string;
  lat: number;
  lon: number;
  capacity_est: string | null;
  capacity_confirmed: number | null;
  share_hh_within_20min: number | null;
  [k: string]: unknown;
}

async function decorate(db: D1Database, rows: CandidateRow[]) {
  const [weights, screen, growth] = await Promise.all([getWeights(db), getScreen(db), getGrowth(db)]);
  return rows.map((row) => {
    const score = scoreCandidate(row, weights, screen);
    const seats = seatsForProjection(row, screen);
    const years = growthProjection(seats, growth);
    return {
      ...row,
      fit_score: score.total,
      score_breakdown: score.components,
      years_to_80pct: years,
      years_to_80pct_base: years.base,
      seats_basis:
        row.capacity_confirmed != null
          ? 'confirmed'
          : seats != null
            ? 'estimated from capacity band'
            : 'unknown',
      // Flagged when the congregation would outgrow the building before a
      // lease runs out — the mistake this parish can least afford to repeat.
      outgrows_lease:
        years.base != null && typeof row.lease_term_months === 'number' && row.lease_term_months > 0
          ? years.base < row.lease_term_months / 12
          : false,
    };
  });
}

export async function listCandidates({ env, url }: RouteContext): Promise<Response> {
  const db = env.DB;
  const where: string[] = [];
  const binds: unknown[] = [];

  const status = url.searchParams.get('status');
  if (status) {
    const wanted = status.split(',').filter((s) => (STATUSES as readonly string[]).includes(s));
    if (wanted.length) {
      where.push(`status IN (${wanted.map(() => '?').join(',')})`);
      binds.push(...wanted);
    }
  }
  const capacity = url.searchParams.get('capacity');
  if (capacity) {
    const wanted = capacity.split(',').filter((s) => (CAPACITIES as readonly string[]).includes(s));
    if (wanted.length) {
      where.push(`capacity_est IN (${wanted.map(() => '?').join(',')})`);
      binds.push(...wanted);
    }
  }
  const maxDrive = Number(url.searchParams.get('maxDrive'));
  if (Number.isFinite(maxDrive) && maxDrive > 0) {
    // Fall back to the straight-line distance when no routed time exists, so
    // the filter does not silently hide every candidate that lacks one.
    where.push('(COALESCE(drive_min_from_center, distance_mi_from_center * 60.0 / 27.0) <= ?)');
    binds.push(maxDrive);
  }

  const sql = `SELECT * FROM candidates ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY name`;
  const { results } = await db.prepare(sql).bind(...binds).all<CandidateRow>();
  const decorated = await decorate(db, results);
  decorated.sort((a, b) => b.fit_score - a.fit_score);
  // The per-component reasons are only ever read in the drawer, which fetches
  // a single candidate. Sending them for every row costs about a megabyte on
  // a full county list, over a phone connection, for data nothing renders.
  const list = decorated.map(({ score_breakdown: _drop, ...rest }) => rest);
  return json({ count: list.length, candidates: list });
}

export async function getCandidate({ env, params }: RouteContext): Promise<Response> {
  const db = env.DB;
  const row = await db.prepare('SELECT * FROM candidates WHERE id = ?').bind(params.id).first<CandidateRow>();
  if (!row) return error('no such candidate', 404);
  const [candidate] = await decorate(db, [row]);
  const [notes, contacts] = await Promise.all([
    db.prepare('SELECT * FROM notes WHERE candidate_id = ? ORDER BY created_at DESC').bind(params.id).all(),
    db.prepare('SELECT * FROM contacts WHERE candidate_id = ?').bind(params.id).all(),
  ]);
  return json({ candidate, notes: notes.results, contacts: contacts.results });
}

export async function createCandidate({ env, request, identity }: RouteContext): Promise<Response> {
  const db = env.DB;
  let body: Record<string, unknown>;
  try {
    body = await readJson<Record<string, unknown>>(request);
  } catch (e) {
    return error((e as Error).message, 400);
  }

  const name = typeof body.name === 'string' ? body.name.trim() : '';
  const lat = Number(body.lat);
  const lon = Number(body.lon);
  if (!name) return error('name is required', 422);
  if (!Number.isFinite(lat) || lat < -90 || lat > 90) return error('lat must be a number between -90 and 90', 422);
  if (!Number.isFinite(lon) || lon < -180 || lon > 180) return error('lon must be a number between -180 and 180', 422);

  const id = `manual:${crypto.randomUUID()}`;
  const now = new Date().toISOString();
  const share = await driveShareWithin(db, lat, lon, 20);

  await db
    .prepare(
      `INSERT INTO candidates (id, name, lat, lon, source, status, capacity_est, share_hh_within_20min, updated_by, updated_at)
       VALUES (?, ?, ?, ?, 'manual', 'identified', 'unknown', ?, ?, ?)`,
    )
    .bind(id, name, lat, lon, share.share, identity.email, now)
    .run();

  // Apply any other supplied fields through the same validation path a PATCH uses.
  const sets: string[] = [];
  const binds: unknown[] = [];
  for (const [k, v] of Object.entries(body)) {
    if (k === 'name' || k === 'lat' || k === 'lon') continue;
    const val = coerce(k, v);
    if (val === undefined) continue;
    sets.push(`${k} = ?`);
    binds.push(val);
  }
  if (sets.length) {
    await db.prepare(`UPDATE candidates SET ${sets.join(', ')} WHERE id = ?`).bind(...binds, id).run();
  }

  await audit(db, identity.email, 'create', `candidate:${id}`, { name });
  const row = await db.prepare('SELECT * FROM candidates WHERE id = ?').bind(id).first<CandidateRow>();
  const [candidate] = await decorate(db, [row!]);
  return json({ candidate }, 201);
}

export async function patchCandidate({ env, request, params, identity }: RouteContext): Promise<Response> {
  const db = env.DB;
  const existing = await db.prepare('SELECT * FROM candidates WHERE id = ?').bind(params.id).first<CandidateRow>();
  if (!existing) return error('no such candidate', 404);

  let body: Record<string, unknown>;
  try {
    body = await readJson<Record<string, unknown>>(request);
  } catch (e) {
    return error((e as Error).message, 400);
  }

  const sets: string[] = [];
  const binds: unknown[] = [];
  const applied: Record<string, unknown> = {};
  const rejected: string[] = [];
  for (const [k, v] of Object.entries(body)) {
    const val = coerce(k, v);
    if (val === undefined) {
      rejected.push(k);
      continue;
    }
    sets.push(`${k} = ?`);
    binds.push(val);
    applied[k] = val;
  }
  if (!sets.length) return error('no writable fields in request', 422, { rejected });

  const now = new Date().toISOString();
  sets.push('updated_by = ?', 'updated_at = ?');
  binds.push(identity.email, now);

  await db.prepare(`UPDATE candidates SET ${sets.join(', ')} WHERE id = ?`).bind(...binds, params.id).run();

  // Keep the stored fit_score in step with the edit, so exports and any
  // consumer reading the column directly see the same number the UI shows.
  const updated = await db.prepare('SELECT * FROM candidates WHERE id = ?').bind(params.id).first<CandidateRow>();
  const [decorated] = await decorate(db, [updated!]);
  await db
    .prepare('UPDATE candidates SET fit_score = ?, years_to_80pct_base = ? WHERE id = ?')
    .bind(decorated.fit_score, decorated.years_to_80pct_base ?? null, params.id)
    .run();

  await audit(db, identity.email, 'update', `candidate:${params.id}`, applied);
  return json({ candidate: { ...decorated, fit_score: decorated.fit_score }, rejected });
}

/**
 * Routed drive times from one candidate to every placed household.
 *
 * This answers the question the committee actually asks of a building: if we
 * lease this one, how far does the congregation drive? A few dozen households
 * is a single OSRM table request, so the answer is exact rather than read off a
 * contour, and it is cached so a candidate is only ever routed once.
 *
 * It also fills share_hh_within_20min, which the pipeline leaves empty for
 * discovered churches. Until it is filled, the heaviest scoring weight
 * contributes nothing to any candidate's score.
 */
export async function candidateDrive({ env, params, url, identity }: RouteContext): Promise<Response> {
  const db = env.DB;
  const cand = await db
    .prepare('SELECT id, name, lat, lon FROM candidates WHERE id = ?')
    .bind(params.id)
    .first<{ id: string; name: string; lat: number; lon: number }>();
  if (!cand) return error('no such candidate', 404);

  const refresh = url.searchParams.get('refresh') === '1';
  if (!refresh) {
    const cached = await db
      .prepare('SELECT * FROM candidate_drive WHERE candidate_id = ?')
      .bind(params.id)
      .first<{
        computed_at: string; source: string; households: number;
        minutes_json: string; bands_json: string; median_min: number; mean_min: number;
      }>();
    if (cached) {
      return json({
        candidate_id: params.id,
        cached: true,
        computed_at: cached.computed_at,
        source: cached.source,
        households: cached.households,
        minutes: JSON.parse(cached.minutes_json),
        bands: JSON.parse(cached.bands_json),
        median_min: cached.median_min,
        mean_min: cached.mean_min,
        bands_min: DRIVE_BANDS,
      });
    }
  }

  // Out-of-state supporters cannot drive to a Sunday service, and flagged
  // outliers are excluded from the centre, so neither belongs in this measure.
  const { results: hh } = await db
    .prepare(
      'SELECT id, lat, lon FROM households_anon '
      + 'WHERE lat IS NOT NULL AND in_state = 1 AND outlier = 0 ORDER BY id',
    )
    .all<{ id: string; lat: number; lon: number }>();
  if (hh.length === 0) return error('no placed households to measure against', 409);

  const routed = await driveMinutesFrom(
    { lat: cand.lat, lon: cand.lon },
    hh.map((h) => ({ lat: h.lat, lon: h.lon })),
  );

  let minutes: (number | null)[];
  let source: 'osrm' | 'proxy';
  if (routed) {
    minutes = routed.minutes;
    source = 'osrm';
  } else {
    // Fall back rather than fail, but say which it is, every time. A proxy
    // figure presented as a drive time is worse than no figure.
    minutes = hh.map((h) => {
      const mi = haversineMi(cand.lat, cand.lon, h.lat, h.lon);
      return Math.round((mi / PROXY_MPH) * 60 * 10) / 10;
    });
    source = 'proxy';
  }

  const summary = summarise(minutes);
  const byId: Record<string, number | null> = {};
  hh.forEach((h, i) => { byId[h.id] = minutes[i] ?? null; });

  const now = new Date().toISOString();
  await db
    .prepare(
      'INSERT INTO candidate_drive (candidate_id, computed_at, source, households, minutes_json, '
      + 'bands_json, median_min, mean_min) VALUES (?, ?, ?, ?, ?, ?, ?, ?) '
      + 'ON CONFLICT(candidate_id) DO UPDATE SET computed_at = excluded.computed_at, '
      + 'source = excluded.source, households = excluded.households, '
      + 'minutes_json = excluded.minutes_json, bands_json = excluded.bands_json, '
      + 'median_min = excluded.median_min, mean_min = excluded.mean_min',
    )
    .bind(params.id, now, source, hh.length, JSON.stringify(byId),
          JSON.stringify(summary.bands), summary.median_min, summary.mean_min)
    .run();

  // Keep the 20-minute share in step so the scoring weight has real input.
  const within20 = minutes.filter((m): m is number => m != null && m <= 20).length / hh.length;
  const drive20 = Math.round(within20 * 10000) / 10000;
  await db
    .prepare('UPDATE candidates SET share_hh_within_20min = ?, drive_min_from_center = COALESCE(drive_min_from_center, ?) WHERE id = ?')
    .bind(drive20, summary.median_min, params.id)
    .run();

  await audit(db, identity.email, 'drive', `candidate:${params.id}`, { source, households: hh.length });

  return json({
    candidate_id: params.id,
    cached: false,
    computed_at: now,
    source,
    households: hh.length,
    minutes: byId,
    bands: summary.bands,
    median_min: summary.median_min,
    mean_min: summary.mean_min,
    unreachable: summary.unreachable,
    bands_min: DRIVE_BANDS,
    note: source === 'proxy'
      ? 'OSRM was unreachable, so these are straight-line estimates at 27 mph, not drive times.'
      : 'Routed drive times from OSRM, free-flow. A Sunday morning is usually a little quicker.',
  });
}

export async function addNote({ env, request, params, identity }: RouteContext): Promise<Response> {
  const db = env.DB;
  const exists = await db.prepare('SELECT id FROM candidates WHERE id = ?').bind(params.id).first();
  if (!exists) return error('no such candidate', 404);

  let body: { body?: unknown; kind?: unknown };
  try {
    body = await readJson(request);
  } catch (e) {
    return error((e as Error).message, 400);
  }
  const text = typeof body.body === 'string' ? body.body.trim() : '';
  if (!text) return error('note body is required', 422);
  if (text.length > 20000) return error('note is too long (20,000 character limit)', 422);
  const kind = typeof body.kind === 'string' && (NOTE_KINDS as readonly string[]).includes(body.kind)
    ? body.kind
    : 'note';

  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  // author_email comes from the verified token, never from the request body.
  await db
    .prepare('INSERT INTO notes (id, candidate_id, author_email, body, kind, created_at) VALUES (?, ?, ?, ?, ?, ?)')
    .bind(id, params.id, identity.email, text, kind, now)
    .run();
  await audit(db, identity.email, 'note', `candidate:${params.id}`, { kind });
  return json({ note: { id, candidate_id: params.id, author_email: identity.email, body: text, kind, created_at: now } }, 201);
}

export async function addContact({ env, request, params, identity }: RouteContext): Promise<Response> {
  const db = env.DB;
  const exists = await db.prepare('SELECT id FROM candidates WHERE id = ?').bind(params.id).first();
  if (!exists) return error('no such candidate', 404);

  let body: Record<string, unknown>;
  try {
    body = await readJson<Record<string, unknown>>(request);
  } catch (e) {
    return error((e as Error).message, 400);
  }
  const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, 300) : null);
  const name = str(body.name);
  const role = str(body.role);
  const email = str(body.email);
  const phone = str(body.phone);
  if (!name && !email && !phone) return error('a contact needs at least a name, email or phone', 422);

  const id = crypto.randomUUID();
  await db
    .prepare('INSERT INTO contacts (id, candidate_id, name, role, email, phone) VALUES (?, ?, ?, ?, ?, ?)')
    .bind(id, params.id, name, role, email, phone)
    .run();
  await audit(db, identity.email, 'contact', `candidate:${params.id}`, { role });
  return json({ contact: { id, candidate_id: params.id, name, role, email, phone } }, 201);
}

export { STATUSES, CAPACITIES, TENANCIES };
