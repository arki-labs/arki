/**
 * A request as the browser sent it, not as the TLS proxy forwarded it.
 *
 * A proxy that ends TLS (nginx, Traefik, a CDN) talks plain HTTP to the app
 * and adds `X-Forwarded-Proto: https`. Anything that builds an absolute URL
 * from `request.url` (Paraglide's locale redirect `/` → `/ro`, for one) then
 * sends an HTTPS browser to `http://…`. This rebuilds the request with an
 * `https:` URL so those redirects stay on HTTPS.
 *
 * Only GET and HEAD are rebuilt: a redirect worth fixing comes from a page
 * navigation, and a request with a body cannot be copied without reading its
 * stream. Every other request comes back unchanged (the same object).
 *
 * The header is trusted as sent. Behind a proxy that overwrites it, that is
 * correct; without one, a client can only change the scheme of URLs built for
 * its own response.
 *
 * @example
 * handler: (incoming, options) => {
 *   const request = withForwardedProto(incoming);
 *   return paraglideMiddleware(request, () => startHandler(request, options));
 * },
 */
export function withForwardedProto(request: Request): Request {
  if (request.method !== 'GET' && request.method !== 'HEAD') return request;
  if (request.headers.get('x-forwarded-proto') !== 'https') return request;
  const url = new URL(request.url);
  if (url.protocol === 'https:') return request;
  url.protocol = 'https:';
  return new Request(url, request);
}
