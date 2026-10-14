/** Coded failures of the Foreman retry action. Match on `code`, never on the message. */
export const QUEUE_FOREMAN_ERROR_CODES = {
  /** The job changed since the preview the approval pinned (it failed again, or was touched). */
  staleRevision: 'ARKI_QUEUE_E014',
  /** The job is no longer failed: it was already re-queued, or it is gone. */
  notFailed: 'ARKI_QUEUE_E015',
  /** The module has no queue under that key. */
  unknownQueue: 'ARKI_QUEUE_E016',
} as const;

export type QueueForemanErrorCode = (typeof QUEUE_FOREMAN_ERROR_CODES)[keyof typeof QUEUE_FOREMAN_ERROR_CODES];

export class QueueForemanError extends Error {
  readonly code: QueueForemanErrorCode;
  /** What to do about it, in one sentence. */
  readonly remediation: string;

  constructor(code: QueueForemanErrorCode, message: string, remediation: string) {
    super(`${code}: ${message}`);
    this.name = 'QueueForemanError';
    this.code = code;
    this.remediation = remediation;
  }
}
