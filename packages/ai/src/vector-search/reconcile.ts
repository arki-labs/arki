/**
 * Steady-state vector reconciler for a Postgres → vector index mirror.
 *
 * One cron, two phases, runs indefinitely:
 *
 *   Phase A — TOMBSTONE DRAIN (erasure heal, always first): delete the points
 *   whose delete-sync fast path failed, then remove the outbox rows. A throw
 *   here stops the whole run — a dead index would fail every upsert below, so
 *   no embedding work is burned on it. Tombstones are ACKNOWLEDGED ONLY WHEN
 *   THE INDEX IS DURABLE: against an in-memory index a "deleted" point proves
 *   nothing about the durable one, so the phase is skipped and counted, and
 *   the rows wait for a durable index.
 *
 *   Phase B — DIMENSION MIGRATION + MISSING-POINT RE-UPSERT: page durable rows
 *   per store, in the order the app lists its stores. A row whose stored
 *   vector length ≠ the collection dimension is re-embedded from its source
 *   text and persisted with OBSERVED dims; a current row is re-upserted as-is
 *   (idempotent — heals points lost to dual-write failures). The mismatch
 *   predicate shrinks to zero as rows migrate, so early runs are the backfill
 *   and later runs are the reconciler — same code path.
 *
 *   UPSERT, THEN RE-CHECK. The delete side commits the row delete (and its
 *   tombstone) BEFORE it removes the point. So a row paged here may be deleted
 *   or archived while its point is being (re-)upserted — and the fast-path
 *   delete may already have run, leaving the point resurrected. After each
 *   store batch the runner asks the store which of the upserted ids are
 *   STILL current under the same predicate it pages by, and deletes the
 *   points of the others. Whichever side runs last, the point ends up gone.
 *
 * No cursor state: the mismatch legs drain via their own predicate (a
 * re-embedded row leaves the result set), and the re-upsert leg pages
 * newest-first every run. Only the newest `rowCap` current rows are
 * re-checked per run — the rows most likely to have missed their dual-write.
 *
 * The runner takes injected deps so tests exercise the decision logic without
 * a database; the app builds the real store-backed deps.
 *
 * OUTAGE OR BUG. A dep that cannot reach its backend (the vector index, the database) RETURNS a
 * `VectorStoreUnavailable`: the run counts it as `failed` and the next tick tries again. A dep that
 * THROWS has a bug: the run does not swallow it, so the cron fails loudly instead of reporting a
 * defect as an outage.
 */
import type { EmbeddingSpace, EmbedFailure } from '@arki/embeddings';
import { spaceId } from '@arki/embeddings';
import { isFailure } from '@arki/failure';

import { debugVector } from '../debug.ts';
import { VectorStoreUnavailable } from '../failures.ts';
import { failSpan, observeAi } from '../observe.ts';

// ── Batch caps (sized to fit under a 5-minute cron tick) ────

/** Max tombstones drained per run (Phase A). */
export const TOMBSTONE_CAP_PER_RUN = 200;
/** Max durable rows visited per run, total across stores and legs (Phase B). */
export const ROW_CAP_PER_RUN = 50;

// ── Contracts ───────────────────────────────────────────────

/** What a dep gives back: its value, or the outage that kept it from getting it. A bug is thrown, not returned. */
export type OrUnavailable<T> = T | VectorStoreUnavailable;

/**
 * The payload fields the runner owns: which model made the vector, its observed length, and (on a
 * point the runner re-embedded) the `spaceId` of the space it was embedded in.
 */
export type VectorPointPayload = { model: string; dimensions: number; space?: string };

/** A durable row mirrored (or to be mirrored) as one point. */
export type ReconcileRow<P extends VectorPointPayload> = {
  /** Point id — the source row id. */
  pointId: string;
  /** The stored vector from the durable row. */
  vector: number[];
  /** The point payload as the store records it. */
  payload: P;
};

/** A mismatched row additionally knows how to re-embed + persist itself. */
export type MismatchedRow<P extends VectorPointPayload> = ReconcileRow<P> & {
  /** Source text re-embedded on dimension mismatch (write-path parity). */
  sourceText: string;
  /** Persist the re-embedded vector (+ observed dims) on the durable row(s). */
  persistReembedded: (vector: number[]) => Promise<OrUnavailable<void>>;
};

export type ReconcileStore<P extends VectorPointPayload> = {
  name: string;
  /** Rows whose stored vector length ≠ the collection dimension. */
  listMismatched: (limit: number) => Promise<OrUnavailable<MismatchedRow<P>[]>>;
  /** Current-dimension rows, newest first, for the idempotent re-upsert leg. */
  listCurrent: (limit: number) => Promise<OrUnavailable<ReconcileRow<P>[]>>;
  /**
   * Of these point ids, the ones whose row still qualifies under the SAME
   * predicate `listMismatched` / `listCurrent` page by (an archived or deleted
   * row is NOT current). The runner deletes the points of the rest.
   */
  stillCurrent: (pointIds: readonly string[]) => Promise<OrUnavailable<readonly string[]>>;
};

/** The erasure outbox: one row per point to delete, acknowledged by exact id. */
export type TombstoneStore<TId extends string = string> = {
  /** Oldest first (drain order). */
  list: (limit: number) => Promise<OrUnavailable<{ id: TId; pointId: string }[]>>;
  /** Remove the acknowledged tombstones by id. */
  remove: (ids: readonly TId[]) => Promise<OrUnavailable<void>>;
};

export type ReconcileDeps<P extends VectorPointPayload, TId extends string = string> = {
  /** Whether points in this index outlive the process (`VectorIndex.durable`). Gates Phase A. */
  durable: boolean;
  /** The space the index holds: `space.dimensions` is the collection dimension. */
  space: EmbeddingSpace;
  /**
   * Embed one document text (no query instruction on documents), with the space the vector came
   * from. That space's `model` and `spaceId` are recorded on the point, so a revision the embedder
   * learned on this call is part of it. A failure counts the row as failed.
   */
  embedText: (text: string) => Promise<{ vector: number[]; space: EmbeddingSpace } | EmbedFailure>;
  upsertPoint: (pointId: string, vector: number[], payload: P) => Promise<OrUnavailable<void>>;
  deletePoints: (pointIds: readonly string[]) => Promise<OrUnavailable<void>>;
  tombstones: TombstoneStore<TId>;
  /** Durable stores in drain order. */
  stores: readonly ReconcileStore<P>[];
};

export type ReconcileCounts = {
  tombstonesDrained: number;
  /** Tombstones seen but NOT acknowledged because the index is not durable. */
  tombstonesSkipped: number;
  reembedded: number;
  reupserted: number;
  /** Points deleted after upsert because their row was no longer current. */
  retracted: number;
  failed: number;
  /** The message of the outage that stopped Phase A — the run ended there. */
  phaseAError?: string;
};

export type ReconcileCaps = { tombstoneCap?: number; rowCap?: number };

// ── Phase runner (pure over the injected deps) ───────────────

/**
 * Run one reconciliation tick inside an `ai.reconcile` span. The span is marked failed with the
 * code of the first failure of the tick (an outage, or a refused embed); the counts are attributes.
 */
export function runVectorReconciliation<P extends VectorPointPayload, TId extends string>(
  deps: ReconcileDeps<P, TId>,
  caps: ReconcileCaps = {},
): Promise<ReconcileCounts> {
  return observeAi('ai.reconcile', async span => {
    let firstFailureCode: string | undefined;
    const counts = await reconcile(deps, caps, code => {
      firstFailureCode ??= code;
    });
    span.setAttributes({
      'ai.reconcile.tombstones_drained': counts.tombstonesDrained,
      'ai.reconcile.reembedded': counts.reembedded,
      'ai.reconcile.reupserted': counts.reupserted,
      'ai.reconcile.retracted': counts.retracted,
      'ai.reconcile.failed': counts.failed,
    });
    if (firstFailureCode !== undefined) failSpan(span, firstFailureCode);
    return counts;
  });
}

async function reconcile<P extends VectorPointPayload, TId extends string>(
  deps: ReconcileDeps<P, TId>,
  caps: ReconcileCaps,
  onFailure: (code: string) => void,
): Promise<ReconcileCounts> {
  const tombstoneCap = caps.tombstoneCap ?? TOMBSTONE_CAP_PER_RUN;
  const rowCap = caps.rowCap ?? ROW_CAP_PER_RUN;

  const counts: ReconcileCounts = {
    tombstonesDrained: 0,
    tombstonesSkipped: 0,
    reembedded: 0,
    reupserted: 0,
    retracted: 0,
    failed: 0,
  };

  /** Count one failed unit of work and tell the span. */
  function recordFailure(failure: { code: string }, units: number): void {
    counts.failed += units;
    onFailure(failure.code);
  }

  // ── Phase A: tombstone drain — first, and gating ──
  const tombstones = await deps.tombstones.list(tombstoneCap);
  if (isFailure(tombstones)) {
    // The outbox cannot be read: nothing below can be trusted to be erasure-safe. Stop the run.
    recordFailure(tombstones, 1);
    counts.phaseAError = tombstones.message;
    debugVector.debug('[Reconcile] tombstone list failed — stopping the run: {error}', { error: tombstones.message });
    return counts;
  }
  if (tombstones.length > 0 && !deps.durable) {
    // A non-durable index cannot prove an erasure. Keep the rows; count them.
    counts.tombstonesSkipped = tombstones.length;
    debugVector.debug('[Reconcile] index not durable — {count} tombstones kept, none acknowledged', {
      count: tombstones.length,
    });
  } else if (tombstones.length > 0) {
    // Two delete-sync sites may have tombstoned the same point — delete each once.
    const pointIds = [...new Set(tombstones.map(t => t.pointId))];
    const deleted = await deps.deletePoints(pointIds);
    if (isFailure(deleted)) {
      // The index is unreachable: every upsert below would fail too, so stop
      // the run instead of burning embedding work. The rows stay for the next tick.
      recordFailure(deleted, tombstones.length);
      counts.phaseAError = deleted.message;
      debugVector.debug('[Reconcile] tombstone drain failed — stopping the run ({count} points): {error}', {
        count: pointIds.length,
        error: deleted.message,
      });
      return counts;
    }
    const removed = await deps.tombstones.remove(tombstones.map(t => t.id));
    if (isFailure(removed)) {
      // The points are gone but the rows are not acknowledged: the next tick deletes them again (idempotent).
      recordFailure(removed, tombstones.length);
      counts.phaseAError = removed.message;
      return counts;
    }
    counts.tombstonesDrained = tombstones.length;
  }

  /**
   * Upsert, then re-check: delete the points whose rows stopped being current
   * meanwhile. When the re-check itself fails, the whole batch is retracted: a
   * revived point for a deleted row has no tombstone, so no later run would
   * find it, while a row that still qualifies is simply re-upserted next run.
   */
  async function retractStale(store: ReconcileStore<P>, upsertedIds: string[]): Promise<void> {
    if (upsertedIds.length === 0) return;
    const stillCurrent = await store.stillCurrent(upsertedIds);
    let current: ReadonlySet<string>;
    if (isFailure(stillCurrent)) {
      current = new Set();
      debugVector.debug('[Reconcile] post-upsert re-check failed for store {store}, retracting the batch: {error}', {
        store: store.name,
        error: stillCurrent.message,
      });
    } else {
      current = new Set(stillCurrent);
    }
    const stale = upsertedIds.filter(id => !current.has(id));
    if (stale.length === 0) return;
    const deleted = await deps.deletePoints(stale);
    if (isFailure(deleted)) {
      recordFailure(deleted, stale.length);
      debugVector.debug('[Reconcile] retracting {count} stale points failed for store {store}: {error}', {
        count: stale.length,
        store: store.name,
        error: deleted.message,
      });
      return;
    }
    counts.retracted += stale.length;
  }

  // ── Phase B1: dimension-migration drain (store order) ──
  let budget = rowCap;
  for (const store of deps.stores) {
    if (budget <= 0) break;
    const rows = await store.listMismatched(budget);
    if (isFailure(rows)) {
      recordFailure(rows, 1);
      debugVector.debug('[Reconcile] listing mismatched rows failed for store {store}: {error}', {
        store: store.name,
        error: rows.message,
      });
      continue;
    }
    budget -= rows.length;
    const upserted: string[] = [];

    for (const row of rows) {
      const embedded = await deps.embedText(row.sourceText);
      if (isFailure(embedded)) {
        recordFailure(embedded, 1);
        debugVector.debug('[Reconcile] re-embed refused ({store}/{pointId}): {code}', {
          store: store.name,
          pointId: row.pointId,
          code: embedded.code,
        });
        continue;
      }
      const { vector } = embedded;
      // Durable row first: observed dims are the truth even when the index
      // upsert fails afterwards (the re-upsert leg heals the point later).
      const persisted = await row.persistReembedded(vector);
      if (isFailure(persisted)) {
        recordFailure(persisted, 1);
        debugVector.debug('[Reconcile] persisting the re-embedded vector failed ({store}/{pointId}): {error}', {
          store: store.name,
          pointId: row.pointId,
          error: persisted.message,
        });
        continue;
      }

      if (vector.length !== deps.space.dimensions) {
        // Model/config disagreement: the collection would reject this
        // vector — surface it instead of silently indexing garbage.
        counts.failed++;
        debugVector.debug(
          '[Reconcile] re-embedded vector has unexpected dimensions ({store}/{pointId}): {observed} vs {expected} — check EMBEDDING_DIMENSIONS',
          { store: store.name, pointId: row.pointId, observed: vector.length, expected: deps.space.dimensions },
        );
        continue;
      }

      const indexed = await deps.upsertPoint(row.pointId, vector, {
        ...row.payload,
        model: embedded.space.model,
        dimensions: vector.length,
        space: spaceId(embedded.space),
      });
      if (isFailure(indexed)) {
        recordFailure(indexed, 1);
        debugVector.debug('[Reconcile] re-embed upsert failed ({store}/{pointId}): {error}', {
          store: store.name,
          pointId: row.pointId,
          error: indexed.message,
        });
        continue;
      }
      upserted.push(row.pointId);
      counts.reembedded++;
    }
    await retractStale(store, upserted);
  }

  // ── Phase B2: idempotent re-upsert of current rows (missing-point heal) ──
  for (const store of deps.stores) {
    if (budget <= 0) break;
    const rows = await store.listCurrent(budget);
    if (isFailure(rows)) {
      recordFailure(rows, 1);
      debugVector.debug('[Reconcile] listing current rows failed for store {store}: {error}', {
        store: store.name,
        error: rows.message,
      });
      continue;
    }
    budget -= rows.length;
    const upserted: string[] = [];

    for (const row of rows) {
      const indexed = await deps.upsertPoint(row.pointId, row.vector, { ...row.payload, dimensions: row.vector.length });
      if (isFailure(indexed)) {
        recordFailure(indexed, 1);
        debugVector.debug('[Reconcile] re-upsert failed ({store}/{pointId}): {error}', {
          store: store.name,
          pointId: row.pointId,
          error: indexed.message,
        });
        continue;
      }
      upserted.push(row.pointId);
      counts.reupserted++;
    }
    await retractStale(store, upserted);
  }

  return counts;
}
