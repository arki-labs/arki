import Stripe from 'stripe';

/**
 * Why a payment provider call failed, in terms a caller can act on.
 *
 * - `card_declined`: the card or payment method was refused. Ask for another one.
 * - `invalid_request`: the provider rejected the request itself. Retrying the same call fails again.
 * - `authentication`: the API key is wrong or lacks permission.
 * - `rate_limited` / `unavailable`: a later retry can work.
 * - `idempotency_conflict`: the same idempotency key was used with different parameters.
 * - `reference_not_found`: a customer, plan or subscription id has no row, or the row has no provider id.
 * - `not_configured`: the provider was built without what the call needs.
 * - `unknown`: anything else. `cause` holds the original error.
 */
export type PaymentProviderErrorCode =
  | 'card_declined'
  | 'invalid_request'
  | 'authentication'
  | 'rate_limited'
  | 'unavailable'
  | 'idempotency_conflict'
  | 'reference_not_found'
  | 'not_configured'
  | 'unknown';

export class PaymentProviderError extends Error {
  readonly code: PaymentProviderErrorCode;
  /** The provider's own error code, such as Stripe's `card_declined`, when it sent one. */
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

/** A Stripe SDK error as a `PaymentProviderError`. Errors that are not Stripe's pass through unchanged. */
export function mapStripeError(error: unknown): unknown {
  if (error instanceof PaymentProviderError) return error;
  if (!(error instanceof Stripe.errors.StripeError)) return error;

  const options = { cause: error, providerCode: error.code };
  switch (error.type) {
    case 'StripeCardError': {
      return new PaymentProviderError('card_declined', error.message, options);
    }
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
    case 'StripeIdempotencyError': {
      return new PaymentProviderError('idempotency_conflict', error.message, options);
    }
    default: {
      return new PaymentProviderError('unknown', error.message, options);
    }
  }
}
