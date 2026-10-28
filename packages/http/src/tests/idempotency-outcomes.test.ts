import { describe, expect, it, vi } from 'vitest';

import { isFailure, orThrow } from '@arki/failure';
import { parse } from '@arki/schema';

import type { ResponseCache, StoredResponse } from '../idempotency.js';
import { route } from '../contract.js';
import { composeMiddleware } from '../engine.js';
import { HttpError, toErrorResponse } from '../error.js';
import {
  IDEMPOTENCY_FAILURES,
  IdempotencyClaimUnconfirmed,
  IdempotencyReplayInvalid,
  IdempotencyResponseUnavailable,
  IdempotencyWriteUnconfirmed,
  idempotent,
  RESPONSE_CACHE_BEGIN_FAILURES,
  RESPONSE_CACHE_FINISH_FAILURES,
  storedResponse,
} from '../idempotency.js';

const writeRoute = route.post('/write', { id: 'write', failures: IDEMPOTENCY_FAILURES });
const request = () =>
  new Request('http://test/write', {
    method: 'POST',
    headers: { 'idempotency-key': 'one-write' },
    body: '{}',
  });

function setup(overrides: Partial<ResponseCache> = {}, handler = () => Promise.resolve(new Response('written'))) {
  let claimed = false;
  let stored: StoredResponse | undefined;
  const cache = {
    begin: vi.fn<ResponseCache['begin']>(
      overrides.begin ??
        (() => {
          if (stored !== undefined) return Promise.resolve({ replay: stored });
          if (claimed) return Promise.resolve('in-progress');
          claimed = true;
          return Promise.resolve('started');
        }),
    ),
    finish: vi.fn<ResponseCache['finish']>(
      overrides.finish ??
        ((_key, _owner, response) => {
          stored = response;
          return Promise.resolve();
        }),
    ),
    abandon: vi.fn<ResponseCache['abandon']>(
      overrides.abandon ??
        (() => {
          claimed = false;
          stored = undefined;
          return Promise.resolve();
        }),
    ),
  };
  const next = vi.fn(handler);
  const middleware = idempotent({ cache, scope: () => 'user', routes: [writeRoute], ttl: 100 });
  return {
    cache,
    next,
    run: () => middleware(request(), next),
    fetch: composeMiddleware(next, [middleware]),
  };
}

async function bridgeError(run: () => Response | Promise<Response>): Promise<HttpError> {
  try {
    await run();
  } catch (error) {
    if (error instanceof HttpError) return error;
    throw error;
  }
  throw new Error('Expected a canonical failure through the HTTP exception bridge');
}

describe('idempotency owned outcomes', () => {
  it.each(RESPONSE_CACHE_BEGIN_FAILURES)(
    'preserves returned begin outcome $code and its private cause',
    async definition => {
      const cause = new Error('private-store-secret');
      const failure = definition({ cause });
      const { run, cache, next } = setup({ begin: () => Promise.resolve(failure) });
      const error = await bridgeError(run);
      expect(error.code).toBe(failure.code);
      expect(error.status).toBe(failure.status);
      expect(error.remediation).toBe(failure.remediation);
      expect(error.cause).toBe(cause);
      expect(await toErrorResponse(error).text()).not.toContain('private-store-secret');
      expect(next).not.toHaveBeenCalled();
      expect(cache.finish).not.toHaveBeenCalled();
      expect(cache.abandon).not.toHaveBeenCalled();
    },
  );

  it.each(RESPONSE_CACHE_FINISH_FAILURES)(
    'preserves returned finish outcome $code after effects without releasing',
    async definition => {
      const cause = new Error('private-write-secret');
      const failure = definition({ cause });
      const { run, cache, next } = setup({ finish: () => Promise.resolve(failure) });
      const error = await bridgeError(run);
      expect(error.code).toBe(failure.code);
      expect(error.status).toBe(failure.status);
      expect(error.remediation).toBe(failure.remediation);
      expect(error.cause).toBe(cause);
      expect(await toErrorResponse(error).text()).not.toContain('private-write-secret');
      await expect(bridgeError(run)).resolves.toMatchObject({ code: 'http.idempotency_in_progress' });
      expect(next).toHaveBeenCalledOnce();
      expect(cache.abandon).not.toHaveBeenCalled();
    },
  );

  it('supervises a thrown begin as claim unconfirmed before application effects', async () => {
    const cause = new Error('private-begin-secret');
    const { run, cache, next } = setup({ begin: () => Promise.reject(cause) });
    const error = await bridgeError(run);
    expect(error.code).toBe(IdempotencyClaimUnconfirmed.code);
    expect(error.cause).toBe(cause);
    expect(await toErrorResponse(error).text()).not.toContain('private-begin-secret');
    expect(next).not.toHaveBeenCalled();
    expect(cache.abandon).not.toHaveBeenCalled();
  });

  it('replays after finish stores then throws, so a lost acknowledgement cannot repeat effects', async () => {
    const cause = new Error('private-finish-secret');
    const { run, fetch, next, cache } = setup();
    const persist = cache.finish.getMockImplementation();
    if (persist === undefined) throw new Error('Expected the default persistence implementation');
    cache.finish.mockImplementation(async (...args) => {
      orThrow(await persist(...args));
      throw cause;
    });
    const error = await bridgeError(run);
    expect(error.code).toBe(IdempotencyWriteUnconfirmed.code);
    expect(error.cause).toBe(cause);
    expect(await toErrorResponse(error).text()).not.toContain('private-finish-secret');
    const replay = await fetch(request());
    expect(replay.status).toBe(200);
    expect(await replay.text()).toBe('written');
    expect(replay.headers.get('idempotent-replayed')).toBe('true');
    expect(next).toHaveBeenCalledOnce();
    expect(cache.finish).toHaveBeenCalledOnce();
    expect(cache.finish.mock.calls[0]?.[3]).toBe(100);
    expect(cache.begin.mock.calls[0]).toHaveLength(3);
    expect(cache.abandon).not.toHaveBeenCalled();
  });

  it('blocks every retry when finish throws before storage because the write may already exist', async () => {
    const cause = new Error('storage unavailable');
    const { run, cache, next } = setup({ finish: () => Promise.reject(cause) });
    const error = await bridgeError(run);
    expect(error.code).toBe(IdempotencyWriteUnconfirmed.code);
    expect(error.cause).toBe(cause);
    for (let retry = 0; retry < 3; retry += 1) {
      await expect(bridgeError(run)).resolves.toMatchObject({ code: 'http.idempotency_in_progress' });
    }
    expect(next).toHaveBeenCalledOnce();
    expect(cache.finish).toHaveBeenCalledOnce();
    expect(cache.abandon).not.toHaveBeenCalled();
  });

  it('keeps the handler error bridge and retains the reservation after application execution throws', async () => {
    const cause = new HttpError(502, 'application.unconfirmed', 'Application result unknown');
    const { run, cache, next } = setup({}, () => Promise.reject(cause));
    await expect(run()).rejects.toBe(cause);
    await expect(bridgeError(run)).resolves.toMatchObject({ code: 'http.idempotency_in_progress' });
    expect(next).toHaveBeenCalledOnce();
    expect(cache.finish).not.toHaveBeenCalled();
    expect(cache.abandon).not.toHaveBeenCalled();
  });

  it.each(['stream', 'oversized', 'read rejection', 'consumed body'])(
    'retains ownership when a %s response cannot be buffered for replay',
    async kind => {
      const cause = new Error('private-body-secret');
      const { run, next, cache } = setup({}, async () => {
        if (kind === 'stream')
          return new Response('event: written\n\n', { headers: { 'content-type': 'text/event-stream' } });
        if (kind === 'oversized') return new Response('x'.repeat(1_048_577));
        if (kind === 'read rejection')
          return new Response(
            new ReadableStream<Uint8Array>({
              start(controller) {
                controller.error(cause);
              },
            }),
          );
        const response = new Response('already consumed');
        await response.text();
        return response;
      });
      const error = await bridgeError(run);
      expect(error.code).toBe(IdempotencyResponseUnavailable.code);
      if (kind === 'read rejection') expect(error.cause).toBe(cause);
      expect(await toErrorResponse(error).text()).not.toContain('private-body-secret');
      await expect(bridgeError(run)).resolves.toMatchObject({ code: 'http.idempotency_in_progress' });
      expect(next).toHaveBeenCalledOnce();
      expect(cache.finish).not.toHaveBeenCalled();
      expect(cache.abandon).not.toHaveBeenCalled();
    },
  );

  it.each<StoredResponse>([
    { status: 600, headers: {}, body: '' },
    { status: 200, headers: { 'invalid\nheader': 'value' }, body: '' },
    { status: 200, headers: {}, body: '%' },
  ])('classifies invalid persisted replay data without executing application work: %j', async stored => {
    expect(isFailure(parse(storedResponse, stored))).toBe(true);
    const { run, cache, next } = setup({ begin: () => Promise.resolve({ replay: stored }) });
    const error = await bridgeError(run);
    expect(error.code).toBe(IdempotencyReplayInvalid.code);
    expect(next).not.toHaveBeenCalled();
    expect(cache.finish).not.toHaveBeenCalled();
    expect(cache.abandon).not.toHaveBeenCalled();
  });
});
