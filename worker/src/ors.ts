/**
 * openrouteservice isochrones from the Worker.
 *
 * The pipeline script computes these offline for every candidate it knows
 * about. A church somebody adds in the browser is not one of those: it exists
 * only in D1, and scripts/isochrones.py reads JSON files on a laptop, so it
 * can never see it. Without this, a hand-added candidate silently showed the
 * centre's bands instead of its own.
 *
 * One request returns every band already contoured to the road network, which
 * is why this is the only isochrone method worth doing while someone waits.
 * The sampled-grid fallback in the script needs hundreds of routing calls per
 * point; a Worker has a subrequest budget and a person has patience, and
 * neither stretches that far. With no key, this fails and says so plainly
 * rather than drawing a circle and calling it a drive time.
 */

const ORS_URL = 'https://api.openrouteservice.org/v2/isochrones/driving-car';

/** The bands the pipeline uses, so a computed set matches a seeded one. */
export const ISOCHRONE_BANDS = [15, 30, 45, 60] as const;

export interface IsochroneBand {
  minutes: number;
  geometry: unknown;
}

export type IsochroneResult =
  | { ok: true; bands: IsochroneBand[] }
  | { ok: false; status: number; message: string };

/**
 * Bands around one point.
 *
 * `trafficFactor` matches scripts/common.py: a band of N minutes under factor
 * f is the area reachable in N/f minutes of the router's own free-flow time,
 * so f > 1 (slower traffic) shrinks the area. The default of 1.0 is free-flow,
 * which is what the pipeline uses and what a Sunday morning most resembles.
 */
export async function orsIsochrones(
  point: { lat: number; lon: number },
  key: string,
  bands: readonly number[] = ISOCHRONE_BANDS,
  trafficFactor = 1,
  timeoutMs = 30000,
): Promise<IsochroneResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let resp: Response;
  try {
    resp = await fetch(ORS_URL, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        Authorization: key,
        'Content-Type': 'application/json',
        Accept: 'application/geo+json',
        'User-Agent': 'ChristsChapelSiteFinder/1.0 (parish site search)',
      },
      body: JSON.stringify({
        // ORS takes [lon, lat] and seconds.
        locations: [[Number(point.lon.toFixed(6)), Number(point.lat.toFixed(6))]],
        range: bands.map((b) => Math.round((b * 60) / trafficFactor)),
        range_type: 'time',
        location_type: 'start',
        // 0 hugs individual roads and looks spidery, 100 is a blob. The middle
        // reads as a neighbourhood.
        smoothing: 25,
      }),
    });
  } catch (e) {
    const aborted = (e as Error).name === 'AbortError';
    return {
      ok: false,
      status: 504,
      message: aborted
        ? 'openrouteservice did not answer within 30 seconds.'
        : `openrouteservice could not be reached: ${(e as Error).name}.`,
    };
  } finally {
    clearTimeout(timer);
  }

  if (resp.status === 401 || resp.status === 403) {
    return {
      ok: false,
      status: 502,
      message:
        'openrouteservice refused the key. Check CCAC_ORS_KEY in the Worker secrets — '
        + 'it is the Basic Key from the API Key tab, and it begins "ey".',
    };
  }
  if (resp.status === 429) {
    return {
      ok: false,
      status: 429,
      message:
        'openrouteservice rate limit reached. The free tier allows 20 isochrone requests '
        + 'a minute and 500 a day; wait a minute and try again.',
    };
  }
  if (!resp.ok) {
    return { ok: false, status: 502, message: `openrouteservice returned HTTP ${resp.status}.` };
  }

  let payload: { features?: { properties?: { value?: number }; geometry?: unknown }[] };
  try {
    payload = (await resp.json()) as typeof payload;
  } catch {
    return { ok: false, status: 502, message: 'openrouteservice returned something that is not JSON.' };
  }

  const out: IsochroneBand[] = [];
  for (const f of payload.features ?? []) {
    const secs = f.properties?.value;
    if (secs == null || !f.geometry) continue;
    // Label the band by the minutes asked for, not the free-flow seconds sent.
    out.push({ minutes: Math.round((secs * trafficFactor) / 60), geometry: f.geometry });
  }
  if (out.length === 0) {
    return {
      ok: false,
      status: 502,
      message: 'openrouteservice returned no bands for this point. It may be off the road network.',
    };
  }
  return { ok: true, bands: out };
}
