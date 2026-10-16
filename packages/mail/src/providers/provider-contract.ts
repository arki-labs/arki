import { describe, expect, it } from 'vitest';

import type { EmailProvider, SendEmailPayload } from './types';
import { quotaRouter } from './quota-router';

/**
 * How one provider plugs into the shared contract. Every method drives the
 * provider's real code path with only the HTTP layer (or SDK) mocked.
 */
export type ProviderHarness = {
  /** Display name used in the describe block. */
  label: string;
  /** Build the provider under test. `quotaPerMonth` is passed through when given. */
  create(options?: { quotaPerMonth?: number }): EmailProvider;
  /** The next send succeeds and the service assigns a message id. */
  mockSuccess(): void;
  /** The next send is rejected by the service with this message. */
  mockServiceError(message: string): void;
  /** The next send fails at the network layer. */
  mockNetworkFailure(message: string): void;
  /** The recipients the mocked service actually received on the last send. */
  receivedRecipients(): string[];
  /** Reset mocks between tests. */
  reset(): void;
};

const payload: SendEmailPayload = {
  to: ['reader@example.com', 'second@example.com'],
  from: 'App <no-reply@example.com>',
  subject: 'Hello',
  html: '<p>hi</p>',
  text: 'hi',
};

/**
 * One test suite every `EmailProvider` must pass: send shape, error mapping
 * and quota behaviour. Call it once per provider with a harness.
 */
export function runProviderContract(harness: ProviderHarness): void {
  describe(`provider contract: ${harness.label}`, () => {
    it('exposes a stable name', () => {
      expect(harness.create().name).toMatch(/^[a-z][a-z0-9-]*$/);
    });

    it('send shape: success returns { data: { id }, error: null } and delivers to every recipient', async () => {
      harness.reset();
      harness.mockSuccess();

      const result = await harness.create().send(payload);

      expect(result.error).toBeNull();
      expect(typeof result.data?.id).toBe('string');
      expect(result.data?.id.length).toBeGreaterThan(0);
      expect(harness.receivedRecipients()).toEqual(['reader@example.com', 'second@example.com']);
    });

    it('error mapping: a service rejection becomes { data: null, error } with the service message', async () => {
      harness.reset();
      harness.mockServiceError('mailbox unavailable');

      const result = await harness.create().send(payload);

      expect(result.data).toBeNull();
      expect(result.error?.message).toContain('mailbox unavailable');
      expect(result.error?.name.length).toBeGreaterThan(0);
    });

    it('error mapping: a network failure never throws and becomes { data: null, error }', async () => {
      harness.reset();
      harness.mockNetworkFailure('socket hang up');

      const result = await harness.create().send(payload);

      expect(result.data).toBeNull();
      expect(result.error?.message).toContain('socket hang up');
    });

    it('quota: reports quotaPerMonth so the router can use it', () => {
      expect(harness.create({ quotaPerMonth: 7 }).quotaPerMonth).toBe(7);
      expect(harness.create().quotaPerMonth).toBeUndefined();
    });

    it('quota: the router skips this provider once its monthly quota is used and fails over', async () => {
      harness.reset();
      const fallbackIds: string[] = [];
      const fallback: EmailProvider = {
        name: 'fallback',
        async send() {
          fallbackIds.push('sent');
          return { data: { id: 'fallback-1' }, error: null };
        },
      };
      const router = quotaRouter([harness.create({ quotaPerMonth: 1 }), fallback]);

      harness.mockSuccess();
      const first = await router.send(payload);
      const second = await router.send(payload);

      expect(first.data?.id).not.toBe('fallback-1');
      expect(second.data?.id).toBe('fallback-1');
      expect(fallbackIds).toHaveLength(1);
    });

    it('quota: a failed send does not use up quota', async () => {
      harness.reset();
      const fallback: EmailProvider = {
        name: 'fallback',
        async send() {
          return { data: { id: 'fallback-1' }, error: null };
        },
      };
      const router = quotaRouter([harness.create({ quotaPerMonth: 1 }), fallback]);

      harness.mockServiceError('rejected');
      const failed = await router.send(payload);
      harness.mockSuccess();
      const retried = await router.send(payload);

      expect(failed.error).not.toBeNull();
      expect(retried.data?.id).not.toBe('fallback-1');
    });
  });
}
