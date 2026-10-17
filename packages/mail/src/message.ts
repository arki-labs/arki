/**
 * Checks on a message before any transport sees it. A line break in a header or an address
 * would let input add headers of its own (header injection), so it is refused, not cleaned.
 */
import type { Addresses, MailMessage } from './types.js';
import { MAIL_ERROR_CODES, MailError } from './errors.js';

/** Headers the message fields own. Setting them through `headers` would contradict those fields. */
const RESERVED_HEADERS = new Set([
  'from',
  'to',
  'cc',
  'bcc',
  'reply-to',
  'subject',
  'content-type',
  'content-transfer-encoding',
  'mime-version',
]);

const LINE_BREAK = /[\r\n]/;

/** Addresses as a list; `undefined` is an empty list. */
export function listOf(addresses: Addresses | undefined): readonly string[] {
  if (addresses === undefined) return [];
  return typeof addresses === 'string' ? [addresses] : addresses;
}

const invalid = (message: string): never => {
  throw new MailError(MAIL_ERROR_CODES.invalidMessage, message);
};

/**
 * Throws `ARKI_MAIL_E002` on the first problem with `message`. Addresses and headers come from
 * the caller's code, so a bad one is a bug to fix (validate user input first), not an outcome.
 */
export function checkMessage(message: MailMessage): void {
  const recipients = [...listOf(message.to), ...listOf(message.cc), ...listOf(message.bcc)];
  if (recipients.length === 0) invalid('A mail needs at least one recipient in to, cc or bcc.');
  const addresses = [message.from, ...recipients, ...listOf(message.replyTo)];
  if (addresses.some(address => address.trim() === '')) invalid('An address is empty.');
  if (addresses.some(address => LINE_BREAK.test(address))) invalid('An address contains a line break.');
  if (LINE_BREAK.test(message.subject)) invalid('The subject contains a line break.');
  for (const [name, value] of Object.entries(message.headers ?? {})) {
    if (LINE_BREAK.test(name) || LINE_BREAK.test(value)) invalid(`Header "${name}" contains a line break.`);
    if (RESERVED_HEADERS.has(name.toLowerCase())) {
      invalid(`Header "${name}" is set by the message itself; use the matching field instead.`);
    }
  }
}

/**
 * Staging guard: every mail goes to `redirectTo` instead. Cc and Bcc are dropped so no real
 * person is copied; the original To is kept in `X-Original-To` for debugging.
 */
export function redirect(message: MailMessage, redirectTo: Addresses): MailMessage {
  const { cc: _cc, bcc: _bcc, ...rest } = message;
  return {
    ...rest,
    to: redirectTo,
    headers: { ...message.headers, 'X-Original-To': listOf(message.to).join(', ') },
  };
}
