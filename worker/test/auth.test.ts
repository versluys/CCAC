/**
 * Phase 4 acceptance (PRD §12): an unauthenticated request is refused, an
 * authenticated one yields the Workspace email, and a forged header without a
 * valid signature is rejected.
 */
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AuthError, verifyAccess } from '../src/auth';
import {
  AUD, TEAM, baseEnv, installJwksFetch, makeKeyPair, mintToken, req, unsignedToken, validPayload,
} from './helpers';

let pair: CryptoKeyPair;
let jwk: JsonWebKey;

beforeAll(async () => {
  ({ pair, jwk } = await makeKeyPair());
});
beforeEach(() => {
  installJwksFetch(jwk);
});

describe('verifyAccess', () => {
  it('accepts a properly signed token and lowercases the email', async () => {
    const token = await mintToken(pair.privateKey, validPayload());
    const id = await verifyAccess(req(token), baseEnv(jwk));
    expect(id.email).toBe('treasurer@christschapelrec.org');
    expect(id.sub).toBe('user-123');
  });

  it('rejects a request with no token at all', async () => {
    await expect(verifyAccess(req(), baseEnv(jwk))).rejects.toThrow(/no Access token/);
  });

  it('rejects a forged header whose signature does not verify', async () => {
    const good = await mintToken(pair.privateKey, validPayload());
    const [h, p] = good.split('.');
    // Same header and payload, attacker-chosen signature.
    const forged = `${h}.${p}.YWJjZGVmZ2hpamtsbW5vcHFyc3R1dnd4eXo`;
    await expect(verifyAccess(req(forged), baseEnv(jwk))).rejects.toThrow(/signature is not valid/);
  });

  it('rejects a token whose payload was tampered with after signing', async () => {
    const token = await mintToken(pair.privateKey, validPayload({ email: 'member@christschapelrec.org' }));
    const [h, , s] = token.split('.');
    const swapped = btoa(JSON.stringify(validPayload({ email: 'attacker@evil.example' })))
      .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    await expect(verifyAccess(req(`${h}.${swapped}.${s}`), baseEnv(jwk))).rejects.toThrow(/signature is not valid/);
  });

  it('rejects alg=none', async () => {
    const token = unsignedToken(validPayload());
    await expect(verifyAccess(req(token), baseEnv(jwk))).rejects.toThrow(/unsupported token algorithm/);
  });

  it('rejects a token minted for a different Access application', async () => {
    const token = await mintToken(pair.privateKey, validPayload({ aud: ['some-other-app'] }));
    await expect(verifyAccess(req(token), baseEnv(jwk))).rejects.toThrow(/different application/);
  });

  it('rejects a token from a different team', async () => {
    const token = await mintToken(pair.privateKey, validPayload({ iss: 'https://evil.cloudflareaccess.com' }));
    await expect(verifyAccess(req(token), baseEnv(jwk))).rejects.toThrow(/issuer mismatch/);
  });

  it('rejects an expired token', async () => {
    const now = Math.floor(Date.now() / 1000);
    const token = await mintToken(pair.privateKey, validPayload({ exp: now - 600, iat: now - 4200 }));
    await expect(verifyAccess(req(token), baseEnv(jwk))).rejects.toThrow(/expired/);
  });

  it('rejects a token with no email claim', async () => {
    const p = validPayload();
    delete (p as Record<string, unknown>).email;
    const token = await mintToken(pair.privateKey, p);
    await expect(verifyAccess(req(token), baseEnv(jwk))).rejects.toThrow(/no email claim/);
  });

  it('enforces the optional domain allow-list', async () => {
    const token = await mintToken(pair.privateKey, validPayload({ email: 'someone@gmail.com' }));
    const env = baseEnv(jwk, { ALLOWED_EMAIL_DOMAINS: 'christschapelrec.org' });
    await expect(verifyAccess(req(token), env)).rejects.toThrow(/outside the permitted domains/);
  });

  it('accepts a token via the CF_Authorization cookie', async () => {
    const token = await mintToken(pair.privateKey, validPayload());
    const request = new Request('https://sitefinder.example/api/me', {
      headers: { Cookie: `CF_Authorization=${token}; other=1` },
    });
    const id = await verifyAccess(request, baseEnv(jwk));
    expect(id.email).toBe('treasurer@christschapelrec.org');
  });

  it('fails closed when the audience tag is not configured', async () => {
    const token = await mintToken(pair.privateKey, validPayload());
    const env = baseEnv(jwk, { CF_ACCESS_AUD: '' });
    await expect(verifyAccess(req(token), env)).rejects.toMatchObject({ status: 500 });
  });

  it('ignores ACCESS_DEV_EMAIL outside development', async () => {
    const env = baseEnv(jwk, { ACCESS_DEV_EMAIL: 'anyone@example.org', ENVIRONMENT: 'production' });
    await expect(verifyAccess(req(), env)).rejects.toThrow(AuthError);
  });

  it('honours ACCESS_DEV_EMAIL only in development', async () => {
    const env = baseEnv(jwk, { ACCESS_DEV_EMAIL: 'dev@example.org', ENVIRONMENT: 'development' });
    const id = await verifyAccess(req(), env);
    expect(id.email).toBe('dev@example.org');
  });

  it('normalises a bare team name into the full issuer', async () => {
    const token = await mintToken(pair.privateKey, validPayload());
    const env = baseEnv(jwk, { CF_ACCESS_TEAM_DOMAIN: 'christschapel' });
    const id = await verifyAccess(req(token), env);
    expect(id.email).toBe('treasurer@christschapelrec.org');
    expect(TEAM).toContain('christschapel');
    expect(AUD).toBeTruthy();
  });
});
