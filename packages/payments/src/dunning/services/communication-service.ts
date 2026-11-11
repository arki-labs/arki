import { and, desc, eq, gt, isNull, ne, notExists, or } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';

import type { Instant } from '@arki/date';
import type { FailureOf, SchemaFailure } from '@arki/failure';
import { z } from '@arki/contracts';
import { fromDate, now, toDate } from '@arki/date';
import { invariant, isFailure, orThrow, unreachable } from '@arki/failure';
import { getLogger } from '@arki/log';
import { parse } from '@arki/schema';

import type { CommunicationWebhookInput, ListCommunicationsQuery, UpdateCommunicationStatusInput } from '../contracts.js';
import type { DunningTickReport, NotificationProviderFailure } from '../failures.js';
import type {
  CommunicationStatus as CommStatus,
  CommunicationChannel,
  DunningCommunicationId,
  DunningExecutionId,
} from '../primitives.js';
import type { DunningDatabase } from '../repository.js';
import type { DunningTables } from '../tables.js';
import type {
  CommunicationTemplate,
  CommunicationUpdateData,
  CustomerData,
  DunningCommunication,
  DunningExecution,
  DunningTemplate,
} from '../types.js';
import { PaymentsConfigurationInvalid } from '../../core/failures.js';
import { fetchUrlSchema } from '../../core/fetch-url.js';
import { INT4_MAX, pgJsonRecordSchema, pgTextSchema, pgVarcharSchema } from '../../core/pg-values.js';
import { communicationWebhookSchema } from '../contracts.js';
import { PaymentProviderError } from '../../core/providers/provider-error.js';
import { observePayments } from '../../core/telemetry.js';
import {
  DunningCommunicationNotFound,
  NotificationChannelUnavailable,
  NotificationProviderRejected,
  NotificationProviderResponseInvalid,
  NotificationProviderTimeout,
  NotificationWebhookHostNotAllowed,
  tickFault,
} from '../failures.js';
import { createDunningCommunicationRepository } from '../repository.js';

/**
 * Interface for communication providers (email, SMS, etc.). `send` and `getDeliveryStatus` return a
 * `NotificationProviderFailure` for an answer the caller must handle (a refusal, a timeout, a body
 * that is not the documented shape, a recipient or message id that is not valid for the channel) and
 * throw only when the provider cannot be reached at all: a `PaymentProviderError` with code
 * `unavailable` (retryable), the network error as its cause.
 */
export type CommunicationProvider = {
  readonly channel: CommunicationChannel;
  send(communication: CommunicationRequest): Promise<CommunicationSent | NotificationProviderFailure>;
  validateConfiguration(): Promise<boolean>;
  getDeliveryStatus?(messageId: string): Promise<CommunicationDeliveryStatus | NotificationProviderFailure>;
};

export type CommunicationRequest = {
  recipient: string;
  subject?: string;
  content: string;
  template: CommunicationTemplate;
  personalizations: Record<string, string>;
  trackingData?: Record<string, unknown>;
};

/** A message the provider accepted: its id at the provider and what the provider answered. */
export type CommunicationSent = {
  messageId: string;
  providerResponse: Record<string, unknown>;
};

export type CommunicationDeliveryStatus = {
  status: CommStatus;
  timestamp: Instant;
  metadata?: Record<string, unknown>;
};

const logger = getLogger('arki:payments:dunning');

/** How long a provider call may take before it returns `NotificationProviderTimeout`. */
const DEFAULT_PROVIDER_TIMEOUT_MS = 30_000;

/** A provider call's timeout: whole milliseconds from 1 to 2^31 - 1 (a longer timer fires at once). */
const providerTimeoutSchema = z.number().int().min(1).max(INT4_MAX);

/** `payments.configuration_invalid`: a setting the app passed when it built a provider or the service. */
type ConfigurationInvalid = FailureOf<typeof PaymentsConfigurationInvalid>;

/** `payments.configuration_invalid` for a `timeoutMs` no timer can wait; `undefined` when it is fine or unset (the default applies). */
function timeoutProblem(setting: string, timeoutMs: number | undefined): ConfigurationInvalid | undefined {
  if (timeoutMs === undefined || providerTimeoutSchema.safeParse(timeoutMs).success) return undefined;
  return PaymentsConfigurationInvalid({
    setting,
    problem: `${String(timeoutMs)} is not a whole number of milliseconds from 1 to ${INT4_MAX}`,
  });
}

/**
 * A value `fetch` can send in a header (an API key, a token, a header value): `fetch` refuses a NUL,
 * a line break or a character above U+00FF before anything is sent.
 */
const headerValueSchema = z
  .string()
  .regex(/^[^\0\n\r\u0100-\uFFFF]*$/, 'holds a NUL, a line break or a character above U+00FF, which no HTTP header can carry');

/** A header name `fetch` accepts: an HTTP token. */
const headerNameSchema = z.string().regex(/^[\w!#$%&'*+.^`|~-]+$/, 'is not an HTTP header name');

/**
 * A provider API origin `fetch` can call on every runtime: an http(s) URL with no user name or
 * password and no port the Fetch standard blocks (`fetch` refuses both).
 */
const apiBaseUrlSchema = fetchUrlSchema;

/**
 * `payments.configuration_invalid` for `setting` when `value` fails `schema`, else `undefined`, so a
 * setting `fetch` would refuse before sending fails at boot, never as an outage on every send. The
 * value is not echoed: it may be a secret.
 */
function settingProblem(setting: string, schema: z.ZodType, value: unknown): ConfigurationInvalid | undefined {
  const checked = schema.safeParse(value);
  if (checked.success) return undefined;
  return PaymentsConfigurationInvalid({ setting, problem: checked.error.issues.map(issue => issue.message).join('; ') });
}

/** The channel and provider name a provider call is about: the bounded span attributes and failure data. */
type ProviderTarget = { channel: CommunicationChannel; provider: string };

/** One provider answer: its status and its body text (at most {@link MAX_PROVIDER_BODY_BYTES}), read under the same timeout. */
type ProviderReply = { status: number; ok: boolean; body: string };

/** The most of a provider's body that is read. A documented Resend or Twilio answer is far smaller; the rest is cancelled. */
export const MAX_PROVIDER_BODY_BYTES = 64 * 1024;

/** The body's first {@link MAX_PROVIDER_BODY_BYTES} bytes as text. A longer body is cut there and the rest is cancelled. */
async function readCappedBody(response: Response): Promise<string> {
  const stream = response.body;
  if (!stream) return '';
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let text = '';
  let bytes = 0;
  try {
    while (bytes < MAX_PROVIDER_BODY_BYTES) {
      const { done, value } = await reader.read();
      if (done) return text + decoder.decode();
      const room = MAX_PROVIDER_BODY_BYTES - bytes;
      const chunk = value.byteLength > room ? value.subarray(0, room) : value;
      bytes += chunk.byteLength;
      text += decoder.decode(chunk, { stream: true });
    }
    await reader.cancel();
    return text + decoder.decode();
  } finally {
    reader.releaseLock();
  }
}

/** Text that must be JSON; the value is then checked by the schema it is piped into. */
const jsonTextSchema = z.string().transform((text, context) => {
  try {
    const value: unknown = JSON.parse(text);
    return value;
  } catch {
    context.addIssue({ code: 'custom', message: 'The body is not JSON' });
    return z.NEVER;
  }
});

/** The error body Resend and Twilio both send: a `message`, among other fields. */
// The text is stored as the communication's failure reason, so it must be text Postgres can store
const providerErrorBodySchema = jsonTextSchema.pipe(z.looseObject({ message: pgTextSchema }));

/** A provider's id for a sent message: stored in `provider_message_id`, a varchar(255). */
const sentMessageIdSchema = pgVarcharSchema(255);

/**
 * A provider message id as the caller passes it. It goes into a URL path, so text with a lone UTF-16
 * surrogate (which `encodeURIComponent` cannot encode) is refused as `schema.invalid_input`.
 */
const providerMessageIdSchema = z
  .string()
  .min(1)
  .regex(/^\P{Cs}*$/u, 'The message id has a lone UTF-16 surrogate');

/** The ids a communication row stores: each is a varchar(255) column, and Postgres refuses more (SQLSTATE 22001) or U+0000. */
const communicationRefsSchema = z.object({
  executionId: pgVarcharSchema(255),
  customerId: pgVarcharSchema(255),
  templateId: pgVarcharSchema(255),
});

/** A date the provider sends as text; text that is not a date is refused. */
const providerDateSchema = z.string().pipe(z.coerce.date());

/**
 * One HTTP call to a provider under `timeoutMs`. With `body: 'read'` the body's first
 * {@link MAX_PROVIDER_BODY_BYTES} bytes are read; with `body: 'discard'` it is cancelled unread and
 * `body` is `''`. A call that does not finish in time returns `NotificationProviderTimeout`; a
 * provider that cannot be reached at all throws `PaymentProviderError('unavailable')`, with the
 * network error as its cause.
 */
async function callProvider(
  target: ProviderTarget,
  url: string,
  init: RequestInit,
  timeoutMs: number,
  body: 'read' | 'discard' = 'read',
) {
  const timeout = AbortSignal.timeout(timeoutMs);
  try {
    const response = await fetch(url, { ...init, signal: timeout });
    let text = '';
    if (body === 'read') text = await readCappedBody(response);
    else await response.body?.cancel();
    const reply: ProviderReply = { status: response.status, ok: response.ok, body: text };
    return reply;
  } catch (error) {
    if (timeout.aborted) return NotificationProviderTimeout({ ...target, timeoutMs }, { cause: error });
    throw new PaymentProviderError('unavailable', `The ${target.provider} request failed`, { cause: error });
  }
}

/** The provider's error status as `NotificationProviderRejected`, with its own error text when the body has one. */
function rejected(target: ProviderTarget, reply: ProviderReply) {
  const detail = providerErrorBodySchema.safeParse(reply.body);
  return NotificationProviderRejected({
    ...target,
    upstreamStatus: reply.status,
    upstreamMessage: detail.success ? detail.data.message : null,
  });
}

/** A success body that is not the provider's documented shape; `cause` is the schema failure. */
function invalidBody(target: ProviderTarget, reply: ProviderReply, cause: SchemaFailure) {
  return NotificationProviderResponseInvalid({ ...target, upstreamStatus: reply.status }, { cause });
}

/** Replaces each `{{key}}` with its personalization, inserted literally (`$&` in a value stays `$&`). */
function applyPersonalizations(template: string, personalizations: Record<string, string>): string {
  let processed = template;
  for (const [key, value] of Object.entries(personalizations)) {
    processed = processed.replaceAll(`{{${key}}}`, () => value);
  }

  return processed;
}

/** The Resend send answer: the email id. */
const resendSentSchema = jsonTextSchema.pipe(z.looseObject({ id: sentMessageIdSchema }));

/** The Resend email record `getDeliveryStatus` reads. */
const resendEmailSchema = jsonTextSchema.pipe(
  z.looseObject({ last_event: z.string().nullish(), created_at: providerDateSchema }),
);

/** The settings of an {@link EmailProvider}. */
export type EmailProviderConfig = {
  apiKey: string;
  fromEmail: string;
  fromName: string;
  /** How long one Resend call may take. Default 30 000 ms. */
  timeoutMs?: number;
  /** The Resend API origin. Default `https://api.resend.com`. */
  apiBaseUrl?: string;
};

/**
 * Email communication provider with Resend integration. Each send runs in a
 * `payments.notification.send` span (channel and provider only). Build it with
 * {@link EmailProvider.create}.
 */
export class EmailProvider implements CommunicationProvider {
  readonly channel = 'email' as const;
  private readonly target: ProviderTarget = { channel: 'email', provider: 'resend' };

  private constructor(private config: EmailProviderConfig) {}

  /**
   * Builds the provider, or returns `payments.configuration_invalid` for a `timeoutMs` that is not a
   * whole number from 1 to 2^31 - 1, an `apiKey` no HTTP header can carry, or an `apiBaseUrl` that is
   * not an http(s) URL without credentials or that uses a port the Fetch standard blocks (such as
   * 6000, on every runtime): `fetch` would refuse those before sending, so `unavailable` means a real
   * outage.
   */
  static create(config: EmailProviderConfig): EmailProvider | ConfigurationInvalid {
    return (
      timeoutProblem('email.timeoutMs', config.timeoutMs) ??
      settingProblem('email.apiKey', headerValueSchema, config.apiKey) ??
      (config.apiBaseUrl === undefined ? undefined : settingProblem('email.apiBaseUrl', apiBaseUrlSchema, config.apiBaseUrl)) ??
      new EmailProvider(config)
    );
  }

  private get baseUrl(): string {
    return this.config.apiBaseUrl ?? 'https://api.resend.com';
  }

  private get timeoutMs(): number {
    return this.config.timeoutMs ?? DEFAULT_PROVIDER_TIMEOUT_MS;
  }

  async send(request: CommunicationRequest) {
    return observePayments('notification.send', this.target, async () => {
      const processedContent = applyPersonalizations(request.content, request.personalizations);
      const processedSubject = request.subject
        ? applyPersonalizations(request.subject, request.personalizations)
        : 'Payment Notice';

      const reply = await callProvider(
        this.target,
        `${this.baseUrl}/emails`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${this.config.apiKey}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            from: `${this.config.fromName} <${this.config.fromEmail}>`,
            to: [request.recipient],
            subject: processedSubject,
            html: processedContent,
            tags: [
              { name: 'category', value: 'dunning' },
              { name: 'campaign_id', value: request.trackingData?.['campaignId']?.toString() || '' },
            ],
          }),
        },
        this.timeoutMs,
      );
      if (isFailure(reply)) return reply;
      if (!reply.ok) return rejected(this.target, reply);

      const data = parse(resendSentSchema, reply.body);
      if (isFailure(data)) return invalidBody(this.target, reply, data);

      const sent: CommunicationSent = {
        messageId: data.id,
        providerResponse: {
          provider: 'resend',
          timestamp: now().toString(),
          recipient: request.recipient,
          resendId: data.id,
        },
      };
      return sent;
    });
  }

  async validateConfiguration(): Promise<boolean> {
    try {
      // Test API key by making a test call to Resend
      const response = await fetch(`${this.baseUrl}/domains`, {
        method: 'GET',
        headers: { Authorization: `Bearer ${this.config.apiKey}` },
        signal: AbortSignal.timeout(this.timeoutMs),
      });

      return response.ok && !!this.config.fromEmail;
    } catch {
      return false;
    }
  }

  async getDeliveryStatus(messageId: string) {
    return observePayments('notification.delivery_status', this.target, async () => {
      const id = parse(providerMessageIdSchema, messageId);
      if (isFailure(id)) return id;
      const reply = await callProvider(
        this.target,
        `${this.baseUrl}/emails/${encodeURIComponent(id)}`,
        { headers: { Authorization: `Bearer ${this.config.apiKey}` } },
        this.timeoutMs,
      );
      if (isFailure(reply)) return reply;
      if (!reply.ok) return rejected(this.target, reply);

      const data = parse(resendEmailSchema, reply.body);
      if (isFailure(data)) return invalidBody(this.target, reply, data);

      const status: CommunicationDeliveryStatus = {
        status: data.last_event === 'delivered' ? 'delivered' : 'sent',
        timestamp: fromDate(data.created_at),
        metadata: { ...data, created_at: data.created_at.toISOString() },
      };
      return status;
    });
  }
}

/** The Twilio message answer: its sid, and status and uri when Twilio sends them. */
const twilioMessageSchema = jsonTextSchema.pipe(
  z.looseObject({
    sid: sentMessageIdSchema,
    // Stored in the communication's provider response (jsonb)
    status: pgTextSchema.nullish(),
    uri: z.string().nullish(),
    date_created: providerDateSchema.nullish(),
    date_updated: providerDateSchema.nullish(),
    error_code: z.union([z.number(), z.string()]).nullish(),
    error_message: z.string().nullish(),
  }),
);

/** The settings of an {@link SMSProvider}. */
export type SMSProviderConfig = {
  accountSid: string;
  authToken: string;
  fromNumber: string;
  /** How long one Twilio call may take. Default 30 000 ms. */
  timeoutMs?: number;
  /** The Twilio API origin. Default `https://api.twilio.com`. */
  apiBaseUrl?: string;
};

/**
 * SMS communication provider with Twilio integration. Each send runs in a
 * `payments.notification.send` span (channel and provider only). Build it with
 * {@link SMSProvider.create}.
 */
export class SMSProvider implements CommunicationProvider {
  readonly channel = 'sms' as const;
  private readonly target: ProviderTarget = { channel: 'sms', provider: 'twilio' };

  private constructor(private config: SMSProviderConfig) {}

  /**
   * Builds the provider, or returns `payments.configuration_invalid` for a `timeoutMs` that is not a
   * whole number from 1 to 2^31 - 1, an `accountSid` or `authToken` no HTTP header can carry, or an
   * `apiBaseUrl` that is not an http(s) URL without credentials or that uses a port the Fetch
   * standard blocks (such as 6000, on every runtime).
   */
  static create(config: SMSProviderConfig): SMSProvider | ConfigurationInvalid {
    // `btoa` throws for a character above U+00FF; `fetch` refuses an invalid origin before sending
    return (
      timeoutProblem('sms.timeoutMs', config.timeoutMs) ??
      settingProblem('sms.accountSid', headerValueSchema, config.accountSid) ??
      settingProblem('sms.authToken', headerValueSchema, config.authToken) ??
      (config.apiBaseUrl === undefined ? undefined : settingProblem('sms.apiBaseUrl', apiBaseUrlSchema, config.apiBaseUrl)) ??
      new SMSProvider(config)
    );
  }

  private get accountUrl(): string {
    return `${this.config.apiBaseUrl ?? 'https://api.twilio.com'}/2010-04-01/Accounts/${this.config.accountSid}`;
  }

  private get timeoutMs(): number {
    return this.config.timeoutMs ?? DEFAULT_PROVIDER_TIMEOUT_MS;
  }

  private get authorization(): string {
    return `Basic ${btoa(`${this.config.accountSid}:${this.config.authToken}`)}`;
  }

  async send(request: CommunicationRequest) {
    return observePayments('notification.send', this.target, async () => {
      const processedContent = applyPersonalizations(request.content, request.personalizations);

      // Truncate SMS content to 160 characters for standard SMS
      const smsContent = processedContent.length > 160 ? processedContent.slice(0, 157) + '...' : processedContent;

      const reply = await callProvider(
        this.target,
        `${this.accountUrl}/Messages.json`,
        {
          method: 'POST',
          headers: {
            Authorization: this.authorization,
            'Content-Type': 'application/x-www-form-urlencoded',
          },
          body: new URLSearchParams({
            From: this.config.fromNumber,
            To: request.recipient,
            Body: smsContent,
            StatusCallback: '', // Would be webhook URL for status updates
          }),
        },
        this.timeoutMs,
      );
      if (isFailure(reply)) return reply;
      if (!reply.ok) return rejected(this.target, reply);

      const data = parse(twilioMessageSchema, reply.body);
      if (isFailure(data)) return invalidBody(this.target, reply, data);

      const sent: CommunicationSent = {
        messageId: data.sid,
        providerResponse: {
          provider: 'twilio',
          timestamp: now().toString(),
          recipient: request.recipient,
          twilioSid: data.sid,
          status: data.status,
          uri: data.uri,
        },
      };
      return sent;
    });
  }

  async validateConfiguration(): Promise<boolean> {
    try {
      // Test Twilio credentials by fetching account info
      const response = await fetch(`${this.accountUrl}.json`, {
        method: 'GET',
        headers: { Authorization: this.authorization },
        signal: AbortSignal.timeout(this.timeoutMs),
      });

      return response.ok && !!this.config.fromNumber;
    } catch {
      return false;
    }
  }

  async getDeliveryStatus(messageId: string) {
    return observePayments('notification.delivery_status', this.target, async () => {
      const id = parse(providerMessageIdSchema, messageId);
      if (isFailure(id)) return id;
      const reply = await callProvider(
        this.target,
        `${this.accountUrl}/Messages/${encodeURIComponent(id)}.json`,
        { headers: { Authorization: this.authorization } },
        this.timeoutMs,
      );
      if (isFailure(reply)) return reply;
      if (!reply.ok) return rejected(this.target, reply);

      const data = parse(twilioMessageSchema, reply.body);
      if (isFailure(data)) return invalidBody(this.target, reply, data);

      // Map Twilio status to our status
      let status: CommStatus = 'sent';
      if (data.status === 'delivered') status = 'delivered';
      else if (data.status === 'failed' || data.status === 'undelivered') status = 'failed';

      const delivery: CommunicationDeliveryStatus = {
        status,
        timestamp: fromDate(data.date_updated ?? data.date_created ?? new Date()),
        metadata: {
          twilioStatus: data.status,
          errorCode: data.error_code,
          errorMessage: data.error_message,
        },
      };
      return delivery;
    });
  }
}

/** One in-app notification, as the in-app channel hands it to the app's store. */
export type InAppNotification = {
  /** The customer id the notification is for. */
  recipient: string;
  title: string;
  content: string;
  /** The execution, campaign and customer the notification belongs to. */
  trackingData: Record<string, unknown>;
};

/** What the app's store holds about one in-app notification: when it was stored, and when the customer read it. */
export type StoredInAppNotification = { id: string; createdAt: Instant; readAt: Instant | null };

/**
 * Where the app keeps in-app notifications. The package has no notifications table: the app owns it
 * and shows the notifications in its UI. `save` stores one and returns its row; `find` reads one back
 * (or `null` when the app has no notification with that id).
 */
export type InAppNotificationStore = {
  save(notification: InAppNotification): Promise<StoredInAppNotification>;
  find(id: string): Promise<StoredInAppNotification | null>;
};

/** In-app notifications, stored through the app's {@link InAppNotificationStore}. */
export class InAppProvider implements CommunicationProvider {
  readonly channel = 'in_app' as const;
  private readonly target: ProviderTarget = { channel: 'in_app', provider: 'in_app' };

  constructor(
    private config: {
      appUrl: string;
      store: InAppNotificationStore;
    },
  ) {}

  async send(request: CommunicationRequest): Promise<CommunicationSent> {
    const title = request.subject
      ? applyPersonalizations(request.subject, request.personalizations)
      : 'Payment Notice';
    const stored = await this.config.store.save({
      recipient: request.recipient,
      title,
      content: applyPersonalizations(request.content, request.personalizations),
      trackingData: request.trackingData ?? {},
    });

    return {
      messageId: stored.id,
      providerResponse: {
        provider: 'in_app',
        timestamp: stored.createdAt.toString(),
        notificationId: stored.id,
        appUrl: `${this.config.appUrl}/notifications/${stored.id}`,
      },
    };
  }

  async validateConfiguration(): Promise<boolean> {
    return URL.canParse(this.config.appUrl);
  }

  /**
   * What the store holds: `opened` once the customer read it, else `delivered` (stored is shown).
   * A notification the store does not have is `NotificationProviderRejected` with status 404.
   */
  async getDeliveryStatus(messageId: string) {
    const stored = await this.config.store.find(messageId);
    if (!stored) {
      return NotificationProviderRejected({ ...this.target, upstreamStatus: 404, upstreamMessage: null });
    }
    const status: CommunicationDeliveryStatus = {
      status: stored.readAt ? 'opened' : 'delivered',
      timestamp: stored.readAt ?? stored.createdAt,
      metadata: { messageId, readAt: stored.readAt?.toString() ?? null },
    };
    return status;
  }
}

/**
 * A webhook recipient: an http or https URL with no user name or password and no port the Fetch
 * standard blocks. `fetch` throws for either before sending, which would read as an outage.
 */
const webhookUrlSchema = apiBaseUrlSchema;

/** The JSON object a webhook step's content may hold; other content is sent as `{ message }`. */
const webhookPayloadSchema = jsonTextSchema.pipe(z.record(z.string(), z.unknown()));

/** A metadata object inside a webhook payload; anything else is replaced. */
const payloadMetadataSchema = z.record(z.string(), z.unknown());

/** An `allowedHosts` entry: a bare hostname, the way URL parsing writes it (no scheme, port or path). */
const allowedHostSchema = z
  .string()
  .refine(host => URL.canParse(`http://${host}`) && new URL(`http://${host}`).hostname === host.toLowerCase(), {
    message: 'must be a bare hostname such as hooks.example.com',
  });

/** The settings of a {@link WebhookProvider}. */
export type WebhookProviderConfig = {
  /** The hostnames a webhook may reach, compared exactly (lowercased) with the URL's host. Never empty. */
  allowedHosts: readonly string[];
  defaultHeaders: Record<string, string>;
  /** How long one webhook call may take: whole milliseconds from 1 to 2^31 - 1. */
  timeoutMs: number;
};

/**
 * Webhook communication provider for external integrations. The URL comes from customer metadata,
 * so a send reaches only a host on the operator's `allowedHosts` list, and the reply's body is
 * never read or kept: only its HTTP status. Each send runs in a `payments.notification.send` span
 * (channel and provider only, never the URL). Build it with {@link WebhookProvider.create}.
 */
export class WebhookProvider implements CommunicationProvider {
  readonly channel = 'webhook' as const;
  private readonly target: ProviderTarget = { channel: 'webhook', provider: 'webhook' };
  private readonly allowedHosts: ReadonlySet<string>;

  private constructor(private config: WebhookProviderConfig) {
    this.allowedHosts = new Set(config.allowedHosts.map(host => host.toLowerCase()));
  }

  /**
   * Builds the provider, or returns `payments.configuration_invalid` for an empty `allowedHosts`, an
   * entry that is not a bare hostname, a `defaultHeaders` name or value `fetch` would refuse, or a
   * `timeoutMs` that is not a whole number from 1 to 2^31 - 1.
   */
  static create(config: WebhookProviderConfig): WebhookProvider | ConfigurationInvalid {
    const timeout = timeoutProblem('webhook.timeoutMs', config.timeoutMs);
    if (timeout) return timeout;
    if (config.allowedHosts.length === 0) {
      return PaymentsConfigurationInvalid({
        setting: 'webhook.allowedHosts',
        problem: 'the webhook channel is enabled with no allowed hosts',
      });
    }
    for (const host of config.allowedHosts) {
      if (!allowedHostSchema.safeParse(host).success) {
        return PaymentsConfigurationInvalid({
          setting: 'webhook.allowedHosts',
          problem: `${JSON.stringify(host)} is not a bare hostname`,
        });
      }
    }
    for (const [name, value] of Object.entries(config.defaultHeaders)) {
      const problem =
        settingProblem('webhook.defaultHeaders', headerNameSchema, name) ??
        settingProblem(`webhook.defaultHeaders.${name}`, headerValueSchema, value);
      if (problem) return problem;
    }
    return new WebhookProvider(config);
  }

  async send(request: CommunicationRequest) {
    return observePayments('notification.send', this.target, async () => {
      // For webhook communications, the recipient is the webhook URL (stored customer metadata)
      const webhookUrl = parse(webhookUrlSchema, request.recipient);
      if (isFailure(webhookUrl)) return webhookUrl;
      // Tracking data is caller JSON sent in the body: a bigint (which JSON.stringify throws on) or U+0000 is refused
      const trackingData = parse(pgJsonRecordSchema.optional(), request.trackingData);
      if (isFailure(trackingData)) return trackingData;
      const host = new URL(webhookUrl).hostname.toLowerCase();
      if (!this.allowedHosts.has(host)) return NotificationWebhookHostNotAllowed({ host });

      // Process template variables in content (webhook payload)
      const processedContent = applyPersonalizations(request.content, request.personalizations);

      // Content that is a JSON object is the payload; any other content is sent as text
      const parsed = webhookPayloadSchema.safeParse(processedContent);
      const payload = parsed.success ? parsed.data : { message: processedContent };
      const metadata = payloadMetadataSchema.safeParse(payload['metadata']);

      // Add metadata to payload
      payload['metadata'] = {
        ...(metadata.success ? metadata.data : {}),
        ...trackingData,
        timestamp: now().toString(),
      };

      const messageId = `webhook_${Date.now()}_${Math.random().toString(36).slice(2, 11)}`;

      const reply = await callProvider(
        this.target,
        webhookUrl,
        {
          method: 'POST',
          // A redirect is answered as it is, never followed: an allowed host must not lead to one that is not
          redirect: 'manual',
          headers: {
            'Content-Type': 'application/json',
            'User-Agent': 'Strophie-Dunning/1.0',
            ...this.config.defaultHeaders,
          },
          body: JSON.stringify(payload),
        },
        this.config.timeoutMs,
        // The receiver is not a provider we know: its reply body is never read or kept, only its status
        'discard',
      );
      if (isFailure(reply)) return reply;
      if (!reply.ok) {
        return NotificationProviderRejected({ ...this.target, upstreamStatus: reply.status, upstreamMessage: null });
      }

      const sent: CommunicationSent = {
        messageId,
        providerResponse: {
          provider: 'webhook',
          timestamp: now().toString(),
          recipient: webhookUrl,
          status: reply.status,
        },
      };
      return sent;
    });
  }

  async validateConfiguration(): Promise<boolean> {
    // The allowed hosts were checked when the provider was built; each URL is checked per request
    return this.config.timeoutMs > 0;
  }
}

/**
 * Main communication orchestration service
 * Manages multiple communication providers and handles delivery orchestration
 */
export class CommunicationOrchestrationService {
  private providers = new Map<CommunicationChannel, CommunicationProvider>();
  private communicationRepo;

  constructor(
    private readonly db: DunningDatabase,
    private readonly tables: Pick<DunningTables, 'dunningCommunications' | 'dunningExecutions'>,
  ) {
    this.communicationRepo = createDunningCommunicationRepository(db, tables);
  }

  /**
   * Register a communication provider
   */
  registerProvider(provider: CommunicationProvider): void {
    this.providers.set(provider.channel, provider);
  }

  /**
   * Send communication for a dunning execution. Returns the communication row marked `sent`, or the
   * provider's failure (refused, timed out, unreadable answer, invalid recipient) after the row is
   * marked `failed` with that failure's message. A channel with no provider registered returns
   * `NotificationChannelUnavailable`, a recipient from customer data the `recipient` column cannot
   * store (over 255 characters, or holding U+0000) returns `schema.invalid_input`, and an execution,
   * step or customer with no row returns its not-found failure (`CommunicationReferenceMissing`); each
   * writes nothing and sends nothing; so does an execution, customer or template id the columns cannot
   * store (over 255 characters, or holding U+0000). A provider that cannot be reached throws
   * (`PaymentProviderError('unavailable')`) after the row is marked `failed`; when marking the row
   * fails too, an `AggregateError` holds both errors, the send error first.
   */
  async sendCommunication(
    execution: DunningExecution,
    template: DunningTemplate,
    customer: CustomerData,
    personalizations: Record<string, string> = {},
  ) {
    const refs = parse(communicationRefsSchema, {
      executionId: execution.id,
      customerId: execution.customerId,
      templateId: template.id,
    });
    if (isFailure(refs)) return refs;

    const provider = this.providers.get(template.communication.channel);
    if (!provider) {
      return NotificationChannelUnavailable({ channel: template.communication.channel });
    }

    // Determine recipient based on channel. It comes from customer data: the insert checks it fits its column
    const recipient = this.getRecipient(customer, template.communication.channel);

    // Create communication record
    const communication = await this.communicationRepo.create({
      executionId: execution.id,
      customerId: execution.customerId,
      templateId: template.id,
      channel: template.communication.channel,
      recipient,
      subject: template.communication.subject ?? null,
      content: template.communication.content,
      status: 'pending',
    });
    // The execution, step or customer has no row (deleted, or never stored): nothing is written or sent
    if (isFailure(communication)) return communication;

    try {
      // Send the communication
      const result = await provider.send({
        recipient,
        subject: template.communication.subject,
        content: template.communication.content,
        template: template.communication,
        personalizations: {
          ...this.getDefaultPersonalizations(customer),
          ...personalizations,
        },
        trackingData: {
          executionId: execution.id,
          campaignId: execution.campaignId,
          customerId: execution.customerId,
        },
      });

      if (isFailure(result)) {
        orThrow(await this.communicationRepo.updateStatus(communication.id, 'failed', { failureReason: result.message }));
        return result;
      }

      const sent = await this.communicationRepo.updateStatus(communication.id, 'sent', {
        sentAt: now(),
        providerMessageId: result.messageId,
        providerResponse: result.providerResponse,
      });
      return sent ?? communication;
    } catch (error) {
      // Update communication status on error; a failing status write never hides the send error
      try {
        orThrow(
          await this.communicationRepo.updateStatus(communication.id, 'failed', {
            failureReason: error instanceof Error ? error.message : 'Unknown error',
          }),
        );
      } catch (statusError) {
        throw new AggregateError(
          [error, statusError],
          'The communication was not sent, and marking it failed did not work either',
          { cause: statusError },
        );
      }

      throw error;
    }
  }

  /**
   * Get recipient address based on customer and channel
   */
  private getRecipient(customer: CustomerData, channel: CommunicationChannel): string {
    switch (channel) {
      case 'email': {
        return customer.email || '';
      }
      case 'sms': {
        return customer.phone || metadataText(customer.metadata?.['phone']);
      }
      case 'in_app': {
        return customer.id;
      } // Use customer ID instead of userId which doesn't exist
      case 'webhook': {
        return metadataText(customer.metadata?.['webhookUrl']);
      }
      default: {
        // The channel type is closed; a value outside it is a caller bug
        return unreachable(channel);
      }
    }
  }

  /**
   * Get default personalizations for a customer
   */
  private getDefaultPersonalizations(customer: CustomerData): Record<string, string> {
    return {
      customer_name: customer.name || 'Valued Customer',
      customer_email: customer.email || '',
      customer_id: customer.id,
      current_date: toDate(now()).toLocaleDateString(),
      company_name: 'Your Company', // Would come from configuration
    };
  }

  /**
   * Send the pending communications. Returns how many were handled and each one that was not sent:
   * a channel with no provider, a provider failure (the row is marked `failed`), or a thrown error.
   * `limit` is a whole number of 0 or more (a precondition: anything else throws an invariant failure
   * before any query).
   */
  async processPendingCommunications(limit = 100): Promise<DunningTickReport> {
    const pendingCommunications = await this.communicationRepo.findPendingCommunications(limit);
    const report: DunningTickReport = { processed: pendingCommunications.length, failed: [] };

    for (const communication of pendingCommunications) {
      try {
        const provider = this.providers.get(communication.channel);
        if (!provider) {
          logger.error('No provider configured for channel', { channel: communication.channel });
          report.failed.push(
            tickFault(communication.id, NotificationChannelUnavailable({ channel: communication.channel })),
          );
          continue;
        }

        // For pending communications, we need to get the customer and execution data
        // This is a simplified version - in practice you'd join with customer data
        const result = await provider.send({
          recipient: communication.recipient,
          subject: communication.subject ?? undefined,
          content: communication.content,
          template: {
            channel: communication.channel,
            content: communication.content,
            subject: communication.subject ?? undefined,
            variables: [],
          },
          personalizations: {}, // Would be filled from customer data
        });

        if (isFailure(result)) {
          logger.warn('Communication {communicationId} was not sent: {code}', {
            communicationId: communication.id,
            code: result.code,
          });
          report.failed.push(tickFault(communication.id, result));
          orThrow(await this.communicationRepo.updateStatus(communication.id, 'failed', { failureReason: result.message }));
        } else {
          orThrow(await this.communicationRepo.updateStatus(communication.id, 'sent', {
            sentAt: now(),
            providerMessageId: result.messageId,
            providerResponse: result.providerResponse,
          }));
        }
      } catch (error) {
        logger.error('Failed to process communication', {
          communicationId: communication.id,
          error: error instanceof Error ? error.message : String(error),
        });
        report.failed.push(tickFault(communication.id, error));
        orThrow(await this.communicationRepo.updateStatus(communication.id, 'failed', {
          failureReason: error instanceof Error ? error.message : 'Unknown error',
        }));
      }
    }
    return report;
  }

  /**
   * Record a delivery callback from a channel provider. The payload is outside input and is parsed with
   * `communicationWebhookSchema`: a payload it refuses returns `schema.invalid_input`, and a provider
   * message id no communication has returns `DunningCommunicationNotFound`; both write nothing.
   * Returns the communication as it is now.
   */
  async handleCommunicationWebhook(payload: CommunicationWebhookInput) {
    const data = parse(communicationWebhookSchema, payload);
    if (isFailure(data)) return data;

    const communication = await this.communicationRepo.findByProviderMessageId(data.providerMessageId);
    if (!communication) return DunningCommunicationNotFound({ providerMessageId: data.providerMessageId });

    const updates: Partial<CommunicationUpdateData> = {
      trackingData: {
        ...communication.trackingData,
        [data.event]: data.timestamp,
        ...(data.metadata && { metadata: data.metadata }),
      },
      updatedAt: now(),
    };

    switch (data.event) {
      case 'delivered': {
        updates.deliveredAt = data.timestamp;
        break;
      }
      case 'opened': {
        updates.openedAt = data.timestamp;
        break;
      }
      case 'clicked': {
        updates.clickedAt = data.timestamp;
        break;
      }
      case 'bounced': {
        updates.failureReason = 'Email bounced';
        break;
      }
    }

    const updated = await this.communicationRepo.updateStatus(
      communication.id,
      data.event === 'bounced' ? 'bounced' : communication.status,
      updates,
    );
    return updated ?? communication;
  }

  /**
   * Get communication by ID
   */
  async getCommunication(communicationId: DunningCommunicationId): Promise<DunningCommunication | null> {
    return this.communicationRepo.findById(communicationId);
  }

  /**
   * List communications with filtering. `limit` and `offset` are whole numbers of 0 or more and the
   * times fall in the years 1 to 9999 (preconditions: anything else throws an invariant failure). A
   * `status` or `sortBy` outside its list returns `schema.invalid_input`.
   */
  async listCommunications(query: ListCommunicationsQuery) {
    return this.communicationRepo.findMany(query);
  }

  /**
   * Update communication status manually
   */
  async updateCommunicationStatus(input: UpdateCommunicationStatusInput) {
    const updates: Partial<CommunicationUpdateData> = { updatedAt: now() };

    if (input.sentAt) updates.sentAt = input.sentAt;
    if (input.deliveredAt) updates.deliveredAt = input.deliveredAt;
    if (input.openedAt) updates.openedAt = input.openedAt;
    if (input.clickedAt) updates.clickedAt = input.clickedAt;
    if (input.failureReason) updates.failureReason = input.failureReason;
    if (input.providerMessageId) updates.providerMessageId = input.providerMessageId;
    if (input.providerResponse) updates.providerResponse = input.providerResponse;
    if (input.trackingData) updates.trackingData = input.trackingData;

    return this.communicationRepo.updateStatus(input.communicationId, input.status, updates);
  }

  /**
   * Get communication metrics for an execution
   */
  async getCommunicationMetrics(executionId: DunningExecutionId) {
    return this.communicationRepo.getMetricsForExecution(executionId);
  }

  /**
   * Validate all registered providers
   */
  async validateProviders(): Promise<Partial<Record<CommunicationChannel, boolean>>> {
    // Only the channels with a registered provider have an entry
    const results: Partial<Record<CommunicationChannel, boolean>> = {};

    for (const [channel, provider] of this.providers) {
      try {
        results[channel] = await provider.validateConfiguration();
      } catch (error) {
        logger.error('Provider validation failed', {
          channel,
          error: error instanceof Error ? error.message : String(error),
        });
        results[channel] = false;
      }
    }

    return results;
  }

  /**
   * Get delivery status for a communication: `null` when the communication, its provider message id,
   * or a provider that reports status is missing; the provider's failure when it refuses, times out
   * or answers in another shape. A provider that cannot be reached throws `PaymentProviderError('unavailable')`.
   */
  async getDeliveryStatus(communicationId: DunningCommunicationId) {
    const communication = await this.communicationRepo.findById(communicationId);
    if (!communication || !communication.providerMessageId) {
      return null;
    }

    const provider = this.providers.get(communication.channel);
    if (!provider || !provider.getDeliveryStatus) {
      return null;
    }

    return provider.getDeliveryStatus(communication.providerMessageId);
  }

  /**
   * Put the failed communications back to pending and send them again: the report of that send.
   * Executions own the resend of their message, so only one job ever sends it again: a communication
   * whose execution is `failed` with a `nextRetryAt` (`retryFailedExecutions` will send it again), or
   * that a later communication of the same execution replaced, is skipped. What is left is the latest
   * failed send of an execution no retry will run (refused with a 4xx, timed out, retries used up).
   * `limit` is a whole number of 0 or more (a precondition: anything else throws an invariant failure
   * before any query).
   */
  async retryFailedCommunications(limit = 50): Promise<DunningTickReport> {
    invariant(Number.isSafeInteger(limit) && limit >= 0, '[@arki/payments] limit must be a whole number of 0 or more');
    const { dunningCommunications: communications, dunningExecutions: executions } = this.tables;
    const later = alias(communications, 'later_communication');
    const failedCommunications = await this.db
      .select({ id: communications.id })
      .from(communications)
      .innerJoin(executions, eq(executions.id, communications.executionId))
      .where(
        and(
          eq(communications.status, 'failed'),
          // Not an execution retryFailedExecutions will run again
          or(ne(executions.status, 'failed'), isNull(executions.nextRetryAt)),
          notExists(
            this.db
              .select({ id: later.id })
              .from(later)
              .where(and(eq(later.executionId, communications.executionId), gt(later.createdAt, communications.createdAt))),
          ),
        ),
      )
      .orderBy(desc(communications.createdAt))
      .limit(limit);

    const resetFaults: DunningTickReport['failed'] = [];
    for (const communication of failedCommunications) {
      try {
        // Reset status to pending for retry
        orThrow(await this.communicationRepo.updateStatus(communication.id, 'pending'));
      } catch (error) {
        logger.error('Failed to retry communication', {
          communicationId: communication.id,
          error: error instanceof Error ? error.message : String(error),
        });
        resetFaults.push(tickFault(communication.id, error));
      }
    }

    // Process the retried communications
    const sent = await this.processPendingCommunications(limit);
    return { processed: sent.processed, failed: [...resetFaults, ...sent.failed] };
  }
}

export type CommunicationOrchestrationConfig = {
  email?: {
    apiKey: string;
    fromEmail: string;
    fromName?: string;
    /** How long one Resend call may take. Default 30 000 ms. */
    timeoutMs?: number;
  };
  sms?: {
    accountSid: string;
    authToken: string;
    fromNumber: string;
    /** How long one Twilio call may take. Default 30 000 ms. */
    timeoutMs?: number;
  };
  inApp?: {
    appUrl: string;
    /** Where the app keeps in-app notifications: the channel stores through it and reads delivery status back. */
    store: InAppNotificationStore;
  };
  /** The webhook channel. Omit it to leave the channel off. */
  webhook?: {
    /** The hostnames a customer's `webhookUrl` may point at. Required and never empty: an empty list fails at boot. */
    allowedHosts: readonly string[];
    defaultHeaders?: Record<string, string>;
    timeoutMs?: number;
    sourceHeader?: string;
  };
};

/** Text stored in customer metadata, or `''` when the key holds no text. */
function metadataText(value: unknown): string {
  const text = z.string().safeParse(value);
  return text.success ? text.data : '';
}

/**
 * Factory function to create CommunicationOrchestrationService.
 *
 * Apps inject channel-provider config rather than the package reading
 * `env` directly — preserves the @arki/payments package as
 * config-injectable and env-agnostic. A channel setting no provider can use (see
 * {@link EmailProvider.create}, {@link SMSProvider.create}, {@link WebhookProvider.create}) returns
 * `payments.configuration_invalid`; nothing is thrown.
 */
export function createCommunicationOrchestrationService(
  db: DunningDatabase,
  tables: Pick<DunningTables, 'dunningCommunications' | 'dunningExecutions'>,
  config: CommunicationOrchestrationConfig = {},
): CommunicationOrchestrationService | ConfigurationInvalid {
  const service = new CommunicationOrchestrationService(db, tables);

  if (config.email) {
    const email = EmailProvider.create({
      apiKey: config.email.apiKey,
      fromEmail: config.email.fromEmail,
      fromName: config.email.fromName ?? 'Payments',
      timeoutMs: config.email.timeoutMs,
    });
    if (isFailure(email)) return email;
    service.registerProvider(email);
  }

  if (config.sms) {
    const sms = SMSProvider.create({
      accountSid: config.sms.accountSid,
      authToken: config.sms.authToken,
      fromNumber: config.sms.fromNumber,
      timeoutMs: config.sms.timeoutMs,
    });
    if (isFailure(sms)) return sms;
    service.registerProvider(sms);
  }

  if (config.inApp) {
    service.registerProvider(new InAppProvider({ appUrl: config.inApp.appUrl, store: config.inApp.store }));
  }

  if (config.webhook) {
    const webhook = WebhookProvider.create({
      allowedHosts: config.webhook.allowedHosts,
      defaultHeaders: config.webhook.defaultHeaders ?? {
        'X-Source': config.webhook.sourceHeader ?? 'dunning-system',
      },
      timeoutMs: config.webhook.timeoutMs ?? DEFAULT_PROVIDER_TIMEOUT_MS,
    });
    if (isFailure(webhook)) return webhook;
    service.registerProvider(webhook);
  }

  return service;
}
