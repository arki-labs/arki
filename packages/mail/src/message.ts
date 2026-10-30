/**
 * Checks on a message before any transport sees it. A line break in a header or an address
 * would let input add headers of its own (header injection), so it is refused, not cleaned.
 */
import type { FailureOf } from '@arki/failure';

import type { Addresses, MailMessage } from './types.js';
import { MailInvalidMessage } from './failures.js';

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

/**
 * The first problem with `message`, as `MailInvalidMessage`, or `undefined` when it can be sent.
 * Addresses usually come from a user, so a bad one is an expected outcome, returned not thrown.
 */
export function checkMessage(message: MailMessage): FailureOf<typeof MailInvalidMessage> | undefined {
  const problem = problemWith(message);
  return problem === undefined ? undefined : MailInvalidMessage({ problem });
}

function problemWith(message: MailMessage): string | undefined {
  const recipients = [...listOf(message.to), ...listOf(message.cc), ...listOf(message.bcc)];
  if (recipients.length === 0) return 'A mail needs at least one recipient in to, cc or bcc.';
  const addresses = [message.from, ...recipients, ...listOf(message.replyTo)];
  if (addresses.some(address => address.trim() === '')) return 'An address is empty.';
  if (addresses.some(address => LINE_BREAK.test(address))) return 'An address contains a line break.';
  if (LINE_BREAK.test(message.subject)) return 'The subject contains a line break.';
  for (const [name, value] of Object.entries(message.headers ?? {})) {
    if (LINE_BREAK.test(name) || LINE_BREAK.test(value)) return `Header "${name}" contains a line break.`;
    if (RESERVED_HEADERS.has(name.toLowerCase())) {
      return `Header "${name}" is set by the message itself; use the matching field instead.`;
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
