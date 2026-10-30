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
  detail: { readonly message?: string; readonly providerCode?: string; readonly retryAfterMs?: number } = {},
) {
  return MailRejected({
    transport,
    retryable: status === 429 || status >= 500,
    upstreamStatus: status,
    ...(detail.message === undefined || detail.message === '' ? {} : { detail: detail.message }),
    ...(detail.providerCode === undefined ? {} : { providerCode: detail.providerCode }),
    ...(detail.retryAfterMs === undefined ? {} : { retryAfterMs: detail.retryAfterMs }),
  });
}

/** The longest a request may wait for the service, in milliseconds, when the transport sets no `timeoutMs`. */
export const DEFAULT_TIMEOUT_MS = 30_000;

/**
 * The signal one request runs under: the caller's `signal` joined with a timeout. After a failure,
 * `reason()` says which of them ended it, so a caller's cancel is not reported as an outage.
 */
export function requestSignal(caller: AbortSignal | undefined, timeoutMs = DEFAULT_TIMEOUT_MS) {
  const timeout = AbortSignal.timeout(timeoutMs);
  return {
    signal: caller === undefined ? timeout : AbortSignal.any([caller, timeout]),
    reason: (): 'cancelled' | 'timeout' | 'network' => {
      if (caller?.aborted === true) return 'cancelled';
      return timeout.aborted ? 'timeout' : 'network';
    },
  };
}

/** Milliseconds to wait from a `Retry-After` header (whole seconds or an HTTP date), or `undefined`. */
export function retryAfterMs(header: string | null | undefined): number | undefined {
  if (header === null || header === undefined) return undefined;
  const seconds = Number(header);
  if (header.trim() !== '' && Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1000);
  const date = Date.parse(header);
  return Number.isNaN(date) ? undefined : Math.max(0, date - Date.now());
}

/**
 * The request failed in transit, timed out or was aborted (`reason` says which). The service may
 * have taken the mail.
 */
export function uncertain(transport: string, error: unknown, reason: 'cancelled' | 'timeout' | 'network') {
  return MailUncertain(
    { transport, detail: `no answer from the service (${errorField(error).message})`, reason },
    { cause: error },
  );
}

/** The service answered with success, but the answer could not be read. It may have taken the mail. */
export function badResponse(transport: string, status: number, problem: string) {
  return MailUncertain({
    transport,
    detail: `unreadable answer (HTTP ${status}): ${problem}`,
    upstreamStatus: status,
    reason: 'unreadable',
  });
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
