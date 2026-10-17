// @arki/mail — portable core (Node, Bun, Deno). Transports live in `./http/*` and `./node/*`.
export type {
  Address,
  Addresses,
  Awaitable,
  MailContent,
  MailEvent,
  MailMessage,
  MailTransport,
  RecipientOutcome,
  RenderContext,
  SendFailure,
  SendOptions,
  SentMail,
  TransportFailure,
} from './types.js';
export type { MailErrorCode } from './errors.js';
export { isMailError, MAIL_ERROR_CODES, MailError } from './errors.js';
export { MailExpired, MailInvalidInput, MailQuotaExhausted, MailRejected, MailUncertain } from './failures.js';
export type { MailTemplate } from './template.js';
export { defineTemplate, renderTemplate } from './template.js';
export type { Mailer, MailerOptions, RawMail } from './mailer.js';
export { mailer } from './mailer.js';
export type { FailoverOptions } from './failover.js';
export { failover } from './failover.js';
export type { KVLike, QuotaStore } from './quota-store.js';
export { inMemoryQuotaStore, kvQuotaStore } from './quota-store.js';
export { logTransport } from './log-transport.js';
