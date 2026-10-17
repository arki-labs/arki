/**
 * `@arki/testing/services/mailpit` — one Mailpit container per worker, so a worker's mailbox
 * is its own. The app sends through `@arki/mail/http/mailpit`; the test reads with `mailbox()`.
 */
import { GenericContainer, Wait } from 'testcontainers';

import { service } from '../stack/index.js';
import { nothingToStop, once, RUN_LABEL } from './labels.js';

export type MailpitWorker = { readonly httpUrl: string };

export const mailpit = (options: { readonly image?: string } = {}) =>
  service<null, MailpitWorker>({
    name: 'mailpit',
    scope: 'worker',
    async start() {
      return { value: null, stop: nothingToStop };
    },
    async slice(_run, ctx) {
      const container = await new GenericContainer(options.image ?? 'axllent/mailpit:v1.31')
        .withExposedPorts(8025)
        .withLabels({ [RUN_LABEL]: ctx.runId })
        .withWaitStrategy(Wait.forHttp('/api/v1/info', 8025))
        .start();
      return {
        value: { httpUrl: `http://${container.getHost()}:${container.getMappedPort(8025)}` },
        stop: once(() => container.stop()),
      };
    },
  });

export type MailSummary = { readonly id: string; readonly subject: string; readonly to: readonly string[] };

/** One mail, read in full. */
export type ReceivedMail = MailSummary & {
  readonly text: string;
  readonly html: string;
  /** Every `http(s)` link in the HTML part, in order. */
  links(): readonly string[];
};

export type Mailbox = {
  /** Mails to `to` (an exact address) or all mails when omitted. Oldest first. */
  all(to?: string): Promise<readonly MailSummary[]>;
  /**
   * Waits until a mail to `to` whose subject matches arrives, and returns it in full.
   * Polls Mailpit; on timeout the error lists what Mailpit does hold (MAIL_NOT_RECEIVED).
   */
  waitFor(match: { readonly to: string; readonly subject?: string | RegExp; readonly timeoutMs?: number }): Promise<ReceivedMail>;
  /** Deletes the mails to `to`, or every mail when omitted. */
  clear(to?: string): Promise<void>;
};

type ApiAddress = { readonly Address?: string };
type ApiSummary = { readonly ID?: string; readonly Subject?: string; readonly To?: readonly ApiAddress[] };
type ApiMessage = { readonly Text?: string; readonly HTML?: string };

function summaryOf(raw: ApiSummary): MailSummary {
  return {
    id: raw.ID ?? '',
    subject: raw.Subject ?? '',
    to: (raw.To ?? []).flatMap(address => (address.Address === undefined ? [] : [address.Address])),
  };
}

async function getJson<T>(url: string): Promise<T> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Mailpit answered ${response.status} for ${url}`);
  // Erasure seam: Mailpit's API shape is fixed by its docs; the callers read optional fields only.
  return (await response.json()) as T;
}

export function mailbox(httpUrl: string): Mailbox {
  const query = (to: string) => `to:${to}`;
  async function all(to?: string): Promise<readonly MailSummary[]> {
    const url =
      to === undefined
        ? `${httpUrl}/api/v1/messages?limit=500`
        : `${httpUrl}/api/v1/search?limit=500&query=${encodeURIComponent(query(to))}`;
    const answer = await getJson<{ readonly messages?: readonly ApiSummary[] }>(url);
    // Mailpit lists newest first.
    return (answer.messages ?? []).toReversed().map(raw => summaryOf(raw));
  }
  return {
    all,
    async waitFor({ to, subject, timeoutMs = 30_000 }) {
      const deadline = Date.now() + timeoutMs;
      const matches = (mail: MailSummary) =>
        subject === undefined ? true : typeof subject === 'string' ? mail.subject === subject : subject.test(mail.subject);
      for (;;) {
        const mails = await all(to);
        const first = mails.find(mail => matches(mail));
        if (first !== undefined) {
          const full = await getJson<ApiMessage>(`${httpUrl}/api/v1/message/${first.id}`);
          const html = full.HTML ?? '';
          return {
            ...first,
            text: full.Text ?? '',
            html,
            links: () => [...html.matchAll(/https?:\/\/[^"'\s<>]+/g)].map(match => match[0]),
          };
        }
        if (Date.now() > deadline) {
          const everything = await all();
          const held = everything.map(mail => `${mail.to.join(',')}: ${mail.subject}`);
          throw new Error(
            `MAIL_NOT_RECEIVED: no mail to ${to} matching ${String(subject)} within ${timeoutMs} ms. Mailpit holds ${held.length}: ${held.join(' | ') || '(nothing)'}`,
          );
        }
        await new Promise(resolve => setTimeout(resolve, 250));
      }
    },
    async clear(to) {
      const response =
        to === undefined
          ? await fetch(`${httpUrl}/api/v1/messages`, { method: 'DELETE' })
          : await fetch(`${httpUrl}/api/v1/search?query=${encodeURIComponent(query(to))}`, { method: 'DELETE' });
      if (!response.ok) throw new Error(`Mailpit refused to clear mail (${response.status}).`);
    },
  };
}
