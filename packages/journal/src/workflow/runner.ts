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
import { and, count, eq, inArray, sql } from 'drizzle-orm';
import { z } from 'zod';

import type { SchemaInput, SchemaOutput, StandardSchemaV1 } from '@arki/schema';
import { defineFailure, isFailure } from '@arki/failure';
import { parseAsync, SchemaError } from '@arki/schema';

import type { Command, JournalDefinitions, RootCommandRunner } from '../api.js';
import type { JournalTables } from '../pg.js';
import type { EffectContext, Needed, Needs, RecordedOf, RootDb, TransactionSource } from '../types.js';
import type { ErasedContext, WorkflowDef, WorkflowNode } from './define.js';
import { debugWorkflow } from '../debug.js';
import { CommandConflict, JournalError } from '../errors.js';
import { workflowRunId } from '../id.js';
import { parseAge } from '../retention.js';
import { isPlainObject, sameValue } from '../storage.js';
import { defaultEffectRetry } from '../worker.js';
import { workflowWith } from './define.js';
import { workflowMachine } from './machine.js';

/** The library-owned effect that runs one node attempt. */
export const STEP_EFFECT = 'workflow.step';
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
> = {
  readonly start: Command<StartSchema<Input>, Promise<StartOutcome>, SchemaOutput<Meta>, Tx>;
};

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
const checkpointSchema = z.object({
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
  ]),
});

type Verdict =
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
>(j: Definitions<Meta, Tx, AppDb>, tables: JournalTables) {
  type MetaOut = SchemaOutput<Meta>;
  const machine = workflowMachine<Meta, Tx>(j, tables);
  const { run, events } = machine;
  const { workflowRuns, workflowSteps } = tables;

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

  const checkpoint = j.command(
    CHECKPOINT_COMMAND,
    checkpointSchema,
    async (input, { write, tx }): Promise<{ readonly status: 'checkpointed' | 'already' }> => {
      const written = await write(run, input.runId, async (row, inside) => {
        if (row === null || row.finishedAt !== null) return [];
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
        const at = new Date().toISOString();
        const after = async (route: Route) =>
          route.go === 'node'
            ? [
                events.NodeScheduled({
                  path: route.name,
                  phase: 'do',
                  attempt: 1,
                  key: await keyOfNextVisit(inside.tx, input.runId, route.name),
                  jobId: null,
                  at,
                }),
              ]
            : [events.RunCompleted({ output: route.output, at, keepUntil: route.keepUntil })];
        const { outcome } = input;
        switch (outcome.kind) {
          case 'completed': {
            return [
              events.NodeCompleted({ path: input.path, phase: 'do', result: outcome.result, resolvedBy: null, at }),
              ...(await after(outcome.route)),
            ];
          }
          case 'skipped': {
            return [
              events.NodeSkipped({ path: input.path, phase: 'do', reason: outcome.reason, actorId: null, at }),
              ...(await after(outcome.route)),
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
        }
      });
      if (isFailure(written))
        throw new Error(`journal: the workflow checkpoint was refused: ${JSON.stringify(written)}`);
      const queued = written.events.flatMap(event =>
        event.type === 'NodeScheduled' ? [{ seq: event.seq, path: event.data.path, phase: event.data.phase }] : [],
      );
      await linkJobs(tx, input.runId, queued);
      return { status: written.events.length === 0 ? 'already' : 'checkpointed' };
    },
  );

  /** The `name@version` of every definition a `compose({ workflows })` of this `initJournal()` registered. A start of any other has no step effect to queue its job for. */
  const started = new Set<string>();

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
        await linkJobs(
          tx,
          runId,
          written.events.flatMap(event =>
            event.type === 'NodeScheduled' ? [{ seq: event.seq, path: event.data.path, phase: event.data.phase }] : [],
          ),
        );
        debugWorkflow.debug('{name} v{version}: run {runId} started', { name: def.name, version: def.version, runId });
        return { runId };
      },
    );
  };

  /** `j.workflow`: the step-2 builder, with `start` on the finished definition. */
  const workflow: JournalDefinitions<Meta, Tx, AppDb>['workflow'] = (name, options) =>
    workflowWith(name, options, def => ({ start: startCommandFor(def) }));

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
      const unsupported = def.nodes.find(node => node.kind !== 'step');
      if (unsupported !== undefined) {
        throw new JournalError(
          'BAD_DEFINITION',
          'workflow',
          def.name,
          `node '${unsupported.name}' is a ${unsupported.kind}; the runner runs step nodes only so far`,
        );
      }
      registry.set(id, def);
      started.add(id);
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
    type Row = typeof workflowRuns.$inferSelect;
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
      if (node === undefined || node.kind !== 'step') {
        throw new JournalError('BAD_DEFINITION', 'workflow', runId, `"${row.name}" has no step '${data.path}'`);
      }

      const verdict = await attemptNode(def, index, node, row, event, ctx);

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
      const policy = node.options.retry ?? defaultEffectRetry;
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

    return { effect, steps: machine.steps };
  }

  return { workflow, register };
}

const dueSchema = z.object({ at: isoTime });
/** `at` of a `NodeScheduled` event, from the untyped data an effect schedule sees. */
function dueAtOf(data: unknown): string {
  return dueSchema.parse(data).at;
}
