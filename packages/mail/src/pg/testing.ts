/**
 * Assertions on queued mail, for tests. They read committed rows, not function calls: a mail
 * queued inside a transaction that rolled back is not there, which is the point.
 */
import { and, eq, isNotNull, isNull } from 'drizzle-orm';

import type { DbHandle, JournalTables } from '@arki/journal';

import { isMailMessage, MAIL_JOB } from './args.js';

export type QueuedMail = {
  readonly jobId: string;
  readonly template: string | undefined;
  readonly to: string | readonly string[];
  readonly subject: string;
  readonly text: string;
  readonly attempts: number;
  readonly lastError: string | null;
  readonly idempotencyKey: string | null;
};

export function mailQueueAssertions(db: DbHandle, tables: Pick<JournalTables, 'jobs'>) {
  const { jobs } = tables;
  const read = async (dead: boolean, template?: { readonly name: string }): Promise<readonly QueuedMail[]> => {
    const rows = await db
      .select({
        id: jobs.id,
        args: jobs.args,
        attempts: jobs.attempts,
        lastError: jobs.lastError,
        dedupeKey: jobs.dedupeKey,
      })
      .from(jobs)
      .where(and(eq(jobs.jobName, MAIL_JOB), dead ? isNotNull(jobs.deadAt) : isNull(jobs.deadAt)))
      .orderBy(jobs.id);
    return rows.flatMap(row => {
      const message: unknown =
        typeof row.args === 'object' && row.args !== null ? Reflect.get(row.args, 'message') : undefined;
      if (!isMailMessage(message)) return [];
      if (template !== undefined && message.template !== template.name) return [];
      return [
        {
          jobId: row.id,
          template: message.template,
          to: message.to,
          subject: message.subject,
          text: message.text,
          attempts: row.attempts,
          lastError: row.lastError,
          idempotencyKey: row.dedupeKey,
        },
      ];
    });
  };
  return {
    /** Mail waiting to be sent (or to be retried), optionally of one template. */
    queued: (template?: { readonly name: string }) => read(false, template),
    /** Mail that ran out of tries or failed for good. */
    dead: () => read(true),
  };
}
