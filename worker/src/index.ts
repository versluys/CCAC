/**
 * Christ's Chapel Site Finder — Worker entrypoint.
 *
 * One Worker serves the built React app and the /api surface. Every route,
 * including the static assets, sits behind Cloudflare Access; the Worker
 * verifies the Access JWT itself rather than trusting that the proxy in front
 * of it did (PRD §5).
 */

import { AuthError, verifyAccess } from './auth';
import { error, json, match, type Route } from './http';
import {
  addContact,
  addNote,
  candidateDrive,
  createCandidate,
  getCandidate,
  listCandidates,
  patchCandidate,
} from './routes/candidates';
import {
  centroids,
  dataQuality,
  driveShare,
  exportCsv,
  geocode,
  getSettings,
  households,
  isochrones,
  me,
  putGrowth,
  putWeights,
} from './routes/data';

const ROUTES: Route[] = [
  { method: 'GET', pattern: /^\/api\/me$/, handler: me },
  { method: 'GET', pattern: /^\/api\/households$/, handler: households },
  { method: 'GET', pattern: /^\/api\/centroids$/, handler: centroids },
  { method: 'GET', pattern: /^\/api\/isochrones$/, handler: isochrones },
  { method: 'GET', pattern: /^\/api\/drive-share$/, handler: driveShare },
  { method: 'GET', pattern: /^\/api\/data-quality$/, handler: dataQuality },
  { method: 'GET', pattern: /^\/api\/geocode$/, handler: geocode },
  { method: 'GET', pattern: /^\/api\/export\.csv$/, handler: exportCsv },
  { method: 'GET', pattern: /^\/api\/candidates$/, handler: listCandidates },
  { method: 'POST', pattern: /^\/api\/candidates$/, handler: createCandidate },
  { method: 'GET', pattern: /^\/api\/candidates\/(?<id>[^/]+)$/, handler: getCandidate },
  { method: 'GET', pattern: /^\/api\/candidates\/(?<id>[^/]+)\/drive$/, handler: candidateDrive },
  { method: 'PATCH', pattern: /^\/api\/candidates\/(?<id>[^/]+)$/, handler: patchCandidate },
  { method: 'POST', pattern: /^\/api\/candidates\/(?<id>[^/]+)\/notes$/, handler: addNote },
  { method: 'POST', pattern: /^\/api\/candidates\/(?<id>[^/]+)\/contacts$/, handler: addContact },
  { method: 'GET', pattern: /^\/api\/settings(?:\/(?:weights|growth|screen))?$/, handler: getSettings },
  { method: 'PUT', pattern: /^\/api\/settings\/weights$/, handler: putWeights },
  { method: 'PUT', pattern: /^\/api\/settings\/growth$/, handler: putGrowth },
];

const SECURITY_HEADERS: Record<string, string> = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'same-origin',
  'Content-Security-Policy': [
    "default-src 'self'",
    // MapLibre compiles its style expressions at runtime and needs a worker
    // blob for tile decoding.
    "script-src 'self' 'wasm-unsafe-eval' blob:",
    "worker-src 'self' blob:",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob: https://tiles.openfreemap.org",
    "connect-src 'self' https://tiles.openfreemap.org",
    "font-src 'self' data:",
    "frame-ancestors 'none'",
    "base-uri 'self'",
  ].join('; '),
};

function withSecurityHeaders(resp: Response): Response {
  const out = new Response(resp.body, resp);
  for (const [k, v] of Object.entries(SECURITY_HEADERS)) out.headers.set(k, v);
  return out;
}

export default {
  async fetch(request: Request, env: Env, _ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    // Liveness probe. Deliberately says nothing about the parish or its data.
    if (url.pathname === '/api/health') {
      return json({ ok: true });
    }

    let identity;
    try {
      identity = await verifyAccess(request, env);
    } catch (e) {
      const err = e as AuthError;
      const status = err instanceof AuthError ? err.status : 403;
      if (url.pathname.startsWith('/api/')) {
        return withSecurityHeaders(error(err.message || 'forbidden', status));
      }
      // For a browser hitting a page, a bare 403 is more honest than a
      // redirect loop: Access itself should have challenged first.
      return withSecurityHeaders(
        new Response(
          `Access denied.\n\n${err.message}\n\nThis application is restricted to Christ's Chapel parish leaders and is reached through Cloudflare Access.\n`,
          { status, headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' } },
        ),
      );
    }

    if (url.pathname.startsWith('/api/')) {
      const hit = match(ROUTES, request.method, url.pathname);
      if (!hit) {
        const allowed = ROUTES.filter((r) => r.pattern.test(url.pathname)).map((r) => r.method);
        if (allowed.length) {
          return withSecurityHeaders(error(`method not allowed`, 405, { allowed }));
        }
        return withSecurityHeaders(error('no such route', 404));
      }
      try {
        const resp = await hit.route.handler({
          request,
          env,
          params: hit.params,
          identity,
          url,
        });
        return withSecurityHeaders(resp);
      } catch (e) {
        // Log for the operator; return something the committee can quote back
        // without leaking a stack trace to the browser.
        console.error('route failure', url.pathname, e);
        return withSecurityHeaders(error('internal error', 500));
      }
    }

    // Static assets, with SPA fallback to index.html.
    if (!env.ASSETS) return withSecurityHeaders(error('static assets are not bound', 500));
    const assetResp = await env.ASSETS.fetch(request);
    if (assetResp.status === 404 && request.method === 'GET') {
      const indexUrl = new URL('/index.html', url.origin);
      const fallback = await env.ASSETS.fetch(new Request(indexUrl, request));
      return withSecurityHeaders(fallback);
    }
    return withSecurityHeaders(assetResp);
  },
} satisfies ExportedHandler<Env>;
