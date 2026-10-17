/** Coded failures of the Foreman retry action. Match on `code`, never on the message. Thrown as `ModuleError`s (`moduleError` from `@arki/admin/module`), so Foreman answers each with its own HTTP status. */
export const QUEUE_FOREMAN_ERROR_CODES = {
  /** The job changed since the preview the approval pinned (it failed again, or was touched). HTTP 409. */
  staleRevision: 'ARKI_QUEUE_E014',
  /** The job is no longer failed: it was already re-queued, or it is gone. HTTP 409. */
  notFailed: 'ARKI_QUEUE_E015',
  /** The module has no queue under that key. HTTP 404. */
  unknownQueue: 'ARKI_QUEUE_E016',
} as const;

export type QueueForemanErrorCode = (typeof QUEUE_FOREMAN_ERROR_CODES)[keyof typeof QUEUE_FOREMAN_ERROR_CODES];
