import type { z } from 'zod';
import { expectTypeOf } from 'vitest';

import type { IdGenerationFailure } from '@arki/contracts';
import { defineFailure } from '@arki/failure';

import type { transactionSettings } from './transaction-settings.js';
import type {
  ResolvedTransactionSettings,
  TRANSACTION_FAILURES,
  TransactionalDb,
  TransactionFailure,
  TransactionSettings,
} from './transaction.js';
import { createUnitOfWork } from './composition.js';
import { runTransaction, runTransactionOnce } from './transaction.js';

const Refused = defineFailure('test.transaction_refused');
declare const db: TransactionalDb<{ id: number }>;
const work = () => Promise.resolve(Math.random() > 0.5 ? Refused() : { id: 1 });
const result = runTransaction(db, work);
const once = runTransactionOnce(db, work);
const uow = createUnitOfWork(db, { item: tx => tx });
const scoped = uow(() => work());
type Expected = { id: number } | ReturnType<typeof Refused> | TransactionFailure;
expectTypeOf(result).toEqualTypeOf<Promise<Expected>>();
expectTypeOf(once).toEqualTypeOf<Promise<Expected>>();
expectTypeOf(scoped).toEqualTypeOf<Promise<Expected>>();
expectTypeOf<TransactionFailure>().toEqualTypeOf<ReturnType<(typeof TRANSACTION_FAILURES)[number]>>();
expectTypeOf<Extract<TransactionFailure, IdGenerationFailure>>().toEqualTypeOf<IdGenerationFailure>();
// The plain settings types are the source: the parser must read and write exactly them.
expectTypeOf<z.input<typeof transactionSettings>>().toEqualTypeOf<TransactionSettings>();
expectTypeOf<z.output<typeof transactionSettings>>().toEqualTypeOf<ResolvedTransactionSettings>();
