import type { CreatePaymentRepositoryDeps, PaymentDatabase } from './core/repository.js';
import type { DunningDatabase, DunningRepositoryTables } from './dunning/repository.js';
import type { RefundsDatabase } from './refunds/repository.js';
import type { RefundsTables } from './refunds/tables.js';
import type { TaxDatabase, TaxRepositoryTables } from './tax/repository.js';
import { createPaymentRepository } from './core/repository.js';
import { createDunningRepository } from './dunning/repository.js';
import { createRefundRepository } from './refunds/repository.js';
import { createTaxRepositories } from './tax/repository.js';

export type PaymentRepositoriesTables = {
  core: CreatePaymentRepositoryDeps['tables'];
  dunning: DunningRepositoryTables;
  refunds: Pick<RefundsTables, 'refunds'>;
  tax: TaxRepositoryTables;
};

export type PaymentRepositoriesDatabase = PaymentDatabase & DunningDatabase & RefundsDatabase & TaxDatabase;

export function createPaymentRepositories(db: PaymentRepositoriesDatabase, tables: PaymentRepositoriesTables) {
  return {
    core: createPaymentRepository(db, { tables: tables.core }),
    dunning: createDunningRepository(db, tables.dunning),
    refunds: createRefundRepository(db, tables.refunds),
    tax: createTaxRepositories(db, tables.tax),
  };
}

export type PaymentRepositories = ReturnType<typeof createPaymentRepositories>;
