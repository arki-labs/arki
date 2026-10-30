import type { CustomerInfo, PurchasesOffering, PurchasesPackage } from 'react-native-purchases';
import Purchases from 'react-native-purchases';
import { z } from 'zod';

import { defineFailure } from '@arki/failure';
import { is } from '@arki/schema';

/**
 * `@arki/payments-native` — a thin, reusable wrapper around the RevenueCat SDK
 * (`react-native-purchases`) for native in-app purchases. Purchase rail only: the entitlement READ
 * (am-I-Pro) is intentionally NOT here — apps read entitlement from their own backend (the single
 * cross-platform source of truth), which RevenueCat purchases reach via the server webhook
 * projector in `@arki/payments`. This package just makes/restores purchases on-device.
 *
 * Plain functions (no React) so any native app can compose them with its own state/query layer.
 */

export type { CustomerInfo, PurchasesOffering, PurchasesPackage } from 'react-native-purchases';

export type ConfigureRevenueCatParams = {
  /** Platform RevenueCat public SDK key (the iOS or Android API key). */
  apiKey: string;
  /**
   * The app's own user id, set as RevenueCat's `appUserID`. This is what lets the server webhook
   * attribute a purchase to a user — pass the SAME id your backend authenticates with.
   */
  appUserId: string;
};

/**
 * Initialize the RevenueCat SDK. Call once after the user is known (so `appUserID` is set); calling
 * again with a different `appUserId` re-identifies the user (e.g. after sign-in).
 */
export function configureRevenueCat({ apiKey, appUserId }: ConfigureRevenueCatParams): void {
  Purchases.configure({ apiKey, appUserID: appUserId });
}

/**
 * RevenueCat could not load the offerings (no network, store down, bad key). The SDK error stays
 * private as the failure's `cause`.
 * @fix Check the network and the RevenueCat key, then try again.
 * @verify bun run typecheck
 */
export const OfferingsUnavailable = /* @__PURE__ */ defineFailure('payments_native.offerings_unavailable', {
  status: 503,
  message: 'The purchase offerings could not be loaded.',
  remediation: 'Check the network and the RevenueCat key, then try again.',
});

/**
 * The store or RevenueCat refused the purchase (not a user cancellation). The SDK error stays
 * private as the failure's `cause`.
 * @fix Try again; if it repeats, check the product setup in the store and RevenueCat.
 * @verify bun run typecheck
 */
export const PurchaseFailed = /* @__PURE__ */ defineFailure('payments_native.purchase_failed', {
  status: 502,
  message: 'The purchase could not be completed.',
  remediation: 'Try again; if it repeats, check the product setup in the store and RevenueCat.',
});

/**
 * RevenueCat could not restore earlier purchases (not a user cancellation). The SDK error stays
 * private as the failure's `cause`.
 * @fix Check the network and that the user is signed in to the store, then try again.
 * @verify bun run typecheck
 */
export const RestoreFailed = /* @__PURE__ */ defineFailure('payments_native.restore_failed', {
  status: 502,
  message: 'The earlier purchases could not be restored.',
  remediation: 'Check the network and that the user is signed in to the store, then try again.',
});

/**
 * The current (default) offering's purchasable packages, or `null` when none is configured in
 * RevenueCat yet — so a pre-launch app can show its honest "coming soon" instead of an empty sheet.
 * Returns `payments_native.offerings_unavailable` when RevenueCat cannot be reached.
 */
export async function getProOffering(): Promise<
  PurchasesOffering | null | ReturnType<typeof OfferingsUnavailable>
> {
  try {
    const offerings = await Purchases.getOfferings();
    return offerings.current ?? null;
  } catch (error) {
    return OfferingsUnavailable({ cause: error });
  }
}

/** Outcome of a purchase attempt — cancellation is a normal result, not a failure. */
export type PurchaseOutcome = { status: 'purchased'; customerInfo: CustomerInfo } | { status: 'cancelled' };

/** RevenueCat throws an error object carrying `userCancelled: true` when the user backs out. */
const userCancelledSchema = z.object({ userCancelled: z.literal(true) });

/**
 * Purchase a package. Returns a tagged outcome so the caller can treat user-cancellation calmly
 * (no red error) and surface real failures as `payments_native.purchase_failed`. On success the entitlement still lands in the backend
 * asynchronously via RevenueCat's webhook — re-fetch backend entitlement after `'purchased'`.
 */
export async function purchasePackage(
  pkg: PurchasesPackage,
): Promise<PurchaseOutcome | ReturnType<typeof PurchaseFailed>> {
  try {
    const { customerInfo } = await Purchases.purchasePackage(pkg);
    return { status: 'purchased', customerInfo };
  } catch (error) {
    if (is(error, userCancelledSchema)) return { status: 'cancelled' };
    return PurchaseFailed({ cause: error });
  }
}

/**
 * Restore prior purchases (after reinstall / new device). Returns RevenueCat's `CustomerInfo`; the
 * authoritative entitlement is still the backend, so re-fetch it afterward. Returns
 * `payments_native.restore_failed` when RevenueCat cannot restore.
 */
export async function restorePurchases(): Promise<CustomerInfo | ReturnType<typeof RestoreFailed>> {
  try {
    return await Purchases.restorePurchases();
  } catch (error) {
    return RestoreFailed({ cause: error });
  }
}
