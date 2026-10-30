/**
 * Stable codes for mistakes in how the package is used: bad config, a message that cannot be
 * sent as written, data the queue cannot hold. They are thrown as {@link MailError}. A mail that
 * is not sent for a reason the caller must expect is a returned failure instead (`failures.ts`).
 */

export const MAIL_ERROR_CODES = {
  /**
   * No transport, a duplicate transport id, an empty key or sender, a transport SDK that cannot load.
   *
   * @fix Pass one transport with a unique id and a sender, and install the transport's SDK peer.
   * @verify bun run test -- src/mailer.spec.ts
   */
  invalidConfig: 'ARKI_MAIL_E001',
  /**
   * A queued mail needs exactly one `to` recipient and no cc or bcc. (A message that cannot be
   * sent as written is the returned failure `MailInvalidMessage`, not this code.)
   *
   * @fix Queue one mail per recipient, with the recipient in `to` only.
   * @verify bun run test -- src/pg
   */
  invalidMessage: 'ARKI_MAIL_E002',
  /**
   * A field the transport cannot carry. Thrown before any request.
   *
   * @fix Drop the field, or pick a transport that carries it (see the transport table in the README).
   * @verify bun run test -- src/message.spec.ts
   */
  unsupported: 'ARKI_MAIL_E005',
  /**
   * A durable send was given the root database handle instead of a transaction.
   *
   * @fix Call `enqueue` inside `db.transaction(async tx => ...)` and pass `tx`.
   * @verify bun run test -- src/pg
   */
  needsTransaction: 'ARKI_MAIL_E009',
  /**
   * A queue row does not hold a readable mail (a row edited by hand, or written by an older version).
   * (A mail over `maxBytes` is the returned failure `MailTooLarge`.)
   *
   * @fix Dead-letter the row and queue the mail again.
   * @verify bun run test -- src/pg
   */
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
