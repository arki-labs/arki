/**
 * Resend over its REST API with plain `fetch` (no SDK). Runs on Node, Bun and Deno.
 * Carries every message field, and forwards `idempotencyKey` as the `Idempotency-Key` header:
 * Resend keeps a key for 24 hours and refuses a reused key with a different payload.
 */
import type { MailTransport } from '../types.js';
import type { FetchFn } from './post-json.js';
import { failed, ok } from '../errors.js';
import { listOf } from '../message.js';
import { fieldOf, stringOf } from '../narrow.js';
import { badResponse, everyRecipient, logged, rejection } from '../transport-failures.js';
import { postJson } from './post-json.js';

const RESEND_EMAILS_URL = 'https://api.resend.com/emails';

export type ResendOptions = {
  /** Default `'resend'`. Set it when two Resend accounts share one mailer. */
  readonly id?: string;
  /** API key, starts with `re_`. */
  readonly apiKey: string;
  /** Monthly budget for `failover`. Free tier: 3 000. */
  readonly quotaPerMonth?: number;
  /** For tests. Default `globalThis.fetch`. */
  readonly fetch?: FetchFn;
};

/**
 * @example
 * const mail = mailer({ transport: resend({ apiKey: env.RESEND_API_KEY }), from: 'App <hi@app.dev>' });
 */
export function resend(options: ResendOptions): MailTransport {
  const id = options.id ?? 'resend';
  const fetchFn = options.fetch ?? globalThis.fetch;
  return {
    id,
    ...(options.quotaPerMonth === undefined ? {} : { quotaPerMonth: options.quotaPerMonth }),
    async send(message, sendOptions) {
      const replyTo = listOf(message.replyTo);
      const answer = await postJson({
        transport: id,
        fetch: fetchFn,
        url: RESEND_EMAILS_URL,
        headers: {
          Authorization: `Bearer ${options.apiKey}`,
          ...(sendOptions.idempotencyKey === undefined ? {} : { 'Idempotency-Key': sendOptions.idempotencyKey }),
        },
        body: {
          from: message.from,
          to: listOf(message.to),
          subject: message.subject,
          text: message.text,
          ...(message.html === undefined ? {} : { html: message.html }),
          ...(message.cc === undefined ? {} : { cc: listOf(message.cc) }),
          ...(message.bcc === undefined ? {} : { bcc: listOf(message.bcc) }),
          ...(replyTo.length === 0 ? {} : { reply_to: replyTo }),
          ...(message.headers === undefined ? {} : { headers: message.headers }),
          ...(message.tags === undefined
            ? {}
            : { tags: Object.entries(message.tags).map(([name, value]) => ({ name, value })) }),
        },
        ...(sendOptions.signal === undefined ? {} : { signal: sendOptions.signal }),
      });
      if (answer.error !== null) return logged(id, answer);
      const { status, body } = answer.data;
      if (status >= 400) {
        return logged(
          id,
          failed(
            rejection(id, status, {
              message: stringOf(fieldOf(body, 'message')),
              providerCode: stringOf(fieldOf(body, 'name')),
            }),
          ),
        );
      }
      if (status < 200 || status >= 300 || typeof body !== 'object' || body === null) {
        return logged(id, failed(badResponse(id, status, 'expected a JSON object')));
      }
      return logged(
        id,
        ok({
          id: stringOf(fieldOf(body, 'id')) ?? null,
          transport: id,
          status: 'accepted',
          recipients: everyRecipient(message, 'accepted'),
        }),
      );
    },
  };
}
