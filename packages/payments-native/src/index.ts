import Purchases from 'react-native-purchases';
import type { CustomerInfo, PurchasesOffering, PurchasesPackage } from 'react-native-purchases';

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
 * The current (default) offering's purchasable packages, or `null` when none is configured in
 * RevenueCat yet — so a pre-launch app can show its honest "coming soon" instead of an empty sheet.
 */
export async function getProOffering(): Promise<PurchasesOffering | null> {
  const offerings = await Purchases.getOfferings();
  return offerings.current ?? null;
}

/** Outcome of a purchase attempt — cancellation is a normal result, not an error. */
export type PurchaseOutcome =
  | { status: 'purchased'; customerInfo: CustomerInfo }
  | { status: 'cancelled' }
  | { status: 'error'; message: string };

function isUserCancelled(error: unknown): boolean {
  // RevenueCat throws an error object carrying `userCancelled: true` when the user backs out.
  return (
    typeof error === 'object' &&
    error !== null &&
    'userCancelled' in error &&
    error.userCancelled === true
  );
}

/**
 * Purchase a package. Returns a tagged outcome so the caller can treat user-cancellation calmly
 * (no red error) and surface real failures. On success the entitlement still lands in the backend
 * asynchronously via RevenueCat's webhook — re-fetch backend entitlement after `'purchased'`.
 */
export async function purchasePackage(pkg: PurchasesPackage): Promise<PurchaseOutcome> {
  try {
    const { customerInfo } = await Purchases.purchasePackage(pkg);
    return { status: 'purchased', customerInfo };
  } catch (error) {
    if (isUserCancelled(error)) return { status: 'cancelled' };
    return { status: 'error', message: error instanceof Error ? error.message : 'Purchase failed' };
  }
}

/**
 * Restore prior purchases (after reinstall / new device). Returns RevenueCat's `CustomerInfo`; the
 * authoritative entitlement is still the backend, so re-fetch it afterward.
 */
export async function restorePurchases(): Promise<CustomerInfo> {
  return Purchases.restorePurchases();
}
