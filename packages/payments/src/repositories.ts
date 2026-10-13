import { createPaymentRepository, type CreatePaymentRepositoryDeps, type PaymentDatabase } from './core/repository.js';
import { createDunningRepository, type DunningDatabase, type DunningRepositoryTables } from './dunning/repository.js';
import { createRefundRepository, type RefundsDatabase } from './refunds/repository.js';
import type { RefundsTables } from './refunds/tables.js';
import { createTaxRepositories, type TaxDatabase, type TaxRepositoryTables } from './tax/repository.js';

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
