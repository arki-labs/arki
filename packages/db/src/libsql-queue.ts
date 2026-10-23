/**
 * One turn at a time for a local libSQL client.
 *
 * SQLite has one writer. `@libsql/client` gives each transaction its own pooled
 * connection, and every connection runs on the one JavaScript thread. So a
 * second writer cannot wait inside SQLite: a busy wait would block the thread
 * that has to commit the first. Without this queue a second transaction, or a
 * plain insert while a transaction is open, fails at once with `SQLITE_BUSY`,
 * and a busy timeout does not help at any value
 * (docs/arki/research/17-multi-database/spike/results.md).
 *
 * Only an open transaction holds a lock across an `await`; a local statement
 * runs in one synchronous native call. So the queue costs no parallelism:
 * calls take turns in order, and a transaction keeps its turn until it commits
 * or rolls back. Queries inside the transaction run on the transaction object
 * and never wait. A query on the root database from inside its own
 * transaction waits for that transaction to end, so it never returns: use `tx`.
 */
import type { Client, InArgs, InStatement, ResultSet, Transaction, TransactionMode } from '@libsql/client';

/** Wrap `client` so every call, and every transaction for its whole life, takes its turn in order. */
export function queueWrites(client: Client): Client {
  let last: Promise<void> = Promise.resolve();

  /** Waits for every earlier turn, then resolves with the function that ends this one. */
  const take = async (): Promise<() => void> => {
    const { promise, resolve } = Promise.withResolvers<void>();
    const previous = last;
    last = promise;
    await previous;
    return resolve;
  };

  const inTurn = async <T>(call: () => Promise<T>): Promise<T> => {
    const release = await take();
    try {
      return await call();
    } finally {
      release();
    }
  };

  return {
    execute: (statement: InStatement | string, args?: InArgs): Promise<ResultSet> =>
      inTurn(() => (typeof statement === 'string' ? client.execute(statement, args) : client.execute(statement))),
    batch: (statements, mode) => inTurn(() => client.batch(statements, mode)),
    migrate: statements => inTurn(() => client.migrate(statements)),
    executeMultiple: sql => inTurn(() => client.executeMultiple(sql)),
    sync: () => inTurn(() => client.sync()),
    transaction: async (mode?: TransactionMode): Promise<Transaction> => {
      const release = await take();
      try {
        return holdTurn(await client.transaction(mode), release);
      } catch (error) {
        release();
        throw error;
      }
    },
    close: () => {
      client.close();
    },
    reconnect: () => {
      client.reconnect();
    },
    get closed() {
      return client.closed;
    },
    get protocol() {
      return client.protocol;
    },
  };
}

/** The transaction keeps the turn until it commits, rolls back or closes, whether or not that call succeeds. */
function holdTurn(transaction: Transaction, release: () => void): Transaction {
  const ending =
    <T>(end: () => T): (() => T) =>
    () => {
      try {
        return end();
      } finally {
        release();
      }
    };
  const settle = async (end: () => Promise<void>): Promise<void> => {
    try {
      await end();
    } finally {
      release();
    }
  };
  return {
    execute: statement => transaction.execute(statement),
    batch: statements => transaction.batch(statements),
    executeMultiple: sql => transaction.executeMultiple(sql),
    commit: () => settle(() => transaction.commit()),
    rollback: () => settle(() => transaction.rollback()),
    close: ending(() => {
      transaction.close();
    }),
    get closed() {
      return transaction.closed;
    },
  };
}
