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
    id,
    idempotencyKey: id,
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
    const items = await dlStore.list();
    expect(items).toEqual([]);
  });

  it('add() persists a mutation and list() returns it', async () => {
    const dlStore = createDeadLetterStore('test-dl');
    const mutation = makeMutation('mut-1');
    const error = new Error('Request failed with 422');

    await dlStore.add(mutation, error);

    const items = await dlStore.list();
    expect(items).toHaveLength(1);
    expect(items[0]?.id).toBe('mut-1');
    expect(items[0]?.attempts).toBe(5);
  });

  it('add() accumulates multiple entries in insertion order', async () => {
    const dlStore = createDeadLetterStore('test-dl-order');

    await dlStore.add(makeMutation('first'), new Error('err1'));
    await dlStore.add(makeMutation('second'), new Error('err2'));
    await dlStore.add(makeMutation('third'), new Error('err3'));

    const items = await dlStore.list();
    expect(items.map((m) => m.id)).toEqual(['first', 'second', 'third']);
  });

  it('remove() deletes an entry by id; remaining entries are preserved', async () => {
    const dlStore = createDeadLetterStore('test-dl-remove');

    await dlStore.add(makeMutation('keep-1'), new Error('e1'));
    await dlStore.add(makeMutation('remove-me'), new Error('e2'));
    await dlStore.add(makeMutation('keep-2'), new Error('e3'));

    await dlStore.remove('remove-me');

    const items = await dlStore.list();
    expect(items.map((m) => m.id)).toEqual(['keep-1', 'keep-2']);
  });

  it('remove() on a non-existent id is a no-op', async () => {
    const dlStore = createDeadLetterStore('test-dl-noop');
    await dlStore.add(makeMutation('real'), new Error('e'));

    await dlStore.remove('ghost-id');

    const items = await dlStore.list();
    expect(items).toHaveLength(1);
  });

  it('subscribe() fires when add() is called', async () => {
    const dlStore = createDeadLetterStore('test-dl-sub');
    const listener = vi.fn();

    dlStore.subscribe(listener);
    await dlStore.add(makeMutation('sub-test'), new Error('e'));

    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('subscribe() fires when remove() is called', async () => {
    const dlStore = createDeadLetterStore('test-dl-sub-remove');
    await dlStore.add(makeMutation('rem-sub'), new Error('e'));

    const listener = vi.fn();
    dlStore.subscribe(listener);
    await dlStore.remove('rem-sub');

    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('the unsubscribe function returned by subscribe() stops notifications', async () => {
    const dlStore = createDeadLetterStore('test-dl-unsub');
    const listener = vi.fn();

    const unsubscribe = dlStore.subscribe(listener);
    unsubscribe();

    await dlStore.add(makeMutation('no-notify'), new Error('e'));
    expect(listener).not.toHaveBeenCalled();
  });

  it('isolates data between different storageKeys', async () => {
    const dlA = createDeadLetterStore('dl-a');
    const dlB = createDeadLetterStore('dl-b');

    await dlA.add(makeMutation('a-1'), new Error('e'));

    const itemsA = await dlA.list();
    const itemsB = await dlB.list();

    expect(itemsA).toHaveLength(1);
    expect(itemsB).toHaveLength(0);
  });
});
