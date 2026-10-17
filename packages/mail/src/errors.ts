/**
 * Stable codes for mistakes in how the package is used: bad config, a message that cannot be
 * sent as written, data the queue cannot hold. They are thrown as {@link MailError}. A mail that
 * is not sent for a reason the caller must expect is a returned failure instead (`failures.ts`).
 */

export const MAIL_ERROR_CODES = {
  /** No transport, a duplicate transport id, an empty key or sender, a transport SDK that cannot load. */
  invalidConfig: 'ARKI_MAIL_E001',
  /** No recipient, a line break in a header or address, a reserved header. */
  invalidMessage: 'ARKI_MAIL_E002',
  /** A field the transport cannot carry. Thrown before any request. */
  unsupported: 'ARKI_MAIL_E005',
  /** A durable send was given the root database handle instead of a transaction. */
  needsTransaction: 'ARKI_MAIL_E009',
  /** Queued input is not plain JSON, or too large. */
  badQueuedData: 'ARKI_MAIL_E010',
} as const;

export type MailErrorCode = (typeof MAIL_ERROR_CODES)[keyof typeof MAIL_ERROR_CODES];

/** A mistake in how the package is used. Match on `code`, never on the message. */
export class MailError extends Error {
  readonly code: MailErrorCode;

  constructor(code: MailErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'MailError';
    this.code = code;
  }
}

export function isMailError(error: unknown): error is MailError {
  return error instanceof MailError;
}

/** Throws a configuration error. */
export function invalidConfig(message: string): never {
  throw new MailError(MAIL_ERROR_CODES.invalidConfig, message);
}
