/**
 * The entry point: `initJournal`, the definition helpers it returns, and
 * `createJournal`, which checks the handlers, builds each part with its
 * dependencies and wires the public methods.
 * May import every other file. No implementation file may import this one.
 */
import { and, eq, getTableColumns, getTableName, is, isNull, lt } from 'drizzle-orm';
import { getTableConfig, PgColumn } from 'drizzle-orm/pg-core';

import type { SchemaInput, SchemaOutput, StandardSchemaV1 } from '@arki/schema';
import { isFailure } from '@arki/failure';

import type { Journal, JournalDefinitions, RootCommandRunner } from './api.js';
import type { Fence } from './command.js';
import type { EntityBuilder } from './entity.js';
import type { JournalTables } from './pg.js';
import type { JobRetention } from './retention.js';
import type {
  AnyEntity,
  CommandHookContext,
  DbHandle,
  Effect,
  EffectHookContext,
  EntityTable,
  IdTable,
  KeyName,
  Needs,
  Projection,
  RootDb,
  SingleKey,
  Tap,
  TransactionSource,
} from './types.js';
import type { EffectAttempt } from './worker.js';
import { createCommandRunner } from './command.js';
import { debugDrain } from './debug.js';
import { defineEntity } from './entity.js';
import { JournalError } from './errors.js';
import { defineEvent } from './event.js';
import { bindEffect, bindHandlers, bindTap, defineProjection, effectFor, tapFor } from './handlers.js';
import { createHistory } from './history.js';
import { createHookPoint } from './hooks.js';
import { createJobOps } from './outbox.js';
import { trackRefusals } from './refusals.js';
import { assertRetention, effectOverrides, resolveRetention } from './retention.js';
import { isReturnedFailure } from './rollback.js';
import { isPlainObject } from './storage.js';
import { createCatchUp, createDrain, createStrandedJobs, createTapDispatch, createWorkers } from './worker.js';
import { createWorkflowReads } from './workflow/read.js';
import { createWorkflows } from './workflow/runner.js';
import { createWriter } from './write.js';

/**
 * The meta schema when `initJournal` gets none: a plain object in, `{}` out. Other
 * keys are dropped, so nothing unchecked reaches the stored meta.
 */
const emptyMeta: StandardSchemaV1<Record<string, never>, Record<string, never>> = {
  '~standard': {
    version: 1,
    vendor: 'arki',
    validate: value =>
      isPlainObject(value) ? { value: {} } : { issues: [{ message: 'meta must be a plain object' }] },
  },
};
type EmptyMeta = typeof emptyMeta;

function initFor<Tx extends TransactionSource<Tx>, AppDb extends RootDb>() {
  function init(options: {
    readonly tables: JournalTables;
    readonly retention?: JobRetention;
  }): JournalDefinitions<EmptyMeta, Tx, AppDb>;
  function init<Meta extends StandardSchemaV1<unknown, Record<string, unknown>>>(options: {
    readonly tables: JournalTables;
    readonly retention?: JobRetention;
    readonly meta: Meta;
  }): JournalDefinitions<Meta, Tx, AppDb>;
  function init<Meta extends StandardSchemaV1<unknown, Record<string, unknown>>>(options: {
    readonly tables: JournalTables;
    readonly retention?: JobRetention;
    readonly meta?: Meta;
  }): JournalDefinitions<Meta, Tx, AppDb> | JournalDefinitions<EmptyMeta, Tx, AppDb> {
    return options.meta === undefined
      ? createInit<EmptyMeta, Tx, AppDb>(emptyMeta, options.tables, options.retention)
      : createInit<Meta, Tx, AppDb>(options.meta, options.tables, options.retention);
  }
  return init;
}

/**
 * `initJournal({ tables, meta })` types `write`'s `tx`, `events`' `{ tx }` and
 * projection handlers with the structural `DbHandle`. `initJournal.tx<AppTx>()
 * .create({ meta })` uses the app's own Drizzle transaction type instead, so
 * repositories typed against it fit. `initJournal.db<AppDb>()` names the
 * app's root database type: effects get it as `ctx.db`, and `drain` and
 * `worker` then need it. Both are type-only steps and chain in either order.
 * `retention` says how long finished jobs are kept, where they go and how often the sweeper runs. It is the one
 * place for it: archive at ack, the job operations, the sweeper, Foreman and workflow timers all read it.
 * Defaults: completed 7 days, dead 90 days.
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

function createInit<
  Meta extends StandardSchemaV1<unknown, Record<string, unknown>>,
  Tx extends TransactionSource<Tx>,
  AppDb extends RootDb,
>(metaSchema: Meta, tables: JournalTables, retention: JobRetention | undefined): JournalDefinitions<Meta, Tx, AppDb> {
  type MetaOut = SchemaOutput<Meta>;
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
  const command: JournalDefinitions<Meta, Tx, AppDb>['command'] = (name, input, handler, options) => {
    const authorize = options?.authorize;
    if (authorize === undefined) return { name, input, handler };
    // Keeps only a failure, so the command's type holds the failures `authorize` can return.
    const refuse = async (...args: Parameters<typeof authorize>) => {
      const refused = await authorize(...args);
      return isReturnedFailure(refused) ? refused : undefined;
    };
    return { name, input, handler, authorize: refuse };
  };
  const projection: JournalDefinitions<Meta, Tx, AppDb>['projection'] = (name, entity, on, opts) =>
    defineProjection(name, entity, on, opts);
  const effect = effectFor<MetaOut, AppDb, RootCommandRunner<Meta, Tx>>();
  const workflows = createWorkflows<Meta, Tx, AppDb>(
    { event: defineEvent, entity, command, projection, effect },
    tables,
    retention,
  );
  return {
    event: defineEvent,
    entity,
    command,
    projection,
    effect,
    tap: tapFor<MetaOut, AppDb>(),
    workflow: workflows.workflow,
    compose: config => {
      const registered = config.workflows === undefined || config.workflows.length === 0 ? undefined : config.workflows;
      if (registered !== undefined && config.workflowMeta === undefined) {
        throw new JournalError(
          'BAD_DEFINITION',
          'workflow',
          registered[0]?.name ?? '',
          "journal: compose({ workflows }) needs workflowMeta, the meta recorded on the workflow runner's checkpoints, such as { actorId: 'system:workflow' }",
        );
      }
      const runner =
        registered === undefined || config.workflowMeta === undefined
          ? undefined
          : workflows.register(registered, config.workflowMeta);
      // `'worker'`: the handlers keep their needs, and each worker or drain gives the services.
      const services = config.services === 'worker' ? undefined : (config.services ?? {});
      const effects = [...(config.effects ?? []), ...(runner === undefined ? [] : runner.effects)].map(declared =>
        services === undefined ? declared : bindEffect(declared, services),
      );
      const taps = (config.taps ?? []).map(tap => (services === undefined ? tap : bindTap(tap, services)));
      const projections = [...(config.projections ?? []), ...(runner === undefined ? [] : [runner.steps])];
      return createJournal<Meta, Tx, AppDb>(metaSchema, tables, projections, effects, taps, retention, {
        commands: workflows.operate,
        registry: workflows.started,
        meta: config.workflowMeta,
      });
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

function createJournal<
  Meta extends StandardSchemaV1<unknown, Record<string, unknown>>,
  Tx extends TransactionSource<Tx>,
  AppDb extends RootDb,
>(
  metaSchema: Meta,
  tables: JournalTables,
  projections: readonly Projection<SchemaOutput<Meta>, Tx>[],
  /** An effect or a tap may still have needs (`services: 'worker'`): only the worker runs them, with its `services`. */
  effects: readonly Effect<SchemaOutput<Meta>, AppDb, RootCommandRunner<Meta, Tx>, Needs>[],
  taps: readonly Tap<SchemaOutput<Meta>, AppDb, Needs>[] = [],
  retentionOption?: JobRetention,
  /** What `journal.workflows` needs: the operator verbs, the registered code, and the meta their events are recorded with. */
  workflowWiring?: {
    readonly commands: ReturnType<typeof createWorkflows<Meta, Tx, AppDb>>['operate'];
    readonly registry: ReadonlyMap<string, { readonly shapeHash: string }>;
    readonly meta: SchemaInput<Meta> | undefined;
  },
): Journal<Meta, Tx, AppDb> {
  assertUniqueNames('tap', taps);
  const retention = resolveRetention(retentionOption);
  assertRetention(retention, effects);
  const effectOverride = effectOverrides(effects);
  const eventsSchema = getTableConfig(tables.events).schema;
  const wakeChannel = eventsSchema === undefined ? 'journal_wake' : `${eventsSchema}_journal_wake`;
  type MetaOut = SchemaOutput<Meta>;

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
  const commandHooks = createHookPoint<CommandHookContext<SchemaOutput<Meta>>>('command');
  const effectHooks = createHookPoint<EffectHookContext<SchemaOutput<Meta>>>('effect');
  const run = createCommandRunner<Meta, Tx>({
    metaSchema,
    writeWithValidatedMeta,
    wake: () => journal.wake(),
    hooks: commandHooks,
    tables,
  });
  // The worker's database is also the source of every command an effect runs, so it opens `Tx`.
  type WorkerDb = AppDb & TransactionSource<Tx>;
  /**
   * An effect whose `ctx.run` returned a failure it did not accept must not report success:
   * the job would count as done though a command said no. Each command already rolled back on
   * its own, so there is nothing left to undo. A success after an unaccepted refusal ends the
   * job with that refusal instead: dead after one try by default, like a returned failure. It
   * is not thrown, because a thrown error is retried, and a retry would run again the commands
   * that did commit.
   */
  const attemptOn = (
    db: WorkerDb,
    cause: { readonly seq: number; readonly correlationId: string | null },
    effect: string,
    held: { readonly jobId: string; readonly attempt: number },
  ): EffectAttempt<RootCommandRunner<Meta, Tx>> => {
    const refusals = trackRefusals('effect', effect, 'run');
    const attempts = tables.jobAttempts;
    // `FOR SHARE` on the open attempt row: a claim that supersedes it needs the row for update, so it waits for
    // this command to commit, and a command that starts after the claim finds no open row and commits nothing.
    const fence: Fence = async tx => {
      const open = await tx
        .select({ id: attempts.id })
        .from(attempts)
        .where(and(eq(attempts.jobId, held.jobId), eq(attempts.attempt, held.attempt), isNull(attempts.finishedAt)))
        .for('share');
      if (open.length === 0)
        throw new JournalError(
          'LEASE_LOST',
          'job',
          held.jobId,
          `attempt ${held.attempt} of "${effect}" is no longer open`,
        );
    };
    return {
      run: (command, input, meta, call) =>
        run(db, command, input, meta, call, cause, fence).then(refusals.watch(`the command "${command.name}"`)),
      accept: refusals.accept,
      settle: async handler => {
        const outcome = await handler.finally(refusals.finish);
        const ignored = refusals.unhandled();
        if (ignored === undefined || isFailure<unknown>(outcome)) return outcome;
        debugDrain.debug('{effect}: {from} returned {code}, and the effect returned a success; the job fails', {
          effect,
          from: ignored.from,
          code: ignored.failure.code,
        });
        return ignored.failure;
      },
    };
  };
  const drain = createDrain<Meta, WorkerDb, RootCommandRunner<Meta, Tx>>({
    tables,
    hooks: effectHooks,
    effects,
    retention,
    history,
    attemptOn,
  });
  const catching = createCatchUp<Meta, Tx>({ tables, projections: asyncProjections, history });
  const dispatch = createTapDispatch<Meta, WorkerDb>({ tables, taps, history });
  const workers = createWorkers<WorkerDb>({
    drain: (db, opts) => journal.drain(db, opts),
    catchUp: (db, opts) => journal.catchUp(db, opts),
    dispatch,
    checkServices: services => void bindHandlers({ effects, taps }, services),
    tapNames: taps.map(tap => tap.name),
    sweep:
      retention.sweep === false
        ? undefined
        : { everyMs: retention.sweep.everyMs, run: (db, signal) => sweepOnce(db, signal) },
  });
  const strandedJobs = createStrandedJobs({ tables, effectNames: effects.map(effect => effect.name) });
  const { sweepOnce, ...jobOps } = createJobOps({
    tables,
    retention,
    wake: () => journal.wake(),
    overrideFor: effectOverride,
  });

  const workflowReads = createWorkflowReads({ tables, registry: workflowWiring?.registry ?? new Map() });
  /** The meta of the events the verbs write: the one `compose` was given for the workflow runner. */
  const verbMeta = (): SchemaInput<Meta> => {
    if (workflowWiring?.meta === undefined) {
      throw new JournalError(
        'BAD_DEFINITION',
        'workflow',
        'workflows',
        'journal: the workflow verbs need compose({ workflows, workflowMeta }): the code that undoes and resumes runs, and the meta their events carry',
      );
    }
    return workflowWiring.meta;
  };
  const verbCommands = () => {
    if (workflowWiring === undefined) {
      throw new JournalError(
        'BAD_DEFINITION',
        'workflow',
        'workflows',
        'journal: the workflow verbs need compose({ workflows, workflowMeta })',
      );
    }
    return workflowWiring.commands;
  };

  const journal: Journal<Meta, Tx, AppDb> = {
    write: (tx, entity, id, input) => write(tx, entity, id, input),
    adopt: (tx, entity, id, input) => adopt(tx, entity, id, input),
    run: (source, command, input, meta, opts) => run(source, command, input, meta, opts),
    bind: (source, meta, opts) => (command, input, call) => {
      const { keyPerCommand, ...bound } = opts ?? {};
      const key = bound.idempotencyKey;
      return journal.run(source, command, input, meta, {
        ...bound,
        ...(keyPerCommand === true && key !== undefined ? { idempotencyKey: `${key}:${command.name}` } : {}),
        ...call,
      });
    },
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
    strandedJobs: (db, opts) => strandedJobs(db, opts),
    retention,
    ...jobOps,
    workflows: {
      ...workflowReads,
      retryStep: async (source, args, op) => {
        const done = await run(source, verbCommands().retryStep, { ...args, op }, verbMeta());
        // A retried job, a new attempt and restarted children are all work for a worker.
        journal.wake();
        return done;
      },
      resolveStep: async (source, args, op) => {
        const done = await run(source, verbCommands().resolveStep, { ...args, op }, verbMeta());
        journal.wake();
        return done;
      },
      skipUndo: async (source, args, op) => {
        const done = await run(source, verbCommands().skipUndo, { ...args, op }, verbMeta());
        journal.wake();
        return done;
      },
      signal: async (source, args, op) => {
        const done = await run(source, verbCommands().signal, { ...args, op }, verbMeta());
        journal.wake();
        return done;
      },
      cancel: async (source, args, op) => {
        const done = await run(source, verbCommands().cancel, { ...args, op }, verbMeta());
        journal.wake();
        return done;
      },
      checkResult: (db, args) => verbCommands().checkResult(db, args),
    },
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
