/**
 * OSRM routing from the Worker.
 *
 * Used for the one question that has to be answered on demand: how far does
 * the congregation drive to reach a given candidate church. With a few dozen
 * households that is a single table request, so it is fast enough to do while
 * someone waits, and exact rather than contoured.
 *
 * The public demo server is a donated service. Requests are cached in D1 on the
 * way back, so a candidate is routed once and then read from the database.
 */

const OSRM_BASE = 'https://router.project-osrm.org';

// The public demo caps coordinates per table request.
const MAX_COORDS = 95;

export interface DriveResult {
  minutes: (number | null)[];
  source: 'osrm';
}

/** Drive minutes from one origin to each destination, in order. */
export async function driveMinutesFrom(
  origin: { lat: number; lon: number },
  dests: { lat: number; lon: number }[],
  timeoutMs = 20000,
): Promise<DriveResult | null> {
  if (dests.length === 0) return { minutes: [], source: 'osrm' };

  const out: (number | null)[] = [];
  for (let start = 0; start < dests.length; start += MAX_COORDS - 1) {
    const batch = dests.slice(start, start + MAX_COORDS - 1);
    const coords = [origin, ...batch]
      .map((p) => `${p.lon.toFixed(5)},${p.lat.toFixed(5)}`)
      .join(';');
    const destIdx = batch.map((_, i) => i + 1).join(';');
    const url = `${OSRM_BASE}/table/v1/driving/${coords}?sources=0&destinations=${destIdx}&annotations=duration`;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const resp = await fetch(url, {
        signal: controller.signal,
        headers: { 'User-Agent': 'ChristsChapelSiteFinder/1.0 (parish site search)' },
      });
      if (!resp.ok) return null;
      const payload = (await resp.json()) as { code?: string; durations?: (number | null)[][] };
      if (payload.code !== 'Ok' || !payload.durations?.[0]) return null;
      for (const v of payload.durations[0]) {
        out.push(v == null ? null : Math.round((v / 60) * 10) / 10);
      }
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  }
  return { minutes: out, source: 'osrm' };
}

export const DRIVE_BANDS = [15, 30, 45, 60] as const;

export function summarise(minutes: (number | null)[]) {
  const routed = minutes.filter((m): m is number => m != null);
  const total = minutes.length || 1;
  const bands: Record<string, { share: number; count: number }> = {};
  for (const b of DRIVE_BANDS) {
    const count = routed.filter((m) => m <= b).length;
    bands[String(b)] = { share: count / total, count };
  }
  const sorted = [...routed].sort((a, b) => a - b);
  const median = sorted.length
    ? sorted.length % 2
      ? sorted[(sorted.length - 1) / 2]
      : (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2
    : null;
  const mean = routed.length ? routed.reduce((a, b) => a + b, 0) / routed.length : null;
  return {
    bands,
    median_min: median == null ? null : Math.round(median * 10) / 10,
    mean_min: mean == null ? null : Math.round(mean * 10) / 10,
    unreachable: minutes.length - routed.length,
  };
}
