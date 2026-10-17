/**
 * How every transport turns what a service said into a failure. One mapping, so failover and
 * the journal runner see the same `retryable` and the same kind whichever service failed.
 */
import type { Result } from '@arki/failure';
import { isFailure } from '@arki/failure';

import type { MailMessage, RecipientOutcome, SentMail, TransportFailure } from './types.js';
import { MAIL_ERROR_CODES, MailError } from './errors.js';
import { MailRejected, MailUncertain } from './failures.js';
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
) {
  return MailRejected({
    transport,
    retryable: status === 429 || status >= 500,
    upstreamStatus: status,
    ...(detail.message === undefined || detail.message === '' ? {} : { detail: detail.message }),
    ...(detail.providerCode === undefined ? {} : { providerCode: detail.providerCode }),
  });
}

/** The request failed in transit, timed out or was aborted. The service may have taken the mail. */
export function uncertain(transport: string, error: unknown) {
  return MailUncertain(
    { transport, detail: `no answer from the service (${errorField(error).message})` },
    { cause: error },
  );
}

/** The service answered with success, but the answer could not be read. It may have taken the mail. */
export function badResponse(transport: string, status: number, problem: string) {
  return MailUncertain({ transport, detail: `unreadable answer (HTTP ${status}): ${problem}`, upstreamStatus: status });
}

/** A field this transport cannot carry. Thrown before any request, so nothing was sent. */
export function unsupported(transport: string, problem: string): never {
  throw new MailError(MAIL_ERROR_CODES.unsupported, `${transport} cannot send this mail: ${problem}`);
}

/** Every recipient of `message`, with one status. */
export function everyRecipient(message: MailMessage, status: RecipientOutcome['status']): readonly RecipientOutcome[] {
  return [...listOf(message.to), ...listOf(message.cc), ...listOf(message.bcc)].map(address => ({ address, status }));
}

/** Logs the outcome of one send at debug level and returns it unchanged. */
export function logged(
  transport: string,
  result: Result<SentMail, TransportFailure>,
): Result<SentMail, TransportFailure> {
  if (isFailure(result)) {
    log.debug('{transport} failed {code}: {message}', { transport, code: result.code, message: result.message });
  } else {
    log.debug('{transport} sent id={id} status={status}', { transport, id: result.id, status: result.status });
  }
  return result;
}
