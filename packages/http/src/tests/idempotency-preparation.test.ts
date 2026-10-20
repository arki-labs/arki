import { afterEach, describe, expect, it, vi } from 'vitest';

import { defineFailure, InvalidEnvelope, UnexpectedDefect } from '@arki/failure';

import type { ResponseCache } from '../idempotency.js';
import { route } from '../contract.js';
import { HttpError, toErrorResponse } from '../error.js';
import { RequestCancelled } from '../failures.js';
import {
  IDEMPOTENCY_FAILURES,
  IdempotencyHashUnavailable,
  IdempotencyRequestUnreadable,
  idempotent,
} from '../idempotency.js';

const Denied = defineFailure('test.scope_denied', { status: 403 });
const endpoint = route.post('/write', { id: 'preparation.write', failures: [...IDEMPOTENCY_FAILURES, Denied] });
const secure = globalThis.crypto;
const uuid = '8b91ca18-3fce-42c4-af7b-f551178de374';
const request = (signal?: AbortSignal) =>
  new Request('https://test/write?b=2&a=1', {
    method: 'POST',
    headers: { 'idempotency-key': 'key' },
    body: 'abc',
    signal,
  });
function setup(
  scope: (
    req: Request,
  ) => string | undefined | ReturnType<typeof Denied> | Promise<string | undefined | ReturnType<typeof Denied>> = () =>
    'user',
) {
  const cache = {
    begin: vi.fn<ResponseCache['begin']>(() => Promise.resolve('started')),
    finish: vi.fn<ResponseCache['finish']>(() => Promise.resolve()),
    abandon: vi.fn<ResponseCache['abandon']>(() => Promise.resolve()),
  };
  const handler = vi.fn(() => Promise.resolve(new Response(null, { status: 204 })));
  const middleware = idempotent({ cache, scope, routes: [endpoint], ttl: 100 });
  return { cache, handler, run: (req = request()) => middleware(req, handler) };
}
async function failure(run: () => Response | Promise<Response>) {
  try {
    await run();
  } catch (error) {
    if (error instanceof HttpError) return error;
    throw error;
  }
  throw new Error('Expected canonical HTTP refusal');
}
function untouched(subject: ReturnType<typeof setup>) {
  expect(subject.cache.begin).not.toHaveBeenCalled();
  expect(subject.cache.finish).not.toHaveBeenCalled();
  expect(subject.cache.abandon).not.toHaveBeenCalled();
  expect(subject.handler).not.toHaveBeenCalled();
}
function provider(subtle: unknown) {
  vi.stubGlobal('crypto', { randomUUID: () => uuid, subtle });
}
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('idempotency preparation refuses before reservation or application effects', () => {
  it('bridges exact scope refusals with private causes intact and safe wire data', async () => {
    const cause = new Error('private scope credential');
    const refusal = Denied({ cause });
    const subject = setup(() => refusal);
    const error = await failure(subject.run);
    expect(error).toMatchObject({ code: refusal.code, status: refusal.status, cause });
    expect(await toErrorResponse(error).text()).not.toContain(cause.message);
    untouched(subject);
  });
  it.each(['throw', 'reject', 'invalid'])('supervises a scope %s as UnexpectedDefect', async kind => {
    const cause = new Error('private scope credential');
    const scope = () => {
      if (kind === 'throw') throw cause;
      return Promise.reject(cause);
    };
    const subject = setup(scope);
    if (kind === 'invalid') {
      // A foreign JavaScript callback can violate the TypeScript contract.
      const foreign: unknown = () => ({ user: 'private' });
      const options = { cache: subject.cache, scope, routes: [endpoint], ttl: 100 };
      Object.defineProperty(options, 'scope', { value: foreign });
      const middleware = idempotent(options);
      const error = await failure(() => middleware(request(), subject.handler));
      expect(error.code).toBe(UnexpectedDefect.code);
    } else {
      const error = await failure(subject.run);
      expect(error).toMatchObject({ code: UnexpectedDefect.code, cause });
      expect(await toErrorResponse(error).text()).not.toContain(cause.message);
    }
    untouched(subject);
  });
  it('checks foreign scope failures against the matched route, never another route', async () => {
    const subject = setup();
    const narrower = route.post('/other', { id: 'preparation.other', failures: IDEMPOTENCY_FAILURES });
    const options = { cache: subject.cache, scope: () => 'user', routes: [endpoint, narrower], ttl: 100 };
    Object.defineProperty(options, 'scope', { value: () => Denied() });
    const middleware = idempotent(options);
    const req = new Request('https://test/other', { method: 'POST', headers: { 'idempotency-key': 'key' } });
    expect(await failure(() => middleware(req, subject.handler))).toMatchObject({ code: InvalidEnvelope.code });
    untouched(subject);
  });
  it('keeps undefined scope as the unauthenticated bypass', async () => {
    const subject = setup((): undefined => {
      /* Unauthenticated requests deliberately bypass replay. */
    });
    await expect(subject.run()).resolves.toHaveProperty('status', 204);
    expect(subject.handler).toHaveBeenCalledOnce();
    expect(subject.cache.begin).not.toHaveBeenCalled();
  });
  it.each(['clone', 'locked', 'read'])('classifies %s body failure before effects', async kind => {
    const cause = new Error('private body');
    const req = request();
    if (kind === 'clone')
      vi.spyOn(req, 'clone').mockImplementation(() => {
        throw cause;
      });
    if (kind === 'locked') req.body?.getReader();
    if (kind === 'read')
      vi.spyOn(req, 'clone').mockReturnValue(
        new Request('https://test/write', {
          method: 'POST',
          body: new ReadableStream<Uint8Array>({
            start(controller) {
              controller.error(cause);
            },
          }),
          duplex: 'half',
        }),
      );
    const subject = setup();
    const error = await failure(() => subject.run(req));
    expect(error).toMatchObject({ code: IdempotencyRequestUnreadable.code, status: 400 });
    if (kind !== 'locked') expect(error.cause).toBe(cause);
    expect(await toErrorResponse(error).text()).not.toContain(cause.message);
    untouched(subject);
  });
  it.each([undefined, null, {}, { digest: 1 }])('reports unavailable digest capability %j', async subtle => {
    provider(subtle);
    const subject = setup();
    expect(await failure(subject.run)).toMatchObject({ code: IdempotencyHashUnavailable.code, status: 503 });
    untouched(subject);
  });
  it.each(['get', 'throw', 'reject', 'object', 'view', 'short', 'shadowed', 'detached'])(
    'supervises %s digest provider defects',
    async kind => {
      const cause = new Error('private crypto credential');
      const digest = vi.fn(() => {
        if (kind === 'throw') throw cause;
        if (kind === 'reject') return Promise.reject(cause);
        if (kind === 'object') return Promise.resolve({ byteLength: 32 });
        if (kind === 'view') return Promise.resolve(new Uint8Array(32));
        if (kind === 'shadowed') {
          const buffer = new ArrayBuffer(1);
          Object.defineProperty(buffer, 'byteLength', { value: 32 });
          return Promise.resolve(buffer);
        }
        if (kind === 'detached') {
          const buffer = new ArrayBuffer(32);
          structuredClone(buffer, { transfer: [buffer] });
          return Promise.resolve(buffer);
        }
        return Promise.resolve(new ArrayBuffer(31));
      });
      const subtle = { digest };
      if (kind === 'get')
        Object.defineProperty(subtle, 'digest', {
          get() {
            throw cause;
          },
        });
      provider(subtle);
      const subject = setup();
      const error = await failure(subject.run);
      expect(error.code).toBe(UnexpectedDefect.code);
      if (['get', 'throw', 'reject'].includes(kind)) expect(error.cause).toBe(cause);
      expect(await toErrorResponse(error).text()).not.toContain(cause.message);
      untouched(subject);
    },
  );
  it.each(['before', 'scope', 'body', 'hash'])('observes cancellation at %s preparation boundary', async phase => {
    const controller = new AbortController();
    const req = request(controller.signal);
    const scope = vi.fn((received: Request) => {
      expect(received.signal).toBe(req.signal);
      if (phase === 'scope') controller.abort();
      return 'user';
    });
    if (phase === 'before') controller.abort();
    if (phase === 'body')
      vi.spyOn(req, 'clone').mockImplementation(() => {
        controller.abort();
        throw new Error('aborted read');
      });
    if (phase === 'hash')
      provider({
        digest: () => {
          controller.abort();
          return Promise.resolve(new ArrayBuffer(32));
        },
      });
    const subject = setup(scope);
    expect(await failure(() => subject.run(req))).toMatchObject({ code: RequestCancelled.code });
    if (phase === 'before') expect(scope).not.toHaveBeenCalled();
    untouched(subject);
  });
  it.each([2, 3])('stops immediately when cancellation occurs during digest stage %i', async stage => {
    const controller = new AbortController();
    const digest = vi.fn(() => {
      if (digest.mock.calls.length === stage) controller.abort();
      return Promise.resolve(new ArrayBuffer(32));
    });
    provider({ digest });
    const subject = setup();
    expect(await failure(() => subject.run(request(controller.signal)))).toMatchObject({ code: RequestCancelled.code });
    expect(digest).toHaveBeenCalledTimes(stage);
    untouched(subject);
  });
  it.each([2, 3])('supervises a rejection from digest stage %i before effects', async stage => {
    const cause = new Error('private late digest defect');
    let calls = 0;
    provider({
      digest: () => {
        calls += 1;
        return calls === stage ? Promise.reject(cause) : Promise.resolve(new ArrayBuffer(32));
      },
    });
    const subject = setup();
    expect(await failure(subject.run)).toMatchObject({ code: UnexpectedDefect.code, cause });
    expect(calls).toBe(stage);
    untouched(subject);
  });
  it('waits for an in-flight scope callback to settle and then observes cancellation', async () => {
    const controller = new AbortController();
    let complete: ((value: string) => void) | undefined;
    const pending = new Promise<string>(resolve => {
      complete = resolve;
    });
    const subject = setup(() => pending);
    let settled = false;
    const result = failure(() => subject.run(request(controller.signal))).finally(() => {
      settled = true;
    });
    controller.abort();
    await Promise.resolve();
    await Promise.resolve();
    expect(settled).toBe(false);
    untouched(subject);
    if (complete === undefined) throw new Error('Expected pending scope resolver');
    complete('user');
    expect(await result).toMatchObject({ code: RequestCancelled.code });
    untouched(subject);
  });
  it('preserves SubtleCrypto receiver and the established three SHA-256 byte inputs', async () => {
    const digest = vi.spyOn(secure.subtle, 'digest');
    const subject = setup();
    await subject.run();
    expect(digest).toHaveBeenCalledTimes(3);
    expect(digest.mock.contexts).toEqual([secure.subtle, secure.subtle, secure.subtle]);
    const inputs = digest.mock.calls.map(call => new TextDecoder().decode(call[1]));
    expect(inputs).toEqual([
      '4:userkey',
      'abc',
      'POST\n/write\n[["a","1"],["b","2"]]\nba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    ]);
    expect(subject.cache.begin.mock.calls[0]?.[0]).toBe(
      '46c233812ab755b6e0e82f258e41b6161874450e95cf655433a82d26ec326678',
    );
  });
});
