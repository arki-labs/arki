/**
 * Command execution: parse the input, open the transaction, give the handler a
 * context bound to it, and refuse to close while an operation is still running.
 * A returned failure rolls the transaction back and is the run's result.
 * May import `api`, `write` (types), `storage`, `transaction-guard` and leaf files.
 * Must not import `journal`, `history` or `worker`.
 */
import { eq, is } from 'drizzle-orm';
import { PgAsyncTransaction } from 'drizzle-orm/pg-core';

import type { SchemaInput, SchemaOutput, StandardSchemaV1 } from '@arki/schema';
import { parseAsync } from '@arki/schema';

import type { Command, CommandContext, RunOptions } from './api.js';
import type { HookPointInternal } from './hooks.js';
import type { JournalTables } from './pg.js';
import type { CommandHookContext, DbHandle, Trace, TransactionSource } from './types.js';
import type { Writer } from './write.js';
import { debugCommand } from './debug.js';
import { JournalError } from './errors.js';
import { commandId, correlationId } from './id.js';
import { trackRefusals } from './refusals.js';
import { isReturnedFailure, rollbackOnFailure } from './rollback.js';
import { assertRoundTrips, sameValue } from './storage.js';
import { oneAtATime } from './transaction-guard.js';

/** What JSON storage keeps of `value`. `undefined` has no JSON form, so it comes back as `undefined` here too. */
const throughJson = (value: unknown): unknown =>
  // eslint-disable-next-line unicorn/prefer-structured-clone -- JSON semantics on purpose: this is what the column stores
  value === undefined ? undefined : JSON.parse(JSON.stringify(value));

/** What command execution needs from the journal. */
export type CommandDeps<
  Meta extends StandardSchemaV1<unknown, Record<string, unknown>>,
  Tx extends TransactionSource<Tx>,
> = {
  readonly metaSchema: Meta;
  readonly writeWithValidatedMeta: Writer<Meta, Tx>['writeWithValidatedMeta'];
  /** Wakes this journal's workers. Called after a root-database run that queued a job. */
  readonly wake: () => void;
  /** The command hooks. Frozen by the first run. */
  readonly hooks: HookPointInternal<CommandHookContext<SchemaOutput<Meta>>>;
  readonly tables: Pick<JournalTables, 'receipts'>;
};

export function createCommandRunner<
  Meta extends StandardSchemaV1<unknown, Record<string, unknown>>,
  Tx extends TransactionSource<Tx>,
>(deps: CommandDeps<Meta, Tx>) {
  type MetaOut = SchemaOutput<Meta>;
  const { metaSchema, writeWithValidatedMeta, hooks } = deps;
  const receipts = deps.tables.receipts;

  /**
   * Take the key for this run, or find the run that holds it. Returns `{ replay }` with the
   * stored result when a finished run holds the key with the same command and input. The
   * insert waits on an uncommitted holder, so a concurrent repeat sees its outcome.
   */
  const claimReceipt = async (
    tx: DbHandle,
    key: string,
    name: string,
    input: unknown,
    own: string,
  ): Promise<{ readonly replay: unknown } | undefined> => {
    const inserted = await tx
      .insert(receipts)
      .values({ key, command: name, input: throughJson(input) ?? null, commandId: own })
      .onConflictDoNothing()
      .returning({ key: receipts.key });
    if (inserted.length > 0) return undefined;
    const [held] = await tx.select().from(receipts).where(eq(receipts.key, key));
    if (held === undefined)
      throw new Error(`journal: idempotency key ${JSON.stringify(key)} vanished while it was being claimed`);
    // Only a run inside this transaction can see an unfinished receipt: a concurrent one waited on the insert.
    if (held.result === null)
      throw new Error(
        `journal: idempotency key ${JSON.stringify(key)} is held by a run of "${held.command}" that has not finished; a key cannot be reused inside its own transaction`,
      );
    if (held.command !== name)
      throw new JournalError(
        'CONFLICT',
        'receipt',
        key,
        `the idempotency key is held by command "${held.command}", not "${name}"`,
      );
    if (!sameValue(held.input, throughJson(input) ?? null))
      throw new JournalError(
        'CONFLICT',
        'receipt',
        key,
        `the idempotency key was used by command "${name}" with a different input`,
      );
    return { replay: 'value' in held.result ? held.result.value : undefined };
  };

  /** Store the result under the key. It must survive JSON, because the replay returns the stored form. */
  const storeReceipt = async (tx: DbHandle, key: string, name: string, value: unknown): Promise<void> => {
    const stored = throughJson(value);
    if (!sameValue(stored, value))
      throw new JournalError(
        'UNSTABLE_SCHEMA',
        'command',
        name,
        `the result of command "${name}" does not survive JSON storage; a command run with an idempotency key must return plain data, because a repeat returns the stored result`,
      );
    await tx
      .update(receipts)
      .set({ result: stored === undefined ? {} : { value: stored } })
      .where(eq(receipts.key, key));
  };

  /**
   * `journal.run` and `context.run` share this. `getValidatedMeta` gives the parsed meta:
   * the root call parses it, a child inherits it. It runs inside the one-at-a-time
   * guard, so a bad meta on a busy transaction waits like any other rejection.
   * `onJobs` hears how many jobs each write queued, in this command and its children.
   * `parent` is the trace this run continues: the chain's correlation id and cause are
   * inherited, the command id is this run's own.
   */
  const runCommand = <S extends StandardSchemaV1, R>(
    source: TransactionSource<Tx>,
    command: Command<S, R, MetaOut, Tx>,
    input: SchemaInput<S>,
    getValidatedMeta: () => Promise<MetaOut>,
    onJobs: (count: number) => void,
    parent: Omit<Trace, 'commandId'>,
    key: string | undefined,
  ): Promise<Awaited<R>> =>
    oneAtATime(source, `command "${command.name}"`, async (): Promise<Awaited<R>> => {
      hooks.freeze();
      const meta = await getValidatedMeta();
      const parsed = await parseAsync<SchemaOutput<S>>(command.input, input);
      const own = commandId();
      const trace: Trace = { ...parent, commandId: own };
      debugCommand.debug('{commandName}: input ok ({own}, {correlationId})', {
        commandName: command.name,
        own,
        correlationId: trace.correlationId,
      });
      // A failure the handler or `authorize` returns rolls the transaction back, like a throw,
      // and is what the run returns: a rule that says no never leaves half a change behind.
      const refusal = rollbackOnFailure<Awaited<R>>();
      const transaction = source.transaction(async (tx): Promise<Awaited<R>> => {
        // Every operation the handler starts through this context. The transaction
        // must not close while one is still running: its work would land outside.
        const started: Promise<unknown>[] = [];
        let unfinished = 0;
        const track = <T>(operation: Promise<T>): Promise<T> => {
          started.push(operation);
          unfinished += 1;
          const done = () => {
            unfinished -= 1;
          };
          void operation.then(done, done);
          return operation;
        };
        // Every failure a write's `events` or a child command returned. While one is not accepted,
        // the command is doomed: it must end with a failure, or an ignored refusal would commit the rest.
        const refusals = trackRefusals('command', command.name, 'write or run');
        const { watch } = refusals;
        /** The handler's result, unless it is a success after a failure it did not accept: then the run throws and rolls back. */
        const handle = async (): Promise<Awaited<R>> => {
          let value: Awaited<R>;
          try {
            value = await command.handler(parsed, context);
          } finally {
            refusals.finish();
          }
          const ignored = refusals.unhandled();
          if (ignored === undefined || isReturnedFailure(value)) return value;
          throw new JournalError(
            'IGNORED_FAILURE',
            'command',
            command.name,
            `${ignored.from} returned the failure "${ignored.failure.code}", but the handler returned a success`,
          );
        };
        const context: CommandContext<MetaOut, Tx> = {
          tx,
          meta,
          commandId: own,
          correlationId: trace.correlationId,
          write: (entity, id, events, opts) =>
            track(
              writeWithValidatedMeta(tx, entity, id, () => meta, events, trace, onJobs, opts).then(
                watch(`the write to ${entity.kind} ${id}`),
              ),
            ),
          run: (child, childInput, childOpts) =>
            track(
              runCommand(
                tx,
                child,
                childInput,
                () => Promise.resolve(meta),
                onJobs,
                trace,
                childOpts?.idempotencyKey,
              ).then(watch(`the child command "${child.name}"`)),
            ),
          accept: refusals.accept,
        };
        let result: Awaited<R>;
        try {
          // Inside the transaction: a hook that throws rolls the command back cleanly.
          result = await hooks.run(
            {
              name: command.name,
              input: parsed,
              meta,
              commandId: own,
              correlationId: trace.correlationId,
              idempotencyKey: key ?? null,
            },
            async (): Promise<Awaited<R>> => {
              // Before the receipt: a receipt proves the command ran once, not that this caller
              // may have its result. A replay is authorized like a first run.
              if (command.authorize !== undefined) {
                const refused = await command.authorize(parsed, { tx, meta });
                if (isReturnedFailure(refused)) return refused;
              }
              if (key === undefined) return await handle();
              const held = await claimReceipt(tx, key, command.name, parsed, own);
              if (held !== undefined) {
                debugCommand.debug('{commandName}: replayed from receipt {key}', { commandName: command.name, key });
                // The receipt holds what this same command returned earlier, in the JSON form
                // `storeReceipt` checked against the live value. This is the one cast in the library.
                return held.replay as Awaited<R>;
              }
              const value = await handle();
              // A refusal is not stored: the rollback takes the claimed key back, so a repeat runs again.
              if (isReturnedFailure(value)) return value;
              await storeReceipt(tx, key, command.name, value);
              return value;
            },
          );
        } catch (error) {
          // The handler's own error is the one to report; the rollback undoes the rest.
          await Promise.allSettled(started);
          throw error;
        }
        if (unfinished > 0) {
          const count = unfinished;
          await Promise.allSettled(started);
          throw new Error(
            `journal: command "${command.name}" returned with ${count} journal operation${count === 1 ? '' : 's'} still running; await every write and run before the handler returns`,
          );
        }
        debugCommand.debug('{commandName}: done', { commandName: command.name });
        return refusal.settle(result);
      });
      return transaction.catch(refusal.recover);
    });

  /**
   * `journal.run`: parses `meta` once for the whole command. `cause` is set only by an
   * effect's `ctx.run`: the event the job was for. Its correlation id carries over unless
   * `opts.correlationId` says otherwise; with neither, the run starts a new chain.
   */
  const run = <S extends StandardSchemaV1, R>(
    source: TransactionSource<Tx>,
    command: Command<S, R, MetaOut, Tx>,
    input: NoInfer<SchemaInput<S>>,
    meta: SchemaInput<Meta>,
    opts?: RunOptions,
    cause?: { readonly seq: number; readonly correlationId: string | null },
  ): Promise<Awaited<R>> => {
    let queued = 0;
    return runCommand(
      source,
      command,
      input,
      async () => {
        const parsed = await parseAsync<SchemaOutput<Meta>>(metaSchema, meta);
        // No entity yet: the error names the command instead.
        assertRoundTrips(metaSchema, parsed, 'command', command.name, 'meta');
        return parsed;
      },
      count => {
        queued += count;
      },
      {
        causeSeq: cause?.seq ?? null,
        correlationId: opts?.correlationId ?? cause?.correlationId ?? correlationId(),
      },
      opts?.idempotencyKey,
    ).then(result => {
      // The root database has committed by now. Inside a caller's transaction
      // only the caller knows when the commit happens, so the caller wakes.
      if (queued > 0 && !is(source, PgAsyncTransaction)) deps.wake();
      return result;
    });
  };

  return run;
}
