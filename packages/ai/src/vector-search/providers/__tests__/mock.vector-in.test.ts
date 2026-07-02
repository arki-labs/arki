import { describe, expect, it } from 'vitest';

import { MockVectorProvider } from '../mock';

// The mock never calls the embedding provider on the vector-in path; a stub is
// enough to construct it.
const embed = {
  getEmbedding: async () => [0, 0, 0],
  getDimensions: () => 3,
} as never;

describe('MockVectorProvider vector-in', () => {
  it('ranks by cosine similarity, descending', async () => {
    const p = new MockVectorProvider(embed);
    await p.upsertVector('a', [1, 0, 0], { userId: 'u1', kind: 'item' });
    await p.upsertVector('b', [0.9, 0.1, 0], { userId: 'u1', kind: 'item' });
    await p.upsertVector('c', [0, 1, 0], { userId: 'u1', kind: 'item' });

    const hits = await p.searchByVector([1, 0, 0], 10);
    expect(hits.map((h) => h.id)).toEqual(['a', 'b', 'c']);
    expect(hits[0]!.score).toBeCloseTo(1, 5);
  });

  it('honors limit', async () => {
    const p = new MockVectorProvider(embed);
    await p.upsertVector('a', [1, 0, 0], { userId: 'u1', kind: 'item' });
    await p.upsertVector('b', [0.9, 0.1, 0], { userId: 'u1', kind: 'item' });
    await p.upsertVector('c', [0.8, 0.2, 0], { userId: 'u1', kind: 'item' });

    const hits = await p.searchByVector([1, 0, 0], 2);
    expect(hits).toHaveLength(2);
  });

  // R5 CRITICAL — a userId-filter regression leaks one user's data into another's.
  it('NEVER returns another user’s points when filtered by userId', async () => {
    const p = new MockVectorProvider(embed);
    await p.upsertVector('u1-doc', [1, 0, 0], { userId: 'u1', kind: 'item' });
    await p.upsertVector('u2-doc', [1, 0, 0], { userId: 'u2', kind: 'item' }); // identical vector, different owner

    const hits = await p.searchByVector([1, 0, 0], 10, { userId: 'u1' });
    expect(hits.map((h) => h.id)).toEqual(['u1-doc']);
    expect(hits.some((h) => h.id === 'u2-doc')).toBe(false);
  });

  it('filters by kind alongside userId', async () => {
    const p = new MockVectorProvider(embed);
    await p.upsertVector('item', [1, 0, 0], { userId: 'u1', kind: 'item' });
    await p.upsertVector('chunk', [1, 0, 0], { userId: 'u1', kind: 'chunk' });

    const hits = await p.searchByVector([1, 0, 0], 10, { userId: 'u1', kind: 'chunk' });
    expect(hits.map((h) => h.id)).toEqual(['chunk']);
  });

  it('upsertVector overwrites the same id (idempotent re-index)', async () => {
    const p = new MockVectorProvider(embed);
    await p.upsertVector('a', [1, 0, 0], { userId: 'u1', kind: 'item' });
    await p.upsertVector('a', [0, 1, 0], { userId: 'u1', kind: 'item' });

    const hits = await p.searchByVector([0, 1, 0], 10, { userId: 'u1' });
    expect(hits).toHaveLength(1);
    expect(hits[0]!.id).toBe('a');
    expect(hits[0]!.score).toBeCloseTo(1, 5);
  });
});
