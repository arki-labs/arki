---
'@arki/auth': minor
---

Authorization as plain functions. `definePolicies<{ order: Order }>()({ order: { view, refund } })` (from `@arki/auth`) groups policies by subject; each policy reads `{ principal, order }` and returns a boolean, and names like `order.refund` are read from the tree, so a typo does not compile. The optional `view` policy decides whether the principal may know the subject exists.

- `@arki/auth/orpc`: `guards<C>()` now also returns `can`. `can(policies)('order.refund', load)` signs in, loads the subject by the procedure's input, runs the policy and puts the subject on the context (`context.order`). A guest is `UNAUTHORIZED` (E401) and the loader never runs; a missing subject or `view` false is `NOT_FOUND` with no auth code (it looks missing); the policy false is `FORBIDDEN` (E403).
- The procedure's contract meta must name the same policy (`.meta({ policy: 'order.refund' })`), so `dot explain` lists it. A missing or different name is the new `ARKI_AUTH_E008` (500).
- `@arki/auth/http`: `authorize(policies)(name, load, handler)` wraps an `@arki/http` handler with the same check (401, 404 `ARKI_HTTP_E404`, 403). It runs after input decoding, so `load` reads the typed `params` and `body`.
- Every refusal after sign-in writes one debug line on `arki:auth` with the policy name, the principal id and the outcome (`missing`, `hidden`, `forbidden`).
