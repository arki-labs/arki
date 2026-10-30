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
import type { MoneyFailure } from './failures.js';
import type { Money, MoneyOptions } from './money.js';
import type { ParseOptions } from './parse.js';
import { Currency, toCurrency } from './currency.js';
import { isMoneyFailure } from './failures.js';
import { orRaise } from './internal/raise.js';
import { fromDecimalText } from './money.js';
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

/** A returned failure as a Zod issue. `params.code` carries the failure code to match on. */
function addFailure(ctx: z.RefinementCtx, failure: MoneyFailure, path?: string[]): void {
  ctx.addIssue({ code: 'custom', message: failure.message, params: { code: failure.code }, path });
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
  const value = fromDecimalText(amount, currency, currency.scale, options.rounding);
  if (isMoneyFailure(value)) {
    addFailure(ctx, value, ['amount']);
    return z.NEVER;
  }
  checkBounds(value, options, ctx);
  return value;
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
    const currency = Currency.parse(input.currency, options.currencies);
    if (isMoneyFailure(currency)) {
      addFailure(ctx, currency, ['currency']);
      return z.NEVER;
    }
    return settle(input.amount, currency, options, ctx);
  });
}

/**
 * A form field: locale text such as `'1.234,56 €'` → `Money<C>`, with the
 * strict rules of `@arki/money/parse`. A locale the runtime rejects throws here, when the
 * schema is built: the schema is your code's.
 */
export function moneyInputSchema<const C extends string>(
  currency: CurrencyLike<C>,
  options: ParseOptions & Pick<MoneySchemaOptions<C>, 'min' | 'max'> = {},
) {
  const parser = orRaise(createMoneyParser(currency, options));
  return z.string().transform((text, ctx): Money<C> => {
    const value = parser.parse(text);
    if (isMoneyFailure(value)) {
      addFailure(ctx, value);
      return z.NEVER;
    }
    checkBounds(value, options, ctx);
    return value;
  });
}

/** An ISO 4217 code from the shipped table, such as `'EUR'`. */
export const currencyCodeSchema = z
  .string()
  .refine(code => Currency.isKnown(code), { message: 'Unknown ISO 4217 currency code' });
