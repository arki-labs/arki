/**
 * How every transport turns what a service said into a `MailFailure`. One mapping, so failover
 * and the journal runner see the same `retryable` and `acceptance` whichever service failed.
 */
import type { MailFailure, MailMessage, MailResult, RecipientOutcome } from './types.js';
import { MAIL_ERROR_CODES } from './errors.js';
import { errorField, log } from './log.js';
import { listOf } from './message.js';

/**
 * The service answered with an error status. 429 and 5xx can pass on a later try; any other
 * status means the request itself is wrong and will fail again.
 */
export function rejection(
  transport: string,
  status: number,
  detail: { readonly message?: string; readonly providerCode?: string } = {},
): MailFailure {
  const reason = detail.message === undefined || detail.message === '' ? '' : `: ${detail.message}`;
  return {
    code: MAIL_ERROR_CODES.rejected,
    message: `${transport} refused the mail (HTTP ${status})${reason}`,
    retryable: status === 429 || status >= 500,
    acceptance: 'none',
    transport,
    status,
    ...(detail.providerCode === undefined ? {} : { providerCode: detail.providerCode }),
  };
}

/** The request failed in transit, timed out or was aborted. The service may have taken the mail. */
export function uncertain(transport: string, error: unknown): MailFailure {
  return {
    code: MAIL_ERROR_CODES.uncertain,
    message: `${transport}: no answer from the service (${errorField(error).message})`,
    retryable: true,
    acceptance: 'unknown',
    transport,
  };
}

/** The service answered with success, but the answer could not be read. */
export function badResponse(transport: string, status: number, problem: string): MailFailure {
  return {
    code: MAIL_ERROR_CODES.badResponse,
    message: `${transport}: unreadable answer (HTTP ${status}): ${problem}`,
    retryable: true,
    acceptance: 'unknown',
    transport,
    status,
  };
}

/** A field this transport cannot carry. Returned before any request, so nothing was sent. */
export function unsupported(transport: string, problem: string): MailFailure {
  return {
    code: MAIL_ERROR_CODES.unsupported,
    message: `${transport} cannot send this mail: ${problem}`,
    retryable: false,
    acceptance: 'none',
    transport,
  };
}

/** Every recipient of `message`, with one status. */
export function everyRecipient(message: MailMessage, status: RecipientOutcome['status']): readonly RecipientOutcome[] {
  return [...listOf(message.to), ...listOf(message.cc), ...listOf(message.bcc)].map(address => ({ address, status }));
}

/** Logs the outcome of one send at debug level and returns it unchanged. */
export function logged(transport: string, result: MailResult): MailResult {
  if (result.error === null) {
    log.debug('{transport} sent id={id} status={status}', {
      transport,
      id: result.data.id,
      status: result.data.status,
    });
  } else {
    log.debug('{transport} failed {code}: {message}', {
      transport,
      code: result.error.code,
      message: result.error.message,
    });
  }
  return result;
}
