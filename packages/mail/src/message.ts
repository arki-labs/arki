/**
 * Checks on a message before any transport sees it. A line break in a header or an address
 * would let input add headers of its own (header injection), so it is refused, not cleaned.
 */
import type { Addresses, MailFailure, MailMessage } from './types.js';
import { MAIL_ERROR_CODES, permanent } from './errors.js';

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

const invalid = (message: string): MailFailure => permanent(MAIL_ERROR_CODES.invalidMessage, message);

/** The first problem with `message`, or `undefined` when it can be sent. */
export function checkMessage(message: MailMessage): MailFailure | undefined {
  const recipients = [...listOf(message.to), ...listOf(message.cc), ...listOf(message.bcc)];
  if (recipients.length === 0) return invalid('A mail needs at least one recipient in to, cc or bcc.');
  const addresses = [message.from, ...recipients, ...listOf(message.replyTo)];
  if (addresses.some(address => address.trim() === '')) return invalid('An address is empty.');
  if (addresses.some(address => LINE_BREAK.test(address))) return invalid('An address contains a line break.');
  if (LINE_BREAK.test(message.subject)) return invalid('The subject contains a line break.');
  for (const [name, value] of Object.entries(message.headers ?? {})) {
    if (LINE_BREAK.test(name) || LINE_BREAK.test(value)) return invalid(`Header "${name}" contains a line break.`);
    if (RESERVED_HEADERS.has(name.toLowerCase())) {
      return invalid(`Header "${name}" is set by the message itself; use the matching field instead.`);
    }
  }
  return undefined;
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
