/** Requests against an auth's handler, as a browser on the app's own origin sends them. */
export const ORIGIN = 'http://localhost:3000';

type Handler = { readonly handler: (request: Request) => Promise<Response> };

export function post(auth: Handler, path: string, body: unknown, headers?: HeadersInit): Promise<Response> {
  const merged = new Headers(headers);
  merged.set('content-type', 'application/json');
  if (!merged.has('origin')) merged.set('origin', ORIGIN);
  return auth.handler(
    new Request(`${ORIGIN}/api/auth${path}`, { method: 'POST', headers: merged, body: JSON.stringify(body) }),
  );
}

export function get(auth: Handler, pathOrUrl: string | URL, headers?: HeadersInit): Promise<Response> {
  const url = pathOrUrl instanceof URL ? pathOrUrl : new URL(`${ORIGIN}/api/auth${pathOrUrl}`);
  return auth.handler(new Request(url, { headers, redirect: 'manual' }));
}

/** The cookies a response set, as a `cookie` request header. */
export function cookiesOf(response: Response): string {
  return response.headers
    .getSetCookie()
    .map(line => line.split(';')[0] ?? '')
    .filter(pair => !pair.endsWith('='))
    .join('; ');
}

export const PASSWORD = 'correct horse battery staple';
