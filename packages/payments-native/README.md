# @arki/payments-native

A thin wrapper around the [RevenueCat](https://www.revenuecat.com/) SDK (`react-native-purchases`) for in-app purchases in React Native apps. It makes and restores purchases on the device. Failures come back as values, not thrown errors.

This package is the purchase rail only. It does not read entitlements. Your app reads "is this user Pro" from its own backend. RevenueCat reaches that backend through a webhook, handled by `@arki/payments` on the server.

## Install

```sh
npm install @arki/payments-native react-native-purchases
# or
bun add @arki/payments-native react-native-purchases
```

`react-native-purchases` (version 8 or later) is a peer dependency. Your app owns its install and native setup.

## Quick start

Configure once after the user is known. Then load the offering, buy a package and handle the result.

```ts skip="needs the RevenueCat native module, which only exists inside a React Native app"
import { isFailure } from '@arki/failure';
import {
  configureRevenueCat,
  getProOffering,
  purchasePackage,
} from '@arki/payments-native';

export async function buyMonthly(userId: string): Promise<'bought' | 'cancelled' | 'unavailable' | 'failed'> {
  configureRevenueCat({ apiKey: 'appl_public_sdk_key', appUserId: userId });

  const offering = await getProOffering();
  if (isFailure(offering)) return 'unavailable'; // RevenueCat could not be reached
  if (offering === null) return 'unavailable'; // no offering set up yet: show "coming soon"

  const monthly = offering.availablePackages[0];
  if (!monthly) return 'unavailable';

  const outcome = await purchasePackage(monthly);
  if (isFailure(outcome)) return 'failed';
  return outcome.status === 'purchased' ? 'bought' : 'cancelled';
}
```

After `'purchased'`, the entitlement reaches your backend through the webhook a moment later. Fetch it from your backend again.

## When not to use this

- You need to know whether the user is Pro. Ask your own backend. This package has no entitlement read.
- You build for the web. Use `@arki/payments` on the server and a web checkout.
- You want hooks or a state layer. These are plain async functions. Wrap them in your own query layer.

## Runtime support

React Native on iOS and Android, through Metro or Expo. `react-native-purchases` is a native module, so the package does not run in plain Node, Deno or a browser. The `react-native` export condition and the default condition both point at the same compiled file.

## Public imports

Everything comes from `@arki/payments-native`.

| Export | What it does |
| --- | --- |
| `configureRevenueCat({ apiKey, appUserId })` | Starts the SDK. `appUserId` must be the id your backend signs users in with, so the webhook can find the user. Call again with a new id to re-identify after sign-in. |
| `getProOffering()` | The current offering, or `null` when none is set up. |
| `purchasePackage(pkg)` | Buys a package. Returns `{ status: 'purchased', customerInfo }` or `{ status: 'cancelled' }`. |
| `restorePurchases()` | Restores earlier purchases and returns RevenueCat's `CustomerInfo`. |
| `OfferingsUnavailable`, `PurchaseFailed`, `RestoreFailed` | The failure constructors. |
| `CustomerInfo`, `PurchasesOffering`, `PurchasesPackage`, `PurchaseOutcome`, `ConfigureRevenueCatParams` | Types. |

## Failure behaviour

Functions return a failure instead of throwing. Check with `isFailure` from `@arki/failure`. The SDK error is kept as the failure's `cause`.

| Code | When |
| --- | --- |
| `payments_native.offerings_unavailable` | `getProOffering` could not load offerings (network, store, bad key). Status 503. |
| `payments_native.purchase_failed` | The store or RevenueCat refused the purchase. Status 502. |
| `payments_native.restore_failed` | `restorePurchases` could not restore. Status 502. |

A user who backs out of the purchase sheet is not a failure. `purchasePackage` returns `{ status: 'cancelled' }`.

## Limits

- `configureRevenueCat` is the only call that can throw, because it calls the SDK directly. Call it once at app start.
- One offering: the current (default) one in RevenueCat.
