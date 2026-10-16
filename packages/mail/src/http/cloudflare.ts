/**
 * Cloudflare Email Service (Email Sending REST API) with plain `fetch`. Runs on Node, Bun and
 * Deno. In beta as of 2026-05; needs the Workers Paid plan for outbound mail.
 *
 * Cloudflare answers per recipient (`delivered`, `queued`, `permanent_bounces`,
 * `suppressed_recipients`), so a send can be `partial`. The API reference adds `message_id` and
 * `suppressed_recipients`; the REST guide's example lacks them. Both shapes are read, and `id` is
 * `null` when no `message_id` comes back.
 *
 * It cannot carry tags or more than one Reply-To; such a message is refused before any request.
 */
import type { MailFailure, MailTransport, RecipientOutcome } from '../types.js';
import type { FetchFn } from './post-json.js';
import { failed, MAIL_ERROR_CODES, ok } from '../errors.js';
import { listOf } from '../message.js';
import { fieldOf, stringOf, stringsOf } from '../narrow.js';
import { badResponse, everyRecipient, logged, rejection, unsupported } from '../transport-failures.js';
import { postJson } from './post-json.js';

const CLOUDFLARE_API_BASE = 'https://api.cloudflare.com/client/v4';

export type CloudflareOptions = {
  /** Default `'cloudflare'`. */
  readonly id?: string;
  /** Cloudflare account id (32 hex characters). */
  readonly accountId: string;
  /** API token with the `Email Sending: Edit` permission. */
  readonly apiToken: string;
  /** Monthly budget for `failover`. Workers Paid includes 3 000. */
  readonly quotaPerMonth?: number;
  /** For tests. Default `globalThis.fetch`. */
  readonly fetch?: FetchFn;
};

/** The first entry of Cloudflare's `errors` array: `{ code, message }`. */
function firstError(body: unknown): { message?: string; providerCode?: string } {
  const errors = fieldOf(body, 'errors');
  const first: unknown = Array.isArray(errors) ? errors[0] : undefined;
  const message = stringOf(fieldOf(first, 'message'));
  const code = fieldOf(first, 'code');
  const providerCode = typeof code === 'string' || typeof code === 'number' ? String(code) : undefined;
  return {
    ...(message === undefined ? {} : { message }),
    ...(providerCode === undefined ? {} : { providerCode }),
  };
}

/** Per-recipient outcomes from `result`. A missing list is an empty one. */
function outcomesOf(result: object): readonly RecipientOutcome[] {
  const list = (key: string, status: RecipientOutcome['status']): RecipientOutcome[] =>
    (stringsOf(fieldOf(result, key)) ?? []).map(address => ({ address, status }));
  return [
    ...list('delivered', 'accepted'),
    ...list('queued', 'accepted'),
    ...list('permanent_bounces', 'rejected'),
    ...list('suppressed_recipients', 'suppressed'),
  ];
}

/**
 * @example
 * cloudflare({ accountId: env.CLOUDFLARE_ACCOUNT_ID, apiToken: env.CLOUDFLARE_EMAIL_TOKEN, quotaPerMonth: 3_000 })
 */
export function cloudflare(options: CloudflareOptions): MailTransport {
  const id = options.id ?? 'cloudflare';
  const fetchFn = options.fetch ?? globalThis.fetch;
  const url = `${CLOUDFLARE_API_BASE}/accounts/${encodeURIComponent(options.accountId)}/email/sending/send`;
  return {
    id,
    ...(options.quotaPerMonth === undefined ? {} : { quotaPerMonth: options.quotaPerMonth }),
    async send(message, sendOptions) {
      if (message.tags !== undefined && Object.keys(message.tags).length > 0) {
        return logged(id, failed(unsupported(id, 'Cloudflare Email Service has no tags.')));
      }
      const replyTo = listOf(message.replyTo);
      if (replyTo.length > 1) {
        return logged(id, failed(unsupported(id, 'Cloudflare Email Service takes one Reply-To address.')));
      }
      const answer = await postJson({
        transport: id,
        fetch: fetchFn,
        url,
        headers: { Authorization: `Bearer ${options.apiToken}` },
        body: {
          from: message.from,
          to: listOf(message.to),
          subject: message.subject,
          text: message.text,
          ...(message.html === undefined ? {} : { html: message.html }),
          ...(message.cc === undefined ? {} : { cc: listOf(message.cc) }),
          ...(message.bcc === undefined ? {} : { bcc: listOf(message.bcc) }),
          ...(replyTo[0] === undefined ? {} : { reply_to: replyTo[0] }),
          ...(message.headers === undefined ? {} : { headers: message.headers }),
        },
        ...(sendOptions.signal === undefined ? {} : { signal: sendOptions.signal }),
      });
      if (answer.error !== null) return logged(id, answer);
      const { status, body } = answer.data;
      if (status >= 400 || fieldOf(body, 'success') === false) {
        return logged(id, failed(rejection(id, status, firstError(body))));
      }
      const result = fieldOf(body, 'result');
      if (status < 200 || status >= 300 || typeof result !== 'object' || result === null) {
        return logged(id, failed(badResponse(id, status, 'expected a JSON object with a `result` object')));
      }
      const messageId = stringOf(fieldOf(result, 'message_id')) ?? null;
      const outcomes = outcomesOf(result);
      if (outcomes.length === 0) {
        // Accepted, but Cloudflare said nothing per recipient: report each as unknown.
        return logged(
          id,
          ok({ id: messageId, transport: id, status: 'accepted', recipients: everyRecipient(message, 'unknown') }),
        );
      }
      const refused = outcomes.filter(outcome => outcome.status !== 'accepted');
      if (refused.length === outcomes.length) {
        const everyoneRefused: MailFailure = {
          code: MAIL_ERROR_CODES.rejected,
          message: `${id}: every recipient bounced or is suppressed: ${refused.map(outcome => outcome.address).join(', ')}`,
          retryable: false,
          acceptance: 'none',
          transport: id,
          status,
        };
        return logged(id, failed(everyoneRefused));
      }
      return logged(
        id,
        ok({
          id: messageId,
          transport: id,
          status: refused.length === 0 ? 'accepted' : 'partial',
          recipients: outcomes,
        }),
      );
    },
  };
}
