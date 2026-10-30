/**
 * Values that come from outside (typed text, JSON, database rows, provider
 * payloads) are read by `parse*` doors that return one of these failures
 * instead of throwing. Builders and arithmetic keep their thrown errors
 * (`errors.ts`), because their input is the caller's own code.
 *
 * Failures carry no input text: the caller already holds it, and a failure
 * may be logged or sent to a client. Match on `code`, never on the message.
 */

import { defineFailure } from '@arki/failure';

/**
 * The text is not an amount of money in the expected format: wrong characters,
 * misplaced grouping, a different currency's symbol, two signs, mixed digit scripts.
 *
 * @fix Show the person the expected format, for example `19.99 EUR`. Do not guess a repair.
 * @verify cd packages/money && bun run vitest run src/failures.test.ts
 */
export const InvalidMoneyText = /* @__PURE__ */ defineFailure('money.invalid_text', {
  status: 400,
  message: 'The text is not an amount of money in the expected format.',
  remediation:
    'Use plain digits with an optional sign and fraction, such as 19.99 EUR, or the locale format you parse with.',
});

/**
 * The value has a different shape than `{ amount: string, currency: string }`.
 *
 * @fix Send `{ amount, currency }` with both fields as strings, as `Money#toJSON()` writes them.
 * @verify cd packages/money && bun run vitest run src/failures.test.ts
 */
export const InvalidMoneyShape = /* @__PURE__ */ defineFailure('money.invalid_shape', {
  status: 400,
  message: 'The value is not an object with a string amount and a string currency.',
  remediation: 'Send an object with an amount string and a currency string, as Money#toJSON() writes them.',
});

/**
 * The currency code or number is not in the ISO 4217 table and no custom currency was listed for it.
 * Thrown builders raise `UnknownCurrencyError` (`ARKI_MONEY_E002`) for the same fault.
 *
 * @fix Use an ISO 4217 code in upper case, or pass the custom `Currency` objects you accept.
 * @verify cd packages/money && bun run vitest run src/failures.test.ts
 */
export const UnknownCurrency = /* @__PURE__ */ defineFailure('money.unknown_currency', {
  status: 400,
  message: 'The currency is not in the ISO 4217 table or the list of custom currencies.',
  remediation: 'Use an upper-case ISO 4217 code, or pass the custom currencies you accept.',
});

/**
 * The amount has more decimals than the currency or scale allows, and no rounding mode was given.
 *
 * @fix Ask for an amount with fewer decimals, or pass an explicit `rounding` mode to the parser.
 * @verify cd packages/money && bun run vitest run src/failures.test.ts
 */
export const RoundingNecessary = /* @__PURE__ */ defineFailure('money.rounding_necessary', {
  status: 400,
  message: 'The amount has more decimals than allowed and no rounding mode was given.',
  remediation: 'Ask for fewer decimals, or pass a rounding mode such as halfEven.',
});

/**
 * A number is not a safe whole number of minor units: it is fractional, not finite, or past 2^53.
 *
 * @fix Send minor units as a string or bigint when they may pass 2^53, and never send a fraction.
 * @verify cd packages/money && bun run vitest run src/failures.test.ts
 */
export const AmountOutOfRange = /* @__PURE__ */ defineFailure('money.out_of_range', {
  status: 400,
  message: 'The number is not a safe whole number of minor units.',
  remediation: 'Send whole minor units as a string or bigint when they may pass 2^53.',
});

/**
 * The input is longer than the package reads: text over 1000 characters, an exponent or fraction
 * that is too large, or a number with more than about 10 000 digits.
 *
 * @fix Refuse the input at your boundary. Real amounts are far shorter than these limits.
 * @verify cd packages/money && bun run vitest run src/failures.test.ts
 */
export const InputTooLarge = /* @__PURE__ */ defineFailure('money.input_too_large', {
  status: 413,
  message: 'The input is longer or has more digits than money parsing accepts.',
  remediation: 'Refuse the input. Real amounts are far below the limits.',
});

/**
 * The locale tag is not valid, so the runtime's `Intl` cannot give its number format.
 *
 * @fix Pass a well-formed BCP 47 tag such as `de-DE`, or pass `symbols` to parse without `Intl`.
 * @verify cd packages/money && bun run vitest run src/failures.test.ts
 */
export const UnsupportedLocale = /* @__PURE__ */ defineFailure('money.unsupported_locale', {
  status: 400,
  message: 'The locale is not a valid language tag for this runtime.',
  remediation: 'Pass a well-formed BCP 47 locale such as de-DE, or pass symbols to parse without Intl.',
});

/**
 * A payment provider amount cannot be read as money: it is not a multiple of the provider's step,
 * it carries a fraction the currency does not have, or the provider has no unit rule for the currency.
 *
 * @fix Check the provider's amount and currency. Never round a provider amount to make it fit.
 * @verify cd packages/money && bun run vitest run src/failures.test.ts
 */
export const ProviderAmount = /* @__PURE__ */ defineFailure('money.provider_amount', {
  status: 422,
  message: "The provider amount does not fit the provider's unit rule for this currency.",
  remediation: "Check the provider's amount and currency. Do not round it to make it fit.",
});

/**
 * A rate read from a feed is not usable: it is zero or negative, or a rate from a currency
 * to itself is not 1. Thrown builders raise `ExchangeRateError` for the same fault.
 *
 * @fix Check the feed. A rate is how many units of the quote currency one unit of the base buys, always above 0.
 * @verify cd packages/money && bun run vitest run src/exchange.test.ts
 */
export const InvalidExchangeRate = /* @__PURE__ */ defineFailure('money.invalid_rate', {
  status: 400,
  message: 'The exchange rate is not positive, or a rate from a currency to itself is not 1.',
  remediation: 'Check the rate feed. Every rate must be above 0, and a currency to itself must be 1.',
});

/** Every failure a `parse*` door of this package can return. */
export const MONEY_FAILURES = [
  InvalidMoneyText,
  InvalidMoneyShape,
  UnknownCurrency,
  RoundingNecessary,
  AmountOutOfRange,
  InputTooLarge,
  UnsupportedLocale,
  ProviderAmount,
  InvalidExchangeRate,
] as const;

/** The code of every failure in {@link MONEY_FAILURES}, derived from the definitions. */
export type MoneyFailureCode = (typeof MONEY_FAILURES)[number]['code'];

/** A failure value returned by a money door. */
export type MoneyFailure = ReturnType<(typeof MONEY_FAILURES)[number]>;

/** Whether a value is one of the failures in {@link MONEY_FAILURES}. */
export function isMoneyFailure(value: unknown): value is MoneyFailure {
  return MONEY_FAILURES.some(definition => definition.is(value));
}
