/** Mint real RS256 Access-style tokens so the tests exercise real crypto. */

const enc = new TextEncoder();

function b64url(bytes: Uint8Array | string): string {
  const b = typeof bytes === 'string' ? enc.encode(bytes) : bytes;
  let bin = '';
  for (const byte of b) bin += String.fromCharCode(byte);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export async function makeKeyPair() {
  const pair = (await crypto.subtle.generateKey(
    { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
    true,
    ['sign', 'verify'],
  )) as CryptoKeyPair;
  const jwk = (await crypto.subtle.exportKey('jwk', pair.publicKey)) as JsonWebKey;
  return { pair, jwk };
}

export async function mintToken(
  privateKey: CryptoKey,
  payload: Record<string, unknown>,
  kid = 'test-kid',
  alg = 'RS256',
): Promise<string> {
  const header = b64url(JSON.stringify({ alg, kid, typ: 'JWT' }));
  const body = b64url(JSON.stringify(payload));
  const sig = new Uint8Array(
    await crypto.subtle.sign('RSASSA-PKCS1-v1_5', privateKey, enc.encode(`${header}.${body}`)),
  );
  return `${header}.${body}.${b64url(sig)}`;
}

export function unsignedToken(payload: Record<string, unknown>, alg = 'none'): string {
  return `${b64url(JSON.stringify({ alg, kid: 'test-kid', typ: 'JWT' }))}.${b64url(JSON.stringify(payload))}.`;
}

export const TEAM = 'christschapel.cloudflareaccess.com';
export const AUD = 'aud-tag-for-this-application';

export function baseEnv(jwk: JsonWebKey, overrides: Record<string, unknown> = {}) {
  return {
    CF_ACCESS_TEAM_DOMAIN: TEAM,
    CF_ACCESS_AUD: AUD,
    ENVIRONMENT: 'production',
    _jwk: jwk,
    ...overrides,
  } as unknown as Env;
}

export function installJwksFetch(jwk: JsonWebKey, kid = 'test-kid') {
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.includes('/cdn-cgi/access/certs')) {
      return new Response(JSON.stringify({ keys: [{ ...jwk, kid, alg: 'RS256', use: 'sig' }] }), {
        headers: { 'Content-Type': 'application/json' },
      });
    }
    return new Response('not found', { status: 404 });
  }) as typeof fetch;
}

export function validPayload(extra: Record<string, unknown> = {}) {
  const now = Math.floor(Date.now() / 1000);
  return {
    aud: [AUD],
    email: 'Treasurer@ChristsChapelREC.org',
    sub: 'user-123',
    iss: `https://${TEAM}`,
    iat: now,
    exp: now + 3600,
    ...extra,
  };
}

export function req(token?: string, url = 'https://sitefinder.example/api/me'): Request {
  return new Request(url, token ? { headers: { 'Cf-Access-Jwt-Assertion': token } } : undefined);
}
