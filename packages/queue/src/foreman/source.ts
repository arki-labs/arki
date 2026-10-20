/** One failed job, as a queue backend reports it. */
export type FailedJobRecord = {
  id: string;
  /** The job (queue) name. */
  name: string;
  /** External stable key, when it differs from the native provider identity. */
  key?: string;
  attempts: number;
  /** The raw last error message. The module redacts it before it leaves the app. */
  error: string | null;
  failedAt: Date;
  /** Changes whenever the job fails again or leaves the failed state. */
  revision: string;
};

/**
 * What the Foreman module needs from one queue backend.
 * `pgBossFailedJobSource` implements it for runtime-local (pg-boss on PGlite).
 */
export type FailedJobSource = {
  /** Failed jobs, newest first, plus the total count. */
  listFailed(page: { limit: number; offset: number }): Promise<{ jobs: FailedJobRecord[]; total: number }>;
  /** The job if it is failed right now; `undefined` when it is gone or already re-queued. */
  getFailed(id: string): Promise<FailedJobRecord | undefined>;
  /**
   * Re-queue the job only while it is still failed with `expectedRevision`, in one atomic step.
   * Returns `false` when it no longer matches, so nothing was written.
   */
  retryFailed(id: string, expectedRevision: string): Promise<boolean>;
};
