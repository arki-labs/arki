// Cross-runtime smoke test for the portable entries `./transaction` and `./orpc`.
// Runs the BUILT package (dist/) under Node, Bun and Deno via `bun run test:runtimes`,
// and is bundled for the browser and Hermes targets. A scripted database stands in
// for Postgres, so no driver loads. The unit and Postgres tests cover the details.
// The root entry (node-postgres) and `./eslint` (tooling) are not portable and are
// not imported here.

import { call, os } from '@orpc/server';
import { z } from 'zod';

import { transactionalProcedure, transactionalProcedureConfig, transactionErrorMap } from '../dist/orpc.js';
import {
  DB_TRANSACTION_ERROR_CODES,
  isDbTransactionError,
  retryableSqlState,
  runTransaction,
  runTransactionOnce,
  TransactionConflict,
} from '../dist/transaction.js';

const conflict = () => Object.assign(new Error('could not serialize access'), { code: '40001' });

/** A database whose first `failFirst` transactions throw 40001 after the work ran. */
function scriptedDb(failFirst) {
  const configs = [];
  return {
    configs,
    async transaction(fn, config) {
      configs.push(config);
      const result = await fn({ attempt: configs.length });
      if (configs.length <= failFirst) throw conflict();
      return result;
    },
  };
}

const caught = promise =>
  promise.then(
    () => undefined,
    error => error,
  );

async function main() {
  const retried = scriptedDb(1);
  const value = await runTransaction(retried, async (tx, attempt) => `${tx.attempt}/${attempt}`);
  const exhausted = await runTransaction(scriptedDb(9), async () => 'x', { retries: 1 });
  const refusal = TransactionConflict({ attempts: 1, sqlState: '40001' });
  const invalid = await caught(runTransaction(scriptedDb(0), async () => 'x', { retries: 11 }));
  const wrapped = new Error('query failed', { cause: conflict() });

  const repositories = { withTx: tx => ({ attempt: tx.attempt }) };
  const builder = os.$config(transactionalProcedureConfig).errors(transactionErrorMap);
  const answer = builder
    .output(z.object({ attempt: z.number() }))
    .use(transactionalProcedure(scriptedDb(1), { repos: () => repositories }))
    .handler(({ context }) => ({ attempt: context.repos.attempt }));
  const lost = builder
    .use(transactionalProcedure(scriptedDb(9), { repos: () => repositories, retries: 0 }))
    .handler(() => 'never');
  const late = builder
    .use(transactionalProcedure(scriptedDb(0), { repos: () => repositories }))
    .use(({ next }) => next())
    .handler(() => 'x');

  const checks = [
    ['runs serializable', retried.configs[0]?.isolationLevel, 'serializable'],
    ['reruns on 40001 with a fresh transaction', value, '2/2'],
    ['gives up with a coded error', TransactionConflict.is(exhausted) && exhausted.code, TransactionConflict.code],
    ['counts attempts', TransactionConflict.is(exhausted) && exhausted.data.attempts, 2],
    ['refuses bad options', isDbTransactionError(invalid) && invalid.code, DB_TRANSACTION_ERROR_CODES.invalidOptions],
    ['classifies a wrapped 40001', retryableSqlState(wrapped), '40001'],
    ['middleware reruns the handler', (await call(answer, {})).attempt, 2],
    [
      'middleware maps exhaustion to a canonical failure',
      (await caught(call(lost, {})))?.code,
      TransactionConflict.code,
    ],
    ['returned failure preserves identity', await runTransaction(scriptedDb(0), async () => refusal), refusal],
    [
      'single attempt preserves failure identity',
      await runTransactionOnce(scriptedDb(0), async () => refusal),
      refusal,
    ],
    ['middleware must be last', (await caught(call(late, {})))?.code, DB_TRANSACTION_ERROR_CODES.invalidPipeline],
  ];

  let failedChecks = 0;
  for (const [name, actual, expected] of checks) {
    if (actual === expected) continue;
    failedChecks++;
    console.log(`FAIL ${name}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
  const runtime =
    typeof HermesInternal !== 'undefined'
      ? 'hermes'
      : typeof Deno !== 'undefined'
        ? 'deno'
        : typeof Bun !== 'undefined'
          ? 'bun'
          : typeof window !== 'undefined'
            ? 'browser'
            : 'node';
  if (failedChecks > 0) {
    console.log(`${runtime}: ${failedChecks} smoke checks FAILED`);
    throw new Error('smoke failed');
  }
  console.log(`${runtime}: ${checks.length} smoke checks passed`);
}

main();
