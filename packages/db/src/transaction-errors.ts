import type { RetryableSqlState } from './transaction.js';

export const DB_TRANSACTION_ERROR_CODES = {
  /**
   * Every attempt failed with a retryable SQLSTATE (`40001` or `40P01`).
   *
   * @fix Shorten the transaction, touch rows in a fixed order, or raise `retries` (at most 10).
   * @verify bun run test -- src/transaction.test.ts
   */
  retriesExhausted: 'ARKI_DB_TX_E001',
  /**
   * `isolation` is not `serializable`, `retries` is not a whole number from 0 to 10, or an option key is unknown.
   *
   * @fix Fix the options. Nothing is clamped.
   * @verify bun run test -- src/transaction.test.ts
   */
  invalidOptions: 'ARKI_DB_TX_E002',
  /**
   * A transactional procedure was called with a context that is already inside a transaction.
   *
   * @fix Open one transaction per call. Call the usecase directly instead.
   * @verify bun run test -- src/orpc.test.ts
   */
  nestedTransaction: 'ARKI_DB_TX_E003',
  /**
   * `transact` is not the last `.use()`, or `implement` was not given `transactionalProcedureConfig`.
   *
   * @fix Put `.use(transact)` last and pass `transactionalProcedureConfig` to `implement`.
   * @verify bun run test -- src/orpc.test.ts
   */
  invalidPipeline: 'ARKI_DB_TX_E004',
  /**
   * The transactional handler returned a stream.
   *
   * @fix Return plain data. Stream from another procedure.
   * @verify bun run test -- src/orpc.test.ts
   */
  unsupportedOutput: 'ARKI_DB_TX_E005',
  /**
   * The database handed to the transaction helper is already a transaction.
   *
   * @fix Pass the root database.
   * @verify bun run test -- src/transaction.test.ts
   */
  transactionAsRoot: 'ARKI_DB_TX_E006',
} as const;

export type DbTransactionErrorCode = (typeof DB_TRANSACTION_ERROR_CODES)[keyof typeof DB_TRANSACTION_ERROR_CODES];

/** An error of `@arki/db/transaction` or `@arki/db/orpc`. Same shape as `DbCompositionError`. */
export class DbTransactionError extends Error {
  readonly code: DbTransactionErrorCode;
  /** How to fix it. */
  readonly remediation: string;
  /** How many times the work ran. Set for `retriesExhausted`. */
  readonly attempts: number | undefined;
  /** The SQLSTATE of the last failure. Set for `retriesExhausted`. */
  readonly sqlState: RetryableSqlState | undefined;

  constructor(args: {
    readonly code: DbTransactionErrorCode;
    readonly message: string;
    readonly remediation: string;
    readonly attempts?: number;
    readonly sqlState?: RetryableSqlState;
    readonly cause?: unknown;
  }) {
    super(args.message, args.cause === undefined ? undefined : { cause: args.cause });
    this.name = 'DbTransactionError';
    this.code = args.code;
    this.remediation = args.remediation;
    this.attempts = args.attempts;
    this.sqlState = args.sqlState;
  }
}

/** True when `error` is a `DbTransactionError`, and has `code` when one is given. */
export function isDbTransactionError(error: unknown, code?: DbTransactionErrorCode): error is DbTransactionError {
  return error instanceof DbTransactionError && (code === undefined || error.code === code);
}
