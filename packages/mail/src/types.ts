/**
 * The shapes every part of `@arki/mail` shares: what a template renders, who a mail goes to,
 * what a transport returns. Written once here; everything else infers from them.
 */
import type { StandardSchemaV1 } from '@arki/schema';

import type { MailErrorCode } from './errors.js';

export type Awaitable<T> = T | Promise<T>;

/** One address: `user@example.com` or `Name <user@example.com>`. */
export type Address = string;
export type Addresses = Address | readonly Address[];

/** What a template produces. Every mail has a plain-text part. */
export type MailContent = {
  readonly subject: string;
  readonly text: string;
  readonly html?: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly tags?: Readonly<Record<string, string>>;
};

/** Per send: who receives it, and how the send behaves. */
export type SendOptions = {
  readonly to: Addresses;
  /** The template's default, then the mailer's. */
  readonly from?: Address;
  readonly cc?: Addresses;
  readonly bcc?: Addresses;
  readonly replyTo?: Addresses;
  /** Forwarded to transports that support it, so a retried send is not delivered twice. */
  readonly idempotencyKey?: string;
  readonly signal?: AbortSignal;
  readonly locale?: string;
};

/** A complete mail: content plus addressing. Independent of how it is sent. */
export type MailMessage = MailContent &
  Omit<SendOptions, 'signal' | 'idempotencyKey' | 'locale' | 'from'> & {
    readonly from: Address;
    /** The template name, for logs and the test sink. */
    readonly template?: string;
  };

/** Passed to every renderer. */
export type RenderContext = { readonly locale?: string };

export type RecipientOutcome = {
  readonly address: string;
  readonly status: 'accepted' | 'rejected' | 'suppressed' | 'unknown';
};

export type SentMail = {
  /** The provider's message id, or `null` when it gives none. Never made up. */
  readonly id: string | null;
  readonly transport: string;
  /** `simulated`: nothing left the process (log transport, test sink). */
  readonly status: 'accepted' | 'partial' | 'simulated';
  readonly recipients: readonly RecipientOutcome[];
};

export type MailFailure = {
  readonly code: MailErrorCode;
  readonly message: string;
  /** Sending the same mail again later may succeed. */
  readonly retryable: boolean;
  /** `none`: the provider did not take the mail. `unknown`: it may have (timeout, unreadable answer). */
  readonly acceptance: 'none' | 'unknown';
  readonly transport?: string;
  /** The provider's own error code or name. */
  readonly providerCode?: string;
  readonly status?: number;
  /** What the template's schema reported (`ARKI_MAIL_E003` only). */
  readonly issues?: readonly StandardSchemaV1.Issue[];
};

export type MailResult<T = SentMail> =
  { readonly data: T; readonly error: null } | { readonly data: null; readonly error: MailFailure };

/** Sends one mail through one service. */
export type MailTransport = {
  /** Stable name for logs and quota counters; unique within a mailer. */
  readonly id: string;
  /** Monthly budget, counted per UTC month by `failover`. Omit for none. */
  readonly quotaPerMonth?: number;
  /** Never throws: every failure is a `MailFailure`. */
  send(
    message: MailMessage,
    options: { readonly idempotencyKey?: string; readonly signal?: AbortSignal },
  ): Promise<MailResult>;
};

/** What the mailer reports to `onEvent`. Observe only. */
export type MailEvent =
  | { readonly type: 'sending'; readonly transport: string; readonly template?: string }
  | { readonly type: 'sent'; readonly result: SentMail; readonly template?: string }
  | { readonly type: 'failed'; readonly failure: MailFailure; readonly template?: string };
