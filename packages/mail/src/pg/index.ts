/**
 * Mail that commits with the business write. `enqueue` renders the mail and inserts one journal
 * queue row in the caller's transaction: a rollback drops the mail with the write, a commit
 * makes it durable. The journal worker sends it through `runner`, retries failures that can
 * succeed later, and dead-letters the rest. It is the only thing that retries.
 *
 * The row stores the rendered message, not the template input, so every retry sends the same
 * bytes and a template changed after the enqueue cannot change a mail already queued.
 *
 * Delivery is at least once. The job id is passed to the transport as the idempotency key, so a
 * provider that supports keys drops a repeat within its own window (Resend: 24 hours).
 */
import { and, eq, sql } from 'drizzle-orm';
import { getTableConfig } from 'drizzle-orm/pg-core';

import type { DbHandle, JobRunner, JournalTables } from '@arki/journal';
import type { Backoff } from '@arki/resilience';
import type { SchemaInput, StandardSchemaV1 } from '@arki/schema';
import { jobId } from '@arki/journal';
import { backoff } from '@arki/resilience';

import type { Mailer } from '../mailer.js';
import type { MailTemplate } from '../template.js';
import type { SendOptions } from '../types.js';
import type { QueuedArgs } from './args.js';
import { isMailError, MAIL_ERROR_CODES, MailError, permanent } from '../errors.js';
import { listOf } from '../message.js';
import { MAIL_JOB, queuedArgs } from './args.js';

export { MAIL_JOB } from './args.js';

const WAKE_PAYLOAD = '{"queue":1}';
const DEFAULT_MAX_BYTES = 256 * 1024;
/** 5 s, 10 s, 20 s, … capped at 1 h; dead after the 5th try. */
const DEFAULT_RETRY = backoff.exponential({ base: 5000, max: 3_600_000 }).upTo(4);

/** A transaction: it has `rollback()`, which the root database does not. */
export type MailTx = DbHandle & { rollback(): never };

export type MailOutboxOptions = {
  readonly mailer: Mailer;
  readonly tables: Pick<JournalTables, 'jobs'>;
  /** Waits between tries. Default: 5 s doubling to 1 h, 5 tries in all. */
  readonly retry?: Backoff;
  /** Largest stored message, in bytes of JSON. Default 256 KiB. */
  readonly maxBytes?: number;
};

export type EnqueueOptions = Omit<SendOptions, 'signal'> & {
  /** After this moment the mail is not sent; the job is dead with `ARKI_MAIL_E011`. */
  readonly expiresAt?: Date;
};

export type MailOutbox = {
  /**
   * Queues one mail inside `tx`. Throws {@link MailError}: `E009` for the root database, `E002`
   * unless there is exactly one `to` recipient, `E003` for bad input, `E010` when too large.
   * The same `idempotencyKey` while a job is still queued returns that job (`deduped: true`).
   */
  enqueue<S extends StandardSchemaV1>(
    tx: MailTx,
    template: MailTemplate<S>,
    input: NoInfer<SchemaInput<S>>,
    options: EnqueueOptions,
  ): Promise<{ readonly jobId: string; readonly deduped: boolean }>;
  /** Runs queued mail: pass it to `journal.worker(db, { jobs })`, or combine it with `combineRunners`. */
  readonly runner: JobRunner;
};

export function mailOutbox(options: MailOutboxOptions): MailOutbox {
  const { mailer, tables } = options;
  const retry = options.retry ?? DEFAULT_RETRY;
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  // The journal's wake channel: every journal worker of this table hears it.
  const tableSchema = getTableConfig(tables.jobs).schema;
  const channel = tableSchema === undefined ? 'journal_wake' : `${tableSchema}_journal_wake`;

  const enqueue: MailOutbox['enqueue'] = async (tx, template, input, enqueueOptions) => {
    if (typeof Reflect.get(tx, 'rollback') !== 'function') {
      throw new MailError(
        permanent(MAIL_ERROR_CODES.needsTransaction, 'enqueue needs the transaction of the write it belongs to.'),
      );
    }
    if (listOf(enqueueOptions.to).length !== 1 || enqueueOptions.cc !== undefined || enqueueOptions.bcc !== undefined) {
      throw new MailError(
        permanent(MAIL_ERROR_CODES.invalidMessage, 'A queued mail has exactly one `to` recipient and no cc or bcc.'),
      );
    }
    const composed = await mailer.compose(template, input, enqueueOptions);
    if (composed.error !== null) throw new MailError(composed.error);

    const args: QueuedArgs = {
      version: 1,
      message: composed.data,
      ...(enqueueOptions.expiresAt === undefined ? {} : { expiresAt: enqueueOptions.expiresAt.toISOString() }),
    };
    const bytes = new TextEncoder().encode(JSON.stringify(args)).byteLength;
    if (bytes > maxBytes) {
      throw new MailError(
        permanent(MAIL_ERROR_CODES.badQueuedData, `The queued mail is ${bytes} bytes; the limit is ${maxBytes}.`),
      );
    }

    const dedupeKey = enqueueOptions.idempotencyKey ?? null;
    const inserted = await tx
      .insert(tables.jobs)
      .values({ id: jobId(), kind: 'queue', jobName: MAIL_JOB, args, dedupeKey })
      .onConflictDoNothing()
      .returning({ id: tables.jobs.id });
    const [row] = inserted;
    if (row !== undefined) {
      // Delivered at commit, dropped on rollback.
      await tx.execute(sql`select pg_notify(${channel}, ${WAKE_PAYLOAD})`);
      return { jobId: row.id, deduped: false };
    }
    // Only the dedupe index can refuse the insert: a job with this key is still queued.
    const [existing] = await tx
      .select({ id: tables.jobs.id })
      .from(tables.jobs)
      .where(and(eq(tables.jobs.jobName, MAIL_JOB), eq(tables.jobs.dedupeKey, dedupeKey ?? '')));
    if (existing === undefined) throw new Error('mail enqueue: insert refused but no queued job holds the key');
    return { jobId: existing.id, deduped: true };
  };

  const runner: JobRunner = {
    names: [MAIL_JOB],
    run: async (job, { signal }) => {
      const queued = queuedArgs(job);
      if (queued.expiresAt !== undefined && Date.parse(queued.expiresAt) <= Date.now()) {
        throw new MailError(
          permanent(MAIL_ERROR_CODES.expired, `The mail expired at ${queued.expiresAt} before it could be sent.`),
        );
      }
      const result = await mailer.sendRaw(queued.message, { idempotencyKey: job.id, signal });
      if (result.error !== null) throw new MailError(result.error);
    },
    // A failure no retry can fix is dead now; anything else waits for the next try.
    retryDelay: (job, error) => (isMailError(error) && !error.retryable ? undefined : retry.delay(job.attempt, error)),
  };

  return { enqueue, runner };
}
