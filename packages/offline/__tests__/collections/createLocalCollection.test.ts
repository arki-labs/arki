import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { createLocalCollection } from '../../src/collections/createLocalCollection.ts';
import { createMemoryCollection } from '../../src/collections/createMemoryCollection.ts';

// ---------------------------------------------------------------------------
// Schemas shared across tests
// ---------------------------------------------------------------------------

const itemSchema = z.object({
  id: z.string(),
  label: z.string(),
  count: z.number(),
});

type Item = z.infer<typeof itemSchema>;

// ---------------------------------------------------------------------------
// createLocalCollection
// ---------------------------------------------------------------------------

describe('createLocalCollection', () => {
  it('creates a collection that accepts valid items', async () => {
    const col = createLocalCollection({
      storageKey: 'test:items',
      schema: itemSchema,
      getKey: (item) => item.id,
    });

    await col.stateWhenReady;

    const tx = col.insert({ id: 'a', label: 'Alpha', count: 1 });
    await tx.isPersisted.promise;

    expect(col.size).toBe(1);
    expect(col.get('a')).toMatchObject({ id: 'a', label: 'Alpha', count: 1 });
  });

  it('rejects items that fail schema validation', async () => {
    const col = createLocalCollection({
      storageKey: 'test:items-schema',
      schema: itemSchema,
      getKey: (item) => item.id,
    });

    await col.stateWhenReady;

    expect(() => {
      // @ts-expect-error — deliberately passing wrong shape
      col.insert({ id: 'bad', label: 'bad', count: 'not-a-number' });
    }).toThrow(/validation failed/i);
  });

  it('supports reading multiple items', async () => {
    const col = createLocalCollection({
      storageKey: 'test:items-multi',
      schema: itemSchema,
      getKey: (item) => item.id,
    });

    await col.stateWhenReady;

    await col.insert({ id: 'x', label: 'X', count: 10 }).isPersisted.promise;
    await col.insert({ id: 'y', label: 'Y', count: 20 }).isPersisted.promise;

    expect(col.size).toBe(2);
    expect([...col.keys()].sort()).toEqual(['x', 'y']);
  });

  it('supports delete operations', async () => {
    const col = createLocalCollection({
      storageKey: 'test:items-delete',
      schema: itemSchema,
      getKey: (item) => item.id,
    });

    await col.stateWhenReady;
    await col.insert({ id: 'd', label: 'D', count: 5 }).isPersisted.promise;
    expect(col.size).toBe(1);

    await col.delete('d').isPersisted.promise;
    expect(col.size).toBe(0);
    expect(col.has('d')).toBe(false);
  });

  it('supports update operations', async () => {
    const col = createLocalCollection({
      storageKey: 'test:items-update',
      schema: itemSchema,
      getKey: (item) => item.id,
    });

    await col.stateWhenReady;
    await col.insert({ id: 'u', label: 'Before', count: 1 }).isPersisted.promise;

    await col.update('u', (draft) => {
      draft.label = 'After';
      draft.count = 99;
    }).isPersisted.promise;

    expect(col.get('u')).toMatchObject({ label: 'After', count: 99 });
  });

  it('accepts syncBetweenTabs: true without throwing', () => {
    expect(() => {
      createLocalCollection({
        storageKey: 'test:sync-true',
        schema: itemSchema,
        getKey: (item) => item.id,
        syncBetweenTabs: true,
      });
    }).not.toThrow();
  });

  it('accepts syncBetweenTabs: false without throwing', () => {
    expect(() => {
      createLocalCollection({
        storageKey: 'test:sync-false',
        schema: itemSchema,
        getKey: (item) => item.id,
        syncBetweenTabs: false,
      });
    }).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// createMemoryCollection
// ---------------------------------------------------------------------------

describe('createMemoryCollection', () => {
  it('creates an empty in-memory collection by default', async () => {
    const col = createMemoryCollection({
      schema: itemSchema,
      getKey: (item) => item.id,
    });

    await col.stateWhenReady;
    expect(col.size).toBe(0);
  });

  it('populates from initialData when provided', async () => {
    const seed: Item[] = [
      { id: 'm1', label: 'One', count: 1 },
      { id: 'm2', label: 'Two', count: 2 },
    ];

    const col = createMemoryCollection({
      schema: itemSchema,
      getKey: (item) => item.id,
      initialData: seed,
    });

    await col.stateWhenReady;
    expect(col.size).toBe(2);
    expect(col.get('m1')).toMatchObject({ id: 'm1', label: 'One', count: 1 });
    expect(col.get('m2')).toMatchObject({ id: 'm2', label: 'Two', count: 2 });
  });

  it('accepts inserts after construction', async () => {
    const col = createMemoryCollection({
      schema: itemSchema,
      getKey: (item) => item.id,
    });

    await col.stateWhenReady;
    await col.insert({ id: 'n', label: 'N', count: 7 }).isPersisted.promise;

    expect(col.size).toBe(1);
    expect(col.get('n')).toMatchObject({ label: 'N', count: 7 });
  });

  it('rejects items that fail schema validation', async () => {
    const col = createMemoryCollection({
      schema: itemSchema,
      getKey: (item) => item.id,
    });

    await col.stateWhenReady;

    expect(() => {
      // @ts-expect-error — deliberately wrong shape
      col.insert({ id: 'bad', label: 123, count: 'oops' });
    }).toThrow(/validation failed/i);
  });

  it('does not persist data across instances (truly in-memory)', async () => {
    const col1 = createMemoryCollection({
      schema: itemSchema,
      getKey: (item) => item.id,
    });
    await col1.stateWhenReady;
    await col1.insert({ id: 'p', label: 'P', count: 0 }).isPersisted.promise;

    // A new instance with no initialData starts empty
    const col2 = createMemoryCollection({
      schema: itemSchema,
      getKey: (item) => item.id,
    });
    await col2.stateWhenReady;
    expect(col2.size).toBe(0);
  });
});
