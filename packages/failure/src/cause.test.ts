import { describe, expect, expectTypeOf, it } from 'vitest';
import { z } from 'zod';

import type { Failure } from './failure.js';
import { findCause } from './cause.js';
import { defineFailure } from './failure.js';

const DbTimeout = defineFailure('db.timeout', { status: 503, data: z.object({ ms: z.number() }) });
const SyncFailed = defineFailure('feed.sync_failed', { status: 502, data: z.object({ feed: z.string() }) });

class SocketError extends Error {
  readonly port = 5432;
}

describe('findCause', () => {
  it('finds a failure anywhere in the cause chain, typed by its definition', () => {
    const timeout = DbTimeout({ ms: 30_000 });
    const synced = SyncFailed({ feed: 'hn' }, { cause: timeout });
    const found = findCause(synced, DbTimeout);
    expect(found).toBe(timeout);
    expectTypeOf(found).toEqualTypeOf<Failure<'db.timeout', { ms: number }> | undefined>();
  });

  it('starts with the value itself, like errors.As', () => {
    const timeout = DbTimeout({ ms: 1 });
    expect(findCause(timeout, DbTimeout)).toBe(timeout);
  });

  it('finds a thrown error class through failures and plain errors', () => {
    const socket = new SocketError('reset');
    const chain = SyncFailed({ feed: 'hn' }, { cause: new Error('query failed', { cause: socket }) });
    const found = findCause(chain, SocketError);
    expect(found).toBe(socket);
    expectTypeOf(found).toEqualTypeOf<SocketError | undefined>();
  });

  it('returns undefined when nothing matches, and survives a cyclic chain', () => {
    expect(findCause(SyncFailed({ feed: 'x' }), DbTimeout)).toBeUndefined();
    const loop = new Error('a');
    const other = new Error('b', { cause: loop });
    Object.defineProperty(loop, 'cause', { value: other });
    expect(findCause(loop, SocketError)).toBeUndefined();
  });
});
