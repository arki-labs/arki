import { createHash } from 'node:crypto';
import { BlockList } from 'node:net';

import type { Instant } from '@arki/date';
import { z } from '@arki/contracts';
import { isBefore, now, sub } from '@arki/date';
import { isFailure } from '@arki/failure';
import { stripe, WebhookMalformed, WebhookStale } from '@arki/http/webhooks';
import { is, recordSchema } from '@arki/schema';

import type { PaymentProviderType } from '../types.js';
import type { WebhookCheck } from './webhook-failures.js';
import { PaymentsConfigurationInvalid } from '../failures.js';
import { MAX_BATCH_ITEMS } from '../pg-values.js';
import { paymentProviderValues } from '../primitives.js';
import { mapStripeEventType } from '../providers/stripe-event-types.js';
import { WebhookRejected } from './webhook-failures.js';

/** One allowed source: an IPv4 or IPv6 address, or a CIDR range of either. */
const allowedIpSchema = z.union([z.ipv4(), z.ipv6(), z.cidrv4(), z.cidrv6()]);

/** A delivery's source address: an IPv4 or IPv6 address. Anything else is not allowed. */
const sourceIpSchema = z.union([z.ipv4(), z.ipv6()]);

/**
 * A `Stripe-Signature` value an HTTP header can carry: printable ASCII. Stripe writes only that, and
 * `new Headers` throws on a line break or a character past U+00FF.
 */
const signatureHeaderSchema = z.string().regex(/^[\u0020-\u007E]*$/);

/**
 * The verifier's settings. `allowedIps` holds addresses and CIDR ranges (`'203.0.113.10'`,
 * `'173.0.80.0/20'`, `'2001:db8::/32'`); a malformed entry is refused when the service is built, so
 * it can never let an address through. `replayWindowSeconds` is whole seconds from 1 to one day: it
 * is both the timestamp window and Stripe's signature tolerance. `maxRetries` is a whole number of 0 or more.
 * `allowedIps` holds at most `MAX_BATCH_ITEMS` (1,000) entries.
 */
const webhookSecurityConfigSchema = z.object({
  allowedIps: z.array(allowedIpSchema).max(MAX_BATCH_ITEMS),
  replayWindowSeconds: z.number().int().min(1).max(86_400),
  maxRetries: z.number().int().min(0),
});

export type WebhookSecurityConfig = z.output<typeof webhookSecurityConfigSchema>;

export type WebhookValidationOptions = {
  skipIpValidation?: boolean;
  skipTimestampValidation?: boolean;
  skipSignatureValidation?: boolean;
};

/** A parsed JSON body. `JSON.parse` returns one; the schema says so to the type system without a cast. */
const jsonValueSchema = z.json();
type JsonValue = z.output<typeof jsonValueSchema>;

/** The one field of a Stripe event the verifier reads: its type, to name the event. */
const stripeTypedEventSchema = z.looseObject({ type: z.string() });

/** A whole number of seconds since the epoch, as Stripe writes `t=`. */
const UNIX_SECONDS = /^\d+$/;

/** The sources each provider sends webhooks from, besides `allowedIps`. */
const PROVIDER_IP_RANGES: Record<PaymentProviderType, readonly string[]> = {
  stripe: ['54.187.174.169', '54.187.205.235', '54.187.216.72', '54.241.31.99', '54.241.31.102', '54.241.34.107'],
  paypal: ['173.0.80.0/20', '173.0.96.0/20', '173.0.112.0/20'],
  square: ['52.21.213.172', '35.174.233.25'],
  razorpay: [],
  // RevenueCat authenticates webhooks via the Authorization header secret, not an IP allowlist.
  revenuecat: [],
};

/**
 * The allow list for addresses and CIDR ranges that `allowedIpSchema` accepted. `node:net`'s
 * `BlockList` does the matching (also an IPv4 address written as IPv4-mapped IPv6).
 */
function allowListOf(entries: readonly string[]): BlockList {
  const list = new BlockList();
  for (const entry of entries) {
    const slash = entry.indexOf('/');
    const address = slash === -1 ? entry : entry.slice(0, slash);
    const family = address.includes(':') ? 'ipv6' : 'ipv4';
    if (slash === -1) list.addAddress(address, family);
    else list.addSubnet(address, Number(entry.slice(slash + 1)), family);
  }
  return list;
}

/** A refusal of the delivery, with the check that refused it. */
function rejected(check: WebhookCheck, reason: string) {
  return WebhookRejected({ check, reason, retryable: false });
}

/** The messages this service has always returned, by `@arki/http/webhooks` code. */
function stripeFailure(code: string): string {
  switch (code) {
    case WebhookMalformed.code: {
      return 'Invalid signature format';
    }
    case WebhookStale.code: {
      return 'Signature timestamp is outside the allowed window';
    }
    default: {
      return 'Signature verification failed';
    }
  }
}

/** How often, at most, deliveries older than twice the replay window are pruned from the replay set. */
const CLEANUP_INTERVAL_MS = 60 * 60 * 1000;

/**
 * Checks a webhook delivery's source address, timestamp, replay and signature.
 *
 * `validateWebhook` returns `WebhookRejected` (`payments.webhook_rejected`) for every refusal, with
 * `check` naming the check that refused it: `source_ip`, `timestamp`, `replay` or `signature`. It
 * never throws for a delivery.
 *
 * Limit: the replay set is in this process's memory only. It is empty after a restart and not shared
 * between instances, so it only catches a copy that reaches the same process within the window. The
 * webhook handler's database claim (`claimWebhookEvent`) is what keeps an event from running twice.
 *
 * It starts no timer: old entries are pruned during `validateWebhook`, at most once an hour, so the
 * service never keeps a process alive and needs no closing.
 */
export class WebhookSecurityService {
  private processedEvents = new Map<string, Instant>();
  private readonly config: WebhookSecurityConfig;
  private readonly allowLists: ReadonlyMap<PaymentProviderType, BlockList>;
  private lastCleanupAt: Instant = now();

  private constructor(config: WebhookSecurityConfig) {
    this.config = config;
    this.allowLists = new Map(
      paymentProviderValues.map(provider => [
        provider,
        allowListOf([...config.allowedIps, ...PROVIDER_IP_RANGES[provider]]),
      ]),
    );
  }

  /** Builds the verifier. Returns `payments.configuration_invalid` for a config that breaks `WebhookSecurityConfig`'s rules. */
  static create(config: WebhookSecurityConfig) {
    const checked = webhookSecurityConfigSchema.safeParse(config);
    if (!checked.success) {
      return PaymentsConfigurationInvalid({
        setting: 'webhookSecurity',
        problem: checked.error.issues
          .map(issue => `${issue.path.join('.') || '(config)'}: ${issue.message}`)
          .join('; '),
      });
    }
    return new WebhookSecurityService(checked.data);
  }

  async validateWebhook(
    provider: PaymentProviderType,
    payload: string | Buffer,
    signature: string,
    timestamp: string,
    sourceIp: string,
    webhookSecret: string,
    options: WebhookValidationOptions = {},
  ) {
    // 1. IP Address validation
    if (!options.skipIpValidation && !this.isIpAllowed(sourceIp, provider)) {
      return rejected('source_ip', `Webhook from unauthorized IP address: ${sourceIp}`);
    }

    // 2. Timestamp validation (prevent replay attacks). Stripe signs its own
    //    timestamp, which the signature check verifies; the caller's value is not trusted.
    if (!options.skipTimestampValidation && provider !== 'stripe') {
      const timestampRefusal = this.validateTimestamp(timestamp);
      if (timestampRefusal !== undefined) return rejected('timestamp', timestampRefusal);
    }

    // 3. Replay attack prevention
    this.cleanupIfDue();
    const eventId = this.generateEventId(payload, signature, timestamp);
    if (this.isEventProcessed(eventId)) {
      return rejected('replay', 'Webhook event has already been processed (replay attack detected)');
    }

    // 4. Signature verification
    if (!options.skipSignatureValidation) {
      const signatureRefusal = await this.validateSignature(provider, payload, signature, webhookSecret);
      if (signatureRefusal !== undefined) return rejected('signature', signatureRefusal);
    }

    // 5. Payload sanitization
    const sanitizedPayload = this.sanitizePayload(payload);

    // Mark event as processed
    this.markEventAsProcessed(eventId);

    const typed = stripeTypedEventSchema.safeParse(sanitizedPayload);
    const eventType =
      provider === 'stripe' && typed.success ? (mapStripeEventType(typed.data.type) ?? undefined) : undefined;

    return { provider, eventType, data: sanitizedPayload };
  }

  /** Whether the source is an address on the provider's allow list. Text that is not an IP address is not. */
  private isIpAllowed(sourceIp: string, provider: PaymentProviderType): boolean {
    if (!is(sourceIp, sourceIpSchema)) return false;
    return this.allowLists.get(provider)?.check(sourceIp, sourceIp.includes(':') ? 'ipv6' : 'ipv4') ?? false;
  }

  /** Why the caller's timestamp is refused, or `undefined` when it is inside the window. */
  private validateTimestamp(timestamp: string): string | undefined {
    if (!UNIX_SECONDS.test(timestamp)) return 'Invalid timestamp format';
    const timeDifference = Math.abs(Date.now() - Number(timestamp) * 1000);
    if (timeDifference > this.config.replayWindowSeconds * 1000) {
      return `Webhook timestamp is outside acceptable window (${this.config.replayWindowSeconds}s)`;
    }
    return undefined;
  }

  private generateEventId(payload: string | Buffer, signature: string, timestamp: string): string {
    const payloadStr = typeof payload === 'string' ? payload : payload.toString();
    const data = `${payloadStr}:${signature}:${timestamp}`;
    return createHash('sha256').update(data).digest('hex');
  }

  private isEventProcessed(eventId: string): boolean {
    return this.processedEvents.has(eventId);
  }

  private markEventAsProcessed(eventId: string): void {
    this.processedEvents.set(eventId, now());
  }

  private cleanupIfDue(): void {
    if (isBefore(this.lastCleanupAt, sub(now(), { milliseconds: CLEANUP_INTERVAL_MS }))) {
      this.cleanupOldEvents();
    }
  }

  private cleanupOldEvents(): void {
    this.lastCleanupAt = now();
    const cutoffTime = sub(now(), { seconds: this.config.replayWindowSeconds * 2 });

    for (const [eventId, processedAt] of this.processedEvents) {
      if (isBefore(processedAt, cutoffTime)) {
        this.processedEvents.delete(eventId);
      }
    }
  }

  /** Why the signature is refused, or `undefined` when it matches. */
  private async validateSignature(
    provider: PaymentProviderType,
    payload: string | Buffer,
    signature: string,
    webhookSecret: string,
  ): Promise<string | undefined> {
    // An HMAC keyed with an empty secret can be computed by anyone.
    if (!webhookSecret) return 'Webhook secret is not configured';

    switch (provider) {
      case 'stripe': {
        return this.validateStripeSignature(payload, signature, webhookSecret);
      }
      // PayPal verifies through its API with transmission headers this method does not receive.
      case 'paypal': {
        return 'PayPal signature verification is not implemented';
      }
      // Square signs the notification URL plus the body, and this method does not receive the URL.
      case 'square': {
        return 'Square signature verification is not implemented';
      }
      default: {
        return `Unsupported provider for signature validation: ${provider}`;
      }
    }
  }

  /** Stripe signs its own timestamp (`t=`), so the window is checked on that, not on the caller's value. */
  private async validateStripeSignature(
    payload: string | Buffer,
    signature: string,
    secret: string,
  ): Promise<string | undefined> {
    if (!is(signature, signatureHeaderSchema)) return stripeFailure(WebhookMalformed.code);
    const body = typeof payload === 'string' ? new TextEncoder().encode(payload) : new Uint8Array(payload);
    const result = await stripe({ secrets: [secret] }).verify(
      { headers: new Headers({ 'stripe-signature': signature }), body },
      { tolerance: this.config.replayWindowSeconds },
    );
    return isFailure(result) ? stripeFailure(result.code) : undefined;
  }

  private sanitizePayload(payload: string | Buffer): Record<string, unknown> {
    try {
      const payloadStr = typeof payload === 'string' ? payload : payload.toString();
      const parsed: unknown = JSON.parse(payloadStr);
      if (!is(parsed, jsonValueSchema)) return {};
      const sanitized = this.deepSanitize(parsed);
      return is(sanitized, recordSchema) ? sanitized : {};
    } catch {
      return {};
    }
  }

  private deepSanitize(value: JsonValue): JsonValue {
    if (value === null || typeof value !== 'object') {
      return value;
    }

    if (Array.isArray(value)) {
      return value.map(item => this.deepSanitize(item));
    }

    const sanitized: Record<string, JsonValue> = {};
    const dangerousKeys = new Set(['__proto__', 'constructor', 'prototype']);

    for (const [key, v] of Object.entries(value)) {
      if (!dangerousKeys.has(key)) {
        sanitized[key] = this.deepSanitize(v);
      }
    }

    return sanitized;
  }

  // Public utility methods
  public getProcessedEventCount(): number {
    return this.processedEvents.size;
  }

  public clearProcessedEvents(): void {
    this.processedEvents.clear();
  }

  public isHealthy(): boolean {
    try {
      this.cleanupOldEvents();
      return true;
    } catch {
      return false;
    }
  }
}
