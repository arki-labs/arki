/**
 * Stable error codes. A send returns them in `MailResult.error`; configuration mistakes and the
 * durable runner throw them as {@link MailError}.
 */
import type { MailFailure, MailResult } from './types.js';

export const MAIL_ERROR_CODES = {
  /** No transport, a duplicate transport id, an empty key or sender. */
  invalidConfig: 'ARKI_MAIL_E001',
  /** No recipient, a line break in a header or address, a reserved header. */
  invalidMessage: 'ARKI_MAIL_E002',
  /** The template's schema refused the input. */
  invalidInput: 'ARKI_MAIL_E003',
  /** Every transport is over its monthly quota. Nothing was sent. */
  quotaExhausted: 'ARKI_MAIL_E004',
  /** A field the transport cannot carry. Refused before any request. */
  unsupported: 'ARKI_MAIL_E005',
  /** The service refused the mail. `retryable` says whether trying later can help. */
  rejected: 'ARKI_MAIL_E006',
  /** Timeout or network failure. The service may have taken the mail. */
  uncertain: 'ARKI_MAIL_E007',
  /** The service answered, but the answer could not be read. */
  badResponse: 'ARKI_MAIL_E008',
  /** A durable send was given the root database handle instead of a transaction. */
  needsTransaction: 'ARKI_MAIL_E009',
  /** Queued input is not plain JSON, or too large. */
  badQueuedData: 'ARKI_MAIL_E010',
  /** A queued mail's `expiresAt` passed before it could be delivered. */
  expired: 'ARKI_MAIL_E011',
} as const;

export type MailErrorCode = (typeof MAIL_ERROR_CODES)[keyof typeof MAIL_ERROR_CODES];

/** A failure as a thrown error, for configuration mistakes and for the journal runner. */
export class MailError extends Error {
  readonly code: MailErrorCode;
  readonly retryable: boolean;
  readonly acceptance: 'none' | 'unknown';
  readonly failure: MailFailure;

  constructor(failure: MailFailure, options?: ErrorOptions) {
    super(failure.message, options);
    this.name = 'MailError';
    this.code = failure.code;
    this.retryable = failure.retryable;
    this.acceptance = failure.acceptance;
    this.failure = failure;
  }
}

export function isMailError(error: unknown): error is MailError {
  return error instanceof MailError;
}

/** A failure that the caller can fix and that no retry will change. */
export function permanent(code: MailErrorCode, message: string, extra?: Partial<MailFailure>): MailFailure {
  return { code, message, retryable: false, acceptance: 'none', ...extra };
}

export function failed<T>(failure: MailFailure): MailResult<T> {
  return { data: null, error: failure };
}

export function ok<T>(data: T): MailResult<T> {
  return { data, error: null };
}

/** Throws a configuration error. */
export function invalidConfig(message: string): never {
  throw new MailError(permanent(MAIL_ERROR_CODES.invalidConfig, message));
}
