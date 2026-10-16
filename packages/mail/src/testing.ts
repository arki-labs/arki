/**
 * Test helpers. `mailSink()` is a transport that keeps every mail in memory; `transportContract`
 * is the suite every transport must pass (it imports vitest).
 *
 * @example
 * const sink = mailSink();
 * const mail = mailer({ transport: sink, from: 'App <hi@app.dev>' });
 * await signUp(mail, 'ada@example.com');
 * expect(sink.sentWith(verifyEmail)).toHaveLength(1);
 */
import type { StandardSchemaV1 } from '@arki/schema';

import type { MailTemplate } from './template.js';
import type { MailFailure, MailMessage, MailTransport } from './types.js';
import { failed, MAIL_ERROR_CODES, ok } from './errors.js';
import { listOf } from './message.js';
import { everyRecipient } from './transport-failures.js';

export type { TransportHarness } from './testing/transport-contract.js';
export { transportContract } from './testing/transport-contract.js';

/**
 * One mail the sink took. `template` is the template's name (`undefined` for `sendRaw`). The
 * template's input is not recorded: a transport only sees the rendered message.
 */
export type SentRecord<Name extends string | undefined = string | undefined> = {
  readonly message: MailMessage;
  readonly template: Name;
  readonly idempotencyKey: string | undefined;
};

export type MailSink = MailTransport & {
  /** Every mail taken, oldest first. Failed sends are not recorded. */
  readonly sent: readonly SentRecord[];
  /** Mails rendered from `template`. */
  sentWith<S extends StandardSchemaV1, Name extends string>(
    template: MailTemplate<S, Name>,
  ): readonly SentRecord<Name>[];
  /** Mails with `address` in To, Cc or Bcc. `Name <a@b>` matches `a@b`; case is ignored. */
  sentTo(address: string): readonly SentRecord[];
  /** The latest mail taken. */
  last(): SentRecord | undefined;
  /** The next send fails with this failure (default: a permanent `ARKI_MAIL_E006`). Only the next one. */
  failNext(failure?: Partial<MailFailure>): void;
  /** Forgets every mail and any pending `failNext`. */
  clear(): void;
};

/** `a@b` from `Name <a@b>`, lower-cased. */
const mailboxOf = (address: string): string => (/<([^>]+)>/.exec(address)?.[1] ?? address).trim().toLowerCase();

/** A transport that sends nothing and records each mail, reported as `simulated`. */
export function mailSink(): MailSink {
  const id = 'sink';
  let records: SentRecord[] = [];
  let pendingFailure: MailFailure | undefined;

  return {
    id,
    get sent() {
      return records;
    },
    send(message, options) {
      if (pendingFailure !== undefined) {
        const failure = pendingFailure;
        pendingFailure = undefined;
        return Promise.resolve(failed(failure));
      }
      records = [...records, { message, template: message.template, idempotencyKey: options.idempotencyKey }];
      return Promise.resolve(
        ok({ id: null, transport: id, status: 'simulated', recipients: everyRecipient(message, 'accepted') }),
      );
    },
    sentWith<S extends StandardSchemaV1, Name extends string>(template: MailTemplate<S, Name>) {
      return records.filter((record): record is SentRecord<Name> => record.template === template.name);
    },
    sentTo(address) {
      const wanted = mailboxOf(address);
      return records.filter(({ message }) =>
        [...listOf(message.to), ...listOf(message.cc), ...listOf(message.bcc)].some(
          recipient => mailboxOf(recipient) === wanted,
        ),
      );
    },
    last: () => records.at(-1),
    failNext(failure = {}) {
      pendingFailure = {
        code: MAIL_ERROR_CODES.rejected,
        message: 'mailSink: failNext',
        retryable: false,
        acceptance: 'none',
        transport: id,
        ...failure,
      };
    },
    clear() {
      records = [];
      pendingFailure = undefined;
    },
  };
}
