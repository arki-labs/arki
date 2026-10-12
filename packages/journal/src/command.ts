/**
 * Command execution: parse the input, open the transaction, give the handler a
 * context bound to it, and refuse to close while an operation is still running.
 * May import `api`, `write` (types), `storage`, `transaction-guard` and leaf files.
 * Must not import `journal`, `history` or `worker`.
 */
import type { z } from 'zod';
import { is } from 'drizzle-orm';
import { PgAsyncTransaction } from 'drizzle-orm/pg-core';

import type { Command, CommandContext } from './api.js';
import type { TransactionSource } from './types.js';
import type { Writer } from './write.js';
import { debugCommand } from './debug.js';
import { assertRoundTrips } from './storage.js';
import { oneAtATime } from './transaction-guard.js';

/** What command execution needs from the journal. */
export type CommandDeps<Meta extends z.ZodObject, Tx extends TransactionSource<Tx>> = {
  readonly metaSchema: Meta;
  readonly writeWithValidatedMeta: Writer<Meta, Tx>['writeWithValidatedMeta'];
  /** Wakes this journal's workers. Called after a root-database run that queued a job. */
  readonly wake: () => void;
};

export function createCommandRunner<Meta extends z.ZodObject, Tx extends TransactionSource<Tx>>(
  deps: CommandDeps<Meta, Tx>,
) {
  type MetaOut = z.output<Meta>;
  const { metaSchema, writeWithValidatedMeta } = deps;

  /**
   * `journal.run` and `context.run` share this. `getValidatedMeta` gives the parsed meta:
   * the root call parses it, a child inherits it. It runs inside the one-at-a-time
   * guard, so a bad meta on a busy transaction waits like any other rejection.
   * `onJobs` hears how many jobs each write queued, in this command and its children.
   */
  const runCommand = <S extends z.ZodType, R>(
    source: TransactionSource<Tx>,
    command: Command<S, R, MetaOut, Tx>,
    input: z.input<S>,
    getValidatedMeta: () => Promise<MetaOut>,
    onJobs: (count: number) => void,
  ): Promise<Awaited<R>> =>
    oneAtATime(source, `command "${command.name}"`, async (): Promise<Awaited<R>> => {
      const meta = await getValidatedMeta();
      const parsed = await command.input.parseAsync(input);
      debugCommand('%s: input ok', command.name);
      return source.transaction(async (tx): Promise<Awaited<R>> => {
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
        const context: CommandContext<MetaOut, Tx> = {
          tx,
          meta,
          write: (entity, id, events) => track(writeWithValidatedMeta(tx, entity, id, () => meta, events, onJobs)),
          run: (child, childInput) => track(runCommand(tx, child, childInput, () => Promise.resolve(meta), onJobs)),
        };
        let result: Awaited<R>;
        try {
          result = await command.handler(parsed, context);
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
        debugCommand('%s: done', command.name);
        return result;
      });
    });

  /** `journal.run`: parses `meta` once for the whole command. */
  const run = <S extends z.ZodType, R>(
    source: TransactionSource<Tx>,
    command: Command<S, R, MetaOut, Tx>,
    input: NoInfer<z.input<S>>,
    meta: z.input<Meta>,
  ): Promise<Awaited<R>> => {
    let queued = 0;
    return runCommand(
      source,
      command,
      input,
      async () => {
        const parsed = await metaSchema.parseAsync(meta);
        // No entity yet: the error names the command instead.
        assertRoundTrips(metaSchema, parsed, 'command', command.name, 'meta');
        return parsed;
      },
      count => {
        queued += count;
      },
    ).then(result => {
      // The root database has committed by now. Inside a caller's transaction
      // only the caller knows when the commit happens, so the caller wakes.
      if (queued > 0 && !is(source, PgAsyncTransaction)) deps.wake();
      return result;
    });
  };

  return run;
}
