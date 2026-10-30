import { beforeEach, describe, expect, it, vi } from 'vitest';

import { isFailure } from '@arki/failure';

// The RevenueCat SDK is a native module that cannot run here, so it is the one fake: each test
// scripts what the SDK does, and the wrapper's own mapping is what runs for real.
const sdk = vi.hoisted(() => ({
  getOfferings: vi.fn(),
  purchasePackage: vi.fn(),
  restorePurchases: vi.fn(),
  configure: vi.fn(),
}));
vi.mock('react-native-purchases', () => ({ default: sdk }));

const { getProOffering, purchasePackage, restorePurchases } = await import('./index');
type Pkg = Parameters<typeof purchasePackage>[0];
const pkg = {} as Pkg;

beforeEach(() => {
  vi.resetAllMocks();
});

describe('getProOffering', () => {
  it('returns null when no offering is configured', async () => {
    sdk.getOfferings.mockResolvedValue({ current: null });
    expect(await getProOffering()).toBeNull();
  });

  it('returns a typed failure, not a raw rejection, when RevenueCat cannot be reached', async () => {
    sdk.getOfferings.mockRejectedValue(new Error('offline'));
    const result = await getProOffering();
    expect(isFailure(result) && result.code).toBe('payments_native.offerings_unavailable');
  });
});

describe('purchasePackage', () => {
  it('reports a user cancellation as a normal outcome', async () => {
    sdk.purchasePackage.mockRejectedValue({ userCancelled: true });
    expect(await purchasePackage(pkg)).toEqual({ status: 'cancelled' });
  });

  it('returns a typed failure and never exposes the SDK message', async () => {
    sdk.purchasePackage.mockRejectedValue(new Error('SKErrorDomain secret detail'));
    const result = await purchasePackage(pkg);
    expect(isFailure(result) && result.code).toBe('payments_native.purchase_failed');
    expect(JSON.stringify(result)).not.toContain('secret detail');
  });
});

describe('restorePurchases', () => {
  it('returns a typed failure, not a raw rejection', async () => {
    sdk.restorePurchases.mockRejectedValue(new Error('no store account'));
    const result = await restorePurchases();
    expect(isFailure(result) && result.code).toBe('payments_native.restore_failed');
  });
});
