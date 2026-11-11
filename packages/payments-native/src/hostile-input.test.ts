/**
 * The hostile-input gate (T08) for the RevenueCat wrapper
 *
 * The same gate as `@arki/payments` `src/hostile-input/`: one valid call per
 * exported operation, then every hostile value at every argument leaf. A
 * mutated call must resolve (to a value or a typed failure) or throw a
 * `FailureError` from `invariant`; nothing else.
 *
 * The RevenueCat SDK is a native module that cannot run here, so it is the
 * package's one stand-in (as in `index.test.ts`): it answers like the SDK,
 * and the wrapper's own code is what runs for real.
 */
import { describe, expect, test, vi } from 'vitest';

import { FAILURE_ERROR_CODES, FailureError, isFailure } from '@arki/failure';

const sdk = vi.hoisted(() => ({
  getOfferings: vi.fn(),
  purchasePackage: vi.fn(),
  restorePurchases: vi.fn(),
  configure: vi.fn(),
}));
vi.mock('react-native-purchases', () => ({ default: sdk }));

const native = await import('./index');
const { configureRevenueCat, getProOffering, purchasePackage, restorePurchases } = native;

type Pkg = Parameters<typeof purchasePackage>[0];

/** A package as the SDK hands it over; the stand-in SDK reads none of its fields. */
function toPkg(input: Record<string, unknown>): Pkg {
  return Object.assign({} as Pkg, input);
}

const customerInfo = { entitlements: { active: {} }, originalAppUserId: 'usr_1' };
sdk.getOfferings.mockResolvedValue({ current: null });
sdk.purchasePackage.mockResolvedValue({ customerInfo });
sdk.restorePurchases.mockResolvedValue(customerInfo);

const STRINGS: [string, string][] = [
  ["'\\u0000'", '\u0000'],
  ["'a\\u0000b'", 'a\u0000b'],
  ["'\\uD800' (lone surrogate)", '\uD800'],
  ['300-char text', 'x'.repeat(300)],
  ['100k-char text', 'x'.repeat(100_000)],
  ["'a\\r\\nb'", 'a\r\nb'],
  ["'éĀ' (above U+00FF)", 'éĀ'],
];

/** One argument object with each hostile change: every string leaf, one extra key, one bigint field. */
function hostileVariants(valid: Record<string, unknown>): [string, Record<string, unknown>][] {
  const variants: [string, Record<string, unknown>][] = [
    ['extra unknown key', { ...valid, hostileExtraKey: 'x' }],
    ['extra bigint field', { ...valid, hostileBigint: 1n }],
  ];
  for (const [key, value] of Object.entries(valid)) {
    if (typeof value !== 'string') continue;
    for (const [label, hostile] of STRINGS) variants.push([`args[0].${key} = ${label}`, { ...valid, [key]: hostile }]);
  }
  return variants;
}

async function outcomeOf(call: () => unknown): Promise<string | undefined> {
  try {
    await call();
    return undefined;
  } catch (error) {
    if (error instanceof FailureError && error.code === FAILURE_ERROR_CODES.invariant) return undefined;
    return error instanceof Error ? `${error.constructor.name}: ${error.message}` : String(error);
  }
}

const exemptByShape = new Set(['OfferingsUnavailable', 'PurchaseFailed', 'RestoreFailed']);
const covered = new Set(['configureRevenueCat', 'getProOffering', 'purchasePackage', 'restorePurchases']);

describe('hostile input: payments-native', () => {
  test('every exported function has a case (failure definitions are exempt)', () => {
    const callables = Object.entries(native)
      .filter(([, value]) => typeof value === 'function')
      .map(([name]) => name)
      .filter(name => !exemptByShape.has(name));
    expect(callables.filter(name => !covered.has(name))).toEqual([]);
  });

  test('configureRevenueCat', async () => {
    const valid = { apiKey: 'appl_test_key', appUserId: 'usr_1' };
    configureRevenueCat(valid);
    expect(sdk.configure).toHaveBeenLastCalledWith({ apiKey: 'appl_test_key', appUserID: 'usr_1' });

    const failures: string[] = [];
    for (const [label, input] of hostileVariants(valid)) {
      const outcome = await outcomeOf(() =>
        configureRevenueCat({ apiKey: String(input.apiKey), appUserId: String(input.appUserId), ...input }),
      );
      if (outcome) failures.push(`${label} → ${outcome}`);
    }
    expect(failures).toEqual([]);
  });

  test('getProOffering', async () => {
    expect(await getProOffering()).toBeNull();
  });

  test('restorePurchases', async () => {
    expect(await restorePurchases()).toEqual(customerInfo);
  });

  test('purchasePackage', async () => {
    const valid = { identifier: '$rc_monthly', packageType: 'MONTHLY', offeringIdentifier: 'default' };
    const result = await purchasePackage(toPkg(valid));
    expect(isFailure(result)).toBe(false);
    expect(result).toEqual({ status: 'purchased', customerInfo });

    const failures: string[] = [];
    for (const [label, input] of hostileVariants(valid)) {
      const outcome = await outcomeOf(() => purchasePackage(toPkg(input)));
      if (outcome) failures.push(`${label} → ${outcome}`);
    }
    expect(failures).toEqual([]);
  });
});
