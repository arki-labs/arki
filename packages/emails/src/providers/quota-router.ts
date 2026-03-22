import { debugEmails } from '../debug';

import type { EmailProvider, SendEmailPayload, SendEmailResult } from './types';

type ProviderUsage = {
  /** YYYY-M key so it resets each calendar month automatically. */
  month: string;
  sent: number;
};

function currentMonthKey(): string {
  const d = new Date();
  return `${d.getUTCFullYear()}-${d.getUTCMonth()}`;
}

/**
 * Wraps multiple providers and routes each send to whichever provider still
 * has quota remaining for the current calendar month.
 *
 * - Providers are tried in the order they were registered.
 * - A provider with no `quotaPerMonth` is treated as unlimited and always
 *   eligible (useful as a fallback).
 * - If all providers are exhausted, the last provider is used anyway so
 *   delivery is never silently skipped (fail-open strategy).
 * - Usage counters are in-memory. For multi-process or multi-instance
 *   deployments, wire a Redis-backed counter by replacing the `usage` map
 *   with a distributed store.
 *
 * @example
 * ```ts
 * const router = quotaRouter([
 *   resendProvider({ apiKey: env.RESEND_API_KEY, quotaPerMonth: 3_000 }),
 *   unosendProvider({ apiKey: env.UNOSEND_API_KEY, quotaPerMonth: 6_000 }),
 * ]);
 * ```
 */
export function quotaRouter(providers: EmailProvider[]): EmailProvider {
  if (providers.length === 0) {
    throw new Error('[arki/emails] quotaRouter requires at least one provider');
  }

  const usage = new Map<string, ProviderUsage>();

  function getSent(name: string): number {
    const entry = usage.get(name);
    if (!entry || entry.month !== currentMonthKey()) return 0;
    return entry.sent;
  }

  function incrementSent(name: string): void {
    const month = currentMonthKey();
    const prev = usage.get(name);
    if (!prev || prev.month !== month) {
      usage.set(name, { month, sent: 1 });
    } else {
      usage.set(name, { month, sent: prev.sent + 1 });
    }
  }

  function selectProvider(): EmailProvider {
    for (const provider of providers) {
      const quota = provider.quotaPerMonth;
      const sent = getSent(provider.name);

      if (quota === undefined || sent < quota) {
        debugEmails(
          '[quota-router] Selected provider=%s (sent=%d, quota=%s)',
          provider.name,
          sent,
          quota ?? 'unlimited',
        );
        return provider;
      }

      debugEmails(
        '[quota-router] Provider=%s quota exhausted (sent=%d/%d) — skipping',
        provider.name,
        sent,
        quota,
      );
    }

    // All quotas exhausted — fall back to the last provider rather than failing
    const fallback = providers[providers.length - 1]!;
    debugEmails(
      '[quota-router] All quotas exhausted — using fallback provider=%s',
      fallback.name,
    );
    return fallback;
  }

  return {
    name: 'quota-router',

    async send(payload: SendEmailPayload): Promise<SendEmailResult> {
      const provider = selectProvider();
      const result = await provider.send(payload);

      if (!result.error) {
        incrementSent(provider.name);
      }

      return result;
    },
  };
}
