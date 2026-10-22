---
'@arki/auth': minor
'@arki/http': minor
'@arki/live': patch
---

Auth checks are plain steps (RFC `docs/rfcs/2026-10-21-dot-middleware.md`, step 4).

- `@arki/auth` adds `authed`, `verified` and `role(name)`: plain functions that read `ctx.principal` and narrow it to non-null, or refuse with `auth.unauthenticated` (401) / `auth.forbidden` (403). Attach them with the transport's `step()`: `impl.x.use(step(authed))` (`@arki/dot/orpc`), `routes().use(step(authed))` (`@arki/http`). The handler keeps the app's own principal type.
- `@arki/auth/http` adds `principalFromHeaders(auth)`, a step that adds `principal` (`null` for a guest) from the request's credentials.
- Breaking: `guards<C>()` is removed from `@arki/auth/orpc`. `const { authed } = guards<C>()` → `import { authed } from '@arki/auth'` and `.use(step(authed))`. `can(policies)(name, load)` is now imported directly from `@arki/auth/orpc`, same call shape.
- Breaking: `withPrincipal(auth, options)` and `withOptionalPrincipal(auth)` are removed from `@arki/auth/http`. Use `.use(step(principalFromHeaders(auth), { failureHeaders: authFailureHeaders }))`, then `.use(step(authed, { failureHeaders: authFailureHeaders }))` (or `verified`, `role(name)`) on routes that need a signed-in caller.
- Breaking: `@arki/http` removes `derive(key, fn)`, the bundle's `.derive()`, `Deriver`, `ErasedDeriver`, `BASE_CTX_KEYS` and `ARKI_HTTP_E007`. A keyed deriver becomes a step that returns an object: `.derive('db', fn)` → `.use(step(ctx => ({ db: fn(ctx) })))`. `verifyWebhook({ scheme })` is a step: `.use(step(verifyWebhook({ scheme })))` adds `ctx.webhook`. A route bundle's `derivers` field is renamed `stages` (it holds steps and arounds).
- Fix: `@arki/http` steps after the first one see `ctx.url` and `ctx.signal` again (they were dropped when the context was extended). This fixes `@arki/live`'s endpoint, which reads `ctx.url` in its second stage.
