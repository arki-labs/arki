/**
 * The one JSON POST every fetch transport shares. Why these tests matter: a hung service must not
 * hold a request forever, a caller's cancel must not read as the service being down, and a
 * `Retry-After` must reach whoever decides when to try again.
 */
import { describe, expect, it } from 'vitest';

import { isFailure } from '@arki/failure';

import type { FetchFn } from './post-json.js';
import { MAIL_ERROR_CODES } from '../errors.js';
import { MailUncertain } from '../failures.js';
import { ses } from '../node/ses.js';
import { MAX_TIMEOUT_MS } from '../transport-failures.js';
import { cloudflare } from './cloudflare.js';
import { mailpit } from './mailpit.js';
import { resend } from './resend.js';
import { unosend } from './unosend.js';
import { postJson } from './post-json.js';

const request = (fetch: FetchFn, extra: { signal?: AbortSignal; timeoutMs?: number } = {}) => ({
  transport: 't',
  fetch,
  url: 'https://service.test/send',
  headers: {},
  body: { hello: 'world' },
  ...extra,
});

/** A fetch that never answers until its signal aborts, then rejects as a real fetch does. */
const hangs: FetchFn = (_url, init) =>
  new Promise((_resolve, reject) => {
    init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true });
  });

describe('postJson', () => {
  it('gives up on a service that never answers, as an uncertain send with reason timeout', async () => {
    const answer = await postJson(request(hangs, { timeoutMs: 20 }));
    expect(MailUncertain.is(answer)).toBe(true);
    expect(answer).toMatchObject({ data: { reason: 'timeout' } });
  });

  it('tells a caller cancel from an outage: reason cancelled', async () => {
    const controller = new AbortController();
    const pending = postJson(request(hangs, { signal: controller.signal, timeoutMs: 60_000 }));
    controller.abort();
    expect(await pending).toMatchObject({ code: 'mail.uncertain', data: { reason: 'cancelled' } });
  });

  it('a network fault is reason network', async () => {
    const answer = await postJson(request(() => Promise.reject(new TypeError('fetch failed'))));
    expect(answer).toMatchObject({ code: 'mail.uncertain', data: { reason: 'network' } });
  });

  it('reads Retry-After as seconds', async () => {
    const answer = await postJson(
      request(() => Promise.resolve(new Response('{}', { status: 429, headers: { 'Retry-After': '7' } }))),
    );
    expect(isFailure(answer)).toBe(false);
    expect(answer).toMatchObject({ status: 429, retryAfterMs: 7000 });
  });

  it('has no retryAfterMs when the header is absent or unreadable', async () => {
    const none = await postJson(request(() => Promise.resolve(new Response('{}', { status: 503 }))));
    const junk = await postJson(
      request(() => Promise.resolve(new Response('{}', { status: 503, headers: { 'Retry-After': 'soon' } }))),
    );
    expect(none).not.toHaveProperty('retryAfterMs');
    expect(junk).not.toHaveProperty('retryAfterMs');
  });
});

describe('a refusal that names a wait', () => {
  it('carries the Retry-After into MailRejected, retryable', async () => {
    const transport = resend({
      apiKey: 're_x',
      fetch: () =>
        Promise.resolve(
          new Response('{"message":"slow down","name":"rate_limit_exceeded"}', {
            status: 429,
            headers: { 'Retry-After': '30' },
          }),
        ),
    });
    const result = await transport.send(
      { from: 'a@app.dev', to: 'b@example.com', subject: 's', text: 't' },
      {},
    );
    expect(result).toMatchObject({
      code: 'mail.rejected',
      data: { retryable: true, upstreamStatus: 429, retryAfterMs: 30_000, providerCode: 'rate_limit_exceeded' },
    });
  });
});

// Why: a `timeoutMs` of -1, NaN or Infinity once made every send reject with a raw TypeError or RangeError.
// It is a configuration mistake, so it must fail when the transport is built, as the documented MailError.
describe('a bad timeoutMs fails when the transport is built (audit-2 #12)', () => {
  const builders = {
    resend: (timeoutMs: number) => resend({ apiKey: 're_x', timeoutMs }),
    mailpit: (timeoutMs: number) => mailpit({ baseUrl: 'http://localhost:8025', timeoutMs }),
    unosend: (timeoutMs: number) => unosend({ apiKey: 'un_x', timeoutMs }),
    cloudflare: (timeoutMs: number) => cloudflare({ accountId: 'acc', apiToken: 'tok', timeoutMs }),
    ses: (timeoutMs: number) => ses({ region: 'eu-west-1', timeoutMs }),
  };

  const bad = [-1, 0, Number.NaN, Number.POSITIVE_INFINITY, MAX_TIMEOUT_MS + 1];
  it.each(Object.entries(builders).flatMap(([name, build]) => bad.map(ms => [name, ms, build] as const)))(
    '%s with timeoutMs %s throws MailError ARKI_MAIL_E001',
    (name, timeoutMs, build) => {
      expect(() => build(timeoutMs)).toThrow(
        expect.objectContaining({
          name: 'MailError',
          code: MAIL_ERROR_CODES.invalidConfig,
          message: `${name}: \`timeoutMs\` must be more than 0 and at most ${MAX_TIMEOUT_MS} milliseconds, got ${timeoutMs}.`,
        }),
      );
    },
  );

  it('accepts the largest timer a runtime holds', () => {
    expect(resend({ apiKey: 're_x', timeoutMs: MAX_TIMEOUT_MS }).id).toBe('resend');
  });
});
