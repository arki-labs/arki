import { cloudflareEmailServiceProvider } from '../providers/cloudflare-email-service';
import { kvQuotaStore } from '../providers/quota-store-kv';
import type { KVLike } from '../providers/quota-store-kv';
import { resendProvider } from '../providers/resend';
import { sesProvider } from '../providers/ses';
import type { EmailProvider } from '../providers/types';
import { unosendProvider } from '../providers/unosend';

import { initEmails } from './init';
import type { EmailClient } from './init';

/** Default monthly send quota for Resend free-tier accounts. */
export const RESEND_FREE_QUOTA = 3_000;

/** Default monthly send quota for Unosend entry Pro accounts. */
export const UNOSEND_PRO_QUOTA = 6_000;

/**
 * Default monthly send quota for Cloudflare Email Service on Workers Paid plan.
 * 3 000 emails/month included; $0.35 per 1 000 emails overage.
 *
 * **Beta status (2026-05-28):** Cloudflare Email Service is currently in beta.
 * Pricing and features may change before GA.
 */
export const CLOUDFLARE_EMAIL_SERVICE_FREE_QUOTA = 3_000;

/**
 * Create an email client that automatically detects providers from environment
 * variables — no manual provider wiring required.
 *
 * **Supported environment variables (auto-detected):**
 * - `RESEND_API_KEY` — adds Resend (3 000/mo on free tier)
 * - `UNOSEND_API_KEY` — adds Unosend (60 000/mo on Pro tier)
 * - `AWS_SES_REGION` + AWS credentials — adds Amazon SES (pay-as-you-go)
 * - `CLOUDFLARE_ACCOUNT_ID` + `CLOUDFLARE_EMAIL_API_TOKEN` — adds Cloudflare Email
 *   Service (3 000/mo free on Workers Paid plan, beta)
 *
 * When multiple providers are configured the quota router fails over in this
 * order: Resend → Unosend → Cloudflare Email Service → SES. Cheaper free-tier
 * providers are tried first; SES (pay-as-you-go, no monthly cap) is the
 * unlimited fallback so delivery is never silently skipped.
 *
 * Cloudflare Email Service is opt-in only — it does NOT inherit credentials
 * from the broader Cloudflare env (e.g. `CLOUDFLARE_API_TOKEN` is intentionally
 * not used) because Email Service is in beta and apps should explicitly opt in
 * via a dedicated token with `Email Service: Edit` permission.
 *
 * **Overrides** let apps supply their own values instead of relying on
 * `process.env` — useful when using a typed env schema like `@t3-oss/env-core`.
 *
 * @example
 * ```ts
 * // Reads RESEND_API_KEY / UNOSEND_API_KEY / AWS_SES_REGION / CLOUDFLARE_* from
 * // process.env automatically.
 * export const emailClient = createEmailClientFromEnv();
 *
 * // Or pass explicit keys from a typed env.
 * export const emailClient = createEmailClientFromEnv({
 *   resendApiKey: env.RESEND_API_KEY,
 *   unosendApiKey: env.UNOSEND_API_KEY,
 *   sesRegion: env.AWS_SES_REGION,
 *   cloudflareAccountId: env.CLOUDFLARE_ACCOUNT_ID,
 *   cloudflareEmailApiToken: env.CLOUDFLARE_EMAIL_API_TOKEN,
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
   * AWS region for SES. Falls back to `process.env.AWS_SES_REGION` then
   * `process.env.AWS_REGION`. SES is only enabled when a region is resolved
   * AND AWS credentials are available (via env, SDK default chain, or
   * explicit `sesCredentials`).
   */
  sesRegion?: string;
  /**
   * Explicit AWS credentials for SES. Omit to use the SDK's default chain
   * (env vars `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY`, shared config, IMDS).
   */
  sesCredentials?: {
    accessKeyId: string;
    secretAccessKey: string;
    sessionToken?: string;
  };
  /**
   * Monthly SES send quota cap. SES is pay-as-you-go with no inherent monthly
   * cap; omit to mark unlimited (always eligible as the router's fallback).
   * Set a value to bound spend.
   */
  sesQuota?: number;
  /** Optional SES Configuration Set name for reputation tracking. */
  sesConfigurationSetName?: string;
  /**
   * Cloudflare account ID for Email Service. Falls back to
   * `process.env.CLOUDFLARE_ACCOUNT_ID`.
   */
  cloudflareAccountId?: string;
  /**
   * Cloudflare API token with `Email Service: Edit` permission. Falls back to
   * `process.env.CLOUDFLARE_EMAIL_API_TOKEN`. **Not** read from the generic
   * `CLOUDFLARE_API_TOKEN` — Email Service is in beta and requires explicit
   * opt-in.
   */
  cloudflareEmailApiToken?: string;
  /**
   * Monthly Cloudflare Email Service quota. Defaults to
   * {@link CLOUDFLARE_EMAIL_SERVICE_FREE_QUOTA} (3 000) — the Workers Paid
   * plan's included allowance. Raise this if you've prepaid additional volume.
   */
  cloudflareEmailQuota?: number;
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
   * Only used when multiple providers are configured (single-provider setups
   * have no router and no quota counter).
   *
   * @example
   * ```ts
   * import { kv } from './kv';
   *
   * export const emailClient = createEmailClientFromEnv({ kv });
   * ```
   */
  kv?: KVLike;
}): EmailClient {
  const resendKey = overrides?.resendApiKey ?? process.env['RESEND_API_KEY'];
  const unosendKey = overrides?.unosendApiKey ?? process.env['UNOSEND_API_KEY'];
  const sesRegion =
    overrides?.sesRegion ??
    process.env['AWS_SES_REGION'] ??
    process.env['AWS_REGION'];
  const cfAccountId =
    overrides?.cloudflareAccountId ?? process.env['CLOUDFLARE_ACCOUNT_ID'];
  const cfApiToken =
    overrides?.cloudflareEmailApiToken ?? process.env['CLOUDFLARE_EMAIL_API_TOKEN'];

  const providers: EmailProvider[] = [];

  // Order matters — quotaRouter walks the chain front-to-back, picking the first
  // provider with remaining quota. Free tiers first, paid second, beta last,
  // pay-as-you-go SES at the end so delivery is never silently skipped.

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

  if (cfAccountId && cfApiToken) {
    providers.push(
      cloudflareEmailServiceProvider({
        accountId: cfAccountId,
        apiToken: cfApiToken,
        quotaPerMonth:
          overrides?.cloudflareEmailQuota ?? CLOUDFLARE_EMAIL_SERVICE_FREE_QUOTA,
      }),
    );
  }

  if (sesRegion) {
    providers.push(
      sesProvider({
        region: sesRegion,
        ...(overrides?.sesCredentials ? { credentials: overrides.sesCredentials } : {}),
        ...(overrides?.sesConfigurationSetName
          ? { configurationSetName: overrides.sesConfigurationSetName }
          : {}),
        ...(overrides?.sesQuota !== undefined ? { quotaPerMonth: overrides.sesQuota } : {}),
      }),
    );
  }

  if (providers.length === 0) {
    throw new Error(
      '[arki/emails] createEmailClientFromEnv: no provider configured. ' +
        'Set at least one of: RESEND_API_KEY, UNOSEND_API_KEY, AWS_SES_REGION (with credentials), ' +
        'CLOUDFLARE_ACCOUNT_ID + CLOUDFLARE_EMAIL_API_TOKEN — or pass explicit keys via overrides.',
    );
  }

  const store = overrides?.kv ? kvQuotaStore(overrides.kv) : undefined;

  return initEmails({ providers, isDev: overrides?.isDev, store });
}
