/** Response helpers and a tiny path router. */

export function json(body: unknown, status = 200, extra: HeadersInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      // This app is private research behind Access; nothing here should be
      // cached by an intermediary or embedded elsewhere.
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'same-origin',
      ...extra,
    },
  });
}

export function error(message: string, status = 400, detail?: unknown): Response {
  return json({ error: message, detail: detail ?? null }, status);
}

export async function readJson<T>(request: Request): Promise<T> {
  const ct = request.headers.get('Content-Type') ?? '';
  if (!ct.includes('application/json')) throw new Error('expected application/json');
  try {
    return (await request.json()) as T;
  } catch {
    throw new Error('request body was not valid JSON');
  }
}

export interface Route {
  method: string;
  pattern: RegExp;
  handler: (ctx: RouteContext) => Promise<Response>;
}

export interface RouteContext {
  request: Request;
  env: Env;
  params: Record<string, string>;
  identity: { email: string; sub: string };
  url: URL;
}

/**
 * Resolve a request to a route, decoding path parameters.
 *
 * Candidate ids contain colons and slashes ("osm:way/480534530"), so a browser
 * sends them percent-encoded. `URL.pathname` keeps that encoding, so a captured
 * parameter arrives as "osm%3Away%2F480534530". Binding that straight into a
 * query looks for an id no row has, and every candidate detail request answers
 * 404 while the list beside it works perfectly.
 */
export function match(routes: Route[], method: string, pathname: string) {
  for (const route of routes) {
    if (route.method !== method) continue;
    const m = route.pattern.exec(pathname);
    if (!m) continue;
    const params: Record<string, string> = {};
    for (const [key, raw] of Object.entries(m.groups ?? {})) {
      if (raw === undefined) continue;
      try {
        params[key] = decodeURIComponent(raw);
      } catch {
        // A malformed escape is the client's problem, not a reason to 500.
        // Pass it through and let the lookup miss honestly.
        params[key] = raw;
      }
    }
    return { route, params };
  }
  return null;
}
