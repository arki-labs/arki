import { describe, expect, it } from 'vitest';

import { UnsupportedFeatureError } from '@arki/math/errors';

import { createMoneyFormatter, formatMoney, formatMoneyToParts } from './format.js';
import { Currency, Money, money, RoundingNecessaryError } from './index.js';

// Intl uses non-breaking spaces in many locales; compare with plain spaces.
const plain = (text: string) => text.replaceAll(/[\u00A0\u202F]/g, ' ');

describe('formatMoney', () => {
  it('formats with the locale and shows every stored decimal', () => {
    expect(plain(formatMoney(money('1234.5', 'EUR'), { locale: 'de-DE' }))).toBe(plain('1.234,50 €'));
    expect(formatMoney(money('1234.5', 'USD'))).toBe('$1,234.50');
    expect(formatMoney(money(1234, 'JPY'), { locale: 'ja-JP' })).toBe('￥1,234');
    expect(formatMoney(money('0.1234', 'EUR', { scale: 4 }))).toBe('€0.1234');
    expect(plain(formatMoney(money('1.5', 'EUR'), { display: 'code' }))).toBe(plain('EUR 1.50'));
  });

  it('keeps every digit past 2^53', () => {
    const big = Money.fromMinor(123_456_789_012_345_678_901n, 'USD');
    expect(formatMoney(big, { useGrouping: false })).toBe('$1234567890123456789.01');
  });

  it('rounds for display exactly, and only when asked', () => {
    const price = money('2.345', 'EUR', { scale: 3 });
    expect(() => formatMoney(price, { fractionDigits: 2 })).toThrow(RoundingNecessaryError);
    expect(formatMoney(price, { fractionDigits: 2, rounding: 'halfEven' })).toBe('€2.34');
    expect(formatMoney(price, { fractionDigits: 2, rounding: 'halfUp' })).toBe('€2.35');
  });

  it('supports accounting negatives', () => {
    expect(formatMoney(money(-5, 'USD'), { accounting: true })).toBe('($5.00)');
  });

  it('prints custom currencies with their code and refuses symbols it does not have', () => {
    const btc = Currency.custom({ code: 'BTC', scale: 8 });
    expect(formatMoney(money('0.00012', btc))).toBe('0.00012000 BTC');
    expect(() => formatMoney(money(1, btc), { display: 'symbol' })).toThrow(UnsupportedFeatureError);
  });

  it('returns parts and binds options once', () => {
    const parts = formatMoneyToParts(money('1.5', 'USD'));
    expect(parts.find(part => part.type === 'currency')?.value).toBe('$');
    const de = createMoneyFormatter({ locale: 'de-DE' });
    expect(plain(de.format(money(1, 'EUR')))).toBe(plain('1,00 €'));
  });
});
