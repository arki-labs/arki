# @arki/payments-native

## 0.1.2

### Patch Changes

- 20e2cc4: The runtime claims are now proven per entry, and the README tables show it.

  - `@arki/geo/geocoding` runs on Node, Bun and Deno only (package.json `arki.entryRuntimes`):
    `node-geocoder` needs Node's `readline`. The rest of `@arki/geo` runs on all five engines.
  - `@arki/seo/react` and `@arki/tanstack-start/error` are bundler-only entries. They are now proven as a
    bundle on each engine they claim, which is how an app loads them.
  - `@arki/queue` now passes on Deno, run straight from `node_modules` as a Deno app does.
  - `@arki/payments-native` now passes on Hermes.

  No code in these packages changed.

  no docs impact: README runtime sections only.
  no demo impact: no behaviour change.

- 763b232: Declares the engines it supports and documents them in the README.
- 93d1ea9: `getProOffering`, `purchasePackage` and `restorePurchases` each run in a span named like the web `@arki/payments` spans: `payments.revenuecat.get_offerings`, `payments.revenuecat.purchase_package` and `payments.revenuecat.restore_purchases`, with `payments.provider` and `failure.code` on a failure. The three failures are faults, so they set the error status. A cancelled purchase sets `payments.purchase_status: 'cancelled'` and leaves the status unset. Each call counts in `payments.operations` (`operation`, `outcome`). The API key, user id, products and `CustomerInfo` are never recorded. `@opentelemetry/api` is a new dependency; it still runs on Hermes.

  Docs: README `## Observability`.

- 744896d: Add the README `Documentation` and `Support` sections, `AGENTS.md`, an agent guide and `llms.txt`, and ship them in the package.

## 0.1.1

### Patch Changes

- 73eef01: First public release of @arki/payments-native: RevenueCat in-app purchases for React Native (configure, load the pro offering, purchase, restore) with failures returned as values.
