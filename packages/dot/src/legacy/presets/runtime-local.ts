/**
 * @arki/dot/presets/runtime-local
 *
 * Embedded local-development stack: PGlite (embedded Postgres) + pg-boss
 * (durable queue on PGlite). One binary, no Docker, no Redis, no external services.
 *
 * Use this preset for:
 *   - Solo apps and side projects during development
 *   - The first deploy of a new product before it has earned a managed DB
 *   - Any arki app that wants `bun dev` to boot the full stack in one process
 *
 * When you need to graduate to hosted Postgres + Redis:
 *   - Swap `initDbRuntimeLocal` → `@arki/db/init` (withDb on the Dot builder)
 *   - Swap `createRuntimeLocalQueueInstance` → `q.createQueue({ connection: redisUrl })`
 *   - Apps that only used the portable subset (no BullMQ flows) need no other changes.
 *
 * @example
 * ```ts
 * import { bootRuntimeLocal } from '@arki/dot/presets/runtime-local';
 * import { initQueue } from '@arki/queue/runtime-local';
 * import { relations } from './db/schema.js';
 *
 * const q = initQueue.context<MyContext>().create();
 * export const myJob = q.job.name('my-job').input(z.object({ url: z.string() })).handler(handler);
 *
 * const runtime = await bootRuntimeLocal({
 *   db: { relations, dataDir: './.local/db' },
 *   queue: { registry: q.registry({ myJob }), createContext: () => ({ db: runtime.db }) },
 * });
 *
 * process.on('SIGINT', () => runtime.stop());
 * ```
 */
import type { AnyRelations } from 'drizzle-orm';
import type { PgliteDatabase } from 'drizzle-orm/pglite';
import type { PGlite } from '@electric-sql/pglite';

import { initDbRuntimeLocal, type PgliteInitOptions } from '@arki/db/runtime-local';
import { createRuntimeLocalQueueInstance } from '@arki/queue/runtime-local';
import type { QueueInstance } from '@arki/queue/types';

export type BootRuntimeLocalConfig<TRelations extends AnyRelations, TContext> = {
  db: PgliteInitOptions & {
    /** Drizzle relations object produced by defineRelations(). */
    relations: TRelations;
  };
  queue: {
    /** Jobs/schedules registry built with q.registry(). */
    registry: Record<string, unknown>;
    /** Factory that produces the context passed to job handlers. Called per job execution. */
    createContext: () => TContext | Promise<TContext>;
    /** pg-boss schema name. Defaults to 'infra_pg_boss'. */
    schema?: string;
  };
};

export type RuntimeLocalHandle<TRelations extends AnyRelations> = {
  /** PGlite instance — shared by Drizzle and pg-boss. */
  pglite: PGlite;
  /** Drizzle database handle. Use this in your app's db layer. */
  db: PgliteDatabase<TRelations>;
  /** Queue instance — call queue.register() / queue.start() / queue.stop(). */
  queue: QueueInstance;
  /** Gracefully stop queue workers and close PGlite. Call on SIGINT/SIGTERM. */
  stop: () => Promise<void>;
};

/**
 * Boot the embedded runtime-local stack.
 *
 * Order: PGlite ready → pg-boss schema bootstrap → PgBoss start → workers registered.
 * The returned handle's `stop()` reverses this in the correct order.
 */
export async function bootRuntimeLocal<TRelations extends AnyRelations, TContext>(
  config: BootRuntimeLocalConfig<TRelations, TContext>,
): Promise<RuntimeLocalHandle<TRelations>> {
  // 1. PGlite + Drizzle
  const { db, pglite } = await initDbRuntimeLocal(
    { dataDir: config.db.dataDir, memory: config.db.memory },
    { relations: config.db.relations },
  );

  // 2. Queue instance (schema bootstrap + PgBoss start happen inside queue.start())
  const queue = createRuntimeLocalQueueInstance({
    pglite,
    schema: config.queue.schema,
    createContext: config.queue.createContext,
  });

  // 3. Register jobs/schedules and start workers
  await queue.register(config.queue.registry as Parameters<QueueInstance['register']>[0]);
  await queue.start();

  // 4. Graceful shutdown — stop workers first, then close PGlite
  const stop = async () => {
    await queue.stop();
    await pglite.close();
  };

  // Attach default signal handlers (idempotent — a second SIGINT triggers force-exit)
  let stopping = false;
  const handleSignal = async () => {
    if (stopping) process.exit(1);
    stopping = true;
    console.log('\n[runtime-local] shutting down…');
    await stop();
    process.exit(0);
  };
  process.once('SIGINT', () => void handleSignal());
  process.once('SIGTERM', () => void handleSignal());

  return { pglite, db, queue, stop };
}
