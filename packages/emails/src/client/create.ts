import { z } from 'zod';

import type { KVLike } from '../providers/quota-store-kv';
import type { EmailProvider } from '../providers/types';
import type { EmailClient } from './init';
import { cloudflareEmailServiceProvider } from '../providers/cloudflare-email-service';
import { kvQuotaStore } from '../providers/quota-store-kv';
import { resendProvider } from '../providers/resend';
import { sesProvider } from '../providers/ses';
import { unosendProvider } from '../providers/unosend';
import { initEmails } from './init';

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

const quota = z.number().int().positive();
const secret = z.string().min(1);

const kvSchema = z.custom<KVLike>(
  value =>
    typeof value === 'object' &&
    value !== null &&
    'get' in value &&
    typeof value.get === 'function' &&
    'set' in value &&
    typeof value.set === 'function',
  { message: 'kv must provide get() and set()' },
);

/**
 * Explicit configuration for {@link createEmailClient}. The library never reads
 * `process.env`: the app reads its own env and passes the values in.
 */
export const EmailClientConfigSchema = z
  .object({
    /** When true, emails are logged but NOT delivered. Always explicit. */
    isDev: z.boolean(),
    /** Resend. Quota defaults to {@link RESEND_FREE_QUOTA}. */
    resend: z.object({ apiKey: secret, quotaPerMonth: quota.optional() }).optional(),
    /** Unosend. Quota defaults to {@link UNOSEND_PRO_QUOTA}. */
    unosend: z.object({ apiKey: secret, quotaPerMonth: quota.optional() }).optional(),
    /** Cloudflare Email Service (beta). Quota defaults to {@link CLOUDFLARE_EMAIL_SERVICE_FREE_QUOTA}. */
    cloudflare: z.object({ accountId: secret, apiToken: secret, quotaPerMonth: quota.optional() }).optional(),
    /**
     * Amazon SES. Omit `credentials` to use the AWS SDK default chain.
     * Omit `quotaPerMonth` for unlimited (always eligible as the fallback).
     */
    ses: z
      .object({
        region: secret,
        credentials: z
          .object({ accessKeyId: secret, secretAccessKey: secret, sessionToken: z.string().min(1).optional() })
          .optional(),
        configurationSetName: z.string().min(1).optional(),
        quotaPerMonth: quota.optional(),
      })
      .optional(),
    /** KV store that persists quota counters across replicas (only used with 2+ providers). */
    kv: kvSchema.optional(),
  })
  .refine(config => config.resend || config.unosend || config.cloudflare || config.ses, {
    message: 'configure at least one provider: resend, unosend, cloudflare or ses',
  });

export type EmailClientConfig = z.input<typeof EmailClientConfigSchema>;

/**
 * Build an email client from an explicit config object.
 *
 * When several providers are configured the quota router fails over in this
 * order: Resend, Unosend, Cloudflare Email Service, SES. Free tiers go first;
 * SES (pay-as-you-go, no monthly cap) is the fallback so delivery is never
 * silently skipped.
 *
 * @example
 * ```ts
 * export const emailClient = createEmailClient({
 *   isDev: env.NODE_ENV === 'development',
 *   resend: { apiKey: env.RESEND_API_KEY },
 *   unosend: { apiKey: env.UNOSEND_API_KEY, quotaPerMonth: 60_000 },
 * });
 * ```
 *
 * @throws If the config is invalid or no provider is configured.
 */
export function createEmailClient(config: EmailClientConfig): EmailClient {
  const parsed = EmailClientConfigSchema.safeParse(config);
  if (!parsed.success) {
    throw new Error(`[arki/emails] createEmailClient: invalid config.\n${z.prettifyError(parsed.error)}`);
  }
  const { isDev, resend, unosend, cloudflare, ses, kv } = parsed.data;

  const providers: EmailProvider[] = [];

  if (resend) {
    providers.push(resendProvider({ apiKey: resend.apiKey, quotaPerMonth: resend.quotaPerMonth ?? RESEND_FREE_QUOTA }));
  }
  if (unosend) {
    providers.push(
      unosendProvider({ apiKey: unosend.apiKey, quotaPerMonth: unosend.quotaPerMonth ?? UNOSEND_PRO_QUOTA }),
    );
  }
  if (cloudflare) {
    providers.push(
      cloudflareEmailServiceProvider({
        accountId: cloudflare.accountId,
        apiToken: cloudflare.apiToken,
        quotaPerMonth: cloudflare.quotaPerMonth ?? CLOUDFLARE_EMAIL_SERVICE_FREE_QUOTA,
      }),
    );
  }
  if (ses) {
    providers.push(
      sesProvider({
        region: ses.region,
        ...(ses.credentials ? { credentials: ses.credentials } : {}),
        ...(ses.configurationSetName ? { configurationSetName: ses.configurationSetName } : {}),
        ...(ses.quotaPerMonth !== undefined ? { quotaPerMonth: ses.quotaPerMonth } : {}),
      }),
    );
  }

  return initEmails({ providers, isDev, ...(kv ? { store: kvQuotaStore(kv) } : {}) });
}
