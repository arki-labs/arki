/**
 * @arki/journal/foreman
 *
 * The Foreman control-plane modules for the journal: `journalJobsModule` reads the jobs, their
 * attempts and the archive, and retries, discards, cancels, purges or replays them under an
 * approved permit; `journalWorkflowsModule` does the same for durable workflow runs. Also holds the
 * Postgres receipt store (`journalReceiptStore`) that moved here from `@arki/admin`.
 * Requires the optional peer `@arki/admin`. The normal `@arki/journal` entry never imports it.
 *
 * Both modules are returned as a plain `ForemanModule`: the admin dispatcher reads their schemas
 * at runtime, and the entry's types never name Zod (`TYPES_E001`).
 */
import type { ForemanModule } from '@arki/admin/module';
import type { StandardSchemaV1 } from '@arki/schema';

import type { RootDb, TransactionSource } from '../index.js';
import type { JournalJobsModuleOptions, JournalWorkflowsModuleOptions } from './shapes.js';
import { jobsModule } from './jobs.js';
import { workflowsModule } from './workflows.js';

export {
  foremanReceiptTables,
  journalReceiptStore,
  type ForemanReceiptTables,
  type JournalReceiptStoreOptions,
} from './receipts.js';
export {
  JOURNAL_JOBS_ERROR_CODES,
  JOURNAL_WORKFLOWS_ERROR_CODES,
  type ArchivedSummary,
  type AttemptSummary,
  type JobSummary,
  type JournalJobsModuleOptions,
  type JournalWorkflowsModuleOptions,
  type OperationSummary,
} from './shapes.js';

/** The reads and actions take no context of their own. */
type ModuleContext = Record<string, never>;

/** The Foreman module for the journal's jobs. */
export function journalJobsModule<
  Meta extends StandardSchemaV1<unknown, Record<string, unknown>>,
  Tx extends TransactionSource<Tx>,
  AppDb extends RootDb,
>(options: JournalJobsModuleOptions<Meta, Tx, AppDb>): ForemanModule<ModuleContext> {
  return jobsModule(options);
}

/** The Foreman module for durable workflow runs. */
export function journalWorkflowsModule<
  Meta extends StandardSchemaV1<unknown, Record<string, unknown>>,
  Tx extends TransactionSource<Tx>,
  AppDb extends RootDb,
>(options: JournalWorkflowsModuleOptions<Meta, Tx, AppDb>): ForemanModule<ModuleContext> {
  return workflowsModule(options);
}
