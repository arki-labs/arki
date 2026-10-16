import type { QuotaStore } from './quota-store';
import type { EmailProvider, SendEmailPayload, SendEmailResult } from './types';
import { debugEmails } from '../debug';
import { inMemoryQuotaStore } from './quota-store';

export type { QuotaStore };

function currentMonthKey(): string {
  const d = new Date();
  return `${d.getUTCFullYear()}-${d.getUTCMonth()}`;
}

/**
 * De-duplicate provider names so quota counters never collide.
 *
 * If two providers share the same `name` (e.g. two `resendProvider()` calls
 * with different API keys), the second is suffixed `-2`, the third `-3`, etc.
 *
 * @returns A parallel array of unique names for each provider, in the same order.
 */
function deduplicateNames(providers: EmailProvider[]): string[] {
  const seen = new Map<string, number>();
  return providers.map(p => {
    const count = (seen.get(p.name) ?? 0) + 1;
    seen.set(p.name, count);
    return count === 1 ? p.name : `${p.name}-${count}`;
  });
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
 * - Duplicate provider names are auto-suffixed (`resend`, `resend-2`, …) so
 *   their quota counters never collide.
 * - Supply a `store` option to use a distributed quota counter instead of the
 *   default in-memory Map — required for multi-instance deployments.
 *
 * @example
 * ```ts
 * const router = quotaRouter([
 *   resendProvider({ apiKey: env.RESEND_API_KEY, quotaPerMonth: 3_000 }),
 *   unosendProvider({ apiKey: env.UNOSEND_API_KEY, quotaPerMonth: 6_000 }),
 * ]);
 *
 * // With a custom distributed store:
 * const router = quotaRouter([...providers], { store: kvQuotaStore(redisClient) });
 * ```
 */
export function quotaRouter(providers: EmailProvider[], options?: { store?: QuotaStore }): EmailProvider {
  if (providers.length === 0) {
    throw new Error('[arki/mail] quotaRouter requires at least one provider');
  }

  const store: QuotaStore = options?.store ?? inMemoryQuotaStore();
  const names = deduplicateNames(providers);

  async function selectProvider(): Promise<{ provider: EmailProvider; resolvedName: string }> {
    const month = currentMonthKey();

    for (let i = 0; i < providers.length; i++) {
      const provider = providers[i]!;
      const name = names[i]!;
      const quota = provider.quotaPerMonth;
      const sent = await store.getSent(name, month);

      if (quota === undefined || sent < quota) {
        debugEmails.debug('[quota-router] Selected provider={provider} (sent={sent}, quota={quota})', {
          provider: name,
          sent,
          quota: quota ?? 'unlimited',
        });
        return { provider, resolvedName: name };
      }

      debugEmails.debug('[quota-router] Provider={Provider} quota exhausted (sent={sent}/{quota}) — skipping', {
        Provider: name,
        sent,
        quota,
      });
    }

    // All quotas exhausted — fall through to last provider (fail-open)
    const fallbackIdx = providers.length - 1;
    const fallback = providers[fallbackIdx]!;
    const fallbackName = names[fallbackIdx]!;
    debugEmails.debug('[quota-router] All quotas exhausted — using fallback provider={provider}', {
      provider: fallbackName,
    });
    return { provider: fallback, resolvedName: fallbackName };
  }

  return {
    name: 'quota-router',

    async send(payload: SendEmailPayload): Promise<SendEmailResult> {
      const { provider, resolvedName } = await selectProvider();
      const result = await provider.send(payload);

      if (!result.error) {
        await store.increment(resolvedName, currentMonthKey());
      }

      return result;
    },
  };
}
