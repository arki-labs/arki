---
'@arki/admin': patch
---

Add `createForemanRoute` (`./server`), the one mount for `/api/foreman/*`. It builds the handler on the
first request, takes one store for both nonces and receipts, and namespaces the receipts by the app's
audience. With no store it answers 404 while the keys are unset and throws `ARKI_ADMIN_E014` once they
are set. Also add `memoryForemanStore` for single-instance apps, and a new `./pg` entry with
`foremanStoreTable` and `pgForemanStore`: a Postgres store for apps without a KV (`drizzle-orm` is an
optional peer).

no demo impact: no demo mounts Foreman.
