/**
 * The entry point: `initJournal`, the definition helpers it returns, and
 * `createJournal`, which checks the handlers, builds each part with its
 * dependencies and wires the public methods.
 * May import every other file. No implementation file may import this one.
 */
import {
  and,
  eq,
  getTableColumns,
  getTableName,
  is,
  isNotNull,
  isNull,
  lt,
  lte,
  ne,
  notLike,
  or,
  sql,
} from 'drizzle-orm';
import { getTableConfig, PgColumn } from 'drizzle-orm/pg-core';

import type { SchemaInput, SchemaOutput, StandardSchemaV1 } from '@arki/schema';
import { isFailure } from '@arki/failure';

import type { Journal, JournalDefinitions, RootCommandRunner } from './api.js';
import type { Fence } from './command.js';
import type { EntityBuilder } from './entity.js';
import type { EventLog, ForwardedLog } from './event-log.js';
import type { JournalTables } from './pg.js';
import type { JobRetention } from './retention.js';
import type {
  AnyEntity,
  CommandHookContext,
  DbHandle,
  Effect,
  EffectHookContext,
  EntityTable,
  EventStorage,
  IdTable,
  KeyName,
  Needs,
  Projection,
  RootDb,
  SingleKey,
  StepHookContext,
  Tap,
  TransactionSource,
} from './types.js';
import type { EffectAttempt } from './worker.js';
import { createCommandRunner } from './command.js';
import { debugDrain } from './debug.js';
import { defineEntity } from './entity.js';
import { CommandNotFound, JournalError } from './errors.js';
import { routeOf } from './event-log.js';
import { defineEvent } from './event.js';
import { bindEffectFrom, bindHandlers, bindTap, defineProjection, effectFor, tapFor } from './handlers.js';
import { createHistory } from './history.js';
import { createHookPoint } from './hooks.js';
import { createJobOps } from './outbox.js';
import { trackRefusals } from './refusals.js';
import { assertRetention, effectOverrides, resolveRetention } from './retention.js';
import { isReturnedFailure } from './rollback.js';
import { isPlainObject } from './storage.js';
import { createBuiltInEventLog, createPgStore } from './store.js';
import {
  createCatchUp,
  createDrain,
  createForwardLag,
  createStrandedJobs,
  createTapDispatch,
  createWorkers,
} from './worker.js';
import { defineLimit } from './workflow/limit-types.js';
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

/** `initJournal` options other than `meta`. `events` is the journal default; each entity may override it. */
type InitOptions = {
  readonly tables: JournalTables;
  readonly retention?: JobRetention;
  readonly events?: EventStorage;
};

function initFor<Tx extends TransactionSource<Tx>, AppDb extends RootDb>() {
  function init(options: InitOptions): JournalDefinitions<EmptyMeta, Tx, AppDb>;
  function init<Meta extends StandardSchemaV1<unknown, Record<string, unknown>>>(
    options: InitOptions & { readonly meta: Meta },
  ): JournalDefinitions<Meta, Tx, AppDb>;
  function init<Meta extends StandardSchemaV1<unknown, Record<string, unknown>>>(
    options: InitOptions & { readonly meta?: Meta },
  ): JournalDefinitions<Meta, Tx, AppDb> | JournalDefinitions<EmptyMeta, Tx, AppDb> {
    const eventStorage = options.events ?? 'stored';
    return options.meta === undefined
      ? createInit<EmptyMeta, Tx, AppDb>(emptyMeta, options.tables, options.retention, eventStorage)
      : createInit<Meta, Tx, AppDb>(options.meta, options.tables, options.retention, eventStorage);
  }
  return init;
}

/**
 * `initJournal({ tables, meta })` types `write`'s `tx`, `events`' `{ tx }` and
 * projection handlers with the structural `DbHandle`. `initJournal.tx<AppTx>()
 * .create({ tables, meta })` uses the app's own Drizzle transaction type instead, so
 * repositories typed against it fit. `initJournal.db<AppDb>()` names the
 * app's root database type: effects get it as `ctx.db`, and `drain` and
 * `worker` then need it. Both are type-only steps and chain in either order.
 * `retention` says how long finished jobs are kept, where they go and how often the sweeper runs. It is the one
 * place for it: archive at ack, the job operations, the sweeper, Foreman and workflow timers all read it.
 * Defaults: completed 7 days, dead 90 days.
 * `events` is the journal's default for whether an entity's events are stored (`'stored'`, the
 * default) or only passed through the write (`'transient'`); `j.entity(kind, table, { events })`
 * overrides it per entity. Workflow runs always store their events.
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
>(
  metaSchema: Meta,
  tables: JournalTables,
  retention: JobRetention | undefined,
  defaultEventStorage: EventStorage,
): JournalDefinitions<Meta, Tx, AppDb> {
  type MetaOut = SchemaOutput<Meta>;
  /** Per entity kind, the log its forward jobs append to: the worker reads it to run them. */
  const forwardedLogs = new Map<string, ForwardedLog>();
  function entity<K extends string, Tbl extends IdTable>(
    kind: K,
    table: Tbl,
    options?: { readonly events?: EventStorage },
  ): EntityBuilder<K, Tbl, never, MetaOut, 'id'>;
  function entity<K extends string, Tbl extends EntityTable, Key extends KeyName<Tbl>>(
    kind: K,
    table: Tbl,
    options: { readonly key: Key & SingleKey<Key>; readonly events?: EventStorage },
  ): EntityBuilder<K, Tbl, never, MetaOut, Key>;
  function entity<K extends string, Tbl extends EntityTable>(
    kind: K,
    table: Tbl,
    options?: { readonly key?: string; readonly events?: EventStorage },
  ) {
    // Resolved here, the one place that sees both the entity's setting and the journal's default.
    const eventStorage = options?.events ?? defaultEventStorage;
    if (typeof eventStorage === 'object' && !eventStorage.canJoinTransaction) {
      const known = forwardedLogs.get(kind);
      if (known !== undefined && known !== eventStorage)
        throw new JournalError(
          'BAD_DEFINITION',
          'entity',
          kind,
          `journal: entity "${kind}" is declared twice with two different event logs; one kind has one log, or its forward jobs would not know where to go`,
        );
      forwardedLogs.set(kind, eventStorage);
    }
    if (options?.key !== undefined) {
      return defineEntity<K, Tbl, MetaOut, string>(kind, table, options.key, eventStorage);
    }
    if (!hasIdColumn(table)) {
      throw new JournalError(
        'BAD_DEFINITION',
        'entity',
        kind,
        `journal: entity "${kind}": table "${getTableName(table)}" has no "id" column; pass { key: 'columnName' }`,
      );
    }
    return defineEntity<K, Tbl, MetaOut, 'id'>(kind, table, 'id', eventStorage);
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
    task: workflows.task,
    limit: defineLimit,
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
        services === undefined ? declared : bindEffectFrom(declared, () => services),
      );
      const taps = (config.taps ?? []).map(tap => (services === undefined ? tap : bindTap(tap, services)));
      const projections = [...(config.projections ?? []), ...(runner === undefined ? [] : [runner.steps])];
      return createJournal<Meta, Tx, AppDb>(metaSchema, tables, projections, effects, taps, retention, forwardedLogs, {
        commands: workflows.operate,
        limits: workflows.limits,
        registry: workflows.started,
        meta: config.workflowMeta,
        stepHooks: workflows.stepHooks,
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

/**
 * Throws when a handler that reads the log back cannot: an entity keeps no events, a tap follows a
 * forwarded entity (taps read the seq range the wake signal carries, from `journal_events`), the
 * entities live in different logs, or a forwarded log has no global order to walk.
 */
function assertStoredEntities(
  kind: 'projection' | 'tap',
  handler: { readonly name: string; readonly entities: readonly Pick<AnyEntity, 'kind' | 'eventStorage'>[] },
): void {
  const what = kind === 'projection' ? 'async projection' : 'tap';
  const refuse = (detail: string): never => {
    throw new JournalError('BAD_DEFINITION', kind, handler.name, `journal: ${what} "${handler.name}" ${detail}`);
  };
  const transient = handler.entities.find(entity => entity.eventStorage === 'transient');
  if (transient !== undefined)
    refuse(
      `reads stored events, but entity "${transient.kind}" is declared with events: 'transient' and keeps none; use an inline projection or an effect, or store the entity's events`,
    );
  const elsewhere = handler.entities.find(entity => typeof entity.eventStorage === 'object');
  if (kind === 'tap' && elsewhere !== undefined)
    refuse(
      `follows entity "${elsewhere.kind}", whose events go to its own event log; a tap reads only journal_events, so use an effect or an async projection`,
    );
  const logs = new Set(handler.entities.map(entity => entity.eventStorage));
  if (logs.size > 1)
    refuse('reads entities whose events live in different logs; one projection walks one log, so split it in two');
  const [log] = logs;
  if (typeof log === 'object' && !log.canJoinTransaction && log.all === undefined)
    refuse(
      `reads entity "${elsewhere?.kind ?? ''}", whose event log has no global order to walk; use an inline projection or an effect`,
    );
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
  /** Per entity kind, the forwarded log of `j.entity`. Live: an entity defined after compose still counts. */
  forwardedLogs: ReadonlyMap<string, ForwardedLog> = new Map(),
  /** What `journal.workflows` needs: the operator verbs, the registered code, and the meta their events are recorded with. */
  workflowWiring?: {
    readonly commands: ReturnType<typeof createWorkflows<Meta, Tx, AppDb>>['operate'];
    /** The limit reads and the commands of the limit verbs. */
    readonly limits: ReturnType<typeof createWorkflows<Meta, Tx, AppDb>>['limits'];
    readonly registry: ReadonlyMap<string, { readonly shapeHash: string }>;
    readonly meta: SchemaInput<Meta> | undefined;
    /** The step hooks the runner wraps each step body and undo in. */
    readonly stepHooks: ReturnType<typeof createWorkflows<Meta, Tx, AppDb>>['stepHooks'];
  },
): Journal<Meta, Tx, AppDb> {
  assertUniqueNames('tap', taps);
  // Async projections and taps read `journal_events` after the commit. A transient entity never
  // writes there, so they would see nothing, silently. Refused at setup instead.
  for (const projection of projections) {
    if (projection.lane === 'async') assertStoredEntities('projection', projection);
  }
  for (const tap of taps) assertStoredEntities('tap', tap);
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
  const store = createPgStore({ tables, wakeChannel });
  const eventLog = createBuiltInEventLog({ tables });
  const history = createHistory<Meta>({ metaSchema, tables, store, log: eventLog });
  const inlineProjections = projections.filter(projection => projection.lane === 'inline');
  const asyncProjections = projections.filter(projection => projection.lane === 'async');
  const { write, adopt, writeWithValidatedMeta } = createWriter<Meta, Tx>({
    metaSchema,
    store,
    log: eventLog,
    projections: inlineProjections,
    asyncProjections,
    effects,
    history,
  });
  const commandHooks = createHookPoint<CommandHookContext<SchemaOutput<Meta>>>('command');
  const effectHooks = createHookPoint<EffectHookContext<SchemaOutput<Meta>>>('effect');
  const stepHooks = workflowWiring?.stepHooks ?? createHookPoint<StepHookContext>('step');
  const run = createCommandRunner<Meta, Tx>({
    metaSchema,
    writeWithValidatedMeta,
    wake: () => journal.wake(),
    hooks: commandHooks,
    store,
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
      runUnwatched: (command, input, meta, call) => run(db, command, input, meta, call, cause, fence),
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
    // Steps run inside effect jobs, so the first drain freezes the step hooks together with the effect hooks.
    hooks: {
      ...effectHooks,
      freeze: () => {
        effectHooks.freeze();
        stepHooks.freeze();
      },
    },
    effects,
    retention,
    history,
    attemptOn,
    forwarded: forwardedLogs,
  });
  // `assertStoredEntities` held each async projection to one log, so its first entity's log is the one.
  const logOfProjection = (projection: Pick<Projection, 'entities'>): EventLog => {
    const route = routeOf(projection.entities[0]?.eventStorage ?? 'stored', eventLog);
    return route.mode === 'transient' ? eventLog : route.log;
  };
  const catching = createCatchUp<Meta, Tx>({ tables, logOf: logOfProjection, projections: asyncProjections, history });
  const dispatch = createTapDispatch<Meta, WorkerDb>({ log: eventLog, taps, history });
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
  const strandedJobs = createStrandedJobs({
    tables,
    effectNames: effects.map(effect => effect.name),
    forwarded: forwardedLogs,
  });
  const { sweepOnce, ...jobOps } = createJobOps({
    tables,
    retention,
    wake: () => journal.wake(),
    overrideFor: effectOverride,
    forwarded: forwardedLogs,
  });
  const forwardLag = createForwardLag({ tables });

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
  const limitCommands = () => {
    if (workflowWiring === undefined) {
      throw new JournalError(
        'BAD_DEFINITION',
        'workflow',
        'limits',
        'journal: the limit verbs need compose({ workflows, workflowMeta })',
      );
    }
    return workflowWiring.limits;
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
        .where(
          and(
            lt(tables.receipts.recordedAt, opts.before),
            or(
              ne(tables.receipts.command, 'http.response'),
              notLike(tables.receipts.key, 'http:%'),
              and(isNotNull(tables.receipts.response), lte(tables.receipts.expiresAt, sql`now()`)),
            ),
          ),
        )
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
    forwardLag: db => forwardLag(db),
    copyLog: (db, entity, opts) => history.copyLog(db, entity, opts),
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
      // A metadata or tag change moves no run, so there is no work to wake a worker for.
      setMetadata: (source, args, op) => run(source, verbCommands().setMetadata, { ...args, op }, verbMeta()),
      addTags: (source, args, op) => run(source, verbCommands().addTags, { ...args, op }, verbMeta()),
      reschedule: async (source, args, op) => {
        const done = await run(source, verbCommands().reschedule, { ...args, op }, verbMeta());
        // The first node may be due now.
        journal.wake();
        return done;
      },
      replay: async (source, args, op) => {
        const done = await run(source, verbCommands().replay, { ...args, op }, verbMeta());
        journal.wake();
        return done;
      },
      checkResult: (db, args) => verbCommands().checkResult(db, args),
    },
    // A limit change starts nothing in this slice, so no verb wakes a worker. Without workflows no limit is known.
    limits: {
      list: async db => (workflowWiring === undefined ? [] : workflowWiring.limits.list(db)),
      get: (db, name) =>
        workflowWiring === undefined
          ? Promise.resolve(CommandNotFound({ detail: `no limit "${name}"; no workflows are composed` }))
          : workflowWiring.limits.get(db, name),
      override: (source, args, op) => run(source, limitCommands().override, { ...args, op }, verbMeta()),
      reset: (source, args, op) => run(source, limitCommands().reset, { ...args, op }, verbMeta()),
      pause: (source, args, op) => run(source, limitCommands().pause, { ...args, op }, verbMeta()),
      resume: (source, args, op) => run(source, limitCommands().resume, { ...args, op }, verbMeta()),
    },
    wakeChannel,
    hooks: { command: commandHooks.point, effect: effectHooks.point, step: stepHooks.point },
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
