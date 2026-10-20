/** Coded failures of the Foreman retry action. Match on `code`, never on the message. Thrown as `ModuleError`s (`moduleError` from `@arki/admin/module`), so Foreman answers each with its own HTTP status. */
export const QUEUE_FOREMAN_ERROR_CODES = {
  /** The job changed since the preview the approval pinned (it failed again, or was touched). HTTP 409.
   * @fix Refresh the failed-job preview and obtain approval for its current revision.
   * @verify bun run test -- src/foreman/foreman.spec.ts
   */
  staleRevision: 'ARKI_QUEUE_E014',
  /** The job is no longer failed: it was already re-queued, or it is gone. HTTP 409.
   * @fix Refresh the job state and select an existing failed job before retrying.
   * @verify bun run test -- src/foreman/foreman.spec.ts
   */
  notFailed: 'ARKI_QUEUE_E015',
  /** The module has no queue under that key. HTTP 404.
   * @fix Use a queue key registered by the module.
   * @verify bun run test -- src/foreman/foreman.spec.ts
   */
  unknownQueue: 'ARKI_QUEUE_E016',
} as const;

export type QueueForemanErrorCode = (typeof QUEUE_FOREMAN_ERROR_CODES)[keyof typeof QUEUE_FOREMAN_ERROR_CODES];
