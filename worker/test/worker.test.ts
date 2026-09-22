/** Every route is behind Access — including the static app shell. */
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import worker from '../src/index';
import { baseEnv, installJwksFetch, makeKeyPair, mintToken, validPayload } from './helpers';

let pair: CryptoKeyPair;
let jwk: JsonWebKey;

beforeAll(async () => { ({ pair, jwk } = await makeKeyPair()); });
beforeEach(() => { installJwksFetch(jwk); });

const ctx = {} as ExecutionContext;

describe('route protection', () => {
  const protectedPaths = [
    '/api/me', '/api/households', '/api/centroids', '/api/candidates',
    '/api/export.csv', '/api/settings/weights', '/api/data-quality', '/',
  ];

  it.each(protectedPaths)('refuses %s without a token', async (path) => {
    const resp = await worker.fetch(new Request(`https://x.example${path}`), baseEnv(jwk), ctx);
    expect(resp.status).toBe(403);
  });

  it('refuses a forged Access header', async () => {
    const good = await mintToken(pair.privateKey, validPayload());
    const [h, p] = good.split('.');
    const resp = await worker.fetch(
      new Request('https://x.example/api/me', { headers: { 'Cf-Access-Jwt-Assertion': `${h}.${p}.bm9wZQ` } }),
      baseEnv(jwk), ctx,
    );
    expect(resp.status).toBe(403);
    expect(await resp.json()).toMatchObject({ error: expect.stringMatching(/signature/) });
  });

  it('returns the verified Workspace email on /api/me', async () => {
    const token = await mintToken(pair.privateKey, validPayload());
    const resp = await worker.fetch(
      new Request('https://x.example/api/me', { headers: { 'Cf-Access-Jwt-Assertion': token } }),
      baseEnv(jwk), ctx,
    );
    expect(resp.status).toBe(200);
    expect(await resp.json()).toMatchObject({ email: 'treasurer@christschapelrec.org' });
  });

  it('leaves /api/health open for liveness checks and says nothing about the parish', async () => {
    const resp = await worker.fetch(new Request('https://x.example/api/health'), baseEnv(jwk), ctx);
    expect(resp.status).toBe(200);
    expect(await resp.json()).toEqual({ ok: true });
  });

  it('sets hardening headers on refusals', async () => {
    const resp = await worker.fetch(new Request('https://x.example/'), baseEnv(jwk), ctx);
    expect(resp.headers.get('X-Frame-Options')).toBe('DENY');
    expect(resp.headers.get('Content-Security-Policy')).toMatch(/frame-ancestors 'none'/);
  });

  it('404s an unknown api route for an authenticated user', async () => {
    const token = await mintToken(pair.privateKey, validPayload());
    const resp = await worker.fetch(
      new Request('https://x.example/api/nope', { headers: { 'Cf-Access-Jwt-Assertion': token } }),
      baseEnv(jwk), ctx,
    );
    expect(resp.status).toBe(404);
  });

  it('405s a known route reached with the wrong method', async () => {
    const token = await mintToken(pair.privateKey, validPayload());
    const resp = await worker.fetch(
      new Request('https://x.example/api/me', { method: 'DELETE', headers: { 'Cf-Access-Jwt-Assertion': token } }),
      baseEnv(jwk), ctx,
    );
    expect(resp.status).toBe(405);
  });
});
