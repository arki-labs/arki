import type { EmbeddingSpace } from '@arki/embeddings';
import { describe, expect, it } from 'vitest';

import { MockVectorProvider } from '../mock';

const space: EmbeddingSpace = {
  provider: 'fake',
  model: 'fake-3',
  dimensions: 3,
  normalized: true,
  quantization: 'float32',
  instructionVersion: 0,
};

describe('MockVectorProvider vector-in', () => {
  it('ranks by cosine similarity, descending', async () => {
    const p = new MockVectorProvider({ space });
    await p.upsertVector('a', [1, 0, 0], { userId: 'u1', kind: 'item' });
    await p.upsertVector('b', [0.9, 0.1, 0], { userId: 'u1', kind: 'item' });
    await p.upsertVector('c', [0, 1, 0], { userId: 'u1', kind: 'item' });

    const hits = await p.searchByVector([1, 0, 0], 10);
    expect(hits.map((h) => h.id)).toEqual(['a', 'b', 'c']);
    expect(hits[0]!.score).toBeCloseTo(1, 5);
  });

  it('honors limit', async () => {
    const p = new MockVectorProvider({ space });
    await p.upsertVector('a', [1, 0, 0], { userId: 'u1', kind: 'item' });
    await p.upsertVector('b', [0.9, 0.1, 0], { userId: 'u1', kind: 'item' });
    await p.upsertVector('c', [0.8, 0.2, 0], { userId: 'u1', kind: 'item' });

    const hits = await p.searchByVector([1, 0, 0], 2);
    expect(hits).toHaveLength(2);
  });

  // R5 CRITICAL — a userId-filter regression leaks one user's data into another's.
  it('NEVER returns another user’s points when filtered by userId', async () => {
    const p = new MockVectorProvider({ space });
    await p.upsertVector('u1-doc', [1, 0, 0], { userId: 'u1', kind: 'item' });
    await p.upsertVector('u2-doc', [1, 0, 0], { userId: 'u2', kind: 'item' }); // identical vector, different owner

    const hits = await p.searchByVector([1, 0, 0], 10, { userId: 'u1' });
    expect(hits.map((h) => h.id)).toEqual(['u1-doc']);
    expect(hits.some((h) => h.id === 'u2-doc')).toBe(false);
  });

  it('filters by kind alongside userId', async () => {
    const p = new MockVectorProvider({ space });
    await p.upsertVector('item', [1, 0, 0], { userId: 'u1', kind: 'item' });
    await p.upsertVector('chunk', [1, 0, 0], { userId: 'u1', kind: 'chunk' });

    const hits = await p.searchByVector([1, 0, 0], 10, { userId: 'u1', kind: 'chunk' });
    expect(hits.map((h) => h.id)).toEqual(['chunk']);
  });

  it('supports array filters (IN-semantics) and numeric range filters', async () => {
    const p = new MockVectorProvider({ space });
    await p.upsertVector('old', [1, 0, 0], { userId: 'u1', kind: 'chunk', itemDate: 100, sourceId: 'src_a' });
    await p.upsertVector('new', [1, 0, 0], { userId: 'u1', kind: 'chunk', itemDate: 500, sourceId: 'src_b' });
    await p.upsertVector('other-src', [1, 0, 0], { userId: 'u1', kind: 'chunk', itemDate: 500, sourceId: 'src_c' });

    // Range: only points at/after itemDate 200.
    const recent = await p.searchByVector([1, 0, 0], 10, { userId: 'u1', itemDate: { gte: 200 } });
    expect(recent.map((h) => h.id).sort()).toEqual(['new', 'other-src']);

    // Array: only points from the listed sources.
    const bySource = await p.searchByVector([1, 0, 0], 10, { userId: 'u1', sourceId: ['src_a', 'src_b'] });
    expect(bySource.map((h) => h.id).sort()).toEqual(['new', 'old']);
  });

  it('upsertVector overwrites the same id (idempotent re-index)', async () => {
    const p = new MockVectorProvider({ space });
    await p.upsertVector('a', [1, 0, 0], { userId: 'u1', kind: 'item' });
    await p.upsertVector('a', [0, 1, 0], { userId: 'u1', kind: 'item' });

    const hits = await p.searchByVector([0, 1, 0], 10, { userId: 'u1' });
    expect(hits).toHaveLength(1);
    expect(hits[0]!.id).toBe('a');
    expect(hits[0]!.score).toBeCloseTo(1, 5);
  });

  it('accepts the typed-array vectors @arki/embeddings returns', async () => {
    const p = new MockVectorProvider({ space });
    await p.upsertVector('a', Float32Array.from([1, 0, 0]), { userId: 'u1', kind: 'item' });

    const hits = await p.searchByVector(Float32Array.from([1, 0, 0]), 10);
    expect(hits.map((h) => h.id)).toEqual(['a']);
    expect(hits[0]!.score).toBeCloseTo(1, 5);
  });

  // Reading by filter needs no query vector: a dummy zero vector would score every point 0.
  it('scroll returns points by filter alone, page by page', async () => {
    const p = new MockVectorProvider({ space });
    await p.upsertVector('a', [1, 0, 0], { userId: 'u1', kind: 'item' });
    await p.upsertVector('b', [0, 1, 0], { userId: 'u1', kind: 'item' });
    await p.upsertVector('c', [0, 0, 1], { userId: 'u1', kind: 'item' });
    await p.upsertVector('other', [1, 0, 0], { userId: 'u2', kind: 'item' });

    const first = await p.scroll({ userId: 'u1' }, { limit: 2 });
    expect(first.items.map((i) => i.id)).toEqual(['a', 'b']);
    expect(first.next).toBeDefined();

    const second = await p.scroll({ userId: 'u1' }, { limit: 2, offset: first.next });
    expect(second.items.map((i) => i.id)).toEqual(['c']);
    expect(second.next).toBeUndefined();
  });
});
