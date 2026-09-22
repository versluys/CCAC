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

export function match(routes: Route[], method: string, pathname: string) {
  for (const route of routes) {
    if (route.method !== method) continue;
    const m = route.pattern.exec(pathname);
    if (m) return { route, params: (m.groups ?? {}) as Record<string, string> };
  }
  return null;
}
