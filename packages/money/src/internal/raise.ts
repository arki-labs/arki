/**
 * Builders and arithmetic throw; the `parse*` doors return. Both read the same
 * text, so a builder asks the door and raises the matching thrown error.
 */

import {
  InvalidArgumentError,
  NumberFormatError,
  NumericRangeError,
  ResourceLimitError,
  RoundingNecessaryError,
  UnsupportedFeatureError,
} from '@arki/math/errors';

import type { MoneyFailure } from '../failures.js';
import { ExchangeRateError, ProviderAmountError } from '../errors.js';
import { isMoneyFailure } from '../failures.js';

/** The thrown error a builder raises for a failure. */
export function failureToError(failure: MoneyFailure): Error {
  const message = failure.message;
  switch (failure.code) {
    case 'money.invalid_text': {
      return new NumberFormatError(message);
    }
    // A caller that knows the code throws `UnknownCurrencyError` itself; this is the fallback.
    case 'money.invalid_shape':
    case 'money.unknown_currency': {
      return new InvalidArgumentError(message);
    }
    case 'money.rounding_necessary': {
      return new RoundingNecessaryError(message);
    }
    case 'money.out_of_range': {
      return new NumericRangeError(message);
    }
    case 'money.input_too_large': {
      return new ResourceLimitError(message);
    }
    case 'money.unsupported_locale': {
      return new UnsupportedFeatureError(message);
    }
    case 'money.provider_amount': {
      return new ProviderAmountError(message);
    }
    case 'money.invalid_rate': {
      return new ExchangeRateError(message);
    }
  }
}

/** The value, or the thrown error for a returned failure. For builders, whose input is the caller's own code; not `@arki/failure`'s `orThrow`, which throws `FailureError`. */
export function orRaise<T>(value: T | MoneyFailure): T {
  if (isMoneyFailure(value)) throw failureToError(value);
  return value;
}
