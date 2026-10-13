import { defineEnv } from '@arki/env/core';

import { z } from '@arki/contracts';

/**
 * Optional Stripe credential: deployment platforms (Coolify, Vercel, …) often store an unset
 * variable as `""` rather than omitting it, and Zod's `.optional()` only skips `undefined`. This
 * normalises `""` → undefined, then validates the expected key prefix when a value IS present.
 */
const optionalStripeKey = (prefix: string) =>
  z.preprocess(
    val => (val === '' ? undefined : val),
    z.string().startsWith(prefix).optional(),
  );

/**
 * Environment contract for `@arki/payments` (Stripe).
 *
 * Compose this into a consuming app's env via `createEnv({ extends: [paymentsEnv], … })` so every
 * app that ships billing declares the same Stripe variables in one place. Only **provider
 * credentials** live here — app-specific configuration (e.g. which Stripe Price ID is "Pro")
 * belongs in the consuming app's own env, not the shared package.
 */
export const env = defineEnv({
  name: '@arki/payments',
  server: {
    /**
     * Stripe secret API key — `sk_test_…` in test mode, `sk_live_…` in production (restricted
     * `rk_…` keys are also accepted). Required: the provider cannot talk to Stripe without it.
     */
    STRIPE_SECRET_KEY: z
      .string()
      .regex(/^(sk|rk)_(test|live)_/, 'must be a Stripe secret or restricted key (sk_… / rk_…)'),
    /**
     * Stripe webhook signing secret (`whsec_…`), copied from the webhook endpoint you create in
     * the Stripe dashboard. Optional until that endpoint exists — but the subscription projection
     * cannot verify `customer.subscription.*` events without it, so it's required to go live.
     */
    STRIPE_WEBHOOK_SECRET: optionalStripeKey('whsec_'),
    /**
     * Stripe publishable key (`pk_…`). Client-side only — the hosted Checkout flow the preset uses
     * does NOT need it server-side. Declared here so the full Stripe credential set lives in one
     * contract; expose it to the browser via the app's own client env (e.g. `VITE_…`) only if you
     * later adopt Stripe Elements.
     */
    STRIPE_PUBLISHABLE_KEY: optionalStripeKey('pk_'),
  },
  client: {},
  clientPrefix: '',
  options: {
    skipValidation:
      !!process.env['CI'] ||
      process.env['NODE_ENV'] === 'test' ||
      process.env['npm_lifecycle_event'] === 'lint',
  },
});
