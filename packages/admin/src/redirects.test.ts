/**
 * T(admin-redirects): Foreman's outbound calls never follow a redirect. A target that
 * answers 3xx pointing at an internal URL must be refused, and the internal URL must
 * never be requested.
 */
import { describe, expect, it } from 'vitest';

import { createForemanClient, generateForemanKeyPair } from './client';
import { refusal } from './test-support';
import { ADMIN_ERROR_CODES } from './module';
import { fetchFleetSnapshot } from './server';

const INTERNAL = 'http://169.254.169.254/latest/meta-data';

/** A fake network: the target answers like a real fetch with `redirect: 'manual'` would see it. */
function redirectingNetwork(status: number) {
  const requested: string[] = [];
  const fetchImpl = (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const request = new Request(input, init);
    requested.push(request.url);
    if (request.url.startsWith('http://169.254.169.254')) return Promise.resolve(Response.json({ leaked: true }));
    // A fetch that follows redirects (the default) would request the internal URL next.
    const answer = new Response(null, { status, headers: { location: INTERNAL } });
    if (init?.redirect !== 'manual') return fetchImpl(INTERNAL).then(() => answer);
    return Promise.resolve(answer);
  };
  return { fetchImpl, requested };
}

describe('T(admin-redirects)', () => {
  it('the signed client refuses a redirect and never requests its target', async () => {
    const [readPair, appPair] = await Promise.all([generateForemanKeyPair(), generateForemanKeyPair()]);
    const { fetchImpl, requested } = redirectingNetwork(302);
    const client = createForemanClient({
      target: { aud: 'novelette:prod', baseUrl: 'https://novelette.app', appKey: appPair.publicKey },
      readKey: readPair.privateKey,
      fetch: fetchImpl,
    });
    const error = await refusal(client.manifest());
    expect(error.code).toBe(ADMIN_ERROR_CODES.unreachable);
    expect(error.message).toMatch(/redirect/);
    expect(requested.some(url => url.startsWith(INTERNAL))).toBe(false);
  });

  it('fetchFleetSnapshot refuses a redirect and never requests its target', async () => {
    const { fetchImpl, requested } = redirectingNetwork(302);
    const result = await fetchFleetSnapshot(
      { id: 'novelette', brand: 'Novelette', domain: 'novelette.app', baseUrl: 'https://novelette.app', token: 't' },
      { fetch: fetchImpl },
    );
    expect(result).toMatchObject({ id: 'novelette', ok: false });
    expect(requested.some(url => url.startsWith(INTERNAL))).toBe(false);
  });
});
