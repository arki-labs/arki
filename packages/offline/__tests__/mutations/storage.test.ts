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

const { createQueueStorage } = await import('../../src/mutations/storage.ts');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeMutation(overrides?: Partial<QueuedMutation>): QueuedMutation {
  return {
    id: 'test-id-1',
    idempotencyKey: 'test-id-1',
    procedurePath: ['todos', 'create'],
    input: { title: 'Buy milk' },
    actorId: 'usr_alice',
    enqueuedAt: 1_700_000_000_000,
    attempts: 0,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('QueueStorage', () => {
  beforeEach(() => {
    for (const k of Object.keys(store)) delete store[k];
    vi.clearAllMocks();
  });

  it('read() returns an empty array when nothing has been stored', async () => {
    const storage = createQueueStorage('test-queue');
    const result = await storage.read();
    expect(result).toEqual([]);
  });

  it('write() then read() round-trips an array of mutations', async () => {
    const storage = createQueueStorage('test-queue');
    const mutation = makeMutation();
    await storage.write([mutation]);

    const result = await storage.read();
    expect(result).toHaveLength(1);
    expect(result[0]?.id).toBe('test-id-1');
    expect(result[0]?.procedurePath).toEqual(['todos', 'create']);
    expect(result[0]?.input).toEqual({ title: 'Buy milk' });
  });

  it('preserves Date objects through superjson serialization', async () => {
    const storage = createQueueStorage('test-dates');
    const dateInput = { createdAt: new Date('2024-01-15T10:00:00.000Z'), title: 'Task' };
    const mutation = makeMutation({ input: dateInput });
    await storage.write([mutation]);

    const result = await storage.read();
    const restoredInput = result[0]?.input as typeof dateInput;
    expect(restoredInput.createdAt).toBeInstanceOf(Date);
    expect(restoredInput.createdAt.toISOString()).toBe('2024-01-15T10:00:00.000Z');
  });

  // A mutation queued offline is replayed later through oRPC. Its input must
  // still be a Temporal value then, or the procedure's input schema rejects it.
  it('preserves Temporal values in queued mutation input', async () => {
    const { Temporal } = await import('@arki/date/types');
    const storage = createQueueStorage('test-temporal');
    const dueAt = Temporal.Instant.from('2026-10-13T06:00:00Z');
    await storage.write([makeMutation({ input: { dueAt } })]);

    const result = await storage.read();
    const restored = (result[0]?.input as { dueAt: unknown }).dueAt;
    expect(restored).toBeInstanceOf(Temporal.Instant);
    expect((restored as typeof dueAt).equals(dueAt)).toBe(true);
  });

  it('preserves enqueuedAt timestamp exactly', async () => {
    const storage = createQueueStorage('test-timestamps');
    const mutation = makeMutation({ enqueuedAt: 1_700_000_123_456 });
    await storage.write([mutation]);

    const result = await storage.read();
    expect(result[0]?.enqueuedAt).toBe(1_700_000_123_456);
  });

  it('clear() removes the stored data so subsequent reads return []', async () => {
    const storage = createQueueStorage('test-clear');
    await storage.write([makeMutation()]);
    expect(store['test-clear']).toBeDefined();

    await storage.clear();
    expect(store['test-clear']).toBeUndefined();

    const result = await storage.read();
    expect(result).toEqual([]);
  });

  it('preserves FIFO ordering across multiple mutations', async () => {
    const storage = createQueueStorage('test-fifo');
    const m1 = makeMutation({ id: 'id-1', idempotencyKey: 'id-1', enqueuedAt: 1 });
    const m2 = makeMutation({ id: 'id-2', idempotencyKey: 'id-2', enqueuedAt: 2 });
    const m3 = makeMutation({ id: 'id-3', idempotencyKey: 'id-3', enqueuedAt: 3 });
    await storage.write([m1, m2, m3]);

    const result = await storage.read();
    expect(result.map((m) => m.id)).toEqual(['id-1', 'id-2', 'id-3']);
  });

  it('isolates data between different storageKeys', async () => {
    const storageA = createQueueStorage('queue-a');
    const storageB = createQueueStorage('queue-b');

    await storageA.write([makeMutation({ id: 'a-1', idempotencyKey: 'a-1' })]);
    await storageB.write([makeMutation({ id: 'b-1', idempotencyKey: 'b-1' })]);

    const resultA = await storageA.read();
    const resultB = await storageB.read();

    expect(resultA[0]?.id).toBe('a-1');
    expect(resultB[0]?.id).toBe('b-1');
  });

  it('returns empty array when stored data is corrupted JSON', async () => {
    const storage = createQueueStorage('test-corrupt');
    // Manually inject corrupted data
    store['test-corrupt'] = 'not-valid-superjson!!!';

    const result = await storage.read();
    expect(result).toEqual([]);
  });
});
