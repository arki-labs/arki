/**
 * @arki/journal/foreman
 *
 * The Foreman control-plane module for the journal's jobs: read the jobs, their attempts and the
 * archive, and retry, discard, cancel, purge or replay them under an approved permit. Also holds the
 * Postgres receipt store (`journalReceiptStore`) that moved here from `@arki/admin`.
 * Requires the optional peer `@arki/admin`. The normal `@arki/journal` entry never imports it.
 */
import { z } from 'zod';

import type { Permit } from '@arki/admin/module';
import type { IdGenerationFailure } from '@arki/contracts';
import type { StandardSchemaV1 } from '@arki/schema';
import {
  ADMIN_ERROR_CODES,
  AdminError,
  canonicalJson,
  defineAction,
  defineModule,
  defineRead,
  jsonValueSchema,
  moduleError,
  redactSecrets,
  schemaHash,
} from '@arki/admin/module';
import { ID_GENERATION_FAILURES } from '@arki/contracts';
import { isFailure } from '@arki/failure';

import type {
  ArchivedJob,
  DbHandle,
  JobAttempt,
  JobDetail,
  JobOperation,
  JobOperationInput,
  JobRunner,
  Journal,
  RootDb,
  TransactionSource,
} from '../index.js';
import { isJournalError } from '../index.js';

export {
  foremanReceiptTables,
  journalReceiptStore,
  type ForemanReceiptTables,
  type JournalReceiptStoreOptions,
} from './receipts.js';
export {
  JOURNAL_WORKFLOWS_ERROR_CODES,
  journalWorkflowsModule,
  type JournalWorkflowsModuleOptions,
} from './workflows.js';

/**
 * The coded refusals of the job actions. They are `ARKI_ADMIN_E0xx` codes of `@arki/admin`, so the
 * dispatcher answers them with the right HTTP status (409, or 400 for the purge bound).
 */
export const JOURNAL_JOBS_ERROR_CODES = {
  /** The job (or the set of jobs) changed since the preview the approval pinned. HTTP 409.
   * @fix Refresh the job preview and obtain approval for its current revision before executing.
   * @verify bun run test -- src/foreman/index.test.ts
   */
  staleRevision: 'ARKI_JOURNAL_E001',
  /** The action needs a dead job and the job is not dead, or is gone. HTTP 409.
   * @fix Select an existing dead job; refresh its state before retrying or discarding it.
   * @verify bun run test -- src/foreman/index.test.ts
   */
  notDead: 'ARKI_JOURNAL_E002',
  /** The purge bound is shorter than `journal.retention.retryableFor`. HTTP 400.
   * @fix Set the purge age at least as long as journal.retention.retryableFor.
   * @verify bun run test -- src/foreman/index.test.ts
   */
  boundTooShort: 'ARKI_JOURNAL_E003',
  /** Cancel needs a ready or delayed job and the job is running, dead or gone. HTTP 409.
   * @fix Cancel only a ready or delayed job; refresh the job state first.
   * @verify bun run test -- src/foreman/index.test.ts
   */
  notPending: 'ARKI_JOURNAL_E004',
  /** Replay is blocked by an unfinished job that holds the same dedupe key. HTTP 409.
   * @fix Wait for or reconcile the unfinished job holding the dedupe key before replaying.
   * @verify bun run test -- src/foreman/index.test.ts
   */
  exists: 'ARKI_JOURNAL_E005',
  /** The job belongs to a workflow run, so the raw job actions refuse it. HTTP 409.
   * @fix Use the workflow operations for this job instead of raw job actions.
   * @verify bun run test -- src/foreman/index.test.ts
   */
  managed: 'ARKI_JOURNAL_E006',
} as const;

const MAX_PAGE = 200;
const MAX_RETRY_DEAD = 500;
const MAX_PURGE = 5000;
const DAY_MS = 86_400_000;
/** How many job ids a batch preview lists. The count is always exact. */
const PREVIEW_SAMPLE = 50;

// ---- output schemas ---------------------------------------------------------------------------------------------

/** One try of a job. The error has secrets removed and is capped. */
export const AttemptSummary = z
  .object({
    attempt: z.number().int(),
    startedAt: z.string(),
    finishedAt: z.string().nullable(),
    outcome: z.string().nullable(),
    error: z.string().nullable(),
  })
  .strict();
export type AttemptSummary = z.output<typeof AttemptSummary>;

/** One row of the operations audit: who did what, and why. */
export const OperationSummary = z
  .object({
    id: z.string(),
    action: z.string(),
    actor: z.string(),
    reason: z.string().nullable(),
    executionId: z.string().nullable(),
    /** How many jobs the operation touched. */
    count: z.number().int(),
    at: z.iso.datetime(),
  })
  .strict();
export type OperationSummary = z.output<typeof OperationSummary>;

/** A finished job as the archive keeps it, without its payload and attempt log. */
export const ArchivedSummary = z
  .object({
    id: z.string(),
    kind: z.enum(['effect', 'queue']),
    /** The effect name, or the queue job name. */
    name: z.string(),
    eventSeq: z.number().int().nullable(),
    outcome: z.enum(['completed', 'dead', 'discarded', 'cancelled']),
    attempts: z.number().int(),
    priority: z.number().int(),
    enqueuedAt: z.iso.datetime(),
    finishedAt: z.iso.datetime(),
    archivedAt: z.iso.datetime(),
    keepUntil: z.iso.datetime().nullable(),
    exportedAt: z.iso.datetime().nullable(),
    /** Last error message, with secrets removed. */
    lastError: z.string().nullable(),
    /** The archived job a replay was made from. */
    replayOf: z.string().nullable(),
  })
  .strict();
export type ArchivedSummary = z.output<typeof ArchivedSummary>;

/** A job in the hot table. It never carries its payload. */
export const JobSummary = z
  .object({
    id: z.string(),
    kind: z.enum(['effect', 'queue']),
    /** The effect name, or the queue job name. */
    name: z.string(),
    state: z.enum(['ready', 'delayed', 'running', 'dead']),
    eventSeq: z.number().int().nullable(),
    attempts: z.number().int(),
    priority: z.number().int(),
    availableAt: z.iso.datetime(),
    enqueuedAt: z.iso.datetime(),
    deadAt: z.iso.datetime().nullable(),
    /** Last error message, with secrets removed. */
    lastError: z.string().nullable(),
    replayOf: z.string().nullable(),
  })
  .strict();
export type JobSummary = z.output<typeof JobSummary>;

const EventHeader = z
  .object({
    seq: z.number().int(),
    id: z.string(),
    kind: z.string(),
    entityId: z.string(),
    version: z.number().int(),
    type: z.string(),
    recordedAt: z.iso.datetime(),
  })
  .strict();

const payloadField = z.string().optional();

// ---- options ----------------------------------------------------------------------------------------------------

export type JournalJobsModuleOptions<
  Meta extends StandardSchemaV1<unknown, Record<string, unknown>>,
  Tx extends TransactionSource<Tx>,
  AppDb extends RootDb,
> = {
  /** The app's composed journal. Its `retention` policy is the one source for archive and purge rules. */
  journal: Journal<Meta, Tx, AppDb>;
  /** The root database the job reads and verbs run on. */
  db: DbHandle;
  /**
   * What `journal.job` and `journal.archivedJob` show of a job's payload (the `args` of a queue job).
   * `hidden` (default): nothing. `redacted`: canonical JSON with secrets removed, capped at 500 characters.
   * Lists never carry a payload.
   */
  payload?: 'hidden' | 'redacted';
  /** The worker's `jobs` runner. With it `journal.strandedJobs` also counts queue jobs no handler knows. */
  jobs?: Pick<JobRunner, 'names'>;
};

// ---- helpers ----------------------------------------------------------------------------------------------------

const iso = (date: Date) => date.toISOString();
const isoOrNull = (date: Date | null) => (date === null ? null : date.toISOString());
const errorOrNull = (error: string | null) => (error === null ? null : redactSecrets(error));

type HotJob = Omit<JobDetail, 'event' | 'attemptLog' | 'operations'>;

function toJobSummary(row: HotJob): z.input<typeof JobSummary> {
  return {
    id: row.id,
    kind: row.kind,
    name: row.effect ?? row.jobName ?? '',
    state: row.state,
    eventSeq: row.eventSeq,
    attempts: row.attempts,
    priority: row.priority,
    availableAt: iso(row.availableAt),
    enqueuedAt: iso(row.enqueuedAt),
    deadAt: isoOrNull(row.deadAt),
    lastError: errorOrNull(row.lastError),
    replayOf: row.replayOf,
  };
}

function toArchivedSummary(row: ArchivedJob): z.input<typeof ArchivedSummary> {
  return {
    id: row.id,
    kind: row.kind,
    name: row.effect ?? row.jobName ?? '',
    eventSeq: row.eventSeq,
    outcome: row.outcome,
    attempts: row.attempts,
    priority: row.priority,
    enqueuedAt: iso(row.enqueuedAt),
    finishedAt: iso(row.finishedAt),
    archivedAt: iso(row.archivedAt),
    keepUntil: isoOrNull(row.keepUntil),
    exportedAt: isoOrNull(row.exportedAt),
    lastError: errorOrNull(row.lastError),
    replayOf: row.replayOf,
  };
}

const toAttempt = (row: JobAttempt): z.input<typeof AttemptSummary> => ({
  attempt: row.attempt,
  startedAt: iso(row.startedAt),
  finishedAt: isoOrNull(row.finishedAt),
  outcome: row.outcome,
  error: errorOrNull(row.error),
});

/** The attempt log the archive folded into the row: oldest first, with the same keys as {@link AttemptSummary}. */
const archivedAttemptLog = z
  .array(
    z.object({
      attempt: z.number().int(),
      startedAt: z.string(),
      finishedAt: z.string().nullable(),
      outcome: z.string().nullable(),
      error: z.string().nullable(),
    }),
  )
  .nullable();

function toArchivedAttempts(log: unknown): z.input<typeof AttemptSummary>[] {
  return (archivedAttemptLog.parse(log) ?? []).map(entry => ({ ...entry, error: errorOrNull(entry.error) }));
}

const toOperation = (row: JobOperation): z.input<typeof OperationSummary> => ({
  id: row.id,
  action: row.action,
  actor: row.actor,
  reason: row.reason,
  executionId: row.executionId,
  count: row.count,
  at: iso(row.at),
});

/** The `payload` field of a detail read: absent while the option says `hidden`, and for a job that has no payload. */
function payloadFor(mode: 'hidden' | 'redacted', args: unknown): { payload?: string } {
  if (mode === 'hidden' || args === null || args === undefined) return {};
  return { payload: redactSecrets(canonicalJson(jsonValueSchema.parse(args))) };
}

const notFound = (what: string, id: string) =>
  new AdminError(
    ADMIN_ERROR_CODES.invalidInput,
    `No ${what} has the id "${id}".`,
    `List the ${what}s and pick an id from the list.`,
  );

const stale = (what: string) =>
  moduleError(
    JOURNAL_JOBS_ERROR_CODES.staleRevision,
    409,
    `${what} changed since the preview.`,
    'Preview the action again and approve the new revision.',
  );

const notDead = (id: string) =>
  moduleError(
    JOURNAL_JOBS_ERROR_CODES.notDead,
    409,
    `Job ${id} is not a dead job. It may be running, waiting, finished or gone.`,
    'Reload the dead jobs list.',
  );

const notWaiting = (id: string) =>
  moduleError(
    JOURNAL_JOBS_ERROR_CODES.notPending,
    409,
    `Job ${id} is not a waiting job: it is running, dead or gone.`,
    'A running job finishes or loses its lease on its own. Reload the jobs list and try again later.',
  );

const managed = (id: string) =>
  moduleError(
    JOURNAL_JOBS_ERROR_CODES.managed,
    409,
    `Job ${id} belongs to a workflow run, so a job action cannot change it.`,
    "Use the workflow's own actions on the run.",
  );

/** A journal refusal as the coded admin error an operator sees. Anything else passes through as an app failure. */
function asAdminError(error: unknown, id: string): unknown {
  if (isJournalError(error, 'JOB_MANAGED')) return managed(id);
  if (isJournalError(error, 'JOB_NOT_DEAD')) return notDead(id);
  if (isJournalError(error, 'JOB_NOT_PENDING') || isJournalError(error, 'JOB_RUNNING')) return notWaiting(id);
  if (isJournalError(error, 'JOB_EXISTS')) {
    return moduleError(
      JOURNAL_JOBS_ERROR_CODES.exists,
      409,
      `An unfinished job already holds the dedupe key of archived job ${id}.`,
      'Wait for that job to finish, or cancel it, then replay again.',
    );
  }
  return error;
}

async function guarded<T>(id: string, run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    throw asAdminError(error, id);
  }
}

function operationOf(permit: Permit, reason: string | undefined): JobOperationInput {
  return {
    actor: permit.approvedBy,
    executionId: permit.executionId,
    ...(reason === undefined ? {} : { reason }),
  };
}

/** What a hot job looked like when the operator saw it. Any change of state, attempts or due time voids the approval. */
const jobRevision = (row: HotJob) =>
  `${row.id}:${row.state}:${row.attempts}:${row.deadAt?.getTime() ?? 0}:${row.availableAt.getTime()}`;

const reasonField = z.string().min(1).max(500).optional();
const pageLimit = z.number().int().min(1).max(MAX_PAGE).default(50);
const cursor = z.string().min(1).optional();
const emptyInput = z.object({}).strict();

// ---- the module -------------------------------------------------------------------------------------------------

export function journalJobsModule<
  Meta extends StandardSchemaV1<unknown, Record<string, unknown>>,
  Tx extends TransactionSource<Tx>,
  AppDb extends RootDb,
>(options: JournalJobsModuleOptions<Meta, Tx, AppDb>) {
  const { journal, db } = options;
  const payloadMode = options.payload ?? 'hidden';

  // ---- reads --------------------------------------------------------------------------------------------------

  const jobs = defineRead({
    id: 'journal.jobs',
    summary: 'Jobs in the outbox, pending by default, dead newest first',
    permission: 'journal:read',
    input: z
      .object({
        status: z.enum(['pending', 'ready', 'delayed', 'running', 'dead', 'all']).default('pending'),
        effect: z.string().min(1).optional(),
        job: z.string().min(1).optional(),
        limit: pageLimit,
        after: cursor,
      })
      .strict(),
    output: z.object({ jobs: z.array(JobSummary), next: z.string().nullable() }).strict(),
    load: async ({ status, effect, job, limit, after }, _ctx: Record<string, never>) => {
      const page = await journal.jobs(db, {
        status,
        limit,
        ...(effect === undefined ? {} : { effect }),
        ...(job === undefined ? {} : { job }),
        ...(after === undefined ? {} : { after }),
      });
      return { jobs: page.jobs.map(row => toJobSummary(row)), next: page.next };
    },
  });

  const job = defineRead({
    id: 'journal.job',
    summary: 'One job with its event, attempts and operations',
    permission: 'journal:read',
    input: z.object({ id: z.string().min(1) }).strict(),
    output: z
      .object({
        job: JobSummary,
        event: EventHeader.nullable(),
        attempts: z.array(AttemptSummary),
        operations: z.array(OperationSummary),
        payload: payloadField,
      })
      .strict(),
    load: async ({ id }, _ctx: Record<string, never>) => {
      const detail = await journal.job(db, id);
      if (detail === undefined) throw notFound('job', id);
      return {
        job: toJobSummary(detail),
        event: detail.event === null ? null : { ...detail.event, recordedAt: iso(detail.event.recordedAt) },
        attempts: detail.attemptLog.map(row => toAttempt(row)),
        operations: detail.operations.map(row => toOperation(row)),
        ...payloadFor(payloadMode, detail.args),
      };
    },
  });

  const jobCounts = defineRead({
    id: 'journal.jobCounts',
    summary: 'Per effect and queue job name: ready, delayed, running and dead jobs',
    permission: 'journal:read',
    input: emptyInput,
    output: z
      .object({
        counts: z.array(
          z
            .object({
              kind: z.enum(['effect', 'queue']),
              name: z.string(),
              ready: z.number().int(),
              delayed: z.number().int(),
              running: z.number().int(),
              dead: z.number().int(),
              oldestDeadAt: z.iso.datetime().nullable(),
            })
            .strict(),
        ),
      })
      .strict(),
    load: async (_input, _ctx: Record<string, never>) => {
      const counts = await journal.jobCounts(db);
      return { counts: counts.map(count => ({ ...count, oldestDeadAt: isoOrNull(count.oldestDeadAt) })) };
    },
  });

  const strandedJobs = defineRead({
    id: 'journal.strandedJobs',
    summary: 'Pending jobs no handler on this journal can claim',
    permission: 'journal:read',
    input: emptyInput,
    output: z
      .object({
        stranded: z.array(
          z.object({ kind: z.enum(['effect', 'queue']), name: z.string(), jobs: z.number().int() }).strict(),
        ),
      })
      .strict(),
    load: async (_input, _ctx: Record<string, never>) => {
      const stranded = await journal.strandedJobs(db, options.jobs === undefined ? {} : { jobs: options.jobs });
      return { stranded: stranded.map(row => ({ ...row })) };
    },
  });

  const jobOperations = defineRead({
    id: 'journal.jobOperations',
    summary: 'Who did what to the jobs, newest first',
    permission: 'journal:read',
    input: z.object({ jobId: z.string().min(1).optional(), limit: pageLimit, after: cursor }).strict(),
    output: z.object({ operations: z.array(OperationSummary), next: z.string().nullable() }).strict(),
    load: async ({ jobId, limit, after }, _ctx: Record<string, never>) => {
      const page = await journal.jobOperations(db, {
        limit,
        ...(jobId === undefined ? {} : { jobId }),
        ...(after === undefined ? {} : { after }),
      });
      return { operations: page.operations.map(row => toOperation(row)), next: page.next };
    },
  });

  const archivedJobs = defineRead({
    id: 'journal.archivedJobs',
    summary: 'Finished jobs, newest first',
    permission: 'journal:read',
    input: z
      .object({
        outcome: z.enum(['completed', 'dead', 'discarded', 'cancelled']).optional(),
        effect: z.string().min(1).optional(),
        job: z.string().min(1).optional(),
        limit: pageLimit,
        after: cursor,
      })
      .strict(),
    output: z.object({ jobs: z.array(ArchivedSummary), next: z.string().nullable() }).strict(),
    load: async ({ outcome, effect, job: jobName, limit, after }, _ctx: Record<string, never>) => {
      const page = await journal.archivedJobs(db, {
        limit,
        ...(outcome === undefined ? {} : { outcome }),
        ...(effect === undefined ? {} : { effect }),
        ...(jobName === undefined ? {} : { job: jobName }),
        ...(after === undefined ? {} : { after }),
      });
      return { jobs: page.jobs.map(row => toArchivedSummary(row)), next: page.next };
    },
  });

  const archivedJob = defineRead({
    id: 'journal.archivedJob',
    summary: 'One finished job with its attempt log and operations',
    permission: 'journal:read',
    input: z.object({ id: z.string().min(1) }).strict(),
    output: z
      .object({
        job: ArchivedSummary,
        attempts: z.array(AttemptSummary),
        operations: z.array(OperationSummary),
        payload: payloadField,
      })
      .strict(),
    load: async ({ id }, _ctx: Record<string, never>) => {
      const row = await journal.archivedJob(db, id);
      if (row === undefined) throw notFound('archived job', id);
      const history = await journal.jobOperations(db, { jobId: id });
      return {
        job: toArchivedSummary(row),
        attempts: toArchivedAttempts(row.attemptLog),
        operations: history.operations.map(row => toOperation(row)),
        ...payloadFor(payloadMode, row.args),
      };
    },
  });

  const archiveStatus = defineRead({
    id: 'journal.archiveStatus',
    summary: 'The archive size, the sink backlog and the rows past their keep time',
    permission: 'journal:read',
    input: emptyInput,
    output: z
      .object({
        rows: z.number().int(),
        unexported: z.number().int(),
        oldestUnexportedAt: z.iso.datetime().nullable(),
        pastKeepUntil: z.number().int(),
      })
      .strict(),
    load: async (_input, _ctx: Record<string, never>) => {
      const status = await journal.archiveStatus(db);
      return { ...status, oldestUnexportedAt: isoOrNull(status.oldestUnexportedAt) };
    },
  });

  // ---- single-job actions -------------------------------------------------------------------------------------

  const singleJobInput = z.object({ jobId: z.string().min(1), reason: reasonField }).strict();
  const singleJobPreview = z
    .object({
      revision: z.string(),
      jobId: z.string(),
      name: z.string(),
      attempts: z.number().int(),
      lastError: z.string().nullable(),
      consequence: z.string(),
    })
    .strict();
  const singleJobOutput = z.object({ jobId: z.string(), operationId: z.string() }).strict();

  /** The shape retry, discard and cancel share: preview the job, re-check its revision, run one journal verb. */
  function singleJobAction(def: {
    id: string;
    summary: string;
    permission: `journal:${string}`;
    risk: 'low' | 'medium' | 'high';
    /** The refusal for a job that is gone. */
    missing: (jobId: string) => AdminError;
    /** Throws the coded refusal when the job is not in the state this action needs. */
    require: (row: HotJob) => void;
    consequence: (row: HotJob) => string;
    run: (jobId: string, op: JobOperationInput) => Promise<{ operationId: string } | IdGenerationFailure>;
  }) {
    const load = async (jobId: string): Promise<HotJob | undefined> => journal.job(db, jobId);
    return defineAction({
      id: def.id,
      summary: def.summary,
      permission: def.permission,
      risk: def.risk,
      input: singleJobInput,
      previewOutput: singleJobPreview,
      output: singleJobOutput,
      failures: ID_GENERATION_FAILURES,
      preview: async ({ jobId }, _ctx: Record<string, never>) => {
        const row = await load(jobId);
        if (row === undefined) throw def.missing(jobId);
        def.require(row);
        return {
          revision: jobRevision(row),
          jobId,
          name: row.effect ?? row.jobName ?? '',
          attempts: row.attempts,
          lastError: errorOrNull(row.lastError),
          consequence: def.consequence(row),
        };
      },
      execute: async ({ jobId, reason }, _ctx: Record<string, never>, permit) => {
        const row = await load(jobId);
        if (row === undefined || jobRevision(row) !== permit.expectedRevision) throw stale(`Job ${jobId}`);
        const done = await guarded(jobId, () => def.run(jobId, operationOf(permit, reason)));
        if (isFailure(done)) return done;
        return { jobId, operationId: done.operationId };
      },
    });
  }

  const requireDead = (row: HotJob) => {
    if (row.state !== 'dead') throw notDead(row.id);
  };

  const retryJob = singleJobAction({
    id: 'journal.retryJob',
    summary: 'Retry one dead job',
    permission: 'journal:retry',
    // A retry runs the job's side effects once more. It never deletes data.
    risk: 'low',
    missing: notDead,
    require: requireDead,
    consequence: row =>
      `Job "${row.effect ?? row.jobName ?? ''}" goes back to pending with a clean attempt count and runs again. If it ran side effects before it died, they may repeat.`,
    run: (jobId, op) => journal.retry(db, jobId, op),
  });

  const discardJob = singleJobAction({
    id: 'journal.discardJob',
    summary: 'Give up on one dead job',
    permission: 'journal:delete',
    risk: 'medium',
    missing: notDead,
    require: requireDead,
    consequence: row =>
      `Job "${row.effect ?? row.jobName ?? ''}" is removed and will never run. ${
        journal.retention.dead.store
          ? 'It is archived as "discarded" and kept per the retention policy.'
          : 'The retention policy keeps no dead jobs, so nothing of it is kept.'
      }`,
    run: (jobId, op) => journal.discard(db, jobId, op),
  });

  const cancelJob = singleJobAction({
    id: 'journal.cancelJob',
    summary: 'Cancel one waiting job',
    permission: 'journal:delete',
    // A cancelled job never runs: the work it stood for is dropped, and a running job cannot be cancelled.
    risk: 'high',
    missing: notWaiting,
    require: row => {
      if (row.state !== 'ready' && row.state !== 'delayed') throw notWaiting(row.id);
    },
    consequence: row =>
      `Job "${row.effect ?? row.jobName ?? ''}" is removed before it runs, so the work it stands for never happens. ${
        journal.retention.dead.store
          ? 'It is archived as "cancelled" and kept per the retention policy.'
          : 'The retention policy keeps no dead jobs, so nothing of it is kept.'
      }`,
    run: (jobId, op) => journal.cancel(db, jobId, op),
  });

  // ---- batch actions ------------------------------------------------------------------------------------------

  /** The dead jobs a `retryDead` input names: the ids, or the newest dead jobs matching the filter, as the list shows them. */
  async function selectDead(input: {
    ids?: string[] | undefined;
    effect?: string | undefined;
    job?: string | undefined;
    limit: number;
  }): Promise<{ rows: HotJob[]; notDead: string[] }> {
    if (input.ids !== undefined) {
      if (input.effect !== undefined || input.job !== undefined) {
        throw new AdminError(
          ADMIN_ERROR_CODES.invalidInput,
          'Give either ids or an effect/job filter, not both.',
          'Remove the filter, or remove the ids.',
        );
      }
      const wanted = [...new Set(input.ids)];
      const rows = await Promise.all(wanted.map(id => journal.job(db, id)));
      const bad = wanted.filter((_id, index) => rows[index]?.state !== 'dead');
      return { rows: rows.flatMap(row => (row?.state === 'dead' ? [row] : [])), notDead: bad };
    }
    const picked: HotJob[] = [];
    let after: string | undefined;
    while (picked.length < input.limit) {
      const page = await journal.jobs(db, {
        status: 'dead',
        limit: Math.min(MAX_PAGE, input.limit - picked.length),
        ...(input.effect === undefined ? {} : { effect: input.effect }),
        ...(input.job === undefined ? {} : { job: input.job }),
        ...(after === undefined ? {} : { after }),
      });
      // A run's own dead step is not the operator's to retry in bulk: the run's actions move it.
      picked.push(...page.jobs.filter(job => job.runId === null));
      if (page.next === null) break;
      after = page.next;
    }
    return { rows: picked, notDead: [] };
  }

  /** The approved set: every id with its attempts and death time, in id order. Any change to any job voids the approval. */
  const setRevision = (rows: readonly HotJob[]) =>
    schemaHash(
      rows
        .map(row => [row.id, row.attempts, row.deadAt?.getTime() ?? 0] as [string, number, number])
        .toSorted((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)),
    );

  const retryDead = defineAction({
    failures: ID_GENERATION_FAILURES,
    id: 'journal.retryDead',
    summary: 'Retry many dead jobs at once',
    permission: 'journal:retry',
    risk: 'medium',
    input: z
      .object({
        ids: z.array(z.string().min(1)).min(1).max(MAX_RETRY_DEAD).optional(),
        effect: z.string().min(1).optional(),
        job: z.string().min(1).optional(),
        limit: z.number().int().min(1).max(MAX_RETRY_DEAD).default(100),
        reason: reasonField,
      })
      .strict(),
    previewOutput: z
      .object({
        revision: z.string(),
        count: z.number().int(),
        /** The first jobs of the set. `count` is the whole set. */
        jobs: z.array(z.object({ id: z.string(), name: z.string() }).strict()),
        consequence: z.string(),
      })
      .strict(),
    output: z.object({ ids: z.array(z.string()), operationId: z.string().nullable() }).strict(),
    preview: async (input, _ctx: Record<string, never>) => {
      const { rows, notDead: bad } = await selectDead(input);
      if (bad.length > 0) {
        throw moduleError(
          JOURNAL_JOBS_ERROR_CODES.notDead,
          409,
          `Not dead jobs: ${bad.slice(0, 5).join(', ')}${bad.length > 5 ? ` and ${bad.length - 5} more` : ''}. Nothing was selected.`,
          'Reload the dead jobs list.',
        );
      }
      return {
        revision: await setRevision(rows),
        count: rows.length,
        jobs: rows.slice(0, PREVIEW_SAMPLE).map(row => ({ id: row.id, name: row.effect ?? row.jobName ?? '' })),
        consequence: `${rows.length} dead job(s) go back to pending and run again. If they ran side effects before they died, those may repeat. All of them are retried, or none.`,
      };
    },
    execute: async (input, _ctx: Record<string, never>, permit) => {
      const { rows, notDead: bad } = await selectDead(input);
      // A job of the set is no longer dead: the set is not the one that was approved.
      if (bad.length > 0) throw stale('The job set');
      if ((await setRevision(rows)) !== permit.expectedRevision) throw stale('The job set');
      if (rows.length === 0) return { ids: [], operationId: null };
      const ids = rows.map(row => row.id);
      const done = await guarded(ids.join(','), () =>
        journal.retryDead(db, { ids }, operationOf(permit, input.reason)),
      );
      if (isFailure(done)) return done;
      return { ids: [...done.ids], operationId: done.operationId };
    },
  });

  const purgeDead = defineAction({
    failures: ID_GENERATION_FAILURES,
    id: 'journal.purgeDead',
    summary: 'Move old dead jobs out of the outbox, archived or deleted by the retention policy',
    permission: 'journal:delete',
    risk: 'medium',
    input: z
      .object({
        /** Dead jobs that died more than this many days ago. Not shorter than `journal.retention.retryableFor`. */
        olderThanDays: z.number().positive(),
        limit: z.number().int().min(1).max(MAX_PURGE).default(1000),
        reason: reasonField,
      })
      .strict(),
    previewOutput: z
      .object({
        revision: z.string(),
        deadJobs: z.number().int(),
        oldestDeadAt: z.iso.datetime().nullable(),
        /** `archive`: the policy keeps dead jobs in the archive. `delete`: it keeps nothing. */
        willDo: z.enum(['archive', 'delete']),
        consequence: z.string(),
      })
      .strict(),
    output: z
      .object({ archived: z.number().int(), deleted: z.number().int(), operationId: z.string().nullable() })
      .strict(),
    preview: async ({ olderThanDays, limit }, _ctx: Record<string, never>) => {
      requireLongEnough(olderThanDays);
      const state = await deadState();
      const willDo: 'archive' | 'delete' = journal.retention.dead.store ? 'archive' : 'delete';
      return {
        revision: state.revision,
        deadJobs: state.deadJobs,
        oldestDeadAt: isoOrNull(state.oldestDeadAt),
        willDo,
        consequence: `Up to ${limit} dead job(s) that died more than ${olderThanDays} day(s) ago, oldest first, leave the outbox and can no longer be retried. ${
          willDo === 'archive'
            ? 'They are archived as "dead" and kept per the retention policy.'
            : 'The retention policy keeps no dead jobs, so they are deleted for good.'
        } An effect with its own retention may differ.`,
      };
    },
    execute: async ({ olderThanDays, limit, reason }, _ctx: Record<string, never>, permit) => {
      requireLongEnough(olderThanDays);
      const state = await deadState();
      if (state.revision !== permit.expectedRevision) throw stale('The dead jobs');
      try {
        return await journal.purgeDead(
          db,
          { olderThan: new Date(Date.now() - olderThanDays * DAY_MS), limit },
          operationOf(permit, reason),
        );
      } catch (error) {
        // The journal checks the same bound; a clock that moved between the two checks lands here.
        if (isJournalError(error, 'BAD_ARGUMENT')) throw boundTooShort(olderThanDays);
        throw error;
      }
    },
  });

  function boundTooShort(olderThanDays: number) {
    const retryableForDays = journal.retention.retryableForMs / DAY_MS;
    return moduleError(
      JOURNAL_JOBS_ERROR_CODES.boundTooShort,
      400,
      `${olderThanDays} day(s) is shorter than the ${retryableForDays} day(s) a dead job stays retryable (journal.retention.retryableFor).`,
      `Use olderThanDays of ${Math.ceil(retryableForDays)} or more.`,
    );
  }

  function requireLongEnough(olderThanDays: number) {
    if (olderThanDays * DAY_MS < journal.retention.retryableForMs) throw boundTooShort(olderThanDays);
  }

  /**
   * The dead backlog purge can touch, as one revision: how many jobs, and how old the oldest is. A retry or a new death
   * changes it. A job a workflow run owns is the run's to move, so it is not counted.
   */
  async function deadState() {
    let deadJobs = 0;
    let oldest: Date | null = null;
    let after: string | undefined;
    for (;;) {
      const page = await journal.jobs(db, {
        status: 'dead',
        limit: MAX_PAGE,
        ...(after === undefined ? {} : { after }),
      });
      for (const row of page.jobs) {
        if (row.runId !== null) continue;
        deadJobs += 1;
        if (row.deadAt !== null && (oldest === null || row.deadAt.getTime() < oldest.getTime())) oldest = row.deadAt;
      }
      if (page.next === null) break;
      after = page.next;
    }
    return { deadJobs, oldestDeadAt: oldest, revision: `${deadJobs}:${oldest?.getTime() ?? 0}` };
  }

  // ---- replay -------------------------------------------------------------------------------------------------

  const replayRevision = (row: ArchivedJob) => `${row.id}:${row.archivedAt.getTime()}`;

  const replayJob = defineAction({
    failures: ID_GENERATION_FAILURES,
    id: 'journal.replayJob',
    summary: 'Run a finished job again as a new job',
    permission: 'journal:retry',
    // A replay is a new job with a new id, so a provider that deduped on the old job id will not dedupe this run.
    risk: 'high',
    input: z.object({ id: z.string().min(1), reason: reasonField }).strict(),
    previewOutput: z
      .object({
        revision: z.string(),
        id: z.string(),
        name: z.string(),
        outcome: z.enum(['completed', 'dead', 'discarded', 'cancelled']),
        consequence: z.string(),
      })
      .strict(),
    output: z.object({ jobId: z.string(), operationId: z.string() }).strict(),
    preview: async ({ id }, _ctx: Record<string, never>) => {
      const row = await journal.archivedJob(db, id);
      if (row === undefined) throw notFound('archived job', id);
      return {
        revision: replayRevision(row),
        id,
        name: row.effect ?? row.jobName ?? '',
        outcome: row.outcome,
        consequence: `A new job is made from archived job ${id} and runs "${row.effect ?? row.jobName ?? ''}" again with the same input. It has a new job id: a provider that deduped on the original id will not dedupe this run, so its side effects may happen twice. It is blocked while an unfinished job holds the same dedupe key.`,
      };
    },
    execute: async ({ id, reason }, _ctx: Record<string, never>, permit) => {
      const row = await journal.archivedJob(db, id);
      if (row === undefined || replayRevision(row) !== permit.expectedRevision) throw stale(`Archived job ${id}`);
      return guarded(id, () => journal.replayJob(db, id, operationOf(permit, reason)));
    },
  });

  return defineModule({
    id: '@arki/journal',
    version: '1.0.0',
    reads: { jobs, job, jobCounts, strandedJobs, jobOperations, archivedJobs, archivedJob, archiveStatus },
    actions: { retryJob, retryDead, discardJob, cancelJob, purgeDead, replayJob },
  });
}
