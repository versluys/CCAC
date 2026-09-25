/**
 * Path-parameter decoding.
 *
 * These exist because of a bug that shipped: candidate ids contain colons and
 * slashes, browsers percent-encode them, and the router passed the encoded text
 * into SQL. Every candidate detail request 404'd. The earlier tests missed it
 * because they were written with hand-built URLs carrying raw colons, which a
 * browser never sends. So each case here goes through encodeURIComponent, the
 * way the real client does.
 */
import { describe, expect, it } from 'vitest';
import { match, type Route } from '../src/http';

const noop = async () => new Response('ok');
const routes: Route[] = [
  { method: 'GET', pattern: /^\/api\/candidates$/, handler: noop },
  { method: 'GET', pattern: /^\/api\/candidates\/(?<id>[^/]+)$/, handler: noop },
  { method: 'GET', pattern: /^\/api\/candidates\/(?<id>[^/]+)\/drive$/, handler: noop },
  { method: 'POST', pattern: /^\/api\/candidates\/(?<id>[^/]+)\/notes$/, handler: noop },
];

/** What the browser actually puts on the wire for a given id. */
const pathFor = (id: string, suffix = '') =>
  `/api/candidates/${encodeURIComponent(id)}${suffix}`;

describe('path parameter decoding', () => {
  const realIds = [
    'osm:way/480534530',
    'osm:node/358842114',
    'osm:relation/1134120340',
    'manual:8b4180f0-95ce-47e6-bb18-e74c259ab6fa',
    'gplace:ChIJN1t_tDeuEmsRUsoyG83frY4',
  ];

  it.each(realIds)('recovers %s from its encoded path', (id) => {
    const hit = match(routes, 'GET', pathFor(id));
    expect(hit).not.toBeNull();
    expect(hit!.params.id).toBe(id);
  });

  it.each(realIds)('recovers %s on a sub-route', (id) => {
    const hit = match(routes, 'GET', pathFor(id, '/drive'));
    expect(hit).not.toBeNull();
    expect(hit!.params.id).toBe(id);
  });

  it('routes an encoded id to notes on POST', () => {
    const id = 'osm:way/480534530';
    const hit = match(routes, 'POST', pathFor(id, '/notes'));
    expect(hit).not.toBeNull();
    expect(hit!.params.id).toBe(id);
  });

  it('still matches a raw, unencoded colon', () => {
    const hit = match(routes, 'GET', '/api/candidates/manual:abc');
    expect(hit!.params.id).toBe('manual:abc');
  });

  it('does not confuse the collection route with a detail route', () => {
    expect(match(routes, 'GET', '/api/candidates')!.route.pattern.source).toContain('candidates$');
    expect(match(routes, 'GET', '/api/candidates/')).toBeNull();
  });

  it('passes a malformed escape through rather than throwing', () => {
    const hit = match(routes, 'GET', '/api/candidates/%E0%A4%A');
    expect(hit).not.toBeNull();
    expect(hit!.params.id).toBe('%E0%A4%A');
  });

  it('keeps an encoded slash from splitting the path', () => {
    // A raw slash would match the /drive sub-route instead of the id.
    const hit = match(routes, 'GET', pathFor('osm:way/123'));
    expect(hit!.route.pattern.source).not.toContain('drive');
    expect(hit!.params.id).toBe('osm:way/123');
  });

  it('returns null for an unknown path', () => {
    expect(match(routes, 'GET', '/api/nope')).toBeNull();
  });

  it('respects the method', () => {
    expect(match(routes, 'DELETE', pathFor('osm:way/1'))).toBeNull();
  });
});
