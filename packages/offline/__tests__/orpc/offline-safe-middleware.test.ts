import { describe, expect, it, vi, beforeEach } from 'vitest';
import { offlineSafe } from '../../src/orpc/offline-safe-middleware';
import type { IdempotencyRepository } from '../../src/orpc/idempotency-repository';

function makeRepo(overrides?: Partial<IdempotencyRepository>): IdempotencyRepository {
  return {
    find: vi.fn().mockResolvedValue(null),
    store: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  } as unknown as IdempotencyRepository;
}

function makeOutput() {
  return vi.fn((value: unknown) => Promise.resolve({ output: value, context: {} }));
}

function makeNext(returnValue: unknown = { data: 'fresh' }) {
  return vi.fn(() => Promise.resolve({ output: returnValue, context: {} }));
}

function makeOptions(overrides?: {
  headers?: Record<string, string>;
  userId?: string | null;
  path?: string[];
}) {
  const headers = new Headers(overrides?.headers ?? { 'Idempotency-Key': 'test-key-123' });
  return {
    context: {
      headers,
      session: overrides?.userId !== undefined
        ? (overrides.userId ? { user: { id: overrides.userId } } : null)
        : { user: { id: 'usr_abc' } },
    },
    path: overrides?.path ?? ['posts', 'createPost'],
    next: makeNext(),
    errors: {},
    procedure: {} as any,
    signal: undefined,
    lastEventId: undefined,
  };
}

describe('offlineSafe middleware', () => {
  let repo: IdempotencyRepository;
  let output: ReturnType<typeof makeOutput>;

  beforeEach(() => {
    repo = makeRepo();
    output = makeOutput();
  });

  it('passes through when no Idempotency-Key header', async () => {
    const opts = makeOptions({ headers: {} });
    const middleware = offlineSafe(repo);

    await middleware(opts as any, undefined, output);

    expect(opts.next).toHaveBeenCalledOnce();
    expect(repo.find).not.toHaveBeenCalled();
    expect(output).not.toHaveBeenCalled();
  });

  it('passes through when no session user', async () => {
    const opts = makeOptions({ userId: null });
    const middleware = offlineSafe(repo);

    await middleware(opts as any, undefined, output);

    expect(opts.next).toHaveBeenCalledOnce();
    expect(repo.find).not.toHaveBeenCalled();
  });

  it('returns cached response on cache hit', async () => {
    const cached = { id: 'post_1', title: 'Hello' };
    repo = makeRepo({ find: vi.fn().mockResolvedValue(cached) });
    const middleware = offlineSafe(repo);
    const opts = makeOptions();

    await middleware(opts as any, undefined, output);

    expect(opts.next).not.toHaveBeenCalled();
    expect(output).toHaveBeenCalledWith(cached);
    expect(repo.store).not.toHaveBeenCalled();
  });

  it('calls next and stores result on cache miss', async () => {
    const freshData = { id: 'post_2', title: 'New Post' };
    const opts = makeOptions();
    opts.next = makeNext(freshData);
    const middleware = offlineSafe(repo);

    await middleware(opts as any, undefined, output);

    expect(opts.next).toHaveBeenCalledOnce();
    expect(repo.store).toHaveBeenCalledWith(
      'test-key-123',
      'posts.createPost',
      'usr_abc',
      freshData,
    );
    expect(output).not.toHaveBeenCalled();
  });

  it('joins path array into dot-separated procedure path', async () => {
    const opts = makeOptions({ path: ['users', 'profile', 'update'] });
    const middleware = offlineSafe(repo);

    await middleware(opts as any, undefined, output);

    expect(repo.find).toHaveBeenCalledWith('test-key-123', 'users.profile.update', 'usr_abc');
  });

  it('does not block response when store fails', async () => {
    repo = makeRepo({ store: vi.fn().mockRejectedValue(new Error('DB down')) });
    const freshData = { id: 'post_3' };
    const opts = makeOptions();
    opts.next = makeNext(freshData);
    const middleware = offlineSafe(repo);

    const result = await middleware(opts as any, undefined, output);

    expect(result.output).toEqual(freshData);
  });
});
