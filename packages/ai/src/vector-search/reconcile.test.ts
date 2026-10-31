/**
 * The vector reconciler is the durability backstop for a Postgres → vector
 * index mirror. Contracts: (1) the tombstone drain runs FIRST and a dead index
 * stops the run before any embedding work; (2) a dimension-mismatched row is
 * re-embedded from source text, persisted with OBSERVED dims, and upserted
 * with its payload; (3) a current row is re-upserted as-is (idempotent heal);
 * (4) the row budget bounds a run across stores; (5) ERASURE: tombstones are
 * acknowledged only against a durable index, and a point whose row stopped
 * being current while it was upserted is deleted again.
 */
import { trace } from '@opentelemetry/api';
import { BasicTracerProvider, InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { ModelUnavailable, spaceId } from '@arki/embeddings';

import { VectorStoreUnavailable } from '../failures';
import type { MismatchedRow, ReconcileDeps, ReconcileRow, ReconcileStore } from './reconcile';
import { runVectorReconciliation } from './reconcile';

type Payload = {
  userId: string;
  kind: 'item' | 'chunk' | 'highlight';
  model: string;
  dimensions: number;
  itemDate?: number;
  contentType?: string;
  sourceId?: string;
};
type TombstoneId = `vtmb_${string}`;

/** The outage a dep returns when its backend cannot be reached. */
const outage = (reason: string) => VectorStoreUnavailable({ operation: 'test', reason });

const MODEL = 'qwen3-embedding:0.6b';
const SPACE = {
  provider: 'ollama',
  model: MODEL,
  dimensions: 4,
  normalized: true,
  quantization: 'float32',
  instructionVersion: 0,
} as const;

function makeStore(overrides: Partial<ReconcileStore<Payload>> = {}): ReconcileStore<Payload> {
  return {
    name: 'test-store',
    listMismatched: vi.fn().mockResolvedValue([]),
    listCurrent: vi.fn().mockResolvedValue([]),
    // Default: every upserted row is still current.
    stillCurrent: vi.fn().mockImplementation((ids: readonly string[]) => Promise.resolve(ids)),
    ...overrides,
  };
}

/** Resolves to `undefined` — a `Promise<void>` side effect. */
const done = () => vi.fn().mockResolvedValue(null);

function makeDeps(overrides: Partial<Omit<ReconcileDeps<Payload, TombstoneId>, 'tombstones'>> = {}) {
  const deps = {
    durable: true,
    space: SPACE,
    embedText: vi.fn().mockResolvedValue({ vector: [0.1, 0.2, 0.3, 0.4], space: SPACE }),
    upsertPoint: done(),
    deletePoints: done(),
    stores: [] as ReconcileStore<Payload>[],
    ...overrides,
    tombstones: { list: vi.fn().mockResolvedValue([]), remove: done() },
  };
  return deps satisfies ReconcileDeps<Payload, TombstoneId>;
}

function mismatchedRow(overrides: Partial<MismatchedRow<Payload>> = {}): MismatchedRow<Payload> {
  return {
    pointId: 'citm_1',
    vector: [1, 0], // stale 2-dim vector
    payload: { userId: 'u_1', kind: 'item', model: MODEL, dimensions: 2 },
    sourceText: 'Title\n\nBody',
    persistReembedded: done(),
    ...overrides,
  };
}

describe('runVectorReconciliation — Phase A (tombstone drain)', () => {
  it('deletes the tombstoned points, then removes the drained rows', async () => {
    const deps = makeDeps();
    deps.tombstones.list.mockResolvedValue([
      { id: 'vtmb_1', pointId: 'citm_gone' },
      { id: 'vtmb_2', pointId: 'schk_gone' },
      // Duplicate point id (chunk replace racing a cascade) — erased once.
      { id: 'vtmb_3', pointId: 'schk_gone' },
    ]);

    const counts = await runVectorReconciliation(deps);

    expect(deps.deletePoints).toHaveBeenCalledWith(['citm_gone', 'schk_gone']);
    expect(deps.tombstones.remove).toHaveBeenCalledWith(['vtmb_1', 'vtmb_2', 'vtmb_3']);
    expect(counts.tombstonesDrained).toBe(3);
    expect(counts.failed).toBe(0);
  });

  it('stops the run on a dead index: tombstones retained, no embedding work', async () => {
    const listMismatched = vi.fn();
    const deps = makeDeps({
      deletePoints: vi.fn().mockResolvedValue(outage('qdrant down')),
      stores: [makeStore({ listMismatched })],
    });
    deps.tombstones.list.mockResolvedValue([{ id: 'vtmb_1', pointId: 'citm_gone' }]);

    const counts = await runVectorReconciliation(deps);

    expect(deps.tombstones.remove).not.toHaveBeenCalled();
    expect(listMismatched).not.toHaveBeenCalled();
    expect(deps.embedText).not.toHaveBeenCalled();
    expect(deps.upsertPoint).not.toHaveBeenCalled();
    expect(counts).toMatchObject({
      tombstonesDrained: 0,
      reembedded: 0,
      reupserted: 0,
      failed: 1,
      phaseAError: 'test failed because the vector store is unavailable: qdrant down',
    });
  });

  it('ERASURE FIX 1: never acknowledges a tombstone against a non-durable index', async () => {
    const listCurrent = vi.fn().mockResolvedValue([]);
    const deps = makeDeps({ durable: false, stores: [makeStore({ listCurrent })] });
    deps.tombstones.list.mockResolvedValue([
      { id: 'vtmb_1', pointId: 'citm_gone' },
      { id: 'vtmb_2', pointId: 'schk_gone' },
    ]);

    const counts = await runVectorReconciliation(deps);

    // Nothing deleted, nothing acked: the outbox keeps the rows for a durable index.
    expect(deps.deletePoints).not.toHaveBeenCalled();
    expect(deps.tombstones.remove).not.toHaveBeenCalled();
    expect(counts.tombstonesDrained).toBe(0);
    expect(counts.tombstonesSkipped).toBe(2);
    // Phase B still runs against the non-durable index.
    expect(listCurrent).toHaveBeenCalled();
  });
});

describe('runVectorReconciliation — Phase B1 (dimension migration)', () => {
  it('re-embeds a mismatched row, persists observed dims, and upserts with the payload', async () => {
    const row = mismatchedRow({
      pointId: 'schk_1',
      sourceText: 'Section\nChunk text',
      payload: {
        userId: 'u_1',
        kind: 'chunk',
        model: 'old-model',
        dimensions: 2,
        itemDate: 1_750_000_000_000,
        contentType: 'newsletter',
        sourceId: 'nsrc_1',
      },
    });
    const deps = makeDeps({ stores: [makeStore({ listMismatched: vi.fn().mockResolvedValue([row]) })] });

    const counts = await runVectorReconciliation(deps);

    expect(deps.embedText).toHaveBeenCalledWith('Section\nChunk text');
    // Postgres persisted BEFORE the index upsert (durable truth first).
    expect(row.persistReembedded).toHaveBeenCalledWith([0.1, 0.2, 0.3, 0.4]);
    expect(deps.upsertPoint).toHaveBeenCalledWith('schk_1', [0.1, 0.2, 0.3, 0.4], {
      userId: 'u_1',
      kind: 'chunk',
      model: MODEL, // the space's model, not the stale row model
      dimensions: 4, // observed vector.length
      space: spaceId(SPACE), // which space the point is now in
      itemDate: 1_750_000_000_000,
      contentType: 'newsletter',
      sourceId: 'nsrc_1',
    });
    expect(counts).toMatchObject({ reembedded: 1, reupserted: 0, failed: 0 });
  });

  it('persists but does not index a re-embedded vector whose dims still disagree with the collection', async () => {
    const row = mismatchedRow();
    const deps = makeDeps({
      embedText: vi.fn().mockResolvedValue({ vector: [1, 0, 0], space: SPACE }),
      stores: [makeStore({ listMismatched: vi.fn().mockResolvedValue([row]) })],
    });

    const counts = await runVectorReconciliation(deps);

    expect(row.persistReembedded).toHaveBeenCalledWith([1, 0, 0]);
    expect(deps.upsertPoint).not.toHaveBeenCalled();
    expect(counts).toMatchObject({ reembedded: 0, failed: 1 });
  });

  it('re-embedded points record the space of the vector, including a revision learned on the first call', async () => {
    // `deps.space` was read before any call; Ollama only knows its digest after the first one.
    const learned = { ...SPACE, revision: 'sha256:abc' };
    const deps = makeDeps({
      embedText: vi.fn().mockResolvedValue({ vector: [0.1, 0.2, 0.3, 0.4], space: learned }),
      stores: [makeStore({ listMismatched: vi.fn().mockResolvedValue([mismatchedRow()]) })],
    });

    await runVectorReconciliation(deps);

    expect(deps.upsertPoint).toHaveBeenCalledWith(
      'citm_1',
      [0.1, 0.2, 0.3, 0.4],
      expect.objectContaining({ model: MODEL, space: spaceId(learned) }),
    );
  });

  it('the collection dimension is the space dimension: a vector of another size is persisted, never indexed', async () => {
    const row = mismatchedRow();
    const deps = makeDeps({
      space: { ...SPACE, dimensions: 3 },
      stores: [makeStore({ listMismatched: vi.fn().mockResolvedValue([row]) })],
    });

    const counts = await runVectorReconciliation(deps);

    expect(deps.upsertPoint).not.toHaveBeenCalled();
    expect(counts).toMatchObject({ reembedded: 0, failed: 1 });
  });

  it('an embed failure value counts the row as failed and persists nothing for it', async () => {
    const refused = mismatchedRow({ pointId: 'citm_refused' });
    const fine = mismatchedRow({ pointId: 'citm_fine' });
    const embedText = vi.fn<ReconcileDeps<Payload, TombstoneId>['embedText']>();
    embedText.mockResolvedValueOnce(ModelUnavailable({ model: MODEL, reason: 'unreachable' }));
    embedText.mockResolvedValueOnce({ vector: [0.1, 0.2, 0.3, 0.4], space: SPACE });
    const deps = makeDeps({
      embedText,
      stores: [makeStore({ listMismatched: vi.fn().mockResolvedValue([refused, fine]) })],
    });

    const counts = await runVectorReconciliation(deps);

    expect(refused.persistReembedded).not.toHaveBeenCalled();
    expect(deps.upsertPoint).toHaveBeenCalledTimes(1);
    expect(counts).toMatchObject({ reembedded: 1, failed: 1 });
  });

  it('counts an upsert outage as a failed row and keeps reconciling the rest', async () => {
    const bad = mismatchedRow({ pointId: 'citm_bad' });
    const good = mismatchedRow({ pointId: 'citm_good' });
    const deps = makeDeps({
      upsertPoint: vi.fn().mockResolvedValueOnce(outage('timeout')).mockResolvedValue(null),
      stores: [makeStore({ listMismatched: vi.fn().mockResolvedValue([bad, good]) })],
    });

    const counts = await runVectorReconciliation(deps);

    expect(counts).toMatchObject({ reembedded: 1, failed: 1 });
    expect(deps.upsertPoint).toHaveBeenCalledWith('citm_good', expect.anything(), expect.anything());
  });

  it('does not swallow a dep that throws: a bug ends the run instead of counting as an outage', async () => {
    // WHY: a thrown error is a defect. Counting it as `failed` would hide a bug behind an outage counter.
    const deps = makeDeps({
      upsertPoint: vi.fn().mockRejectedValue(new TypeError('undefined is not a function')),
      stores: [makeStore({ listMismatched: vi.fn().mockResolvedValue([mismatchedRow()]) })],
    });

    await expect(runVectorReconciliation(deps)).rejects.toThrow('undefined is not a function');
  });

  it('skips a store whose rows cannot be listed (outage) and reconciles the next store', async () => {
    const down = makeStore({ name: 'down', listMismatched: vi.fn().mockResolvedValue(outage('db down')) });
    const up = makeStore({ name: 'up', listMismatched: vi.fn().mockResolvedValue([mismatchedRow()]) });
    const deps = makeDeps({ stores: [down, up] });

    const counts = await runVectorReconciliation(deps);

    expect(counts).toMatchObject({ reembedded: 1, failed: 1 });
  });
});

describe('runVectorReconciliation — Phase B2 (missing-point re-upsert)', () => {
  it('re-upserts current rows as-is without any embedding call (idempotent heal)', async () => {
    const row: ReconcileRow<Payload> = {
      pointId: 'hlgt_1',
      vector: [0.5, 0.5, 0, 0],
      payload: { userId: 'u_1', kind: 'highlight', model: MODEL, dimensions: 4 },
    };
    const deps = makeDeps({ stores: [makeStore({ listCurrent: vi.fn().mockResolvedValue([row]) })] });

    const counts = await runVectorReconciliation(deps);

    expect(deps.embedText).not.toHaveBeenCalled();
    expect(deps.upsertPoint).toHaveBeenCalledWith('hlgt_1', [0.5, 0.5, 0, 0], {
      userId: 'u_1',
      kind: 'highlight',
      model: MODEL,
      dimensions: 4,
    });
    expect(counts).toMatchObject({ reembedded: 0, reupserted: 1, failed: 0 });
  });

  it('ERASURE FIX 2: after upserting a batch, deletes the points whose rows are no longer current', async () => {
    const rows: ReconcileRow<Payload>[] = ['hlgt_a', 'hlgt_b', 'hlgt_c'].map(pointId => ({
      pointId,
      vector: [0, 0, 0, 1],
      payload: { userId: 'u_1', kind: 'highlight', model: MODEL, dimensions: 4 },
    }));
    // `hlgt_b` was archived between paging and upsert: only a and c still qualify.
    const stillCurrent = vi.fn().mockResolvedValue(['hlgt_a', 'hlgt_c']);
    const deps = makeDeps({ stores: [makeStore({ listCurrent: vi.fn().mockResolvedValue(rows), stillCurrent })] });

    const counts = await runVectorReconciliation(deps);

    expect(stillCurrent).toHaveBeenCalledWith(['hlgt_a', 'hlgt_b', 'hlgt_c']);
    expect(deps.deletePoints).toHaveBeenCalledWith(['hlgt_b']);
    expect(counts).toMatchObject({ reupserted: 3, retracted: 1, failed: 0 });
  });

  it('ERASURE FIX 2: when the re-check itself fails, retracts the whole batch (a revived orphan has no tombstone to find it later)', async () => {
    const rows: ReconcileRow<Payload>[] = ['hlgt_a', 'hlgt_b'].map(pointId => ({
      pointId,
      vector: [0, 0, 0, 1],
      payload: { userId: 'u_1', kind: 'highlight', model: MODEL, dimensions: 4 },
    }));
    const stillCurrent = vi.fn().mockResolvedValue(outage('connection reset'));
    const deps = makeDeps({ stores: [makeStore({ listCurrent: vi.fn().mockResolvedValue(rows), stillCurrent })] });

    const counts = await runVectorReconciliation(deps);

    // Rows that still qualify are re-upserted by the next run; a deleted row's point is gone for good.
    expect(deps.deletePoints).toHaveBeenCalledWith(['hlgt_a', 'hlgt_b']);
    expect(counts).toMatchObject({ reupserted: 2, retracted: 2, failed: 0 });
  });

  it('ERASURE FIX 2 also covers the re-embed leg, and skips the re-check when nothing was upserted', async () => {
    const row = mismatchedRow({ pointId: 'citm_1' });
    const stillCurrent = vi.fn().mockResolvedValue([]);
    const emptyStore = makeStore({ name: 'empty' });
    const deps = makeDeps({
      stores: [makeStore({ listMismatched: vi.fn().mockResolvedValue([row]), stillCurrent }), emptyStore],
    });

    const counts = await runVectorReconciliation(deps);

    expect(deps.deletePoints).toHaveBeenCalledWith(['citm_1']);
    expect(counts).toMatchObject({ reembedded: 1, retracted: 1 });
    expect(emptyStore.stillCurrent).not.toHaveBeenCalled();
  });
});

describe('runVectorReconciliation — row budget', () => {
  it('caps the total rows visited per run across stores and legs (mismatches first)', async () => {
    const mismatches = [mismatchedRow({ pointId: 'citm_1' }), mismatchedRow({ pointId: 'citm_2' })];
    const firstStore = makeStore({
      name: 'first',
      listMismatched: vi.fn().mockImplementation((limit: number) => Promise.resolve(mismatches.slice(0, limit))),
    });
    const listCurrentSecond = vi.fn().mockImplementation((limit: number) =>
      Promise.resolve(
        Array.from({ length: limit }, (_, index) => ({
          pointId: `schk_${index}`,
          vector: [0, 0, 0, 1],
          payload: { userId: 'u_1', kind: 'chunk', model: MODEL, dimensions: 4 },
        })),
      ),
    );
    const secondStore = makeStore({ name: 'second', listCurrent: listCurrentSecond });

    const deps = makeDeps({ stores: [firstStore, secondStore] });
    const counts = await runVectorReconciliation(deps, { rowCap: 3 });

    // 2 mismatches consumed budget first; only 1 slot left for re-upserts.
    expect(counts.reembedded).toBe(2);
    expect(counts.reupserted).toBe(1);
    expect(listCurrentSecond).toHaveBeenCalledWith(1);
  });
});

describe('runVectorReconciliation — spans', () => {
  const exporter = new InMemorySpanExporter();
  beforeAll(() => {
    trace.setGlobalTracerProvider(new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] }));
  });
  afterEach(() => {
    exporter.reset();
  });
  afterAll(() => {
    trace.disable();
  });

  it('records an ai.reconcile span with the counts of the run', async () => {
    const row: ReconcileRow<Payload> = {
      pointId: 'hlgt_a',
      vector: [0, 0, 0, 1],
      payload: { userId: 'u_1', kind: 'highlight', model: MODEL, dimensions: 4 },
    };
    const deps = makeDeps({ stores: [makeStore({ listCurrent: vi.fn().mockResolvedValue([row]) })] });

    await runVectorReconciliation(deps);

    const [span] = exporter.getFinishedSpans();
    expect(span?.name).toBe('ai.reconcile');
    expect(span?.instrumentationScope.name).toBe('@arki/ai');
    expect(span?.attributes['ai.reconcile.reupserted']).toBe(1);
    expect(span?.status.code).not.toBe(2);
  });

  it('marks the span failed with the outage code when the index is down', async () => {
    const deps = makeDeps({ deletePoints: vi.fn().mockResolvedValue(outage('qdrant down')) });
    deps.tombstones.list.mockResolvedValue([{ id: 'vtmb_1', pointId: 'citm_gone' }]);

    await runVectorReconciliation(deps);

    const [span] = exporter.getFinishedSpans();
    expect(span?.status.code).toBe(2);
    expect(span?.attributes['failure.code']).toBe('ai.vector_store_unavailable');
  });

  it('marks the span failed as a defect and rethrows when a dep throws', async () => {
    const deps = makeDeps();
    deps.tombstones.list.mockRejectedValue(new TypeError('bug'));

    await expect(runVectorReconciliation(deps)).rejects.toThrow('bug');

    const [span] = exporter.getFinishedSpans();
    expect(span?.status.code).toBe(2);
    expect(span?.attributes['failure.code']).toBe('failure.unexpected_defect');
  });
});
