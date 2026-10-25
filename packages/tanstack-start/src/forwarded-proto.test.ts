/**
 * Behind a TLS proxy the app sees `http://` while the browser is on
 * `https://`. A locale redirect built from `request.url` must keep the
 * browser on HTTPS, and nothing else about the request may change.
 */
import { describe, expect, it } from 'vitest';

import { withForwardedProto } from './forwarded-proto';

describe('withForwardedProto', () => {
  it('rebuilds a page request behind a TLS proxy as https, so a locale redirect stays on https', () => {
    const forwarded = new Request('http://shop.localhost/', { headers: { 'x-forwarded-proto': 'https' } });
    expect(withForwardedProto(forwarded).url).toBe('https://shop.localhost/');
  });

  it('keeps the headers a locale middleware reads', () => {
    const forwarded = new Request('http://shop.localhost/', {
      headers: { 'x-forwarded-proto': 'https', 'accept-language': 'ro', cookie: 'PARAGLIDE_LOCALE=ro' },
    });
    const rebuilt = withForwardedProto(forwarded);
    expect(rebuilt.headers.get('accept-language')).toBe('ro');
    expect(rebuilt.headers.get('cookie')).toBe('PARAGLIDE_LOCALE=ro');
  });

  it('rebuilds HEAD too, since a crawler probing a page gets the same redirect', () => {
    const head = new Request('http://shop.localhost/', { method: 'HEAD', headers: { 'x-forwarded-proto': 'https' } });
    const rebuilt = withForwardedProto(head);
    expect(rebuilt.url).toBe('https://shop.localhost/');
    expect(rebuilt.method).toBe('HEAD');
  });

  it('leaves a direct request alone (dev server without a proxy)', () => {
    const direct = new Request('http://localhost:5197/');
    expect(withForwardedProto(direct)).toBe(direct);
  });

  it('leaves a request with a body alone, because copying it would consume the stream', () => {
    const post = new Request('http://shop.localhost/api/rpc', {
      method: 'POST',
      body: '{}',
      headers: { 'x-forwarded-proto': 'https' },
    });
    expect(withForwardedProto(post)).toBe(post);
  });

  it('ignores a proxy that forwarded plain http', () => {
    const plain = new Request('http://shop.localhost/', { headers: { 'x-forwarded-proto': 'http' } });
    expect(withForwardedProto(plain)).toBe(plain);
  });

  it('returns an https request unchanged instead of copying it', () => {
    const secure = new Request('https://shop.localhost/', { headers: { 'x-forwarded-proto': 'https' } });
    expect(withForwardedProto(secure)).toBe(secure);
  });
});
