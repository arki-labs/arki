/**
 * Mailpit over its HTTP JSON API with plain `fetch`. Runs on Node, Bun and Deno.
 * For tests and local runs: Mailpit keeps every mail it is sent and shows it in a web page and
 * an API, so a test can read what the app really sent. It accepts every recipient.
 * Carries every message field; `idempotencyKey` is ignored because Mailpit has no such thing.
 */
import { isFailure } from '@arki/failure';

import type { MailTransport } from '../types.js';
import type { FetchFn } from './post-json.js';
import { listOf } from '../message.js';
import { fieldOf, stringOf } from '../narrow.js';
import { badResponse, everyRecipient, logged, rejection } from '../transport-failures.js';
import { postJson } from './post-json.js';

export type MailpitOptions = {
  /** Default `'mailpit'`. */
  readonly id?: string;
  /** Where Mailpit's HTTP API listens, for example `http://localhost:8025`. */
  readonly baseUrl: string;
  /** For tests. Default `globalThis.fetch`. */
  readonly fetch?: FetchFn;
};

/** `Name <a@b.dev>` or `a@b.dev`, as Mailpit wants it: `{ Email, Name? }`. */
function contactOf(address: string): { readonly Email: string; readonly Name?: string } {
  const open = address.lastIndexOf('<');
  const close = address.lastIndexOf('>');
  if (open === -1 || close < open) return { Email: address.trim() };
  const name = address.slice(0, open).trim().replaceAll('"', '');
  const email = address.slice(open + 1, close).trim();
  return name === '' ? { Email: email } : { Email: email, Name: name };
}

/**
 * @example
 * const mail = mailer({ transport: mailpit({ baseUrl: env.MAILPIT_URL }), from: 'App <hi@app.dev>' });
 */
export function mailpit(options: MailpitOptions): MailTransport {
  const id = options.id ?? 'mailpit';
  const fetchFn = options.fetch ?? globalThis.fetch;
  const url = `${options.baseUrl.replace(/\/+$/, '')}/api/v1/send`;
  return {
    id,
    async send(message, sendOptions) {
      const replyTo = listOf(message.replyTo);
      const cc = listOf(message.cc);
      const bcc = listOf(message.bcc);
      const answer = await postJson({
        transport: id,
        fetch: fetchFn,
        url,
        headers: {},
        body: {
          From: contactOf(message.from),
          To: listOf(message.to).map(address => contactOf(address)),
          Subject: message.subject,
          Text: message.text,
          ...(message.html === undefined ? {} : { HTML: message.html }),
          ...(cc.length === 0 ? {} : { Cc: cc.map(address => contactOf(address)) }),
          // Mailpit wants Bcc as bare addresses.
          ...(bcc.length === 0 ? {} : { Bcc: bcc.map(address => contactOf(address).Email) }),
          ...(replyTo.length === 0 ? {} : { ReplyTo: replyTo.map(address => contactOf(address)) }),
          ...(message.headers === undefined ? {} : { Headers: message.headers }),
          // Tags are plain words in Mailpit, so a pair becomes `name-value`.
          ...(message.tags === undefined
            ? {}
            : { Tags: Object.entries(message.tags).map(([name, value]) => `${name}-${value}`) }),
        },
        ...(sendOptions.signal === undefined ? {} : { signal: sendOptions.signal }),
      });
      if (isFailure(answer)) return logged(id, answer);
      const { status, body } = answer;
      if (status >= 400) {
        return logged(id, rejection(id, status, { message: stringOf(fieldOf(body, 'Error')) }));
      }
      if (status < 200 || status >= 300 || typeof body !== 'object' || body === null) {
        return logged(id, badResponse(id, status, 'expected a JSON object'));
      }
      return logged(id, {
        id: stringOf(fieldOf(body, 'ID')) ?? null,
        transport: id,
        status: 'accepted',
        recipients: everyRecipient(message, 'accepted'),
      });
    },
  };
}
