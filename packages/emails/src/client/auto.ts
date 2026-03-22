import { resendProvider } from '../providers/resend';
import { unosendProvider } from '../providers/unosend';
import type { EmailProvider } from '../providers/types';

import { initEmails } from './init';
import type { EmailClient } from './init';

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
   * Monthly Resend send quota. Defaults to 3 000 (free tier).
   * Raise this if your account is on a paid plan.
   */
  resendQuota?: number;
  /** Explicit Unosend API key; falls back to `process.env.UNOSEND_API_KEY`. */
  unosendApiKey?: string;
  /**
   * Monthly Unosend send quota. Defaults to 6 000 (entry Pro plan).
   * Raise this if your account is on a higher tier.
   */
  unosendQuota?: number;
  /**
   * Override dev-mode detection.
   * Defaults to `process.env.NODE_ENV === 'development'`.
   */
  isDev?: boolean;
}): EmailClient {
  const resendKey = overrides?.resendApiKey ?? process.env['RESEND_API_KEY'];
  const unosendKey = overrides?.unosendApiKey ?? process.env['UNOSEND_API_KEY'];

  const providers: EmailProvider[] = [];

  if (resendKey) {
    providers.push(
      resendProvider({
        apiKey: resendKey,
        quotaPerMonth: overrides?.resendQuota ?? 3_000,
      }),
    );
  }

  if (unosendKey) {
    providers.push(
      unosendProvider({
        apiKey: unosendKey,
        quotaPerMonth: overrides?.unosendQuota ?? 6_000,
      }),
    );
  }

  if (providers.length === 0) {
    throw new Error(
      '[arki/emails] createEmailClientFromEnv: no provider configured. ' +
        'Set RESEND_API_KEY and/or UNOSEND_API_KEY, or pass explicit keys via overrides.',
    );
  }

  return initEmails({ providers, isDev: overrides?.isDev });
}
