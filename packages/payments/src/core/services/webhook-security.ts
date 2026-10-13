import { createHash, timingSafeEqual } from 'node:crypto';

import type { Instant } from '@arki/date';
import { isBefore, now, sub } from '@arki/date';

import type { PaymentProviderType, WebhookValidationResult } from '../types.js';

export type WebhookSecurityConfig = {
  allowedIps: string[];
  replayWindowSeconds: number;
  maxRetries: number;
};

export type WebhookValidationOptions = {
  skipIpValidation?: boolean;
  skipTimestampValidation?: boolean;
  skipSignatureValidation?: boolean;
};

type JsonValue = string | number | boolean | null | JsonValue[] | { [k: string]: JsonValue };

export class WebhookSecurityService {
  private processedEvents = new Map<string, Instant>();
  private readonly config: WebhookSecurityConfig;

  constructor(config: WebhookSecurityConfig) {
    this.config = config;

    // Clean up old processed events every hour
    setInterval(() => {
      this.cleanupOldEvents();
    }, 60 * 60 * 1000);
  }

  async validateWebhook(
    provider: PaymentProviderType,
    payload: string | Buffer,
    signature: string,
    timestamp: string,
    sourceIp: string,
    webhookSecret: string,
    options: WebhookValidationOptions = {},
  ): Promise<WebhookValidationResult> {
    try {
      // 1. IP Address validation
      if (!options.skipIpValidation && !this.isIpAllowed(sourceIp, provider)) {
        return {
          isValid: false,
          provider,
          error: `Webhook from unauthorized IP address: ${sourceIp}`,
        };
      }

      // 2. Timestamp validation (prevent replay attacks)
      if (!options.skipTimestampValidation) {
        const timestampValidation = this.validateTimestamp(timestamp);
        if (!timestampValidation.isValid) {
          return {
            isValid: false,
            provider,
            error: timestampValidation.error,
          };
        }
      }

      // 3. Replay attack prevention
      const eventId = this.generateEventId(payload, signature, timestamp);
      if (this.isEventProcessed(eventId)) {
        return {
          isValid: false,
          provider,
          error: 'Webhook event has already been processed (replay attack detected)',
        };
      }

      // 4. Signature verification
      if (!options.skipSignatureValidation) {
        const signatureValidation = this.validateSignature(
          provider,
          payload,
          signature,
          timestamp,
          webhookSecret,
        );
        if (!signatureValidation.isValid) {
          return signatureValidation;
        }
      }

      // 5. Payload sanitization
      const sanitizedPayload = this.sanitizePayload(payload);

      // Mark event as processed
      this.markEventAsProcessed(eventId);

      return {
        isValid: true,
        provider,
        data: sanitizedPayload,
      };
    } catch (error) {
      return {
        isValid: false,
        provider,
        error: `Webhook validation error: ${error instanceof Error ? error.message : 'Unknown error'}`,
      };
    }
  }

  private isIpAllowed(sourceIp: string, provider: PaymentProviderType): boolean {
    // Provider-specific IP allowlists
    const providerIpRanges: Record<PaymentProviderType, string[]> = {
      stripe: [
        '54.187.174.169',
        '54.187.205.235',
        '54.187.216.72',
        '54.241.31.99',
        '54.241.31.102',
        '54.241.34.107',
        // Add more Stripe IPs as needed
      ],
      paypal: ['173.0.80.0/20', '173.0.96.0/20', '173.0.112.0/20'],
      square: ['52.21.213.172', '35.174.233.25'],
      razorpay: [],
      // RevenueCat authenticates webhooks via the Authorization header secret, not an IP allowlist.
      revenuecat: [],
    };

    const allowedIps = [...this.config.allowedIps, ...(providerIpRanges[provider] || [])];

    return allowedIps.some((allowedIp) => {
      if (allowedIp.includes('/')) {
        return this.isIpInCidrRange(sourceIp, allowedIp);
      }
      return sourceIp === allowedIp;
    });
  }

  private isIpInCidrRange(ip: string, cidr: string): boolean {
    // Simplified CIDR check - in production use a proper networking library
    try {
      const [network, prefixLength] = cidr.split('/');
      if (!network || !prefixLength) {
        return false;
      }
      const mask = (0xff_ff_ff_ff << (32 - Number.parseInt(prefixLength, 10))) >>> 0;

      const ipInt = this.ipToInt(ip);
      const networkInt = this.ipToInt(network);

      return (ipInt & mask) === (networkInt & mask);
    } catch {
      return false;
    }
  }

  private ipToInt(ip: string): number {
    return ip.split('.').reduce((acc, octet) => (acc << 8) + Number.parseInt(octet, 10), 0) >>> 0;
  }

  private validateTimestamp(timestamp: string): { isValid: boolean; error?: string } {
    try {
      const webhookTime = Number.parseInt(timestamp, 10) * 1000;
      const currentTime = Date.now();
      const timeDifference = Math.abs(currentTime - webhookTime);

      if (timeDifference > this.config.replayWindowSeconds * 1000) {
        return {
          isValid: false,
          error: `Webhook timestamp is outside acceptable window (${this.config.replayWindowSeconds}s)`,
        };
      }

      return { isValid: true };
    } catch {
      return {
        isValid: false,
        error: 'Invalid timestamp format',
      };
    }
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

  private cleanupOldEvents(): void {
    const cutoffTime = sub(now(), { seconds: this.config.replayWindowSeconds * 2 });

    for (const [eventId, processedAt] of this.processedEvents) {
      if (isBefore(processedAt, cutoffTime)) {
        this.processedEvents.delete(eventId);
      }
    }
  }

  private validateSignature(
    provider: PaymentProviderType,
    payload: string | Buffer,
    signature: string,
    timestamp: string,
    webhookSecret: string,
  ): WebhookValidationResult {
    try {
      switch (provider) {
        case 'stripe': {
          return this.validateStripeSignature(payload, signature, timestamp, webhookSecret);
        }
        case 'paypal': {
          return this.validatePayPalSignature(payload, signature, webhookSecret);
        }
        case 'square': {
          return this.validateSquareSignature(payload, signature, webhookSecret);
        }
        default: {
          return {
            isValid: false,
            provider,
            error: `Unsupported provider for signature validation: ${provider}`,
          };
        }
      }
    } catch (error) {
      return {
        isValid: false,
        provider,
        error: `Signature validation error: ${error instanceof Error ? error.message : 'Unknown error'}`,
      };
    }
  }

  private validateStripeSignature(
    payload: string | Buffer,
    signature: string,
    _timestamp: string,
    secret: string,
  ): WebhookValidationResult {
    try {
      const elements = signature.split(',');
      const signatureMap = new Map<string, string>();

      for (const element of elements) {
        const [key, value] = element.split('=');
        if (key && value) {
          signatureMap.set(key, value);
        }
      }

      const expectedSignature = signatureMap.get('v1');
      const receivedTimestamp = signatureMap.get('t');

      if (!expectedSignature || !receivedTimestamp) {
        return {
          isValid: false,
          provider: 'stripe',
          error: 'Invalid signature format',
        };
      }

      const payloadStr = typeof payload === 'string' ? payload : payload.toString();
      const signedPayload = `${receivedTimestamp}.${payloadStr}`;

      const computedSignature = createHash('sha256')
        .update(signedPayload, 'utf8')
        .update(secret, 'utf8')
        .digest('hex');

      const isValid = timingSafeEqual(
        Buffer.from(expectedSignature, 'hex'),
        Buffer.from(computedSignature, 'hex'),
      );

      return {
        isValid,
        provider: 'stripe',
        error: isValid ? undefined : 'Signature verification failed',
      };
    } catch (error) {
      return {
        isValid: false,
        provider: 'stripe',
        error: `Stripe signature validation error: ${error instanceof Error ? error.message : 'Unknown error'}`,
      };
    }
  }

  private validatePayPalSignature(
    payload: string | Buffer,
    signature: string,
    secret: string,
  ): WebhookValidationResult {
    try {
      const payloadStr = typeof payload === 'string' ? payload : payload.toString();
      const computedSignature = createHash('sha256').update(payloadStr + secret).digest('hex');

      const isValid = timingSafeEqual(Buffer.from(signature), Buffer.from(computedSignature));

      return {
        isValid,
        provider: 'paypal',
        error: isValid ? undefined : 'PayPal signature verification failed',
      };
    } catch (error) {
      return {
        isValid: false,
        provider: 'paypal',
        error: `PayPal signature validation error: ${error instanceof Error ? error.message : 'Unknown error'}`,
      };
    }
  }

  private validateSquareSignature(
    payload: string | Buffer,
    signature: string,
    secret: string,
  ): WebhookValidationResult {
    try {
      const payloadStr = typeof payload === 'string' ? payload : payload.toString();
      const computedSignature = createHash('sha256').update(secret + payloadStr).digest('hex');

      const isValid = timingSafeEqual(Buffer.from(signature), Buffer.from(computedSignature));

      return {
        isValid,
        provider: 'square',
        error: isValid ? undefined : 'Square signature verification failed',
      };
    } catch (error) {
      return {
        isValid: false,
        provider: 'square',
        error: `Square signature validation error: ${error instanceof Error ? error.message : 'Unknown error'}`,
      };
    }
  }

  private sanitizePayload(payload: string | Buffer): Record<string, unknown> {
    try {
      const payloadStr = typeof payload === 'string' ? payload : payload.toString();
      const parsed = JSON.parse(payloadStr) as JsonValue;
      const sanitized = this.deepSanitize(parsed);
      return typeof sanitized === 'object' && sanitized !== null && !Array.isArray(sanitized)
        ? (sanitized as Record<string, unknown>)
        : {};
    } catch {
      return {};
    }
  }

  private deepSanitize(value: JsonValue): JsonValue {
    if (value === null || typeof value !== 'object') {
      return value;
    }

    if (Array.isArray(value)) {
      return value.map((item) => this.deepSanitize(item));
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
