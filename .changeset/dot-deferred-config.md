---
'@arki/dot': minor
'@arki/ts': minor
'@arki/http': patch
'@arki/kv': patch
'@arki/env': patch
---

`Lazy<T>` and `resolveLazy` move from `@arki/ts` to `@arki/dot/plugin` as `Deferred<T>` and `resolveDeferred`. They are the "value now, or a thunk the adapter calls at boot" shape that Dot adapters accept, and the old name clashed with Dot's own `Lazy<Value, Cleanup>` service handle. Behaviour is unchanged. `@arki/ts` no longer exports them; to upgrade, import `Deferred` and `resolveDeferred` from `@arki/dot/plugin`.

`@arki/http` (`port`) and `@arki/kv` (`kv()`, `kv.optional()`) now type their deferred options as `Deferred<T>`, the same shape as before, and no longer depend on `@arki/ts`. `@arki/env` drops an `@arki/ts` dependency it never imported.

demo impact: none (neither demo imports `Lazy` or `resolveLazy`).
