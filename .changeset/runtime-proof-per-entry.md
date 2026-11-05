---
'@arki/geo': patch
'@arki/seo': patch
'@arki/tanstack-start': patch
'@arki/queue': patch
'@arki/payments-native': patch
---

The runtime claims are now proven per entry, and the README tables show it.

- `@arki/geo/geocoding` runs on Node, Bun and Deno only (package.json `arki.entryRuntimes`):
  `node-geocoder` needs Node's `readline`. The rest of `@arki/geo` runs on all five engines.
- `@arki/seo/react` and `@arki/tanstack-start/error` are bundler-only entries. They are now proven as a
  bundle on each engine they claim, which is how an app loads them.
- `@arki/queue` now passes on Deno, run straight from `node_modules` as a Deno app does.
- `@arki/payments-native` now passes on Hermes.

No code in these packages changed.

no docs impact: README runtime sections only.
no demo impact: no behaviour change.
