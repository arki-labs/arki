import { orThrow } from '@arki/failure';
import { queuedMutationId, mutationIdempotencyKey } from '../../src/mutations/identity.ts';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { QueuedMutation } from '../../src/mutations/queue.ts';

// ---------------------------------------------------------------------------
// In-memory IDB mock
// ---------------------------------------------------------------------------

const store: Record<string, string> = {};

vi.mock('idb-keyval', () => ({
  get: vi.fn((key: string) => Promise.resolve(store[key])),
  set: vi.fn((key: string, value: string) => {
    store[key] = value;
    return Promise.resolve();
  }),
  del: vi.fn((key: string) => {
    delete store[key];
    return Promise.resolve();
  }),
}));

const { createDeadLetterStore } = await import('../../src/mutations/dead-letter.ts');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeMutation(id: string): QueuedMutation {
  return {
    id: queuedMutationId.schema.parse(id),
    idempotencyKey: mutationIdempotencyKey.schema.parse(id),
    procedurePath: ['todos', 'create'],
    input: { title: `Task ${id}` },
    actorId: 'usr_alice',
    enqueuedAt: Date.now(),
    attempts: 5,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('DeadLetterStore', () => {
  beforeEach(() => {
    for (const k of Object.keys(store)) delete store[k];
    vi.clearAllMocks();
  });

  it('list() returns empty array when no entries exist', async () => {
    const dlStore = createDeadLetterStore('test-dl');
    const items = orThrow(await dlStore.list());
    expect(items).toEqual([]);
  });

  it('add() persists a mutation and list() returns it', async () => {
    const dlStore = createDeadLetterStore('test-dl');
    const mutation = makeMutation('mut-1');
    const error = new Error('Request failed with 422');

    orThrow(await dlStore.add(mutation, error));

    const items = orThrow(await dlStore.list());
    expect(items).toHaveLength(1);
    expect(items[0]?.id).toBe('mut-1');
    expect(items[0]?.attempts).toBe(5);
  });

  it('add() accumulates multiple entries in insertion order', async () => {
    const dlStore = createDeadLetterStore('test-dl-order');

    orThrow(await dlStore.add(makeMutation('first'), new Error('err1')));
    orThrow(await dlStore.add(makeMutation('second'), new Error('err2')));
    orThrow(await dlStore.add(makeMutation('third'), new Error('err3')));

    const items = orThrow(await dlStore.list());
    expect(items.map((m) => m.id)).toEqual(['first', 'second', 'third']);
  });

  it('remove() deletes an entry by id; remaining entries are preserved', async () => {
    const dlStore = createDeadLetterStore('test-dl-remove');

    orThrow(await dlStore.add(makeMutation('keep-1'), new Error('e1')));
    orThrow(await dlStore.add(makeMutation('remove-me'), new Error('e2')));
    orThrow(await dlStore.add(makeMutation('keep-2'), new Error('e3')));

    orThrow(await dlStore.remove(queuedMutationId.schema.parse('remove-me')));

    const items = orThrow(await dlStore.list());
    expect(items.map((m) => m.id)).toEqual(['keep-1', 'keep-2']);
  });

  it('remove() on a non-existent id is a no-op', async () => {
    const dlStore = createDeadLetterStore('test-dl-noop');
    orThrow(await dlStore.add(makeMutation('real'), new Error('e')));

    orThrow(await dlStore.remove(queuedMutationId.schema.parse('ghost-id')));

    const items = orThrow(await dlStore.list());
    expect(items).toHaveLength(1);
  });

  it('subscribe() fires when add() is called', async () => {
    const dlStore = createDeadLetterStore('test-dl-sub');
    const listener = vi.fn();

    dlStore.subscribe(listener);
    orThrow(await dlStore.add(makeMutation('sub-test'), new Error('e')));

    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('subscribe() fires when remove() is called', async () => {
    const dlStore = createDeadLetterStore('test-dl-sub-remove');
    orThrow(await dlStore.add(makeMutation('rem-sub'), new Error('e')));

    const listener = vi.fn();
    dlStore.subscribe(listener);
    orThrow(await dlStore.remove(queuedMutationId.schema.parse('rem-sub')));

    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('the unsubscribe function returned by subscribe() stops notifications', async () => {
    const dlStore = createDeadLetterStore('test-dl-unsub');
    const listener = vi.fn();

    const unsubscribe = dlStore.subscribe(listener);
    unsubscribe();

    orThrow(await dlStore.add(makeMutation('no-notify'), new Error('e')));
    expect(listener).not.toHaveBeenCalled();
  });

  it('isolates data between different storageKeys', async () => {
    const dlA = createDeadLetterStore('dl-a');
    const dlB = createDeadLetterStore('dl-b');

    orThrow(await dlA.add(makeMutation('a-1'), new Error('e')));

    const itemsA = orThrow(await dlA.list());
    const itemsB = orThrow(await dlB.list());

    expect(itemsA).toHaveLength(1);
    expect(itemsB).toHaveLength(0);
  });

  it('preserves committed writes and later observers when a reporter throws or rejects', async () => {
    const dlStore = createDeadLetterStore('reporter-refusal');
    const later = vi.fn();
    dlStore.subscribe(() => { throw new Error('reporter refused'); });
    // eslint-disable-next-line @typescript-eslint/no-misused-promises -- Exercise a malformed JS observer returning a rejected promise from a void API.
    dlStore.subscribe(() => { return Promise.reject(new Error('async reporter refused')); });
    dlStore.subscribe(later);

    expect(await dlStore.add(makeMutation('reported'), new Error('e'))).toBeUndefined();
    expect(orThrow(await dlStore.list())).toHaveLength(1);
    expect(later).toHaveBeenCalledTimes(1);
  });

  it('does not await or recursively notify a reporter that writes to the store', async () => {
    const dlStore = createDeadLetterStore('reporter-reentry');
    let nested: ReturnType<typeof dlStore.remove> | undefined;
    const reporter = vi.fn(() => {
      nested = dlStore.remove(queuedMutationId.schema.parse('reentrant'));
      return nested;
    });
    const later = vi.fn();
    // eslint-disable-next-line @typescript-eslint/no-misused-promises -- Exercise reentrant async JS reporting through the public void observer API.
    dlStore.subscribe(reporter);
    dlStore.subscribe(later);
    const { set } = await import('idb-keyval');

    expect(await dlStore.add(makeMutation('reentrant'), new Error('e'))).toBeUndefined();
    expect(await nested).toBeUndefined();
    expect(orThrow(await dlStore.list())).toEqual([]);
    expect(reporter).toHaveBeenCalledTimes(1);
    expect(later).toHaveBeenCalledTimes(2);
    expect(set).toHaveBeenCalledTimes(2);
  });

  it('notifies other observers of future commits while one observer stays pending', async () => {
    const dlStore = createDeadLetterStore('pending-reporter');
    const pending = vi.fn(() => new Promise<void>(() => { /* Intentionally never settles. */ }));
    const later = vi.fn();
    // eslint-disable-next-line @typescript-eslint/no-misused-promises -- Exercise a malformed JS observer that never settles through the public void API.
    dlStore.subscribe(pending);
    dlStore.subscribe(later);

    expect(await dlStore.add(makeMutation('first-update'), new Error('e'))).toBeUndefined();
    expect(await dlStore.add(makeMutation('second-update'), new Error('e'))).toBeUndefined();
    expect(orThrow(await dlStore.list())).toHaveLength(2);
    expect(pending).toHaveBeenCalledTimes(1);
    expect(later).toHaveBeenCalledTimes(2);
  });
});
