import crypto from 'node:crypto';

import type { Instant } from '@arki/date';
import { fromUnix } from '@arki/date';

import type { PaymentProviderType } from '../types.js';

export type WebhookSecurityValidationResult = {
  isValid: boolean;
  sanitizedPayload?: unknown;
  provider: PaymentProviderType;
  timestamp: Instant;
}

export class WebhookSecurityError extends Error {
  constructor(
    message: string,
    public code: WebhookSecurityErrorCode,
    public details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'WebhookSecurityError';
  }
}

export type WebhookSecurityErrorCode =
  | 'INVALID_IP'
  | 'TIMESTAMP_INVALID'
  | 'REPLAY_ATTACK'
  | 'INVALID_SIGNATURE'
  | 'INVALID_PAYLOAD';

type SignatureVerifier = {
  verify(payload: string | Buffer, signature: string, timestamp: string): Promise<boolean>;
}

export class WebhookSecurityService {
  private readonly allowedIpRanges = new Map<string, string[]>([
    ['stripe', [
      '54.187.174.169/32',
      '54.187.205.235/32',
      '54.187.216.72/32',
      '54.241.31.99/32',
      '54.241.31.102/32',
      '54.241.34.107/32',
    ]],
    ['razorpay', ['3.6.124.0/24', '3.7.44.0/24']],
    ['paypal', ['64.4.240.0/21', '64.4.248.0/22', '185.177.52.0/22']],
  ]);

  private readonly replayCache = new Map<string, number>();
  private readonly maxTimestampAge = 5 * 60 * 1000; // 5 minutes
  private signatureVerifiers = new Map<string, SignatureVerifier>();

  constructor() {
    // Initialize signature verifiers for each provider
    this.initializeVerifiers();
    // Start cleanup interval for replay cache
    this.startCleanupInterval();
  }

  private initializeVerifiers(): void {
    // Each provider would have its own signature verification logic
    // This is a simplified example
    this.signatureVerifiers.set('stripe', {
      verify: async (_payload, _signature, _timestamp) => {
        // Stripe signature verification logic
        // This would use the Stripe webhook secret
        return true; // Simplified for example
      },
    });

    this.signatureVerifiers.set('razorpay', {
      verify: async (_payload, _signature, _timestamp) => {
        // Razorpay signature verification logic
        return true; // Simplified for example
      },
    });
  }

  /**
   * Comprehensive webhook validation with multiple security layers
   */
  async validateWebhook(
    provider: PaymentProviderType,
    payload: string | Buffer,
    signature: string,
    timestamp: string,
    sourceIp: string,
  ): Promise<WebhookSecurityValidationResult> {
    // 1. IP Address validation
    if (!this.validateSourceIp(provider, sourceIp)) {
      throw new WebhookSecurityError('Invalid source IP address', 'INVALID_IP', {
        sourceIp,
        provider,
      });
    }

    // 2. Timestamp validation (prevent replay attacks)
    if (!this.validateTimestamp(timestamp)) {
      throw new WebhookSecurityError('Request timestamp too old or invalid', 'TIMESTAMP_INVALID', {
        timestamp,
        maxAge: this.maxTimestampAge,
      });
    }

    // 3. Replay attack prevention
    const requestId = this.generateRequestId(payload, timestamp);
    if (this.isReplayAttack(requestId)) {
      throw new WebhookSecurityError('Duplicate webhook request detected', 'REPLAY_ATTACK', {
        requestId,
      });
    }

    // 4. Signature verification
    const verifier = this.signatureVerifiers.get(provider);
    if (!verifier || !(await verifier.verify(payload, signature, timestamp))) {
      throw new WebhookSecurityError('Invalid webhook signature', 'INVALID_SIGNATURE', {
        provider,
      });
    }

    // 5. Payload sanitization
    const sanitizedPayload = this.sanitizePayload(payload);

    // Cache request ID to prevent replays
    this.replayCache.set(requestId, Date.now());

    return {
      isValid: true,
      sanitizedPayload,
      provider,
      timestamp: fromUnix(Number.parseInt(timestamp)),
    };
  }

  private validateSourceIp(provider: PaymentProviderType, sourceIp: string): boolean {
    const allowedRanges = this.allowedIpRanges.get(provider);
    if (!allowedRanges) return false;

    return allowedRanges.some((range) => {
      return this.ipInRange(sourceIp, range);
    });
  }

  private ipInRange(ip: string, cidr: string): boolean {
    // Parse CIDR notation
    const [rangeIp, maskBits] = cidr.split('/');
    if (!rangeIp || !maskBits) return false;

    // Convert IPs to binary
    const ipBinary = this.ipToBinary(ip);
    const rangeBinary = this.ipToBinary(rangeIp);

    if (!ipBinary || !rangeBinary) return false;

    // Compare the first maskBits
    const mask = Number.parseInt(maskBits);
    return ipBinary.slice(0, Math.max(0, mask)) === rangeBinary.slice(0, Math.max(0, mask));
  }

  private ipToBinary(ip: string): string | null {
    const parts = ip.split('.');
    if (parts.length !== 4) return null;

    return parts
      .map((part) => {
        const num = Number.parseInt(part);
        if (isNaN(num) || num < 0 || num > 255) return null;
        return num.toString(2).padStart(8, '0');
      })
      .join('');
  }

  private validateTimestamp(timestamp: string): boolean {
    const webhookTime = Number.parseInt(timestamp) * 1000;
    if (isNaN(webhookTime)) return false;

    const now = Date.now();
    const age = Math.abs(now - webhookTime);

    // Timestamp should be within the allowed window
    return age <= this.maxTimestampAge;
  }

  private isReplayAttack(requestId: string): boolean {
    return this.replayCache.has(requestId);
  }

  private generateRequestId(payload: string | Buffer, timestamp: string): string {
    const content = typeof payload === 'string' ? payload : payload.toString();
    return crypto.createHash('sha256').update(`${content}:${timestamp}`).digest('hex');
  }

  private sanitizePayload(payload: string | Buffer): unknown {
    const content = typeof payload === 'string' ? payload : payload.toString();

    // Remove potentially dangerous characters and validate JSON
    const sanitized = content.replaceAll(/[\u0000-\u0008\v\f\u000E-\u001F\u007F]/g, '');

    try {
      const parsed = JSON.parse(sanitized);
      // Additional sanitization could be added here
      // For example, removing any script tags or SQL injection attempts
      return this.deepSanitize(parsed);
    } catch (error) {
      throw new WebhookSecurityError('Invalid JSON payload', 'INVALID_PAYLOAD', {
        error: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  }

  private deepSanitize(obj: any): any {
    if (typeof obj === 'string') {
      // Remove any potentially harmful strings
      return obj
        .replaceAll(/<script[^>]*>.*?<\/script>/gi, '')
        .replaceAll(/javascript:/gi, '')
        .replaceAll(/on\w+\s*=/gi, '');
    }

    if (Array.isArray(obj)) {
      return obj.map((item) => this.deepSanitize(item));
    }

    if (obj !== null && typeof obj === 'object') {
      const sanitized: any = {};
      for (const [key, value] of Object.entries(obj)) {
        // Skip keys that look suspicious
        if (!/^[\w-]+$/.test(key)) {
          continue;
        }
        sanitized[key] = this.deepSanitize(value);
      }
      return sanitized;
    }

    return obj;
  }

  // Cleanup old replay cache entries
  private cleanupReplayCache(): void {
    const cutoff = Date.now() - this.maxTimestampAge;
    for (const [id, timestamp] of this.replayCache) {
      if (timestamp < cutoff) {
        this.replayCache.delete(id);
      }
    }
  }

  private startCleanupInterval(): void {
    // Clean up every minute
    setInterval(() => {
      this.cleanupReplayCache();
    }, 60 * 1000);
  }

  /**
   * Verify webhook event authenticity with provider
   */
  async verifyWithProvider(
    provider: PaymentProviderType,
    _eventId: string,
  ): Promise<boolean> {
    // This would make an API call to the provider to verify the event
    // For example, Stripe allows fetching events by ID to verify they're real
    // This is an additional layer of security for critical operations
    switch (provider) {
      case 'stripe': {
        // Would use Stripe API to fetch and verify event
        return true;
      } // Simplified
      case 'razorpay': {
        // Would use Razorpay API to verify
        return true;
      } // Simplified
      default: {
        return false;
      }
    }
  }

  /**
   * Rate limiting for webhook endpoints
   */
  async checkRateLimit(sourceIp: string, provider: PaymentProviderType): Promise<boolean> {
    const key = `webhook:ratelimit:${provider}:${sourceIp}`;
    // Window: 1 minute, maxRequests: 100 requests per minute per IP
    const maxRequests = 100;

    // This would use a proper rate limiting service
    // For now, using a simple in-memory counter
    const count = this.getRateLimitCount(key);

    if (count >= maxRequests) {
      return false;
    }

    this.incrementRateLimitCount(key);
    return true;
  }

  private rateLimitCounts = new Map<string, { count: number; resetTime: number }>();

  private getRateLimitCount(key: string): number {
    const now = Date.now();
    const entry = this.rateLimitCounts.get(key);

    if (!entry || entry.resetTime < now) {
      return 0;
    }

    return entry.count;
  }

  private incrementRateLimitCount(key: string): void {
    const now = Date.now();
    const window = 60 * 1000;
    const entry = this.rateLimitCounts.get(key);

    if (!entry || entry.resetTime < now) {
      this.rateLimitCounts.set(key, {
        count: 1,
        resetTime: now + window,
      });
    } else {
      entry.count++;
    }
  }

  /**
   * Log security events for audit trail
   */
  async logSecurityEvent(event: {
    type: WebhookSecurityErrorCode | 'SUCCESS';
    provider: PaymentProviderType;
    sourceIp: string;
    timestamp: Instant;
    details?: Record<string, unknown>;
  }): Promise<void> {
    // This would log to a security audit trail
    // Could use a logging service or database
    console.log('[WEBHOOK SECURITY]', JSON.stringify(event));
  }

  /**
   * Get security metrics for monitoring
   */
  getSecurityMetrics(): {
    replayCacheSize: number;
    rateLimitedIps: number;
    activeProviders: number;
  } {
    return {
      replayCacheSize: this.replayCache.size,
      rateLimitedIps: this.rateLimitCounts.size,
      activeProviders: this.signatureVerifiers.size,
    };
  }
}

// Factory function
export function createWebhookSecurityService() {
  return new WebhookSecurityService();
}
