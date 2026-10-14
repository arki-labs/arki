/**
 * Every failure this package raises on purpose extends `MathError` from
 * `@arki/math`, so one `instanceof MathError` catches both libraries. The
 * money-only failures also extend `MoneyError`. Wrong runtime types (a number
 * where a `Money` was required, or `money + 1`) throw the built-in `TypeError`.
 * Nothing here returns `NaN` or `null` as a hidden failure channel.
 *
 * Each class carries a stable `code` and a one-sentence `remediation`. Match
 * on the code, never on the message. The money-only codes are listed in
 * {@link MONEY_ERROR_CODES}; the shared classes keep their `ARKI_MATH_*` codes.
 */

import { MathError } from '@arki/math/errors';

export {
  DivisionByZeroError,
  EmptyDataError,
  InvalidArgumentError,
  MathError,
  NumberFormatError,
  NumericRangeError,
  ResourceLimitError,
  RoundingNecessaryError,
  UnsupportedFeatureError,
} from '@arki/math/errors';

/** Stable error codes of the failures that only `@arki/money` raises. */
export const MONEY_ERROR_CODES = {
  /** Two amounts in different currencies were combined or compared. */
  currencyMismatch: 'ARKI_MONEY_E001',
  /** The currency code is not in the ISO 4217 table and no custom currency was given. */
  unknownCurrency: 'ARKI_MONEY_E002',
  /** No exchange rate is known for the pair, or a rate is invalid. */
  exchangeRate: 'ARKI_MONEY_E003',
  /** An amount cannot be expressed in a payment provider's units. */
  providerAmount: 'ARKI_MONEY_E004',
} as const;

/** The code of a {@link MoneyError} raised by `@arki/money` itself. */
export type MoneyErrorCode = (typeof MONEY_ERROR_CODES)[keyof typeof MONEY_ERROR_CODES];

/** Base class of the failures that only money can have. */
export abstract class MoneyError extends MathError {}

/** Two amounts in different currencies were combined or compared. */
export class CurrencyMismatchError extends MoneyError {
  readonly code = MONEY_ERROR_CODES.currencyMismatch;
  readonly remediation = 'Convert both amounts to one currency first, for example with an exchange rate.';
  /** Code of the currency on the left-hand side. */
  readonly left: string;
  /** Code of the currency on the right-hand side. */
  readonly right: string;

  constructor(left: string, right: string) {
    super(
      left === right
        ? `Cannot combine two different definitions of ${left}; they disagree on the number of decimals`
        : `Cannot combine ${left} with ${right}`,
    );
    this.left = left;
    this.right = right;
  }
}

/** The code is not in the shipped ISO 4217 table and no custom currency was supplied for it. */
export class UnknownCurrencyError extends MoneyError {
  readonly code = MONEY_ERROR_CODES.unknownCurrency;
  readonly remediation = 'Use a three-letter ISO 4217 code, or create the currency with Currency.custom().';
  /** The currency code that was not found. */
  readonly currencyCode: string;

  constructor(code: string) {
    super(
      `Unknown currency ${JSON.stringify(code)}. ISO 4217 codes are three upper-case letters; ` +
        'for anything else create one with Currency.custom()',
    );
    this.currencyCode = code;
  }
}

/** No exchange rate is known for the pair, or a rate is invalid (zero, negative, conflicting). */
export class ExchangeRateError extends MoneyError {
  readonly code = MONEY_ERROR_CODES.exchangeRate;
  readonly remediation = 'Add a positive rate for the pair to the exchange table, or fix the conflicting rates.';
}

/** An amount cannot be expressed in a payment provider's units (fraction it does not accept, wrong step, unsupported currency). */
export class ProviderAmountError extends MoneyError {
  readonly code = MONEY_ERROR_CODES.providerAmount;
  readonly remediation = 'Round the amount to a step the provider accepts, or use a currency the provider supports.';
}
