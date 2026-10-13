/**
 * The entry point: `initJournal`, the definition helpers it returns, and
 * `createJournal`, which checks the handlers, builds each part with its
 * dependencies and wires the public methods.
 * May import every other file. No implementation file may import this one.
 */
import { getTableColumns, getTableName, is, lt } from 'drizzle-orm';
import { getTableConfig, PgColumn } from 'drizzle-orm/pg-core';
import { z } from 'zod';

import type { Journal, JournalDefinitions, RootCommandRunner } from './api.js';
import type { EntityBuilder } from './entity.js';
import type { JournalTables } from './pg.js';
import type {
  AnyEntity,
  CommandHookContext,
  DbHandle,
  Effect,
  EffectHookContext,
  EntityTable,
  IdTable,
  KeyName,
  Projection,
  RootDb,
  SingleKey,
  Tap,
  TransactionSource,
} from './types.js';
import { createCommandRunner } from './command.js';
import { defineEntity } from './entity.js';
import { JournalError } from './errors.js';
import { defineEvent } from './event.js';
import { bindEffect, bindTap, defineProjection, effectFor, tapFor } from './handlers.js';
import { createHistory } from './history.js';
import { createHookPoint } from './hooks.js';
import {
  createAdmin,
  createCatchUp,
  createDrain,
  createStrandedJobs,
  createTapDispatch,
  createWorkers,
} from './worker.js';
import { createWriter } from './write.js';

const emptyMeta = z.object({});
type EmptyMeta = typeof emptyMeta;

function initFor<Tx extends TransactionSource<Tx>, AppDb extends RootDb>() {
  function init(): JournalDefinitions<EmptyMeta, Tx, AppDb>;
  function init<Meta extends z.ZodObject>(options: { readonly meta: Meta }): JournalDefinitions<Meta, Tx, AppDb>;
  function init<Meta extends z.ZodObject>(options?: {
    readonly meta?: Meta;
  }): JournalDefinitions<Meta, Tx, AppDb> | JournalDefinitions<EmptyMeta, Tx, AppDb> {
    return options?.meta === undefined
      ? createInit<EmptyMeta, Tx, AppDb>(emptyMeta)
      : createInit<Meta, Tx, AppDb>(options.meta);
  }
  return init;
}

/**
 * `initJournal({ meta })` types `write`'s `tx`, `events`' `{ tx }` and
 * projection handlers with the structural `DbHandle`. `initJournal.tx<AppTx>()
 * .create({ meta })` uses the app's own Drizzle transaction type instead, so
 * repositories typed against it fit. `initJournal.db<AppDb>()` names the
 * app's root database type: effects get it as `ctx.db`, and `drain` and
 * `worker` then need it. Both are type-only steps and chain in either order.
 */
export const initJournal = Object.assign(initFor<DbHandle, RootDb>(), {
  tx: <Tx extends TransactionSource<Tx>>() => ({
    create: initFor<Tx, RootDb>(),
    db: <AppDb extends RootDb>() => ({ create: initFor<Tx, AppDb>() }),
  }),
  db: <AppDb extends RootDb>() => ({
    create: initFor<DbHandle, AppDb>(),
    tx: <Tx extends TransactionSource<Tx>>() => ({ create: initFor<Tx, AppDb>() }),
  }),
});

/** A table with a column called `id`. The check is real; the guard narrows to `IdTable`. */
function hasIdColumn<Tbl extends EntityTable>(table: Tbl): table is Tbl & IdTable {
  const columns: Record<string, unknown> = getTableColumns(table);
  return is(columns.id, PgColumn);
}

function createInit<Meta extends z.ZodObject, Tx extends TransactionSource<Tx>, AppDb extends RootDb>(
  metaSchema: Meta,
): JournalDefinitions<Meta, Tx, AppDb> {
  type MetaOut = z.output<Meta>;
  function entity<K extends string, Tbl extends IdTable>(
    kind: K,
    table: Tbl,
  ): EntityBuilder<K, Tbl, never, MetaOut, 'id'>;
  function entity<K extends string, Tbl extends EntityTable, Key extends KeyName<Tbl>>(
    kind: K,
    table: Tbl,
    options: { readonly key: Key & SingleKey<Key> },
  ): EntityBuilder<K, Tbl, never, MetaOut, Key>;
  function entity<K extends string, Tbl extends EntityTable>(kind: K, table: Tbl, options?: { readonly key: string }) {
    if (options !== undefined) {
      return defineEntity<K, Tbl, MetaOut, string>(kind, table, options.key);
    }
    if (!hasIdColumn(table)) {
      throw new JournalError(
        'BAD_DEFINITION',
        'entity',
        kind,
        `journal: entity "${kind}": table "${getTableName(table)}" has no "id" column; pass { key: 'columnName' }`,
      );
    }
    return defineEntity<K, Tbl, MetaOut, 'id'>(kind, table, 'id');
  }
  return {
    event: defineEvent,
    entity,
    command: (name, input, handler) => ({ name, input, handler }),
    projection: (name, entity, on, opts) => defineProjection(name, entity, on, opts),
    effect: effectFor<MetaOut, AppDb, RootCommandRunner<Meta, Tx>>(),
    tap: tapFor<MetaOut, AppDb>(),
    compose: config => {
      const effects = (config.effects ?? []).map(effect => bindEffect(effect, config.services ?? {}));
      const taps = (config.taps ?? []).map(tap => bindTap(tap, config.services ?? {}));
      return createJournal<Meta, Tx, AppDb>(metaSchema, config.tables, config.projections ?? [], effects, taps);
    },
  };
}

/** Throws when two handlers of one kind share a name: the second would silently replace the first. */
function assertUniqueNames(
  kind: 'effect' | 'projection' | 'tap',
  handlers: readonly { readonly name: string }[],
): void {
  const seen = new Set<string>();
  for (const { name } of handlers) {
    if (seen.has(name))
      throw new JournalError('BAD_DEFINITION', kind, name, `journal: duplicate ${kind} name "${name}"`);
    seen.add(name);
  }
}

function createJournal<Meta extends z.ZodObject, Tx extends TransactionSource<Tx>, AppDb extends RootDb>(
  metaSchema: Meta,
  tables: JournalTables,
  projections: readonly Projection<z.output<Meta>, Tx>[],
  effects: readonly Effect<z.output<Meta>, AppDb, RootCommandRunner<Meta, Tx>>[],
  taps: readonly Tap<z.output<Meta>, AppDb>[] = [],
): Journal<Meta, Tx, AppDb> {
  assertUniqueNames('tap', taps);
  const eventsSchema = getTableConfig(tables.events).schema;
  const wakeChannel = eventsSchema === undefined ? 'journal_wake' : `${eventsSchema}_journal_wake`;
  type MetaOut = z.output<Meta>;

  assertUniqueNames('effect', effects);
  assertUniqueNames('projection', projections);
  const entitiesByKind = new Map<string, AnyEntity<MetaOut>>();
  for (const handler of [...projections, ...effects]) {
    for (const entity of handler.entities) entitiesByKind.set(entity.kind, entity);
  }

  // `journal.drain`, `journal.wake` and `journal.run` are read from the journal object on each
  // call, so the worker loop, `run`, a bound runner and an effect's `ctx.run` always use the methods the object holds.
  const history = createHistory<Meta>({ metaSchema, tables });
  const inlineProjections = projections.filter(projection => projection.lane === 'inline');
  const asyncProjections = projections.filter(projection => projection.lane === 'async');
  const { write, adopt, writeWithValidatedMeta } = createWriter<Meta, Tx>({
    metaSchema,
    tables,
    projections: inlineProjections,
    asyncProjections,
    effects,
    history,
    wakeChannel,
  });
  const commandHooks = createHookPoint<CommandHookContext<z.output<Meta>>>('command');
  const effectHooks = createHookPoint<EffectHookContext<z.output<Meta>>>('effect');
  const run = createCommandRunner<Meta, Tx>({
    metaSchema,
    writeWithValidatedMeta,
    wake: () => journal.wake(),
    hooks: commandHooks,
    tables,
  });
  // The worker's database is also the source of every command an effect runs, so it opens `Tx`.
  type WorkerDb = AppDb & TransactionSource<Tx>;
  const drain = createDrain<Meta, WorkerDb, RootCommandRunner<Meta, Tx>>({
    tables,
    hooks: effectHooks,
    effects,
    history,
    runOn: (db, cause) => (command, input, meta, call) => run(db, command, input, meta, call, cause),
  });
  const catching = createCatchUp<Meta, Tx>({ tables, projections: asyncProjections, history });
  const dispatch = createTapDispatch<Meta, WorkerDb>({ tables, taps, history });
  const workers = createWorkers<WorkerDb>({
    drain: (db, opts) => journal.drain(db, opts),
    catchUp: (db, opts) => journal.catchUp(db, opts),
    dispatch,
    tapNames: taps.map(tap => tap.name),
  });
  const strandedJobs = createStrandedJobs({ tables, effectNames: effects.map(effect => effect.name) });
  const admin = createAdmin({ tables, wake: () => journal.wake() });

  const journal: Journal<Meta, Tx, AppDb> = {
    write: (tx, entity, id, input) => write(tx, entity, id, input),
    adopt: (tx, entity, id, input) => adopt(tx, entity, id, input),
    run: (source, command, input, meta, opts) => run(source, command, input, meta, opts),
    bind: (source, meta, opts) => (command, input, call) =>
      journal.run(source, command, input, meta, { ...opts, ...call }),
    replay: (db, entity, id, opts) => history.replay(db, entity, id, opts),
    verify: (db, entity, id) => history.verify(db, entity, id),
    repair: (db, entity, id) => history.repair(db, entity, id),
    forget: (db, entity, id) => history.forget(db, entity, id),
    pruneReceipts: async (db, opts) => {
      const gone = await db
        .delete(tables.receipts)
        .where(lt(tables.receipts.recordedAt, opts.before))
        .returning({ key: tables.receipts.key });
      return gone.length;
    },
    rerun: (db, projection, opts) => {
      if (projection.lane === 'async')
        throw new JournalError(
          'BAD_DEFINITION',
          'projection',
          projection.name,
          `journal: projection "${projection.name}" is async; use reset and catchUp instead of rerun`,
        );
      return history.rerun(db, projection, opts);
    },
    catchUp: (db, opts) => catching.catchUp(db, opts),
    reset: (db, projection, clear) => catching.reset(db, projection, clear),
    cursors: db => catching.cursors(db),
    drain: (db, opts) => drain(db, opts),
    worker: (db, opts) => workers.worker(db, opts),
    wake: () => workers.wakeAll(),
    strandedJobs: db => strandedJobs(db),
    jobs: (db, opts) => admin.jobs(db, opts),
    retry: (db, jobId) => admin.retry(db, jobId),
    discard: (db, jobId) => admin.discard(db, jobId),
    wakeChannel,
    hooks: { command: commandHooks.point, effect: effectHooks.point },
    catalog: {
      entities: [...entitiesByKind.values()].map(entity => ({
        kind: entity.kind,
        table: getTableName(entity.table),
        events: [...entity.events.keys()],
      })),
      projections: projections.map(projection => projection.name),
      effects: effects.map(effect => effect.name),
      taps: taps.map(tap => tap.name),
    },
  };

  return journal;
}
