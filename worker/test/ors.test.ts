/**
 * The isochrone call, against a stubbed openrouteservice.
 *
 * The live round trip cannot be exercised here, so what is tested is
 * everything around it: the request we send, and each way the answer can
 * disappoint. The failures matter more than the success — a spent daily quota
 * and a refused key have to read as different problems, because the remedies
 * are "wait" and "fix the secret".
 */
import { describe, expect, it, vi, afterEach } from 'vitest';
import { ISOCHRONE_BANDS, orsIsochrones } from '../src/ors';

const POINT = { lat: 33.9533, lon: -117.3962 };

function stub(resp: Response | Promise<Response>) {
  const spy = vi.fn(() => Promise.resolve(resp));
  globalThis.fetch = spy as unknown as typeof fetch;
  return spy;
}

function geojson(seconds: number[]) {
  return new Response(
    JSON.stringify({
      features: seconds.map((value) => ({
        properties: { value },
        geometry: { type: 'Polygon', coordinates: [[[0, 0], [1, 0], [1, 1], [0, 0]]] },
      })),
    }),
    { headers: { 'Content-Type': 'application/geo+json' } },
  );
}

afterEach(() => { vi.restoreAllMocks(); });

describe('orsIsochrones', () => {
  it('asks for every band in one request, in seconds, lon first', async () => {
    const spy = stub(geojson([900, 1800, 2700, 3600]));
    await orsIsochrones(POINT, 'test-key');
    const [url, init] = spy.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toContain('/v2/isochrones/driving-car');
    expect(init.method).toBe('POST');
    const body = JSON.parse(String(init.body));
    expect(body.locations).toEqual([[-117.3962, 33.9533]]);
    expect(body.range).toEqual([900, 1800, 2700, 3600]);
    expect(body.range_type).toBe('time');
  });

  it('labels bands by the minutes asked for', async () => {
    stub(geojson([900, 1800, 2700, 3600]));
    const r = await orsIsochrones(POINT, 'test-key');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.bands.map((b) => b.minutes)).toEqual([...ISOCHRONE_BANDS]);
  });

  it('shrinks the request for slower traffic and relabels back to the asked minutes', async () => {
    // A 20-minute band at 1.25x traffic is 16 minutes of free-flow driving.
    const spy = stub(geojson([960]));
    const r = await orsIsochrones(POINT, 'test-key', [20], 1.25);
    expect(JSON.parse(String((spy.mock.calls[0] as unknown as [string, RequestInit])[1].body)).range)
      .toEqual([960]);
    expect(r.ok && r.bands[0].minutes).toBe(20);
  });

  it('reports a refused key as a configuration problem, naming the secret', async () => {
    stub(new Response('nope', { status: 403 }));
    const r = await orsIsochrones(POINT, 'bad-key');
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.message).toMatch(/CCAC_ORS_KEY/);
  });

  it('passes a rate limit back as 429, so the caller can say "wait"', async () => {
    stub(new Response('slow down', { status: 429 }));
    const r = await orsIsochrones(POINT, 'test-key');
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.status).toBe(429);
    expect(r.message).toMatch(/500 a day/);
  });

  it('does not treat an empty answer as success', async () => {
    stub(geojson([]));
    const r = await orsIsochrones(POINT, 'test-key');
    expect(r.ok).toBe(false);
  });

  it('does not treat non-JSON as success', async () => {
    stub(new Response('<html>maintenance</html>', { status: 200 }));
    const r = await orsIsochrones(POINT, 'test-key');
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.message).toMatch(/not JSON/);
  });

  it('survives a thrown fetch rather than rejecting', async () => {
    globalThis.fetch = (() => Promise.reject(new TypeError('network'))) as unknown as typeof fetch;
    const r = await orsIsochrones(POINT, 'test-key');
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.status).toBe(504);
  });
});
