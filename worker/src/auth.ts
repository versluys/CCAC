/**
 * Cloudflare Access (Zero Trust) JWT verification.
 *
 * The PRD is explicit about this and it is worth restating: the presence of
 * the `Cf-Access-Jwt-Assertion` header proves nothing. Anyone can set a
 * header. What proves identity is a signature over that token made by the
 * team's signing key, plus an audience claim matching this application.
 * Everything below exists to check exactly that, and to fail closed when any
 * part of it cannot be checked.
 *
 * The verified email is the only identity this app ever trusts. It is what
 * gets written to notes.author_email and audit_log.actor; a client-supplied
 * author field is ignored everywhere.
 */

export interface AccessIdentity {
  email: string;
  sub: string;
  expiresAt: number;
}

export class AuthError extends Error {
  constructor(message: string, readonly status = 403) {
    super(message);
    this.name = 'AuthError';
  }
}

interface Jwk {
  kid: string;
  kty: string;
  alg?: string;
  n: string;
  e: string;
  use?: string;
}

// JWKS are cached in module scope for the isolate's lifetime. Cloudflare
// rotates Access signing keys periodically, so a miss on `kid` forces a
// refetch rather than a rejection.
let jwksCache: { keys: Jwk[]; fetchedAt: number; teamDomain: string } | null = null;
const JWKS_TTL_MS = 60 * 60 * 1000;

function base64UrlToBytes(input: string): Uint8Array {
  const pad = input.length % 4 === 0 ? '' : '='.repeat(4 - (input.length % 4));
  const b64 = (input + pad).replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function decodeJson<T>(segment: string): T {
  const bytes = base64UrlToBytes(segment);
  return JSON.parse(new TextDecoder().decode(bytes)) as T;
}

function teamDomainOf(env: Env): string {
  const raw = (env.CF_ACCESS_TEAM_DOMAIN ?? '').trim();
  if (!raw) throw new AuthError('CF_ACCESS_TEAM_DOMAIN is not configured', 500);
  // Accept "acme", "acme.cloudflareaccess.com" or a full URL.
  const host = raw
    .replace(/^https?:\/\//, '')
    .replace(/\/.*$/, '')
    .toLowerCase();
  return host.includes('.') ? host : `${host}.cloudflareaccess.com`;
}

async function getJwks(env: Env, force = false): Promise<Jwk[]> {
  const teamDomain = teamDomainOf(env);
  const fresh =
    jwksCache &&
    jwksCache.teamDomain === teamDomain &&
    Date.now() - jwksCache.fetchedAt < JWKS_TTL_MS;
  if (fresh && !force) return jwksCache!.keys;

  const url = `https://${teamDomain}/cdn-cgi/access/certs`;
  const resp = await fetch(url, { cf: { cacheTtl: 3600, cacheEverything: true } });
  if (!resp.ok) {
    if (jwksCache && jwksCache.teamDomain === teamDomain) return jwksCache.keys;
    throw new AuthError(`could not fetch Access signing keys (${resp.status})`, 503);
  }
  const body = (await resp.json()) as { keys?: Jwk[] };
  const keys = body.keys ?? [];
  if (keys.length === 0) throw new AuthError('Access signing key set was empty', 503);
  jwksCache = { keys, fetchedAt: Date.now(), teamDomain };
  return keys;
}

async function importKey(jwk: Jwk): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    'jwk',
    { kty: jwk.kty, n: jwk.n, e: jwk.e, alg: 'RS256', ext: true },
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['verify'],
  );
}

function readToken(request: Request): string | null {
  const header = request.headers.get('Cf-Access-Jwt-Assertion');
  if (header) return header.trim();
  // Access also sets a cookie; browsers hitting the app directly rely on it.
  const cookie = request.headers.get('Cookie') ?? '';
  const match = /(?:^|;\s*)CF_Authorization=([^;]+)/.exec(cookie);
  return match ? decodeURIComponent(match[1]) : null;
}

/**
 * Verify the Access token on a request. Throws AuthError on anything that is
 * not a fully verified identity. There is no development bypass that can be
 * switched on in production: ACCESS_DEV_EMAIL is honoured only when
 * ENVIRONMENT is exactly "development", which wrangler.toml sets solely for
 * `wrangler dev`.
 */
export async function verifyAccess(request: Request, env: Env): Promise<AccessIdentity> {
  if (env.ENVIRONMENT === 'development' && env.ACCESS_DEV_EMAIL) {
    return {
      email: env.ACCESS_DEV_EMAIL,
      sub: 'dev',
      expiresAt: Math.floor(Date.now() / 1000) + 3600,
    };
  }

  const token = readToken(request);
  if (!token) throw new AuthError('no Access token on this request');

  const parts = token.split('.');
  if (parts.length !== 3) throw new AuthError('malformed Access token');
  const [headerB64, payloadB64, signatureB64] = parts;

  let header: { alg?: string; kid?: string };
  let payload: {
    aud?: string | string[];
    email?: string;
    sub?: string;
    iss?: string;
    exp?: number;
    nbf?: number;
    iat?: number;
  };
  try {
    header = decodeJson(headerB64);
    payload = decodeJson(payloadB64);
  } catch {
    throw new AuthError('Access token is not valid JSON');
  }

  // Reject "alg": "none" and any algorithm we are not prepared to check.
  if (header.alg !== 'RS256') throw new AuthError(`unsupported token algorithm ${header.alg}`);
  if (!header.kid) throw new AuthError('Access token has no key id');

  const aud = (env.CF_ACCESS_AUD ?? '').trim();
  if (!aud) throw new AuthError('CF_ACCESS_AUD is not configured', 500);
  const audiences = Array.isArray(payload.aud) ? payload.aud : payload.aud ? [payload.aud] : [];
  if (!audiences.includes(aud)) {
    // A token minted for a *different* Access application is a valid token,
    // signed by the same team key. Skipping this check would let anyone in
    // the organisation reach this app through any other app they can open.
    throw new AuthError('Access token was issued for a different application');
  }

  const expectedIss = `https://${teamDomainOf(env)}`;
  if (payload.iss !== expectedIss) throw new AuthError('Access token issuer mismatch');

  const now = Math.floor(Date.now() / 1000);
  const skew = 60;
  if (typeof payload.exp !== 'number' || payload.exp + skew < now) {
    throw new AuthError('Access token has expired');
  }
  if (typeof payload.nbf === 'number' && payload.nbf - skew > now) {
    throw new AuthError('Access token is not yet valid');
  }

  const signed = new TextEncoder().encode(`${headerB64}.${payloadB64}`);
  const signature = base64UrlToBytes(signatureB64);

  let verified = false;
  for (const force of [false, true]) {
    const keys = await getJwks(env, force);
    const jwk = keys.find((k) => k.kid === header.kid);
    if (!jwk) continue;
    const key = await importKey(jwk);
    verified = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, signature, signed);
    break;
  }
  if (!verified) throw new AuthError('Access token signature is not valid');

  const email = (payload.email ?? '').trim().toLowerCase();
  if (!email) throw new AuthError('Access token carries no email claim');

  // Optional second gate. Access policy should already restrict the
  // application, but a domain allow-list here means a misconfigured policy
  // cannot silently open the parish's research to the whole internet.
  const allowed = (env.ALLOWED_EMAIL_DOMAINS ?? '')
    .split(',')
    .map((d) => d.trim().toLowerCase())
    .filter(Boolean);
  if (allowed.length > 0) {
    const domain = email.split('@')[1] ?? '';
    if (!allowed.includes(domain)) {
      throw new AuthError(`${email} is outside the permitted domains`);
    }
  }

  return { email, sub: payload.sub ?? email, expiresAt: payload.exp };
}
