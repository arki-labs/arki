import Stripe from 'stripe';

import { z } from '@arki/contracts';
import { defineFailure } from '@arki/failure';

/**
 * The card or payment method was refused. Ask for another one. Returned, not thrown, by the
 * provider calls that charge or check a card. `providerCode` is the provider's own code, such as
 * Stripe's `card_declined` or `expired_card`; `declineCode` is the bank's reason when it gave one.
 *
 * @fix Ask the customer for another card or payment method. The same one is likely refused again.
 * @verify bun run test -- src/core/providers
 */
export const CardDeclined = defineFailure('payments.card_declined', {
  status: 402,
  data: z.object({ providerCode: z.string().optional(), declineCode: z.string().optional() }),
  message: ({ providerCode }) =>
    providerCode === undefined ? 'The card was declined' : `The card was declined (${providerCode})`,
  remediation: 'Ask the customer for another card or payment method; the same one is likely refused again.',
});

/**
 * The same idempotency key was used with different parameters. Returned by the calls that take an `idempotencyKey`.
 *
 * @fix Use a new idempotency key for a different request, or resend the first request unchanged.
 * @verify bun run test -- src/core/providers
 */
export const IdempotencyConflict = defineFailure('payments.idempotency_conflict', {
  status: 409,
  message: 'The idempotency key was already used with different parameters',
  remediation: 'Use a new idempotency key for a different request, or resend the first request unchanged.',
});

/**
 * A customer, plan, payment or subscription id has no row (`missing: 'row'`), or the row has no
 * provider id (`missing: 'provider_id'`, such as a plan without a Stripe price). Returned before any
 * provider request is made.
 *
 * @fix Check the id, or create the row with the provider first.
 * @verify bun run test -- src/core/providers
 */
export const ReferenceNotFound = defineFailure('payments.reference_not_found', {
  status: 404,
  data: z.object({
    kind: z.enum(['customer', 'plan', 'payment', 'subscription']),
    id: z.string(),
    missing: z.enum(['row', 'provider_id']),
  }),
  message: ({ kind, id, missing }) =>
    missing === 'row' ? `${kind} ${id} not found` : `${kind} ${id} has no provider id`,
  remediation: 'Check the id, or create the row with the provider first.',
});

/**
 * A webhook delivery's signature does not match the body and the webhook secret: it was not sent
 * by the provider, the body changed after signing, the signature header is missing or malformed, or
 * the signature timestamp is outside the tolerance. Returned by `StripeProvider.constructWebhookEvent`.
 *
 * @fix Answer the delivery with HTTP 400. Check the webhook secret, and pass the raw request body, not re-serialized JSON.
 * @verify bun run test -- src/core/providers src/presets
 */
export const InvalidWebhookSignature = /* @__PURE__ */ defineFailure('payments.invalid_signature', {
  status: 400,
  message: 'The webhook signature does not match the body and the webhook secret',
  remediation:
    'Answer with HTTP 400. Check the webhook secret, and verify the raw request body, not re-serialized JSON.',
});

/**
 * An automatic payment (`automatic: true`, charged with the customer absent) was asked for without
 * a `paymentMethodId`. Returned by `createPaymentIntent` before any provider request.
 *
 * @fix Pass the saved payment method to charge, or use `automatic: false` and let the customer finish in the client.
 * @verify bun run test -- src/core/providers
 */
export const PaymentMethodRequired = /* @__PURE__ */ defineFailure('payments.payment_method_required', {
  status: 400,
  message: 'An automatic payment needs a payment method id',
  remediation: 'Pass the saved payment method to charge, or use automatic: false so the customer finishes the payment.',
});

/**
 * A customer address given for a tax calculation has no country, so no tax jurisdiction can be found.
 * Returned by `calculateTax` and `createTaxTransaction` before any provider request.
 *
 * @fix Ask for the customer's country, or leave the address out to use the one the provider holds.
 * @verify bun run test -- src/core/providers
 */
export const TaxAddressIncomplete = /* @__PURE__ */ defineFailure('payments.tax_address_incomplete', {
  status: 400,
  message: 'A customer address for tax needs a country',
  remediation: "Ask for the customer's country, or leave the address out to use the one the provider holds.",
});

/**
 * Why a payment provider call failed, when it is a fault the caller cannot branch on. Expected
 * answers (`CardDeclined`, `IdempotencyConflict`, `ReferenceNotFound`) are returned instead.
 *
 * - `invalid_request`: the provider rejected the request itself. Retrying the same call fails again.
 * - `authentication`: the API key is wrong or lacks permission.
 * - `rate_limited` / `unavailable`: a later retry can work.
 * - `not_configured`: the provider was built without what the call needs.
 * - `unknown`: anything else. `cause` holds the original error.
 */
export type PaymentProviderErrorCode =
  'invalid_request' | 'authentication' | 'rate_limited' | 'unavailable' | 'not_configured' | 'unknown';

export class PaymentProviderError extends Error {
  readonly code: PaymentProviderErrorCode;
  /** The provider's own error code, such as Stripe's `resource_missing`, when it sent one. */
  readonly providerCode: string | undefined;

  constructor(
    code: PaymentProviderErrorCode,
    message: string,
    options: { cause?: unknown; providerCode?: string } = {},
  ) {
    super(message, { cause: options.cause });
    this.name = 'PaymentProviderError';
    this.code = code;
    this.providerCode = options.providerCode;
  }

  /** True when the same call can succeed later without changes. */
  get retryable(): boolean {
    return this.code === 'rate_limited' || this.code === 'unavailable';
  }
}

/** A Stripe card error as `CardDeclined`. Any other error gives `undefined`. */
export function cardDeclinedOf(error: unknown) {
  if (!(error instanceof Stripe.errors.StripeError) || error.type !== 'StripeCardError') return;
  return CardDeclined({ providerCode: error.code, declineCode: error.decline_code }, { cause: error });
}

/** A Stripe idempotency error as `IdempotencyConflict`. Any other error gives `undefined`. */
export function idempotencyConflictOf(error: unknown) {
  if (!(error instanceof Stripe.errors.StripeError) || error.type !== 'StripeIdempotencyError') return;
  return IdempotencyConflict({ cause: error });
}

/**
 * A Stripe SDK error as a `PaymentProviderError`, to throw. Errors that are not Stripe's pass through unchanged.
 * A card or idempotency error reaches here only from a call that cannot return `CardDeclined` or
 * `IdempotencyConflict`; it is an `invalid_request` there, since the same call fails again.
 */
export function mapStripeError(error: unknown): unknown {
  if (error instanceof PaymentProviderError) return error;
  if (!(error instanceof Stripe.errors.StripeError)) return error;

  const options = { cause: error, providerCode: error.code };
  switch (error.type) {
    case 'StripeCardError':
    case 'StripeIdempotencyError':
    case 'StripeInvalidRequestError': {
      return new PaymentProviderError('invalid_request', error.message, options);
    }
    case 'StripeAuthenticationError':
    case 'StripePermissionError': {
      return new PaymentProviderError('authentication', error.message, options);
    }
    case 'StripeRateLimitError': {
      return new PaymentProviderError('rate_limited', error.message, options);
    }
    case 'StripeConnectionError':
    case 'StripeAPIError': {
      return new PaymentProviderError('unavailable', error.message, options);
    }
    default: {
      return new PaymentProviderError('unknown', error.message, options);
    }
  }
}
