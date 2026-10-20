import { expectTypeOf } from 'vitest';

import { defineFailure } from '@arki/failure';

import type { TRANSACTION_FAILURES, TransactionalDb, TransactionFailure } from './transaction.js';
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
