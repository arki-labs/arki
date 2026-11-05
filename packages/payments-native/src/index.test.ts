import { SpanStatusCode } from '@opentelemetry/api';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { isFailure } from '@arki/failure';
import { captureSpans } from '@arki/testing/otel';

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

describe('spans on the RevenueCat calls', () => {
  // WHY: an operator must see a store outage (error status) apart from a user who backed out (an
  // answer, no error), and the span must never carry the SDK's message, a key or a customer.
  const allowed = new Set(['payments.provider', 'payments.purchase_status', 'failure.code']);

  it('a loaded offering is one payments.revenuecat.get_offerings span, counted as a success', async () => {
    using spans = captureSpans();
    sdk.getOfferings.mockResolvedValue({ current: null });
    expect(await getProOffering()).toBeNull();
    const span = spans.named('payments.revenuecat.get_offerings');
    expect(span.attributes).toEqual({ 'payments.provider': 'revenuecat' });
    expect(span.status.code).toBe(SpanStatusCode.UNSET);
    const collected = await spans.collectMetrics();
    const counter = collected.find(metric => metric.descriptor.name === 'payments.operations');
    expect(counter?.dataPoints.map(point => [point.attributes, point.value])).toEqual([
      [{ operation: 'revenuecat.get_offerings', outcome: 'success' }, 1],
    ]);
  });

  it('an unreachable store sets failure.code and the error status: it is a fault (503)', async () => {
    using spans = captureSpans();
    sdk.getOfferings.mockRejectedValue(new Error('offline with key appl_secret'));
    expect(isFailure(await getProOffering())).toBe(true);
    const span = spans.named('payments.revenuecat.get_offerings');
    expect(span.attributes['failure.code']).toBe('payments_native.offerings_unavailable');
    expect(span.status.code).toBe(SpanStatusCode.ERROR);
    expect(JSON.stringify(span.attributes)).not.toContain('appl_secret');
  });

  it('a cancelled purchase is an answer: status unset, no failure.code, purchase_status cancelled', async () => {
    using spans = captureSpans();
    sdk.purchasePackage.mockRejectedValue({ userCancelled: true });
    expect(await purchasePackage(pkg)).toEqual({ status: 'cancelled' });
    const span = spans.named('payments.revenuecat.purchase_package');
    expect(span.attributes).toEqual({ 'payments.provider': 'revenuecat', 'payments.purchase_status': 'cancelled' });
    expect(span.status.code).toBe(SpanStatusCode.UNSET);
  });

  it('a refused purchase and a failed restore are faults with their codes, and carry no SDK detail', async () => {
    using spans = captureSpans();
    sdk.purchasePackage.mockRejectedValue(new Error('SKErrorDomain secret detail'));
    sdk.restorePurchases.mockRejectedValue(new Error('no store account'));
    expect(isFailure(await purchasePackage(pkg))).toBe(true);
    expect(isFailure(await restorePurchases())).toBe(true);
    const purchase = spans.named('payments.revenuecat.purchase_package');
    const restore = spans.named('payments.revenuecat.restore_purchases');
    expect(purchase.attributes['failure.code']).toBe('payments_native.purchase_failed');
    expect(restore.attributes['failure.code']).toBe('payments_native.restore_failed');
    expect([purchase.status.code, restore.status.code]).toEqual([SpanStatusCode.ERROR, SpanStatusCode.ERROR]);
    for (const span of spans.finished) {
      expect(Object.keys(span.attributes).every(key => allowed.has(key))).toBe(true);
      expect(JSON.stringify(span.attributes)).not.toContain('secret detail');
    }
  });
});
