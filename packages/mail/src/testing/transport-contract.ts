/**
 * The promises every `MailTransport` keeps, as one vitest suite. Failover and the journal runner
 * decide what to do from the failure's kind and `retryable`; a transport that maps a failure
 * differently would make them resend a delivered mail or drop a mail that could still go out.
 *
 * Run it once per transport, with a harness that fakes the service (an injected `fetch`, a mocked
 * SDK) and drives the transport's real code.
 */
import { beforeEach, describe, expect, it } from 'vitest';

import { isFailure, orThrow } from '@arki/failure';

import type { MailMessage, MailTransport } from '../types.js';
import { MAIL_ERROR_CODES } from '../errors.js';
import { MailRejected, MailUncertain } from '../failures.js';

export type TransportHarness = {
  /** Name for the describe block. */
  readonly label: string;
  /** The `id` the factory gives when none is passed. */
  readonly defaultId: string;
  /** Builds the transport under test, wired to the fake service. */
  create(options?: { readonly quotaPerMonth?: number }): MailTransport;
  /** The message id the fake service returns on success, or `null` when the service gives none. */
  readonly expectedId: string | null;
  /** The next request succeeds. */
  succeed(): void;
  /** The next request is answered with this HTTP status and the service's error body. */
  respondWith(status: number): void;
  /** The next request fails in transit with this message. */
  failInTransit(message: string): void;
  /** Requests the fake service received since `reset`. */
  requestCount(): number;
  /** The idempotency key the last request carried. Omit when the service takes none. */
  readonly lastIdempotencyKey?: () => string | undefined;
  /** The abort signal the last request carried, if any. */
  lastSignal(): AbortSignal | undefined;
  /** Message fields this transport cannot carry. Omit when it carries them all. */
  readonly unsupported?: Partial<Pick<MailMessage, 'tags' | 'replyTo'>>;
  /** Clears the fake service between tests. */
  reset(): void;
};

const message: MailMessage = {
  from: 'App <no-reply@example.com>',
  to: ['reader@example.com', 'second@example.com'],
  subject: 'Hello',
  text: 'hi',
  html: '<p>hi</p>',
};

/** Defines the shared transport suite for one harness. Call it at the top level of a spec file. */
export function transportContract(harness: TransportHarness): void {
  describe(`transport contract: ${harness.label}`, () => {
    beforeEach(() => {
      harness.reset();
    });

    it('is named after its factory unless given an id, and reports its quota', () => {
      expect(harness.create().id).toBe(harness.defaultId);
      expect(harness.create({ quotaPerMonth: 7 }).quotaPerMonth).toBe(7);
      expect(harness.create().quotaPerMonth).toBeUndefined();
    });

    it("success: returns the service's own id (or null) and every recipient", async () => {
      harness.succeed();
      const result = await harness.create().send(message, {});
      if (isFailure(result)) throw new Error(`expected a sent mail, got ${result.code}`);
      expect(result.id).toBe(harness.expectedId);
      expect(result.transport).toBe(harness.defaultId);
      expect(result.status).toBe('accepted');
      expect(result.recipients.map(recipient => recipient.address)).toEqual(
        expect.arrayContaining(['reader@example.com', 'second@example.com']),
      );
      expect(harness.requestCount()).toBe(1);
    });

    it('429: rejected and retryable, so failover may try the next transport', async () => {
      harness.respondWith(429);
      const result = await harness.create().send(message, {});
      expect(MailRejected.is(result)).toBe(true);
      expect(result).toMatchObject({
        data: { retryable: true, upstreamStatus: 429, transport: harness.defaultId },
      });
    });

    it('5xx: rejected and retryable', async () => {
      harness.respondWith(503);
      const result = await harness.create().send(message, {});
      expect(MailRejected.is(result)).toBe(true);
      expect(result).toMatchObject({ data: { retryable: true, upstreamStatus: 503 } });
    });

    it('400: rejected and permanent, so the same mail is not tried again', async () => {
      harness.respondWith(400);
      const result = await harness.create().send(message, {});
      expect(MailRejected.is(result)).toBe(true);
      expect(result).toMatchObject({ data: { retryable: false, upstreamStatus: 400 } });
    });

    it('network failure: never throws; uncertain, because the service may have taken the mail', async () => {
      harness.failInTransit('socket hang up');
      const result = await harness.create().send(message, {});
      expect(MailUncertain.is(result)).toBe(true);
      expect(result).toMatchObject({ data: { transport: harness.defaultId } });
      expect(isFailure(result) ? result.message : '').toContain('socket hang up');
    });

    it.skipIf(harness.unsupported === undefined)('a field it cannot carry: throws E005, no request made', async () => {
      await expect(harness.create().send({ ...message, ...harness.unsupported }, {})).rejects.toMatchObject({
        code: MAIL_ERROR_CODES.unsupported,
      });
      expect(harness.requestCount()).toBe(0);
    });

    it.runIf(harness.lastIdempotencyKey !== undefined)('forwards the idempotency key to the service', async () => {
      harness.succeed();
      await orThrow(harness.create().send(message, { idempotencyKey: 'job_123' }));
      expect(harness.lastIdempotencyKey?.()).toBe('job_123');
    });

    it('passes the abort signal to the request', async () => {
      harness.succeed();
      const controller = new AbortController();
      await orThrow(harness.create().send(message, { signal: controller.signal }));
      expect(harness.lastSignal()).toBe(controller.signal);
    });
  });
}
