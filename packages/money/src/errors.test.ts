import { describe, expect, it } from 'vitest';

import { Currency } from './currency.js';
import {
  CurrencyMismatchError,
  ExchangeRateError,
  MathError,
  MONEY_ERROR_CODES,
  MoneyError,
  ProviderAmountError,
  UnknownCurrencyError,
} from './errors.js';
import { money } from './money.js';

function caught(run: () => unknown): unknown {
  try {
    run();
  } catch (error) {
    return error;
  }
  return undefined;
}

describe('MoneyError codes', () => {
  it('keeps the four money-only codes stable, so callers can match on them across releases', () => {
    expect(MONEY_ERROR_CODES).toEqual({
      currencyMismatch: 'ARKI_MONEY_E001',
      unknownCurrency: 'ARKI_MONEY_E002',
      exchangeRate: 'ARKI_MONEY_E003',
      providerAmount: 'ARKI_MONEY_E004',
    });
    expect(new ExchangeRateError('x')).toMatchObject({ code: 'ARKI_MONEY_E003' });
    expect(new ProviderAmountError('x')).toMatchObject({ code: 'ARKI_MONEY_E004' });
  });

  it('puts the code and a remediation on a currency mismatch', () => {
    const usd = money('1', 'USD');
    // @ts-expect-error -- Money<'EUR'> and Money<'USD'> do not mix
    const error = caught(() => money('1', 'EUR').plus(usd));
    expect(error).toBeInstanceOf(CurrencyMismatchError);
    expect(error).toMatchObject({ code: 'ARKI_MONEY_E001', left: 'EUR', right: 'USD' });
    expect(error instanceof MoneyError && error.remediation.length > 0).toBe(true);
  });

  it('keeps the offending currency text apart from the error code, so the code stays machine-readable', () => {
    const error = caught(() => Currency.of('ZZZ'));
    expect(error).toBeInstanceOf(UnknownCurrencyError);
    expect(error).toBeInstanceOf(MathError);
    expect(error).toMatchObject({ code: 'ARKI_MONEY_E002', currencyCode: 'ZZZ' });
  });
});
