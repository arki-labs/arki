import { kvQuotaStore } from '../providers/quota-store-kv';
import type { KVLike } from '../providers/quota-store-kv';
import { resendProvider } from '../providers/resend';
import { unosendProvider } from '../providers/unosend';
import type { EmailProvider } from '../providers/types';

import { initEmails } from './init';
import type { EmailClient } from './init';

/** Default monthly send quota for Resend free-tier accounts. */
export const RESEND_FREE_QUOTA = 3_000;

/** Default monthly send quota for Unosend entry Pro accounts. */
export const UNOSEND_PRO_QUOTA = 6_000;

/**
 * Create an email client that automatically detects providers from environment
 * variables — no manual provider wiring required.
 *
 * **Supported environment variables:**
 * - `RESEND_API_KEY` — adds Resend (3 000/mo on free tier)
 * - `UNOSEND_API_KEY` — adds Unosend (60 000/mo on Pro tier)
 *
 * When both keys are present a quota router is set up automatically: Resend
 * handles sends until its monthly quota is reached, then Unosend takes over.
 *
 * **Overrides** let apps supply their own values instead of relying on
 * `process.env` — useful when using a typed env schema like `@t3-oss/env-core`.
 *
 * @example
 * ```ts
 * // Reads RESEND_API_KEY / UNOSEND_API_KEY from process.env automatically
 * export const emailClient = createEmailClientFromEnv();
 *
 * // Or pass explicit keys from a typed env
 * export const emailClient = createEmailClientFromEnv({
 *   resendApiKey: env.RESEND_API_KEY,
 *   unosendApiKey: env.UNOSEND_API_KEY,
 * });
 * ```
 *
 * @throws If no provider key is found (neither in env nor in overrides).
 */
export function createEmailClientFromEnv(overrides?: {
  /** Explicit Resend API key; falls back to `process.env.RESEND_API_KEY`. */
  resendApiKey?: string;
  /**
   * Monthly Resend send quota. Defaults to {@link RESEND_FREE_QUOTA} (3 000).
   * Raise this if your account is on a paid plan.
   */
  resendQuota?: number;
  /** Explicit Unosend API key; falls back to `process.env.UNOSEND_API_KEY`. */
  unosendApiKey?: string;
  /**
   * Monthly Unosend send quota. Defaults to {@link UNOSEND_PRO_QUOTA} (6 000).
   * Raise this if your account is on a higher tier.
   */
  unosendQuota?: number;
  /**
   * Override dev-mode detection.
   * Defaults to `process.env.NODE_ENV === 'development'`.
   */
  isDev?: boolean;
  /**
   * A KV store instance used to persist quota counters across replicas.
   *
   * When provided, the quota router uses a {@link kvQuotaStore} backed by this
   * KV instance instead of the default in-memory store. Required for
   * multi-instance deployments where each replica would otherwise track
   * sends independently.
   *
   * Only used when both `RESEND_API_KEY` and `UNOSEND_API_KEY` are present
   * (single-provider setups have no router and no quota counter).
   *
   * @example
   * ```ts
   * import { kv } from '@avocabo/backend/core/kv';
   *
   * export const emailClient = createEmailClientFromEnv({ kv });
   * ```
   */
  kv?: KVLike;
}): EmailClient {
  const resendKey = overrides?.resendApiKey ?? process.env['RESEND_API_KEY'];
  const unosendKey = overrides?.unosendApiKey ?? process.env['UNOSEND_API_KEY'];

  const providers: EmailProvider[] = [];

  if (resendKey) {
    providers.push(
      resendProvider({
        apiKey: resendKey,
        quotaPerMonth: overrides?.resendQuota ?? RESEND_FREE_QUOTA,
      }),
    );
  }

  if (unosendKey) {
    providers.push(
      unosendProvider({
        apiKey: unosendKey,
        quotaPerMonth: overrides?.unosendQuota ?? UNOSEND_PRO_QUOTA,
      }),
    );
  }

  if (providers.length === 0) {
    throw new Error(
      '[arki/emails] createEmailClientFromEnv: no provider configured. ' +
        'Set RESEND_API_KEY and/or UNOSEND_API_KEY, or pass explicit keys via overrides.',
    );
  }

  const store = overrides?.kv ? kvQuotaStore(overrides.kv) : undefined;

  return initEmails({ providers, isDev: overrides?.isDev, store });
}
