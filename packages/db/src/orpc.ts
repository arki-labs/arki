/**
 * `@arki/db/orpc` — one oRPC middleware that makes a contract-first procedure a
 * SERIALIZABLE Postgres transaction.
 *
 *   const transact = transactionalProcedure(db, { repos: () => repositories, retries: 3 });
 *   implement(contract, transactionalProcedureConfig).transfer
 *     .use(transact)                                   // always the last `.use()`
 *     .handler(({ context: { repos }, input }) => moveMoney(repos, input));
 *
 * Per call it opens a transaction, binds the repositories to it with
 * `withTx(tx)` (once per attempt), and runs the handler. On `40001` / `40P01` it
 * runs the handler again in a fresh transaction (see `runTransaction`). Out of
 * retries, the client gets the declared `db.transaction_conflict` error, a 409.
 *
 * The handler's output is validated inside the transaction, so a bad output
 * rolls back. That needs `transactionalProcedureConfig` on `implement`: the
 * middleware checks it, and that it is last, on the first call of each procedure.
 *
 * `@orpc/server` is an optional peer. Import this module only in an app that serves oRPC.
 */
import type { Context, Meta, MiddlewareOptions, ORPCErrorConstructorMap } from '@orpc/server';
import { ORPCError } from '@orpc/server';

import type { Clock } from '@arki/clock';
import type { Failure } from '@arki/failure';
import type { ErrorMapOf } from '@arki/failure/orpc';
import { isFailure } from '@arki/failure';
import { errorMap, orThrowRpc } from '@arki/failure/orpc';

import type { TransactionalDb } from './composition.js';
import type { TransactionFailure, TransactionSettings } from './transaction.js';
import {
  DB_TRANSACTION_ERROR_CODES,
  DbTransactionError,
  parseTransactionSettings,
  runTransaction,
  TRANSACTION_FAILURES,
  TransactionDefect,
} from './transaction.js';

/** Native contracts declare these errors without restating transaction schemas. */
export const transactionErrorMap = errorMap(...TRANSACTION_FAILURES);

/** The context key that marks transactional work. */
const MARKER = '~arkiTransaction';

/**
 * Where the bound repositories come from: `Repos<F>` from `@arki/db/dot`, or anything with `withTx`.
 * A property, not a method, so the check is strict: factories typed for the pool only
 * (`(db: Db) => …`) do not accept the transaction and fail at `transactionalProcedure(...)`.
 */
export type TransactionRepositorySource<Tx, R extends object> = { readonly withTx: (tx: Tx) => R };

/** What the middleware adds to the handler's context, and what a transaction-aware usecase takes. */
export type TransactionContext<Tx, R extends object> = {
  readonly tx: Tx;
  /** The repositories bound to `tx`. A fresh set per attempt. */
  readonly repos: R;
  /** Marks transactional code: a second `transact` refuses it, and `db/no-effects-in-transaction` looks for it. */
  readonly '~arkiTransaction': true;
};

export type TransactionalProcedureOptions<C extends Context, Tx, R extends object> = TransactionSettings & {
  /**
   * Picks the repository source from the context. Called once per call; its `withTx` once per attempt.
   * `Tx` is read off the database only, never off `withTx`.
   */
  readonly repos: (context: C) => TransactionRepositorySource<NoInfer<Tx>, R>;
  /** Whose timer the wait between attempts uses. Default: the system clock. */
  readonly clock?: Clock;
};

/**
 * The middleware. Generic in the procedure's output, so one `transact` attaches
 * to every procedure of a feature, whatever each one returns.
 */
export type TransactionalMiddleware<C extends Context, Tx, R extends object> = <TOutput>(
  options: MiddlewareOptions<C, TOutput, ORPCErrorConstructorMap<ErrorMapOf<typeof TRANSACTION_FAILURES>>, Meta>,
) => Promise<{ output: TOutput; context: TransactionContext<Tx, R> }>;

/** The scope a transaction-aware usecase takes, read off the middleware. Never restated. */
export type TransactionScopeOf<M> = M extends (
  options: never,
) => Promise<{ context: TransactionContext<infer Tx, infer R> }>
  ? TransactionContext<Tx, R>
  : never;

/**
 * Pass to `implement(contract, config)`. Input is validated before every
 * middleware (once, however often the handler reruns); output right after the
 * handler, so inside the transaction.
 */
export const transactionalProcedureConfig = {
  initialInputValidationIndex: 0,
  initialOutputValidationIndex: Number.POSITIVE_INFINITY,
} as const;

/** The procedure as the middleware sees it: only the pipeline fields the checks read. */
type Pipeline = {
  readonly '~orpc': { readonly middlewares: readonly unknown[]; readonly outputValidationIndex: number };
};

function pipelineError(message: string, remediation: string): DbTransactionError {
  return new DbTransactionError({ code: DB_TRANSACTION_ERROR_CODES.invalidPipeline, message, remediation });
}

/** The two things a transaction needs from the procedure, checked on its first call. */
function assertPipeline(procedure: Pipeline, self: unknown): void {
  const { middlewares, outputValidationIndex } = procedure['~orpc'];
  if (middlewares.at(-1) !== self) {
    throw pipelineError(
      '[db] the transaction middleware is not the last `.use()` of this procedure. A middleware after it would run again on every retry.',
      'Move `.use(transact)` to the end, right before `.handler()`. Put auth, timing and error mapping before it.',
    );
  }
  if (outputValidationIndex < middlewares.length) {
    throw pipelineError(
      '[db] this procedure validates its output after the transaction has committed, so a bad output would not roll back.',
      'Build the implementer with `implement(contract, transactionalProcedureConfig)` from `@arki/db/orpc`.',
    );
  }
}

function isMarked(context: object): boolean {
  const marker: unknown = Reflect.get(context, MARKER);
  return marker === true;
}

function isAsyncIterable(value: unknown): boolean {
  return typeof value === 'object' && value !== null && Symbol.asyncIterator in value;
}

/**
 * Make the transaction middleware, once per feature (or app).
 *
 * - `db`: the root database, or a function that picks it from the context (a
 *   Dot feature's `ctx.db`). A transaction as root is refused (`ARKI_DB_TX_E006`).
 * - `options.repos`: picks the repository source; the handler gets
 *   `source.withTx(tx)` as `context.repos`.
 * - `options.isolation` (`'serializable'`, the default and only level) and
 *   `options.retries` (default 3, at most 10) are checked now: bad values throw
 *   `ARKI_DB_TX_E002` here, not on the first request.
 */
export function transactionalProcedure<C extends Context = Record<never, never>, Tx = never, R extends object = never>(
  db: TransactionalDb<Tx> | ((context: C) => TransactionalDb<Tx>),
  options: TransactionalProcedureOptions<C, Tx, R>,
): TransactionalMiddleware<C, Tx, R> {
  const { repos: selectRepos, clock, ...rest } = options;
  const settings = parseTransactionSettings(rest);
  const checked = new WeakSet<object>();

  async function transact<TOutput>({
    context,
    procedure,
    next,
    signal,
    errors,
  }: MiddlewareOptions<C, TOutput, ORPCErrorConstructorMap<ErrorMapOf<typeof TRANSACTION_FAILURES>>, Meta>): Promise<{
    output: TOutput;
    context: TransactionContext<Tx, R>;
  }> {
    if (!checked.has(procedure)) {
      assertPipeline(procedure, transact);
      checked.add(procedure);
    }
    if (isMarked(context)) {
      throw new DbTransactionError({
        code: DB_TRANSACTION_ERROR_CODES.nestedTransaction,
        message: '[db] this procedure already runs inside a transaction middleware.',
        remediation: 'Use one `.use(transact)` per procedure. Its retry covers the whole handler.',
      });
    }
    const root = typeof db === 'function' ? db(context) : db;
    const source = selectRepos(context);
    // Native oRPC expects a result wrapper. Keep it intact on rollback too.
    let refusedResult: { output: TOutput; context: TransactionContext<Tx, R> } | undefined;
    const outcome = await runTransaction(
      root,
      async tx => {
        const scope: TransactionContext<Tx, R> = { tx, repos: source.withTx(tx), [MARKER]: true };
        const result = await next({ context: scope });
        if (isAsyncIterable(result.output)) {
          throw new DbTransactionError({
            code: DB_TRANSACTION_ERROR_CODES.unsupportedOutput,
            message: '[db] a transactional procedure returned a stream. It would be read after the transaction closed.',
            remediation: 'Return plain data. Stream from a separate, non-transactional procedure.',
          });
        }
        // An abort before the commit rolls back: the caller is gone and will not see the answer.
        signal?.throwIfAborted();
        if (isFailure<unknown>(result.output)) {
          refusedResult = result;
          const failure: Failure = result.output;
          return failure;
        }
        return result;
      },
      { ...settings, clock, signal },
    );
    if (!isFailure(outcome)) return outcome;
    if (refusedResult !== undefined && refusedResult.output === outcome) return refusedResult;
    // Exceptions belong only at this foreign framework boundary. Preserve native
    // errors (including output validation), whose declared transport semantics own them.
    if (outcome.cause instanceof ORPCError) throw outcome.cause;
    if (isTransactionFailure(outcome)) return orThrowRpc(outcome, errors);
    return orThrowRpc(TransactionDefect({ cause: outcome }), errors);
  }
  return transact;
}

function isTransactionFailure(value: unknown): value is TransactionFailure {
  return TRANSACTION_FAILURES.some(definition => definition.is(value));
}
