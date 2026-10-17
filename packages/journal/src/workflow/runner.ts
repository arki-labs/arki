/**
 * The runner core: how a run starts, how one node runs as a journal effect job, and the checkpoint
 * that moves the run on.
 *
 *   start (command)  -> RunStarted + NodeScheduled(first)          one transaction
 *   workflow.step    -> one job per node attempt, `run_id` set      runs the body under the lease
 *   checkpoint (cmd) -> NodeCompleted | NodeSkipped | NodeFailed    through the fence of `ctx.run`,
 *                       + NodeScheduled(next) | RunCompleted         so a stale owner commits nothing
 *
 * A step is at-least-once: a crash after the body and before the checkpoint runs the body again with
 * the same `ctx.key`. The checkpoint itself commits at most once per node attempt.
 */
import { and, asc, count, desc, eq, inArray, isNull, lte, or, sql } from 'drizzle-orm';
import { z } from 'zod';

import type { SchemaInput, SchemaOutput, StandardSchemaV1 } from '@arki/schema';
import { defineFailure, isFailure } from '@arki/failure';
import { parseAsync, SchemaError } from '@arki/schema';

import type { Command, JournalDefinitions, RootCommandRunner } from '../api.js';
import type { JournalTables } from '../pg.js';
import type { JobRetention } from '../retention.js';
import type { EffectContext, Needed, Needs, RecordedOf, RootDb, TransactionSource } from '../types.js';
import type { AnySignals, DefExtension, ErasedContext, WorkflowDef, WorkflowNode } from './define.js';
import { debugWorkflow } from '../debug.js';
import { CommandConflict, CommandInvalid, CommandNotFound, isJournalError, JournalError } from '../errors.js';
import { workflowRunId, workflowSignalId } from '../id.js';
import { createJobOps } from '../outbox.js';
import { parseAge, resolveRetention } from '../retention.js';
import { isPlainObject, sameValue } from '../storage.js';
import { defaultEffectRetry } from '../worker.js';
import { workflowWith } from './define.js';
import { workflowMachine } from './machine.js';

/** The library-owned effect that runs one node attempt. */
export const STEP_EFFECT = 'workflow.step';
/** The library-owned effect that fires a park's wake time and a run's deadline. */
export const TIMER_EFFECT = 'workflow.timer';
/** The actor on the job operation rows the runner writes, such as the timer it cancels when a signal wins. */
const WORKFLOW_ACTOR = 'system:workflow';
/** The command that moves a run on after a node attempt. Internal: only the step effect runs it. */
const CHECKPOINT_COMMAND = 'workflow.checkpoint';

/** What a step's last attempt returns to the worker when the step is dead: the job dies at once and an operator can revive it. */
const StepDead = defineFailure('journal.workflow.step_dead', {
  status: 500,
  data: z.object({ detail: z.string() }),
  message: '{detail}',
});

/** The arguments of `def.start`. */
export type StartArgs<Input> = { readonly input: Input; readonly id?: string };
/** The schema of `def.start`: `{ input, id? }`, with `input` checked by the workflow's own input schema. */
export type StartSchema<Input extends StandardSchemaV1> = StandardSchemaV1<
  StartArgs<SchemaInput<Input>>,
  StartArgs<SchemaOutput<Input>>
>;
/** What `def.start` returns: the run id, or a refusal when the id is taken by another run or the input is too large. */
export type StartOutcome = { readonly runId: string } | CommandConflict;
/** What a journal adds to a finished definition. */
export type WorkflowStarter<
  Meta extends StandardSchemaV1<unknown, Record<string, unknown>>,
  Tx extends TransactionSource<Tx>,
  Input extends StandardSchemaV1,
  Signals extends AnySignals,
> = {
  readonly start: Command<StartSchema<Input>, Promise<StartOutcome>, SchemaOutput<Meta>, Tx>;
  /**
   * The command that delivers the signal `name` to a run. `name` is one of the signals the workflow's `waitFor`
   * nodes declare, and `payload` is the input of that signal's schema.
   */
  readonly signal: <Name extends keyof Signals & string>(
    name: Name,
  ) => Command<SignalSchema<Signals[Name]>, Promise<SignalOutcome>, SchemaOutput<Meta>, Tx>;
};
/** What `j.workflow` adds to a definition: a `WorkflowStarter` for the signals the finished definition declares. */
// eslint-disable-next-line @typescript-eslint/consistent-type-definitions -- `this['signals']` is only available in an interface
export interface StarterOf<
  Meta extends StandardSchemaV1<unknown, Record<string, unknown>>,
  Tx extends TransactionSource<Tx>,
  Input extends StandardSchemaV1,
> extends DefExtension {
  readonly out: WorkflowStarter<Meta, Tx, Input, Extract<this['signals'], AnySignals>>;
}

function startSchema<Input extends StandardSchemaV1>(input: Input): StartSchema<Input> {
  return {
    '~standard': {
      version: 1,
      vendor: 'arki',
      validate: async value => {
        if (!isPlainObject(value)) return { issues: [{ message: 'start takes { input, id? }' }] };
        const { id } = value;
        if (id !== undefined && (typeof id !== 'string' || id === '')) {
          return { issues: [{ message: 'id must be a non-empty string', path: ['id'] }] };
        }
        try {
          const parsed = await parseAsync<SchemaOutput<Input>>(input, value.input);
          return { value: id === undefined ? { input: parsed } : { input: parsed, id } };
        } catch (error) {
          if (error instanceof SchemaError) {
            return { issues: error.issues.map(issue => ({ ...issue, path: ['input', ...(issue.path ?? [])] })) };
          }
          throw error;
        }
      },
    },
  };
}

const isoTime = z.iso.datetime();
/** Where a run goes after a node: to another node, or to its end with the output already worked out. */
const routeSchema = z.discriminatedUnion('go', [
  z.object({ go: z.literal('node'), name: z.string().min(1) }),
  z.object({ go: z.literal('finish'), output: z.unknown(), keepUntil: isoTime.nullable() }),
]);
type Route = z.infer<typeof routeSchema>;
const nodeCheckpointSchema = z.object({
  runId: z.string().min(1),
  path: z.string().min(1),
  /** The attempt of the node this checkpoint answers. A checkpoint for any other attempt is stale. */
  attempt: z.int().positive(),
  outcome: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('completed'), result: z.unknown(), route: routeSchema }),
    z.object({ kind: z.literal('skipped'), reason: z.string().min(1), route: routeSchema }),
    /** The attempt failed and the step retries: the same key, the next attempt, due at `at`. */
    z.object({ kind: z.literal('retry'), error: z.string().min(1), key: z.string().min(1), at: isoTime }),
    /** The attempt failed and the step is out of retries: it waits for an operator. */
    z.object({ kind: z.literal('dead'), error: z.string().min(1) }),
    /** A `waitFor` or `sleep` node has nothing to run: the run parks until the signal or `wakeAt`. */
    z.object({ kind: z.literal('park'), waitingFor: z.string().min(1).nullable(), wakeAt: isoTime.nullable() }),
  ]),
});
/** A timer job fired: the wake time of a park, or the deadline of the run. */
const timerCheckpointSchema = z.object({
  runId: z.string().min(1),
  fired: z.discriminatedUnion('kind', [
    /** `parkSeq`: the seq of the `Parked` event that made this timer. A later park of the same node is another wait. */
    z.object({ kind: z.literal('wake'), node: z.string().min(1), parkSeq: z.int().positive() }),
    z.object({ kind: z.literal('deadline') }),
  ]),
});
const checkpointSchema = z.union([nodeCheckpointSchema, timerCheckpointSchema]);

/** The arguments of `def.signal(name)`. `deliveryId` is the sender's own id: a repeat of it changes nothing. */
const signalEnvelope = z.object({
  runId: z.string().min(1),
  deliveryId: z.string().min(1),
  payload: z.unknown(),
});
export type SignalArgs<Payload> = { readonly runId: string; readonly deliveryId: string; readonly payload: Payload };
/** The schema of a signal command. `payload` is typed with the input of the signal's schema; the handler checks it. */
export type SignalSchema<Payload extends StandardSchemaV1> = StandardSchemaV1<
  SignalArgs<SchemaInput<Payload>>,
  SignalArgs<unknown>
>;
/** Checks `runId` and `deliveryId` and passes the payload on: the command's handler checks it with the node's schema. */
function signalSchemaFor<Payload extends StandardSchemaV1>(): SignalSchema<Payload> {
  return {
    '~standard': { version: 1, vendor: 'arki', validate: value => signalEnvelope['~standard'].validate(value) },
  };
}
/** `kept`: stored, the run is not waiting for it yet. `woke`: stored and the run moved on. `duplicate`: this delivery was seen. `finished`: the run is over, so it is dropped. */
export type SignalOutcome =
  { readonly status: 'kept' | 'woke' | 'duplicate' | 'finished' } | CommandNotFound | CommandInvalid | CommandConflict;

type Verdict =
  | { readonly kind: 'park'; readonly waitingFor: string | null; readonly wakeAt: string | null }
  | { readonly kind: 'skipped'; readonly reason: string; readonly route: Route }
  | { readonly kind: 'completed'; readonly result: unknown; readonly route: Route }
  | { readonly kind: 'failed'; readonly reason: unknown; readonly retryable: boolean };

const failed = (reason: unknown, retryable = true): Verdict => ({ kind: 'failed', reason, retryable });

/** Readable text of whatever failed a step: an error, a returned failure, or anything thrown. */
function reasonText(reason: unknown): string {
  if (isFailure(reason)) return JSON.stringify(reason);
  const text = reason instanceof Error ? `${reason.name}: ${reason.message}` : String(reason);
  return text === '' ? 'the step failed without a message' : text;
}

/** `JSON.stringify` says `string`, but it gives `undefined` for a function or a symbol. */
const jsonOf = (value: unknown): string | undefined => JSON.stringify(value);

/**
 * A value a run may keep: it survives JSON storage unchanged and fits `limit` bytes. `undefined` is stored as `null`,
 * so a step that returns nothing has the result `null`. Returns the value to store, or the error that refuses it.
 */
function storable(
  value: unknown,
  limit: number,
  what: string,
  runId: string,
): { readonly value: unknown } | JournalError {
  const normal = value === undefined ? null : value;
  let json: string | undefined;
  try {
    json = jsonOf(normal);
  } catch (error) {
    return new JournalError('UNSTABLE_SCHEMA', 'workflow', runId, `${what} cannot be written as JSON`, {
      cause: error,
    });
  }
  if (json === undefined) return new JournalError('UNSTABLE_SCHEMA', 'workflow', runId, `${what} has no JSON form`);
  const bytes = new TextEncoder().encode(json).length;
  if (bytes > limit) {
    return new JournalError(
      'WORKFLOW_LIMIT',
      'workflow',
      runId,
      `${what} is ${bytes} bytes; limits.payload is ${limit}`,
    );
  }
  const back: unknown = JSON.parse(json);
  if (!sameValue(normal, back)) {
    return new JournalError('UNSTABLE_SCHEMA', 'workflow', runId, `${what} changes across JSON storage`);
  }
  return { value: normal };
}

const nowIso = () => new Date().toISOString();
const endedBy = (written: readonly { readonly type: string }[]) => ({
  park: written.some(event => event.type === 'NodeCompleted' || event.type === 'RunFailed'),
  deadline: written.some(event => event.type === 'RunCompleted' || event.type === 'RunFailed'),
});

const inMs = (ms: number) => new Date(Date.now() + ms).toISOString();
const keepUntilFor = (age: WorkflowDef['retention']['completed']): string | null =>
  age === undefined || age === 'forever' ? null : inMs(parseAge(age));

type Definitions<
  Meta extends StandardSchemaV1<unknown, Record<string, unknown>>,
  Tx extends TransactionSource<Tx>,
  AppDb extends RootDb,
> = Pick<JournalDefinitions<Meta, Tx, AppDb>, 'event' | 'entity' | 'projection' | 'command' | 'effect'>;

/**
 * The workflow runner of one `initJournal()`: `workflow` builds definitions with `start`; `register`, called by
 * `compose`, returns the step effect and the step projection. The `workflow.run` entity is built here from the
 * journal tables `initJournal` was given, like any entity of the app.
 */
export function createWorkflows<
  Meta extends StandardSchemaV1<unknown, Record<string, unknown>>,
  Tx extends TransactionSource<Tx>,
  AppDb extends RootDb,
>(j: Definitions<Meta, Tx, AppDb>, tables: JournalTables, retention: JobRetention | undefined) {
  type MetaOut = SchemaOutput<Meta>;
  const machine = workflowMachine<Meta, Tx>(j, tables);
  const { run, events } = machine;
  const { workflowRuns, workflowSteps, workflowSignals } = tables;

  /**
   * The step key of a node's next visit: `<run>:<path>:do`, and `…:do:2`, `…:do:3` when a `next` loop comes back to
   * it. A retry of the same visit keeps the key, so a provider that dedupes on it dedupes the retry; a new visit gets a new one.
   */
  const keyOfNextVisit = async (tx: Tx, runId: string, path: string) => {
    const [seen] = await tx
      .select({ n: count() })
      .from(tables.events)
      .where(
        and(
          eq(tables.events.kind, 'workflow.run'),
          eq(tables.events.entityId, runId),
          inArray(tables.events.type, ['NodeCompleted', 'NodeSkipped']),
          sql`${tables.events.data} ->> 'path' = ${path}`,
          sql`${tables.events.data} ->> 'phase' = 'do'`,
        ),
      );
    const visit = (seen?.n ?? 0) + 1;
    return visit === 1 ? `${runId}:${path}:do` : `${runId}:${path}:do:${visit}`;
  };

  /**
   * Gives the step jobs a write just queued their `run_id`, and the step rows their `job_id`. In the write's own
   * transaction, so a worker never sees a step job that does not belong to its run.
   */
  const linkJobs = async (
    tx: Tx,
    runId: string,
    scheduled: readonly { readonly seq: number; readonly path: string; readonly phase: 'do' | 'undo' }[],
  ) => {
    if (scheduled.length === 0) return;
    const queued = await tx
      .update(tables.jobs)
      .set({ runId })
      .where(
        and(
          inArray(
            tables.jobs.eventSeq,
            scheduled.map(entry => entry.seq),
          ),
          eq(tables.jobs.effect, STEP_EFFECT),
        ),
      )
      .returning({ id: tables.jobs.id, eventSeq: tables.jobs.eventSeq });
    for (const job of queued) {
      const owner = scheduled.find(entry => entry.seq === job.eventSeq);
      if (owner === undefined) continue;
      await tx
        .update(workflowSteps)
        .set({ jobId: job.id })
        .where(
          and(eq(workflowSteps.runId, runId), eq(workflowSteps.path, owner.path), eq(workflowSteps.phase, owner.phase)),
        );
    }
  };

  type Row = typeof workflowRuns.$inferSelect;

  /** Every definition a `compose({ workflows })` of this `initJournal()` registered, by `name@version`. A start of any other has no step effect to queue its job for. */
  const started = new Map<string, WorkflowDef>();
  const definitionOf = (row: Row): WorkflowDef => {
    const def = started.get(`${row.name}@${row.workflowVersion}`);
    if (def === undefined) {
      throw new JournalError(
        'WORKFLOW_UNKNOWN',
        'workflow',
        row.id,
        `no registered workflow "${row.name}" v${row.workflowVersion}`,
      );
    }
    return def;
  };

  /**
   * The job verbs, for the one thing the runner cancels: the timer of a park the run has left. They write
   * the operation row and archive the job under the retention given to `initJournal`.
   */
  const jobOps = createJobOps({
    tables,
    retention: resolveRetention(retention),
    wake: () => {
      // No worker to wake here; the caller polls.
    },
  });

  /** `node` index `targetIndex` is next; past the last node the run is over and its output is worked out here. */
  async function routeAt(
    def: WorkflowDef,
    targetIndex: number,
    row: Row,
    lastPath: string,
    lastResult: unknown,
  ): Promise<Route> {
    const target = def.nodes[targetIndex];
    if (target !== undefined) return { go: 'node', name: target.name };
    const results = { ...row.results, [lastPath]: lastResult };
    const produced =
      def.finish === undefined ? lastResult : await def.finish({ runId: row.id, input: row.input, results });
    if (isFailure(produced)) {
      throw new JournalError(
        'BAD_DEFINITION',
        'workflow',
        row.id,
        `finish returned a failure: ${JSON.stringify(produced)}`,
      );
    }
    const parsed = def.output === undefined ? produced : await parseAsync(def.output, produced);
    const kept = storable(parsed, def.limits.payload, 'the output', row.id);
    if (kept instanceof JournalError) throw kept;
    return { go: 'finish', output: kept.value, keepUntil: keepUntilFor(def.retention.completed) };
  }

  /** The run's deadline has passed, whether or not its timer has fired yet: a late signal or park cannot defeat it. */
  const pastDeadline = (row: Row) => row.deadlineAt !== null && row.deadlineAt.getTime() <= Date.now();
  const runFailed = (def: WorkflowDef, error: string, at: string) =>
    events.RunFailed({ error, at, keepUntil: keepUntilFor(def.retention.failed) });
  const deadlineEvents = (def: WorkflowDef, at: string) => [
    events.DeadlineReached({ at }),
    runFailed(def, 'the run deadline passed before it finished', at),
  ];

  /** Where a run goes: the next node's schedule, or its completion. */
  const eventsAfter = async (tx: Tx, runId: string, route: Route, at: string) =>
    route.go === 'node'
      ? [
          events.NodeScheduled({
            path: route.name,
            phase: 'do',
            attempt: 1,
            key: await keyOfNextVisit(tx, runId, route.name),
            jobId: null,
            at,
          }),
        ]
      : [events.RunCompleted({ output: route.output, at, keepUntil: route.keepUntil })];

  /** A wait that cannot go on: the node is marked failed, and the run fails with the same text. */
  const failWait = async (tx: Tx, def: WorkflowDef, row: Row, path: string, error: string, at: string) => {
    const [step] = await tx
      .select({ attempt: workflowSteps.attempt })
      .from(workflowSteps)
      .where(and(eq(workflowSteps.runId, row.id), eq(workflowSteps.path, path), eq(workflowSteps.phase, 'do')));
    return [
      events.NodeFailed({ path, phase: 'do', attempt: Math.max(step?.attempt ?? 1, 1), error, at }),
      runFailed(def, error, at),
    ];
  };

  /** The wait node `index` is over with `result`: it completes and the run goes on. */
  const completeWait = async (tx: Tx, def: WorkflowDef, index: number, row: Row, result: unknown, at: string) => {
    const path = def.nodes[index]?.name ?? '';
    let route: Route;
    try {
      route = await routeAt(def, index + 1, row, path, result);
    } catch (error) {
      // No step is left to retry: a finish or output that fails now would fail again.
      return failWait(tx, def, row, path, reasonText(error), at);
    }
    return [
      events.NodeCompleted({ path, phase: 'do', result, resolvedBy: null, at }),
      ...(await eventsAfter(tx, row.id, route, at)),
    ];
  };

  /** The oldest signal of this name nobody has taken, now taken by `path`. */
  const takeSignal = async (tx: Tx, runId: string, name: string, path: string) => {
    const [early] = await tx
      .select()
      .from(workflowSignals)
      .where(and(eq(workflowSignals.runId, runId), eq(workflowSignals.name, name), isNull(workflowSignals.consumedAt)))
      .orderBy(asc(workflowSignals.receivedAt), asc(workflowSignals.id))
      .limit(1);
    if (early === undefined) return;
    await tx
      .update(workflowSignals)
      .set({ consumedAt: new Date(), consumedBy: path })
      .where(eq(workflowSignals.id, early.id));
    return early;
  };

  /** A `waitFor` node got its signal: the payload is checked with the node's schema and becomes the node's result. */
  const wakeOnSignal = async (tx: Tx, def: WorkflowDef, index: number, row: Row, payload: unknown, at: string) => {
    const node = def.nodes[index];
    if (node === undefined || node.kind !== 'waitFor') {
      throw new JournalError('BAD_DEFINITION', 'workflow', row.id, `node ${index} of "${def.name}" is not a waitFor`);
    }
    // The door checked this payload with the signal's one schema, so it parses here too.
    const parsed = await parseAsync(node.schema, payload);
    const stored = storable(parsed, def.limits.payload, `the payload of '${node.name}'`, row.id);
    if (stored instanceof JournalError) {
      return failWait(tx, def, row, node.name, `waitFor '${node.name}': ${reasonText(stored)}`, at);
    }
    return completeWait(tx, def, index, row, stored.value, at);
  };

  /** A timer fired. It acts only if the run is still parked on the very park the timer was made for. */
  const onTimer = async (tx: Tx, row: Row, fired: z.infer<typeof timerCheckpointSchema>['fired'], at: string) => {
    const def = definitionOf(row);
    if (fired.kind === 'deadline') return deadlineEvents(def, at);
    // A timer of a park the run already left finds the run elsewhere and does nothing. A run in a loop can park on
    // the same node again: only the timer of its latest park may end that wait.
    if (row.state !== 'parked' || row.node !== fired.node) return [];
    const [latestPark] = await tx
      .select({ seq: tables.events.seq })
      .from(tables.events)
      .where(and(eq(tables.events.entityId, row.id), eq(tables.events.type, 'Parked')))
      .orderBy(desc(tables.events.seq))
      .limit(1);
    if (latestPark?.seq !== fired.parkSeq) return [];
    if (pastDeadline(row)) return deadlineEvents(def, at);
    const index = def.nodes.findIndex(candidate => candidate.name === fired.node);
    const node = def.nodes[index];
    if (node === undefined || (node.kind !== 'waitFor' && node.kind !== 'sleep')) {
      throw new JournalError('BAD_DEFINITION', 'workflow', row.id, `"${def.name}" has no wait node '${fired.node}'`);
    }
    const timerFired = events.TimerFired({ node: fired.node, at });
    if (node.kind === 'waitFor' && node.onTimeout === 'fail') {
      const error = `waitFor '${node.name}' got no '${node.signal}' signal in time`;
      return [timerFired, ...(await failWait(tx, def, row, node.name, error, at))];
    }
    // `sleep` is over, or `waitFor` goes on without a payload.
    return [timerFired, ...(await completeWait(tx, def, index, row, null, at))];
  };

  /** Gives the timer jobs a write just queued their `run_id`, in the same transaction, before any worker can see them. */
  const linkTimers = async (tx: Tx, runId: string, seqs: readonly number[]) => {
    if (seqs.length === 0) return;
    await tx
      .update(tables.jobs)
      .set({ runId })
      .where(and(eq(tables.jobs.effect, TIMER_EFFECT), inArray(tables.jobs.eventSeq, [...seqs])));
  };

  /**
   * Cancels the timers a run no longer needs, in the transaction that moved it: the wake timer of a park it left,
   * and the deadline timer of a run that ended. A timer a worker holds is left alone: it finds nothing to do.
   */
  const cancelTimers = async (tx: Tx, runId: string, gone: { readonly park: boolean; readonly deadline: boolean }) => {
    const types = [...(gone.park ? ['Parked'] : []), ...(gone.deadline ? ['RunStarted'] : [])];
    if (types.length === 0) return;
    const pending = await tx
      .select({ id: tables.jobs.id })
      .from(tables.jobs)
      .innerJoin(tables.events, eq(tables.events.seq, tables.jobs.eventSeq))
      .where(
        and(
          eq(tables.jobs.runId, runId),
          eq(tables.jobs.effect, TIMER_EFFECT),
          isNull(tables.jobs.deadAt),
          or(isNull(tables.jobs.leaseUntil), lte(tables.jobs.leaseUntil, sql`now()`)),
          inArray(tables.events.type, types),
        ),
      );
    for (const job of pending) {
      try {
        await jobOps.cancel(tx, job.id, { actor: WORKFLOW_ACTOR, reason: 'the run moved on' });
      } catch (error) {
        // A worker claimed it between the read and the cancel: it runs, finds the run moved, and writes nothing.
        if (!isJournalError(error, 'JOB_RUNNING') && !isJournalError(error, 'JOB_NOT_PENDING')) throw error;
      }
    }
  };

  type RunEvent = {
    [Name in keyof typeof events]: RecordedOf<(typeof events)[Name], MetaOut, string>;
  }[keyof typeof events];
  /** After a write: the step jobs and the timer jobs it queued get their run, and the step rows their job. */
  const queueJobs = async (tx: Tx, runId: string, written: readonly RunEvent[]) => {
    await linkJobs(
      tx,
      runId,
      written.flatMap(event =>
        event.type === 'NodeScheduled' ? [{ seq: event.seq, path: event.data.path, phase: event.data.phase }] : [],
      ),
    );
    await linkTimers(
      tx,
      runId,
      written.map(event => event.seq),
    );
  };

  const checkpoint = j.command(
    CHECKPOINT_COMMAND,
    checkpointSchema,
    async (input, { write, tx }): Promise<{ readonly status: 'checkpointed' | 'already' }> => {
      const before = { parked: false };
      const written = await write(run, input.runId, async (row, inside) => {
        if (row === null || row.finishedAt !== null) return [];
        before.parked = row.state === 'parked';
        const at = nowIso();
        if ('fired' in input) return onTimer(inside.tx, row, input.fired, at);
        const [step] = await inside.tx
          .select()
          .from(workflowSteps)
          .where(
            and(
              eq(workflowSteps.runId, input.runId),
              eq(workflowSteps.path, input.path),
              eq(workflowSteps.phase, 'do'),
            ),
          );
        // Another checkpoint already moved this node on, or a later attempt replaced the one this answers.
        if (
          step === undefined ||
          step.attempt !== input.attempt ||
          (step.status !== 'scheduled' && step.status !== 'failed')
        ) {
          return [];
        }
        const { outcome } = input;
        switch (outcome.kind) {
          case 'completed': {
            return [
              events.NodeCompleted({ path: input.path, phase: 'do', result: outcome.result, resolvedBy: null, at }),
              ...(await eventsAfter(inside.tx, input.runId, outcome.route, at)),
            ];
          }
          case 'skipped': {
            return [
              events.NodeSkipped({ path: input.path, phase: 'do', reason: outcome.reason, actorId: null, at }),
              ...(await eventsAfter(inside.tx, input.runId, outcome.route, at)),
            ];
          }
          case 'retry': {
            return [
              events.NodeFailed({ path: input.path, phase: 'do', attempt: input.attempt, error: outcome.error, at }),
              events.NodeScheduled({
                path: input.path,
                phase: 'do',
                attempt: input.attempt + 1,
                key: outcome.key,
                jobId: null,
                at: outcome.at,
              }),
            ];
          }
          case 'dead': {
            return [
              events.NodeFailed({ path: input.path, phase: 'do', attempt: input.attempt, error: outcome.error, at }),
            ];
          }
          case 'park': {
            // The park of this attempt is already in: the step row stays `scheduled` while a run is parked.
            if (row.state === 'parked') return [];
            const def = definitionOf(row);
            const index = def.nodes.findIndex(candidate => candidate.name === input.path);
            const node = def.nodes[index];
            if (node === undefined || (node.kind !== 'waitFor' && node.kind !== 'sleep')) {
              throw new JournalError(
                'BAD_DEFINITION',
                'workflow',
                row.id,
                `"${def.name}" has no wait node '${input.path}'`,
              );
            }
            if (pastDeadline(row)) return deadlineEvents(def, at);
            if (node.kind === 'waitFor') {
              // The signal came before the run got here: it was kept, and this wait takes it.
              const early = await takeSignal(inside.tx, row.id, node.signal, node.name);
              if (early !== undefined) return wakeOnSignal(inside.tx, def, index, row, early.payload, at);
            }
            return [events.Parked({ node: input.path, waitingFor: outcome.waitingFor, wakeAt: outcome.wakeAt, at })];
          }
        }
      });
      if (isFailure(written))
        throw new Error(`journal: the workflow checkpoint was refused: ${JSON.stringify(written)}`);
      await queueJobs(tx, input.runId, written.events);
      const ended = endedBy(written.events);
      await cancelTimers(tx, input.runId, { park: before.parked && ended.park, deadline: ended.deadline });
      return { status: written.events.length === 0 ? 'already' : 'checkpointed' };
    },
  );

  const startCommandFor = <Input extends StandardSchemaV1>(def: WorkflowDef<Input>) => {
    const first = def.nodes[0];
    return j.command(
      `${def.name}.start`,
      startSchema(def.input),
      async (args, { write, tx }): Promise<StartOutcome> => {
        if (!started.has(`${def.name}@${def.version}`)) {
          throw new JournalError(
            'WORKFLOW_UNKNOWN',
            'workflow',
            def.name,
            `workflow "${def.name}" v${def.version} is not registered; pass it to compose({ workflows })`,
          );
        }
        if (first === undefined)
          throw new JournalError('BAD_DEFINITION', 'workflow', def.name, 'a workflow needs a node');
        const stored = storable(args.input, def.limits.payload, 'the input', def.name);
        if (stored instanceof JournalError) return CommandConflict({ detail: stored.message });
        const runId = args.id ?? workflowRunId();
        const now = new Date();
        const at = now.toISOString();
        const written = await write(machine.run, runId, row => {
          if (row !== null) return [];
          return [
            machine.events.RunStarted({
              name: def.name,
              workflowVersion: def.version,
              shape: def.shape,
              shapeHash: def.shapeHash,
              input: stored.value,
              deadlineAt: def.deadline === undefined ? null : inMs(parseAge(def.deadline)),
              parentId: null,
              parentPath: null,
              concurrencyKey: null,
              at,
            }),
            machine.events.NodeScheduled({
              path: first.name,
              phase: 'do',
              attempt: 1,
              key: `${runId}:${first.name}:do`,
              jobId: null,
              at,
            }),
          ];
        });
        if (isFailure(written)) return written;
        const { row } = written;
        // The id is taken. The same start again is the same run; another workflow or another input is not.
        if (written.events.length === 0) {
          if (
            row === null ||
            row.name !== def.name ||
            row.workflowVersion !== def.version ||
            !sameValue(row.input, stored.value)
          ) {
            return CommandConflict({ detail: `run id "${runId}" already belongs to another run` });
          }
          return { runId };
        }
        await queueJobs(tx, runId, written.events);
        debugWorkflow.debug('{name} v{version}: run {runId} started', { name: def.name, version: def.version, runId });
        return { runId };
      },
    );
  };

  /** `def.signal(name)`: the command that delivers one of the definition's signals. */
  const signalCommandFor = <Signals extends AnySignals>(def: WorkflowDef<StandardSchemaV1, unknown, Signals>) =>
    function signal<Name extends keyof Signals & string>(name: Name) {
      // One signal name has one payload schema, which `define` enforces: the first node that waits for it has it.
      const waiting = def.nodes.find(node => node.kind === 'waitFor' && node.signal === name);
      if (waiting === undefined || waiting.kind !== 'waitFor') {
        throw new JournalError('BAD_DEFINITION', 'workflow', def.name, `no waitFor node waits for signal '${name}'`);
      }
      const payloadSchema = waiting.schema;
      return j.command(
        `${def.name}.signal.${name}`,
        signalSchemaFor<Signals[Name]>(),
        async (args, { write, tx }): Promise<SignalOutcome> => {
          if (!started.has(`${def.name}@${def.version}`)) {
            throw new JournalError(
              'WORKFLOW_UNKNOWN',
              'workflow',
              def.name,
              `workflow "${def.name}" v${def.version} is not registered; pass it to compose({ workflows })`,
            );
          }
          // A payload the wait would refuse is refused at the door, so a bad webhook cannot fail the run.
          const stored = storable(args.payload, def.limits.payload, `the payload of signal '${name}'`, args.runId);
          if (stored instanceof JournalError) return CommandInvalid({ detail: stored.message });
          try {
            await parseAsync(payloadSchema, stored.value);
          } catch (error) {
            if (error instanceof SchemaError) {
              return CommandInvalid({ detail: `signal '${name}' payload: ${reasonText(error)}` });
            }
            throw error;
          }
          const result: { status: 'kept' | 'woke' | 'duplicate' | 'finished' } = { status: 'kept' };
          const before = { parked: false };
          const written = await write(run, args.runId, async (row, inside) => {
            if (row === null) return CommandNotFound({ detail: `no workflow run "${args.runId}"` });
            if (row.name !== def.name || row.workflowVersion !== def.version) {
              return CommandConflict({ detail: `run "${args.runId}" belongs to another workflow` });
            }
            if (row.shapeHash !== def.shapeHash) {
              throw new JournalError(
                'WORKFLOW_SHAPE_CHANGED',
                'workflow',
                row.id,
                `"${def.name}" v${def.version} has other nodes than this run started with`,
              );
            }
            // A signal for a finished run is dropped: a late webhook is not an error the sender should retry.
            if (row.finishedAt !== null) {
              result.status = 'finished';
              return [];
            }
            const [inserted] = await inside.tx
              .insert(workflowSignals)
              .values({
                id: workflowSignalId(),
                runId: row.id,
                name,
                deliveryId: args.deliveryId,
                payload: stored.value,
              })
              .onConflictDoNothing()
              .returning({ id: workflowSignals.id });
            if (inserted === undefined) {
              result.status = 'duplicate';
              return [];
            }
            before.parked = row.state === 'parked';
            const at = nowIso();
            const received = events.SignalReceived({ name, deliveryId: args.deliveryId, at });
            if (pastDeadline(row)) return [received, ...deadlineEvents(def, at)];
            const index =
              row.state === 'parked' && row.waitingFor === name ? def.nodes.findIndex(n => n.name === row.node) : -1;
            const node = def.nodes[index];
            if (node === undefined || node.kind !== 'waitFor' || node.signal !== name) return [received];
            // The run waits for this signal: it is taken now, and the run moves on in this same commit.
            await takeSignal(inside.tx, row.id, name, node.name);
            result.status = 'woke';
            return [received, ...(await wakeOnSignal(inside.tx, def, index, row, stored.value, at))];
          });
          if (isFailure(written)) return written;
          await queueJobs(tx, args.runId, written.events);
          const ended = endedBy(written.events);
          await cancelTimers(tx, args.runId, { park: before.parked && ended.park, deadline: ended.deadline });
          return result;
        },
      );
    };

  /** `j.workflow`: the step-2 builder, with `start` and `signal` on the finished definition. */
  const workflow: JournalDefinitions<Meta, Tx, AppDb>['workflow'] = (name, options) =>
    workflowWith(name, options, def => ({ start: startCommandFor(def), signal: signalCommandFor(def) }));

  type StepEffectContext = EffectContext<AppDb, RootCommandRunner<Meta, Tx>> & Needed<Needs>;

  /**
   * Registers the definitions: the step effect that runs their nodes, and the projection that keeps `workflow_steps`.
   * `meta` is the actor recorded on every checkpoint the library commits.
   */
  function register(defs: readonly WorkflowDef[], meta: SchemaInput<Meta>) {
    const registry = new Map<string, WorkflowDef>();
    for (const def of defs) {
      const id = `${def.name}@${def.version}`;
      if (registry.has(id)) {
        throw new JournalError(
          'BAD_DEFINITION',
          'workflow',
          def.name,
          `workflow "${def.name}" v${def.version} is registered twice`,
        );
      }
      const unsupported = def.nodes.find(node => node.kind === 'child' || node.kind === 'map');
      if (unsupported !== undefined) {
        throw new JournalError(
          'BAD_DEFINITION',
          'workflow',
          def.name,
          `node '${unsupported.name}' is a ${unsupported.kind}; the runner runs step, waitFor and sleep nodes only so far`,
        );
      }
      registry.set(id, def);
      started.set(id, def);
    }
    const needs: Needs = Object.fromEntries(defs.flatMap(def => Object.entries(def.needs)));

    /**
     * Stores the key the body will see, so a retry keeps it. The attempt is not marked running: a step is running
     * while its job holds a live lease (`stepStatusSql`).
     */
    const recordKey = (ctx: StepEffectContext, runId: string, path: string, attempt: number, key: string) =>
      ctx.db
        .update(workflowSteps)
        .set({ key })
        .where(
          and(
            eq(workflowSteps.runId, runId),
            eq(workflowSteps.path, path),
            eq(workflowSteps.phase, 'do'),
            eq(workflowSteps.attempt, attempt),
            inArray(workflowSteps.status, ['scheduled', 'failed']),
          ),
        );

    type NodeScheduledEvent = RecordedOf<typeof machine.events.NodeScheduled, MetaOut, string>;
    type StepNode = Extract<WorkflowNode, { readonly kind: 'step' }>;

    /** The body of one node attempt, bounded by the step's timeout. A timeout aborts `signal` and fails the attempt. */
    async function runBody(
      node: StepNode,
      build: (signal: AbortSignal) => ErasedContext,
      signal: AbortSignal,
      runId: string,
    ) {
      const timeoutMs = node.options.timeout === undefined ? undefined : parseAge(node.options.timeout);
      if (timeoutMs === undefined) return node.run(build(signal));
      const timeout = new AbortController();
      let timer: ReturnType<typeof setTimeout> | undefined;
      const expired = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          const error = new JournalError(
            'STEP_TIMEOUT',
            'workflow',
            runId,
            `step '${node.name}' ran longer than ${timeoutMs} ms`,
          );
          timeout.abort(error);
          reject(error);
        }, timeoutMs);
      });
      try {
        return await Promise.race([
          Promise.resolve().then(() => node.run(build(AbortSignal.any([signal, timeout.signal])))),
          expired,
        ]);
      } finally {
        clearTimeout(timer);
      }
    }

    /** Where the run goes after `index`, once its result is `result`. A `next` that is not an earlier node is a bad definition. */
    async function routeFrom(
      def: WorkflowDef,
      index: number,
      node: StepNode,
      row: Row,
      result: unknown,
      build: (signal: AbortSignal) => ErasedContext,
      signal: AbortSignal,
    ): Promise<Route> {
      const { next } = node.options;
      const target = typeof next === 'function' ? next({ ...build(signal), result }) : (next ?? 'next');
      let targetIndex = index + 1;
      if (target !== 'next') {
        targetIndex = def.nodes.findIndex(candidate => candidate.name === target);
        if (targetIndex < 0 || targetIndex >= index) {
          throw new JournalError(
            'BAD_DEFINITION',
            'workflow',
            row.id,
            `step '${node.name}' routed to '${target}', which is not an earlier node; next may only jump back`,
          );
        }
      }
      return routeAt(def, targetIndex, row, node.name, result);
    }

    /** Runs one attempt of a node: key, `when`, body, result checks, routing. Never throws for a failure of the step itself. */
    async function attemptNode(
      def: WorkflowDef,
      index: number,
      node: StepNode,
      row: Row,
      event: NodeScheduledEvent,
      ctx: StepEffectContext,
    ): Promise<Verdict> {
      const { data } = event;
      const build =
        (key: string) =>
        (signal: AbortSignal): ErasedContext => ({
          ...ctx,
          runId: row.id,
          path: data.path,
          attempt: data.attempt,
          input: row.input,
          results: row.results,
          key,
          signal,
        });
      let key = data.key;
      try {
        if (node.options.key !== undefined) key = node.options.key(build(data.key)(ctx.signal));
        if (typeof key !== 'string' || key === '')
          throw new Error('the step key function must return a non-empty string');
      } catch (error) {
        return failed(error, false);
      }
      await recordKey(ctx, row.id, data.path, data.attempt, key);
      const make = build(key);

      try {
        if (node.options.when !== undefined && !node.options.when(make(ctx.signal))) {
          return { kind: 'skipped', reason: 'when', route: await routeAt(def, index + 1, row, node.name, null) };
        }
      } catch (error) {
        return failed(error);
      }

      let result: unknown;
      try {
        result = await runBody(node, make, ctx.signal, row.id);
      } catch (error) {
        return failed(error);
      }
      if (isFailure(result)) return failed(result);

      try {
        const parsed = node.options.output === undefined ? result : await parseAsync(node.options.output, result);
        const kept = storable(parsed, def.limits.payload, `the result of step '${node.name}'`, row.id);
        if (kept instanceof JournalError) return failed(kept);
        return {
          kind: 'completed',
          result: kept.value,
          route: await routeFrom(def, index, node, row, kept.value, make, ctx.signal),
        };
      } catch (error) {
        // A router, a `finish` or an output schema that fails will fail again: no retry, the definition needs a fix.
        return failed(error, !(error instanceof JournalError && error.code === 'BAD_DEFINITION'));
      }
    }

    /** The park of a `waitFor` or `sleep` node: when it wakes by itself, and for which signal it waits. */
    function attemptWait(
      node: Extract<WorkflowNode, { readonly kind: 'waitFor' | 'sleep' }>,
      row: Row,
      event: NodeScheduledEvent,
      ctx: StepEffectContext,
    ): Verdict {
      try {
        if (node.kind === 'waitFor') {
          const wakeAt = node.timeout === undefined ? null : inMs(parseAge(node.timeout));
          return { kind: 'park', waitingFor: node.signal, wakeAt };
        }
        const { until } = node;
        const due =
          typeof until === 'function'
            ? until({
                ...ctx,
                runId: row.id,
                path: event.data.path,
                attempt: event.data.attempt,
                input: row.input,
                results: row.results,
                key: event.data.key,
                signal: ctx.signal,
              })
            : new Date(Date.now() + parseAge(until));
        if (!(due instanceof Date) || Number.isNaN(due.getTime())) {
          throw new TypeError(`sleep '${node.name}' needs a valid Date to wake at`);
        }
        return { kind: 'park', waitingFor: null, wakeAt: due.toISOString() };
      } catch (error) {
        return failed(error);
      }
    }

    async function runNode(event: NodeScheduledEvent, ctx: StepEffectContext): Promise<unknown> {
      const { data } = event;
      const runId = event.entityId;
      if (data.phase !== 'do') {
        throw new JournalError(
          'BAD_DEFINITION',
          'workflow',
          runId,
          `step '${data.path}' is an undo; compensation is not run yet`,
        );
      }
      const [row] = await ctx.db.select().from(workflowRuns).where(eq(workflowRuns.id, runId));
      if (row === undefined || row.finishedAt !== null) return undefined;
      const [step] = await ctx.db
        .select()
        .from(workflowSteps)
        .where(and(eq(workflowSteps.runId, runId), eq(workflowSteps.path, data.path), eq(workflowSteps.phase, 'do')));
      // Already checkpointed, or replaced by a later attempt: this job has nothing left to do.
      if (step === undefined || step.attempt !== data.attempt || step.status === 'done' || step.status === 'skipped') {
        return undefined;
      }
      const def = registry.get(`${row.name}@${row.workflowVersion}`);
      if (def === undefined) {
        throw new JournalError(
          'WORKFLOW_UNKNOWN',
          'workflow',
          runId,
          `no registered workflow "${row.name}" v${row.workflowVersion}`,
        );
      }
      if (def.shapeHash !== row.shapeHash) {
        throw new JournalError(
          'WORKFLOW_SHAPE_CHANGED',
          'workflow',
          runId,
          `"${row.name}" v${row.workflowVersion} has other nodes than this run started with`,
        );
      }
      const index = def.nodes.findIndex(candidate => candidate.name === data.path);
      const node = def.nodes[index];
      if (node === undefined || node.kind === 'child' || node.kind === 'map') {
        throw new JournalError(
          'BAD_DEFINITION',
          'workflow',
          runId,
          `"${row.name}" has no runnable node '${data.path}'`,
        );
      }

      const verdict =
        node.kind === 'step'
          ? await attemptNode(def, index, node, row, event, ctx)
          : attemptWait(node, row, event, ctx);

      if (verdict.kind !== 'failed') {
        const checkpointed = await ctx.run(
          checkpoint,
          { runId, path: data.path, attempt: data.attempt, outcome: verdict },
          meta,
        );
        debugWorkflow.debug('{runId} {path}: {kind}, checkpoint {status}', {
          runId,
          path: data.path,
          kind: verdict.kind,
          status: checkpointed.status,
        });
        return undefined;
      }
      // A stop or a lost lease aborts the body too. That is not the step failing: leave the job to be run again.
      if (ctx.signal.aborted) {
        throw new Error(`journal: the worker stopped or lost its lease during step '${data.path}'`, {
          cause: ctx.signal.reason,
        });
      }
      const error = reasonText(verdict.reason);
      const policy = (node.kind === 'step' ? node.options.retry : undefined) ?? defaultEffectRetry;
      const wait = verdict.retryable ? policy.delay(data.attempt, verdict.reason) : undefined;
      if (wait !== undefined) {
        await ctx.run(
          checkpoint,
          {
            runId,
            path: data.path,
            attempt: data.attempt,
            outcome: { kind: 'retry', error, key: step.key ?? data.key, at: inMs(wait) },
          },
          meta,
        );
        return undefined;
      }
      const checkpointed = await ctx.run(
        checkpoint,
        { runId, path: data.path, attempt: data.attempt, outcome: { kind: 'dead', error } },
        meta,
      );
      if (checkpointed.status === 'already') return undefined;
      debugWorkflow.warn('{runId} {path}: dead after {attempt} attempts, waiting for an operator', {
        runId,
        path: data.path,
        attempt: data.attempt,
      });
      return StepDead({ detail: `step '${data.path}' of run ${runId} is dead: ${error}` });
    }

    const effect = j
      .effect(STEP_EFFECT, machine.run, needs, { NodeScheduled: (event, ctx) => runNode(event, ctx) })
      .withSchedule({
        // A retry is due at the time its event names; a first try is due now.
        runAt: event => new Date(dueAtOf(event.data)),
      });

    /**
     * A park's wake time and a run's deadline. The job is due at the event's time; when it fires, the checkpoint
     * command acts only if the run is still parked on that park (or unfinished, for the deadline).
     */
    const timer = j
      .effect(TIMER_EFFECT, machine.run, {
        Parked: async (event, ctx) => {
          await ctx.run(
            checkpoint,
            { runId: event.entityId, fired: { kind: 'wake', node: event.data.node, parkSeq: event.seq } },
            meta,
          );
        },
        RunStarted: async (event, ctx) => {
          await ctx.run(checkpoint, { runId: event.entityId, fired: { kind: 'deadline' } }, meta);
        },
      })
      .withSchedule({
        // Only a park with a wake time and a run with a deadline have anything to time.
        when: event => timerAt(event.data) !== null,
        runAt: event => timerDueAt(event.data),
      });

    return { effects: [effect, timer], steps: machine.steps };
  }

  return { workflow, register };
}

const dueSchema = z.object({ at: isoTime });
/** `at` of a `NodeScheduled` event, from the untyped data an effect schedule sees. */
function dueAtOf(data: unknown): string {
  return dueSchema.parse(data).at;
}

const timerDueSchema = z.union([
  z.object({ wakeAt: isoTime.nullable() }),
  z.object({ deadlineAt: isoTime.nullable() }),
]);
/** The time of a timer, from the untyped data of a `Parked` or `RunStarted` event; null when the event has nothing to time. */
function timerAt(data: unknown): Date | null {
  const parsed = timerDueSchema.parse(data);
  const at = 'wakeAt' in parsed ? parsed.wakeAt : parsed.deadlineAt;
  return at === null ? null : new Date(at);
}
/** When a timer job is due. `when` lets only timed events through, so an untimed one here is a bug. */
function timerDueAt(data: unknown): Date {
  const at = timerAt(data);
  if (at === null) {
    throw new JournalError(
      'BAD_DEFINITION',
      'workflow',
      '',
      'journal: the timer effect got an event with no time to wait for',
    );
  }
  return at;
}
