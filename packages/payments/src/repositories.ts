import { createPaymentRepository, type CreatePaymentRepositoryDeps, type PaymentDatabase } from './core/repository';
import { createDunningRepository, type DunningDatabase, type DunningRepositoryTables } from './dunning/repository';
import { createRefundRepository, type RefundsDatabase } from './refunds/repository';
import type { RefundsTables } from './refunds/tables';
import { createTaxRepositories, type TaxDatabase, type TaxRepositoryTables } from './tax/repository';

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
