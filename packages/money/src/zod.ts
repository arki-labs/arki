/**
 * Zod 4 schemas that turn input into `Money`. Optional: needs `zod` installed.
 *
 * ```ts
 * const order = z.object({ total: moneySchema('EUR', { min: money(0, 'EUR') }) });
 * order.parse({ total: { amount: '19.99', currency: 'EUR' } }).total; // Money<'EUR'>
 * ```
 *
 * The input type is the JSON shape `{ amount: string; currency: string }`, so
 * RPC clients (tRPC, oRPC) infer what to send; the output type is `Money`.
 */

import { z } from 'zod';

import type { CurrencyLike } from './currency.js';
import type { Money, MoneyOptions } from './money.js';
import type { ParseOptions } from './parse.js';
import { Currency, resolveCurrency, toCurrency } from './currency.js';
import { MathError } from './errors.js';
import { Money as MoneyClass } from './money.js';
import { createMoneyParser } from './parse.js';

export type MoneySchemaOptions<C extends string> = {
  /** Inclusive bounds. */
  min?: Money<C>;
  max?: Money<C>;
  /** Extra digits are rounded with this mode instead of rejected. */
  rounding?: MoneyOptions['rounding'];
};

export type AnyMoneySchemaOptions = MoneySchemaOptions<string> & {
  /** Custom currencies to resolve by code. */
  currencies?: readonly Currency[];
};

function message(error: unknown): string {
  return error instanceof Error ? error.message : 'Invalid money';
}

function checkBounds<C extends string>(value: Money<C>, options: MoneySchemaOptions<C>, ctx: z.RefinementCtx): void {
  if (options.min !== undefined && value.lt(options.min)) {
    ctx.addIssue({ code: 'custom', message: `Must be at least ${options.min.toString()}` });
  }
  if (options.max !== undefined && value.gt(options.max)) {
    ctx.addIssue({ code: 'custom', message: `Must be at most ${options.max.toString()}` });
  }
}

const moneyJsonShape = z.object({ amount: z.string(), currency: z.string() });

function settle<C extends string>(
  amount: string,
  currency: Currency<C>,
  options: MoneySchemaOptions<C>,
  ctx: z.RefinementCtx,
): Money<C> {
  try {
    const value = MoneyClass.of(amount, currency, { rounding: options.rounding });
    checkBounds(value, options, ctx);
    return value;
  } catch (error) {
    if (!(error instanceof MathError)) throw error;
    ctx.addIssue({ code: 'custom', message: message(error), path: ['amount'] });
    return z.NEVER;
  }
}

/**
 * `{ amount: '19.99', currency: 'EUR' }` → `Money<'EUR'>`. Another currency,
 * a bad amount or a value out of bounds becomes a Zod issue.
 */
export function moneySchema<const C extends string>(currency: CurrencyLike<C>, options: MoneySchemaOptions<C> = {}) {
  const expected = toCurrency(currency);
  return moneyJsonShape.transform((input, ctx): Money<C> => {
    if (input.currency !== expected.code) {
      ctx.addIssue({ code: 'custom', message: `Expected ${expected.code}, got ${input.currency}`, path: ['currency'] });
      return z.NEVER;
    }
    return settle(input.amount, expected, options, ctx);
  });
}

/** `{ amount, currency }` in any ISO (or listed custom) currency → `Money`. */
export function anyMoneySchema(options: AnyMoneySchemaOptions = {}) {
  return moneyJsonShape.transform((input, ctx): Money => {
    let currency: Currency;
    try {
      currency = resolveCurrency(input.currency, options.currencies);
    } catch (error) {
      if (!(error instanceof MathError)) throw error;
      ctx.addIssue({ code: 'custom', message: message(error), path: ['currency'] });
      return z.NEVER;
    }
    return settle(input.amount, currency, options, ctx);
  });
}

/**
 * A form field: locale text such as `'1.234,56 €'` → `Money<C>`, with the
 * strict rules of `@arki/money/parse`.
 */
export function moneyInputSchema<const C extends string>(
  currency: CurrencyLike<C>,
  options: ParseOptions & Pick<MoneySchemaOptions<C>, 'min' | 'max'> = {},
) {
  const parser = createMoneyParser(currency, options);
  return z.string().transform((text, ctx): Money<C> => {
    try {
      const value = parser.parse(text);
      checkBounds(value, options, ctx);
      return value;
    } catch (error) {
      if (!(error instanceof MathError)) throw error;
      ctx.addIssue({ code: 'custom', message: message(error) });
      return z.NEVER;
    }
  });
}

/** An ISO 4217 code from the shipped table, such as `'EUR'`. */
export const currencyCodeSchema = z
  .string()
  .refine(code => Currency.isKnown(code), { message: 'Unknown ISO 4217 currency code' });
