/** Small helpers over D1: settings, audit, and drive-share computation. */

import {
  DEFAULT_GROWTH,
  DEFAULT_SCREEN,
  DEFAULT_WEIGHTS,
  type Growth,
  type ScreenSettings,
  type Weights,
} from './scoring';

export async function getSetting<T>(db: D1Database, key: string, fallback: T): Promise<T> {
  const row = await db.prepare('SELECT value FROM settings WHERE key = ?').bind(key).first<{ value: string }>();
  if (!row?.value) return fallback;
  try {
    return { ...fallback, ...(JSON.parse(row.value) as object) } as T;
  } catch {
    return fallback;
  }
}

export async function putSetting(db: D1Database, key: string, value: unknown): Promise<void> {
  await db
    .prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .bind(key, JSON.stringify(value))
    .run();
}

export const getWeights = (db: D1Database) => getSetting<Weights>(db, 'weights', DEFAULT_WEIGHTS);
export const getGrowth = (db: D1Database) => getSetting<Growth>(db, 'growth', DEFAULT_GROWTH);
export const getScreen = (db: D1Database) => getSetting<ScreenSettings>(db, 'screen', DEFAULT_SCREEN);

export async function audit(
  db: D1Database,
  actor: string,
  action: string,
  entity: string,
  detail?: unknown,
): Promise<void> {
  await db
    .prepare('INSERT INTO audit_log (id, actor, action, entity, at, detail) VALUES (?, ?, ?, ?, ?, ?)')
    .bind(
      crypto.randomUUID(),
      actor,
      action,
      entity,
      new Date().toISOString(),
      detail === undefined ? null : JSON.stringify(detail),
    )
    .run();
}

const EARTH_RADIUS_MI = 3958.7613;

export function haversineMi(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const toRad = (d: number) => (d * Math.PI) / 180;
  const p1 = toRad(lat1);
  const p2 = toRad(lat2);
  const dp = p2 - p1;
  const dl = toRad(lon2 - lon1);
  const a = Math.sin(dp / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) ** 2;
  return 2 * EARTH_RADIUS_MI * Math.asin(Math.sqrt(a));
}

/**
 * Share of in-state households within 20 driving minutes of a point.
 *
 * Drive times are not available inside the Worker, so this is a straight-line
 * proxy at a flat arterial speed. It is only ever used to fill a gap left by
 * the offline pipeline, and the API labels it so the dashboard can say plainly
 * that the number is an estimate rather than a routed drive time.
 */
export const PROXY_MPH = 27;

export async function driveShareWithin(
  db: D1Database,
  lat: number,
  lon: number,
  minutes = 20,
): Promise<{ share: number; count: number; total: number; source: 'proxy' }> {
  const { results } = await db
    .prepare('SELECT lat, lon FROM households_anon WHERE lat IS NOT NULL AND in_state = 1 AND outlier = 0')
    .all<{ lat: number; lon: number }>();
  const total = results.length;
  if (total === 0) return { share: 0, count: 0, total: 0, source: 'proxy' };
  const limitMi = (PROXY_MPH * minutes) / 60;
  const count = results.filter((h) => haversineMi(lat, lon, h.lat, h.lon) <= limitMi).length;
  return { share: count / total, count, total, source: 'proxy' };
}
