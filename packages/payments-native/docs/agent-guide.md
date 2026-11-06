# Agent guide: @arki/payments-native

Read `llms.txt` first for the map. This guide is the detail. When this guide and the code disagree, `src/index.ts` wins.

## The model

1. `configureRevenueCat({ apiKey, appUserId })` starts the SDK. Call it once after the user is known.
2. `getProOffering()` returns the current offering, `null` when none is set up, or the failure `payments_native.offerings_unavailable`.
3. `purchasePackage(pkg)` returns `{ status: 'purchased', customerInfo }`, `{ status: 'cancelled' }` or the failure `payments_native.purchase_failed`.
4. `restorePurchases()` returns `CustomerInfo` or the failure `payments_native.restore_failed`.
5. The package does not read entitlements. After a purchase the entitlement reaches your backend through the RevenueCat webhook, handled by `@arki/payments`. Fetch it from your backend again.
6. Each call runs in a `payments.revenuecat.*` span and counts in `payments.operations`. Nothing is exported until the app configures an OpenTelemetry SDK.

## Task map

### Buy a package

1. `configureRevenueCat({ apiKey, appUserId })` with the platform public key and your backend's user id.
2. `const offering = await getProOffering()`. Check `isFailure(offering)` and `offering === null`.
3. Pick a package from `offering.availablePackages`.
4. `const outcome = await purchasePackage(pkg)`. Check `isFailure(outcome)` first, then `outcome.status`.
5. After `'purchased'`, fetch the entitlement from your backend again.

### Restore purchases

1. `const info = await restorePurchases()` after a reinstall or on a new device.
2. Check `isFailure(info)`. Then fetch the entitlement from your backend.

### Show a placeholder before the offering exists

1. `getProOffering()` returns `null` while RevenueCat has no current offering.
2. Show your own placeholder screen. Do not show an empty sheet.

### Re-identify after sign-in

1. Call `configureRevenueCat` again with the new `appUserId`.

## Rules that bite

- No entitlement read lives here. Ask your own backend.
- `appUserId` must match the id your backend signs users in with. A mismatch breaks the webhook.
- Check `isFailure` before you read a result.
- A cancelled purchase is `{ status: 'cancelled' }`. Do not show an error for it.
- `configureRevenueCat` can throw. Call it once at app start.
- Only the current (default) offering is supported.
- Match on the failure `code`, never on the message. Read the SDK error from `cause`.
- The package does not run in plain Node, Deno or a browser, because `react-native-purchases` is a native module.

## Errors

| Code                                    | Meaning                                                                   | What to do                                                |
| --------------------------------------- | ------------------------------------------------------------------------- | --------------------------------------------------------- |
| `payments_native.offerings_unavailable` | `getProOffering` could not load offerings (network, store, bad key). 503. | Check the network and the RevenueCat key, then try again. |
| `payments_native.purchase_failed`       | The store or RevenueCat refused the purchase. 502.                        | Try again. If it repeats, check the product setup.        |
| `payments_native.restore_failed`        | `restorePurchases` could not restore. 502.                                | Try again. If it repeats, check the RevenueCat setup.     |

## Verify

```sh
bun run build && bun run typecheck && bun run lint && bun run test
bun run test:docs
bun ../../tooling/library/src/llms.ts --check
```
